// Simulates days of minute-by-minute checks through the real Worker code and a
// SQLite stand-in for D1, and checks the stored timeline matches the original
// in-browser accounting exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runCycle } from "../src/worker.js";
import { segmentsForPortal } from "../src/db.js";
import { newRecord, applyPresence, applyError, closeInterval } from "../src/accounting.js";
import { isWithinSchedule, DEFAULT_SCHEDULE } from "../src/schedule.js";

function fakeD1() {
    const db = new DatabaseSync(":memory:");
    const wrap = (sql, params = []) => ({
        sql, params,
        bind: (...p) => wrap(sql, p),
        async all() { return { results: db.prepare(sql).all(...params) }; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        exec() { return /^\s*(SELECT|WITH)/i.test(sql) ? { results: db.prepare(sql).all(...params) } : (() => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) }, results: [] }; })(); }
    });
    return {
        raw: db,
        prepare: (sql) => wrap(sql),
        async batch(stmts) {
            db.exec("BEGIN");
            try { const out = stmts.map((s) => s.exec()); db.exec("COMMIT"); return out; }
            catch (e) { db.exec("ROLLBACK"); throw e; }
        }
    };
}

const IDS = ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002", "aaaaaaaa-0000-0000-0000-000000000003"];
const STATUSES = ["Available", "Available", "Available", "Busy", "Away", "BeRightBack", "Offline", "AvailableIdle", "DoNotDisturb"];

test("stored timeline matches reference accounting over 3 simulated days", async () => {
    const DB = fakeD1();
    const env = { DB, AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s", GRAPH_BASE_URL: "https://g", LOGIN_BASE_URL: "https://l" };
    // seed people via the schema the worker creates
    let now = Date.parse("2026-11-25T00:00:00Z");
    await runCycle(env, now);
    for (const id of IDS) DB.raw.prepare("INSERT INTO people (id, display_name, added_at) VALUES (?, ?, ?)").run(id, id.slice(-1), now);

    let rand = 42; const rnd = () => (rand = (rand * 1103515245 + 12345) % 2147483648) / 2147483648;
    const current = Object.fromEntries(IDS.map((id) => [id, "Available"]));
    let failNext = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "x", expires_in: 3600 }));
        if (failNext) return new Response(JSON.stringify({ error: { message: "throttled" } }), { status: 429 });
        const { ids } = JSON.parse(init.body);
        return new Response(JSON.stringify({ value: ids.map((id) => ({ id, availability: current[id], activity: current[id] === "Away" ? "Away" : "" })) }));
    };

    // reference: full in-memory records, same rules, driven identically
    const ref = Object.fromEntries(IDS.map((id) => [id, newRecord({ id, displayName: id.slice(-1) })]));
    let wasLive = false;
    const client = Object.fromEntries(IDS.map((id) => [id, []]));
    let lastSync = 0;
    try {
        for (let minute = 0; minute < 3 * 24 * 60; minute += 1) {
            now += 60000 + Math.floor(rnd() * 3000); // a little jitter like real cron
            if (rnd() < 0.003) now += 5 * 60000;     // occasional missed runs
            for (const id of IDS) if (rnd() < 0.08) current[id] = STATUSES[Math.floor(rnd() * STATUSES.length)];
            failNext = rnd() < 0.01;
            const live = isWithinSchedule(now, DEFAULT_SCHEDULE);
            await runCycle(env, now);
            for (const id of IDS) {
                const r = ref[id];
                if (!live) { if (r.openSince) closeInterval(r, now, false); continue; }
                if (failNext) applyError(r, { id }, "x", now);
                else applyPresence(r, { id, displayName: id.slice(-1) }, { availability: current[id], activity: current[id] === "Away" ? "Away" : "" }, now);
            }
            wasLive = live;
            if (minute % 7 === 3) { // the portal refreshing incrementally
                const got = await segmentsForPortal(env, IDS, lastSync ? lastSync - 10 * 60000 : 0);
                for (const id of IDS) {
                    const rows = got[id];
                    const from = lastSync ? (rows.length ? Math.min(rows[0].s, lastSync - 10 * 60000) : lastSync - 10 * 60000) : -Infinity;
                    client[id] = client[id].filter((x) => x.s < from).concat(rows);
                }
                lastSync = now;
            }
        }
    } finally { globalThis.fetch = realFetch; }
    void wasLive;

    for (const id of IDS) {
        const stored = DB.raw.prepare("SELECT s, e, st, adj FROM segments WHERE user_id = ? ORDER BY s").all(id)
            .map((r) => ({ s: r.s, e: r.e, st: r.st, ...(r.adj ? { adj: true } : {}) }));
        assert.ok(stored.length > 20, `expected plenty of segments, got ${stored.length}`);
        assert.deepEqual(stored, ref[id].segments, `segments differ for ${id}`);
        const final = await segmentsForPortal(env, IDS, lastSync - 10 * 60000);
        const rows = final[id];
        const from = rows.length ? Math.min(rows[0].s, lastSync - 10 * 60000) : lastSync - 10 * 60000;
        assert.deepEqual(client[id].filter((x) => x.s < from).concat(rows), stored, `portal sync drifted for ${id}`);
    }
    const logs = DB.raw.prepare("SELECT COUNT(*) n FROM logs").get().n;
    assert.ok(logs > 50);
});
