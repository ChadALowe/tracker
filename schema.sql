-- For reference only: the Worker creates these tables itself on first run.
CREATE TABLE IF NOT EXISTS people ( id TEXT PRIMARY KEY, display_name TEXT, mail TEXT, upn TEXT, added_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records ( user_id TEXT PRIMARY KEY, user_label TEXT, availability TEXT, activity TEXT, checked_at INTEGER, first_seen_at INTEGER, open_since INTEGER);
CREATE TABLE IF NOT EXISTS segments ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, s INTEGER NOT NULL, e INTEGER NOT NULL, st TEXT NOT NULL, adj INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS segments_user_s ON segments (user_id, s);
CREATE TABLE IF NOT EXISTS logs ( id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT NOT NULL, user_label TEXT, from_av TEXT, to_av TEXT, activity TEXT);
CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
