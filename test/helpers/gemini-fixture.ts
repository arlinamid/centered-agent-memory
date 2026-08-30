import fs from "node:fs";
import path from "node:path";
import type { ResolvedRoots } from "../../src/paths.js";

export interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type: string;
  content: unknown;
  [k: string]: unknown;
}

export interface GeminiChat {
  sessionId: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  kind?: string | null;
  messages: GeminiMessage[];
}

/** Write `.project_root`, or leave it out to model the hash-named directories. */
export function writeGeminiProject(roots: ResolvedRoots, project: string, projectRoot: string | null): string {
  const dir = path.join(roots.geminiTmp, project);
  fs.mkdirSync(path.join(dir, "chats"), { recursive: true });
  // The CLI writes the path with no trailing newline; keep the fixture honest.
  if (projectRoot !== null) fs.writeFileSync(path.join(dir, ".project_root"), projectRoot, "utf8");
  return dir;
}

export function writeGeminiChat(roots: ResolvedRoots, project: string, name: string, chat: GeminiChat): string {
  const file = path.join(roots.geminiTmp, project, "chats", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(chat, null, 2), "utf8");
  return file;
}

/**
 * Every message shape a real chat file holds, including the ones that must NOT
 * be indexed: `info` and `error` are the CLI talking to itself, and a `gemini`
 * record's `thoughts` and `toolCalls` are working notes rather than speech.
 */
export function realisticChat(sessionId: string): GeminiChat {
  return {
    sessionId,
    projectHash: "0000000000000000000000000000000000000000000000000000000000000000",
    startTime: "2026-04-02T12:18:00.000Z",
    lastUpdated: "2026-04-02T12:20:00.000Z",
    kind: "main",
    messages: [
      {
        id: "m0",
        timestamp: "2026-04-02T12:18:10.000Z",
        type: "user",
        content: [{ text: "Az árvíztűrő tükörfúrógép hol akad el?" }],
      },
      {
        id: "m1",
        timestamp: "2026-04-02T12:18:12.000Z",
        type: "info",
        content: 'You have 2 extensions with an update available. Run "/extensions update".',
      },
      {
        id: "m2",
        timestamp: "2026-04-02T12:18:30.000Z",
        type: "gemini",
        content: "Megnézem a naplófájlokat és a gyorsítótárat.",
        thoughts: "C".repeat(2048),
        tokens: { input: 12, output: 34 },
        model: "gemini-3-pro",
        toolCalls: [{ name: "run_shell_command", args: { command: "du -sh" } }],
      },
      {
        id: "m3",
        timestamp: "2026-04-02T12:19:00.000Z",
        type: "error",
        content: "[API Error: You have exhausted your daily quota on this model.]",
      },
      {
        id: "m4",
        timestamp: "2026-04-02T12:19:30.000Z",
        type: "user",
        content: [{ text: "Második kérdés a projektről." }],
      },
    ],
  };
}
