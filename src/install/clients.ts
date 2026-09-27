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
  /** Where the skill comes from when there is no file to write: what the user is told instead. */
  skillVia?: string;
  /**
   * A copy cam would write here, had another channel not taken over: it is
   * removed on install and refresh, so the client does not list the skill twice.
   */
  supersededSkillFile?: string;
}

/** The repository whose `.claude-plugin/marketplace.json` carries the Desktop skill. */
export const MARKETPLACE_REPO = "arlinamid/centered-agent-memory";

/** The name the server is registered under, in every client. */
export const SERVER_KEY = "cam";

/** The skill's directory name, and its `name:` in the frontmatter. */
export const SKILL_NAME = "agent-memory";

/** The `name` in `.claude-plugin/marketplace.json`, and so the part after `@` in the install id. */
export const MARKETPLACE_NAME = "centered-agent-memory";

/** The plugin's install id, the key Claude Code writes under `enabledPlugins`. */
export const PLUGIN_ID = `${SKILL_NAME}@${MARKETPLACE_NAME}`;

/**
 * Whether the marketplace plugin is on in Claude Code's user settings.
 *
 * Claude Desktop installs a Personal marketplace plugin into the same
 * `~/.claude/settings.json` Claude Code reads, so once the user adds the
 * marketplace in the app, Claude Code has the skill from the plugin as well.
 * An unreadable file counts as off: cam then writes its copy, as before.
 */
export function pluginEnabled(claudeHome: string): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8")) as {
      enabledPlugins?: Record<string, unknown>;
    };
    return settings.enabledPlugins?.[PLUGIN_ID] === true;
  } catch {
    return false;
  }
}

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
  const claudeSkill = path.join(claudeHome, "skills", SKILL_NAME, "SKILL.md");
  const viaPlugin = pluginEnabled(claudeHome);

  return [
    {
      id: "claude_code",
      name: "Claude Code",
      scope: "user",
      home: claudeHome,
      installed: fs.existsSync(claudeHome),
      mcpFile: path.join(home, ".claude.json"),
      mcpFormat: "json",
      // With the marketplace plugin on, a copy here would be the same skill a
      // second time, under a second name, in the same list.
      ...(viaPlugin
        ? { skillFile: null, supersededSkillFile: claudeSkill, skillVia: `skill: from the plugin ${PLUGIN_ID}` }
        : { skillFile: claudeSkill }),
    },
    {
      id: "claude_desktop",
      name: "Claude Desktop / Cowork",
      scope: "user",
      home: desktopHome,
      installed: fs.existsSync(desktopHome),
      mcpFile: path.join(desktopHome, "claude_desktop_config.json"),
      mcpFormat: "json",
      // Chat and Cowork have no skill directory we can write: they take skills
      // only from the account or from a plugin, and a marketplace is added in
      // the app's own UI. The repository is that marketplace. The app installs
      // the plugin into Claude Code's settings, which is why the `claude_code`
      // target steps aside once it is on.
      skillFile: null,
      skillVia: viaPlugin
        ? `skill: from the plugin ${PLUGIN_ID}`
        : `skill: add the marketplace ${MARKETPLACE_REPO} under Directory → Plugins → Personal`,
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
    },
    {
      id: "devin",
      name: "Devin",
      scope: "user",
      home: devinHome,
      installed: fs.existsSync(devinHome),
      mcpFile: path.join(devinHome, "mcp_config.json"),
      mcpFormat: "json",
      // Devin's global skills live in its own directory: the app data one on
      // Windows and Linux, `~/.config/devin/skills` on macOS
      // (docs.devin.ai/cli/extensibility/skills/overview). From Claude Code it
      // imports only a project's `.claude/skills/`, not `~/.claude/skills/`.
      // `~/.agents/skills/` would reach it too, but Codex, Cursor and Gemini
      // CLI read that folder as well and would list the skill twice.
      skillFile: path.join(
        process.platform === "darwin" ? path.join(home, ".config", "devin") : devinHome,
        "skills",
        SKILL_NAME,
        "SKILL.md",
      ),
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
  // A project copy is for everyone who opens the repository, most of whom do
  // not have this user's plugin, so it is written whether or not the plugin is on.
  const of = (id: ClientId, mcpFile: string, skillFile: string): ClientTarget => ({
    ...user.get(id)!,
    scope: "project",
    mcpFile: path.join(cwd, mcpFile),
    skillFile: path.join(cwd, skillFile),
    skillVia: undefined,
    supersededSkillFile: undefined,
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
