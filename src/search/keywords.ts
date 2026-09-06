import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface StopwordMap {
  [lang: string]: string[] | undefined;
}

let cached: Set<string> | null = null;

/**
 * Hungarian and English stopwords plus a few words that carry no meaning in
 * this corpus specifically ("session", "project" appear in nearly every
 * conversation, so matching them ranks noise).
 */
function stopwords(): Set<string> {
  if (cached) return cached;
  const set = new Set<string>();
  try {
    const iso = require("stopwords-iso/stopwords-iso.json") as StopwordMap;
    for (const lang of ["hu", "en"]) for (const w of iso[lang] ?? []) set.add(w);
  } catch {
    // The package is optional at runtime; the domain list below still applies.
  }
  for (const w of ["session", "project", "projekt", "agent", "chat", "kód", "code", "file", "fájl"]) set.add(w);
  cached = set;
  return set;
}

/** Keep short technical identifiers such as UI, DB and Go. */
const MIN_TOKEN = 2;
/** Hungarian is agglutinative and there is no stemmer, so long tokens match by prefix. */
const PREFIX_FROM = 5;

const DATE_WORDS: Record<string, number> = {
  ma: 0,
  today: 0,
  tegnap: 1,
  yesterday: 1,
  tegnapelőtt: 2,
};

export interface ParsedQuery {
  /** FTS5 MATCH expression. */
  match: string;
  /** Tokens for the local highlighter. */
  terms: string[];
  /** Day boundary implied by a date word, if any. */
  sinceMs: number | null;
}

function tokenize(text: string, locale = "hu"): string[] {
  const seg = new Intl.Segmenter(locale, { granularity: "word" });
  const out: string[] = [];
  for (const s of seg.segment(text)) {
    if (!s.isWordLike) continue;
    const w = s.segment.toLowerCase();
    if (w.length > 0) out.push(w);
  }
  return out.length > 0 ? out : text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Escape a term for an FTS5 MATCH expression. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export function parseQuery(raw: string, nowMs = Date.now()): ParsedQuery {
  const words = tokenize(raw);
  const stop = stopwords();
  const terms: string[] = [];
  let sinceMs: number | null = null;

  for (const w of words) {
    const days = DATE_WORDS[w];
    if (days !== undefined) {
      const d = new Date(nowMs - days * 86_400_000);
      d.setHours(0, 0, 0, 0);
      sinceMs = d.getTime();
      continue;
    }
    if (stop.has(w)) continue;
    if (w.length < 2) continue;
    terms.push(w);
  }

  // A query made only of stopwords still has to search for something.
  if (terms.length === 0) {
    for (const w of words) if (w.length >= 2 && DATE_WORDS[w] === undefined) terms.push(w);
  }

  const unique = [...new Set(terms)];
  const match = unique
    .map((t) => (t.length >= PREFIX_FROM ? `${quote(t)}*` : quote(t)))
    .join(" OR ");

  return { match, terms: unique, sinceMs };
}

/** Corpus-independent lexical evidence; an FTS rank is not a probability. */
export function termCoverage(text: string, terms: ReadonlyArray<string>): number {
  if (!terms.length) return 0;
  const words = fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(terms.map(fold))];
  return unique.filter((term) => {
    // Intl.Segmenter can keep identifiers such as node_modules together;
    // unicode61 treats their separators as token boundaries within a phrase.
    const parts = term.match(/[\p{L}\p{N}]+/gu) ?? [];
    return parts.length > 0 && words.some((_, index) => parts.every((part, offset) => {
      const word = words[index + offset] ?? "";
      return offset === parts.length - 1 && term.length >= PREFIX_FROM ? word.startsWith(part) : word === part;
    }));
  }).length / unique.length;
}

/**
 * Mark query terms in a rehydrated snippet. FTS5's own `snippet()` returns NULL
 * on a contentless table, so highlighting happens here, on text read back from
 * the source.
 */
export function highlight(text: string, terms: ReadonlyArray<string>, open = "«", close = "»"): string {
  if (terms.length === 0) return text;
  const folded = fold(text);
  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    const needle = fold(term);
    if (needle.length < MIN_TOKEN) continue;
    let i = folded.indexOf(needle);
    while (i !== -1) {
      const wordChar = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);
      if ((i > 0 && wordChar(folded[i - 1]!)) ||
          (needle.length < PREFIX_FROM && wordChar(folded[i + needle.length] ?? ""))) {
        i = folded.indexOf(needle, i + needle.length);
        continue;
      }
      // Prefix match: extend to the end of the word, as the index does.
      let end = i + needle.length;
      while (needle.length >= PREFIX_FROM && end < folded.length && wordChar(folded[end]!)) end++;
      marks.push([i, end]);
      i = folded.indexOf(needle, end);
    }
  }
  if (marks.length === 0) return text;

  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m]);
  }

  let out = "";
  let pos = 0;
  for (const [s, e] of merged) {
    out += text.slice(pos, s) + open + text.slice(s, e) + close;
    pos = e;
  }
  return out + text.slice(pos);
}

/**
 * Accent-insensitive comparison that matches the index's `remove_diacritics 2`
 * — and preserves length, one output character per input character.
 *
 * Folding the whole string with NFD would shorten it (é becomes e + combining
 * mark, then the mark is dropped), so every offset found in the folded text
 * would be wrong by the number of accents before it, and highlights would drift
 * mid-word. Hungarian text is full of accents, so this matters everywhere.
 */
function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const stripped = ch.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    out += (stripped.length > 0 ? stripped[0]! : ch).toLowerCase();
  }
  return out;
}

/** Cut a window around the first highlighted position. */
export function excerpt(text: string, terms: ReadonlyArray<string>, width = 320): string {
  const folded = fold(text);
  let at = -1;
  for (const t of terms) {
    const i = folded.indexOf(fold(t));
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return text.length > width ? text.slice(0, width) + "…" : text;

  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
