import { CASE_INSENSITIVE_FS } from "../paths.js";
import type { Db } from "./open.js";

/**
 * The failure this exists to prevent is a silent one.
 *
 * Paths are stored case-folded on Windows and macOS and verbatim on Linux (see
 * `paths.ts`). An index written on one and opened on the other therefore
 * matches nothing: no error, no warning, just empty results and a project list
 * that lost most of its entries. Copying the file between machines is exactly
 * what `cam backup` invites, so the index says which convention it was written
 * with, and `cam doctor` compares that with the running platform.
 *
 * Only raw SQL here, and a type-only import of `Db`: `open.ts` calls into this
 * from `initSchema`, and a value import would close the cycle.
 */

export const CASE_FOLD_KEY = "path_case_fold";
export const PLATFORM_KEY = "written_on";

const read = (db: Db, key: string): string | null =>
  ((db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value ?? null);

/**
 * Record how this index spells its paths, once. Never overwritten: the stamp
 * describes the data already stored, not the machine that opened it last.
 */
export function stampPlatform(db: Db): void {
  const write = db.prepare("insert or ignore into meta(key, value) values (?, ?)");
  write.run(CASE_FOLD_KEY, CASE_INSENSITIVE_FS ? "1" : "0");
  write.run(PLATFORM_KEY, process.platform);
}

export interface Portability {
  /** False for an index written before the stamp existed. */
  stamped: boolean;
  wroteOn: string | null;
  caseFold: boolean | null;
  /** The stored paths cannot be matched by this platform's rules. */
  mismatch: boolean;
  message: string | null;
}

export function checkPortability(db: Db): Portability {
  const stamp = read(db, CASE_FOLD_KEY);
  const wroteOn = read(db, PLATFORM_KEY);
  if (stamp === null) return { stamped: false, wroteOn, caseFold: null, mismatch: false, message: null };

  const caseFold = stamp === "1";
  const mismatch = caseFold !== CASE_INSENSITIVE_FS;
  const spelling = (fold: boolean): string => (fold ? "kisbetűsítve" : "betűhelyesen");
  return {
    stamped: true,
    wroteOn,
    caseFold,
    mismatch,
    message: mismatch
      ? `az index ${wroteOn ?? "másik rendszeren"} készült, ahol az útvonalak ${spelling(caseFold)} vannak tárolva, ` +
        `itt viszont ${spelling(CASE_INSENSITIVE_FS)} keresnénk — a projekt-hozzárendelés némán üres maradna. ` +
        `Állítsd be: CAM_CASE_FOLD=${stamp}`
      : null,
  };
}
