#!/usr/bin/env node
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

export const SERVER_NAME = "centered-agent-memory";
/** Kept in step with package.json by a test, so the two cannot drift apart. */
export const SERVER_VERSION = "0.5.0";

const INSTRUCTIONS = `Kereshető index a felhasználó MÁSIK AI-eszközeinek beszélgetéseiről:
Claude Code, Claude Desktop / Cowork, Codex és Cursor. Csak olvas — egyik eszköz
tárolóját sem módosítja.

Használd, mielőtt egy projekt korábbi munkájáról kérdeznél vagy feltételeznél
valamit: cam_dossier adja a projekt teljes képét, cam_timeline az időrendet,
cam_recall a szöveges keresést, cam_get pedig egy találat teljes szövegét.
A cam_memory azt adja vissza, ami a korábbi kereséseidben többször, több napon,
többféle kérdésre előjött — bizonyítékkal együtt.

Minden találat mellett ott a projekt-hozzárendelés megbízhatósága
(strong / medium / weak / none). A gyenge hozzárendelés idő-korrelációból
származik és tévedhet. Ha egy forrás azóta megváltozott vagy eltűnt, az
eredmény ezt kiírja ahelyett, hogy csendben kihagyná.

Minden válasz utolsó sora megmondja, mikor szinkronizált utoljára az index.
Ha ELAVULT-ot ír, az azóta folytatott beszélgetések nincsenek benne — ezt
mondd meg a felhasználónak ahelyett, hogy a régi adatot friss gyanánt idéznéd.`;

export interface ServerOptions {
  /** Past this age the index reports itself as stale. */
  staleAfterMs?: number;
  nowMs?: () => number;
}

/** Factory so tests can drive the server in-process over an in-memory transport. */
export function createServer(db: Db, opts: ServerOptions = {}): McpServer {
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
  const dated =
    <A>(handler: (args: A) => ToolResult) =>
    (args: A): ToolResult => {
      const res = handler(args);
      const footer = formatFreshness(freshness(db, now(), opts.staleAfterMs));
      return { ...res, content: [...res.content, { type: "text", text: footer }] };
    };

  const text = (s: string, isError = false): ToolResult => ({ content: [{ type: "text", text: s }], isError });

  server.registerTool(
    "cam_dossier",
    {
      title: "Projekt-dosszié",
      description:
        "Mi történt egy projekten: eszközönkénti session- és turn-számok, időtartomány, " +
        "legnagyobb sessionök, legutóbbi témák, melléktermékek, forrás-állapot. " +
        "Ezzel kezdd, ha egy projekt előzményeire vagy kíváncsi.",
      inputSchema: {
        project: z.string().min(1).describe("Projektkulcs, ahogy a cam_projects listázza"),
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
        return text(`Nincs ilyen projekt: ${project}\nIsmert projektek: ${known}`, true);
      }
      return text(formatDossier(d));
    }),
  );

  server.registerTool(
    "cam_timeline",
    {
      title: "Projekt idővonala",
      description:
        "Egy projekt sessionjei időrendben, mind a négy eszközből, a projekt-hozzárendelés " +
        "módjával és megbízhatóságával. Szöveget nem olvas, ezért gyors.",
      inputSchema: {
        project: z.string().min(1),
        since: z.string().optional().describe("ISO dátum, ettől kezdve"),
        until: z.string().optional().describe("ISO dátum, eddig"),
        tools: z.array(z.string()).optional().describe("Szűrés eszközre: claude_code, codex, cursor, cowork"),
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
      title: "Keresés a beszélgetésekben",
      description:
        "Teljes szövegű keresés az indexelt beszélgetésekben. Ékezetre érzéketlen, és a hosszabb " +
        "szavakra prefix-illesztést használ (magyar toldalékolás miatt). Minden találat idézhető " +
        "hivatkozást ad, amit a cam_get kibont.",
      inputSchema: {
        query: z.string().min(1),
        project: z.string().optional(),
        tool: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        includeWeak: z.boolean().optional().describe("Gyenge projekt-hozzárendelésű találatok is"),
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
      title: "Egy session szövege",
      description:
        "Egy találat teljes szövege. A hivatkozás formája tool:sessionId#seqN-M, ahogy a " +
        "cam_recall adja. Ha a forrás azóta megváltozott vagy eltűnt, azt jelzi.",
      inputSchema: {
        citation: z
          .string()
          .min(3)
          .describe("cam_recall hivatkozás, pl. codex:019d4cd9-…#seq12-18, vagy csak tool:sessionId"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(({ citation }: { citation: string }) => {
      const parsed = parseCitation(citation);
      if (!parsed) return text(`Értelmezhetetlen hivatkozás: ${citation}`, true);

      const turns = getTurns(db, parsed.tool, parsed.sessionExtId, parsed.seqStart, parsed.seqEnd);
      if (turns.length === 0) return text(`Nincs ilyen session: ${citation}`, true);

      return text(formatTurns(turns));
    }),
  );

  server.registerTool(
    "cam_projects",
    {
      title: "Projektek listája",
      description: "Az indexelt projektek session- és turn-számmal, a legutóbbi aktivitás szerint.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(({ limit }: { limit?: number }) => {
      const rows = listProjects(db).slice(0, limit ?? 50);
      const listed = rows
        .map(
          (p) =>
            `${p.key.padEnd(30)} ${String(p.sessions).padStart(4)} session ${String(p.turns).padStart(7)} turn` +
            `  utoljára: ${p.lastMs ? new Date(p.lastMs).toISOString().slice(0, 10) : "?"}`,
        )
        .join("\n");
      return text(listed || "Az index üres. Futtasd: cam sync");
    }),
  );

  server.registerTool(
    "cam_memory",
    {
      title: "Hosszú távú memória",
      description:
        "Amit a kereséseid többször, több napon, többféle kérdésre előhívtak — determinisztikusan " +
        "promotálva, nem modellel összefoglalva. Az `id` megadásával egy emlék teljes szövegét és a " +
        "promóció bizonyítékát adja (mikor, milyen kérdésekre jött elő). Ha üres, még nem gyűlt elég " +
        "előhívási nyom; ez nem hiba.",
      inputSchema: {
        id: z.number().int().min(1).optional().describe("Egy konkrét emlék azonosítója"),
        project: z.string().optional(),
        topics: z.boolean().optional().describe("A visszatérő témákat adja vissza az emlékek helyett"),
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
          if (!found) return text(`Nincs ilyen emlék: #${id}`, true);
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
      title: "Az index állapota",
      description:
        "Mikor szinkronizált utoljára az index, mit tartalmaz, és megbízható-e. Akkor hívd, ha egy " +
        "válasz ELAVULT-nak jelzi magát, vagy ha a felhasználó azt kérdezi, naprakész-e az előzmény. " +
        "Írni nem tud: a szinkront a felhasználónak kell elindítania (cam sync).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    dated(() => {
      const L = [describeFreshness(freshness(db, now(), opts.staleAfterMs))];

      const tools = db
        .prepare("select tool k, count(*) c from sessions group by k order by c desc")
        .all() as Array<{ k: string; c: number }>;
      if (tools.length > 0) L.push(`eszközök          ${tools.map((t) => `${t.k}=${t.c}`).join("  ")}`);

      const conf = db
        .prepare("select confidence k, count(*) c from attribution group by k")
        .all() as Array<{ k: string; c: number }>;
      if (conf.length > 0) L.push(`hozzárendelés     ${conf.map((r) => `${r.k}=${r.c}`).join("  ")}`);

      const mem = memoryStatus(db);
      L.push(`memória           ${mem.facts} emlék · ${mem.events} előhívás ${mem.queries} kérdésből`);

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
