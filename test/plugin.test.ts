import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientTargets, MARKETPLACE_NAME, PLUGIN_ID, SKILL_NAME, type ClientTarget } from "../src/install/clients.js";
import { PLUGIN_ROOT, publishedFiles } from "../src/install/plugin.js";

const repo = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(repo, ...rel.split("/")), "utf8");
const pkg = JSON.parse(read("package.json"));
// The id cam looks for under `enabledPlugins` must be the one the app writes.
const entryName = (market: { plugins: Array<{ name: string }> }): string => market.plugins[0]!.name;

describe("Claude Desktop marketplace", () => {
  it("has every committed rendering up to date (run: npm run skills)", () => {
    for (const [rel, text] of Object.entries(publishedFiles())) {
      expect(fs.existsSync(path.join(repo, rel)), rel).toBe(true);
      expect(read(rel), rel).toBe(text);
    }
  });

  it("lists the plugin under the name its manifest carries, at a path inside the repository", () => {
    const market = JSON.parse(read(".claude-plugin/marketplace.json"));
    const manifest = JSON.parse(read(`${PLUGIN_ROOT}/.claude-plugin/plugin.json`));

    expect(market.name).toBe(MARKETPLACE_NAME);
    expect(`${entryName(market)}@${market.name}`).toBe(PLUGIN_ID);
    expect(market.owner?.name).toBeTruthy();
    const [entry] = market.plugins;
    expect(market.plugins).toHaveLength(1);
    // The entry name is the install id, the manifest name the skill prefix;
    // when they differ, installing by the manifest name fails.
    expect(entry.name).toBe(manifest.name);
    expect(entry.source).toBe(`./${PLUGIN_ROOT}`);
    expect(entry.source).not.toContain("..");
    // Version in one place only: the manifest's wins silently otherwise.
    expect(entry.version).toBeUndefined();
    expect(manifest.version).toBe(pkg.version);
  });

  it("carries the same skill as every other copy, and no server of its own", () => {
    // The app installs the plugin into Claude Code's settings too, so its
    // skill cannot be a Desktop-only text.
    expect(read(`${PLUGIN_ROOT}/skills/${SKILL_NAME}/SKILL.md`)).toBe(read(`skills/${SKILL_NAME}/SKILL.md`));
    // `cam install` registers the server in claude_desktop_config.json; a
    // bundled one would start a second process beside it.
    expect(fs.existsSync(path.join(repo, PLUGIN_ROOT, ".mcp.json"))).toBe(false);
    expect(JSON.parse(read(`${PLUGIN_ROOT}/.claude-plugin/plugin.json`)).mcpServers).toBeUndefined();
  });

  it("points the Desktop install report at this marketplace until the plugin is on", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cam-plugin-"));
    try {
      const desktop = (): ClientTarget => clientTargets("user", home).find((t) => t.id === "claude_desktop")!;
      const repoName = String(pkg.repository.url).replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "");
      expect(desktop().skillFile).toBeNull();
      expect(desktop().skillVia).toContain(repoName);

      fs.mkdirSync(path.join(home, ".claude"));
      fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: true } }));
      expect(desktop().skillVia).toContain(`from the plugin ${PLUGIN_ID}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
