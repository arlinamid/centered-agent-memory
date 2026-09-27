import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientTargets, SKILL_NAME } from "../src/install/clients.js";
import { PLUGIN_ROOT, publishedFiles } from "../src/install/plugin.js";

const repo = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(repo, ...rel.split("/")), "utf8");
const pkg = JSON.parse(read("package.json"));

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

    expect(market.name).toMatch(/^[a-z0-9-]+$/);
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

  it("gives Desktop its own surface and no server of its own", () => {
    const skill = read(`${PLUGIN_ROOT}/skills/${SKILL_NAME}/SKILL.md`);
    expect(skill).toContain("ask the user to run `cam sync`");
    expect(skill).not.toContain("run `cam sync`: it writes");
    // `cam install` registers the server in claude_desktop_config.json; a
    // bundled one would start a second process beside it.
    expect(fs.existsSync(path.join(repo, PLUGIN_ROOT, ".mcp.json"))).toBe(false);
    expect(JSON.parse(read(`${PLUGIN_ROOT}/.claude-plugin/plugin.json`)).mcpServers).toBeUndefined();
  });

  it("points the Desktop install report at this marketplace", () => {
    const desktop = clientTargets("user").find((t) => t.id === "claude_desktop")!;
    const repoName = String(pkg.repository.url).replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "");
    expect(desktop.skillFile).toBeNull();
    expect(desktop.skillVia).toContain(repoName);
  });
});
