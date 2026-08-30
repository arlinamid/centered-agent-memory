import type { Db } from "../db/open.js";
import { normalizePath } from "../paths.js";
import { addTurns, clearSession, upsertSession } from "../index/indexer.js";
import { ensureSource, getSource, recordVersionSync } from "../index/watermarks.js";
import { replaceEvidence } from "../attribution/evidence.js";
import { DaemonSession } from "./language-server.js";
import { fetchTrajectory } from "./cascade-rpc.js";

/**
 * Fetching one Antigravity conversation, on demand.
 *
 * This is deliberately not a collector. `cam sync` never comes here: it would
 * mean holding a vendor daemon open on an hourly schedule to decrypt hundreds
 * of conversations nobody asked for — and one of them is 5.2 MB. Instead the
 * body arrives when somebody asks for that conversation by name, and is then
 * kept, so asking twice costs one call.
 *
 * The summaries database — already read, offline, free — decides whether the
 * kept copy is still current. Nothing here runs when it is.
 */

export type FetchOutcome =
  | { status: "cached"; turns: number }
  | { status: "fetched"; turns: number; steps: number }
  | { status: "no-daemon" }
  | { status: "not-found" }
  | { status: "failed"; detail: string };

const bodySourceLocator = (cascadeId: string): string => `antigravity#body:${cascadeId}`;

/**
 * What the summaries pass recorded for this conversation. The body is stale
 * exactly when this has moved, which is the whole change-detection story.
 */
export function summaryVersion(db: Db, cascadeId: string): number | null {
  const row = db
    .prepare(
      "select ext_version from sources where tool = 'antigravity' and locator like ? order by id limit 1",
    )
    .get(`%#summary:${cascadeId}`) as { ext_version: number | null } | undefined;
  return row?.ext_version ?? null;
}

/** True when the stored body is current, so no call is needed. */
export function bodyIsCurrent(db: Db, cascadeId: string): boolean {
  const wanted = summaryVersion(db, cascadeId);
  if (wanted === null) return false;
  const body = getSource(db, "antigravity", bodySourceLocator(cascadeId));
  return body?.ext_version === wanted;
}

export interface FetchOptions {
  session: DaemonSession;
  log?: (msg: string) => void;
  fetchImpl?: typeof globalThis.fetch;
  /** Fetch again even when the stored copy looks current. */
  force?: boolean;
}

/**
 * Ensure the conversation's turns are in the index, fetching them if they are
 * not — and doing nothing at all when they already are.
 */
export async function fetchConversation(
  db: Db,
  cascadeId: string,
  opts: FetchOptions,
): Promise<FetchOutcome> {
  const existing = db
    .prepare("select id, turn_count from sessions where tool = 'antigravity' and ext_id = ?")
    .get(cascadeId) as { id: number; turn_count: number } | undefined;
  if (!existing) return { status: "not-found" };

  if (!opts.force && existing.turn_count > 0 && bodyIsCurrent(db, cascadeId)) {
    return { status: "cached", turns: existing.turn_count };
  }

  // Not an error: Antigravity is simply closed, and there is no supported way
  // to open it from here. The caller says so and shows what it does have.
  // Every live daemon is asked, because the first one may be Devin's.
  const got = await fetchTrajectory(opts.session, cascadeId, { fetchImpl: opts.fetchImpl });
  let parsed;
  switch (got.status) {
    case "no-daemon":
      return { status: "no-daemon" };
    case "failed":
      return { status: "failed", detail: got.detail };
    case "ok":
      parsed = got.parsed;
      break;
    default: {
      const _never: never = got;
      return { status: "failed", detail: String(_never) };
    }
  }

  const version = summaryVersion(db, cascadeId);
  const source = ensureSource(db, "antigravity", "rpc", bodySourceLocator(cascadeId));
  const cwd = parsed.workspaces[0] ?? null;

  const tx = db.transaction(() => {
    const sessionId = upsertSession(db, {
      tool: "antigravity",
      extId: cascadeId,
      cwdRaw: cwd,
      cwdNorm: cwd ? normalizePath(cwd) : null,
      startedMs: parsed.createdMs,
    });
    // A re-fetch replaces: a conversation that continued has new steps, and
    // appending would double whatever came before them.
    clearSession(db, sessionId);
    addTurns(db, sessionId, parsed.turns);
    if (cwd) replaceEvidence(db, sessionId, "workspace_uris", [cwd], 3);
    recordVersionSync(db, source.id, version, Date.now());
  });
  tx();

  opts.log?.(
    `antigravity: ${cascadeId.slice(0, 8)}… — ${parsed.turns.length} turn(s) from ${parsed.totalSteps} step(s)`,
  );
  return { status: "fetched", turns: parsed.turns.length, steps: parsed.totalSteps };
}
