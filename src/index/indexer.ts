import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import type { ToolId } from "../db/schema.js";
import { chunkTurns, type ChunkInput } from "./chunker.js";

/**
 * Where a turn's text actually lives. We store this, never the text itself.
 *
 * `sqlite_kv` addresses one key in a key/value table; `sqlite_row` addresses a
 * row in a named table, which is what a store like Devin's `message_nodes`
 * needs. `file_range` reads a whole file (or a byte span of it) and, with a
 * `field`, plucks one value out — that is how a source that writes a single
 * JSON document per session is addressed, rather than one JSON per line.
 *
 * `inline` remains reserved for a volatile source whose text would be gone
 * before it could be read back; no collector emits it. The volatile material we
 * do keep lives on the `artifacts` table instead.
 */
export type Locator =
  | { kind: "jsonl_line"; path: string; off: number; len: number; field: string }
  | { kind: "sqlite_kv"; path: string; key: string; field: string }
  | { kind: "sqlite_row"; path: string; table: string; column: string; key: string; field?: string }
  | { kind: "file_range"; path: string; off?: number; len?: number; field?: string }
  | { kind: "inline" };

export interface TurnInput {
  seq: number;
  role: "user" | "assistant";
  tsMs: number | null;
  /** Extracted text — kept in memory for chunking, persisted only for `inline`. */
  text: string;
  locator: Locator;
}

export interface SessionInput {
  tool: ToolId;
  extId: string;
  sourceId?: number | null;
  parentExtId?: string | null;
  role?: "main" | "subagent";
  agentRole?: string | null;
  agentNickname?: string | null;
  title?: string | null;
  titleOrigin?: string | null;
  cwdRaw?: string | null;
  cwdNorm?: string | null;
  startedMs?: number | null;
  endedMs?: number | null;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A title is only a title when it reads like one. Codex stores whole prompts
 * (and even entire transcripts) in `threads.title` — 739 of 917 rows on the
 * reference machine — so anything long is not a title.
 */
export const MAX_TITLE_LEN = 200;

export function usableTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || t.length >= MAX_TITLE_LEN) return null;
  if (t.includes("\n")) return null;
  return t;
}

export function upsertSession(db: Db, s: SessionInput): number {
  const existing = db.prepare("select id from sessions where tool = ? and ext_id = ?").get(s.tool, s.extId) as
    | { id: number }
    | undefined;

  if (existing) {
    // COALESCE keeps whatever we already learned when this pass has nothing
    // better to say (e.g. an enrichment collector supplying only a title).
    db.prepare(
      `update sessions set
         source_id      = coalesce(?, source_id),
         parent_ext_id  = coalesce(?, parent_ext_id),
         role           = coalesce(?, role),
         agent_role     = coalesce(?, agent_role),
         agent_nickname = coalesce(?, agent_nickname),
         title          = coalesce(?, title),
         title_origin   = coalesce(?, title_origin),
         cwd_raw        = coalesce(?, cwd_raw),
         cwd_norm       = coalesce(?, cwd_norm),
         started_ms     = min(coalesce(?, started_ms), coalesce(started_ms, ?)),
         ended_ms       = max(coalesce(?, ended_ms), coalesce(ended_ms, ?))
       where id = ?`,
    ).run(
      s.sourceId ?? null,
      s.parentExtId ?? null,
      s.role ?? null,
      s.agentRole ?? null,
      s.agentNickname ?? null,
      s.title ?? null,
      s.titleOrigin ?? null,
      s.cwdRaw ?? null,
      s.cwdNorm ?? null,
      s.startedMs ?? null,
      s.startedMs ?? null,
      s.endedMs ?? null,
      s.endedMs ?? null,
      existing.id,
    );
    return existing.id;
  }

  const info = db
    .prepare(
      `insert into sessions
        (tool, ext_id, source_id, parent_ext_id, role, agent_role, agent_nickname,
         title, title_origin, cwd_raw, cwd_norm, started_ms, ended_ms)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      s.tool,
      s.extId,
      s.sourceId ?? null,
      s.parentExtId ?? null,
      s.role ?? "main",
      s.agentRole ?? null,
      s.agentNickname ?? null,
      s.title ?? null,
      s.titleOrigin ?? null,
      s.cwdRaw ?? null,
      s.cwdNorm ?? null,
      s.startedMs ?? null,
      s.endedMs ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** Insert turns and index them. Existing seq numbers are replaced. */
export function addTurns(db: Db, sessionId: number, turns: ReadonlyArray<TurnInput>): number {
  if (turns.length === 0) return 0;

  const insert = db.prepare(
    `insert into turns
       (session_id, seq, role, ts_ms, char_len, text_sha256,
        locator_kind, loc_path, loc_off, loc_len, loc_key, loc_field,
        loc_table, loc_column, inline_text, availability)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ok')
     on conflict(session_id, seq) do update set
       role = excluded.role, ts_ms = excluded.ts_ms, char_len = excluded.char_len,
       text_sha256 = excluded.text_sha256, locator_kind = excluded.locator_kind,
       loc_path = excluded.loc_path, loc_off = excluded.loc_off, loc_len = excluded.loc_len,
       loc_key = excluded.loc_key, loc_field = excluded.loc_field,
       loc_table = excluded.loc_table, loc_column = excluded.loc_column,
       inline_text = excluded.inline_text, availability = 'ok'`,
  );

  for (const t of turns) {
    const l = t.locator;
    insert.run(
      sessionId,
      t.seq,
      t.role,
      t.tsMs,
      t.text.length,
      sha256(t.text),
      l.kind,
      l.kind === "inline" ? null : l.path,
      l.kind === "jsonl_line" ? l.off : l.kind === "file_range" ? (l.off ?? null) : null,
      l.kind === "jsonl_line" ? l.len : l.kind === "file_range" ? (l.len ?? null) : null,
      l.kind === "sqlite_kv" || l.kind === "sqlite_row" ? l.key : null,
      l.kind === "jsonl_line" || l.kind === "sqlite_kv"
        ? l.field
        : l.kind === "sqlite_row" || l.kind === "file_range"
          ? (l.field ?? null)
          : null,
      l.kind === "sqlite_row" ? l.table : null,
      l.kind === "sqlite_row" ? l.column : null,
      // The one sanctioned copy: volatile sources the OS or the app deletes.
      l.kind === "inline" ? t.text : null,
    );
  }

  db.prepare("update sessions set turn_count = (select count(*) from turns where session_id = ?) where id = ?").run(
    sessionId,
    sessionId,
  );

  indexChunks(db, sessionId, turns);
  return turns.length;
}

/**
 * Chunk a batch of turns and write the contentless FTS index. Only the batch is
 * chunked, so an incremental sync never re-reads what it already indexed; a
 * chunk therefore never spans two sync runs.
 */
export function indexChunks(db: Db, sessionId: number, turns: ReadonlyArray<TurnInput>): void {
  const inputs: ChunkInput[] = turns.map((t) => ({ seq: t.seq, role: t.role, text: t.text, tsMs: t.tsMs }));
  const chunks = chunkTurns(inputs);
  if (chunks.length === 0) return;

  const session = db.prepare("select project_id, started_ms from sessions where id = ?").get(sessionId) as {
    project_id: number | null;
    started_ms: number | null;
  };
  const projectId = session.project_id;
  // Cursor bubbles carry no timestamp of their own. Rather than inventing one
  // per turn, a chunk falls back to when its session started, so time filters
  // and ordering still work.
  const fallbackTs = session.started_ms;

  const findChunk = db.prepare(
    "select id from chunks where session_id = ? and seq_start = ? and seq_end = ?",
  );
  const insertChunk = db.prepare(
    `insert into chunks(session_id, seq_start, seq_end, char_len, text_sha256, ts_ms, project_id)
     values (?,?,?,?,?,?,?)`,
  );
  const updateChunk = db.prepare(
    "update chunks set char_len = ?, text_sha256 = ?, ts_ms = ?, project_id = ? where id = ?",
  );
  const deleteFts = db.prepare("delete from chunks_fts where rowid = ?");
  const insertFts = db.prepare("insert into chunks_fts(rowid, text) values (?, ?)");

  for (const c of chunks) {
    const existing = findChunk.get(sessionId, c.seqStart, c.seqEnd) as { id: number } | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
      updateChunk.run(c.charLen, c.sha256, c.tsMs ?? fallbackTs, projectId, id);
      deleteFts.run(id);
    } else {
      id = Number(
        insertChunk.run(sessionId, c.seqStart, c.seqEnd, c.charLen, c.sha256, c.tsMs ?? fallbackTs, projectId)
          .lastInsertRowid,
      );
    }
    insertFts.run(id, c.text);
  }
}

/** Drop everything derived from a session, for a rotated or repaired source. */
export function clearSession(db: Db, sessionId: number): void {
  // The chunks_after_delete trigger removes the matching FTS rows.
  db.prepare("delete from chunks where session_id = ?").run(sessionId);
  db.prepare("delete from turns where session_id = ?").run(sessionId);
  db.prepare("update sessions set turn_count = 0 where id = ?").run(sessionId);
}
