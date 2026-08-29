import fs from "node:fs";
import path from "node:path";
import type { JsonlLine } from "../index/jsonl.js";
import { usableTitle, type TurnInput } from "../index/indexer.js";

/**
 * Claude Code transcript format, shared by the CLI store and by Cowork
 * (local agent mode), which writes the identical shape inside its own
 * per-session config directory.
 */

export interface TranscriptMeta {
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  titleOrigin: string | null;
  startedMs: number | null;
  endedMs: number | null;
}

export function extractMeta(lines: ReadonlyArray<JsonlLine>): TranscriptMeta {
  const meta: TranscriptMeta = {
    sessionId: null,
    cwd: null,
    title: null,
    titleOrigin: null,
    startedMs: null,
    endedMs: null,
  };
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
 * Only `text` blocks are indexed. A `thinking` block carries kilobytes of
 * base64 signature and an `attachment` record is a pasted payload; neither is
 * conversation. Whitelisting rather than blacklisting keeps a newly introduced
 * record type from silently polluting the index.
 */
export function buildTurns(filePath: string, lines: ReadonlyArray<JsonlLine>, baseSeq: number): TurnInput[] {
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

export interface TranscriptFile {
  path: string;
  extId: string;
  parentExtId: string | null;
}

/**
 * `<dir>/<sessionId>.jsonl` plus `<dir>/<sessionId>/subagents/*.jsonl`.
 *
 * A subagent transcript repeats its PARENT's `sessionId` in every record, so
 * its identity has to come from the filename.
 */
export function listTranscripts(dir: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
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
