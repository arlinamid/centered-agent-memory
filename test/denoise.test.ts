import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkTurns } from "../src/index/chunker.js";
import {
  CURRENT_RENDER_VERSION,
  RENDER_DENOISED,
  RENDER_RAW,
  denoiseTurnText,
  readRenderVersion,
  renderTurn,
  writeRenderVersion,
} from "../src/index/denoise.js";
import { Hydrator } from "../src/index/hydrate.js";
import { addTurns, upsertSession } from "../src/index/indexer.js";
import { rebuildFts } from "../src/index/rebuild.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";

let h: Harness;
const NOW = Date.parse("2026-09-01T12:00:00Z");
beforeEach(() => { h = makeHarness(); });
afterEach(() => h.cleanup());

describe("denoiseTurnText", () => {
  it("elides tool traffic and says so", () => {
    const out = denoiseTurnText("before\n<tool_result>{\"a\":1}\nlots\nof\nnoise</tool_result>\nafter");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("[tool_result elided]");
    expect(out).not.toContain("noise");
  });

  it("closes an unterminated block rather than keeping the rest of the turn", () => {
    const out = denoiseTurnText("question\n<system-reminder>never closed and very long");
    expect(out).toBe("question\n[system-reminder elided]");
  });

  it("keeps a short code block and cuts a long one to a counted head", () => {
    const short = "```ts\nconst a = 1;\nconst b = 2;\n```";
    expect(denoiseTurnText(short)).toBe(short);

    const long = ["```ts", ...Array.from({ length: 40 }, (_, i) => `line ${i};`), "```"].join("\n");
    const out = denoiseTurnText(long);
    expect(out).toContain("line 0;");
    expect(out).toContain("line 2;");
    expect(out).not.toContain("line 20;");
    expect(out).toContain("[37 lines elided]");
  });

  it("cuts a diff to its header", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,8 +1,8 @@",
      ...Array.from({ length: 20 }, (_, i) => `+added ${i}`),
    ].join("\n");
    const out = denoiseTurnText(diff);
    expect(out).toContain("diff --git a/x.ts b/x.ts");
    expect(out).toContain("diff lines elided]");
    expect(out).not.toContain("+added 19");
  });

  it("elides an unbroken blob but leaves ordinary prose alone", () => {
    expect(denoiseTurnText("x".repeat(500))).toBe("[500 characters elided]");
    const prose = "The Docker port moved from 3000 to 80 because the proxy already owned 3000.";
    expect(denoiseTurnText(prose)).toBe(prose);
  });

  it("is idempotent, so a second pass cannot drift from the first", () => {
    const messy = "a\n<tool_use>x</tool_use>\n\n\n\nb\n" + ["```", ...Array.from({ length: 30 }, (_, i) => `l${i}`), "```"].join("\n");
    const once = denoiseTurnText(messy);
    expect(denoiseTurnText(once)).toBe(once);
  });
});

/**
 * The invariant the whole design rests on: `chunks.text_sha256` is written by
 * the chunker and recomputed by the hydrator, so if those two ever render a
 * turn differently, every chunk in the index silently reads as `stale`.
 */
describe("chunker and hydrator render identically", () => {
  const TURNS = [
    { seq: 0, role: "user", text: "Why did the Docker port change?\n<system-reminder>ignore me</system-reminder>", tsMs: NOW },
    { seq: 1, role: "assistant", text: ["The proxy owned 3000.", "```sh", ...Array.from({ length: 30 }, (_, i) => `cmd ${i}`), "```"].join("\n"), tsMs: NOW },
  ];

  for (const version of [RENDER_RAW, RENDER_DENOISED] as const) {
    it(`agrees on the hash at rendering ${version}`, () => {
      writeRenderVersion(h.hub, version);
      const session = upsertSession(h.hub, { tool: "codex", extId: `render-${version}`, startedMs: NOW });
      addTurns(h.hub, session, TURNS.map((t) => ({ ...t, locator: { kind: "inline" as const } })));

      const chunk = h.hub.prepare("select id, text_sha256 from chunks where session_id = ?").get(session) as {
        id: number;
        text_sha256: string;
      };
      const resolved = new Hydrator(h.hub).resolveChunk(chunk.id);
      expect(resolved.status).toBe("ok");
      expect(createHash("sha256").update(resolved.text).digest("hex")).toBe(chunk.text_sha256);
    });
  }

  it("keeps the noise out of the denoised rendering and in the raw one", () => {
    writeRenderVersion(h.hub, RENDER_DENOISED);
    expect(renderTurn("user", TURNS[0]!.text, RENDER_DENOISED)).not.toContain("ignore me");
    expect(renderTurn("user", TURNS[0]!.text, RENDER_RAW)).toContain("ignore me");
  });
});

describe("render version", () => {
  it("starts a fresh hub on the current rendering", () => {
    expect(readRenderVersion(h.hub)).toBe(CURRENT_RENDER_VERSION);
  });

  it("rebuild re-renders, recomputes the hashes and records the new version", () => {
    writeRenderVersion(h.hub, RENDER_RAW);
    const session = upsertSession(h.hub, { tool: "codex", extId: "upgrade", startedMs: NOW });
    addTurns(h.hub, session, [
      { seq: 0, role: "user", tsMs: NOW, text: "Docker port\n<tool_result>junk junk junk</tool_result>", locator: { kind: "inline" } },
    ]);
    const before = h.hub.prepare("select id, text_sha256 from chunks").get() as { id: number; text_sha256: string };

    const stat = rebuildFts(h.hub, undefined, RENDER_DENOISED);

    expect(stat.rehashed).toBe(1);
    expect(stat.renderVersion).toBe(RENDER_DENOISED);
    expect(readRenderVersion(h.hub)).toBe(RENDER_DENOISED);
    const after = h.hub.prepare("select text_sha256 from chunks where id = ?").get(before.id) as { text_sha256: string };
    expect(after.text_sha256).not.toBe(before.text_sha256);
    // And the hub is consistent again: the hydrator reproduces the new hash.
    expect(new Hydrator(h.hub).resolveChunk(before.id).status).toBe("ok");
  });

  it("a rebuild that changes nothing rehashes nothing", () => {
    const session = upsertSession(h.hub, { tool: "codex", extId: "same", startedMs: NOW });
    addTurns(h.hub, session, [{ seq: 0, role: "user", tsMs: NOW, text: "plain", locator: { kind: "inline" } }]);
    expect(rebuildFts(h.hub).rehashed).toBe(0);
  });
});

describe("chunkTurns", () => {
  it("renders with the version it is given", () => {
    const turns = [{ seq: 0, role: "user", text: "a\n<thinking>secret</thinking>\nb", tsMs: NOW }];
    expect(chunkTurns(turns, { renderVersion: RENDER_RAW })[0]!.text).toContain("secret");
    expect(chunkTurns(turns, { renderVersion: RENDER_DENOISED })[0]!.text).not.toContain("secret");
  });
});
