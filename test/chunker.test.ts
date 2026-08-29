import { describe, expect, it } from "vitest";
import { chunkTurns, type ChunkInput } from "../src/index/chunker.js";

const turn = (seq: number, text: string, tsMs: number | null = 1000 + seq): ChunkInput => ({
  seq,
  role: seq % 2 === 0 ? "user" : "assistant",
  text,
  tsMs,
});

describe("chunkTurns", () => {
  it("returns nothing for no turns", () => {
    expect(chunkTurns([])).toEqual([]);
  });

  it("keeps a short conversation in one chunk", () => {
    const chunks = chunkTurns([turn(0, "rövid"), turn(1, "válasz")]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ seqStart: 0, seqEnd: 1 });
    expect(chunks[0]!.text).toBe("user: rövid\nassistant: válasz");
    expect(chunks[0]!.charLen).toBe(chunks[0]!.text.length);
  });

  it("never splits a turn in half", () => {
    const turns = Array.from({ length: 40 }, (_, i) => turn(i, "x".repeat(200)));
    const chunks = chunkTurns(turns, { maxTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(Number.isInteger(c.seqStart)).toBe(true);
      expect(c.seqEnd).toBeGreaterThanOrEqual(c.seqStart);
      // Every line is a whole rendered turn.
      expect(c.text.split("\n").every((line) => /^(user|assistant): /.test(line))).toBe(true);
    }
  });

  it("overlaps whole turns so a question and its answer stay together", () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i, "y".repeat(150)));
    const chunks = chunkTurns(turns, { maxTokens: 100, overlapTokens: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.seqStart).toBeLessThanOrEqual(chunks[i - 1]!.seqEnd);
    }
  });

  it("covers every turn from the first to the last", () => {
    const turns = Array.from({ length: 25 }, (_, i) => turn(i, "z".repeat(180)));
    const chunks = chunkTurns(turns, { maxTokens: 80, overlapTokens: 16 });
    expect(chunks[0]!.seqStart).toBe(0);
    expect(chunks[chunks.length - 1]!.seqEnd).toBe(24);
  });

  it("terminates on a single oversized turn instead of repeating it forever", () => {
    // The guard that matters: without it the overlap equals the whole window
    // and the loop never advances.
    const turns = [turn(0, "a".repeat(100_000)), turn(1, "b".repeat(100_000)), turn(2, "rövid")];
    const chunks = chunkTurns(turns, { maxTokens: 100, overlapTokens: 80 });
    expect(chunks.length).toBeLessThanOrEqual(turns.length + 1);
    expect(chunks[chunks.length - 1]!.seqEnd).toBe(2);
    // Progress is monotonic: no chunk starts before the previous one did.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.seqStart).toBeGreaterThanOrEqual(chunks[i - 1]!.seqStart);
    }
  });

  it("takes the timestamp of its first turn, and tolerates a missing one", () => {
    const chunks = chunkTurns([turn(0, "egy", null), turn(1, "kettő", 5000)]);
    expect(chunks[0]!.tsMs).toBeNull();
    expect(chunkTurns([turn(0, "egy", 7000)])[0]!.tsMs).toBe(7000);
  });

  it("hashes the rendered text, so identical content chunks identically", () => {
    const a = chunkTurns([turn(0, "azonos")]);
    const b = chunkTurns([turn(0, "azonos")]);
    expect(a[0]!.sha256).toBe(b[0]!.sha256);
    expect(chunkTurns([turn(0, "más")])[0]!.sha256).not.toBe(a[0]!.sha256);
  });

  it("respects a tiny window without collapsing to nothing", () => {
    const turns = Array.from({ length: 5 }, (_, i) => turn(i, "kis szöveg"));
    const chunks = chunkTurns(turns, { maxTokens: 1, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1]!.seqEnd).toBe(4);
  });
});
