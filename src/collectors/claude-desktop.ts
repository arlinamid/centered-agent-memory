import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "../paths.js";
import { upsertSession, usableTitle } from "../index/indexer.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Claude Desktop keeps only an index of its Claude Code sessions:
 * `claude-code-sessions/<account>/<org>/local_*.json`, with a `cliSessionId`
 * pointing at the transcript in `~/.claude/projects`.
 *
 * It produces no turns of its own — but it is the only place where a session
 * has a human title ("Komplex workflow bemutató"), because older transcripts
 * carry no `ai-title` record. Sessions whose transcript is gone are still
 * recorded, so the timeline can say a conversation happened.
 */
export const claudeDesktopCollector: Collector = {
  tool: "claude_desktop",
  name: "claude-desktop",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    const root = ctx.roots.desktopSessions;
    if (!fs.existsSync(root)) return stat;

    const findCli = ctx.hub.prepare("select id, title from sessions where tool = 'claude_code' and ext_id = ?");
    const setTitle = ctx.hub.prepare(
      "update sessions set title = ?, title_origin = 'desktop_index' where id = ? and title is null",
    );

    for (const file of listMetaFiles(root)) {
      let meta: {
        sessionId?: string;
        cliSessionId?: string;
        cwd?: string;
        title?: string;
        model?: string;
        completedTurns?: number;
        createdAt?: number;
        lastActivityAt?: number;
      };
      try {
        meta = JSON.parse(fs.readFileSync(file, "utf8")) as typeof meta;
      } catch {
        stat.errors++;
        continue;
      }

      const title = usableTitle(meta.title);
      const linked = meta.cliSessionId
        ? (findCli.get(meta.cliSessionId) as { id: number; title: string | null } | undefined)
        : undefined;

      if (linked) {
        // Enrichment only: never overwrite a title the transcript itself carries.
        if (title && !linked.title) setTitle.run(title, linked.id);
        stat.skipped++;
        continue;
      }

      // Already known desktop-only sessions are not news on every run.
      const existed = ctx.hub
        .prepare("select 1 from sessions where tool = 'claude_desktop' and ext_id = ?")
        .get(meta.sessionId ?? path.basename(file, ".json"));
      upsertSession(ctx.hub, {
        tool: "claude_desktop",
        extId: meta.sessionId ?? path.basename(file, ".json"),
        title,
        titleOrigin: title ? "desktop_index" : null,
        cwdRaw: meta.cwd ?? null,
        cwdNorm: meta.cwd ? normalizePath(meta.cwd) : null,
        startedMs: meta.createdAt ?? null,
        endedMs: meta.lastActivityAt ?? null,
      });
      if (existed) stat.skipped++;
      else stat.sessions++;
    }
    return stat;
  },
};

function listMetaFiles(root: string): string[] {
  const out: string[] = [];
  for (const acct of safeDirs(root)) {
    for (const org of safeDirs(path.join(root, acct))) {
      const dir = path.join(root, acct, org);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (n.startsWith("local_") && n.endsWith(".json")) out.push(path.join(dir, n));
      }
    }
  }
  return out;
}

function safeDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
