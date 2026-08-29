import fs from "node:fs";
import path from "node:path";
import { openHub, quickCheck, type Db } from "../db/open.js";

/**
 * Backup and move.
 *
 * The whole index is one SQLite file, so "export" is a copy — but not a `cp`:
 * with WAL on, copying the file without its `-wal` sidecar yields something
 * that opens cleanly and is missing the newest writes. SQLite's own online
 * backup API takes a consistent snapshot of a live database, which is what
 * this uses.
 *
 * The other half of moving an index is `db/portability.ts`: a copy carried to
 * a different platform matches nothing unless the path-folding convention
 * comes with it.
 */

export interface BackupResult {
  file: string;
  bytes: number;
  /** Problems `quick_check` found in the copy. Empty means the copy is sound. */
  problems: string[];
}

/** Where a backup goes when the user does not say. */
export function defaultBackupPath(dbPath: string, nowMs = Date.now()): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return path.join(path.dirname(dbPath), "backups", `${path.basename(dbPath, path.extname(dbPath))}-${stamp}.sqlite`);
}

/**
 * Snapshot the live index, then open the copy and check it. An unverified
 * backup is a guess, and the moment you find out is the moment you needed it.
 */
export async function backup(db: Db, file: string): Promise<BackupResult> {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  await db.backup(file);

  let problems: string[];
  const copy = openHub(file);
  try {
    problems = quickCheck(copy);
    // Fold the write-ahead log back in and leave the copy in rollback mode, so
    // the backup is one self-contained file. A `-wal` sidecar beside it would
    // be a second thing to remember to carry, and forgetting it silently loses
    // the newest data.
    copy.pragma("wal_checkpoint(TRUNCATE)");
    copy.pragma("journal_mode = delete");
  } finally {
    copy.close();
  }
  return { file, bytes: fs.statSync(file).size, problems };
}
