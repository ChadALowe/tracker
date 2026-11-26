// D1 storage. The schema is created automatically the first time the Worker runs,
// so there's no migration step to remember.
//
// Statements are kept few and multi-row, because D1 counts queries per invocation.

export const KEEP_MS = 180 * 24 * 60 * 60 * 1000;
const TAIL = 12;          // recent segments loaded per person for each check
const MAX_PARAMS = 99;    // D1 allows 100 bound parameters per statement

export const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY, display_name TEXT, mail TEXT, upn TEXT, added_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS records (
        user_id TEXT PRIMARY KEY, user_label TEXT, availability TEXT, activity TEXT,
        checked_at INTEGER, first_seen_at INTEGER, open_since INTEGER)`,
    `CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        s INTEGER NOT NULL, e INTEGER NOT NULL, st TEXT NOT NULL, adj INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS segments_user_s ON segments (user_id, s)`,
    `CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT NOT NULL,
        user_label TEXT, from_av TEXT, to_av TEXT, activity TEXT)`,
    `CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts)`,
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
];

let schemaReady = false;
export async function ensureSchema(env) {
    if (schemaReady) return;
    if (!env.DB) throw new Error("No D1 database is bound to the Worker as DB.");
    await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
    schemaReady = true;
}

function chunkRows(rows, perRow) {
    const size = Math.max(1, Math.floor(MAX_PARAMS / perRow));
    const out = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
}

/* ---------- meta ---------- */
export async function getMeta(env) {
    const { results } = await env.DB.prepare("SELECT key, value FROM meta").all();
    const meta = {};
    for (const row of results) {
        try { meta[row.key] = JSON.parse(row.value); } catch { meta[row.key] = null; }
    }
    return meta;
}

export function metaStatements(env, values) {
    const entries = Object.entries(values);
    return chunkRows(entries, 2).map((rows) => env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES ${rows.map(() => "(?, ?)").join(", ")}
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(...rows.flatMap(([k, v]) => [k, JSON.stringify(v ?? null)])));
}

/* ---------- people & records ---------- */
export function peopleFromRows(rows) {
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, mail: r.mail, userPrincipalName: r.upn, addedAt: r.added_at }));
}

export function recordFromRow(r) {
    return {
        userId: r.user_id, userLabel: r.user_label, availability: r.availability, activity: r.activity,
        checkedAt: r.checked_at, firstSeenAt: r.first_seen_at, openSince: r.open_since, segments: []
    };
}

export async function loadPeopleAndRecords(env) {
    const [people, records] = await env.DB.batch([
        env.DB.prepare("SELECT * FROM people ORDER BY added_at"),
        env.DB.prepare("SELECT * FROM records")
    ]);
    const recMap = new Map();
    for (const row of records.results) recMap.set(row.user_id, recordFromRow(row));
    return { people: peopleFromRows(people.results), records: recMap };
}

/* ---------- segments ---------- */
export function segmentFromRow(r) {
    const seg = { s: r.s, e: r.e, st: r.st };
    if (r.adj) seg.adj = true;
    return seg;
}

// Loads each record's most recent segments into rec.segments and remembers what
// they looked like, so saveRecords() only writes what changed.
export async function loadTails(env, recs) {
    if (recs.length === 0) return;
    const byUser = new Map(recs.map((r) => [r.userId, r]));
    for (const rec of recs) { rec.segments = []; rec._orig = new Map(); }
    for (const group of chunkRows(recs, 1)) {
        const sql = group.map(() => `SELECT * FROM (SELECT id, user_id, s, e, st, adj FROM segments WHERE user_id = ? ORDER BY s DESC LIMIT ${TAIL})`).join(" UNION ALL ");
        const { results } = await env.DB.prepare(sql).bind(...group.map((r) => r.userId)).all();
        for (const row of results) {
            const rec = byUser.get(row.user_id);
            const seg = segmentFromRow(row);
            seg._id = row.id;
            rec.segments.push(seg);
            rec._orig.set(row.id, segKey(seg));
        }
    }
    for (const rec of recs) rec.segments.sort((a, b) => a.s - b.s);
}

function segKey(seg) { return `${seg.s}|${seg.e}|${seg.st}|${seg.adj ? 1 : 0}`; }

// Statements that write back records, changed segments and new log entries.
export function saveStatements(env, recs, logs) {
    const stmts = [];

    const recordRows = recs.map((r) => [r.userId, r.userLabel, r.availability, r.activity, r.checkedAt, r.firstSeenAt, r.openSince]);
    for (const rows of chunkRows(recordRows, 7)) {
        stmts.push(env.DB.prepare(
            `INSERT INTO records (user_id, user_label, availability, activity, checked_at, first_seen_at, open_since)
             VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
             ON CONFLICT(user_id) DO UPDATE SET user_label = excluded.user_label, availability = excluded.availability,
               activity = excluded.activity, checked_at = excluded.checked_at, first_seen_at = excluded.first_seen_at,
               open_since = excluded.open_since`
        ).bind(...rows.flat()));
    }

    const deletes = [];
    const upserts = [];
    for (const rec of recs) {
        const orig = rec._orig || new Map();
        const kept = new Set();
        for (const seg of rec.segments) {
            if (seg._id && orig.has(seg._id)) {
                kept.add(seg._id);
                if (orig.get(seg._id) !== segKey(seg)) upserts.push([seg._id, rec.userId, seg.s, seg.e, seg.st, seg.adj ? 1 : 0]);
            } else {
                upserts.push([null, rec.userId, seg.s, seg.e, seg.st, seg.adj ? 1 : 0]);
            }
        }
        for (const id of orig.keys()) if (!kept.has(id)) deletes.push(id);
    }
    for (const ids of chunkRows(deletes, 1)) {
        stmts.push(env.DB.prepare(`DELETE FROM segments WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids));
    }
    for (const rows of chunkRows(upserts, 6)) {
        stmts.push(env.DB.prepare(
            `INSERT INTO segments (id, user_id, s, e, st, adj) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
             ON CONFLICT(id) DO UPDATE SET s = excluded.s, e = excluded.e, st = excluded.st, adj = excluded.adj`
        ).bind(...rows.flat()));
    }

    const logRows = logs.map((l) => [l.ts, l.userId, l.userLabel, l.fromAvailability, l.toAvailability, l.activity]);
    for (const rows of chunkRows(logRows, 6)) {
        stmts.push(env.DB.prepare(
            `INSERT INTO logs (ts, user_id, user_label, from_av, to_av, activity) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`
        ).bind(...rows.flat()));
    }
    return stmts;
}

export function pruneStatements(env, nowMs) {
    const cutoff = nowMs - KEEP_MS;
    return [
        env.DB.prepare("DELETE FROM segments WHERE e < ?").bind(cutoff),
        env.DB.prepare("DELETE FROM logs WHERE ts < ?").bind(cutoff)
    ];
}

/* ---------- reading for the portal ---------- */
export function logFromRow(r) {
    return {
        id: r.id, timestamp: new Date(r.ts).toISOString(), userId: r.user_id, userLabel: r.user_label,
        fromAvailability: r.from_av, toAvailability: r.to_av, activity: r.activity
    };
}

// Segments for the portal. Without `since`, everything kept. With `since`, for each
// person: the last segment starting before `since` and everything after it — which
// covers every segment a check could have changed since the portal last asked.
export async function segmentsForPortal(env, userIds, since) {
    const out = {};
    if (!since) {
        const { results } = await env.DB.prepare("SELECT user_id, s, e, st, adj FROM segments ORDER BY user_id, s").all();
        for (const id of userIds) out[id] = [];
        for (const row of results) (out[row.user_id] ||= []).push(segmentFromRow(row));
        return out;
    }
    for (const group of chunkRows(userIds, 4)) {
        const sql = group.map(() => `SELECT * FROM (SELECT user_id, s, e, st, adj FROM segments
            WHERE user_id = ? AND s >= COALESCE((SELECT MAX(s) FROM segments WHERE user_id = ? AND s < ?), ?))`).join(" UNION ALL ");
        const params = group.flatMap((id) => [id, id, since, since]);
        const { results } = await env.DB.prepare(sql).bind(...params).all();
        for (const id of group) out[id] = [];
        for (const row of results) out[row.user_id].push(segmentFromRow(row));
    }
    for (const id of Object.keys(out)) out[id].sort((a, b) => a.s - b.s);
    return out;
}
