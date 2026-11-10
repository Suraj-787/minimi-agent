-- Every statement is IF NOT EXISTS, so running this file on each boot is the migration.
-- Later schema changes: bump SCHEMA_VERSION in db/index.ts and append an ALTER step there.

CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,   -- UTC ISO
  updated_at TEXT NOT NULL    -- UTC ISO
);

-- seq (not the implicit rowid) is the FTS content key: rowids of tables without an INTEGER
-- primary key can be renumbered by VACUUM, which would silently desync the external-content index.
CREATE TABLE IF NOT EXISTS messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text       TEXT NOT NULL,
  parts_json TEXT,
  -- 'partial' = stream was cut before the model finished; 'error' = provider failed.
  -- Both still get a row so a user message never exists without an assistant reply.
  status     TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'partial', 'error')),
  created_at TEXT NOT NULL,   -- UTC ISO
  local_date TEXT NOT NULL,   -- YYYY-MM-DD in the user's timezone
  tz         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_local_date ON messages(local_date);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='seq'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.seq, new.text);
END;

CREATE TABLE IF NOT EXISTS turn_summaries (
  turn_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, -- assistant message id
  thread_id  TEXT NOT NULL,
  local_date TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_summaries_date ON turn_summaries(local_date);

-- No foreign keys on purpose: the ledger is never hard-deleted by the system (CLAUDE.md rule 10),
-- so deleting a thread must not cascade into claims.
CREATE TABLE IF NOT EXISTS claims (
  id               TEXT PRIMARY KEY,
  key              TEXT NOT NULL,
  entity           TEXT NOT NULL,
  attribute        TEXT NOT NULL,
  value            TEXT NOT NULL,
  source_url       TEXT,
  turn_id          TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  valid_as_of      TEXT,
  last_verified_at TEXT NOT NULL,
  superseded_by    TEXT,
  superseded_at    TEXT,
  status           TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'forgotten'))
);
CREATE INDEX IF NOT EXISTS idx_claims_key_status ON claims(key, status);
CREATE INDEX IF NOT EXISTS idx_claims_turn ON claims(turn_id);

CREATE TABLE IF NOT EXISTS memory_writes (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT,
  op          TEXT NOT NULL CHECK (op IN ('add', 'touch', 'supersede', 'forget', 'rejected', 'error')),
  claim_id    TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_writes_turn ON memory_writes(turn_id);

CREATE TABLE IF NOT EXISTS search_cache (
  cache_key     TEXT PRIMARY KEY,  -- provider + normalised query + filters
  provider      TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  turn_id             TEXT PRIMARY KEY,
  thread_id           TEXT NOT NULL,
  intent_json         TEXT,
  resolved_dates_json TEXT,
  recall_rules_json   TEXT,
  memory_ids_json     TEXT,
  memory_chars        INTEGER,
  queries_json        TEXT,
  provider            TEXT,
  context_ms          INTEGER,
  first_token_ms      INTEGER,
  total_ms            INTEGER,
  usage_json          TEXT,
  errors_json         TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_cache (
  key           TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
