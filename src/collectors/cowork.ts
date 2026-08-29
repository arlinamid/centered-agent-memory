import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "../paths.js";
import { readJsonlFrom } from "../index/jsonl.js";
import { addTurns, clearSession, upsertSession, usableTitle } from "../index/indexer.js";
import { classifyFile, markRotated, recordFileSync } from "../index/watermarks.js";
import { replaceEvidence } from "../attribution/evidence.js";
import { buildTurns, extractMeta, listTranscripts } from "./claude-transcript.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Claude Desktop's local agent mode ("Cowork") runs each session in a sandbox
 * and mirrors a full CLAUDE_CONFIG_DIR to the host:
 *
 *   local-agent-mode-sessions/<account>/<org>/local_<sid>.json          meta
 *   local-agent-mode-sessions/<account>/<org>/local_<sid>/.claude/
 *       projects/<vm-slug>/<cliSessionId>.jsonl                          transcript
 *
 * The transcript format is identical to Claude Code's. The working directory is
 * NOT usable here — inside the sandbox it is a generated name like
 * `/sessions/happy-great-cray` — so the project comes from the host folders the
 * user pointed the session at.
 */
export const coworkCollector: Collector = {
  tool: "cowork",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    const root = ctx.roots.coworkSessions;
    if (!fs.existsSync(root)) return stat;

    for (const metaFile of listMetaFiles(root)) {
      try {
        syncSession(ctx, metaFile, stat);
      } catch (err) {
        stat.errors++;
        ctx.log(`cowork: ${metaFile}: ${(err as Error).message}`);
      }
    }
    return stat;
  },
};

/** `<root>/<account>/<org>/local_*.json`; one "account" is the literal `skills-plugin`. */
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

interface CoworkMeta {
  sessionId?: string;
  cliSessionId?: string;
  cwd?: string;
  userSelectedFolders?: unknown;
  initialMessage?: string;
  model?: string;
  createdAt?: number;
  lastActivityAt?: number;
}

function syncSession(ctx: CollectorCtx, metaFile: string, stat: SyncStat): void {
  let meta: CoworkMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as CoworkMeta;
  } catch {
    stat.errors++;
    return;
  }
  const sid = meta.sessionId ?? path.basename(metaFile, ".json");
  const sessionDir = path.join(path.dirname(metaFile), path.basename(metaFile, ".json"));
  const folders = Array.isArray(meta.userSelectedFolders)
    ? meta.userSelectedFolders.filter((f): f is string => typeof f === "string")
    : [];

  const projectsDir = path.join(sessionDir, ".claude", "projects");
  const transcripts = safeDirs(projectsDir).flatMap((slug) => listTranscripts(path.join(projectsDir, slug)));

  // A session with no transcript still belongs on the timeline.
  if (transcripts.length === 0) {
    const id = upsertSession(ctx.hub, {
      tool: "cowork",
      extId: sid,
      title: usableTitle(meta.initialMessage),
      titleOrigin: meta.initialMessage ? "initial_message" : null,
      startedMs: meta.createdAt ?? null,
      endedMs: meta.lastActivityAt ?? null,
    });
    writeFolderEvidence(ctx, id, folders, meta.cwd);
    stat.skipped++;
    return;
  }

  for (const t of transcripts) {
    const verdict = classifyFile(ctx.hub, "cowork", t.path, { repair: ctx.repair });
    if (verdict.action === "skip" || verdict.action === "missing") {
      stat.skipped++;
      continue;
    }

    const from = verdict.action === "append" ? verdict.from : 0;
    const read = readJsonlFrom(t.path, from);
    if (read.rotated) {
      markRotated(ctx.hub, verdict.row.id);
      stat.skipped++;
      continue;
    }
    const { lines, endOffset } = read;
    const tmeta = extractMeta(lines);

    // One Cowork session can hold a main transcript and its subagents; each
    // becomes its own session, linked by the parent id.
    const extId = t.parentExtId ? t.extId : sid;
    const sessionId = upsertSession(ctx.hub, {
      tool: "cowork",
      extId,
      sourceId: verdict.row.id,
      parentExtId: t.parentExtId ? sid : null,
      role: t.parentExtId ? "subagent" : "main",
      title: tmeta.title ?? usableTitle(meta.initialMessage),
      titleOrigin: tmeta.title ? tmeta.titleOrigin : meta.initialMessage ? "initial_message" : null,
      // The sandbox cwd is a generated name, never a project.
      cwdRaw: meta.cwd ?? tmeta.cwd,
      cwdNorm: null,
      startedMs: tmeta.startedMs ?? meta.createdAt ?? null,
      endedMs: tmeta.endedMs ?? meta.lastActivityAt ?? null,
    });

    if (verdict.action === "full" && verdict.reason !== "new") clearSession(ctx.hub, sessionId);

    const baseSeq =
      verdict.action === "append"
        ? ((ctx.hub.prepare("select coalesce(max(seq), -1) as s from turns where session_id = ?").get(sessionId) as {
            s: number;
          }).s + 1)
        : 0;

    const turns = buildTurns(t.path, lines, baseSeq);
    const tx = ctx.hub.transaction(() => {
      stat.turns += addTurns(ctx.hub, sessionId, turns);
      writeFolderEvidence(ctx, sessionId, folders, meta.cwd);
      recordFileSync(ctx.hub, verdict.row.id, t.path, endOffset, ctx.now());
    });
    tx();
    stat.sessions++;
  }
}

/**
 * The folders the user handed to the session are the project signal. A Cowork
 * session can legitimately span several projects, so every folder is recorded
 * and the cascade picks a winner.
 */
function writeFolderEvidence(ctx: CollectorCtx, sessionId: number, folders: string[], cwd: string | undefined): void {
  const normalized = folders.map((f) => normalizePath(f)).filter((f): f is string => f !== null);
  replaceEvidence(ctx.hub, sessionId, "user_selected_folders", normalized, 3);
  // Recorded for debugging only: a sandbox path resolves to nothing.
  if (cwd) replaceEvidence(ctx.hub, sessionId, "sandbox_cwd", [cwd], 0);
}
