import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/open.js";
import { extractPaths, replaceEvidence } from "../attribution/evidence.js";
import { addTurns, clearSession, sha256, upsertSession, usableTitle, type TurnInput } from "../index/indexer.js";
import { ensureSource, getSource, recordVersionSync } from "../index/watermarks.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Cursor keeps everything in one ~8 GB `state.vscdb`:
 *   ItemTable['composer.composerHeaders']  -> the conversation list
 *   cursorDiskKV 'composerData:<cid>'      -> ordered bubble ids
 *   cursorDiskKV 'bubbleId:<cid>:<bid>'    -> the message text
 *   cursorDiskKV 'ofsContent:<cid>:<uri>'  -> the KEY carries an open file path
 *
 * There is no working directory on a Cursor conversation, so the project has to
 * come from the file paths it touched.
 */
export const cursorCollector: Collector = {
  tool: "cursor",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    if (!fs.existsSync(ctx.roots.cursorStateDb)) {
      // Same trap as Codex: a renamed store must be visible as a warning, not
      // as a quiet zero.
      if (fs.existsSync(path.dirname(ctx.roots.cursorStateDb))) {
        ctx.log(`cursor: nincs meg a ${ctx.roots.cursorStateDb} — új Cursor-verzió más nevű tárolóval?`);
      }
      return stat;
    }

    let state: Db;
    try {
      state = ctx.openSource(ctx.roots.cursorStateDb);
    } catch (err) {
      stat.errors++;
      ctx.log(`cursor: state.vscdb: ${(err as Error).message}`);
      return stat;
    }

    try {
      for (const head of readHeaders(state)) {
        try {
          syncComposer(ctx, state, head, stat);
        } catch (err) {
          stat.errors++;
          ctx.log(`cursor: ${head.composerId}: ${(err as Error).message}`);
        }
      }
    } finally {
      state.close();
    }
    return stat;
  },
};

export interface ComposerHead {
  composerId: string;
  name: string | null;
  subtitle: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
}

function readHeaders(state: Db): ComposerHead[] {
  const row = state.prepare("select value from ItemTable where key = 'composer.composerHeaders'").get() as
    | { value: Buffer | string }
    | undefined;
  if (!row) return [];
  const text = typeof row.value === "string" ? row.value : row.value.toString("utf8");
  const parsed = JSON.parse(text) as { allComposers?: Array<Record<string, unknown>> };
  return (parsed.allComposers ?? []).map((c) => ({
    composerId: String(c.composerId ?? ""),
    name: typeof c.name === "string" ? c.name : null,
    subtitle: typeof c.subtitle === "string" ? c.subtitle : null,
    createdAt: typeof c.createdAt === "number" ? c.createdAt : null,
    lastUpdatedAt: typeof c.lastUpdatedAt === "number" ? c.lastUpdatedAt : null,
  }));
}

/**
 * Half-open key range instead of `LIKE 'prefix%'`.
 *
 * `cursorDiskKV.key` is UNIQUE, so it has a BINARY-collated index — but SQLite
 * only turns `LIKE` into a range seek when `case_sensitive_like` is ON, and
 * otherwise falls back to scanning all ~480k rows. Measured on the live 7.6 GB
 * store: LIKE 100.4 ms per composer (SCAN) versus 0.0 ms (SEARCH) for this.
 * ':' is 0x3A, ';' is 0x3B — the next byte value ends the range.
 */
export function keyRange(prefix: string, composerId: string): [string, string] {
  return [`${prefix}:${composerId}:`, `${prefix}:${composerId};`];
}

export const RANGE_SQL = "select key, value from cursorDiskKV where key >= ? and key < ?";
export const RANGE_KEYS_SQL = "select key from cursorDiskKV where key >= ? and key < ?";

function asText(value: Buffer | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.toString("utf8");
}

function syncComposer(ctx: CollectorCtx, state: Db, head: ComposerHead, stat: SyncStat): void {
  if (!head.composerId) return;

  const locator = `${ctx.roots.cursorStateDb}#composer:${head.composerId}`;
  const source = ensureSource(ctx.hub, "cursor", "sqlite_kv", locator);

  // Cheapest signal first: a conversation whose timestamp has not moved needs
  // no reads at all.
  if (
    !ctx.repair &&
    source.ext_version !== null &&
    head.lastUpdatedAt !== null &&
    source.ext_version >= head.lastUpdatedAt
  ) {
    stat.skipped++;
    return;
  }

  const dataRow = state
    .prepare("select value from cursorDiskKV where key = ?")
    .get(`composerData:${head.composerId}`) as { value: Buffer | string } | undefined;

  // Many conversations carry no usable timestamp — background and cloud agent
  // threads in particular. Only for those does the index row itself become the
  // change signal: one point get instead of a range scan over every bubble.
  //
  // This must never override a moved timestamp: editing a bubble's text leaves
  // `composerData` (an ordered list of ids) untouched, so the fingerprint alone
  // would miss a real edit.
  const fingerprint = dataRow ? sha256(asText(dataRow.value) ?? "") : null;
  if (!ctx.repair && head.lastUpdatedAt === null && fingerprint !== null && source.prefix_sha256 === fingerprint) {
    recordVersionSync(ctx.hub, source.id, head.lastUpdatedAt, ctx.now());
    stat.skipped++;
    return;
  }
  if (!dataRow) {
    // Background and cloud conversations appear in the header list with no
    // local payload. Record them so the timeline can say a conversation
    // happened, rather than pretending it never existed.
    upsertSession(ctx.hub, {
      tool: "cursor",
      extId: head.composerId,
      sourceId: source.id,
      title: usableTitle(head.name),
      titleOrigin: head.name ? "composer_name" : null,
      startedMs: head.createdAt,
      endedMs: head.lastUpdatedAt,
    });
    recordVersionSync(ctx.hub, source.id, head.lastUpdatedAt, ctx.now());
    stat.skipped++;
    return;
  }

  let data: { fullConversationHeadersOnly?: Array<{ bubbleId?: string; type?: number }> };
  try {
    data = JSON.parse(asText(dataRow.value) ?? "{}") as typeof data;
  } catch {
    stat.errors++;
    return;
  }

  // One index seek returns every bubble of the conversation.
  const [lo, hi] = keyRange("bubbleId", head.composerId);
  const bubbles = new Map<string, string>();
  for (const r of state.prepare(RANGE_SQL).all(lo, hi) as Array<{ key: string; value: Buffer | string }>) {
    const text = asText(r.value);
    if (text !== null) bubbles.set(r.key, text);
  }

  const sessionId = upsertSession(ctx.hub, {
    tool: "cursor",
    extId: head.composerId,
    sourceId: source.id,
    title: usableTitle(head.name),
    titleOrigin: head.name ? "composer_name" : null,
    startedMs: head.createdAt,
    endedMs: head.lastUpdatedAt,
  });

  // Cursor rewrites bubbles in place, so a changed conversation is re-read
  // whole rather than appended to.
  clearSession(ctx.hub, sessionId);

  const turns: TurnInput[] = [];
  const evidence: string[] = [];
  let seq = 0;

  for (const h of data.fullConversationHeadersOnly ?? []) {
    if (!h.bubbleId) continue;
    const key = `bubbleId:${head.composerId}:${h.bubbleId}`;
    const raw = bubbles.get(key);
    if (raw === undefined) continue; // pruned bubble: skip, do not fail

    let text: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { text?: unknown };
      text = typeof parsed.text === "string" ? parsed.text : null;
    } catch {
      text = null;
    }

    // Paths mentioned in the payload are the fallback project signal; gathered
    // from the values already in memory, never with a second pass over the table.
    for (const p of extractPaths(raw, 60)) evidence.push(p);

    if (!text || text.trim().length === 0) continue; // tool-only bubble
    turns.push({
      seq: seq++,
      role: h.type === 1 ? "user" : "assistant",
      tsMs: null,
      text,
      locator: { kind: "sqlite_kv", path: ctx.roots.cursorStateDb, key, field: "text" },
    });
  }

  // The strongest Cursor signal: the key itself holds an open file's URI, so
  // only the keys are read — the values are whole file contents.
  const [olo, ohi] = keyRange("ofsContent", head.composerId);
  const openFiles: string[] = [];
  for (const r of state.prepare(RANGE_KEYS_SQL).all(olo, ohi) as Array<{ key: string }>) {
    const uri = r.key.slice(`ofsContent:${head.composerId}:`.length);
    if (uri) openFiles.push(uri);
  }

  const [mlo, mhi] = keyRange("messageRequestContext", head.composerId);
  for (const r of state.prepare(RANGE_SQL).all(mlo, mhi) as Array<{ key: string; value: Buffer | string }>) {
    const text = asText(r.value);
    if (text) for (const p of extractPaths(text, 40)) evidence.push(p);
  }

  const tx = ctx.hub.transaction(() => {
    stat.turns += addTurns(ctx.hub, sessionId, turns);
    replaceEvidence(ctx.hub, sessionId, "ofs_key", openFiles, 2);
    replaceEvidence(ctx.hub, sessionId, "bubble_scan", evidence, 1);
    recordVersionSync(ctx.hub, source.id, head.lastUpdatedAt, ctx.now());
    ctx.hub.prepare("update sources set prefix_sha256 = ? where id = ?").run(fingerprint, source.id);
  });
  tx();
  stat.sessions++;
}

/** Exposed for the guard test that asserts the query plan stays a SEARCH. */
export function explainBubbleQuery(state: Db, composerId: string): string {
  const [lo, hi] = keyRange("bubbleId", composerId);
  const rows = state.prepare(`explain query plan ${RANGE_SQL}`).all(lo, hi) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(" | ");
}

export { getSource };
