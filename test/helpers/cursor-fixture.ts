import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ResolvedRoots } from "../../src/paths.js";

export interface BubbleFixture {
  id: string;
  /** 1 = user, 2 = assistant, matching Cursor's own encoding. */
  type: 1 | 2;
  text?: string;
  /** Extra JSON fields, e.g. file paths that should become evidence. */
  extra?: Record<string, unknown>;
  /** Present in composerData but with no row — a pruned bubble. */
  pruned?: boolean;
}

export interface ComposerFixture {
  id: string;
  name?: string | null;
  createdAt?: number;
  lastUpdatedAt?: number;
  bubbles: BubbleFixture[];
  /** Open-file URIs; the KEY carries them in the real store. */
  openFiles?: string[];
  requestContexts?: string[];
}

/**
 * Build a `state.vscdb` with Cursor's real DDL. The UNIQUE on `key` matters:
 * without it the index the range-seek relies on would not exist and the guard
 * test would be meaningless.
 */
export function writeCursorState(roots: ResolvedRoots, composers: ComposerFixture[]): void {
  fs.mkdirSync(path.dirname(roots.cursorStateDb), { recursive: true });
  fs.rmSync(roots.cursorStateDb, { force: true });
  const db = new Database(roots.cursorStateDb);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);

  const headers = {
    allComposers: composers.map((c) => ({
      type: "head",
      composerId: c.id,
      name: c.name ?? null,
      createdAt: c.createdAt ?? 1_787_848_595_150,
      lastUpdatedAt: c.lastUpdatedAt ?? 1_787_924_639_560,
      subtitle: "",
    })),
  };
  db.prepare("insert into ItemTable(key, value) values ('composer.composerHeaders', ?)").run(
    Buffer.from(JSON.stringify(headers), "utf8"),
  );

  const kv = db.prepare("insert into cursorDiskKV(key, value) values (?, ?)");
  for (const c of composers) {
    kv.run(
      `composerData:${c.id}`,
      Buffer.from(
        JSON.stringify({
          composerId: c.id,
          name: c.name ?? null,
          fullConversationHeadersOnly: c.bubbles.map((b) => ({ bubbleId: b.id, type: b.type })),
        }),
        "utf8",
      ),
    );
    for (const b of c.bubbles) {
      if (b.pruned) continue;
      kv.run(
        `bubbleId:${c.id}:${b.id}`,
        Buffer.from(JSON.stringify({ _v: 2, type: b.type, bubbleId: b.id, text: b.text ?? "", ...b.extra }), "utf8"),
      );
    }
    for (const uri of c.openFiles ?? []) {
      // The value is the whole file content in the real store; we never read it.
      kv.run(`ofsContent:${c.id}:${uri}`, Buffer.from("FILE CONTENT SHOULD NEVER BE READ", "utf8"));
    }
    let n = 0;
    for (const text of c.requestContexts ?? []) {
      kv.run(`messageRequestContext:${c.id}:ctx${n++}`, Buffer.from(JSON.stringify({ context: text }), "utf8"));
    }
  }

  // Noise from other conversations, so a range query that leaks would be caught.
  for (let i = 0; i < 50; i++) {
    kv.run(`bubbleId:zzzz-other-${i}:b${i}`, Buffer.from(JSON.stringify({ text: "más beszélgetés" }), "utf8"));
  }
  db.close();
}

export function touchComposer(roots: ResolvedRoots, composerId: string, lastUpdatedAt: number): void {
  const db = new Database(roots.cursorStateDb);
  const row = db.prepare("select value from ItemTable where key = 'composer.composerHeaders'").get() as {
    value: Buffer;
  };
  const parsed = JSON.parse(row.value.toString("utf8")) as {
    allComposers: Array<{ composerId: string; lastUpdatedAt: number }>;
  };
  for (const c of parsed.allComposers) if (c.composerId === composerId) c.lastUpdatedAt = lastUpdatedAt;
  db.prepare("insert into ItemTable(key, value) values ('composer.composerHeaders', ?)").run(
    Buffer.from(JSON.stringify(parsed), "utf8"),
  );
  db.close();
}

export function setBubbleText(roots: ResolvedRoots, composerId: string, bubbleId: string, text: string): void {
  const db = new Database(roots.cursorStateDb);
  db.prepare("insert into cursorDiskKV(key, value) values (?, ?)").run(
    `bubbleId:${composerId}:${bubbleId}`,
    Buffer.from(JSON.stringify({ _v: 2, bubbleId, text }), "utf8"),
  );
  db.close();
}
