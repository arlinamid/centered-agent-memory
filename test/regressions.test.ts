import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { artifactsCollector } from "../src/collectors/artifacts.js";
import { pluck, readJsonlFrom } from "../src/index/jsonl.js";
import { classifyFile } from "../src/index/watermarks.js";
import { jline, makeHarness, realisticRecords, writeTranscript, type Harness } from "./helpers/fixtures.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const SLUG = "C--work-demo";
const SID = "11111111-2222-3333-4444-555555555555";
const CWD = "C:\\work\\demo";

/**
 * Every case here is a silent-failure mode: the run reports success while
 * content is lost, re-read forever, or wrongly attributed. They are the classes
 * this project has already been bitten by, so each one keeps a test.
 */
describe("silent-failure regressions", () => {
  it("notices a rewrite that keeps the same size and mtime", async () => {
    const file = writeTranscript(h.roots, SLUG, SID, [
      { type: "user", sessionId: SID, cwd: CWD, message: { content: "AAAAAAAA" } },
    ]);
    await claudeCodeCollector.sync(h.ctx);
    const { size, mtime } = fs.statSync(file);

    // Same byte length, same mtime, different content — plausible on a
    // coarse-granularity filesystem or an atomic replace.
    fs.writeFileSync(
      file,
      jline({ type: "user", sessionId: SID, cwd: CWD, message: { content: "BBBBBBBB" } }),
      "utf8",
    );
    fs.utimesSync(file, mtime, mtime);
    expect(fs.statSync(file).size).toBe(size);

    const verdict = classifyFile(h.hub, "claude_code", file);
    expect(verdict.action).toBe("full");
    if (verdict.action === "full") expect(verdict.reason).toBe("rotated");
  });

  it("treats a file that shrank below the watermark as rotated, not as 'nothing new'", () => {
    const dir = path.join(h.roots.claudeProjects, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "x.jsonl");
    fs.writeFileSync(file, jline({ a: 1 }) + jline({ a: 2 }) + jline({ a: 3 }), "utf8");
    const size = fs.statSync(file).size;

    fs.writeFileSync(file, jline({ a: 9 }), "utf8"); // rewritten much shorter
    const read = readJsonlFrom(file, size);
    expect(read.rotated).toBe(true);
    // Crucially it must NOT report the new (smaller) size as the watermark,
    // which would mark the rewritten file as fully indexed.
    expect(read.endOffset).toBe(0);
  });

  it("resets the watermark when a collector meets a shrunken file", async () => {
    const file = writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);

    const before = h.hub.prepare("select bytes_indexed from sources where locator = ?").get(file) as {
      bytes_indexed: number;
    };
    expect(before.bytes_indexed).toBeGreaterThan(0);

    // Shrink it without touching mtime, so classifyFile still says "append"
    // from the old offset and only the reader can catch it.
    const { mtime } = fs.statSync(file);
    fs.writeFileSync(file, jline({ type: "user", sessionId: SID, cwd: CWD, message: { content: "rövid" } }), "utf8");
    fs.utimesSync(file, mtime, mtime);

    await claudeCodeCollector.sync(h.ctx);
    const after = h.hub.prepare("select bytes_indexed, status from sources where locator = ?").get(file) as {
      bytes_indexed: number;
      status: string;
    };
    // Either it was re-read whole, or it is queued for a full re-read; what it
    // must never be is "indexed up to an offset past the end of the file".
    expect(after.bytes_indexed).toBeLessThanOrEqual(fs.statSync(file).size);
  });

  it("rehydrates with the same block filter the indexer used", () => {
    const record = {
      message: {
        content: [
          { type: "thinking", text: "NEM EZ", signature: "x".repeat(50) },
          { type: "text", text: "ez a valódi szöveg" },
        ],
      },
    };
    // The indexer only takes `type: "text"` blocks; the pointer has to say so,
    // or read-time would pick up the thinking block's text and every turn would
    // look permanently "stale".
    expect(pluck(record, "message.content[*type=text].text")).toBe("ez a valódi szöveg");
    expect(pluck(record, "message.content[*].text")).toContain("NEM EZ");
  });

  it("leaves no orphaned FTS rows when chunks go away", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);

    const before = h.hub.prepare("select count(*) c from chunks_fts").get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    // A raw session delete cascades to chunks inside SQLite, bypassing any
    // application-level cleanup — the trigger has to catch it.
    h.hub.prepare("delete from sessions").run();
    const after = h.hub.prepare("select count(*) c from chunks_fts").get() as { c: number };
    expect(after.c).toBe(0);
  });

  it("does not re-read artifact files that have not changed", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);

    const scratch = path.join(h.roots.claudeTemp, SLUG, SID, "scratchpad");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "a.md"), "tartalom", "utf8");

    const first = await artifactsCollector.sync(h.ctx);
    expect(first.turns).toBeGreaterThan(0);

    const second = await artifactsCollector.sync(h.ctx);
    expect(second.turns).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it("does not re-scan every transcript for a plan whose owner is already known", async () => {
    writeTranscript(h.roots, SLUG, SID, [
      {
        type: "user",
        sessionId: SID,
        cwd: CWD,
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { content: "a terv: terv-steady-bear.md" },
      },
    ]);
    await claudeCodeCollector.sync(h.ctx);

    fs.mkdirSync(h.roots.claudePlans, { recursive: true });
    fs.writeFileSync(path.join(h.roots.claudePlans, "terv-steady-bear.md"), "# Terv", "utf8");

    await artifactsCollector.sync(h.ctx);
    const owned = h.hub.prepare("select session_id from artifacts where kind = 'plan'").get() as {
      session_id: number | null;
    };
    expect(owned.session_id).not.toBeNull();

    const second = await artifactsCollector.sync(h.ctx);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it("records which tool produced an artifact", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);
    const scratch = path.join(h.roots.claudeTemp, SLUG, SID, "scratchpad");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "a.md"), "x", "utf8");

    await artifactsCollector.sync(h.ctx);
    const row = h.hub.prepare("select tool from artifacts where kind = 'scratchpad'").get() as { tool: string };
    expect(row.tool).toBe("claude_code");
  });
});
