import fs from "node:fs";
import type { Db } from "../db/open.js";
import type { ToolId } from "../db/schema.js";
import { prefixHash, prefixWindow } from "./jsonl.js";

export interface SourceRow {
  id: number;
  tool: string;
  kind: string;
  locator: string;
  size_bytes: number | null;
  mtime_ms: number | null;
  bytes_indexed: number;
  prefix_sha256: string | null;
  ext_version: number | null;
  last_synced_ms: number | null;
  status: string;
}

export type FileVerdict =
  | { action: "skip"; row: SourceRow }
  | { action: "append"; row: SourceRow; from: number }
  | { action: "full"; row: SourceRow; reason: "new" | "rotated" | "repair" }
  | { action: "missing"; row: SourceRow };

export function getSource(db: Db, tool: ToolId, locator: string): SourceRow | undefined {
  return db.prepare("select * from sources where tool = ? and locator = ?").get(tool, locator) as
    | SourceRow
    | undefined;
}

export function ensureSource(db: Db, tool: ToolId, kind: string, locator: string): SourceRow {
  db.prepare("insert or ignore into sources(tool, kind, locator) values (?,?,?)").run(tool, kind, locator);
  return getSource(db, tool, locator)!;
}

/**
 * Decide how much of an append-only file needs reading.
 *
 * Same size and mtime means zero reads — that is what keeps a re-sync cheap.
 * A grown file is only trusted as an append when the fixed prefix window still
 * hashes the same; otherwise the file was rewritten and we start over.
 */
export function classifyFile(db: Db, tool: ToolId, locator: string, opts: { repair?: boolean } = {}): FileVerdict {
  const row = ensureSource(db, tool, "jsonl", locator);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(locator);
  } catch {
    db.prepare("update sources set status = 'missing' where id = ?").run(row.id);
    return { action: "missing", row };
  }

  const size = stat.size;
  const mtime = Math.round(stat.mtimeMs);

  if (opts.repair) return { action: "full", row, reason: "repair" };
  if (row.bytes_indexed === 0) return { action: "full", row, reason: "new" };
  if (row.status !== "ok") return { action: "full", row, reason: "repair" };
  if (size < row.bytes_indexed) return { action: "full", row, reason: "rotated" };

  // The prefix window is verified even on the "nothing changed" path. Size and
  // mtime alone would miss a file rewritten to the same length within one mtime
  // tick — rare, but it would skip the new content permanently and silently,
  // which is the one failure this tool must not have. The check is a single
  // 4 KiB read.
  const win = prefixWindow(row.bytes_indexed);
  const hash = prefixHash(locator, win);
  if (!hash || (row.prefix_sha256 && hash !== row.prefix_sha256)) {
    return { action: "full", row, reason: "rotated" };
  }

  if (row.size_bytes === size && row.mtime_ms === mtime) return { action: "skip", row };
  return { action: "append", row, from: row.bytes_indexed };
}

export function recordFileSync(db: Db, sourceId: number, locator: string, bytesIndexed: number, nowMs: number): void {
  let size: number | null = null;
  let mtime: number | null = null;
  try {
    const st = fs.statSync(locator);
    size = st.size;
    mtime = Math.round(st.mtimeMs);
  } catch {
    /* the file vanished mid-sync; leave the numbers null */
  }
  db.prepare(
    `update sources set size_bytes = ?, mtime_ms = ?, bytes_indexed = ?, prefix_sha256 = ?,
       last_synced_ms = ?, status = 'ok' where id = ?`,
  ).run(size, mtime, bytesIndexed, prefixHash(locator, prefixWindow(bytesIndexed)), nowMs, sourceId);
}

/** For stores addressed by a version number rather than a byte offset (Cursor, Codex). */
export function recordVersionSync(db: Db, sourceId: number, extVersion: number | null, nowMs: number): void {
  db.prepare("update sources set ext_version = ?, last_synced_ms = ?, status = 'ok' where id = ?").run(
    extVersion,
    nowMs,
    sourceId,
  );
}

/**
 * The source shrank under us. Reset the watermark so the next run re-reads it
 * whole; leaving `bytes_indexed` ahead of the file would skip the rewritten
 * content forever.
 */
export function markRotated(db: Db, sourceId: number): void {
  db.prepare("update sources set status = 'rotated', bytes_indexed = 0, prefix_sha256 = null where id = ?").run(
    sourceId,
  );
}
