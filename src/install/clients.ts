import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appSupportDir } from "../paths.js";

/**
 * Where each agent tool keeps its MCP configuration and its skills.
 *
 * The same tools the collectors read from, approached from the other end:
 * there we look for their conversation stores, here for the files that tell
 * them about a server. Detection is by the tool's own home directory, so a
 * client that was never installed is reported as absent rather than having a
 * config file conjured for it.
 *
 * Nothing here is hardcoded to a machine; the profile directory is a parameter
 * so the test suite can point the whole registry at a fixture.
 */

export type ClientId =
  | "claude_code"
  | "claude_desktop"
  | "codex"
  | "cursor"
  | "gemini_cli"
  | "antigravity"
  | "devin";
export type ConfigFormat = "json" | "toml";
export type Scope = "user" | "project";

export interface ClientTarget {
  id: ClientId;
  name: string;
  scope: Scope;
  /** The directory whose existence means the tool is installed. */
  home: string;
  installed: boolean;
  /** Null when the client has no configuration at this scope. */
  mcpFile: string | null;
  mcpFormat: ConfigFormat;
  /** Null when the client has no skill system. */
  skillFile: string | null;
  /** How to reach the index from this client, appended to the shared skill body. */
  surface: string;
}

/** The name the server is registered under, in every client. */
export const SERVER_KEY = "cam";

/** The skill's directory name, and its `name:` in the frontmatter. */
export const SKILL_NAME = "agent-memory";

const CLI_SURFACE = `## This surface

The \`cam_*\` MCP tools are also available from the terminal if \`cam\` is on PATH:
\`cam projects\`, \`cam dossier <project>\`, \`cam recall "<query>"\`, \`cam get <citation>\`,
\`cam timeline <project>\`, \`cam memory list\`. Each accepts \`--json\`. Rendering is shared,
so you get the same text as from the tools.

If the index is stale, \`cam sync\` refreshes it. That is the only write, and it writes
only the index.`;

const MCP_ONLY_SURFACE = `## This surface

Only the \`cam_*\` MCP tools are available; there is no terminal. If the index is stale,
ask the user to run \`cam sync\` — you cannot refresh it yourself.`;

/**
 * Claude Code keeps its user-level server map in `~/.claude.json`, not under
 * `~/.claude/`: the directory holds state, the dotfile holds configuration.
 */
function userTargets(home: string): ClientTarget[] {
  const claudeHome = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  const cursorHome = path.join(home, ".cursor");
  const desktopHome = appSupportDir("Claude", home);
  const geminiHome = path.join(home, ".gemini");
  const antigravityHome = path.join(geminiHome, "antigravity");
  const devinHome = appSupportDir("devin", home);

  return [
    {
      id: "claude_code",
      name: "Claude Code",
      scope: "user",
      home: claudeHome,
      installed: fs.existsSync(claudeHome),
      mcpFile: path.join(home, ".claude.json"),
      mcpFormat: "json",
      skillFile: path.join(claudeHome, "skills", SKILL_NAME, "SKILL.md"),
      surface: CLI_SURFACE,
    },
    {
      id: "claude_desktop",
      name: "Claude Desktop / Cowork",
      scope: "user",
      home: desktopHome,
      installed: fs.existsSync(desktopHome),
      mcpFile: path.join(desktopHome, "claude_desktop_config.json"),
      mcpFormat: "json",
      // Claude Code Desktop reads `~/.claude/skills/` — that is the
      // `claude_code` target, installed by `npx skills add … --agent claude-code`.
      // The original Desktop / Cowork app has no skill directory we can write:
      // Cowork only registers a skill through its Customize UI, not by scanning
      // a folder. Its channel here is the server's own instructions.
      skillFile: null,
      surface: MCP_ONLY_SURFACE,
    },
    {
      id: "codex",
      name: "Codex",
      scope: "user",
      home: codexHome,
      installed: fs.existsSync(codexHome),
      mcpFile: path.join(codexHome, "config.toml"),
      mcpFormat: "toml",
      skillFile: path.join(codexHome, "skills", SKILL_NAME, "SKILL.md"),
      surface: CLI_SURFACE,
    },
    {
      id: "cursor",
      name: "Cursor",
      scope: "user",
      home: cursorHome,
      installed: fs.existsSync(cursorHome),
      mcpFile: path.join(cursorHome, "mcp.json"),
      mcpFormat: "json",
      // Never `skills-cursor/`: that directory is Cursor's own, and is
      // rewritten by the app.
      skillFile: path.join(cursorHome, "skills", SKILL_NAME, "SKILL.md"),
      surface: CLI_SURFACE,
    },
    {
      id: "gemini_cli",
      name: "Gemini CLI",
      scope: "user",
      home: geminiHome,
      installed: fs.existsSync(geminiHome),
      // Not a dedicated server file: `mcpServers` is one key inside the general
      // settings document, next to `ui` and `security`. `upsertJson` merges into
      // that key and leaves the rest of the document alone, which is exactly
      // what is needed here.
      mcpFile: path.join(geminiHome, "settings.json"),
      mcpFormat: "json",
      skillFile: path.join(geminiHome, "skills", SKILL_NAME, "SKILL.md"),
      surface: CLI_SURFACE,
    },
    {
      id: "antigravity",
      name: "Antigravity",
      scope: "user",
      home: antigravityHome,
      installed: fs.existsSync(antigravityHome),
      // One configuration serves all three Antigravity surfaces (IDE, CLI, and
      // the older `antigravity-ide` tree): `~/.gemini/antigravity/mcp_config.json`
      // is a symlink to this file, and `config/.migrated` records the move.
      // Writing the canonical path rather than the link keeps the link a link.
      mcpFile: path.join(geminiHome, "config", "mcp_config.json"),
      mcpFormat: "json",
      skillFile: path.join(antigravityHome, "skills", SKILL_NAME, "SKILL.md"),
      surface: CLI_SURFACE,
    },
    {
      id: "devin",
      name: "Devin",
      scope: "user",
      home: devinHome,
      installed: fs.existsSync(devinHome),
      mcpFile: path.join(devinHome, "mcp_config.json"),
      mcpFormat: "json",
      // Devin has no skill directory of its own: it scans `~/.claude/skills/`
      // and `~/.agents/skills/`, and the Claude Code target already writes the
      // first of those. Writing a second copy would list one skill twice in
      // Devin's own skill menu, so the Claude Code target is the channel here.
      skillFile: null,
      surface: CLI_SURFACE,
    },
  ];
}

/**
 * Project scope exists only where the client actually reads a per-repository
 * file. Codex configures its servers globally and Claude Desktop has no notion
 * of a repository, so neither gets a project target — inventing one would
 * write a file nothing reads.
 */
function projectTargets(home: string, cwd: string): ClientTarget[] {
  const user = new Map(userTargets(home).map((t) => [t.id, t]));
  const of = (id: ClientId, mcpFile: string, skillFile: string): ClientTarget => ({
    ...user.get(id)!,
    scope: "project",
    mcpFile: path.join(cwd, mcpFile),
    skillFile: path.join(cwd, skillFile),
  });

  return [
    of("claude_code", ".mcp.json", path.join(".claude", "skills", SKILL_NAME, "SKILL.md")),
    of("cursor", path.join(".cursor", "mcp.json"), path.join(".cursor", "skills", SKILL_NAME, "SKILL.md")),
  ];
}

export function clientTargets(scope: Scope, home = os.homedir(), cwd = process.cwd()): ClientTarget[] {
  return scope === "project" ? projectTargets(home, cwd) : userTargets(home);
}

const CLIENT_IDS = new Set<string>([
  "claude_code",
  "claude_desktop",
  "codex",
  "cursor",
  "gemini_cli",
  "antigravity",
  "devin",
]);

export const isClientId = (s: string): s is ClientId => CLIENT_IDS.has(s);
