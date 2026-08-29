import type { Db } from "../db/open.js";

/**
 * Absolute Windows paths and file URIs as they appear inside conversation
 * payloads. Deliberately conservative: a false path costs a wrong project.
 */
const WIN_PATH = /[a-zA-Z]:(?:\\\\|\\|\/){1,2}[\w\-. ()]{1,40}(?:(?:\\\\|\\|\/){1,2}[\w\-. ()]{1,40}){0,6}/g;

/**
 * Where a POSIX absolute path is allowed to start. An allowlist, because
 * `/etc/passwd` in a message is not a project and a bare `/x/y` is more often
 * a fraction than a path. Extend it rather than loosening the shape.
 */
const POSIX_ROOTS = ["home", "Users", "users", "srv", "opt", "workspace", "workspaces", "mnt", "media", "data", "projects", "repos", "code", "work"];
const POSIX_ROOT_ALT = POSIX_ROOTS.join("|");

/** `file:///D%3A/…` on Windows, `file:///home/…` everywhere else. */
const FILE_URI = new RegExp(
  String.raw`file:\/\/\/(?:[a-zA-Z](?:%3A|%3a|:)\/[\w\-.%/ ()]{3,160}|(?:${POSIX_ROOT_ALT})\/[\w\-.%/ ()]{1,160})`,
  "g",
);

const POSIX_PATH = new RegExp(
  String.raw`(?:^|[\s"'(])(\/(?:${POSIX_ROOT_ALT})\/[\w\-. ]{1,40}(?:\/[\w\-. ]{1,40}){0,6})`,
  "g",
);

/**
 * Path names may contain spaces ("Program Files"), so a greedy match can run
 * past the end of the path and swallow the next word: `D:\ras\x.ts D:\other`
 * yields `D:\ras\x.ts D`. Drop a trailing word when the token before it already
 * looks like a filename — that combination is never a real directory name.
 */
function trimSwallowedWord(p: string): string {
  const sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const last = p.slice(sep + 1);
  const space = last.lastIndexOf(" ");
  if (space <= 0) return p;
  const before = last.slice(0, space);
  const after = last.slice(space + 1);
  if (before.includes(".") && !after.includes(".")) return p.slice(0, sep + 1 + space);
  return p;
}

export function extractPaths(text: string, limit = 400): string[] {
  const out: string[] = [];
  const push = (v: string): void => {
    if (out.length < limit) out.push(v);
  };
  for (const m of text.matchAll(WIN_PATH)) push(trimSwallowedWord(m[0]));
  for (const m of text.matchAll(FILE_URI)) push(m[0]);
  for (const m of text.matchAll(POSIX_PATH)) if (m[1]) push(m[1]);
  return out;
}

/**
 * Replace one origin's evidence for a session. Evidence is expensive to gather
 * (it needs the source stores) and cheap to re-judge, which is what makes
 * `cam reattribute` a sub-second operation.
 */
export function replaceEvidence(
  db: Db,
  sessionId: number,
  origin: string,
  rawPaths: Iterable<string>,
  weight = 1,
): number {
  const ins = db.prepare(
    "insert into path_evidence(session_id, origin, raw_path, project_key, weight) values (?,?,?,null,?)",
  );
  // Repeats inside one conversation are not independent votes; a path counts
  // once per origin, and the weight expresses how much that origin is trusted.
  //
  // Deduplication looks at the leading segments only. Path names may contain
  // spaces ("Program Files"), so a match can run past the real end of the path
  // and pick up the next word — which would otherwise let one mention vote
  // twice. Only the leading segments decide the project anyway.
  const seen = new Set<string>();
  // Delete and refill in one transaction: a query arriving in between must not
  // see this session with its evidence gone.
  const tx = db.transaction(() => {
    db.prepare("delete from path_evidence where session_id = ? and origin = ?").run(sessionId, origin);
    for (const p of rawPaths) {
      const key = dedupeKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      ins.run(sessionId, origin, p, weight);
    }
  });
  tx();
  return seen.size;
}

const DEDUPE_SEGMENTS = 4;

function dedupeKey(rawPath: string): string {
  return rawPath
    .toLowerCase()
    .replace(/\\{1,2}/g, "/")
    .split("/")
    .filter(Boolean)
    .slice(0, DEDUPE_SEGMENTS)
    .join("/");
}
