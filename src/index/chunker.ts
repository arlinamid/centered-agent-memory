import { createHash } from "node:crypto";

/**
 * Vendored from telecodex `src/agent/memory/chunker.ts` and generalized:
 * the original windowed over lines of a markdown file, this one windows over
 * conversation turns and never splits a turn in half.
 */

export interface ChunkInput {
  seq: number;
  role: string;
  text: string;
  tsMs: number | null;
}

export interface ChunkRecord {
  seqStart: number;
  seqEnd: number;
  text: string;
  charLen: number;
  sha256: string;
  tsMs: number | null;
}

export interface ChunkOptions {
  /** ~4 chars per token, matching the vendored heuristic. */
  maxTokens?: number;
  overlapTokens?: number;
}

function render(turn: ChunkInput): string {
  return `${turn.role}: ${turn.text}`;
}

export function chunkTurns(turns: ReadonlyArray<ChunkInput>, options: ChunkOptions = {}): ChunkRecord[] {
  const maxChars = Math.max(64, (options.maxTokens ?? 400) * 4);
  const overlapChars = Math.max(0, (options.overlapTokens ?? 80) * 4);
  if (turns.length === 0) return [];

  const out: ChunkRecord[] = [];
  let current: ChunkInput[] = [];
  let currentChars = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.map(render).join("\n");
    const first = current[0]!;
    const last = current[current.length - 1]!;
    out.push({
      seqStart: first.seq,
      seqEnd: last.seq,
      text,
      charLen: text.length,
      sha256: createHash("sha256").update(text).digest("hex"),
      tsMs: first.tsMs,
    });
  };

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    current.push(turn);
    currentChars += render(turn).length + 1;

    const isLast = i === turns.length - 1;
    if (currentChars >= maxChars || isLast) {
      flush();
      if (isLast) break;

      // Carry a tail of whole turns forward so a question and its answer are
      // not separated by a chunk boundary.
      const overlap: ChunkInput[] = [];
      let overlapLen = 0;
      for (let j = current.length - 1; j >= 0 && overlapLen < overlapChars; j--) {
        const t = current[j]!;
        overlap.unshift(t);
        overlapLen += render(t).length + 1;
      }
      // A single oversized turn must not repeat forever.
      if (overlap.length === current.length) overlap.length = Math.max(0, overlap.length - 1);
      current = overlap;
      currentChars = overlap.reduce((n, t) => n + render(t).length + 1, 0);
    }
  }

  return out;
}
