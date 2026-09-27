import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_NAME } from "./clients.js";

/**
 * One skill, the same text in every client.
 *
 * It used to end in a per-client section — terminal or MCP only — but one
 * client's copy reaches another: Claude Desktop installs its marketplace
 * plugin into the settings Claude Code reads, so the Desktop text showed up in
 * a terminal client. The one text now says what holds where, and every copy —
 * the installed ones, `npx skills add`'s and the plugin's — is byte-identical.
 */

const DESCRIPTION =
  "Recall earlier conversations from the user's other AI tools (Claude Code, Claude Desktop, " +
  "Codex, Cursor, Gemini CLI, Antigravity, Devin), and search the files of the projects they " +
  "indexed. Use before asking about or assuming a project's history, when the user refers to " +
  "a prior decision, discussion or fix (\"as we discussed\", \"what we did with Codex\"), and " +
  "when you need a file from a project that is not open here.";

const COMPATIBILITY = "Requires the cam MCP server from centered-agent-memory.";

/** Package root, from either `src/install/` or `dist/install/`. */
export function packageFile(...parts: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}

export function skillBody(): string {
  return fs.readFileSync(packageFile("assets", "skill-body.md"), "utf8");
}

/**
 * The optional frontmatter fields of the Agent Skills spec, taken from
 * package.json so a release cannot leave them behind. `version` is how a
 * reader tells which release wrote an installed copy.
 */
export function packageMeta(): { version: string; author: string; license: string; source: string } {
  const pkg = JSON.parse(fs.readFileSync(packageFile("package.json"), "utf8")) as Record<string, unknown>;
  const repo = pkg.repository as { url?: string } | string | undefined;
  // `git+https://host/owner/name.git` → the page a person can open.
  const source = String(typeof repo === "string" ? repo : repo?.url ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  return { version: String(pkg.version), author: String(pkg.author), license: String(pkg.license), source };
}

export function renderSkill(body = skillBody()): string {
  const meta = packageMeta();
  const frontmatter = [
    "---",
    `name: ${SKILL_NAME}`,
    `description: >-`,
    ...wrap(DESCRIPTION, 92),
    `license: ${meta.license}`,
    `compatibility: ${COMPATIBILITY}`,
    "metadata:",
    `  author: ${JSON.stringify(meta.author)}`,
    `  version: ${JSON.stringify(meta.version)}`,
    `  source: ${JSON.stringify(meta.source)}`,
    "---",
    "",
  ];
  return `${frontmatter.join("\n")}${body.trimEnd()}\n`;
}

/** YAML block scalars need every line indented; long descriptions need wrapping. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(`  ${line}`);
      line = word;
    }
  }
  if (line !== "") out.push(`  ${line}`);
  return out;
}

export type SkillChange = "added" | "updated" | "unchanged" | "removed" | "absent";

export function skillState(file: string, wanted: string): SkillChange {
  if (!fs.existsSync(file)) return "added";
  return fs.readFileSync(file, "utf8") === wanted ? "unchanged" : "updated";
}

export function writeSkill(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/**
 * Remove the skill and the directory we created for it, but never a directory
 * somebody put other files in.
 */
export function removeSkill(file: string): SkillChange {
  if (!fs.existsSync(file)) return "absent";
  fs.rmSync(file);
  const dir = path.dirname(file);
  if (path.basename(dir) === SKILL_NAME && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  return "removed";
}
