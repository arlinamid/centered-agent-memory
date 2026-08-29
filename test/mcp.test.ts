import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import { SERVER_VERSION, createServer, type ServerOptions } from "../src/mcp/server.js";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { collectCwdEvidence, learnRoots, reattribute } from "../src/attribution/resolve.js";
import { consolidate } from "../src/memory/consolidate.js";
import { parseCitation, recall } from "../src/query/recall.js";
import { CASE_INSENSITIVE_FS } from "../src/paths.js";
import { makeHarness, realisticRecords, writeTranscript, type Harness } from "./helpers/fixtures.js";

let h: Harness;
let server: McpServer;
let client: Client;

const SID = "11111111-2222-3333-4444-555555555555";

async function connect(opts: ServerOptions = {}): Promise<void> {
  server = createServer(h.hub, opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

/** Reconnect with different server options, for the freshness cases. */
async function reconnect(opts: ServerOptions): Promise<void> {
  await client.close();
  await server.close();
  await connect(opts);
}

const NOW = 1_800_000_000_000;

/** A finished sync run, which is where the index's age comes from. */
function recordSync(endedMs: number, errors = 0): void {
  h.hub
    .prepare("insert into sync_runs(started_ms, ended_ms, errors, turns_added) values (?,?,?,?)")
    .run(endedMs - 1000, endedMs, errors, 7);
}

const textOf = (res: { content?: unknown }): string => {
  const blocks = (res.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks.map((b) => b.text ?? "").join("\n");
};

beforeEach(async () => {
  h = makeHarness();
  // A small but real corpus: index a transcript, then attribute it.
  writeTranscript(h.roots, "C--work-demo", SID, realisticRecords("C:\\work\\demo", SID));
  await claudeCodeCollector.sync(h.ctx);
  collectCwdEvidence(h.hub);
  learnRoots(h.hub);
  // The fixture project has no marker on disk, so pin it as a learned root to
  // exercise the attributed path deterministically.
  h.hub.prepare("insert or replace into projects(key, display_name, root_path) values ('demo','demo','c:/work/demo')").run();
  reattribute(h.hub);
  await connect();
});

afterEach(async () => {
  await client.close();
  await server.close();
  h.cleanup();
});

describe("mcp server", () => {
  it("reports the package version, not a stale copy of it", () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string; bin: Record<string, string> };
    expect(SERVER_VERSION).toBe(pkg.version);
    // The second entry point is what docs/mcp.md tells every client to run.
    expect(pkg.bin["cam-mcp"]).toBe("./dist/mcp/server.js");
  });

  it("advertises tool support and usage instructions", () => {
    expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true } });
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Claude Code");
    expect(instructions).toContain("Csak olvas");
  });

  it("exposes exactly the seven read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cam_dossier",
      "cam_get",
      "cam_memory",
      "cam_projects",
      "cam_recall",
      "cam_status",
      "cam_timeline",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description ?? "").not.toHaveLength(0);
    }
  });

  it("declares a valid input schema for every tool", async () => {
    const { tools } = await client.listTools();
    const dossierTool = tools.find((t) => t.name === "cam_dossier")!;
    expect(dossierTool.inputSchema.type).toBe("object");
    expect(dossierTool.inputSchema.required).toContain("project");
  });

  it("lists projects", async () => {
    const res = await client.callTool({ name: "cam_projects", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("demo");
  });

  it("returns a dossier for a known project", async () => {
    const res = await client.callTool({ name: "cam_dossier", arguments: { project: "demo" } });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("# demo");
    expect(text).toContain("claude_code");
    expect(text).toContain("Projekt-hozzárendelés");
  });

  it("reports an unknown project as an error, with the known ones listed", async () => {
    const res = await client.callTool({ name: "cam_dossier", arguments: { project: "nincs-ilyen" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("demo");
  });

  it("returns a timeline", async () => {
    const res = await client.callTool({ name: "cam_timeline", arguments: { project: "demo" } });
    expect(textOf(res)).toContain("claude_code");
    expect(textOf(res)).toContain("session — demo");
  });

  it("searches accent-insensitively and cites the hit", async () => {
    const res = await client.callTool({ name: "cam_recall", arguments: { query: "arvizturo" } });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("claude_code:");
    expect(text).toContain("#seq");
    expect(text).toMatch(/«|árvíztűrő/);
  });

  it("finds an agglutinated Hungarian form by prefix", async () => {
    const res = await client.callTool({ name: "cam_recall", arguments: { query: "projekt" } });
    expect(textOf(res)).not.toContain("Nincs találat");
  });

  it("says so plainly when nothing matches", async () => {
    const res = await client.callTool({ name: "cam_recall", arguments: { query: "zzzznincsilyen" } });
    expect(textOf(res)).toContain("Nincs találat");
  });

  it("expands a citation into the full text", async () => {
    const recallRes = await client.callTool({ name: "cam_recall", arguments: { query: "arvizturo" } });
    const citation = /([a-z_]+:[^\s]+#seq\d+-\d+)/.exec(textOf(recallRes))?.[1];
    expect(citation).toBeTruthy();

    const res = await client.callTool({ name: "cam_get", arguments: { citation: citation! } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("árvíztűrő tükörfúrógép");
  });

  it("rejects a malformed citation", async () => {
    const res = await client.callTool({ name: "cam_get", arguments: { citation: "nonsense" } });
    expect(res.isError).toBe(true);
  });

  it("turns a schema violation into a tool error, not a crash", async () => {
    const res = await client.callTool({ name: "cam_dossier", arguments: { project: 42 } });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("validation");
  });
});

describe("cam_timeline", () => {
  it("narrows by tool and by date", async () => {
    const all = await client.callTool({ name: "cam_timeline", arguments: { project: "demo" } });
    expect(textOf(all)).toContain("claude_code");

    const other = await client.callTool({ name: "cam_timeline", arguments: { project: "demo", tools: ["codex"] } });
    expect(textOf(other)).toContain("Nincs indexelt session");

    const future = await client.callTool({
      name: "cam_timeline",
      arguments: { project: "demo", since: "2030-01-01" },
    });
    expect(textOf(future)).toContain("Nincs indexelt session");
  });

  it("ignores a date it cannot read rather than returning nothing", async () => {
    const res = await client.callTool({ name: "cam_timeline", arguments: { project: "demo", since: "tegnapelőtt" } });
    expect(textOf(res)).toContain("claude_code");
  });
});

describe("cam_memory", () => {
  /** Three questions on three days: the smallest trace that can be promoted. */
  function promote(): void {
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.now() - 3 * day;
    for (const [i, q] of ["arvizturo", "tukorfurogep", "projekt"].entries()) {
      recall(h.hub, { query: q, nowMs: t0 + i * day, minConfidence: "weak" });
    }
    h.hub.prepare("update recall_events set score = 0.95").run();
    consolidate(h.hub);
  }

  it("explains an empty memory instead of looking broken", async () => {
    const res = await client.callTool({ name: "cam_memory", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("Nincs promotált emlék");
  });

  it("lists what the searches promoted", async () => {
    promote();
    const res = await client.callTool({ name: "cam_memory", arguments: {} });
    expect(textOf(res)).toContain("emlék");
    expect(textOf(res)).toContain("claude_code:");
  });

  it("shows one memory with the questions that earned it", async () => {
    promote();
    const id = (h.hub.prepare("select id from memory_facts order by score desc limit 1").get() as { id: number }).id;
    const res = await client.callTool({ name: "cam_memory", arguments: { id } });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("Bizonyíték");
    expect(text).toContain("Pontszám összetevői");
    expect(text).toContain("arvizturo");
  });

  it("returns the recurring topics on request", async () => {
    promote();
    const res = await client.callTool({ name: "cam_memory", arguments: { topics: true } });
    expect(textOf(res)).toMatch(/kérdés|Nincs visszatérő téma/);
  });

  it("reports an unknown memory as an error", async () => {
    const res = await client.callTool({ name: "cam_memory", arguments: { id: 9999 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Nincs ilyen emlék");
  });

  /**
   * The dream phase runs from the CLI only, but its output is read here. A
   * generated sentence that arrived unlabelled would be indistinguishable from
   * the transcript, which is the one thing this tool must never do.
   */
  it("names the model when it shows a sentence a model wrote", async () => {
    promote();
    const chunkId = (h.hub.prepare("select chunk_id from memory_facts limit 1").get() as { chunk_id: number }).chunk_id;
    h.hub
      .prepare(
        `insert into memory_dreams(kind, chunk_id, input_sha256, model, prompt_version, text, chars, created_ms)
         values ('digest', ?, 'x', 'teszt-modell', 1, 'Egy generált mondat.', 20, ?)`,
      )
      .run(chunkId, Date.now());

    const res = await client.callTool({ name: "cam_memory", arguments: {} });
    expect(textOf(res)).toContain("Egy generált mondat.");
    expect(textOf(res)).toContain("[teszt-modell]");
  });
});

/**
 * The M4 condition, and the reason it is a condition: an agent that cannot see
 * how old an answer is will quote a six-week-old one as current. Enumerating
 * the tools rather than listing them by hand is deliberate — a tool added later
 * is covered by this test the day it is registered.
 */
describe("index age", () => {
  const ARGS: Record<string, Record<string, unknown>> = {
    cam_dossier: { project: "demo" },
    cam_timeline: { project: "demo" },
    cam_recall: { query: "arvizturo" },
    cam_get: { citation: `claude_code:${SID}` },
    cam_projects: {},
    cam_memory: {},
    cam_status: {},
  };

  it("is on every tool's answer, whichever tool it is", async () => {
    recordSync(NOW - 60_000);
    await reconnect({ nowMs: () => NOW });

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      const args = ARGS[t.name];
      expect(args, `no fixture arguments for ${t.name}`).toBeDefined();
      const res = await client.callTool({ name: t.name, arguments: args! });
      expect(res.isError, `${t.name} failed`).toBeFalsy();
      expect(textOf(res), t.name).toContain("— index:");
      expect(textOf(res), t.name).toContain("1 perce");
    }
  });

  it("is on an error answer too, where a missing date would be least noticed", async () => {
    recordSync(NOW - 60_000);
    await reconnect({ nowMs: () => NOW });
    const res = await client.callTool({ name: "cam_dossier", arguments: { project: "nincs-ilyen" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("— index:");
  });

  it("says so loudly once the index is older than the threshold", async () => {
    recordSync(NOW - 3 * 24 * 60 * 60 * 1000);
    await reconnect({ nowMs: () => NOW });
    const res = await client.callTool({ name: "cam_recall", arguments: { query: "arvizturo" } });
    expect(textOf(res)).toContain("ELAVULT");
    expect(textOf(res)).toContain("3 napja");
  });

  it("does not call a never-synced index fresh", async () => {
    await reconnect({ nowMs: () => NOW });
    const res = await client.callTool({ name: "cam_projects", arguments: {} });
    expect(textOf(res)).toContain("még nem futott végig szinkron");
  });

  it("reports the errors of the last run rather than hiding them", async () => {
    recordSync(NOW - 60_000, 3);
    await reconnect({ nowMs: () => NOW });
    const res = await client.callTool({ name: "cam_projects", arguments: {} });
    expect(textOf(res)).toContain("3 hiba az utolsó szinkronban");
  });
});

describe("cam_status", () => {
  it("reports what the index holds and when it last moved", async () => {
    recordSync(NOW - 60_000);
    await reconnect({ nowMs: () => NOW });
    const res = await client.callTool({ name: "cam_status", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("utolsó szinkron");
    expect(text).toContain("claude_code=1");
    expect(text).toMatch(/\d+ session · \d+ turn/);
    expect(text).toContain("memória");
  });

  it("warns about an index written with the other path-folding convention", async () => {
    // The opposite of whatever this run folds by, not of a platform: macOS
    // folds like Windows, and the suite runs a second time with the setting
    // inverted, so naming a platform here would test nothing half the time.
    h.hub
      .prepare("insert or replace into meta(key, value) values ('path_case_fold', ?)")
      .run(CASE_INSENSITIVE_FS ? "0" : "1");
    h.hub.prepare("insert or replace into meta(key, value) values ('written_on','freebsd')").run();
    await reconnect({ nowMs: () => NOW });
    expect(textOf(await client.callTool({ name: "cam_status", arguments: {} }))).toContain("CAM_CASE_FOLD");
  });
});

describe("parseCitation", () => {
  it("reads tool, session and range", () => {
    expect(parseCitation("codex:019d4cd9-abc#seq12-18")).toEqual({
      tool: "codex",
      sessionExtId: "019d4cd9-abc",
      seqStart: 12,
      seqEnd: 18,
    });
  });
  it("accepts a bare session reference", () => {
    expect(parseCitation("claude_code:abc")).toMatchObject({ tool: "claude_code", sessionExtId: "abc" });
  });
  it("rejects nonsense", () => {
    expect(parseCitation("nope")).toBeNull();
    expect(parseCitation("")).toBeNull();
  });
});
