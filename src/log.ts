/**
 * Output levels.
 *
 * The distinction that matters is not "how much" but "what for". An answer —
 * a search result, a JSON document, a dossier — is what the command was run to
 * produce, and `--quiet` must never swallow it; a scripted `cam recall --json
 * --quiet` that printed nothing would be a trap. Progress reports and
 * reassurance are what `--quiet` is for, and a scheduled sync wants exactly
 * that: silence unless something went wrong.
 *
 * Errors go to stderr at every level, because the exit code alone does not say
 * what broke.
 */

export type LogLevel = "quiet" | "normal" | "verbose";

let level: LogLevel = "normal";

export const setLogLevel = (l: LogLevel): void => {
  level = l;
};

export const getLogLevel = (): LogLevel => level;

/** The answer. Always printed, on stdout — this is the command's product. */
export const result = (msg: string): void => {
  console.log(msg);
};

/** Progress and totals. Suppressed by `--quiet`. */
export const status = (msg: string): void => {
  if (level !== "quiet") console.log(msg);
};

/** Detail nobody needs unless they are debugging. Only with `--verbose`. */
export const detail = (msg: string): void => {
  if (level === "verbose") console.log(msg);
};

/** A problem that did not stop the run. Suppressed by `--quiet`. */
export const warn = (msg: string): void => {
  if (level !== "quiet") console.error(`  ! ${msg}`);
};

/** A failure. Always printed, on stderr, whatever the level. */
export const fail = (msg: string): void => {
  console.error(msg);
};
