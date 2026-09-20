import type { Db } from "../db/open.js";

/**
 * How a turn is rendered into chunk text.
 *
 * This is versioned because the rendering IS the indexed text: `chunks.text_sha256`
 * is computed from it at index time and recomputed from it at query time, so the
 * two sides must never disagree about which rules applied. The version lives in
 * the database rather than in configuration for exactly that reason — flipping a
 * config flag cannot retroactively change what was indexed, and a hub carries its
 * own answer with it.
 *
 * 1 — `role: text`, the raw turn.
 * 2 — the same, with transcript exhaust elided (see `denoiseTurnText`).
 */
export type RenderVersion = 1 | 2;

export const RENDER_RAW: RenderVersion = 1;
export const RENDER_DENOISED: RenderVersion = 2;

/** What a hub gets when it is built or rebuilt today. */
export const CURRENT_RENDER_VERSION: RenderVersion = RENDER_DENOISED;

/** A hub with no `render_version` predates the setting and holds raw renders. */
export function readRenderVersion(db: Db): RenderVersion {
  try {
    const row = db.prepare("select value from meta where key = 'render_version'").get() as
      | { value: string }
      | undefined;
    return row?.value === String(RENDER_DENOISED) ? RENDER_DENOISED : RENDER_RAW;
  } catch {
    return RENDER_RAW;
  }
}

export function writeRenderVersion(db: Db, version: RenderVersion): void {
  db.prepare("insert or replace into meta(key, value) values ('render_version', ?)").run(String(version));
}

/**
 * The one place a turn becomes chunk text. Called by the chunker when indexing
 * and by the hydrator when reading back; a difference between the two shows up
 * as every chunk reading `stale`, so there is deliberately no second copy of
 * this expression anywhere in the tree.
 */
export function renderTurn(role: string, text: string, version: RenderVersion = CURRENT_RENDER_VERSION): string {
  return `${role}: ${version === RENDER_DENOISED ? denoiseTurnText(text) : text}`;
}

/** Tag-delimited blocks that are machinery rather than conversation. */
const NOISE_TAGS = [
  "system-reminder",
  "function_calls",
  "function_results",
  "tool_use",
  "tool_result",
  "thinking",
  "antml:function_calls",
  "antml:invoke",
];

/** A fenced block or diff longer than this keeps a head and loses the rest. */
const KEEP_HEAD_LINES = 3;
const FENCE_ELIDE_OVER = 12;
const DIFF_ELIDE_OVER = 6;
/** A single unbroken line longer than this is a blob, not a sentence. */
const BLOB_CHARS = 400;

const DIFF_START = /^(diff --git |index [0-9a-f]{7,}[. ]|--- |\+\+\+ |@@ )/;
const DIFF_BODY = /^([+\- ]|@@ |index |diff --git |--- |\+\+\+ )/;
const FENCE = /^\s*```/;
const UNBROKEN = /\s/;

/**
 * Strip what a transcript accumulates around the conversation: tool traffic,
 * diffs, pasted files, injected boilerplate.
 *
 * Every removal leaves a counted marker. Silent elision would make a chunk look
 * like it says less than the turn did, and the whole index rests on a citation
 * meaning what it says — so the reader can always see that something was cut,
 * and how much.
 *
 * Must stay deterministic and depend on nothing but its input: it runs once at
 * index time and again at query time, and the two results are compared by hash.
 */
export function denoiseTurnText(text: string): string {
  if (!text) return text;
  let out = stripTagBlocks(text);
  out = elideBlocks(out);
  out = out
    .split("\n")
    .map((line) =>
      line.length > BLOB_CHARS && !UNBROKEN.test(line.trim()) ? `[${line.length} characters elided]` : line,
    )
    .join("\n");
  // Three or more blank lines carry no more meaning than one.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTagBlocks(text: string): string {
  let out = text;
  for (const tag of NOISE_TAGS) {
    const name = escapeRe(tag);
    // Paired block first, then a stray opener that never closed.
    out = out.replace(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "gi"), `[${tag} elided]`);
    out = out.replace(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*$`, "i"), `[${tag} elided]`);
  }
  return out;
}

/**
 * Fenced code blocks and diff hunks, reduced to a head plus a count.
 *
 * A fence is kept whole while it is short: a six-line function in an answer is
 * the answer. It is the thousand-line paste that drowns the sentence next to it.
 */
function elideBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (FENCE.test(line)) {
      const start = i;
      let end = i + 1;
      while (end < lines.length && !FENCE.test(lines[end]!)) end++;
      const body = end - start - 1;
      if (body > FENCE_ELIDE_OVER) {
        out.push(
          line,
          ...lines.slice(start + 1, start + 1 + KEEP_HEAD_LINES),
          `[${body - KEEP_HEAD_LINES} lines elided]`,
        );
        if (end < lines.length) out.push(lines[end]!);
      } else {
        out.push(...lines.slice(start, Math.min(end + 1, lines.length)));
      }
      i = end;
      continue;
    }

    if (DIFF_START.test(line)) {
      const start = i;
      let end = i;
      while (end + 1 < lines.length && DIFF_BODY.test(lines[end + 1]!)) end++;
      const body = end - start + 1;
      if (body > DIFF_ELIDE_OVER) {
        out.push(...lines.slice(start, start + KEEP_HEAD_LINES), `[${body - KEEP_HEAD_LINES} diff lines elided]`);
      } else {
        out.push(...lines.slice(start, end + 1));
      }
      i = end;
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}
