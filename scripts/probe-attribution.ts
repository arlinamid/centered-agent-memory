import fs from "node:fs";
import path from "node:path";
import { ProjectResolver } from "../src/attribution/projkey.js";
import { detectWorkspaceRoots } from "../src/attribution/roots.js";
import { defaultRoots } from "../src/paths.js";
import { excludedPrefixes } from "../src/config.js";

const roots = defaultRoots();
console.log("platform:", process.platform);
for (const [k, v] of Object.entries(roots)) {
  console.log(`  ${k.padEnd(16)} ${fs.existsSync(v) ? "OK " : "-- "} ${v}`);
}

// distinct cwd values straight from the real Claude Code transcripts
const cwds = new Set<string>();
for (const slug of fs.readdirSync(roots.claudeProjects)) {
  const dir = path.join(roots.claudeProjects, slug);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const head = fs.readFileSync(path.join(dir, f), "utf8").split("\n").slice(0, 40);
    for (const line of head) {
      try {
        const j = JSON.parse(line) as { cwd?: string };
        if (j.cwd) {
          cwds.add(j.cwd);
          break;
        }
      } catch {
        /* skip */
      }
    }
    break;
  }
}

const detected = detectWorkspaceRoots(cwds);
console.log("\nkorpuszból tanult workspace gyökerek:");
for (const d of detected) console.log(`  ${String(d.children).padStart(3)} gyerek  ${d.root}`);

const r = new ProjectResolver({
  excluded: excludedPrefixes(),
  workspaceRoots: detected.map((d) => d.root),
});

console.log("\nvalódi cwd -> projekt:");
let ok = 0;
for (const c of [...cwds].sort()) {
  const got = r.resolve(c);
  if (got) ok++;
  console.log(`  ${(got?.key ?? "—").padEnd(26)} ${(got?.via ?? "").padEnd(15)} ${c}`);
}
console.log(`\nlefedettség: ${ok}/${cwds.size}`);
