/**
 * Write the committed renderings of the skill: the one `npx skills add` finds
 * and the Claude Desktop plugin's. Run after changing the skill body, a
 * surface, or the version — the test suite compares these files with a fresh
 * rendering and fails on drift.
 *
 *   npm run skills
 */
import fs from "node:fs";
import path from "node:path";
import { publishedFiles } from "../src/install/plugin.js";

for (const [rel, text] of Object.entries(publishedFiles())) {
  const file = path.join(process.cwd(), ...rel.split("/"));
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (before === text) {
    console.log(`unchanged  ${rel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  console.log(`${before === null ? "written  " : "updated  "}  ${rel}`);
}
