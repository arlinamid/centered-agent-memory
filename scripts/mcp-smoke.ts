/**
 * End-to-end MCP smoke test against the REAL hub database, as a subprocess.
 *
 * The in-process tests cover behaviour; this covers what they cannot see — the
 * entry point, the stdio transport, and how a response actually looks to a
 * client. It also asserts the M4 condition on live data: every answer, error
 * answers included, ends with the index's age.
 *
 * Read-only. Run with: npx tsx scripts/mcp-smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/mcp/server.ts"],
  cwd: process.cwd(),
  stderr: "pipe",
});
const client = new Client({ name: "cam-smoke", version: "1.0.0" });
await client.connect(transport);

const text = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? []).map((b) => b.text ?? "").join("\n");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

console.log("capabilities:", JSON.stringify(client.getServerCapabilities()));
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

/** Whichever project is biggest, so the script is not tied to one machine. */
const projects = await client.callTool({ name: "cam_projects", arguments: { limit: 5 } });
const project = text(projects).split("\n")[0]?.trim().split(/\s+/)[0] ?? "";
console.log(`\nlegnagyobb projekt: ${project}`);

const calls: Array<[string, Record<string, unknown>]> = [
  ["cam_status", {}],
  ["cam_projects", { limit: 5 }],
  ["cam_dossier", { project }],
  ["cam_timeline", { project, limit: 3 }],
  ["cam_recall", { query: "memória konszolidáció", limit: 3 }],
  ["cam_memory", {}],
  // The error path: a missing footer would be least noticed exactly here.
  ["cam_get", { citation: "nonsense" }],
];

let undated = 0;
for (const [name, args] of calls) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const body = text(res).trimEnd();
  const footer = body.split("\n").at(-1) ?? "";
  const dated = footer.startsWith("— index:");
  if (!dated) undated++;
  console.log(
    `${dated ? "ok  " : "HIÁNYZIK"} ${name.padEnd(13)} ${String(Date.now() - t0).padStart(4)} ms` +
      `  ${isError(res) ? "[tool-hiba] " : ""}${footer.slice(0, 90)}`,
  );
}

const covered = new Set(calls.map(([n]) => n));
const missed = tools.map((t) => t.name).filter((n) => !covered.has(n));
if (missed.length > 0) console.log(`\nnem hívott tool: ${missed.join(", ")}`);

await client.close();
console.log(undated === 0 && missed.length === 0 ? "\nOK" : "\nHIBA");
process.exit(undated === 0 && missed.length === 0 ? 0 : 1);
