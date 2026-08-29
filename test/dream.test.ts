import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { collectCwdEvidence, learnRoots, reattribute } from "../src/attribution/resolve.js";
import { recall } from "../src/query/recall.js";
import { consolidate } from "../src/memory/consolidate.js";
import { getFact, listFacts, memoryStatus } from "../src/memory/facts.js";
import {
  DreamNotConfiguredError,
  buildPrompt,
  commandProvider,
  forgetDreams,
  makeProvider,
  planDream,
  PROMPT_VERSION,
  runDream,
} from "../src/memory/dream.js";
import { formatMemory, formatMemoryFact } from "../src/query/format.js";
import { makeHarness, writeTranscript, type Harness } from "./helpers/fixtures.js";

/**
 * The dream phase is the only place a model comes near this tool, so what is
 * tested here is mostly what it must NOT do: nothing without configuration,
 * nothing on a dry run, nothing twice, and nothing fatal when the model fails.
 *
 * The "model" is a local script. No network, no API key, no cost.
 */

let h: Harness;
let scriptDir: string;

const SID = "11111111-2222-3333-4444-555555555555";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-08-01T10:00:00.000Z");

/** A fake model: a node script that reads stdin and answers deterministically. */
function fakeModel(behaviour: "echo" | "fail" | "empty" | "slow"): string[] {
  const file = path.join(scriptDir, `${behaviour}.mjs`);
  const bodies = {
    echo: 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write("ÁLOM: "+s.split("--- részlet ---")[1].trim().slice(0,40))});',
    fail: 'process.stderr.write("a modell nem elérhető\\n");process.exit(3);',
    empty: 'process.stdin.on("data",()=>{}).on("end",()=>process.stdout.write("   "));',
    slow: "setTimeout(()=>process.stdout.write('késő'), 5000);",
  };
  fs.writeFileSync(file, bodies[behaviour], "utf8");
  return [process.execPath, file];
}

async function seedPromoted(): Promise<void> {
  writeTranscript(h.roots, "C--work-demo", SID, [
    { type: "ai-title", sessionId: SID, title: "Árvíztűrő teszt" },
    {
      type: "user",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { content: "Hogyan javítsuk a tükörfúrógép hibát a docker-compose alatt?" },
    },
    {
      type: "assistant",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:30.000Z",
      message: { content: [{ type: "text", text: "Az árvíztűrő megoldás a docker-compose átírása." }] },
    },
  ]);
  await claudeCodeCollector.sync(h.ctx);
  collectCwdEvidence(h.hub);
  learnRoots(h.hub);
  h.hub
    .prepare("insert or replace into projects(key, display_name, root_path) values ('demo','demo','c:/work/demo')")
    .run();
  reattribute(h.hub);

  for (const [i, q] of ["arvizturo", "tukorfurogep hiba", "docker compose"].entries()) {
    recall(h.hub, { query: q, nowMs: T0 + (i + 1) * DAY, minConfidence: "weak" });
  }
  // Real bm25 has no spread in a two-chunk fixture; see test/memory.test.ts.
  h.hub.prepare("update recall_events set score = 0.95").run();
  consolidate(h.hub, { nowMs: T0 + 3 * DAY });
}

beforeEach(async () => {
  h = makeHarness();
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-dream-"));
  await seedPromoted();
});

afterEach(() => {
  h.cleanup();
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

describe("configuration", () => {
  it("refuses to send anything until a model is configured", () => {
    expect(() => makeProvider()).toThrow(DreamNotConfiguredError);
    expect(() => makeProvider({ provider: "none" })).toThrow(DreamNotConfiguredError);
    expect(() => makeProvider({ provider: "command" })).toThrow(DreamNotConfiguredError);
  });

  it("says how to configure it, naming the shape of the setting", () => {
    const message = new DreamNotConfiguredError().message;
    expect(message).toContain('"provider": "command"');
    expect(message).toContain("{model}");
  });

  it("takes any command: the model is configuration, not code", async () => {
    const provider = commandProvider({ provider: "command", model: "teszt-modell", command: fakeModel("echo") });
    expect(provider.model).toBe("teszt-modell");
    expect(await provider.generate("--- részlet ---\nvalami szöveg")).toContain("ÁLOM:");
  });
});

describe("the prompt", () => {
  it("carries the excerpt and the questions that promoted it, and forbids invention", () => {
    const fact = listFacts(h.hub)[0]!;
    const prompt = buildPrompt(fact, ["docker compose", "arvizturo"], 4000);
    expect(prompt).toContain(`[cam-dream v${PROMPT_VERSION}`);
    expect(prompt).toContain("Ne találj ki semmit");
    expect(prompt).toContain("docker compose");
    expect(prompt).toContain("árvíztűrő");
  });

  it("caps the excerpt, so one long memory cannot send the whole conversation", () => {
    const fact = listFacts(h.hub)[0]!;
    const prompt = buildPrompt({ ...fact, text: "x".repeat(50_000) }, [], 100);
    expect(prompt.length).toBeLessThan(1000);
    expect(prompt).toContain("…");
  });
});

describe("dry run", () => {
  it("plans what would be sent without sending it", async () => {
    const items = planDream(h.hub, { config: { provider: "command", model: "m", command: fakeModel("fail") } });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.prompt.length).toBeGreaterThan(0);

    const stat = await runDream(h.hub, {
      config: { provider: "command", model: "m", command: fakeModel("fail") },
      dryRun: true,
    });
    expect(stat.sentChars).toBe(0);
    expect(stat.generated).toBe(0);
    expect(memoryStatus(h.hub).dreams).toBe(0);
  });
});

describe("generating", () => {
  const config = (behaviour: "echo" | "fail" | "empty" | "slow", extra = {}) => ({
    provider: "command" as const,
    model: "teszt-modell",
    command: fakeModel(behaviour),
    ...extra,
  });

  it("writes one digest per memory and records the model", async () => {
    const stat = await runDream(h.hub, { config: config("echo"), nowMs: T0 + 3 * DAY });
    expect(stat.generated).toBeGreaterThan(0);
    expect(stat.failed).toBe(0);
    expect(stat.sentChars).toBeGreaterThan(0);

    const fact = listFacts(h.hub)[0]!;
    expect(fact.digest).toContain("ÁLOM:");
    expect(fact.digestModel).toBe("teszt-modell");
    const st = memoryStatus(h.hub);
    expect(st.dreams).toBe(stat.generated);
    expect(st.dreamModels).toEqual(["teszt-modell"]);
  });

  it("does not pay twice for the same input", async () => {
    await runDream(h.hub, { config: config("echo"), nowMs: T0 });
    const second = await runDream(h.hub, { config: config("echo"), nowMs: T0 });
    expect(second.generated).toBe(0);
    expect(second.cached).toBeGreaterThan(0);
    expect(second.sentChars).toBe(0);
  });

  it("regenerates on demand", async () => {
    await runDream(h.hub, { config: config("echo"), nowMs: T0 });
    const forced = await runDream(h.hub, { config: config("echo"), nowMs: T0, force: true });
    expect(forced.generated).toBeGreaterThan(0);
  });

  it("survives a model that fails, and stays retryable", async () => {
    const stat = await runDream(h.hub, { config: config("fail"), nowMs: T0 });
    expect(stat.generated).toBe(0);
    expect(stat.failed).toBeGreaterThan(0);
    expect(stat.errors[0]).toContain("3 kóddal");
    expect(memoryStatus(h.hub).dreams).toBe(0);

    // Nothing was cached, so tomorrow's run tries again.
    const retry = await runDream(h.hub, { config: config("echo"), nowMs: T0 });
    expect(retry.generated).toBeGreaterThan(0);
  });

  it("treats an empty answer as a failure, not as a memory", async () => {
    const stat = await runDream(h.hub, { config: config("empty"), nowMs: T0 });
    expect(stat.failed).toBeGreaterThan(0);
    expect(memoryStatus(h.hub).dreams).toBe(0);
  });

  it("gives up on a model that hangs", async () => {
    const stat = await runDream(h.hub, { config: config("slow", { timeoutMs: 300 }), nowMs: T0 });
    expect(stat.failed).toBeGreaterThan(0);
    expect(stat.errors[0]).toContain("időtúllépés");
  });

  it("never touches the evidence or the promotions", async () => {
    const before = {
      facts: h.hub.prepare("select count(*) c from memory_facts").get(),
      events: h.hub.prepare("select count(*) c from recall_events").get(),
      traces: h.hub.prepare("select count(*) c from memory_traces").get(),
    };
    await runDream(h.hub, { config: config("echo"), nowMs: T0 });
    expect(h.hub.prepare("select count(*) c from memory_facts").get()).toEqual(before.facts);
    expect(h.hub.prepare("select count(*) c from recall_events").get()).toEqual(before.events);
    expect(h.hub.prepare("select count(*) c from memory_traces").get()).toEqual(before.traces);
  });
});

describe("presentation", () => {
  it("marks generated text as generated, and keeps the source next to it", async () => {
    await runDream(h.hub, {
      config: { provider: "command", model: "teszt-modell", command: fakeModel("echo") },
      nowMs: T0,
    });
    const facts = listFacts(h.hub);
    expect(formatMemory(facts)).toContain("[teszt-modell]");

    const found = getFact(h.hub, facts[0]!.id)!;
    const out = formatMemoryFact(found.fact, found.evidence);
    expect(out).toContain("Álom — teszt-modell írta, nem a forrás");
    expect(out).toContain("## Szöveg"); // the source is still shown, unaltered
    expect(out).toContain("árvíztűrő");
  });
});

describe("forgetting", () => {
  it("drops every dream without touching anything else", async () => {
    await runDream(h.hub, {
      config: { provider: "command", model: "m", command: fakeModel("echo") },
      nowMs: T0,
    });
    const before = listFacts(h.hub).length;
    expect(forgetDreams(h.hub)).toBeGreaterThan(0);
    expect(memoryStatus(h.hub).dreams).toBe(0);
    expect(listFacts(h.hub).length).toBe(before);
    expect(listFacts(h.hub)[0]!.digest).toBeNull();
  });
});
