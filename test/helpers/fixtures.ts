import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initSchema, openHub, openSourceReadonly, type Db } from "../../src/db/open.js";
import type { CollectorCtx } from "../../src/collectors/types.js";
import { defaultRoots, type ResolvedRoots } from "../../src/paths.js";

export interface Harness {
  dir: string;
  hub: Db;
  roots: ResolvedRoots;
  ctx: CollectorCtx;
  logs: string[];
  cleanup: () => void;
}

/** A hub plus a fake set of store roots. No test ever reads the real machine. */
export function makeHarness(now = () => 1_700_000_000_000): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-fx-"));
  const hub = openHub(path.join(dir, "hub.sqlite"));
  initSchema(hub);

  const base = defaultRoots(path.join(dir, "home"));
  const roots: ResolvedRoots = {
    ...base,
    claudeProjects: path.join(dir, "claude", "projects"),
    claudePlans: path.join(dir, "claude", "plans"),
    claudeTemp: path.join(dir, "temp", "claude"),
    desktopSessions: path.join(dir, "desktop", "claude-code-sessions"),
    coworkSessions: path.join(dir, "desktop", "local-agent-mode-sessions"),
    codexStateDb: path.join(dir, "codex", "state_5.sqlite"),
    cursorStateDb: path.join(dir, "cursor", "state.vscdb"),
    cursorHistory: path.join(dir, "cursor", "History"),
  };
  for (const p of Object.values(roots)) fs.mkdirSync(p.endsWith(".sqlite") || p.endsWith(".vscdb") ? path.dirname(p) : p, { recursive: true });

  const logs: string[] = [];
  const ctx: CollectorCtx = {
    hub,
    roots,
    openSource: (p: string) => openSourceReadonly(p),
    now,
    log: (m) => logs.push(m),
    maxInlineBytes: 256 * 1024,
  };

  return {
    dir,
    hub,
    roots,
    ctx,
    logs,
    cleanup: () => {
      hub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const jline = (o: unknown): string => JSON.stringify(o) + "\n";

/** Write a Claude Code transcript under a project slug. */
export function writeTranscript(roots: ResolvedRoots, slug: string, sessionId: string, records: unknown[]): string {
  const dir = path.join(roots.claudeProjects, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map(jline).join(""), "utf8");
  return file;
}

export function appendRecords(file: string, records: unknown[]): void {
  fs.appendFileSync(file, records.map(jline).join(""), "utf8");
}

/**
 * A record set exercising every shape seen in a real transcript, including the
 * ones that must NOT be indexed.
 */
export function realisticRecords(cwd: string, sessionId: string): unknown[] {
  return [
    { type: "queue-operation", operation: "enqueue", sessionId, content: "ezt ne indexeljük" },
    { type: "ai-title", sessionId, title: "Generált cím" },
    {
      type: "user",
      sessionId,
      cwd,
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { content: "Nézd meg a projektet, mi tűnik fel elsőre?" },
    },
    {
      type: "assistant",
      sessionId,
      cwd,
      timestamp: "2026-08-01T10:00:05.000Z",
      message: {
        content: [
          { type: "thinking", signature: "A".repeat(4096) },
          { type: "text", text: "Az árvíztűrő tükörfúrógép rendben van." },
        ],
      },
    },
    { type: "attachment", sessionId, content: "B".repeat(2048) },
    { type: "system", sessionId, content: "rendszerüzenet" },
    { type: "custom-title", sessionId, title: "Kézi cím" },
    {
      type: "user",
      sessionId,
      cwd,
      timestamp: "2026-08-01T10:01:00.000Z",
      message: { content: [{ type: "text", text: "Második kérdés a projektről." }] },
    },
  ];
}
