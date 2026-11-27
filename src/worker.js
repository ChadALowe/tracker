// Presence tracker Worker.
//  - scheduled(): runs every minute (cron "* * * * *"); checks Teams presence during tracking hours
//  - fetch(): serves the portal (public/) and a password-protected JSON API under /api/

import { applyError, applyPresence, closeInterval, newRecord, GAP_LIMIT_MS, POLL_MS, AWAY_OFFSET_MS } from "./accounting.js";
import { DEFAULT_SCHEDULE, resolveState, validateSchedule, manualStartUntil, manualStopUntil } from "./schedule.js";
import { connectionStatus, fetchPresences, getAppToken, isConfigured, searchUsers } from "./graph.js";
import {
    ensureSchema, getMeta, metaStatements, loadPeopleAndRecords, loadTails, saveStatements, pruneStatements,
    segmentsForPortal, logFromRow, peopleFromRows, KEEP_MS
} from "./db.js";

const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayBefore(date) {
    return new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
const PORTAL_LOGS = 5000;

/* =========================================================
   The minute-by-minute check
   ========================================================= */
function scheduleFrom(meta) {
    try { return meta.schedule ? validateSchedule(meta.schedule) : DEFAULT_SCHEDULE; } catch { return DEFAULT_SCHEDULE; }
}

async function closeOpen(env, recs, nowMs) {
    if (recs.length === 0) return [];
    await loadTails(env, recs, nowMs);
    for (const rec of recs) closeInterval(rec, nowMs, false);
    return saveStatements(env, recs, []);
}

// Stops two checks (the cron and a button press) overlapping and double-writing.
async function takeLock(env, nowMs) {
    const res = await env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES ('cycle_lock', ?1) ON CONFLICT(key)
         DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) < ?2`
    ).bind(String(nowMs), nowMs - 50000).run();
    return res.meta && res.meta.changes > 0;
}

export async function runCycle(env, nowMs = Date.now()) {
    await ensureSchema(env);
    if (!(await takeLock(env, nowMs))) return { skipped: "another check is running" };
    try {
        return await cycle(env, nowMs);
    } finally {
        await env.DB.prepare("UPDATE meta SET value = '0' WHERE key = 'cycle_lock'").run();
    }
}

async function cycle(env, nowMs) {
    const meta = await getMeta(env);
    const schedule = scheduleFrom(meta);
    const state = resolveState(nowMs, schedule, meta.override);
    const { people, records } = await loadPeopleAndRecords(env);
    const metaUpdates = {};
    const stmts = [];

    if (meta.override && meta.override.until && meta.override.until <= nowMs) metaUpdates.override = null;
    if (!meta.last_prune_at || nowMs - meta.last_prune_at > PRUNE_EVERY_MS) {
        stmts.push(...pruneStatements(env, nowMs));
        metaUpdates.last_prune_at = nowMs;
    }

    const trackedIds = new Set(people.map((p) => p.id));
    // Anyone still "open" who won't be checked this time gets closed off now.
    const toClose = Array.from(records.values()).filter((r) => r.openSince && (!state.live || !trackedIds.has(r.userId)));
    stmts.push(...await closeOpen(env, toClose, nowMs));

    let checked = 0;
    if (!state.live) {
        if (meta.live_since) metaUpdates.live_since = null;
    } else {
        if (!meta.live_since) metaUpdates.live_since = nowMs;
        if (people.length > 0) {
            const recs = people.map((p) => records.get(p.id) || newRecord(p));
            await loadTails(env, recs, nowMs);
            const logs = [];
            let token = null;
            let failure = null;
            try { token = await getAppToken(env); } catch (error) { failure = error; }

            if (failure) {
                people.forEach((p, i) => applyError(recs[i], p, `Sign-in problem: ${failure.message}`, nowMs));
                metaUpdates.last_error = { at: nowMs, message: failure.message };
            } else {
                const results = await fetchPresences(env, token, people.map((p) => p.id));
                let firstError = null;
                people.forEach((p, i) => {
                    const result = results.get(p.id);
                    if (!result || result instanceof Error) {
                        const message = result ? result.message : "No result";
                        firstError ||= message;
                        applyError(recs[i], p, message, nowMs);
                    } else {
                        const log = applyPresence(recs[i], p, result, nowMs);
                        if (log) logs.push(log);
                        checked += 1;
                    }
                });
                metaUpdates.last_error = firstError ? { at: nowMs, message: firstError } : null;
            }
            stmts.push(...saveStatements(env, recs, logs));
        }
        metaUpdates.last_poll_at = nowMs;
    }

    stmts.push(...metaStatements(env, metaUpdates));
    if (stmts.length) await env.DB.batch(stmts);
    return { live: state.live, reason: state.reason, people: people.length, checked };
}

/* =========================================================
   Portal sign-in (one shared password, HttpOnly cookie)
   ========================================================= */
const COOKIE = "presence_session";
const SESSION_DAYS = 30;
const enc = new TextEncoder();

function b64url(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hmacKey(env) {
    // Derived from the password, so changing PORTAL_PASSWORD signs everyone out.
    const secret = `${env.SESSION_SECRET || ""}|${env.PORTAL_PASSWORD}`;
    return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(env, payload) {
    return b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload)));
}

function safeEqual(a, b) {
    const x = enc.encode(String(a)), y = enc.encode(String(b));
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
    return diff === 0;
}

async function makeSessionCookie(env, url) {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    const payload = `v1.${exp}`;
    const value = `${payload}.${await sign(env, payload)}`;
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

async function isSignedIn(env, request) {
    if (!env.PORTAL_PASSWORD) return false;
    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    if (!match) return false;
    const value = match.slice(COOKIE.length + 1);
    const lastDot = value.lastIndexOf(".");
    if (lastDot < 0) return false;
    const payload = value.slice(0, lastDot), sig = value.slice(lastDot + 1);
    const [version, exp] = payload.split(".");
    if (version !== "v1" || !(Number(exp) > Date.now())) return false;
    return safeEqual(sig, await sign(env, payload));
}

/* =========================================================
   API
   ========================================================= */
function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
    });
}

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) throw new HttpError(415, "Send JSON.");
    try { return await request.json(); } catch { throw new HttpError(400, "That request body isn't valid JSON."); }
}

async function bumpDataVersion(env) {
    const meta = await getMeta(env);
    return metaStatements(env, { data_version: (Number(meta.data_version) || 0) + 1 });
}

async function apiState(env, url) {
    const since = Number(url.searchParams.get("since")) || 0;
    const logAfter = Number(url.searchParams.get("logAfter")) || 0;
    const clientVersion = url.searchParams.get("version");
    const nowMs = Date.now();

    const meta = await getMeta(env);
    const version = Number(meta.data_version) || 0;
    const full = !since || clientVersion === null || Number(clientVersion) !== version;
    const schedule = scheduleFrom(meta);
    const state = resolveState(nowMs, schedule, meta.override);

    const [peopleRes, recordRes, logRes] = await env.DB.batch([
        env.DB.prepare("SELECT * FROM people ORDER BY added_at"),
        env.DB.prepare("SELECT * FROM records"),
        full
            ? env.DB.prepare("SELECT * FROM (SELECT * FROM logs ORDER BY id DESC LIMIT ?) ORDER BY id").bind(PORTAL_LOGS)
            : env.DB.prepare("SELECT * FROM logs WHERE id > ? ORDER BY id LIMIT ?").bind(logAfter, PORTAL_LOGS)
    ]);
    const records = recordRes.results.map((r) => ({
        userId: r.user_id, userLabel: r.user_label, availability: r.availability, activity: r.activity,
        checkedAt: r.checked_at, firstSeenAt: r.first_seen_at, openSince: r.open_since
    }));
    const segments = await segmentsForPortal(env, records.map((r) => r.userId), full ? 0 : since);

    return json({
        now: nowMs, version, full,
        status: { ...state, liveSince: meta.live_since || null, lastPollAt: meta.last_poll_at || null, lastError: meta.last_error || null },
        schedule, override: meta.override && meta.override.until > nowMs ? meta.override : null,
        connection: connectionStatus(env),
        leave: Array.isArray(meta.leave) ? meta.leave : [],
        rules: { pollMs: POLL_MS, gapLimitMs: GAP_LIMIT_MS, awayOffsetMs: AWAY_OFFSET_MS, keepMs: KEEP_MS },
        people: peopleFromRows(peopleRes.results),
        records, segments,
        logs: logRes.results.map(logFromRow)
    });
}

async function apiImport(env, body) {
    // Brings over history kept in a browser by the old version of the page.
    const stmts = [];
    const people = Array.isArray(body.people) ? body.people.filter((p) => p && typeof p.id === "string") : [];
    for (const p of people) {
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO people (id, display_name, mail, upn, added_at) VALUES (?, ?, ?, ?, ?)")
            .bind(p.id, p.displayName || null, p.mail || null, p.userPrincipalName || null, Date.now()));
    }
    const records = Array.isArray(body.records) ? body.records.filter((r) => r && typeof r.userId === "string") : [];
    for (const r of records) {
        stmts.push(env.DB.prepare(
            `INSERT INTO records (user_id, user_label, first_seen_at) VALUES (?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET first_seen_at = MIN(COALESCE(records.first_seen_at, excluded.first_seen_at), COALESCE(excluded.first_seen_at, records.first_seen_at)),
               user_label = COALESCE(records.user_label, excluded.user_label)`
        ).bind(r.userId, r.userLabel || r.userId, Number(r.firstSeenAt) || null));
    }
    const segs = (Array.isArray(body.segments) ? body.segments : [])
        .filter((s) => s && typeof s.userId === "string" && Number(s.e) > Number(s.s) && typeof s.st === "string")
        .slice(0, 800);
    for (let i = 0; i < segs.length; i += 16) {
        const rows = segs.slice(i, i + 16);
        stmts.push(env.DB.prepare(`INSERT INTO segments (user_id, s, e, st, adj) VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`)
            .bind(...rows.flatMap((s) => [s.userId, Number(s.s), Number(s.e), s.st, s.adj ? 1 : 0])));
    }
    const logs = (Array.isArray(body.logs) ? body.logs : [])
        .filter((l) => l && typeof l.userId === "string" && !Number.isNaN(Date.parse(l.timestamp)))
        .slice(0, 800);
    for (let i = 0; i < logs.length; i += 14) {
        const rows = logs.slice(i, i + 14);
        stmts.push(env.DB.prepare(`INSERT INTO logs (ts, user_id, user_label, from_av, to_av, activity) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`)
            .bind(...rows.flatMap((l) => [Date.parse(l.timestamp), l.userId, l.userLabel || null, l.fromAvailability || null, l.toAvailability || null, l.activity || null])));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return { people: people.length, records: records.length, segments: segs.length, logs: logs.length };
}

async function handleApi(request, env, url, ctx) {
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method;

    if (path === "/api/login" && method === "POST") {
        if (!env.PORTAL_PASSWORD) throw new HttpError(503, "Set a PORTAL_PASSWORD secret on the Worker first.");
        const body = await readJson(request);
        if (!safeEqual(String(body.password || ""), env.PORTAL_PASSWORD)) {
            await new Promise((r) => setTimeout(r, 800)); // slow down guessing
            throw new HttpError(401, "That password isn't right.");
        }
        return json({ ok: true }, 200, { "Set-Cookie": await makeSessionCookie(env, url) });
    }
    if (path === "/api/logout" && method === "POST") {
        return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }

    if (!env.PORTAL_PASSWORD) throw new HttpError(503, "Set a PORTAL_PASSWORD secret on the Worker so the portal is protected.");
    if (!(await isSignedIn(env, request))) throw new HttpError(401, "Please sign in.");

    await ensureSchema(env);

    if (path === "/api/state" && method === "GET") return apiState(env, url);

    if (path === "/api/schedule" && method === "PUT") {
        let schedule;
        try { schedule = validateSchedule(await readJson(request)); } catch (error) {
            throw error instanceof HttpError ? error : new HttpError(400, error.message);
        }
        await env.DB.batch(metaStatements(env, { schedule }));
        ctx.waitUntil(runCycle(env).catch((e) => console.error(e)));
        return json({ ok: true, schedule });
    }

    if (path === "/api/control" && method === "POST") {
        const { action } = await readJson(request);
        const meta = await getMeta(env);
        const schedule = scheduleFrom(meta);
        const now = Date.now();
        let override;
        if (action === "start") override = { mode: "on", until: manualStartUntil(now, schedule), at: now };
        else if (action === "stop") override = { mode: "off", until: manualStopUntil(now, schedule), at: now };
        else if (action === "auto") override = null;
        else throw new HttpError(400, "Unknown action.");
        await env.DB.batch(metaStatements(env, { override }));
        await runCycle(env, now); // start checking, or close off open time, straight away
        return json({ ok: true, override });
    }

    if (path === "/api/check-now" && method === "POST") {
        const meta = await getMeta(env);
        if (meta.last_poll_at && Date.now() - meta.last_poll_at < 15000) return json({ ok: true, skipped: "Checked moments ago." });
        return json({ ok: true, result: await runCycle(env) });
    }

    if (path === "/api/users/search" && method === "GET") {
        const token = await getAppToken(env);
        return json({ users: await searchUsers(env, token, url.searchParams.get("q") || "") });
    }

    if (path === "/api/people" && method === "POST") {
        const { user } = await readJson(request);
        if (!user || typeof user.id !== "string" || !user.id.trim()) throw new HttpError(400, "Missing person.");
        await env.DB.prepare(
            `INSERT INTO people (id, display_name, mail, upn, added_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, mail = excluded.mail, upn = excluded.upn`
        ).bind(user.id.trim(), user.displayName || null, user.mail || null, user.userPrincipalName || null, Date.now()).run();
        return json({ ok: true });
    }

    if (path.startsWith("/api/people") && method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/people".length).replace(/^\//, ""));
        if (id) await env.DB.prepare("DELETE FROM people WHERE id = ?").bind(id).run();
        else await env.DB.prepare("DELETE FROM people").run();
        return json({ ok: true }); // history is kept; open time is closed at the next check
    }

    if (path === "/api/reset" && method === "POST") {
        await env.DB.batch([
            env.DB.prepare("DELETE FROM segments"),
            env.DB.prepare("DELETE FROM logs"),
            env.DB.prepare("DELETE FROM records"),
            ...await bumpDataVersion(env)
        ]);
        return json({ ok: true });
    }

    if (path === "/api/leave" && method === "POST") {
        const body = await readJson(request);
        const meta = await getMeta(env);
        const leave = Array.isArray(meta.leave) ? meta.leave : [];
        const userId = typeof body.userId === "string" ? body.userId.trim() : "";
        if (!userId) throw new HttpError(400, "Pick a person.");
        let next;
        if (body.action === "add") {
            if (!DATE_RE.test(body.from || "") || !DATE_RE.test(body.to || "")) throw new HttpError(400, "Give a from and until date.");
            if (body.to < body.from) throw new HttpError(400, "The until date must be on or after the from date.");
            next = leave.concat({ userId, from: body.from, to: body.to });
        } else if (body.action === "cancel") {
            if (!DATE_RE.test(body.date || "")) throw new HttpError(400, "Missing date.");
            // Back from `date` onwards: drop leave starting then or later, cut earlier leave short.
            next = leave.flatMap((r) => {
                if (r.userId !== userId || r.from > body.date || r.to < body.date) return [r];
                return r.from >= body.date ? [] : [{ ...r, to: dayBefore(body.date) }];
            });
        } else {
            throw new HttpError(400, "Unknown action.");
        }
        const keepFrom = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
        next = next.filter((r) => r.to >= keepFrom).slice(-500);
        await env.DB.batch(metaStatements(env, { leave: next }));
        return json({ ok: true, leave: next });
    }

    if (path === "/api/import" && method === "POST") {
        return json({ ok: true, imported: await apiImport(env, await readJson(request)) });
    }

    throw new HttpError(404, "Not found.");
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/")) {
            try {
                return await handleApi(request, env, url, ctx);
            } catch (error) {
                const status = error instanceof HttpError ? error.status : 500;
                if (status === 500) console.error(error);
                return json({ error: error.message || String(error) }, status);
            }
        }
        return env.ASSETS.fetch(request);
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(runCycle(env, Date.now()).then(
            (r) => console.log(`presence check: ${JSON.stringify(r)}`),
            (e) => console.error("presence check failed", e)
        ));
    }
};
