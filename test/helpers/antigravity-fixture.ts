import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ResolvedRoots } from "../../src/paths.js";

/**
 * The real DDL of `conversation_summaries.db`, built at runtime rather than
 * committed as a binary so it cannot drift from the reader.
 *
 * Note what the columns promise and what the store actually writes: `title` is
 * empty in every row on the reference machine, and `last_user_input_time` is
 * the .NET default of year 1. Both are modelled here.
 */
const DDL = `
CREATE TABLE conversation_summaries (
  conversation_id text,
  title text NOT NULL DEFAULT "",
  preview text NOT NULL DEFAULT "",
  step_count integer NOT NULL DEFAULT 0,
  last_modified_time datetime NOT NULL,
  workspace_uris text NOT NULL,
  status text NOT NULL DEFAULT "",
  source text NOT NULL DEFAULT "",
  project_id text NOT NULL DEFAULT "",
  agent_name text NOT NULL DEFAULT "",
  parent_conversation_id text NOT NULL DEFAULT "",
  nesting_depth integer NOT NULL DEFAULT 0,
  battle_id text NOT NULL DEFAULT "",
  winning_conversation_id text NOT NULL DEFAULT "",
  not_fully_idle numeric NOT NULL DEFAULT false,
  killed numeric NOT NULL DEFAULT false,
  last_user_input_time datetime NOT NULL,
  last_user_input_step_index integer NOT NULL DEFAULT -1,
  app_data_dir text NOT NULL DEFAULT "",
  PRIMARY KEY (conversation_id)
);
`;

export interface Summary {
  conversation_id: string;
  preview: string;
  title?: string;
  step_count?: number;
  last_modified_time: string;
  workspace_uris: string;
  parent_conversation_id?: string;
  app_data_dir?: string;
}

/** Which of the three Antigravity surfaces to write into. */
export type Surface = "cli" | "ide" | "home";

export function surfaceDir(roots: ResolvedRoots, surface: Surface): string {
  const dir =
    surface === "cli" ? roots.antigravityCli : surface === "ide" ? roots.antigravityIde : roots.antigravityHome;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSummaries(
  roots: ResolvedRoots,
  rows: ReadonlyArray<Summary>,
  surface: Surface = "cli",
): string {
  const file = path.join(surfaceDir(roots, surface), "conversation_summaries.db");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });

  const db = new Database(file);
  db.exec(DDL);
  const ins = db.prepare(
    `insert into conversation_summaries
       (conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
        parent_conversation_id, app_data_dir, last_user_input_time)
     values (?,?,?,?,?,?,?,?, '0001-01-01 00:00:00+00:00')`,
  );
  for (const r of rows) {
    ins.run(
      r.conversation_id,
      r.title ?? "",
      r.preview,
      r.step_count ?? 0,
      r.last_modified_time,
      r.workspace_uris,
      r.parent_conversation_id ?? "",
      r.app_data_dir ?? "antigravity",
    );
  }
  db.close();
  return file;
}

export interface HistoryLine {
  display: string;
  timestamp: number;
  workspace?: string;
  conversationId?: string;
  type?: string;
}

export function writeHistory(
  roots: ResolvedRoots,
  lines: ReadonlyArray<HistoryLine>,
  surface: Surface = "cli",
): string {
  const file = path.join(surfaceDir(roots, surface), "history.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + "\n").join(""), "utf8");
  return file;
}

export function appendHistory(file: string, lines: ReadonlyArray<HistoryLine>): void {
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l) + "\n").join(""), "utf8");
}

/** A `brain/<conversationId>/` directory, as the agent writes it. */
export function writeBrainDoc(
  roots: ResolvedRoots,
  conversationId: string,
  name: string,
  body: string,
  surface: Surface = "home",
): string {
  const dir = path.join(surfaceDir(roots, surface), "brain", conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf8");
  return file;
}
