# MCP server

`cam` also runs as an MCP server, so all four agents can query **the same**
context the CLI shows — rendering is shared, the two surfaces cannot drift
apart.

Strictly **read-only**: there is no write tool, and it does not modify any
tool's store.

## Startup

The wiring does not have to be written by hand: `cam install` registers the
server with every client it finds, with an absolute path, without touching
existing entries — see [`install.md`](install.md). What follows is what that
command does.

```bash
cam-mcp                       # stdio, JSON-RPC on stdout
```

`cam-mcp` is the package's second entry point (on the PATH after a global
install). From a checkout, without installing: `node dist/mcp/server.js`.
During development: `node --import tsx src/mcp/server.ts`.

The index location can be set with the `--db <path>` flag or the `CAM_DB`
environment variable; without that it opens the same database the CLI does
(`cam doctor` prints which one).

`stdout` is the JSON-RPC channel, so every line meant for a human goes to
`stderr`.

## Tools

| tool | what it is for |
|---|---|
| `cam_dossier` | the full picture of one project: per-tool counts, date range, largest sessions, recent topics, artifacts, source status |
| `cam_timeline` | the project's sessions in time order, from every tool, with how they were attributed |
| `cam_recall` | full-text search, with a citable reference |
| `cam_get` | expand a citation into full text (from the CLI: `cam get`) |
| `cam_projects` | the list of indexed projects |
| `cam_memory` | long-term memory: what came back across several questions, on several days — with the evidence behind the promotion |
| `cam_status` | when the index last synced, what it holds, whether it is trustworthy |

Seven tools, deliberately that many. Every further tool consumes context in all
four clients, on every request.

`cam_memory` without `id` lists the promoted memories (filterable by project),
with `id` returns one memory's full text with the evidence (when, on which
questions it came up), and with `topics: true` the recurring topics. If the
reply is empty, not enough recall trace has been collected yet — see
[`memory.md`](memory.md).

Each goes out with a `readOnlyHint: true` annotation, and returns an error as a
tool error, not a crash.

## The index's age on every response

The last line of every tool response says when the index last synced:

```
— index: 2026-08-29 17:37 UTC (1 min ago) · 1643 session · 32054 turn
```

If it is older than the threshold (24 hours by default, `staleAfterHours` in
the config), the line says `STALE, run: cam sync`; if the last sync had errors,
that too. The server's instructions tell the agent to report that to the user
rather than quote the old data as current.

This is not in the individual handlers, but in the function that wraps tool
registration: there is no way to register a tool that omits it — including
error responses, where its absence would be least noticed. `npm run smoke`
checks all seven tools with a real stdio client, against the real index.

The longer story — scheduling, retention, backup — is in
[`operations.md`](operations.md).

## Wiring

All four clients call the same command, with no machine-specific path.

**Claude Code** — `.mcp.json` in the project, or `claude mcp add`:

```json
{
  "mcpServers": {
    "cam": { "command": "cam-mcp" }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json`, the same block.

**Cursor** — `.cursor/mcp.json`, the same block.

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.cam]
command = "cam-mcp"
```

If it is not installed (checkout only), the command is `node` and the argument
is `dist/mcp/server.js` — but then the path points at your machine, and the
blocks above are not portable.

Opening another index: `{ "command": "cam-mcp", "args": ["--db", "<path>"] }`.

## What the responses contain

Every hit carries the confidence of the project attribution:

- **strong** — from the session's working directory or file paths mentioned in the conversation
- **medium** — from file-edit time correlation, with enough evidence
- **weak** — the same, with little evidence; filtered out by default, available with the `includeWeak` flag
- **none** — no attribution

If a source has since changed (`stale`) or vanished (`missing`), the response
prints this instead of quietly dropping the hit.

## Why not `Content-Length` framing

telecodex `memory-core` uses LSP-style `Content-Length` framing for Codex's
sake. The MCP spec, however, requires line-delimited JSON, and `parseMcpFrame`
mandatorily expects a header, with no fallback — making that the default would
break three of the four clients. `cam` uses the SDK's `StdioServerTransport`.
