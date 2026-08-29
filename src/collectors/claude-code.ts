import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "../paths.js";
import { readJsonlFrom, type JsonlLine } from "../index/jsonl.js";
import { addTurns, clearSession, upsertSession, usableTitle, type TurnInput } from "../index/indexer.js";
import { classifyFile, markRotated, recordFileSync } from "../index/watermarks.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Claude Code transcripts: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`
 * plus subagent threads at `<sessionId>/subagents/*.jsonl`.
 *
 * The directory slug is lossy (accents are stripped: `vázlatok` becomes
 * `v-zlatok`), so the project always comes from the `cwd` field inside the
 * records, never from the folder name.
 */
export const claudeCodeCollector: Collector = {
  tool: "claude_code",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    let slugs: string[];
    try {
      slugs = fs.readdirSync(ctx.roots.claudeProjects, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return stat;
    }

    for (const slug of slugs) {
      const dir = path.join(ctx.roots.claudeProjects, slug);
      for (const file of listTranscripts(dir)) {
        try {
          syncOne(ctx, file, stat);
        } catch (err) {
          stat.errors++;
          ctx.log(`claude-code: ${file.path}: ${(err as Error).message}`);
        }
      }
    }
    return stat;
  },
};

interface Transcript {
  path: string;
  extId: string;
  parentExtId: string | null;
}

function listTranscripts(dir: string): Transcript[] {
  const out: Transcript[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push({ path: path.join(dir, e.name), extId: e.name.slice(0, -6), parentExtId: null });
    } else if (e.isDirectory()) {
      const subDir = path.join(dir, e.name, "subagents");
      let subs: string[];
      try {
        subs = fs.readdirSync(subDir).filter((n) => n.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const s of subs) {
        out.push({ path: path.join(subDir, s), extId: s.slice(0, -6), parentExtId: e.name });
      }
    }
  }
  return out;
}

function syncOne(ctx: CollectorCtx, t: Transcript, stat: SyncStat): void {
  const verdict = classifyFile(ctx.hub, "claude_code", t.path, { repair: ctx.repair });
  if (verdict.action === "skip" || verdict.action === "missing") {
    stat.skipped++;
    return;
  }

  const from = verdict.action === "append" ? verdict.from : 0;
  const read = readJsonlFrom(t.path, from);
  if (read.rotated) {
    // The file shrank between the watermark check and the read. Reset so the
    // next run re-reads it whole rather than skipping the rewritten content.
    markRotated(ctx.hub, verdict.row.id);
    stat.skipped++;
    return;
  }
  const { lines, endOffset } = read;
  if (lines.length === 0) {
    recordFileSync(ctx.hub, verdict.row.id, t.path, endOffset, ctx.now());
    stat.skipped++;
    return;
  }

  const meta = extractMeta(lines);
  // A subagent transcript carries its PARENT's sessionId in every record, so
  // trusting that field would merge the subagent into the parent session. The
  // filename is the only identifier that is actually its own.
  const extId = t.parentExtId ? t.extId : (meta.sessionId ?? t.extId);
  const sessionId = upsertSession(ctx.hub, {
    tool: "claude_code",
    extId,
    sourceId: verdict.row.id,
    parentExtId: t.parentExtId,
    role: t.parentExtId ? "subagent" : "main",
    title: meta.title,
    titleOrigin: meta.titleOrigin,
    cwdRaw: meta.cwd,
    cwdNorm: meta.cwd ? normalizePath(meta.cwd) : null,
    startedMs: meta.startedMs,
    endedMs: meta.endedMs,
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
    recordFileSync(ctx.hub, verdict.row.id, t.path, endOffset, ctx.now());
  });
  tx();
  stat.sessions++;
}

interface Meta {
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  titleOrigin: string | null;
  startedMs: number | null;
  endedMs: number | null;
}

function extractMeta(lines: ReadonlyArray<JsonlLine>): Meta {
  const meta: Meta = { sessionId: null, cwd: null, title: null, titleOrigin: null, startedMs: null, endedMs: null };
  for (const l of lines) {
    const rec = l.json as Record<string, unknown> | null;
    if (!rec) continue;
    if (typeof rec.sessionId === "string" && !meta.sessionId) meta.sessionId = rec.sessionId;
    if (typeof rec.cwd === "string" && !meta.cwd) meta.cwd = rec.cwd;

    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN;
    if (Number.isFinite(ts)) {
      if (meta.startedMs === null || ts < meta.startedMs) meta.startedMs = ts;
      if (meta.endedMs === null || ts > meta.endedMs) meta.endedMs = ts;
    }

    // A user-set title outranks a generated one, and later wins over earlier.
    if (rec.type === "ai-title" || rec.type === "custom-title") {
      const title = usableTitle(rec.title ?? rec.value ?? rec.content);
      if (title && (rec.type === "custom-title" || meta.titleOrigin !== "custom-title")) {
        meta.title = title;
        meta.titleOrigin = rec.type;
      }
    }
  }
  return meta;
}

/**
 * Turn records into turns. Only `text` blocks are indexed — a `thinking` block
 * carries kilobytes of base64 signature, and `attachment` records are pasted
 * payloads, neither of which belongs in a full-text index. Whitelisting rather
 * than blacklisting keeps a new record type from silently polluting the index.
 */
function buildTurns(filePath: string, lines: ReadonlyArray<JsonlLine>, baseSeq: number): TurnInput[] {
  const out: TurnInput[] = [];
  let seq = baseSeq;

  for (const l of lines) {
    const rec = l.json as Record<string, unknown> | null;
    if (!rec) continue;
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const message = rec.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const content = message.content;
    let text: string | null = null;
    let field: string | null = null;

    if (typeof content === "string") {
      text = content;
      field = "message.content";
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const t = (block as { text?: unknown }).text;
          if (typeof t === "string" && t.length > 0) parts.push(t);
        }
      }
      if (parts.length > 0) {
        text = parts.join("\n");
        field = "message.content[*type=text].text";
      }
    }

    if (!text || !field || text.trim().length === 0) continue;

    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN;
    out.push({
      seq: seq++,
      role: rec.type === "user" ? "user" : "assistant",
      tsMs: Number.isFinite(ts) ? ts : null,
      text,
      locator: { kind: "jsonl_line", path: filePath, off: l.off, len: l.len, field },
    });
  }
  return out;
}
