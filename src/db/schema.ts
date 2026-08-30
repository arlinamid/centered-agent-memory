export const SCHEMA_VERSION = 5;

/** Every source we can index. */
export const TOOL_IDS = [
  "claude_code",
  "claude_desktop",
  "cowork",
  "codex",
  "cursor",
  "gemini_cli",
  "antigravity",
  "devin",
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/**
 * Core rule: `turns` stores a LOCATOR, not the text — no exceptions today.
 * `turns.inline_text` is reserved for a volatile source whose text would be
 * gone before it could be read back; no collector writes it. The volatile
 * material we do keep (Temp scratchpads, Cowork outputs) lives on
 * `artifacts.inline_text`.
 *
 * `chunks_fts` is contentless (`content=''`): the inverted index exists, the
 * text does not. Requires SQLite >= 3.43 for `contentless_delete`; verified at
 * open time. Note `snippet()` returns NULL on contentless tables, so excerpts
 * come from rehydration.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  -- Normalized directory the key came from. Remembered so a project that is
  -- moved or deleted still resolves.
  root_path     TEXT,
  first_seen_ms INTEGER,
  last_seen_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS project_aliases (
  alias TEXT PRIMARY KEY,
  key   TEXT NOT NULL,
  kind  TEXT NOT NULL DEFAULT 'manual'
);

-- Learned from the corpus, not configured: a directory whose children are the
-- working directories of several different sessions holds projects rather than
-- being one. 'manual' rows are user overrides and survive re-detection.
CREATE TABLE IF NOT EXISTS workspace_roots (
  root     TEXT PRIMARY KEY,
  children INTEGER NOT NULL DEFAULT 0,
  kind     TEXT NOT NULL DEFAULT 'learned'
);

CREATE TABLE IF NOT EXISTS sources (
  id             INTEGER PRIMARY KEY,
  tool           TEXT NOT NULL REFERENCES tools(id),
  kind           TEXT NOT NULL,
  locator        TEXT NOT NULL,
  size_bytes     INTEGER,
  mtime_ms       INTEGER,
  bytes_indexed  INTEGER NOT NULL DEFAULT 0,
  prefix_sha256  TEXT,
  ext_version    INTEGER,
  last_synced_ms INTEGER,
  status         TEXT NOT NULL DEFAULT 'ok',
  UNIQUE(tool, locator)
);
CREATE INDEX IF NOT EXISTS idx_sources_tool_status ON sources(tool, status);

CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY,
  tool           TEXT NOT NULL REFERENCES tools(id),
  ext_id         TEXT NOT NULL,
  source_id      INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  parent_ext_id  TEXT,
  role           TEXT NOT NULL DEFAULT 'main',
  agent_role     TEXT,
  agent_nickname TEXT,
  title          TEXT,
  title_origin   TEXT,
  cwd_raw        TEXT,
  cwd_norm       TEXT,
  started_ms     INTEGER,
  ended_ms       INTEGER,
  turn_count     INTEGER NOT NULL DEFAULT 0,
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  UNIQUE(tool, ext_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_tool_time    ON sessions(tool, started_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_parent       ON sessions(tool, parent_ext_id);
CREATE INDEX IF NOT EXISTS idx_sessions_source       ON sessions(source_id);

CREATE TABLE IF NOT EXISTS turns (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  ts_ms        INTEGER,
  char_len     INTEGER NOT NULL,
  text_sha256  TEXT NOT NULL,
  locator_kind TEXT NOT NULL,
  loc_path     TEXT,
  loc_off      INTEGER,
  loc_len      INTEGER,
  loc_key      TEXT,
  loc_field    TEXT,
  -- Only for the sqlite_row locator: which table and column the key
  -- addresses. A store that is not a single key/value table (Devin's
  -- message_nodes) cannot be described by loc_key alone.
  loc_table    TEXT,
  loc_column   TEXT,
  inline_text  TEXT,
  availability TEXT NOT NULL DEFAULT 'ok',
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_id, seq);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq_start   INTEGER NOT NULL,
  seq_end     INTEGER NOT NULL,
  char_len    INTEGER NOT NULL,
  text_sha256 TEXT NOT NULL,
  ts_ms       INTEGER,
  project_id  INTEGER,
  UNIQUE(session_id, seq_start, seq_end)
);
CREATE INDEX IF NOT EXISTS idx_chunks_project_ts ON chunks(project_id, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_session    ON chunks(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

-- chunks_fts is contentless and has no foreign key of its own, so a plain
-- "delete from chunks" (or an ON DELETE CASCADE from sessions) would leave
-- orphaned index rows behind forever. The trigger enforces the invariant at the
-- schema level, whatever the caller does.
CREATE TRIGGER IF NOT EXISTS chunks_after_delete AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.id;
END;

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model    TEXT NOT NULL,
  dims     INTEGER NOT NULL,
  embedding BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS path_evidence (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  origin      TEXT NOT NULL,
  raw_path    TEXT NOT NULL,
  project_key TEXT,
  weight      REAL NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pe_session ON path_evidence(session_id);
CREATE INDEX IF NOT EXISTS idx_pe_key     ON path_evidence(project_key);

CREATE TABLE IF NOT EXISTS attribution (
  session_id     INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  method         TEXT NOT NULL,
  confidence     TEXT NOT NULL,
  score          REAL,
  runner_up_key  TEXT,
  runner_up_score REAL,
  computed_ms    INTEGER NOT NULL,
  rule_version   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attr_conf ON attribution(confidence);

CREATE TABLE IF NOT EXISTS file_events (
  id          INTEGER PRIMARY KEY,
  project_key TEXT,
  resource    TEXT NOT NULL,
  ts_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fe_ts       ON file_events(ts_ms);
CREATE INDEX IF NOT EXISTS idx_fe_key_ts   ON file_events(project_key, ts_ms);
CREATE INDEX IF NOT EXISTS idx_fe_resource ON file_events(resource);

CREATE TABLE IF NOT EXISTS artifacts (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  tool        TEXT,
  path        TEXT NOT NULL,
  size_bytes  INTEGER,
  mtime_ms    INTEGER,
  sha256      TEXT,
  inline_text TEXT,
  UNIQUE(kind, path)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);

-- Written by every search, read by the memory layer (src/memory/): what a query
-- actually surfaced, and when.
CREATE TABLE IF NOT EXISTS recall_events (
  id         INTEGER PRIMARY KEY,
  chunk_id   INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
  query_hash TEXT NOT NULL,
  score      REAL,
  ts_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recall_chunk ON recall_events(chunk_id);

-- The memory layer. Nothing here copies conversation text: a promoted fact is a
-- reference to a chunk, rehydrated at read time like every other result. What
-- IS stored verbatim is the user's own search text, because "which questions
-- brought this up" is the evidence a promotion has to be able to show.
CREATE TABLE IF NOT EXISTS memory_queries (
  hash     TEXT PRIMARY KEY,
  text     TEXT NOT NULL,
  -- Parsed once, space separated, so consolidation never re-tokenizes.
  terms    TEXT NOT NULL,
  first_ms INTEGER NOT NULL,
  last_ms  INTEGER NOT NULL,
  uses     INTEGER NOT NULL DEFAULT 1
);

-- Light consolidation: the raw recall trace folded per chunk. Derived, always
-- rebuildable from recall_events.
CREATE TABLE IF NOT EXISTS memory_traces (
  chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  recalls    INTEGER NOT NULL,
  queries    INTEGER NOT NULL,
  days       INTEGER NOT NULL,
  terms      INTEGER NOT NULL,
  avg_score  REAL NOT NULL,
  first_ms   INTEGER NOT NULL,
  last_ms    INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_traces_last ON memory_traces(last_ms DESC);

-- REM consolidation: terms that keep coming back across different questions.
CREATE TABLE IF NOT EXISTS memory_topics (
  term    TEXT PRIMARY KEY,
  queries INTEGER NOT NULL,
  chunks  INTEGER NOT NULL,
  days    INTEGER NOT NULL,
  last_ms INTEGER NOT NULL
);

-- Deep consolidation: what got promoted to long-term memory, with the score
-- that promoted it and its parts, so a verdict can always be explained.
CREATE TABLE IF NOT EXISTS memory_facts (
  id           INTEGER PRIMARY KEY,
  chunk_id     INTEGER NOT NULL UNIQUE REFERENCES chunks(id) ON DELETE CASCADE,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  score        REAL NOT NULL,
  components   TEXT NOT NULL,
  recalls      INTEGER NOT NULL,
  queries      INTEGER NOT NULL,
  days         INTEGER NOT NULL,
  chars        INTEGER NOT NULL,
  first_ms     INTEGER NOT NULL,
  last_ms      INTEGER NOT NULL,
  -- Derived from the trace, never from the clock: eviction order has to be the
  -- same on every run, or two runs of the same database disagree.
  promoted_ms  INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL,
  rule_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_score    ON memory_facts(score DESC);
CREATE INDEX IF NOT EXISTS idx_memory_facts_promoted ON memory_facts(promoted_ms);
CREATE INDEX IF NOT EXISTS idx_memory_facts_project  ON memory_facts(project_id);

-- The dream phase's output: text a language model wrote about a promoted
-- memory. Derived, fallible, and the only model-generated content in the whole
-- database — kept apart from every evidence table, cached by the hash of its
-- input, and stamped with the model that produced it. Dropping this table
-- costs nothing but the regeneration.
CREATE TABLE IF NOT EXISTS memory_dreams (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,
  chunk_id       INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  input_sha256   TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  text           TEXT NOT NULL,
  chars          INTEGER NOT NULL,
  created_ms     INTEGER NOT NULL,
  UNIQUE(kind, chunk_id, input_sha256, model, prompt_version)
);
CREATE INDEX IF NOT EXISTS idx_memory_dreams_chunk ON memory_dreams(chunk_id);

-- Read by src/ops/freshness.ts: a run that never wrote its ended_ms crashed,
-- and the newest one that did is how old the index is.
CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY,
  started_ms  INTEGER NOT NULL,
  ended_ms    INTEGER,
  tool        TEXT,
  sources_seen INTEGER NOT NULL DEFAULT 0,
  -- Held sessions rather than sources until 0.4.0; sessions_seen replaced it.
  sources_synced INTEGER NOT NULL DEFAULT 0,
  sessions_seen INTEGER NOT NULL DEFAULT 0,
  turns_added INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_ended ON sync_runs(ended_ms DESC);

-- Resolution cache for the Cursor file-history resources. The collector reloads
-- file_events wholesale every day, which zeroes every project_key it holds; and
-- resolving a path is the one step in the cascade that touches the filesystem.
-- Keeping the verdicts here turns a daily 6 000-path re-resolution into a
-- lookup. A "cam reattribute" clears it, so nothing here can go permanently
-- stale.
CREATE TABLE IF NOT EXISTS path_keys (
  resource    TEXT PRIMARY KEY,
  project_key TEXT,
  resolved_ms INTEGER NOT NULL
);
`;
