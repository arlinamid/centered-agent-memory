import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_NAME, type ClientTarget } from "./clients.js";

/**
 * One skill body, rendered per client.
 *
 * The instructions an agent needs are the same everywhere — what the index is,
 * when to consult it, how to read a confidence level — and only the last
 * section differs: whether the tool is reachable as MCP tools alone or from a
 * terminal too. Writing four skills by hand would guarantee that three of them
 * fall behind, which is the same reason the CLI and the MCP server share a
 * renderer.
 */

const DESCRIPTION =
  "Korábbi beszélgetések előhívása a felhasználó másik AI-eszközeiből (Claude Code, Claude Desktop, " +
  "Codex, Cursor). Használd, mielőtt egy projekt előzményeiről kérdeznél vagy feltételeznél valamit, " +
  "és akkor, ha a felhasználó egy korábbi döntésre, megbeszélésre vagy megoldásra hivatkozik: " +
  "„ahogy megbeszéltük”, „a múltkori”, „amit a Codexszel csináltunk”.";

/** Package root, from either `src/install/` or `dist/install/`. */
function assetFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "skill-body.md");
}

export function skillBody(): string {
  return fs.readFileSync(assetFile(), "utf8");
}

export function renderSkill(target: ClientTarget, body = skillBody()): string {
  const frontmatter = ["---", `name: ${SKILL_NAME}`, `description: >-`, ...wrap(DESCRIPTION, 92), "---", ""];
  return `${frontmatter.join("\n")}${body.replace("{{SURFACE}}", target.surface).trimEnd()}\n`;
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
