import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "../paths.js";
import { ensureSource, recordVersionSync } from "../index/watermarks.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Cursor's local file history (`User/History/<hash>/entries.json`) records which
 * file was edited and when. It says nothing about conversations directly, but a
 * Cursor conversation carries no working directory at all — so for the threads
 * that never mention a path, overlapping edit activity is the only signal left.
 *
 * Feeds `file_events`, which the attribution cascade uses at medium/weak
 * confidence.
 */
export const cursorHistoryCollector: Collector = {
  tool: "cursor",
  name: "cursor-history",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    const root = ctx.roots.cursorHistory;
    if (!fs.existsSync(root)) return stat;

    const source = ensureSource(ctx.hub, "cursor", "history", `${root}#file-history`);
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());

    // Rebuilding is a few thousand tiny reads; the directory count is the
    // change signal, and a daily rebuild is plenty for an attribution input.
    const version = dirs.length;
    const lastRun = source.last_synced_ms ?? 0;
    const aDayAgo = ctx.now() - 24 * 60 * 60 * 1000;
    if (!ctx.repair && source.ext_version === version && lastRun > aDayAgo) {
      stat.skipped++;
      return stat;
    }

    const rows: Array<{ key: string | null; resource: string; ts: number }> = [];
    for (const d of dirs) {
      const file = path.join(root, d.name, "entries.json");
      let parsed: { resource?: unknown; entries?: Array<{ timestamp?: unknown }> };
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8")) as typeof parsed;
      } catch {
        continue; // no entries.json, or mid-write
      }
      const resource = typeof parsed.resource === "string" ? parsed.resource : null;
      if (!resource) continue;
      const norm = normalizePath(resource);
      if (!norm) continue;
      for (const e of parsed.entries ?? []) {
        if (typeof e.timestamp === "number") rows.push({ key: null, resource: norm, ts: e.timestamp });
      }
    }

    const tx = ctx.hub.transaction(() => {
      ctx.hub.prepare("delete from file_events").run();
      const ins = ctx.hub.prepare("insert into file_events(project_key, resource, ts_ms) values (null, ?, ?)");
      for (const r of rows) ins.run(r.resource, r.ts);
      recordVersionSync(ctx.hub, source.id, version, ctx.now());
    });
    tx();

    stat.sessions = 0;
    stat.turns = 0;
    ctx.log(`cursor-history: ${rows.length} fájlesemény ${dirs.length} mappából`);
    return stat;
  },
};
