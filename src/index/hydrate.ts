import fs from "node:fs";
import type { Db } from "../db/open.js";
import { openSourceReadonly } from "../db/open.js";
import { pluck, readLineAt, sha256 } from "./jsonl.js";

export type Availability = "ok" | "stale" | "missing";

/** Separates the key columns inside a `sqlite_row` locator's `loc_key`. */
export const KEY_SEP = "\u001f";

/**
 * The only tables a `sqlite_row` locator may name.
 *
 * Identifiers cannot be bound as parameters, so they are interpolated into the
 * query — which means they must not come from the database unchecked. A stored
 * locator naming anything else is treated as unreadable, not as SQL.
 */
const SQLITE_ROW_TABLES: Record<
  string,
  { keyColumns: readonly string[]; keyTypes: readonly ("text" | "int")[]; columns: readonly string[] }
> = {
  message_nodes: {
    keyColumns: ["session_id", "node_id"],
    keyTypes: ["text", "int"],
    columns: ["chat_message"],
  },
};

/** What a turn reads as once its source is gone. Shown to the user, never indexed. */
export const MISSING_MARK = "[source missing]";

export interface TurnRow {
  id: number;
  session_id: number;
  seq: number;
  role: string;
  ts_ms: number | null;
  text_sha256: string;
  locator_kind: string;
  loc_path: string | null;
  loc_off: number | null;
  loc_len: number | null;
  loc_key: string | null;
  loc_field: string | null;
  loc_table: string | null;
  loc_column: string | null;
  inline_text: string | null;
  availability: string;
}

export interface Resolved {
  text: string | null;
  status: Availability;
}

/**
 * Read a turn's text back from wherever it lives. The hub stores locators, not
 * copies, so this is where the "no duplication" rule is paid for.
 *
 * A drifted or deleted source is reported, never silently omitted: a result
 * that says "[source missing]" is honest, a quietly dropped turn is not.
 */
export class Hydrator {
  private readonly sourceDbs = new Map<string, ReturnType<typeof openSourceReadonly> | null>();

  constructor(private readonly db: Db) {}

  close(): void {
    for (const handle of this.sourceDbs.values()) handle?.close();
    this.sourceDbs.clear();
  }

  private sourceDb(path: string): ReturnType<typeof openSourceReadonly> | null {
    if (!this.sourceDbs.has(path)) {
      try {
        this.sourceDbs.set(path, openSourceReadonly(path));
      } catch {
        this.sourceDbs.set(path, null);
      }
    }
    return this.sourceDbs.get(path) ?? null;
  }

  resolve(turn: TurnRow): Resolved {
    const raw = this.read(turn);
    if (raw === null) return this.record(turn, { text: null, status: "missing" });
    if (sha256(raw) !== turn.text_sha256) return this.record(turn, { text: raw, status: "stale" });
    return this.record(turn, { text: raw, status: "ok" });
  }

  private read(turn: TurnRow): string | null {
    switch (turn.locator_kind) {
      case "inline":
        return turn.inline_text;

      case "jsonl_line": {
        if (!turn.loc_path || turn.loc_off === null || turn.loc_len === null) return null;
        const rec = readLineAt(turn.loc_path, turn.loc_off, turn.loc_len);
        if (rec === null) return null;
        return turn.loc_field ? pluck(rec, turn.loc_field) : null;
      }

      case "sqlite_kv": {
        if (!turn.loc_path || !turn.loc_key) return null;
        const src = this.sourceDb(turn.loc_path);
        if (!src) return null;
        try {
          const row = src.prepare("select value from cursorDiskKV where key = ?").get(turn.loc_key) as
            | { value: Buffer | string }
            | undefined;
          if (!row) return null;
          return this.pluckJson(row.value, turn.loc_field);
        } catch {
          return null;
        }
      }

      case "sqlite_row": {
        if (!turn.loc_path || !turn.loc_key || !turn.loc_table || !turn.loc_column) return null;
        const spec = SQLITE_ROW_TABLES[turn.loc_table];
        // The table and column name go into SQL text, so they are never taken
        // from the row as written: only a shape this build knows how to read is
        // accepted, and an unknown one reads as missing rather than as a query.
        if (!spec || !spec.columns.includes(turn.loc_column)) return null;
        const keys = turn.loc_key.split(KEY_SEP);
        if (keys.length !== spec.keyColumns.length) return null;
        const src = this.sourceDb(turn.loc_path);
        if (!src) return null;
        try {
          const where = spec.keyColumns.map((c) => `"${c}" = ?`).join(" and ");
          const row = src
            .prepare(`select "${turn.loc_column}" as value from "${turn.loc_table}" where ${where}`)
            .get(...spec.keyTypes.map((t, i) => (t === "int" ? Number(keys[i]) : keys[i]))) as
            | { value: Buffer | string | null }
            | undefined;
          if (!row || row.value === null) return null;
          return this.pluckJson(row.value, turn.loc_field);
        } catch {
          return null;
        }
      }

      case "file_range": {
        if (!turn.loc_path) return null;
        try {
          const buf = fs.readFileSync(turn.loc_path);
          const text =
            turn.loc_off !== null && turn.loc_len !== null
              ? buf.subarray(turn.loc_off, turn.loc_off + turn.loc_len).toString("utf8")
              : buf.toString("utf8");
          // Without a field the range IS the text; with one the range is a JSON
          // document and the field names the value inside it.
          if (!turn.loc_field) return text;
          return pluck(JSON.parse(text), turn.loc_field);
        } catch {
          return null;
        }
      }

      default:
        return null;
    }
  }

  /**
   * A stored value that is JSON text, reduced to the one field the locator
   * names. Shared by both SQLite locators, which differ only in how the row is
   * found, not in what the value holds.
   */
  private pluckJson(value: Buffer | string, field: string | null): string | null {
    const text = typeof value === "string" ? value : value.toString("utf8");
    if (!field) return null;
    return pluck(JSON.parse(text), field);
  }

  /** Self-healing signal: what we learned at read time is written back. */
  private record(turn: TurnRow, out: Resolved): Resolved {
    if (turn.availability !== out.status) {
      this.db.prepare("update turns set availability = ? where id = ?").run(out.status, turn.id);
      turn.availability = out.status;
    }
    return out;
  }

  /**
   * Concatenate a chunk's turns, marking whatever could not be read. `readable`
   * counts the turns that came back with text: a chunk where that is zero holds
   * nothing but placeholders, so there is nothing worth indexing.
   */
  resolveChunk(chunkId: number): { text: string; status: Availability; readable: number; turns: number } {
    const rows = this.db
      .prepare(
        `select t.* from turns t
         join chunks c on c.session_id = t.session_id
         where c.id = ? and t.seq between c.seq_start and c.seq_end
         order by t.seq`,
      )
      .all(chunkId) as TurnRow[];

    const parts: string[] = [];
    let worst: Availability = "ok";
    let readable = 0;
    for (const row of rows) {
      const r = this.resolve(row);
      if (r.status === "missing") {
        parts.push(`${row.role}: ${MISSING_MARK}`);
        worst = "missing";
      } else {
        parts.push(`${row.role}: ${r.text ?? ""}`);
        readable++;
        if (r.status === "stale" && worst === "ok") worst = "stale";
      }
    }
    return { text: parts.join("\n"), status: worst, readable, turns: rows.length };
  }
}
