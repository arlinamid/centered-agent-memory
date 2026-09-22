import type { EvidenceRow, MemoryFact, Topic } from "../memory/facts.js";
import type { Dossier, TimelineEntry } from "./dossier.js";
import type { RecallHit, TurnText } from "./recall.js";

/**
 * One renderer for both surfaces. The CLI and the MCP server call these same
 * functions, so what an agent reads and what the terminal prints cannot drift
 * apart.
 */

export const day = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toISOString().slice(0, 10) : "?";

export const minute = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?";

const CONF_MARK: Record<string, string> = {
  strong: "",
  medium: " ~",
  weak: " ?",
  none: " ??",
};

export function formatRecall(hits: ReadonlyArray<RecallHit>, query: string): string {
  if (hits.length === 0) return `No hits: ${query}`;
  const lines: string[] = [];
  for (const h of hits) {
    const flag = h.availability === "ok" ? "" : ` [${h.availability === "missing" ? "source missing" : "source changed"}]`;
    lines.push(
      `${minute(h.tsMs)}  ${h.tool}  ${h.project ?? "—"}${CONF_MARK[h.confidence] ?? ""}${flag}` +
        `${h.sessionTitle ? `  · ${h.sessionTitle}` : ""}`,
    );
    lines.push(`  ${h.snippet.replace(/\s+/g, " ")}`);
    lines.push(`  ${h.citation}`);
    lines.push("");
  }
  lines.push(`${hits.length} hit(s). Marks: ~ medium, ? weak, ?? unattributed project.`);
  return lines.join("\n");
}

/**
 * A session, or the slice of it a citation points at. The availability of each
 * turn is on the turn itself: a session read back weeks later can be partly
 * rehydrated and partly gone, and averaging that into one verdict would hide
 * exactly the turn that is missing.
 */
export function formatTurns(turns: ReadonlyArray<TurnText>): string {
  return turns
    .map((t) => `[${t.seq}] ${t.role}${t.availability === "ok" ? "" : ` (${t.availability})`}: ${t.text}`)
    .join("\n\n");
}

export function formatTimeline(entries: ReadonlyArray<TimelineEntry>, project: string): string {
  if (entries.length === 0) return `No indexed sessions: ${project}`;
  const lines = entries.map((e) => {
    const title = (e.title ?? "").replace(/\s+/g, " ").slice(0, 54);
    const sub = e.role === "subagent" ? `  ↳${e.agentRole ?? "subagent"}` : "";
    return (
      `${minute(e.startedMs)}  ${e.tool.padEnd(14)} ${String(e.turns).padStart(5)}t  ` +
      `${title.padEnd(54)} [${e.method ?? "-"}/${e.confidence}]${sub}`
    );
  });
  lines.push("");
  lines.push(`${entries.length} session(s) — ${project}`);
  return lines.join("\n");
}

export function formatDossier(d: Dossier): string {
  const L: string[] = [];
  L.push(`# ${d.project}${d.rootPath ? `  (${d.rootPath})` : ""}`);
  L.push("");
  L.push(`${d.totals.sessions} session · ${d.totals.turns} turn · ${d.totals.subagents} subagent thread(s)`);
  L.push("");

  L.push("## Tools");
  for (const t of d.byTool) {
    L.push(
      `  ${t.tool.padEnd(15)} ${String(t.sessions).padStart(4)} session ${String(t.turns).padStart(7)} turn` +
        `  ${day(t.firstMs)} → ${day(t.lastMs)}`,
    );
  }

  L.push("");
  L.push("## Attribution");
  const conf = Object.entries(d.attribution)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
  L.push(`  ${conf || "—"}`);

  const nonOk = Object.entries(d.availability).filter(([k]) => k !== "ok");
  if (nonOk.length > 0) {
    L.push("");
    L.push("## Source state");
    for (const [k, v] of nonOk) L.push(`  ${k}: ${v} turn`);
  }

  if (d.artifacts.length > 0) {
    L.push("");
    L.push("## Artifacts");
    for (const a of d.artifacts) {
      L.push(`  ${a.kind.padEnd(18)} ${String(a.count).padStart(5)} file(s)  ${(a.bytes / 2 ** 20).toFixed(1)} MB`);
    }
  }

  if (d.fileEvents.count > 0) {
    L.push("");
    L.push(
      `## File edits\n  ${d.fileEvents.count} saved version(s)  ${day(d.fileEvents.firstMs)} → ${day(d.fileEvents.lastMs)}`,
    );
  }

  if (d.topSessions.length > 0) {
    L.push("");
    L.push("## Largest sessions");
    for (const s of d.topSessions) {
      L.push(`  ${String(s.turns).padStart(5)}t  ${s.tool.padEnd(14)} ${minute(s.startedMs)}  ${s.title ?? ""}`);
    }
  }

  if (d.recentTitles.length > 0) {
    L.push("");
    L.push("## Recent topics");
    for (const t of d.recentTitles) L.push(`  ${day(t.whenMs)}  ${t.tool.padEnd(14)} ${t.title}`);
  }

  return L.join("\n");
}

/** One promoted memory per block: what it is, and what earned the promotion. */
export function formatMemory(facts: ReadonlyArray<MemoryFact>): string {
  if (facts.length === 0) {
    return "No promoted memories. That is not a failure: promotion needs at least 3 recalls across 3 different queries.\nRun: cam memory consolidate";
  }
  const L: string[] = [];
  for (const f of facts) {
    const flag = f.availability === "ok" || f.availability === "unknown" ? "" : ` [${f.availability}]`;
    L.push(
      `#${f.id}  ${f.score.toFixed(3)}  ${f.project ?? "—"}  ${f.tool}` +
        `  ${f.recalls}× / ${f.queries} queries / ${f.days} days  ${day(f.firstMs)} → ${day(f.lastMs)}${flag}`,
    );
    // The dream's sentence when there is one, the raw excerpt otherwise. The
    // model is named, so nobody mistakes generated text for the source.
    if (f.digest) L.push(`  ~ ${f.digest.replace(/\s+/g, " ")}  [${f.digestModel ?? "model"}]`);
    else if (f.text) L.push(`  ${f.text.replace(/\s+/g, " ").slice(0, 200)}`);
    L.push(`  ${f.citation}`);
    L.push("");
  }
  L.push(`${facts.length} memor${facts.length === 1 ? "y" : "ies"}.`);
  return L.join("\n");
}

/** A single memory with the evidence behind it: when, and to which questions. */
export function formatMemoryFact(fact: MemoryFact, evidence: ReadonlyArray<EvidenceRow>): string {
  const L: string[] = [];
  L.push(`# memory #${fact.id}  score ${fact.score.toFixed(3)}`);
  L.push("");
  L.push(`project      ${fact.project ?? "—"}`);
  L.push(`source       ${fact.tool}  ${fact.sessionTitle ?? fact.sessionExtId}`);
  L.push(`citation     ${fact.citation}`);
  L.push(`promoted     since ${day(fact.promotedMs)}  ·  ${fact.chars} characters`);
  L.push(`source state ${fact.availability}`);
  L.push("");
  L.push("## Score components");
  for (const [k, v] of Object.entries(fact.components)) {
    L.push(`  ${k.padEnd(15)} ${v.toFixed(3)}`);
  }
  L.push("");
  L.push(`## Evidence — ${fact.recalls} recall(s), ${fact.queries} distinct queries, ${fact.days} separate day(s)`);
  for (const e of evidence) {
    L.push(`  ${day(e.firstMs)} → ${day(e.lastMs)}  ${String(e.hits).padStart(3)}×  ${e.query ?? `(hash only: ${e.queryHash})`}`);
  }
  if (fact.digest) {
    L.push("");
    L.push(`## Dream — written by ${fact.digestModel ?? "a model"}, not the source`);
    L.push(fact.digest);
  }
  L.push("");
  L.push("## Text");
  L.push(fact.text || "(source unreadable)");
  return L.join("\n");
}

export function formatTopics(topics: ReadonlyArray<Topic>): string {
  if (topics.length === 0) return "No recurring topics. Consolidation waits for at least two different queries on the same term.";
  const L = topics.map(
    (t) =>
      `  ${t.term.padEnd(24)} ${String(t.queries).padStart(3)} queries  ${String(t.chunks).padStart(4)} hits` +
      `  ${String(t.days).padStart(3)} days  last: ${day(t.lastMs)}`,
  );
  L.push("");
  L.push(`${topics.length} recurring topic(s).`);
  return L.join("\n");
}
