/**
 * Does the globally installed MCP server come up and answer over stdio?
 *
 * The in-process tests cover behaviour and `scripts/mcp-smoke.ts` covers a
 * real corpus, but neither notices if the *installed* copy fails to start —
 * a missing file in `files`, a bad shebang, or an entry point that resolves
 * to nothing. So this runs against the global install on an empty index,
 * which is also the state a first-time user is in.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Spawn the server's JS directly instead of the `cam-mcp` shim: on Windows the
// shim is a `.cmd` the transport cannot exec without a shell, and a shell in
// the middle would hide exactly the startup failure this is looking for.
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
const server = path.join(globalRoot, "centered-agent-memory", "dist", "mcp", "server.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  stderr: "pipe",
});

const client = new Client({ name: "cam-ci", version: "1.0.0" });
await client.connect(transport);
console.log("initialize rendben:", JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`${names.length} eszköz: ${names.join(", ")}`);
if (names.length === 0) throw new Error("a szerver egyetlen eszközt sem hirdetett");

// The structural guarantee: every answer states how old the index is. On an
// empty index that is the "never finished a sync" branch, which is the one a
// new user meets first and the easiest one to leave unwired.
const result = await client.callTool({ name: "cam_status", arguments: {} });
const text = (result.content ?? []).map((b) => b.text ?? "").join("\n");
console.log("\ncam_status:\n" + text);

if (!/index/i.test(text)) {
  throw new Error("a cam_status válaszából hiányzik az index frissességi sora");
}

await client.close();
console.log("\nA telepített MCP-szerver elindul és válaszol.");
