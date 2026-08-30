/**
 * Every commit that reaches main becomes a version. A fix does not sit on
 * `main` under yesterday's number.
 *
 * `package.json` is the version. If it already names a version GitHub has not
 * released, that number is tagged (the human started the bump). If it still
 * names a released version and HEAD is ahead of that tag, this script bumps
 * the patch — or the minor, when `[Unreleased]` contains a breaking note —
 * writes the lockfile, `SERVER_VERSION` and the changelog section, commits,
 * and tags. The Release workflow then installs the tarball on three platforms.
 *
 * Usage: node .github/scripts/cut-release-tag.mjs [--dry-run]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION_MARK, checkVersion } from "./check-version.mjs";

export function unreleasedBody(changelog) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## [Unreleased]"));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## ["));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

export function bumpKind(changelog) {
  return /breaking change/i.test(unreleasedBody(changelog)) ? "minor" : "patch";
}

export function nextVersion(version, kind) {
  const [maj, min, pat] = version.split(".").map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function decide({ version, lockVersion, changelog, released, tagged, ahead }) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    return { action: "fail", reason: `package.json version is not semver: ${version}` };
  }
  if (lockVersion != null && lockVersion !== version) {
    return {
      action: "fail",
      reason: `package-lock.json version (${lockVersion}) != package.json (${version})`,
    };
  }
  if (tagged && !released) return { action: "skip", reason: `tag v${version} already exists` };
  if (!released) {
    if (!changelog.split("\n").some((line) => line.startsWith(`## [${version}]`))) {
      return { action: "fail", reason: `CHANGELOG.md has no [${version}] section — move [Unreleased] first` };
    }
    return { action: "tag", reason: `v${version} is new` };
  }
  if (!ahead) return { action: "skip", reason: `v${version} is released and HEAD is that tag` };
  const kind = bumpKind(changelog);
  const next = nextVersion(version, kind);
  return { action: "bump", reason: `v${version} is out; HEAD is ahead → ${kind} ${next}`, next, kind };
}

export function moveUnreleased(changelog, next, date) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## [Unreleased]"));
  if (start === -1) throw new Error("CHANGELOG.md has no [Unreleased] section");
  const rest = lines.slice(start + 1);
  const rel = rest.findIndex((l) => l.startsWith("## ["));
  const body = (rel === -1 ? rest : rest.slice(0, rel)).join("\n").trim();
  const tail = rel === -1 ? [] : lines.slice(start + 1 + rel);
  const section = [`## [${next}] — ${date}`, "", body || "Unreleased work since the previous version."];
  return [...lines.slice(0, start + 1), "", ...section, "", ...tail].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function setLockVersion(text, from, to) {
  let n = 0;
  const re = new RegExp(`("version":\\s*")${from.replace(/\./g, "\\.")}(")`, "g");
  return text.replace(re, (m, a, b) => {
    n += 1;
    return n <= 2 ? `${a}${to}${b}` : m;
  });
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

function released(tag) {
  try {
    execFileSync("gh", ["release", "view", tag], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function tagged(tag) {
  const remote = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  return remote.length > 0;
}

function aheadOf(tag) {
  try {
    git(["fetch", "origin", "--tags", "--force"]);
  } catch {
    /* offline tests never call this */
  }
  try {
    return Number(git(["rev-list", "--count", `${tag}..HEAD`])) > 0;
  } catch {
    return true;
  }
}

function lockVersion(lock) {
  return lock.version ?? lock.packages?.[""]?.version ?? null;
}

export function applyBump(cwd, from, to, date) {
  const pkgPath = path.join(cwd, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = to;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const lockPath = path.join(cwd, "package-lock.json");
  fs.writeFileSync(lockPath, setLockVersion(fs.readFileSync(lockPath, "utf8"), from, to));

  const serverPath = path.join(cwd, "src", "mcp", "server.ts");
  const server = fs.readFileSync(serverPath, "utf8");
  const next = server.replace(
    `export const SERVER_VERSION = "${from}"`,
    `export const SERVER_VERSION = "${to}"`,
  );
  if (next === server) throw new Error(`SERVER_VERSION ${from} not found in src/mcp/server.ts`);
  fs.writeFileSync(serverPath, next);

  const logPath = path.join(cwd, "CHANGELOG.md");
  fs.writeFileSync(logPath, moveUnreleased(fs.readFileSync(logPath, "utf8"), to, date));

  for (const readme of ["README.md", "README.hu.md"]) {
    const file = path.join(cwd, readme);
    const text = fs.readFileSync(file, "utf8");
    const next = text.replaceAll(VERSION_MARK(from), VERSION_MARK(to));
    if (next === text) throw new Error(`${readme} has no ${VERSION_MARK(from)} badge`);
    fs.writeFileSync(file, next);
  }

  const problems = checkVersion(cwd, to);
  if (problems.length > 0) throw new Error(`version ${to} is incomplete:\n  ${problems.join("\n  ")}`);
}

export function planFromDisk(cwd = process.cwd()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8"));
  const changelog = fs.readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8");
  const version = pkg.version;
  const tag = `v${version}`;
  const isReleased = released(tag);
  const isTagged = tagged(tag);
  return {
    version,
    tag,
    decision: decide({
      version,
      lockVersion: lockVersion(lock),
      changelog,
      released: isReleased,
      tagged: isTagged,
      ahead: isReleased || isTagged ? aheadOf(tag) : false,
    }),
  };
}

function identify() {
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
}

function pushTag(tag, sha) {
  identify();
  git(["tag", "-a", tag, sha, "-m", tag]);
  git(["push", "origin", tag]);
  console.log(`pushed ${tag} → ${sha}`);
}

function main() {
  const dry = process.argv.includes("--dry-run");
  const cwd = process.cwd();
  const { version, tag, decision } = planFromDisk(cwd);
  console.log(`${decision.action}: ${decision.reason}`);

  if (decision.action === "fail") process.exit(1);
  if (decision.action === "skip" || dry) return;

  if (decision.action === "tag") {
    const problems = checkVersion(cwd, version);
    if (problems.length > 0) {
      console.error(`version ${version} is incomplete:\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    const sha = process.env.CUT_SHA ?? git(["rev-parse", "HEAD"]);
    pushTag(tag, sha);
    return;
  }

  if (decision.action !== "bump") {
    throw new Error(`unhandled action: ${decision.action}`);
  }

  const next = decision.next;
  const date = new Date().toISOString().slice(0, 10);
  const sha = process.env.CUT_SHA ?? git(["rev-parse", "HEAD"]);
  git(["switch", "-C", "main", sha]);
  applyBump(cwd, version, next, date);
  identify();
  git([
    "add",
    "package.json",
    "package-lock.json",
    "src/mcp/server.ts",
    "CHANGELOG.md",
    "README.md",
    "README.hu.md",
  ]);
  git(["commit", "-m", `chore: release v${next}`]);
  git(["push", "origin", "HEAD:main"]);
  pushTag(`v${next}`, git(["rev-parse", "HEAD"]));
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main();
