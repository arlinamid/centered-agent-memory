import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Writing the server into somebody else's configuration file.
 *
 * Two rules shape everything here. The files belong to other tools and are
 * usually hand-maintained, so we change the least that will do: one key in a
 * JSON object, one table in a TOML file, and nothing else. And a file we cannot
 * parse is a file we refuse to touch — a corrupted `~/.claude.json` costs the
 * user more than a missing MCP entry.
 */

export interface ServerEntry {
  command: string;
  args?: string[];
}

export type Change = "added" | "updated" | "unchanged" | "removed" | "absent";

export interface Edit {
  text: string;
  change: Change;
}

/** Package root, from either `src/install/` or `dist/install/`. */
export function installRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Is this package running from a directory that will not survive?
 *
 * `npx` unpacks into the npm cache under `_npx/<hash>` and lets npm collect it
 * later. Nothing written from there lasts: an absolute path into the cache
 * rots when the cache is cleaned, and a bare `cam-mcp` is only on the PATH for
 * the duration of the run, because npm prepends the unpacked `node_modules/.bin`
 * to it. Both produce a config entry that looks right today and fails silently
 * afterwards, which is worse than refusing.
 */
export function ephemeralRoot(root = installRoot()): boolean {
  return root.replace(/\\/g, "/").toLowerCase().split("/").includes("_npx");
}

export class EphemeralInstallError extends Error {
  constructor(readonly root: string) {
    super(
      `ideiglenes csomagmappából fut (${root}) — innen nem lehet tartós bekötést írni.\n` +
        "Telepítsd előbb tartósan, aztán futtasd újra:  npm i -g centered-agent-memory && cam install",
    );
    this.name = "EphemeralInstallError";
  }
}

/**
 * The path with every symlink resolved, or the path itself if it cannot be.
 *
 * A Node version manager puts a moving link in the middle of both halves of
 * the command we are about to write down: `C:\nvm\current\node.exe` and the
 * global `node_modules` beside it both follow whichever version is selected
 * today. An unattended job must not change which Node runs it because somebody
 * switched versions in a terminal, so the link is followed once, here, and the
 * result is what goes into the config. Switching versions then means re-running
 * `cam install`, which is a visible step rather than a silent one.
 */
export function resolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * What to put in the config: always an absolute path, never a bare command.
 *
 * A client is not started by your shell — a desktop app launched from the dock
 * has no login PATH at all — so a machine-independent-looking `cam-mcp` is a
 * bet on an environment we cannot see. The absolute path is uglier and honest,
 * and re-running `cam install` is what fixes it if the package moves.
 */
export function serverEntry(_env = process.env): ServerEntry {
  const root = installRoot();
  if (ephemeralRoot(root)) throw new EphemeralInstallError(root);
  return { command: resolved(process.execPath), args: [path.join(root, "dist", "mcp", "server.js")] };
}

export const sameEntry = (a: ServerEntry | undefined, b: ServerEntry): boolean =>
  a !== undefined && a.command === b.command && (a.args ?? []).join("\u0000") === (b.args ?? []).join("\u0000");

/** Reuse the file's own indentation rather than imposing ours on a big file. */
function detectIndent(text: string): string | number {
  const m = /\n(\s+)"/.exec(text);
  if (!m?.[1]) return 2;
  return m[1].includes("\t") ? "\t" : m[1].length;
}

export class ConfigParseError extends Error {
  constructor(file: string, detail: string) {
    super(`nem értelmezhető konfiguráció: ${file} (${detail})`);
    this.name = "ConfigParseError";
  }
}

/**
 * JSON clients all use the same shape — a `mcpServers` object keyed by server
 * name — so one function serves Claude Code, Claude Desktop and Cursor.
 */
export function upsertJson(text: string, file: string, key: string, entry: ServerEntry): Edit {
  const trimmed = text.trim();
  let doc: Record<string, unknown>;
  if (trimmed === "") {
    doc = {};
  } else {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("nem objektum");
      doc = parsed as Record<string, unknown>;
    } catch (err) {
      throw new ConfigParseError(file, (err as Error).message);
    }
  }

  const servers = (doc.mcpServers ?? {}) as Record<string, ServerEntry>;
  const change: Change = servers[key] === undefined ? "added" : sameEntry(servers[key], entry) ? "unchanged" : "updated";
  if (change === "unchanged") return { text, change };

  doc.mcpServers = { ...servers, [key]: entry };
  return { text: `${JSON.stringify(doc, null, detectIndent(text))}\n`, change };
}

export function removeJson(text: string, file: string, key: string): Edit {
  if (text.trim() === "") return { text, change: "absent" };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigParseError(file, (err as Error).message);
  }
  const servers = (doc.mcpServers ?? {}) as Record<string, ServerEntry>;
  if (servers[key] === undefined) return { text, change: "absent" };

  const rest = { ...servers };
  delete rest[key];
  doc.mcpServers = rest;
  return { text: `${JSON.stringify(doc, null, detectIndent(text))}\n`, change: "removed" };
}

const tomlString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function tomlTable(name: string, entry: ServerEntry): string {
  const lines = [`[${name}]`, `command = ${tomlString(entry.command)}`];
  if (entry.args && entry.args.length > 0) {
    lines.push(`args = [${entry.args.map(tomlString).join(", ")}]`);
  }
  return lines.join("\n");
}

/**
 * Find one table and the lines belonging to it, without parsing the document.
 *
 * A TOML round-trip through a serializer would reformat the whole file and
 * throw away its comments and quoting style; `~/.codex/config.toml` is a large
 * hand-written file where that is a real loss. Scanning for the header and
 * stopping at the next one changes exactly the lines that are ours.
 */
function findTable(lines: string[], name: string): { start: number; end: number } | null {
  const header = new RegExp(`^\\s*\\[\\s*${name.replace(/[.\\]/g, "\\$&")}\\s*\\]\\s*$`);
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // A sub-table (`[mcp_servers.cam.env]`) belongs to this table; any other
    // header ends it.
    if (/^\s*\[/.test(lines[i]!) && !new RegExp(`^\\s*\\[\\s*${name}\\.`).test(lines[i]!)) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
  return { start, end };
}

export function upsertToml(text: string, name: string, entry: ServerEntry): Edit {
  const block = tomlTable(name, entry);
  const lines = text.split(/\r?\n/);
  const found = findTable(lines, name);

  if (!found) {
    const body = text.trimEnd();
    const next = body === "" ? `${block}\n` : `${body}\n\n${block}\n`;
    return { text: next, change: "added" };
  }

  const current = lines.slice(found.start, found.end).join("\n").trim();
  if (current === block) return { text, change: "unchanged" };

  const next = [...lines.slice(0, found.start), ...block.split("\n"), ...lines.slice(found.end)];
  return { text: `${next.join("\n").trimEnd()}\n`, change: "updated" };
}

export function removeToml(text: string, name: string): Edit {
  const lines = text.split(/\r?\n/);
  const found = findTable(lines, name);
  if (!found) return { text, change: "absent" };

  const next = [...lines.slice(0, found.start), ...lines.slice(found.end)];
  return { text: `${next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, change: "removed" };
}

/**
 * One backup per file per run, named so it is obvious what made it and when.
 * Restoring is a copy back — no tooling required, which is the point.
 */
export function backupOnce(file: string, made: Set<string>, stamp: string): string | null {
  if (made.has(file) || !fs.existsSync(file)) return null;
  const dest = `${file}.cam-backup-${stamp}`;
  fs.copyFileSync(file, dest);
  made.add(file);
  return dest;
}
