import { clientTargets, SKILL_NAME } from "./clients.js";
import { packageMeta, renderSkill } from "./skills.js";

/**
 * The files that make this repository a plugin marketplace for Claude Desktop.
 *
 * Chat and Cowork have no skill directory cam could write, so the skill
 * reaches them as a plugin the user installs from the repository itself. The
 * files are committed, because the app reads them from git, and rendered from
 * the same sources as every other copy of the skill; `npm run skills` writes
 * them and the test suite fails when a committed copy has drifted.
 *
 * The plugin carries no MCP server: `cam install` already registers one in
 * `claude_desktop_config.json`, and a second from the plugin would start
 * beside it.
 */

export const PLUGIN_ROOT = `plugins/${SKILL_NAME}`;

/**
 * Repository-relative path → rendered text, for every committed rendering:
 * the plugin's files, and the skill `npx skills add` finds under `skills/`.
 */
export function publishedFiles(): Record<string, string> {
  const targets = clientTargets("user");
  const of = (id: string) => targets.find((t) => t.id === id)!;
  return {
    [`skills/${SKILL_NAME}/SKILL.md`]: renderSkill(of("claude_code")),
    [`${PLUGIN_ROOT}/.claude-plugin/plugin.json`]: renderPluginManifest(),
    [`${PLUGIN_ROOT}/skills/${SKILL_NAME}/SKILL.md`]: renderSkill(of("claude_desktop")),
  };
}

/**
 * `version` lives here and not in the marketplace entry: the app gives users
 * a new copy only when it changes, and a value in both places is a mismatch
 * the validator reports.
 */
export function renderPluginManifest(): string {
  const meta = packageMeta();
  const manifest = {
    name: SKILL_NAME,
    description:
      "The agent-memory skill for Claude Desktop Chat and Cowork: when to look up the user's " +
      "earlier conversations and project files through the cam MCP server. Needs cam " +
      "installed; Claude Code and the other agents get the skill from `cam install` instead.",
    version: meta.version,
    author: { name: meta.author },
    homepage: meta.source,
    repository: meta.source,
    license: meta.license,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
