#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { checkPortability } from "../db/portability.js";
import { initSchema, openHub, type Db } from "../db/open.js";
import { getFact, listFacts, listTopics, memoryStatus } from "../memory/facts.js";
import { describeFreshness, formatFreshness, freshness } from "../ops/freshness.js";
import { dossier, listProjects, timeline } from "../query/dossier.js";
import {
  formatDossier,
  formatMemory,
  formatMemoryFact,
  formatRecall,
  formatTimeline,
  formatTopics,
  formatTurns,
} from "../query/format.js";
import { getTurns, parseCitation, recall } from "../query/recall.js";
import { defaultRoots } from "../paths.js";
import { DaemonSession } from "../sources/language-server.js";
import { fetchConversation } from "../sources/antigravity-fetch.js";
import { fetchDevinCascade } from "../sources/devin-fetch.js";

export const SERVER_NAME = "centered-agent-memory";
/** Kept in step with package.json by a test, so the two cannot drift apart. */
export const SERVER_VERSION = "0.9.2";

const INSTRUCTIONS = `A searchable index of conversations the user had with their OTHER AI tools:
Claude Code, Claude Desktop / Cowork, Codex, Cursor, Gemini CLI, Antigravity and
Devin. Read-only — it does not modify any of those stores.

Use it before asking about or assuming earlier work on a project: cam_dossier
gives the full picture, cam_timeline the chronology, cam_recall full-text
search, and cam_get the full text of a hit. cam_memory returns what earlier
searches brought up more than once, across days and questions — with evidence.

Every hit carries a project-attribution confidence (strong / medium / weak /
none). Weak attribution comes from time overlap and can be wrong. If a source
has since changed or vanished, the result says so instead of dropping it.

The last line of every answer says when the index last synced. If it says
STALE, conversations since then are not in it — tell the user rather than
quoting old data as current.`;

export interface ServerOptions {
  /** Past this age the index reports itself as stale. */
  staleAfterMs?: number;
  nowMs?: () => number;
  /** Encrypted Cascade files; tests point this at a fixture. */
  cascadeDir?: string;
}

/** Factory so tests can drive the server in-process over an in-memory transport. */
export function createServer(db: Db, opts: ServerOptions = {}): McpServer {
  // One address cache for the life of the server: the MCP client asks several
  // questions in a row, and finding the daemon means listing every process on
  // the machine. It expires on its own, because Antigravity picks new ports
  // every time it restarts.
  const languageServers = new DaemonSession();
  const cascadeDir = opts.cascadeDir ?? path.join(defaultRoots().windsurfHome, "cascade");
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Centered Agent Memory" },
    { instructions: INSTRUCTIONS },
  );

  const now = opts.nowMs ?? Date.now;

  /**
   * Every tool goes through here, so no response can leave without the index's
   * age on it. Wrapping the registration rather than each handler is the point:
   * a tool added later cannot forget, because there is no way to register one
   * that skips this.
   */
  type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  /**
   * Every answer ends with how old the index is.
   *
   * Handlers may be async — `cam_get` has to reach Antigravity's daemon for a
   * conversation whose body is encrypted — so the result is awaited before the
   * footer is appended. Without the await the footer would be pushed onto a
   * promise, and the tool would fail with a result that is not iterable.
   */
  const dated =
    <A>(handler: (args: A) => ToolResult | Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      const res = await handler(args);
      const footer = formatFreshness(freshness(db, now(), opts.staleAfterMs));
      return { ...res, content: [...res.content, { type: "text", text: footer }] };
    };

  const text = (s: string, isError = false): ToolResult => ({ content: [{ type: "text", text: s }], isError });

  server.registerTool(
    "cam_dossier",
    {
      title: "Project dossier",
      description:
        "What happened on a project: per-tool session and turn counts, date range, " +
        "largest sessions, recent topics, artifacts, source state. " +
        "Start here when you want a project's history.",
      inputSchema: {
        project: z.string().min(1).describe("Project key, as listed by cam_projects"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(({ project }: { project: string }) => {
      const d = dossier(db, project);
      if (!d) {
        const known = listProjects(db)
          .slice(0, 15)
          .map((p) => p.key)
          .join(", ");
        return text(`No such project: ${project}\nKnown projects: ${known}`, true);
      }
      return text(formatDossier(d));
    }),
  );

  server.registerTool(
    "cam_timeline",
    {
      title: "Project timeline",
      description:
        "A project's sessions in chronological order, from every tool in the index, with " +
        "attribution method and confidence. Does not read text, so it is fast.",
      inputSchema: {
        project: z.string().min(1),
        since: z.string().optional().describe("ISO date, from"),
        until: z.string().optional().describe("ISO date, until"),
        tools: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by tool: claude_code, claude_desktop, cowork, codex, cursor, gemini_cli, antigravity, devin",
          ),
        includeSubagents: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(
      ({
        project,
        since,
        until,
        tools,
        includeSubagents,
        limit,
      }: {
        project: string;
        since?: string;
        until?: string;
        tools?: string[];
        includeSubagents?: boolean;
        limit?: number;
      }) => {
        const entries = timeline(db, {
          project,
          sinceMs: parseDate(since),
          untilMs: parseDate(until),
          tools: tools ?? null,
          includeSubagents: includeSubagents ?? false,
          limit,
        });
        return text(formatTimeline(entries, project));
      },
    ),
  );

  server.registerTool(
    "cam_recall",
    {
      title: "Search conversations",
      description:
        "Full-text search over indexed conversations. Accent-insensitive, with prefix " +
        "matching on longer words (so inflection is not a barrier). Every hit carries a " +
        "citation that cam_get expands.",
      inputSchema: {
        query: z.string().min(1),
        project: z.string().optional(),
        tool: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        includeWeak: z.boolean().optional().describe("Include weakly attributed hits"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(
      ({
        query,
        project,
        tool,
        since,
        limit,
        includeWeak,
      }: {
        query: string;
        project?: string;
        tool?: string;
        since?: string;
        limit?: number;
        includeWeak?: boolean;
      }) => {
        const hits = recall(db, {
          query,
          project: project ?? null,
          tool: tool ?? null,
          sinceMs: parseDate(since),
          limit: limit ?? 10,
          minConfidence: includeWeak ? "weak" : "medium",
        });
        return text(formatRecall(hits, query));
      },
    ),
  );

  server.registerTool(
    "cam_get",
    {
      title: "A session's text",
      description:
        "The full text of a hit. Citation form is tool:sessionId#seqN-M, as returned by " +
        "cam_recall. If the source has since changed or vanished, that is marked.",
      inputSchema: {
        citation: z
          .string()
          .min(3)
          .describe("cam_recall citation, e.g. codex:019d4cd9-…#seq12-18, or just tool:sessionId"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(async ({ citation }: { citation: string }) => {
      const parsed = parseCitation(citation);
      if (!parsed) return text(`Unreadable citation: ${citation}`, true);

      // Encrypted Cascade bodies (Antigravity and Devin desktop) are read
      // only when someone asks for that conversation by name.
      let note = "";
      if (parsed.tool === "antigravity") {
        const outcome = await fetchConversation(db, parsed.sessionExtId, { session: languageServers });
        if (outcome.status === "no-daemon") {
          note =
            "\n\n(Antigravity is not running, so this conversation's text could not be read: " +
            "its body is encrypted on disk. What is shown is what the index holds without it.)";
        } else if (outcome.status === "failed") {
          note = `\n\n(Antigravity's language server did not answer: ${outcome.detail})`;
        }
      } else if (parsed.tool === "devin") {
        const outcome = await fetchDevinCascade(db, parsed.sessionExtId, {
          session: languageServers,
          cascadeDir,
        });
        if (outcome.status === "no-daemon") {
          note =
            "\n\n(Devin is not running, so this conversation's text could not be read: " +
            "its body is encrypted on disk. What is shown is what the index holds without it.)";
        } else if (outcome.status === "failed") {
          note = `\n\n(Devin's language server did not answer: ${outcome.detail})`;
        }
      }

      const turns = getTurns(db, parsed.tool, parsed.sessionExtId, parsed.seqStart, parsed.seqEnd);
      if (turns.length === 0) return text(`No such session: ${citation}${note}`, true);

      return text(formatTurns(turns) + note);
    }),
  );

  server.registerTool(
    "cam_projects",
    {
      title: "Project list",
      description: "Indexed projects with session and turn counts, most recent activity first.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(({ limit }: { limit?: number }) => {
      const rows = listProjects(db).slice(0, limit ?? 50);
      const listed = rows
        .map(
          (p) =>
            `${p.key.padEnd(30)} ${String(p.sessions).padStart(4)} session ${String(p.turns).padStart(7)} turn` +
            `  last: ${p.lastMs ? new Date(p.lastMs).toISOString().slice(0, 10) : "?"}`,
        )
        .join("\n");
      return text(listed || "The index is empty. Run: cam sync");
    }),
  );

  server.registerTool(
    "cam_memory",
    {
      title: "Long-term memory",
      description:
        "What your searches recalled more than once, across days and questions — promoted " +
        "deterministically, not summarized by a model. With `id`, returns one memory's full " +
        "text and the promotion evidence (when, for which queries). If empty, not enough " +
        "recall trail has accumulated yet; that is not a failure.",
      inputSchema: {
        id: z.number().int().min(1).optional().describe("A specific memory id"),
        project: z.string().optional(),
        topics: z.boolean().optional().describe("Return recurring topics instead of memories"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(
      ({
        id,
        project,
        topics,
        limit,
      }: {
        id?: number;
        project?: string;
        topics?: boolean;
        limit?: number;
      }) => {
        if (id !== undefined) {
          const found = getFact(db, id);
          if (!found) return text(`No such memory: #${id}`, true);
          return text(formatMemoryFact(found.fact, found.evidence));
        }
        if (topics) return text(formatTopics(listTopics(db, limit ?? 20)));
        return text(formatMemory(listFacts(db, { project: project ?? null, limit: limit ?? 10 })));
      },
    ),
  );

  server.registerTool(
    "cam_status",
    {
      title: "Index status",
      description:
        "When the index last synced, what it holds, and whether it is trustworthy. Call this " +
        "when a reply marks itself STALE, or when the user asks if the history is current. " +
        "It cannot write: the user has to start the sync (cam sync).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(() => {
      const L = [describeFreshness(freshness(db, now(), opts.staleAfterMs))];

      const tools = db
        .prepare("select tool k, count(*) c from sessions group by k order by c desc")
        .all() as Array<{ k: string; c: number }>;
      if (tools.length > 0) L.push(`tools             ${tools.map((t) => `${t.k}=${t.c}`).join("  ")}`);

      const conf = db
        .prepare("select confidence k, count(*) c from attribution group by k")
        .all() as Array<{ k: string; c: number }>;
      if (conf.length > 0) L.push(`attribution       ${conf.map((r) => `${r.k}=${r.c}`).join("  ")}`);

      const mem = memoryStatus(db);
      L.push(`memory            ${mem.facts} memories · ${mem.events} recalls from ${mem.queries} queries`);

      // A copied index that finds nothing looks identical to an empty one; the
      // only place that difference can be surfaced is here.
      const portability = checkPortability(db);
      if (portability.message) L.push(`  ! ${portability.message}`);

      return text(L.join("\n"));
    }),
  );

  return server;
}

function parseDate(s: string | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<void> {
  // The one flag the server needs: a client config names the index explicitly
  // when it is not the default one.
  const i = argv.indexOf("--db");
  const inline = argv.find((a) => a.startsWith("--db="));
  const dbPath = i !== -1 ? argv[i + 1] : inline?.slice("--db=".length);

  const cfg = loadConfig(dbPath ? { dbPath } : {}, (m) => process.stderr.write(`${m}\n`));
  const db = openHub(cfg.dbPath);
  initSchema(db);
  const server = createServer(db, { staleAfterMs: cfg.staleAfterMs });
  // stdout is the JSON-RPC channel; anything human-readable goes to stderr.
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} — ${cfg.dbPath}\n`);
  await server.connect(new StdioServerTransport());
}

// Exact comparison, not a filename match: any module whose basename happened to
// be server.js would otherwise start a stdio server on import.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
