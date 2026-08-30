/**
 * The version has to appear in every place a reader or a client looks.
 * If one of them is missing or disagrees, the commit must not go out.
 *
 * Usage: node .github/scripts/check-version.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION_MARK = (version) => `cam-v${version}`;

export function requiredSurfaces(version) {
  return [
    {
      file: "package.json",
      ok: (text) => JSON.parse(text).version === version,
      missing: `package.json version is not ${version}`,
    },
    {
      file: "package-lock.json",
      ok: (text) => {
        const lock = JSON.parse(text);
        return lock.version === version && lock.packages?.[""]?.version === version;
      },
      missing: `package-lock.json root version is not ${version}`,
    },
    {
      file: "src/mcp/server.ts",
      ok: (text) => text.includes(`export const SERVER_VERSION = "${version}"`),
      missing: `SERVER_VERSION is not ${version}`,
    },
    {
      file: "CHANGELOG.md",
      ok: (text) => text.split("\n").some((line) => line.startsWith(`## [${version}]`)),
      missing: `CHANGELOG.md has no [${version}] section`,
    },
    {
      file: "README.md",
      ok: (text) => text.includes(VERSION_MARK(version)),
      missing: `README.md has no ${VERSION_MARK(version)} badge`,
    },
    {
      file: "README.hu.md",
      ok: (text) => text.includes(VERSION_MARK(version)),
      missing: `README.hu.md has no ${VERSION_MARK(version)} badge`,
    },
  ];
}

export function checkVersion(cwd, version) {
  return requiredSurfaces(version)
    .map((s) => {
      const full = path.join(cwd, s.file);
      if (!fs.existsSync(full)) return `${s.file}: file missing`;
      return s.ok(fs.readFileSync(full, "utf8")) ? null : `${s.file}: ${s.missing}`;
    })
    .filter(Boolean);
}

function main() {
  const cwd = process.cwd();
  const version = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version;
  const problems = checkVersion(cwd, version);
  if (problems.length > 0) {
    console.error(`version ${version} is incomplete:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`version ${version} present in package, lockfile, server, changelog, README.md, README.hu.md`);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main();
