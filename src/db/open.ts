import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION, TOOL_IDS } from "./schema.js";
import { migrate } from "./migrate.js";
import { stampPlatform } from "./portability.js";

export type Db = Database.Database;

/** contentless_delete=1 landed in SQLite 3.43. */
const MIN_SQLITE = [3, 43, 0] as const;

export function sqliteVersion(db: Db): string {
  return (db.prepare("select sqlite_version() as v").get() as { v: string }).v;
}

export function assertSqliteCapabilities(db: Db): void {
  const v = sqliteVersion(db);
  const parts = v.split(".").map((n) => Number.parseInt(n, 10));
  const [maj = 0, min = 0, patch = 0] = parts;
  const ok =
    maj > MIN_SQLITE[0] ||
    (maj === MIN_SQLITE[0] && (min > MIN_SQLITE[1] || (min === MIN_SQLITE[1] && patch >= MIN_SQLITE[2])));
  if (!ok) {
    throw new Error(
      `SQLite ${v} is too old: contentless FTS5 with contentless_delete=1 needs >= 3.43. ` +
        `Upgrade better-sqlite3.`,
    );
  }
}

/**
 * A hub file that SQLite refuses to read at all. Distinguished from every other
 * failure because it is the one case no command can recover from on its own —
 * the CLI turns it into a `cam doctor` / `cam rebuild` hint instead of a stack
 * trace.
 */
export class HubUnreadableError extends Error {
  constructor(
    readonly dbPath: string,
    readonly detail: string,
  ) {
    super(`az adatbázis nem olvasható (${dbPath}): ${detail}`);
    this.name = "HubUnreadableError";
  }
}

const CORRUPTION_CODES = new Set([
  "SQLITE_CORRUPT",
  "SQLITE_CORRUPT_VTAB",
  "SQLITE_NOTADB",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR_SHORT_READ",
]);

/** Does this failure mean the file itself is damaged, rather than the query? */
export function isCorruption(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (typeof e.code === "string" && CORRUPTION_CODES.has(e.code)) return true;
  const m = e.message ?? "";
  return /malformed|not a database|database disk image/i.test(m);
}

export function openHub(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db: Db | null = null;
  try {
    db = new Database(dbPath);
    // The first pragma is where a damaged file actually fails: the constructor
    // above only opens the handle.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
  } catch (err) {
    // The handle is already open at this point; leaving it behind would keep
    // the damaged file locked for the rest of the process.
    db?.close();
    if (isCorruption(err)) throw new HubUnreadableError(dbPath, (err as Error).message);
    throw err;
  }
  assertSqliteCapabilities(db);
  return db;
}

/**
 * `pragma quick_check` without the per-row index verification: enough to catch
 * a damaged file, cheap enough to run from `doctor`. Returns the problems
 * found, empty when the database is sound.
 */
export function quickCheck(db: Db, maxErrors = 10): string[] {
  try {
    const rows = db.pragma(`quick_check(${maxErrors})`) as Array<{ quick_check: string }>;
    const messages = rows.map((r) => r.quick_check).filter((m) => m !== "ok");
    return messages;
  } catch (err) {
    return [(err as Error).message];
  }
}

/**
 * Read-only handle on somebody else's live store. Never writes, never blocks
 * the owning application. `immutable` is deliberately NOT set: these DBs have
 * live WALs and immutable would read torn pages.
 */
export function openSourceReadonly(filePath: string): Db {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    // The Cursor store is ~8 GB; keep the page cache bounded (negative = KiB).
    db.pragma("cache_size = -16000");
  } catch (err) {
    // A file that is not a database fails here, not in the constructor. Leaving
    // the handle open would hold a lock on somebody else's store.
    db.close();
    throw err;
  }
  return db;
}

export function initSchema(db: Db): void {
  // Columns first: `CREATE INDEX IF NOT EXISTS` over a column an older table
  // does not have yet fails despite the IF NOT EXISTS, so the upgrade has to
  // happen before the DDL, not after it.
  migrate(db);
  db.exec(SCHEMA_SQL);
  // Again afterwards: on a fresh hub the first pass had no tables to work with.
  migrate(db);
  const tx = db.transaction(() => {
    const tool = db.prepare("insert or ignore into tools(id) values (?)");
    for (const t of TOOL_IDS) tool.run(t);
    // No seeded roots or aliases: workspace roots are learned from the corpus
    // (see attribution/roots.ts) and aliases are the user's own decisions.
    db.prepare("insert or replace into meta(key, value) values ('schema_version', ?)").run(String(SCHEMA_VERSION));
    stampPlatform(db);
  });
  tx();
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("insert or replace into meta(key, value) values (?, ?)").run(key, value);
}
