import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { emptyStat, readDirOrNull, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * The by-products of agent work: scratchpads, plan documents, generated
 * deliverables. They are not conversation, but they are what a session
 * produced, and some of them exist nowhere else.
 *
 * Volatile ones are copied, deliberately. The Claude Code scratchpad lives
 * under the OS temp directory and can be reaped at any time; a plan file in the
 * user's own home is stable and only referenced.
 */
export const artifactsCollector: Collector = {
  tool: "claude_code",
  name: "artifacts",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    collectScratchpads(ctx, stat);
    collectPlans(ctx, stat);
    collectCoworkOutputs(ctx, stat);
    linkProjects(ctx.hub);
    return stat;
  },
};

const TEXTY = new Set([".md", ".txt", ".json", ".csv", ".log", ".output", ".ts", ".js", ".py", ".sql", ".yaml", ".yml"]);

/** True when this exact file was already captured at this size and mtime. */
function unchanged(db: Db, kind: string, filePath: string, size: number, mtimeMs: number): boolean {
  const row = db
    .prepare("select size_bytes, mtime_ms from artifacts where kind = ? and path = ?")
    .get(kind, filePath) as { size_bytes: number | null; mtime_ms: number | null } | undefined;
  return row?.size_bytes === size && row?.mtime_ms === mtimeMs;
}

function upsertArtifact(
  db: Db,
  a: {
    kind: string;
    filePath: string;
    sessionExtId: string | null;
    tool: string | null;
    inline: string | null;
    size: number;
    mtimeMs: number;
    sha?: string | null;
  },
): void {
  const session = a.sessionExtId
    ? (db.prepare("select id from sessions where ext_id = ? limit 1").get(a.sessionExtId) as
        | { id: number }
        | undefined)
    : undefined;
  db.prepare(
    `insert into artifacts(session_id, project_id, kind, tool, path, size_bytes, mtime_ms, sha256, inline_text)
     values (?, null, ?, ?, ?, ?, ?, ?, ?)
     on conflict(kind, path) do update set
       session_id = coalesce(excluded.session_id, artifacts.session_id),
       tool = coalesce(excluded.tool, artifacts.tool),
       size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms,
       sha256 = excluded.sha256, inline_text = excluded.inline_text`,
  ).run(session?.id ?? null, a.kind, a.tool, a.filePath, a.size, a.mtimeMs, a.sha ?? null, a.inline);
}

/**
 * `%TEMP%/claude/<project-slug>/<sessionId>/{scratchpad,tasks}`.
 *
 * The slug is lossy, so the session id (a real directory name) is what links an
 * artifact to its conversation.
 */
function collectScratchpads(ctx: CollectorCtx, stat: SyncStat): void {
  const root = ctx.roots.claudeTemp;
  if (!fs.existsSync(root)) return;

  for (const slug of dirs(root)) {
    for (const sessionId of dirs(path.join(root, slug))) {
      for (const sub of ["scratchpad", "tasks"] as const) {
        const dir = path.join(root, slug, sessionId, sub);
        for (const file of walk(dir, 2)) {
          try {
            const st = fs.statSync(file);
            if (!st.isFile()) continue;
            const kind = sub === "tasks" ? "subagent_output" : "scratchpad";
            // Re-reading every scratchpad file on every sync is exactly the
            // "rescan instead of query" pattern this tool exists to avoid.
            if (!ctx.repair && unchanged(ctx.hub, kind, file, st.size, Math.round(st.mtimeMs))) {
              stat.skipped++;
              continue;
            }
            const ext = path.extname(file).toLowerCase();
            const inline =
              TEXTY.has(ext) && st.size <= ctx.maxInlineBytes ? fs.readFileSync(file, "utf8") : null;
            upsertArtifact(ctx.hub, {
              kind,
              filePath: file,
              sessionExtId: sessionId,
              tool: "claude_code",
              inline,
              size: st.size,
              mtimeMs: Math.round(st.mtimeMs),
            });
            stat.turns++;
          } catch {
            stat.errors++;
          }
        }
      }
    }
  }
}

/**
 * `~/.claude/plans/*.md` — real design documents. They contain no absolute
 * paths, so the only way to attach one to a project is that its filename slug
 * appears in the transcript of the session that wrote it.
 */
function collectPlans(ctx: CollectorCtx, stat: SyncStat): void {
  const dir = ctx.roots.claudePlans;
  if (!fs.existsSync(dir)) return;

  // Finding the owning session means grepping every known transcript, so it is
  // done once per plan and never repeated for a plan that already has one.
  let transcripts: Array<{ loc_path: string }> | null = null;

  const entries = readDirOrNull(dir, ctx, stat);
  if (entries === null) return;

  for (const name of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name)) {
    const file = path.join(dir, name);
    const slug = name.slice(0, -3);

    const known = ctx.hub.prepare("select session_id, size_bytes, mtime_ms from artifacts where kind = 'plan' and path = ?").get(file) as
      | { session_id: number | null; size_bytes: number | null; mtime_ms: number | null }
      | undefined;

    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      stat.errors++;
      continue;
    }
    if (!ctx.repair && known?.session_id && known.size_bytes === st.size && known.mtime_ms === Math.round(st.mtimeMs)) {
      stat.skipped++;
      continue;
    }

    let owner: string | null = null;
    if (!known?.session_id) {
      transcripts ??= ctx.hub
        .prepare("select distinct loc_path from turns where locator_kind = 'jsonl_line' and loc_path is not null")
        .all() as Array<{ loc_path: string }>;
      for (const t of transcripts) {
        try {
          if (fs.readFileSync(t.loc_path, "utf8").includes(slug)) {
            owner = path.basename(t.loc_path, ".jsonl");
            break;
          }
        } catch {
          /* transcript gone; keep looking */
        }
      }
    }

    try {
      const body = fs.readFileSync(file, "utf8");
      upsertArtifact(ctx.hub, {
        kind: "plan",
        filePath: file,
        sessionExtId: owner,
        tool: "claude_code",
        // Stable, user-owned file: reference it, do not copy it.
        inline: null,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        sha: createHash("sha256").update(body).digest("hex"),
      });
      stat.turns++;
    } catch {
      stat.errors++;
    }
  }
}

/** Cowork deliverables (`outputs/`): docx, pptx, research notes that exist nowhere else. */
function collectCoworkOutputs(ctx: CollectorCtx, stat: SyncStat): void {
  const root = ctx.roots.coworkSessions;
  if (!fs.existsSync(root)) return;

  for (const acct of dirs(root)) {
    for (const org of dirs(path.join(root, acct))) {
      const orgDir = path.join(root, acct, org);
      for (const entry of dirs(orgDir)) {
        if (!entry.startsWith("local_")) continue;
        const outDir = path.join(orgDir, entry, "outputs");
        for (const file of walk(outDir, 2)) {
          try {
            const st = fs.statSync(file);
            if (!st.isFile()) continue;
            if (!ctx.repair && unchanged(ctx.hub, "cowork_output", file, st.size, Math.round(st.mtimeMs))) {
              stat.skipped++;
              continue;
            }
            const ext = path.extname(file).toLowerCase();
            const inline =
              TEXTY.has(ext) && st.size <= ctx.maxInlineBytes ? fs.readFileSync(file, "utf8") : null;
            upsertArtifact(ctx.hub, {
              kind: "cowork_output",
              filePath: file,
              sessionExtId: entry,
              tool: "cowork",
              inline,
              size: st.size,
              mtimeMs: Math.round(st.mtimeMs),
            });
            stat.turns++;
          } catch {
            stat.errors++;
          }
        }
      }
    }
  }
}

/** An artifact belongs to the project of the session that produced it. */
function linkProjects(db: Db): void {
  db.prepare(
    `update artifacts set project_id = (select project_id from sessions where sessions.id = artifacts.session_id)
     where session_id is not null`,
  ).run();
}

function dirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function* walk(dir: string, depth: number): Generator<string> {
  if (depth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth - 1);
    else yield full;
  }
}
