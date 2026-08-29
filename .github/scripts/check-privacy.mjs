/**
 * Fail if the repository carries a trace of the machine it was written on.
 *
 * The temptation is to grep for the author's username and project names, but
 * that list would have to live in a public file, which publishes the very
 * strings it exists to keep out. So the rules below are structural: they
 * describe the shape of an acceptable example instead of naming the
 * unacceptable ones, and they stay correct for any future contributor.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Home directories may only belong to these. They are all obviously invented,
 * which is the point: an example username should read as a placeholder at a
 * glance, so nobody has to wonder whether it was somebody's real account.
 * A single letter counts too — nobody's account is named `d` — and so does an
 * elision, which is prose leaving the name out rather than giving one.
 */
const PLACEHOLDERS = new Set(["me", "dev", "test", "user", "runner", "someone"]);

const isPlaceholder = (name) =>
  PLACEHOLDERS.has(name.toLowerCase()) || /^[a-z]$/i.test(name) || /^(?:\.{3}|…)$/.test(name);

const HOME = /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/)([A-Za-z0-9._-]+|…)/g;

/** Data belongs in a user data directory, never in the repository. */
const NEVER_COMMITTED = /(?:^|\/)(?:\.data\/|.*\.sqlite(?:-wal|-shm)?$|.*\.jsonl$|.*\.vscdb$)/;

const SKIP = /^(?:package-lock\.json|\.github\/scripts\/check-privacy\.mjs)$/;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
const problems = [];

for (const file of files) {
  if (NEVER_COMMITTED.test(file)) {
    problems.push(`${file}: adatfájl nem való a repóba`);
    continue;
  }
  if (SKIP.test(file)) continue;

  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    for (const match of line.matchAll(HOME)) {
      const name = match[1];
      if (!isPlaceholder(name)) {
        problems.push(
          `${file}:${i + 1}: "${name}" nem helyőrző felhasználónév\n      ${line.trim()}`
        );
      }
    }
  });
}

if (problems.length > 0) {
  console.error("Gépspecifikus nyom a repóban:\n");
  for (const p of problems) console.error("  " + p);
  console.error(
    `\nHelyőrzőnek ez fogadható el: ${[...PLACEHOLDERS].join(", ")}, vagy egyetlen betű.` +
      "\nHa valódi útvonalat kellene mutatni, írd körül helyette."
  );
  process.exit(1);
}

console.log(`${files.length} fájl átnézve, gépspecifikus nyom nincs benne.`);
