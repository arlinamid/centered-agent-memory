/**
 * Promotion scoring. No model, no network, no randomness — the same trace gives
 * the same number on every machine and on every run.
 *
 * The idea the weights encode: a memory does not become long-term because it
 * looks important, but because it came back several times, on several days, to
 * several different questions.
 */

/** Bumped when the weights or the gates change, so a stored score stays readable. */
export const MEMORY_RULE_VERSION = 1;

export const WEIGHTS = {
  /** How well it actually matched, averaged over the recalls that surfaced it. */
  relevance: 0.3,
  /** How often it came back. */
  frequency: 0.24,
  /** How many different questions reached it. */
  diversity: 0.15,
  /** How recently it was last needed. */
  recency: 0.15,
  /** Over how many separate days it kept coming back. */
  consolidation: 0.1,
  /** How wide the vocabulary was that reached it. */
  conceptual: 0.06,
} as const;

export const GATES = {
  minRecalls: 3,
  minQueries: 3,
  minScore: 0.8,
} as const;

/** Half-life of the recency term. */
export const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Where each count is considered "as good as it gets". */
export const SATURATION = {
  frequency: 10,
  diversity: 5,
  consolidation: 3,
  conceptual: 8,
} as const;

export interface Trace {
  /** Number of recall events. */
  recalls: number;
  /** Distinct queries that surfaced it. */
  queries: number;
  /** Distinct days on which it was recalled. */
  days: number;
  /** Distinct query terms across those queries. */
  terms: number;
  /** Mean recall score, already normalized to 0..1. */
  avgScore: number;
  lastMs: number;
}

export interface ScoreComponents {
  relevance: number;
  frequency: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
}

export interface Scored {
  score: number;
  components: ScoreComponents;
}

/**
 * Diminishing returns: the tenth recall matters less than the second. Log so
 * that a single very active chunk cannot crowd out everything else.
 */
export function saturate(n: number, reference: number): number {
  if (reference <= 0) return 0;
  return Math.min(1, Math.log1p(Math.max(0, n)) / Math.log1p(reference));
}

/** Exponential decay with a 14-day half-life; never negative, never above 1. */
export function recency(lastMs: number, nowMs: number): number {
  const age = Math.max(0, nowMs - lastMs);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

const round = (n: number): number => Number(n.toFixed(4));

export function scoreTrace(t: Trace, nowMs: number): Scored {
  const components: ScoreComponents = {
    relevance: round(Math.min(1, Math.max(0, t.avgScore))),
    frequency: round(saturate(t.recalls, SATURATION.frequency)),
    diversity: round(saturate(t.queries, SATURATION.diversity)),
    recency: round(recency(t.lastMs, nowMs)),
    consolidation: round(saturate(t.days, SATURATION.consolidation)),
    conceptual: round(saturate(t.terms, SATURATION.conceptual)),
  };
  const score =
    components.relevance * WEIGHTS.relevance +
    components.frequency * WEIGHTS.frequency +
    components.diversity * WEIGHTS.diversity +
    components.recency * WEIGHTS.recency +
    components.consolidation * WEIGHTS.consolidation +
    components.conceptual * WEIGHTS.conceptual;
  return { score: round(score), components };
}

/**
 * The gates are a floor under the score, not a substitute for it: something
 * recalled twice by one question is not a memory however well it matched.
 */
export function passes(t: Trace, score: number, minScore: number = GATES.minScore): boolean {
  return t.recalls >= GATES.minRecalls && t.queries >= GATES.minQueries && score >= minScore;
}
