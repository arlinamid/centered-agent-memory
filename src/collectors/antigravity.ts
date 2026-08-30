import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { normalizePath } from "../paths.js";
import { readJsonlFrom } from "../index/jsonl.js";
import { addTurns, upsertSession, usableTitle, type TurnInput } from "../index/indexer.js";
import { classifyFile, ensureSource, markRotated, recordFileSync, recordVersionSync } from "../index/watermarks.js";
import { replaceEvidence } from "../attribution/evidence.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Antigravity, read from the parts of its store that are readable.
 *
 * The conversations themselves — `conversations/*.pb`, `implicit/*.pb` — are
 * encrypted, not merely schemaless: measured over a 64 KiB window they carry
 * 7.998 bits of entropy per byte with no readable header, while the plain
 * protobuf sitting next to them (`user_settings.pb`) measures 3.6. So this
 * collector indexes what Antigravity records ABOUT its conversations, and says
 * plainly that the bodies are not in the index:
 *
 *   - `conversation_summaries.db` — one row per conversation: a preview that
 *     serves as the title, the workspace it ran in, timings. No turns.
 *   - `history.jsonl` — the prompts the user typed, with the workspace and,
 *     usually, the conversation they belong to. Real turns.
 *   - `brain/<uuid>/*.md` — the task and plan documents the agent wrote.
 *
 * Three directories share one data set: `antigravity/` (IDE), `antigravity-ide/`
 * and `antigravity-cli/`. A conversation id is the same conversation in all of
 * them, so everything here is keyed by that id and deduplicated.
 */
export const antigravityCollector: Collector = {
  tool: "antigravity",
  name: "antigravity",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    const surfaces = [ctx.roots.antigravityCli, ctx.roots.antigravityHome, ctx.roots.antigravityIde];
    if (!surfaces.some((d) => fs.existsSync(d))) return stat;

    syncSummaries(ctx, surfaces, stat);
    syncHistory(ctx, surfaces, stat);
    collectBrain(ctx, stat);
    return stat;
  },
};

/* -------------------------------------------------------------------------- */
/* conversation_summaries.db                                                   */
/* -------------------------------------------------------------------------- */

interface SummaryRow {
  conversation_id: string;
  title: string | null;
  preview: string | null;
  step_count: number | null;
  last_modified_time: string | null;
  workspace_uris: string | null;
  parent_conversation_id: string | null;
  app_data_dir: string | null;
}

function syncSummaries(ctx: CollectorCtx, surfaces: ReadonlyArray<string>, stat: SyncStat): void {
  const seen = new Set<string>();

  for (const dir of surfaces) {
    const dbPath = path.join(dir, "conversation_summaries.db");
    if (!fs.existsSync(dbPath)) continue;

    let store: Db;
    try {
      store = ctx.openSource(dbPath);
    } catch (err) {
      stat.errors++;
      ctx.log(`antigravity: ${dbPath}: ${(err as Error).message}`);
      continue;
    }

    try {
      let rows: SummaryRow[];
      try {
        rows = store
          .prepare(
            `select conversation_id, title, preview, step_count, last_modified_time,
                    workspace_uris, parent_conversation_id, app_data_dir
             from conversation_summaries`,
          )
          .all() as SummaryRow[];
      } catch (err) {
        // A column that vanished is a new Antigravity version, not an empty
        // store: say so rather than reporting a quiet zero.
        stat.errors++;
        ctx.log(`antigravity: ${dbPath}: unexpected schema — ${(err as Error).message}`);
        continue;
      }

      for (const row of rows) {
        if (!row.conversation_id || seen.has(row.conversation_id)) continue;
        seen.add(row.conversation_id);
        try {
          upsertSummary(ctx, dbPath, row, stat);
        } catch (err) {
          stat.errors++;
          ctx.log(`antigravity: ${row.conversation_id}: ${(err as Error).message}`);
        }
      }
    } finally {
      store.close();
    }
  }
}

function upsertSummary(ctx: CollectorCtx, dbPath: string, row: SummaryRow, stat: SyncStat): void {
  const source = ensureSource(ctx.hub, "antigravity", "sqlite_row", `${dbPath}#summary:${row.conversation_id}`);
  const modified = parseDotNetTime(row.last_modified_time);
  const version = (modified ?? 0) + (row.step_count ?? 0);
  if (!ctx.repair && source.ext_version === version) {
    stat.skipped++;
    return;
  }

  const workspaces = parseWorkspaceUris(row.workspace_uris);
  // `title` is empty in every row on the reference machine; `preview` is the
  // generated one-line summary the UI actually shows.
  const title = usableTitle(row.title) ?? usableTitle(row.preview);

  const sessionId = upsertSession(ctx.hub, {
    tool: "antigravity",
    extId: row.conversation_id,
    sourceId: source.id,
    parentExtId: row.parent_conversation_id || null,
    role: row.parent_conversation_id ? "subagent" : "main",
    title,
    titleOrigin: title ? "preview" : null,
    cwdRaw: workspaces[0] ?? null,
    cwdNorm: workspaces[0] ? normalizePath(workspaces[0]) : null,
    // The store has no start time: `last_user_input_time` is the .NET default
    // (year 1) in every row, and `step_count` is not a clock.
    startedMs: modified,
    endedMs: modified,
  });

  const tx = ctx.hub.transaction(() => {
    if (workspaces.length > 0) replaceEvidence(ctx.hub, sessionId, "workspace_uris", workspaces, 3);
    recordVersionSync(ctx.hub, source.id, version, ctx.now());
  });
  tx();
  stat.sessions++;
}

/**
 * `.NET` round-trip timestamps: `2026-07-02 14:39:06.8014141+00:00`.
 *
 * `Date.parse` accepts the seven-decimal form, and also accepts the sentinel
 * this store writes for "never" — `0001-01-01 00:00:00+00:00` — which it
 * silently reads as the year 2001. Stored as-is, every such conversation would
 * claim to have happened twenty-five years before it did, and the timeline
 * would be quietly wrong rather than visibly empty.
 */
export function parseDotNetTime(raw: string | null | undefined): number | null {
  if (!raw) return null;
  if (raw.startsWith("0001-")) return null;
  const ms = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  if (!Number.isFinite(ms)) return null;
  // Anything before the tools existed is a sentinel we have not met yet.
  return ms < Date.parse("2020-01-01T00:00:00Z") ? null : ms;
}

/** `["file:///d%3A/tool/demo"]` — a JSON array of percent-encoded file URIs. */
function parseWorkspaceUris(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u): u is string => typeof u === "string" && u.length > 0);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* history.jsonl                                                               */
/* -------------------------------------------------------------------------- */

interface HistoryLine {
  display?: unknown;
  timestamp?: unknown;
  workspace?: unknown;
  conversationId?: unknown;
  type?: unknown;
}

/**
 * The prompts the user typed. This is the only place Antigravity records what
 * was actually said in a form we can read.
 *
 * A line without a `conversationId` — the first prompt of a session, and every
 * slash command — belongs to no conversation we could attach it to, so it is
 * counted as skipped rather than filed under a guess.
 */
function syncHistory(ctx: CollectorCtx, surfaces: ReadonlyArray<string>, stat: SyncStat): void {
  for (const dir of surfaces) {
    const file = path.join(dir, "history.jsonl");
    if (!fs.existsSync(file)) continue;

    const verdict = classifyFile(ctx.hub, "antigravity", file, { repair: ctx.repair });
    if (verdict.action === "skip" || verdict.action === "missing") {
      stat.skipped++;
      continue;
    }

    const read = readJsonlFrom(file, verdict.action === "append" ? verdict.from : 0);
    if (read.rotated) {
      markRotated(ctx.hub, verdict.row.id);
      stat.skipped++;
      continue;
    }

    // Every prompt for one conversation has to be added in a single call, so
    // the sequence numbers continue rather than restart.
    const byConversation = new Map<string, TurnInput[]>();
    const workspaceOf = new Map<string, string>();

    for (const line of read.lines) {
      const rec = line.json as HistoryLine | null;
      if (!rec) continue;
      const id = typeof rec.conversationId === "string" ? rec.conversationId : null;
      const text = typeof rec.display === "string" ? rec.display : null;
      if (!id || !text || text.trim().length === 0) {
        stat.skipped++;
        continue;
      }
      const workspace = typeof rec.workspace === "string" ? rec.workspace : null;
      if (workspace) workspaceOf.set(id, workspace);

      const turns = byConversation.get(id) ?? [];
      turns.push({
        seq: 0, // renumbered below, once the existing count is known
        role: "user",
        tsMs: typeof rec.timestamp === "number" ? rec.timestamp : null,
        text,
        locator: { kind: "jsonl_line", path: file, off: line.off, len: line.len, field: "display" },
      });
      byConversation.set(id, turns);
    }

    const tx = ctx.hub.transaction(() => {
      for (const [id, turns] of byConversation) {
        const workspace = workspaceOf.get(id) ?? null;
        // `upsertSession` COALESCEs the NEW value first, so anything passed
        // here wins over what the summaries pass learned. That pass has the
        // better title — the generated preview the UI shows, rather than the
        // first thing the user typed — so this one only fills a gap.
        const known = ctx.hub
          .prepare("select title, cwd_raw from sessions where tool = 'antigravity' and ext_id = ?")
          .get(id) as { title: string | null; cwd_raw: string | null } | undefined;
        const title = known?.title ? null : usableTitle(turns[0]!.text.split("\n")[0]);

        const sessionId = upsertSession(ctx.hub, {
          tool: "antigravity",
          extId: id,
          title,
          titleOrigin: title ? "first-user-message" : null,
          cwdRaw: known?.cwd_raw ? null : workspace,
          cwdNorm: known?.cwd_raw ? null : workspace ? normalizePath(workspace) : null,
        });
        const base = (
          ctx.hub.prepare("select coalesce(max(seq), -1) as s from turns where session_id = ?").get(sessionId) as {
            s: number;
          }
        ).s + 1;
        stat.turns += addTurns(
          ctx.hub,
          sessionId,
          turns.map((t, i) => ({ ...t, seq: base + i })),
        );
        if (workspace) replaceEvidence(ctx.hub, sessionId, "workspace_dirs", [workspace], 3);
      }
      recordFileSync(ctx.hub, verdict.row.id, file, read.endOffset, ctx.now());
    });
    tx();
  }
}

/* -------------------------------------------------------------------------- */
/* brain/<uuid>/*.md                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The agent's own task and plan documents, kept per conversation.
 *
 * These are ordinary markdown in a git repository, so they are referenced
 * rather than copied — with one exception the artifacts table already makes:
 * the text is kept inline so `cam` can show a plan without the file. Only
 * `.md` is taken; the same directories hold thousands of screenshots and the
 * `.resolved.N` history of each document, and neither is worth the index.
 */
function collectBrain(ctx: CollectorCtx, stat: SyncStat): void {
  for (const surface of [ctx.roots.antigravityHome, ctx.roots.antigravityIde]) {
    const brain = path.join(surface, "brain");
    if (!fs.existsSync(brain)) continue;

    let conversations: fs.Dirent[];
    try {
      conversations = fs.readdirSync(brain, { withFileTypes: true });
    } catch (err) {
      stat.errors++;
      ctx.log(`antigravity: ${brain}: unreadable — ${(err as Error).message}`);
      continue;
    }

    for (const entry of conversations) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(brain, entry.name);
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
      } catch {
        continue;
      }
      for (const name of files) {
        try {
          upsertBrainDoc(ctx, path.join(dir, name), entry.name);
        } catch (err) {
          stat.errors++;
          ctx.log(`antigravity: ${path.join(dir, name)}: ${(err as Error).message}`);
        }
      }
    }
  }
}

function upsertBrainDoc(ctx: CollectorCtx, file: string, conversationId: string): void {
  const st = fs.statSync(file);
  const mtime = Math.round(st.mtimeMs);
  const already = ctx.hub
    .prepare("select size_bytes, mtime_ms from artifacts where kind = ? and path = ?")
    .get("antigravity-brain", file) as { size_bytes: number | null; mtime_ms: number | null } | undefined;
  if (already?.size_bytes === st.size && already?.mtime_ms === mtime) return;

  const text = st.size <= ctx.maxInlineBytes ? fs.readFileSync(file, "utf8") : null;
  const session = ctx.hub.prepare("select id from sessions where tool = 'antigravity' and ext_id = ?").get(
    conversationId,
  ) as { id: number } | undefined;

  ctx.hub
    .prepare(
      `insert into artifacts(session_id, project_id, kind, tool, path, size_bytes, mtime_ms, sha256, inline_text)
       values (?, null, ?, 'antigravity', ?, ?, ?, ?, ?)
       on conflict(kind, path) do update set
         session_id = coalesce(excluded.session_id, artifacts.session_id),
         size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms,
         sha256 = excluded.sha256, inline_text = excluded.inline_text`,
    )
    .run(
      session?.id ?? null,
      "antigravity-brain",
      file,
      st.size,
      mtime,
      text === null ? null : createHash("sha256").update(text).digest("hex"),
      text,
    );
}
