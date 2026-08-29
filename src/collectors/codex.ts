import fs from "node:fs";
import { normalizePath } from "../paths.js";
import { readJsonlFrom, type JsonlLine } from "../index/jsonl.js";
import { addTurns, clearSession, upsertSession, usableTitle, type TurnInput } from "../index/indexer.js";
import { classifyFile, markRotated, recordFileSync } from "../index/watermarks.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Codex keeps a proper session index in `~/.codex/state_5.sqlite` (`threads`),
 * with the transcripts in the rollout files it points at. The index gives us
 * titles, parent/child links and cheap change detection; the rollouts give the
 * text.
 */
export const codexCollector: Collector = {
  tool: "codex",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    if (!fs.existsSync(ctx.roots.codexStateDb)) {
      // The store name carries a version number. When Codex moves to
      // state_6.sqlite this collector would otherwise report zero sessions and
      // look perfectly healthy.
      if (fs.existsSync(ctx.roots.codexHome)) {
        ctx.log(`codex: nincs meg a ${ctx.roots.codexStateDb} — új Codex-verzió más nevű tárolóval?`);
      }
      return stat;
    }

    let state;
    try {
      state = ctx.openSource(ctx.roots.codexStateDb);
    } catch (err) {
      stat.errors++;
      ctx.log(`codex: state_5.sqlite: ${(err as Error).message}`);
      return stat;
    }

    try {
      const threads = readThreads(state);
      const parents = readSpawnEdges(state);
      for (const t of threads) {
        try {
          syncThread(ctx, t, parents.get(t.id) ?? t.parentId, stat);
        } catch (err) {
          stat.errors++;
          ctx.log(`codex: ${t.id}: ${(err as Error).message}`);
        }
      }
    } finally {
      state.close();
    }
    return stat;
  },
};

interface ThreadRow {
  id: string;
  rolloutPath: string | null;
  cwd: string | null;
  title: string | null;
  source: string;
  parentId: string | null;
  agentRole: string | null;
  agentNickname: string | null;
  createdMs: number | null;
  updatedMs: number | null;
}

/** Codex stores epoch SECONDS here; everything else in the hub is milliseconds. */
function secondsToMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // Tolerate a future schema switching to ms.
  return v > 1e11 ? Math.round(v) : Math.round(v * 1000);
}

function readThreads(state: { prepare: (sql: string) => { all: () => unknown[] } }): ThreadRow[] {
  const rows = state
    .prepare("select id, rollout_path, created_at, updated_at, source, cwd, title from threads")
    .all() as Array<{
    id: string;
    rollout_path: string | null;
    created_at: number | null;
    updated_at: number | null;
    source: string | null;
    cwd: string | null;
    title: string | null;
  }>;

  return rows.map((r) => {
    const parsed = parseSource(r.source);
    return {
      id: r.id,
      rolloutPath: r.rollout_path,
      cwd: r.cwd,
      // 739 of 917 rows on the reference machine hold an entire prompt here.
      title: usableTitle(r.title),
      source: parsed.kind,
      parentId: parsed.parentId,
      agentRole: parsed.role,
      agentNickname: parsed.nickname,
      createdMs: secondsToMs(r.created_at),
      updatedMs: secondsToMs(r.updated_at),
    };
  });
}

interface ParsedSource {
  kind: string;
  parentId: string | null;
  role: string | null;
  nickname: string | null;
}

/** `source` is either a literal ("exec", "vscode") or a subagent descriptor. */
export function parseSource(raw: string | null): ParsedSource {
  if (!raw) return { kind: "unknown", parentId: null, role: null, nickname: null };
  if (!raw.startsWith("{")) return { kind: raw, parentId: null, role: null, nickname: null };
  try {
    const j = JSON.parse(raw) as {
      subagent?: { other?: unknown; thread_spawn?: Record<string, unknown> };
    };
    const sa = j.subagent ?? {};
    const spawn = (sa.thread_spawn ?? {}) as {
      parent_thread_id?: unknown;
      agent_role?: unknown;
      agent_nickname?: unknown;
    };
    return {
      kind: "subagent",
      parentId: typeof spawn.parent_thread_id === "string" ? spawn.parent_thread_id : null,
      role:
        typeof spawn.agent_role === "string"
          ? spawn.agent_role
          : typeof sa.other === "string"
            ? sa.other
            : null,
      nickname: typeof spawn.agent_nickname === "string" ? spawn.agent_nickname : null,
    };
  } catch {
    return { kind: "subagent", parentId: null, role: null, nickname: null };
  }
}

function readSpawnEdges(state: { prepare: (sql: string) => { all: () => unknown[] } }): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = state.prepare("select parent_thread_id, child_thread_id from thread_spawn_edges").all() as Array<{
      parent_thread_id: string;
      child_thread_id: string;
    }>;
    for (const r of rows) out.set(r.child_thread_id, r.parent_thread_id);
  } catch {
    /* older Codex builds have no such table */
  }
  return out;
}

function syncThread(ctx: CollectorCtx, t: ThreadRow, parentId: string | null, stat: SyncStat): void {
  if (!t.rolloutPath) {
    stat.skipped++;
    return;
  }

  const verdict = classifyFile(ctx.hub, "codex", t.rolloutPath, { repair: ctx.repair });
  if (verdict.action === "missing") {
    // Codex may prune a rollout while keeping the index row; record the thread
    // so the timeline still shows it, then move on.
    upsertSession(ctx.hub, sessionInputFor(t, parentId, verdict.row.id, null));
    stat.skipped++;
    return;
  }
  if (verdict.action === "skip") {
    stat.skipped++;
    return;
  }

  const from = verdict.action === "append" ? verdict.from : 0;
  const read = readJsonlFrom(t.rolloutPath, from);
  if (read.rotated) {
    markRotated(ctx.hub, verdict.row.id);
    stat.skipped++;
    return;
  }
  const { lines, endOffset } = read;
  const meta = extractMeta(lines);

  const sessionId = upsertSession(ctx.hub, sessionInputFor(t, parentId, verdict.row.id, meta));
  if (verdict.action === "full" && verdict.reason !== "new") clearSession(ctx.hub, sessionId);

  const baseSeq =
    verdict.action === "append"
      ? ((ctx.hub.prepare("select coalesce(max(seq), -1) as s from turns where session_id = ?").get(sessionId) as {
          s: number;
        }).s + 1)
      : 0;

  const turns = buildTurns(t.rolloutPath, lines, baseSeq);

  // A prompt is not a title, but its first line is a usable stand-in when the
  // index has nothing better.
  if (!t.title) {
    const firstUser = turns.find((x) => x.role === "user");
    const synthetic = firstUser ? titleFromText(firstUser.text) : null;
    if (synthetic) {
      ctx.hub
        .prepare("update sessions set title = coalesce(title, ?), title_origin = coalesce(title_origin, ?) where id = ?")
        .run(synthetic, "first_user_msg", sessionId);
    }
  }

  const tx = ctx.hub.transaction(() => {
    stat.turns += addTurns(ctx.hub, sessionId, turns);
    recordFileSync(ctx.hub, verdict.row.id, t.rolloutPath!, endOffset, ctx.now());
  });
  tx();
  stat.sessions++;
}

function sessionInputFor(t: ThreadRow, parentId: string | null, sourceId: number, meta: RolloutMeta | null) {
  const cwdRaw = meta?.cwd ?? t.cwd;
  return {
    tool: "codex" as const,
    extId: t.id,
    sourceId,
    parentExtId: parentId ?? meta?.parentThreadId ?? null,
    role: (parentId ?? meta?.parentThreadId) ? ("subagent" as const) : ("main" as const),
    agentRole: t.agentRole,
    agentNickname: t.agentNickname,
    title: t.title,
    titleOrigin: t.title ? "thread_title" : null,
    cwdRaw,
    cwdNorm: cwdRaw ? normalizePath(cwdRaw) : null,
    startedMs: t.createdMs ?? meta?.startedMs ?? null,
    endedMs: t.updatedMs ?? meta?.endedMs ?? null,
  };
}

export function titleFromText(text: string): string | null {
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  const cleaned = firstLine.replace(/^#+\s*/, "").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "…" : cleaned;
}

interface RolloutMeta {
  id: string | null;
  cwd: string | null;
  parentThreadId: string | null;
  startedMs: number | null;
  endedMs: number | null;
}

function extractMeta(lines: ReadonlyArray<JsonlLine>): RolloutMeta {
  const meta: RolloutMeta = { id: null, cwd: null, parentThreadId: null, startedMs: null, endedMs: null };
  for (const l of lines) {
    const rec = l.json as { type?: string; timestamp?: unknown; payload?: Record<string, unknown> } | null;
    if (!rec) continue;

    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN;
    if (Number.isFinite(ts)) {
      if (meta.startedMs === null || ts < meta.startedMs) meta.startedMs = ts;
      if (meta.endedMs === null || ts > meta.endedMs) meta.endedMs = ts;
    }

    const p = rec.payload;
    if (!p) continue;
    if (rec.type === "session_meta") {
      // `payload.id` is this thread; `payload.session_id` is the PARENT for a
      // subagent, so joining on it would collapse every subagent into its parent.
      if (typeof p.id === "string") meta.id = p.id;
      if (typeof p.cwd === "string" && !meta.cwd) meta.cwd = p.cwd;
      if (typeof p.parent_thread_id === "string") meta.parentThreadId = p.parent_thread_id;
    } else if (rec.type === "turn_context") {
      if (typeof p.cwd === "string" && !meta.cwd) meta.cwd = p.cwd;
    }
  }
  return meta;
}

/**
 * Only `event_msg` carries conversation. `response_item` duplicates the same
 * content and adds `developer`-role permission boilerplate, so it is skipped.
 */
function buildTurns(filePath: string, lines: ReadonlyArray<JsonlLine>, baseSeq: number): TurnInput[] {
  const out: TurnInput[] = [];
  let seq = baseSeq;

  for (const l of lines) {
    const rec = l.json as { type?: string; timestamp?: unknown; payload?: Record<string, unknown> } | null;
    if (!rec || rec.type !== "event_msg" || !rec.payload) continue;

    const kind = rec.payload.type;
    if (kind !== "user_message" && kind !== "agent_message") continue;
    const text = rec.payload.message;
    if (typeof text !== "string" || text.trim().length === 0) continue;

    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN;
    out.push({
      seq: seq++,
      role: kind === "user_message" ? "user" : "assistant",
      tsMs: Number.isFinite(ts) ? ts : null,
      text,
      locator: { kind: "jsonl_line", path: filePath, off: l.off, len: l.len, field: "payload.message" },
    });
  }
  return out;
}
