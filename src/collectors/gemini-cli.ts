import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "../paths.js";
import { addTurns, clearSession, upsertSession, usableTitle, type TurnInput } from "../index/indexer.js";
import { classifyFile, markRotated, recordFileSync } from "../index/watermarks.js";
import { replaceEvidence } from "../attribution/evidence.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Gemini CLI chats: `~/.gemini/tmp/<project>/chats/session-*.json`, one whole
 * JSON document per session.
 *
 * The project directory is named either by a hash or by a bare folder name,
 * and neither can be turned back into a path: `projectHash` is not the SHA-256
 * of the working directory (verified against every path in `projects.json` and
 * every case and separator variant of it), and a name like `scripts` matches
 * any number of directories. So the working directory comes from the
 * `.project_root` file the CLI writes beside the chats, and a project without
 * one stays unattributed rather than guessed at.
 */
export const geminiCliCollector: Collector = {
  tool: "gemini_cli",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    if (!fs.existsSync(ctx.roots.geminiTmp)) return stat;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(ctx.roots.geminiTmp, { withFileTypes: true });
    } catch (err) {
      stat.errors++;
      ctx.log(`gemini-cli: ${ctx.roots.geminiTmp}: unreadable — ${(err as Error).message}`);
      return stat;
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const projectDir = path.join(ctx.roots.geminiTmp, e.name);
      const chats = path.join(projectDir, "chats");
      let files: string[];
      try {
        files = fs.readdirSync(chats).filter((n) => n.endsWith(".json"));
      } catch {
        continue; // no chats here: a scratch directory, not a project
      }

      const cwd = readProjectRoot(projectDir);
      for (const name of files) {
        const file = path.join(chats, name);
        try {
          syncOne(ctx, file, cwd, stat);
        } catch (err) {
          stat.errors++;
          ctx.log(`gemini-cli: ${file}: ${(err as Error).message}`);
        }
      }
    }
    return stat;
  },
};

/** The working directory the CLI recorded for this project, if it recorded one. */
function readProjectRoot(projectDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(projectDir, ".project_root"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

interface ChatDoc {
  sessionId?: unknown;
  startTime?: unknown;
  lastUpdated?: unknown;
  kind?: unknown;
  messages?: unknown;
}

function syncOne(ctx: CollectorCtx, file: string, cwd: string | null, stat: SyncStat): void {
  const verdict = classifyFile(ctx.hub, "gemini_cli", file, { repair: ctx.repair });
  if (verdict.action === "skip" || verdict.action === "missing") {
    stat.skipped++;
    return;
  }

  const raw = fs.readFileSync(file, "utf8");
  const size = Buffer.byteLength(raw);
  // A session is one JSON document that is rewritten in place as it grows, so
  // there is no such thing as reading it from a byte offset: half a document
  // does not parse. `classifyFile` still earns its keep — it is what makes an
  // unchanged chat cost zero reads — but every change is a whole re-read.
  if (verdict.action === "append" && size < verdict.row.bytes_indexed) {
    markRotated(ctx.hub, verdict.row.id);
    stat.skipped++;
    return;
  }

  let doc: ChatDoc;
  try {
    doc = JSON.parse(raw) as ChatDoc;
  } catch (err) {
    stat.errors++;
    ctx.log(`gemini-cli: ${file}: malformed JSON — ${(err as Error).message}`);
    return;
  }

  const messages = Array.isArray(doc.messages) ? doc.messages : [];
  const extId = typeof doc.sessionId === "string" && doc.sessionId ? doc.sessionId : path.basename(file, ".json");
  const turns = buildTurns(file, messages);

  const sessionId = upsertSession(ctx.hub, {
    tool: "gemini_cli",
    extId,
    sourceId: verdict.row.id,
    // Gemini records that a session IS a subagent, never whose it is. Inventing
    // a parent from timing would be a guess, so the link is left open.
    role: doc.kind === "subagent" ? "subagent" : "main",
    title: firstUserTitle(turns),
    titleOrigin: turns.length > 0 ? "first-user-message" : null,
    cwdRaw: cwd,
    cwdNorm: cwd ? normalizePath(cwd) : null,
    startedMs: parseTs(doc.startTime),
    endedMs: parseTs(doc.lastUpdated),
  });

  const tx = ctx.hub.transaction(() => {
    clearSession(ctx.hub, sessionId);
    stat.turns += addTurns(ctx.hub, sessionId, turns);
    if (cwd) replaceEvidence(ctx.hub, sessionId, "cwd", [cwd], 3);
    recordFileSync(ctx.hub, verdict.row.id, file, size, ctx.now());
  });
  tx();
  stat.sessions++;
}

function parseTs(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function firstUserTitle(turns: ReadonlyArray<TurnInput>): string | null {
  const first = turns.find((t) => t.role === "user");
  if (!first) return null;
  return usableTitle(first.text.split("\n")[0]);
}

/**
 * Turn messages into turns.
 *
 * Only `user` and `gemini` are conversation. `info` and `error` are the CLI
 * talking to itself — extension-update notices, quota refusals — and a `gemini`
 * record's `thoughts` and `toolCalls` are working notes, not what was said.
 * Whitelisting the two roles keeps a new record type from quietly entering the
 * index.
 */
function buildTurns(file: string, messages: ReadonlyArray<unknown>): TurnInput[] {
  const out: TurnInput[] = [];
  let seq = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const type = rec.type;
    if (type !== "user" && type !== "gemini") continue;

    const content = rec.content;
    let text: string | null = null;
    let field: string | null = null;

    if (typeof content === "string") {
      text = content;
      field = `messages[${i}].content`;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object") {
          const t = (block as { text?: unknown }).text;
          if (typeof t === "string" && t.length > 0) parts.push(t);
        }
      }
      if (parts.length > 0) {
        text = parts.join("\n");
        field = `messages[${i}].content[*].text`;
      }
    }

    if (!text || !field || text.trim().length === 0) continue;

    out.push({
      seq: seq++,
      role: type === "user" ? "user" : "assistant",
      tsMs: parseTs(rec.timestamp),
      text,
      locator: { kind: "file_range", path: file, field },
    });
  }
  return out;
}
