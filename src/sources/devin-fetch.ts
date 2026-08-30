import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/open.js";
import { normalizePath } from "../paths.js";
import { addTurns, clearSession, upsertSession } from "../index/indexer.js";
import { ensureSource, getSource, recordVersionSync } from "../index/watermarks.js";
import { replaceEvidence } from "../attribution/evidence.js";
import type { DaemonSession } from "./language-server.js";
import { fetchTrajectory } from "./cascade-rpc.js";

/**
 * Fetching one Devin (Windsurf Cascade) conversation, on demand.
 *
 * Same shape as Antigravity, and deliberately not a collector: `cam sync`
 * never comes here. The bodies live encrypted in `~/.codeium/windsurf/cascade/*.pb`
 * with no summaries database beside them, so the only component that can
 * decrypt them is the language server Devin already runs. Asking for one by
 * name is the moment to go and get it.
 *
 * A session the Devin **CLI** already indexed is left alone — that store is
 * readable SQLite, and this path is only for the desktop Cascade threads.
 */

export type FetchOutcome =
  | { status: "cached"; turns: number }
  | { status: "fetched"; turns: number; steps: number }
  | { status: "no-daemon" }
  | { status: "cli-session" }
  | { status: "failed"; detail: string };

const bodySourceLocator = (cascadeId: string): string => `devin#cascade-body:${cascadeId}`;

const CASCADE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pb$/i;

export function cascadePath(cascadeDir: string, cascadeId: string): string {
  return path.join(cascadeDir, `${cascadeId}.pb`);
}

/**
 * Change detection when there is no summaries row: the encrypted file's
 * mtime and size. Missing file is not "stale" — a conversation the daemon
 * still holds can have been deleted from disk, and the kept copy is then
 * the only copy.
 */
export function cascadeFileVersion(file: string): number | null {
  try {
    const st = fs.statSync(file);
    return Math.round(st.mtimeMs) + st.size;
  } catch {
    return null;
  }
}

export function isCascadeFilename(name: string): boolean {
  return CASCADE_FILE.test(name);
}

/** True when this id is a Devin CLI session, not a Cascade thread. */
export function isDevinCliSession(db: Db, extId: string): boolean {
  const row = db
    .prepare(
      `select so.kind as kind, so.locator as locator
       from sessions s
       left join sources so on so.id = s.source_id
       where s.tool = 'devin' and s.ext_id = ?`,
    )
    .get(extId) as { kind: string | null; locator: string | null } | undefined;
  if (!row) return false;
  if (row.kind === "sqlite_row") return true;
  return typeof row.locator === "string" && row.locator.includes("#session:");
}

export function bodyIsCurrent(db: Db, cascadeId: string, cascadeDir: string): boolean {
  const wanted = cascadeFileVersion(cascadePath(cascadeDir, cascadeId));
  const body = getSource(db, "devin", bodySourceLocator(cascadeId));
  if (wanted === null) return (body?.ext_version ?? null) !== null;
  return body?.ext_version === wanted;
}

export interface FetchOptions {
  session: DaemonSession;
  cascadeDir: string;
  log?: (msg: string) => void;
  fetchImpl?: typeof globalThis.fetch;
  force?: boolean;
}

/**
 * Ensure the conversation's turns are in the index, fetching them if they
 * are not. Unlike Antigravity there is no summaries pass that must have
 * seen the id first: a successful fetch inserts the session.
 */
export async function fetchDevinCascade(db: Db, cascadeId: string, opts: FetchOptions): Promise<FetchOutcome> {
  if (isDevinCliSession(db, cascadeId)) return { status: "cli-session" };

  const existing = db
    .prepare("select id, turn_count from sessions where tool = 'devin' and ext_id = ?")
    .get(cascadeId) as { id: number; turn_count: number } | undefined;

  if (!opts.force && existing && existing.turn_count > 0 && bodyIsCurrent(db, cascadeId, opts.cascadeDir)) {
    return { status: "cached", turns: existing.turn_count };
  }

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

  const version = cascadeFileVersion(cascadePath(opts.cascadeDir, cascadeId));
  const source = ensureSource(db, "devin", "rpc", bodySourceLocator(cascadeId));
  const cwd = parsed.workspaces[0] ?? null;

  const tx = db.transaction(() => {
    const sessionId = upsertSession(db, {
      tool: "devin",
      extId: cascadeId,
      cwdRaw: cwd,
      cwdNorm: cwd ? normalizePath(cwd) : null,
      startedMs: parsed.createdMs,
    });
    clearSession(db, sessionId);
    addTurns(db, sessionId, parsed.turns);
    if (cwd) replaceEvidence(db, sessionId, "workspace_uris", [cwd], 3);
    recordVersionSync(db, source.id, version, Date.now());
  });
  tx();

  opts.log?.(
    `devin: ${cascadeId.slice(0, 8)}… — ${parsed.turns.length} turn(s) from ${parsed.totalSteps} step(s)`,
  );
  return { status: "fetched", turns: parsed.turns.length, steps: parsed.totalSteps };
}
