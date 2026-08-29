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
  if (hits.length === 0) return `Nincs találat: ${query}`;
  const lines: string[] = [];
  for (const h of hits) {
    const flag = h.availability === "ok" ? "" : ` [${h.availability === "missing" ? "forrás hiányzik" : "forrás módosult"}]`;
    lines.push(
      `${minute(h.tsMs)}  ${h.tool}  ${h.project ?? "—"}${CONF_MARK[h.confidence] ?? ""}${flag}` +
        `${h.sessionTitle ? `  · ${h.sessionTitle}` : ""}`,
    );
    lines.push(`  ${h.snippet.replace(/\s+/g, " ")}`);
    lines.push(`  ${h.citation}`);
    lines.push("");
  }
  lines.push(`${hits.length} találat. Jelölés: ~ közepes, ? gyenge, ?? besorolatlan projekt-hozzárendelés.`);
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
  if (entries.length === 0) return `Nincs indexelt session: ${project}`;
  const lines = entries.map((e) => {
    const title = (e.title ?? "").replace(/\s+/g, " ").slice(0, 54);
    const sub = e.role === "subagent" ? `  ↳${e.agentRole ?? "alügynök"}` : "";
    return (
      `${minute(e.startedMs)}  ${e.tool.padEnd(14)} ${String(e.turns).padStart(5)}t  ` +
      `${title.padEnd(54)} [${e.method ?? "-"}/${e.confidence}]${sub}`
    );
  });
  lines.push("");
  lines.push(`${entries.length} session — ${project}`);
  return lines.join("\n");
}

export function formatDossier(d: Dossier): string {
  const L: string[] = [];
  L.push(`# ${d.project}${d.rootPath ? `  (${d.rootPath})` : ""}`);
  L.push("");
  L.push(`${d.totals.sessions} session · ${d.totals.turns} turn · ${d.totals.subagents} alügynök-szál`);
  L.push("");

  L.push("## Eszközök");
  for (const t of d.byTool) {
    L.push(
      `  ${t.tool.padEnd(15)} ${String(t.sessions).padStart(4)} session ${String(t.turns).padStart(7)} turn` +
        `  ${day(t.firstMs)} → ${day(t.lastMs)}`,
    );
  }

  L.push("");
  L.push("## Projekt-hozzárendelés");
  const conf = Object.entries(d.attribution)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
  L.push(`  ${conf || "—"}`);

  const nonOk = Object.entries(d.availability).filter(([k]) => k !== "ok");
  if (nonOk.length > 0) {
    L.push("");
    L.push("## Forrás-állapot");
    for (const [k, v] of nonOk) L.push(`  ${k}: ${v} turn`);
  }

  if (d.artifacts.length > 0) {
    L.push("");
    L.push("## Melléktermékek");
    for (const a of d.artifacts) {
      L.push(`  ${a.kind.padEnd(18)} ${String(a.count).padStart(5)} fájl  ${(a.bytes / 2 ** 20).toFixed(1)} MB`);
    }
  }

  if (d.fileEvents.count > 0) {
    L.push("");
    L.push(
      `## Fájlszerkesztés\n  ${d.fileEvents.count} mentett verzió  ${day(d.fileEvents.firstMs)} → ${day(d.fileEvents.lastMs)}`,
    );
  }

  if (d.topSessions.length > 0) {
    L.push("");
    L.push("## Legnagyobb sessionök");
    for (const s of d.topSessions) {
      L.push(`  ${String(s.turns).padStart(5)}t  ${s.tool.padEnd(14)} ${minute(s.startedMs)}  ${s.title ?? ""}`);
    }
  }

  if (d.recentTitles.length > 0) {
    L.push("");
    L.push("## Legutóbbi témák");
    for (const t of d.recentTitles) L.push(`  ${day(t.whenMs)}  ${t.tool.padEnd(14)} ${t.title}`);
  }

  return L.join("\n");
}

/** One promoted memory per block: what it is, and what earned the promotion. */
export function formatMemory(facts: ReadonlyArray<MemoryFact>): string {
  if (facts.length === 0) {
    return "Nincs promotált emlék. Ez nem hiba: a promócióhoz legalább 3 előhívás kell, legalább 3 különböző kérdésre.\nFuttasd: cam memory consolidate";
  }
  const L: string[] = [];
  for (const f of facts) {
    const flag = f.availability === "ok" || f.availability === "unknown" ? "" : ` [${f.availability}]`;
    L.push(
      `#${f.id}  ${f.score.toFixed(3)}  ${f.project ?? "—"}  ${f.tool}` +
        `  ${f.recalls}× / ${f.queries} kérdés / ${f.days} nap  ${day(f.firstMs)} → ${day(f.lastMs)}${flag}`,
    );
    // The dream's sentence when there is one, the raw excerpt otherwise. The
    // model is named, so nobody mistakes generated text for the source.
    if (f.digest) L.push(`  ~ ${f.digest.replace(/\s+/g, " ")}  [${f.digestModel ?? "modell"}]`);
    else if (f.text) L.push(`  ${f.text.replace(/\s+/g, " ").slice(0, 200)}`);
    L.push(`  ${f.citation}`);
    L.push("");
  }
  L.push(`${facts.length} emlék.`);
  return L.join("\n");
}

/** A single memory with the evidence behind it: when, and to which questions. */
export function formatMemoryFact(fact: MemoryFact, evidence: ReadonlyArray<EvidenceRow>): string {
  const L: string[] = [];
  L.push(`# emlék #${fact.id}  pontszám ${fact.score.toFixed(3)}`);
  L.push("");
  L.push(`projekt      ${fact.project ?? "—"}`);
  L.push(`forrás       ${fact.tool}  ${fact.sessionTitle ?? fact.sessionExtId}`);
  L.push(`hivatkozás   ${fact.citation}`);
  L.push(`promotálva   ${day(fact.promotedMs)} óta  ·  ${fact.chars} karakter`);
  L.push(`forrás-állapot ${fact.availability}`);
  L.push("");
  L.push("## Pontszám összetevői");
  for (const [k, v] of Object.entries(fact.components)) {
    L.push(`  ${k.padEnd(15)} ${v.toFixed(3)}`);
  }
  L.push("");
  L.push(`## Bizonyíték — ${fact.recalls} előhívás, ${fact.queries} különböző kérdés, ${fact.days} külön napon`);
  for (const e of evidence) {
    L.push(`  ${day(e.firstMs)} → ${day(e.lastMs)}  ${String(e.hits).padStart(3)}×  ${e.query ?? `(csak hash: ${e.queryHash})`}`);
  }
  if (fact.digest) {
    L.push("");
    L.push(`## Álom — ${fact.digestModel ?? "modell"} írta, nem a forrás`);
    L.push(fact.digest);
  }
  L.push("");
  L.push("## Szöveg");
  L.push(fact.text || "(a forrás nem olvasható)");
  return L.join("\n");
}

export function formatTopics(topics: ReadonlyArray<Topic>): string {
  if (topics.length === 0) return "Nincs visszatérő téma. A konszolidáció legalább két különböző kérdést vár ugyanarra a szóra.";
  const L = topics.map(
    (t) =>
      `  ${t.term.padEnd(24)} ${String(t.queries).padStart(3)} kérdés  ${String(t.chunks).padStart(4)} találat` +
      `  ${String(t.days).padStart(3)} nap  utoljára: ${day(t.lastMs)}`,
  );
  L.push("");
  L.push(`${topics.length} visszatérő téma.`);
  return L.join("\n");
}
