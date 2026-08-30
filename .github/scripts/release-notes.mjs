/**
 * Build the release note for a version out of CHANGELOG.md.
 *
 * The changelog already tells the story in more detail than a hand-written
 * release note would, and keeping two prose accounts of the same release is
 * how they start disagreeing. So the release quotes the changelog and adds
 * only the one thing the changelog cannot know: the URL of the tarball that
 * this particular run is about to attach.
 *
 * Usage: node .github/scripts/release-notes.mjs <version> <repo> <tag> > notes.md
 */
import fs from "node:fs";

const [version, repo, tag] = process.argv.slice(2);
if (!version || !repo || !tag) {
  console.error("usage: release-notes.mjs <version> <repo> <tag>");
  process.exit(2);
}

const lines = fs.readFileSync("CHANGELOG.md", "utf8").split("\n");
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no [${version}] section`);
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => l.startsWith("## ["));
// Sections are separated by a rule in the changelog, which would collide with
// the one this script puts in front of the install instructions.
const body = (end === -1 ? rest : rest.slice(0, end))
  .join("\n")
  .trim()
  .replace(/\n*-{3,}$/, "")
  .trim();

if (body === "") {
  console.error(`[${version}] section is empty`);
  process.exit(1);
}

const tarball = `https://github.com/${repo}/releases/download/${tag}/centered-agent-memory-${version}.tgz`;

process.stdout.write(
  `${body}

---

## Install

\`\`\`bash
npm install -g ${tarball}
cam install
\`\`\`

Node 24 or newer is required. \`cam install\` registers the MCP server with every agent tool it finds and sets up scheduled refresh — preview with \`--dry-run\` first.
`
);
