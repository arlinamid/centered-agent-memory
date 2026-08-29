/**
 * Command-line argument parsing.
 *
 * A flag either takes a value or it does not, and the parser has to know which
 * *before* it sees the next token — otherwise `cam recall --json "kérdés"`
 * hands the question to `--json` and the command sees no positional at all.
 * Every command therefore declares its own flags; an unknown one is an error,
 * not a silently ignored typo.
 */

export interface FlagSpec {
  /** Flags that stand alone: `--json`. */
  bools?: ReadonlyArray<string>;
  /** Flags that consume the next token, or take it after `=`. */
  values?: ReadonlyArray<string>;
}

export interface ParsedArgs {
  positional: string[];
  bools: Set<string>;
  values: Map<string, string>;
  errors: string[];
}

export function parseArgs(argv: ReadonlyArray<string>, spec: FlagSpec): ParsedArgs {
  const bools = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const errors: string[] = [];
  const knownBool = new Set(spec.bools ?? []);
  const knownValue = new Set(spec.values ?? []);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    // Everything after a bare `--` is positional, so a question may start with
    // a dash.
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inlineValue = eq === -1 ? null : token.slice(eq + 1);

    if (knownBool.has(name)) {
      if (inlineValue !== null) errors.push(`a --${name} kapcsoló nem vár értéket`);
      else bools.add(name);
      continue;
    }
    if (knownValue.has(name)) {
      if (inlineValue !== null) {
        values.set(name, inlineValue);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next === "--" || next.startsWith("--")) {
        errors.push(`a --${name} kapcsoló értéket vár`);
        continue;
      }
      values.set(name, next);
      i++;
      continue;
    }
    errors.push(`ismeretlen kapcsoló: --${name}`);
  }

  return { positional, bools, values, errors };
}

export const has = (a: ParsedArgs, name: string): boolean => a.bools.has(name);

export const flag = (a: ParsedArgs, name: string): string | undefined => a.values.get(name);

/**
 * A limit is a positive integer or it is a mistake. Reporting it beats
 * silently falling back to the default, which is how `--limit` went unnoticed
 * in three commands.
 */
export function limit(a: ParsedArgs, fallback: number, max = 1000): number {
  const raw = a.values.get("limit");
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    a.errors.push(`a --limit pozitív egész szám kell legyen, nem "${raw}"`);
    return fallback;
  }
  return Math.min(n, max);
}

/** ISO date or anything Date.parse understands; an unparsable one is an error. */
export function dateFlag(a: ParsedArgs, name: string): number | null {
  const raw = a.values.get(name);
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    a.errors.push(`a --${name} nem értelmezhető dátum: "${raw}"`);
    return null;
  }
  return ms;
}
