import { CURRENT_RENDER_VERSION, RENDER_RAW, writeRenderVersion } from "../index/denoise.js";
import type { Db } from "./open.js";
import { SCHEMA_VERSION } from "./schema.js";

/**
 * Additive, idempotent migrations for a database created by an earlier version.
 *
 * The schema DDL itself is all `IF NOT EXISTS`, so new tables, indexes and
 * triggers appear on their own. What DDL cannot do is add a column to a table
 * that already exists — that is what this handles. Every step must be safe to
 * run twice, and safe to run before the DDL: `initSchema` calls it first,
 * because `CREATE INDEX IF NOT EXISTS` over a column the old table lacks fails
 * even though the index is conditional.
 */
export function migrate(db: Db): string[] {
  const applied: string[] = [];

  const addColumn = (table: string, column: string, ddl: string): void => {
    if (!hasTable(db, table)) return; // a fresh hub: the DDL will create it whole
    if (hasColumn(db, table, column)) return;
    db.exec(`alter table ${table} add column ${ddl}`);
    applied.push(`${table}.${column}`);
  };

  addColumn("artifacts", "tool", "tool TEXT");
  addColumn("projects", "root_path", "root_path TEXT");
  addColumn("workspace_roots", "children", "children INTEGER NOT NULL DEFAULT 0");
  addColumn("workspace_roots", "kind", "kind TEXT NOT NULL DEFAULT 'learned'");
  // `sources_synced` held a session count, which the freshness report made
  // visible. The old column stays (nothing is ever dropped) and keeps its
  // historical values; new runs write the honestly named one.
  addColumn("sync_runs", "sessions_seen", "sessions_seen INTEGER NOT NULL DEFAULT 0");
  // The `sqlite_row` locator addresses a row in a named table rather than a
  // key/value pair, so the table and column travel with the key. Old rows keep
  // NULL, which is exactly right: no existing locator is a `sqlite_row`.
  addColumn("turns", "loc_table", "loc_table TEXT");
  addColumn("turns", "loc_column", "loc_column TEXT");
  addColumn("chunk_embeddings", "input_sha256", "input_sha256 TEXT");

  if (hasTable(db, "meta")) {
    db.prepare("insert or replace into meta(key, value) values ('schema_version', ?)").run(String(SCHEMA_VERSION));
    // Which rendering produced this hub's chunk hashes. A hub with no chunks
    // has rendered nothing yet, so it starts current. One that already holds
    // chunks keeps the raw rendering that produced them — changing it here
    // would invalidate every hash at once, and re-rendering is `cam rebuild`'s
    // job, where it can be reported and paid for deliberately.
    const known = db.prepare("select value from meta where key = 'render_version'").get();
    if (!known) {
      const chunks = hasTable(db, "chunks")
        ? ((db.prepare("select count(*) as n from chunks").get() as { n: number }).n ?? 0)
        : 0;
      writeRenderVersion(db, chunks === 0 ? CURRENT_RENDER_VERSION : RENDER_RAW);
    }
  }
  return applied;
}

function hasTable(db: Db, table: string): boolean {
  const row = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(table);
  return row !== undefined;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}
