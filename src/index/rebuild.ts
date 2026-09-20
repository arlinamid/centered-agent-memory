import { createHash } from "node:crypto";
import { initSchema, type Db } from "../db/open.js";
import { CURRENT_RENDER_VERSION, readRenderVersion, writeRenderVersion, type RenderVersion } from "./denoise.js";
import { Hydrator, MISSING_MARK } from "./hydrate.js";

export interface RebuildStat {
  chunks: number;
  /** Chunks whose text could be read back and re-indexed. */
  indexed: number;
  /** Chunks whose source has drifted since indexing — indexed as it reads now. */
  stale: number;
  /** Chunks with at least one turn whose source is gone. */
  missing: number;
  /** Chunks whose stored hash was recomputed because the rendering changed. */
  rehashed: number;
  /** The rendering this hub now holds. */
  renderVersion: RenderVersion;
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
export function rebuildFts(
  db: Db,
  onProgress?: (done: number, total: number) => void,
  target: RenderVersion = CURRENT_RENDER_VERSION,
): RebuildStat {
  const was = readRenderVersion(db);
  const stat: RebuildStat = { chunks: 0, indexed: 0, stale: 0, missing: 0, rehashed: 0, renderVersion: target };

  // A corrupt virtual table cannot be deleted from, only dropped. initSchema
  // recreates it (and the delete trigger) from the same DDL as a fresh hub.
  db.exec("drop table if exists chunks_fts");
  initSchema(db);

  const ids = (db.prepare("select id from chunks order by id").all() as Array<{ id: number }>).map((r) => r.id);
  stat.chunks = ids.length;
  if (ids.length === 0) {
    writeRenderVersion(db, target);
    return stat;
  }

  // Read with the rendering we are moving to, not the one the hub holds: this
  // pass is what makes the two agree again.
  const hydrator = new Hydrator(db, target);
  const rehash = db.prepare("update chunks set text_sha256 = ? where id = ?");
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
          // The stored hash is what `planEmbeddings` compares against, so a
          // changed rendering has to be written back or every chunk silently
          // stops being embeddable. Only a chunk that read back cleanly earns a
          // new hash: rehashing a drifted source would record the drift as if
          // it had always been there, and lose the one signal that says so.
          if (was !== target && status === "ok") {
            if (rehash.run(createHash("sha256").update(text).digest("hex"), id).changes) stat.rehashed++;
          }
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

  // Last, so an interrupted rebuild leaves the hub claiming the rendering it
  // still mostly holds rather than one it only partly has.
  writeRenderVersion(db, target);
  return stat;
}
