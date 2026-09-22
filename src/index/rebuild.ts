import { initSchema, type Db } from "../db/open.js";
import { Hydrator, MISSING_MARK } from "./hydrate.js";

export interface RebuildStat {
  chunks: number;
  /** Chunks whose text could be read back and re-indexed. */
  indexed: number;
  /** Chunks whose source has drifted since indexing — indexed as it reads now. */
  stale: number;
  /** Chunks with at least one turn whose source is gone. */
  missing: number;
}

/**
 * Rebuild the contentless FTS index from the sources.
 *
 * `chunks_fts` stores no text, so it cannot be rebuilt from a content table the
 * way an ordinary FTS5 index can (`insert into t(t) values('rebuild')` fails on
 * `content=''`). The only place the text still exists is the original stores,
 * which is exactly what the hydrator reads — so a rebuild is a re-read, not a
 * copy operation, and a chunk whose source vanished stays out of the index and
 * is reported.
 *
 * `sync --repair` cannot do this job: it re-reads the sources for turns it does
 * not already have, and every turn here is already known.
 */
export function rebuildFts(db: Db, onProgress?: (done: number, total: number) => void): RebuildStat {
  const stat: RebuildStat = { chunks: 0, indexed: 0, stale: 0, missing: 0 };

  // A corrupt virtual table cannot be deleted from, only dropped. initSchema
  // recreates it (and the delete trigger) from the same DDL as a fresh hub.
  db.exec("drop table if exists chunks_fts");
  initSchema(db);

  const ids = (db.prepare("select id from chunks order by id").all() as Array<{ id: number }>).map((r) => r.id);
  stat.chunks = ids.length;
  if (ids.length === 0) return stat;

  const hydrator = new Hydrator(db);
  const insert = db.prepare("insert into chunks_fts(rowid, text) values (?, ?)");
  // Batched so a large corpus neither holds one enormous transaction nor pays
  // a commit per chunk.
  const BATCH = 500;
  try {
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const tx = db.transaction(() => {
        for (const id of batch) {
          const { text, status, readable } = hydrator.resolveChunk(id);
          if (status === "missing") stat.missing++;
          else if (status === "stale") stat.stale++;
          // A chunk with one lost turn out of five is still worth finding; one
          // with nothing left would only index the placeholder text.
          if (readable === 0) continue;
          insert.run(id, text.split(MISSING_MARK).join(""));
          stat.indexed++;
        }
      });
      tx();
      onProgress?.(Math.min(i + BATCH, ids.length), ids.length);
    }
  } finally {
    hydrator.close();
  }

  return stat;
}
