import fs from "node:fs";
import path from "node:path";
import { upsertSession } from "../index/indexer.js";
import { ensureSource, recordVersionSync } from "../index/watermarks.js";
import { cascadeFileVersion, isCascadeFilename, isDevinCliSession } from "../sources/devin-fetch.js";
import { emptyStat, readDirOrNull, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Devin desktop / Windsurf Cascade: metadata only.
 *
 * `~/.codeium/windsurf/cascade/<uuid>.pb` is encrypted. We record that the
 * conversation exists — filename, mtime, size — and do not open the bytes.
 * The body arrives later, when somebody asks for that id by name.
 *
 * A Devin CLI session with the same id wins: that store is readable, and
 * overwriting it with an empty Cascade stub would hide the turns.
 */
export const devinCascadeCollector: Collector = {
  tool: "devin",
  name: "devin-cascade",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    const dir = path.join(ctx.roots.windsurfHome, "cascade");
    if (!fs.existsSync(dir)) return stat;

    const entries = readDirOrNull(dir, ctx, stat);
    if (!entries) return stat;

    for (const entry of entries) {
      if (!entry.isFile() || !isCascadeFilename(entry.name)) continue;
      const id = entry.name.slice(0, -".pb".length);
      try {
        upsertCascade(ctx, path.join(dir, entry.name), id, stat);
      } catch (err) {
        stat.errors++;
        ctx.log(`devin-cascade: ${entry.name}: ${(err as Error).message}`);
      }
    }
    return stat;
  },
};

function upsertCascade(ctx: CollectorCtx, file: string, id: string, stat: SyncStat): void {
  if (isDevinCliSession(ctx.hub, id)) {
    stat.skipped++;
    return;
  }

  let mtimeMs: number;
  try {
    mtimeMs = Math.round(fs.statSync(file).mtimeMs);
  } catch {
    stat.errors++;
    ctx.log(`devin-cascade: ${file}: unreadable`);
    return;
  }

  const version = cascadeFileVersion(file);
  if (version === null) {
    stat.errors++;
    ctx.log(`devin-cascade: ${file}: unreadable`);
    return;
  }

  const source = ensureSource(ctx.hub, "devin", "file", file);
  if (!ctx.repair && source.ext_version === version) {
    stat.skipped++;
    return;
  }

  upsertSession(ctx.hub, {
    tool: "devin",
    extId: id,
    sourceId: source.id,
    startedMs: mtimeMs,
    endedMs: mtimeMs,
  });

  const tx = ctx.hub.transaction(() => {
    recordVersionSync(ctx.hub, source.id, version, ctx.now());
  });
  tx();
  stat.sessions++;
}
