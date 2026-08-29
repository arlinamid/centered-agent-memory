import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db/open.js";
import { listFacts, type MemoryFact } from "./facts.js";

/**
 * The dream phase: the one place a language model is allowed near this tool.
 *
 * Everything else in the memory layer is deterministic and offline — what gets
 * promoted is decided by evidence, not by judgment. The dream adds the one
 * thing determinism cannot: saying, in a sentence, what a promoted excerpt is
 * *about*. It never promotes, never demotes and never edits an evidence table.
 *
 * Three rules make this safe to have:
 *
 *  1. Off by default, and never run from `consolidate`. Only an explicit
 *     `cam memory dream` sends anything anywhere.
 *  2. The model is configuration, not code. Any command that reads a prompt and
 *     writes text works, so the model can be swapped without a rebuild.
 *  3. Output is cached by the hash of its input, marked with the model that
 *     produced it, and kept apart from the sources. It is derived text: it can
 *     be wrong, and it can always be thrown away.
 */

/** Bumped when the prompt changes, so old output is not mistaken for new. */
export const PROMPT_VERSION = 1;

export type DreamKind = "digest";

export interface DreamProvider {
  /** Recorded with every output, so a stored dream names its author. */
  readonly model: string;
  generate(prompt: string): Promise<string>;
}

export interface DreamConfig {
  /** "none" (default) refuses to send anything. */
  provider?: "none" | "command";
  model?: string;
  /**
   * Argv of the command to run. `{model}` is substituted; the prompt goes to
   * stdin unless `{prompt}` (inline) or `{promptFile}` (temp file) appears.
   */
  command?: string[];
  timeoutMs?: number;
  /** How many memories one run may process. */
  maxItems?: number;
  /** Ceiling on the excerpt sent per memory. */
  maxInputChars?: number;
}

export const DREAM_DEFAULTS = {
  timeoutMs: 120_000,
  maxItems: 10,
  maxInputChars: 4000,
} as const;

export class DreamNotConfiguredError extends Error {
  constructor() {
    super(
      "a dream fázishoz modell kell, és nincs beállítva.\n" +
        "Írd a konfigurációs fájlba (cam doctor kiírja, hol van):\n" +
        '  "memory": { "dream": { "provider": "command", "model": "<modell>",\n' +
        '    "command": ["codex", "exec", "--model", "{model}", "-"] } }\n' +
        "A prompt a stdin-re megy. Bármilyen parancs jó, ami promptot olvas és szöveget ír.",
    );
    this.name = "DreamNotConfiguredError";
  }
}

export const needsShell = (bin: string): boolean => process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);

/** Run an external command with the prompt on stdin (or substituted into argv). */
export function commandProvider(cfg: DreamConfig): DreamProvider {
  const argv = cfg.command ?? [];
  if (argv.length === 0) throw new DreamNotConfiguredError();
  const model = cfg.model ?? "?";
  const timeoutMs = cfg.timeoutMs ?? DREAM_DEFAULTS.timeoutMs;

  return {
    model,
    generate(prompt: string): Promise<string> {
      let tempFile: string | null = null;
      let outFile: string | null = null;
      const args = argv.slice(1).map((a) => {
        if (a.includes("{promptFile}")) {
          tempFile ??= writeTemp(prompt);
          return a.replace("{promptFile}", tempFile);
        }
        // Agent CLIs print a banner, progress and a token count around the
        // answer. Those that can write the answer alone to a file are asked to,
        // so the digest is the model's sentence and not its chrome.
        if (a.includes("{outFile}")) {
          outFile ??= path.join(os.tmpdir(), `cam-dream-out-${process.pid}-${Date.now()}.txt`);
          return a.replace("{outFile}", outFile);
        }
        return a.replace("{model}", model).replace("{prompt}", prompt);
      });
      const useStdin = !argv.some((a) => a.includes("{prompt}") || a.includes("{promptFile}"));
      const bin = argv[0]!.replace("{model}", model);

      return new Promise<string>((resolve, reject) => {
        const child = spawn(bin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // Most agent CLIs are installed on Windows as a .cmd shim, and since
          // Node 18.20 spawning one without a shell fails with EINVAL. Without
          // this the configured model would be unreachable on the platform
          // most of these tools are installed on.
          shell: needsShell(bin),
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`időtúllépés (${timeoutMs} ms)`));
        }, timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d: string) => (out += d));
        child.stderr.on("data", (d: string) => (err += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          cleanup(tempFile, outFile);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const written = outFile !== null && fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null;
          cleanup(tempFile, outFile);
          if (code !== 0) {
            reject(new Error(`a parancs ${code} kóddal lépett ki: ${lastLine(err) || lastLine(out)}`));
            return;
          }
          resolve((written ?? out).trim());
        });

        if (useStdin) {
          child.stdin.end(prompt, "utf8");
        } else {
          child.stdin.end();
        }
      });
    },
  };
}

function writeTemp(prompt: string): string {
  const file = path.join(os.tmpdir(), `cam-dream-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, prompt, "utf8");
  return file;
}

function cleanup(...files: Array<string | null>): void {
  for (const file of files) {
    if (!file) continue;
    try {
      fs.rmSync(file);
    } catch {
      // A leftover temp file is not worth failing a run over.
    }
  }
}

/** The useful part of a failure is usually the last thing said, not the first. */
function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter((l) => l.trim() !== "");
  return lines[lines.length - 1]?.trim() ?? "";
}

export function makeProvider(cfg: DreamConfig = {}): DreamProvider {
  if ((cfg.provider ?? "none") === "none") throw new DreamNotConfiguredError();
  return commandProvider(cfg);
}

/**
 * The prompt. Deliberately narrow: describe what is already there, invent
 * nothing, and answer in the language of the excerpt — the corpus is Hungarian
 * and English mixed, and a translated memory is a wrong memory.
 */
export function buildPrompt(fact: MemoryFact, questions: ReadonlyArray<string>, maxInputChars: number): string {
  const excerpt = fact.text.length > maxInputChars ? `${fact.text.slice(0, maxInputChars)}…` : fact.text;
  return [
    `[cam-dream v${PROMPT_VERSION} · digest]`,
    "Az alábbi részlet egy régi beszélgetésből való, amit a keresések többször előhívtak.",
    "Írd le 1-3 mondatban, miről szól és miért lehet később fontos.",
    "",
    "Szabályok:",
    "- Csak arra támaszkodj, ami a részletben benne van. Ne találj ki semmit.",
    "- Azon a nyelven válaszolj, amin a részlet van.",
    "- Ne ismételd meg a feladatot és ne magyarázd, mit csinálsz. Csak a lényeget írd.",
    "",
    `Projekt: ${fact.project ?? "ismeretlen"}`,
    `Kérdések, amikre előjött: ${questions.join(" · ") || "(nincs feljegyezve)"}`,
    "",
    "--- részlet ---",
    excerpt,
  ].join("\n");
}

export interface DreamItem {
  fact: MemoryFact;
  prompt: string;
  inputSha256: string;
  cached: boolean;
}

export interface DreamStat {
  candidates: number;
  cached: number;
  generated: number;
  failed: number;
  /** Characters actually handed to the model. Zero on a dry run. */
  sentChars: number;
  model: string;
  dryRun: boolean;
  errors: string[];
}

export interface DreamOptions {
  config?: DreamConfig;
  provider?: DreamProvider;
  project?: string | null;
  limit?: number;
  dryRun?: boolean;
  nowMs?: number;
  /** Regenerate even when a cached dream exists for the same input. */
  force?: boolean;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** What would be sent, before anything is sent. This is the disclosure step. */
export function planDream(db: Db, opts: DreamOptions = {}): DreamItem[] {
  const cfg = opts.config ?? {};
  const maxInputChars = cfg.maxInputChars ?? DREAM_DEFAULTS.maxInputChars;
  const limit = Math.min(opts.limit ?? cfg.maxItems ?? DREAM_DEFAULTS.maxItems, 100);
  const model = opts.provider?.model ?? cfg.model ?? "?";

  const facts = listFacts(db, { project: opts.project ?? null, limit });
  const questionsOf = db.prepare(
    `select q.text from recall_events e join memory_queries q on q.hash = e.query_hash
     where e.chunk_id = ? group by q.text order by count(*) desc limit 5`,
  );
  const cachedRow = db.prepare(
    `select 1 from memory_dreams
     where kind = 'digest' and chunk_id = ? and input_sha256 = ? and model = ? and prompt_version = ?`,
  );

  const out: DreamItem[] = [];
  for (const fact of facts) {
    // A memory whose source is gone has nothing to describe.
    if (fact.availability === "missing" || !fact.text.trim()) continue;
    const questions = (questionsOf.all(fact.chunkId) as Array<{ text: string }>).map((r) => r.text);
    const prompt = buildPrompt(fact, questions, maxInputChars);
    const inputSha256 = sha256(prompt);
    const cached = !opts.force && cachedRow.get(fact.chunkId, inputSha256, model, PROMPT_VERSION) !== undefined;
    out.push({ fact, prompt, inputSha256, cached });
  }
  return out;
}

/**
 * Generate the digests. Every failure is per item and recorded, never fatal:
 * the measured failure mode of a model-dependent pipeline is that it stops
 * producing anything at all, and this one has to be retryable tomorrow.
 */
export async function runDream(db: Db, opts: DreamOptions = {}): Promise<DreamStat> {
  const nowMs = opts.nowMs ?? Date.now();
  const items = planDream(db, opts);
  const todo = items.filter((i) => !i.cached);

  const stat: DreamStat = {
    candidates: items.length,
    cached: items.length - todo.length,
    generated: 0,
    failed: 0,
    sentChars: 0,
    model: opts.provider?.model ?? opts.config?.model ?? "?",
    dryRun: opts.dryRun ?? false,
    errors: [],
  };
  if (stat.dryRun || todo.length === 0) return stat;

  const provider = opts.provider ?? makeProvider(opts.config);
  stat.model = provider.model;

  const insert = db.prepare(
    `insert into memory_dreams(kind, chunk_id, input_sha256, model, prompt_version, text, chars, created_ms)
     values ('digest', ?,?,?,?,?,?,?)
     on conflict(kind, chunk_id, input_sha256, model, prompt_version) do update set
       text = excluded.text, chars = excluded.chars, created_ms = excluded.created_ms`,
  );

  for (const item of todo) {
    try {
      const text = (await provider.generate(item.prompt)).trim();
      stat.sentChars += item.prompt.length;
      if (!text) {
        stat.failed++;
        stat.errors.push(`#${item.fact.id}: üres válasz`);
        continue;
      }
      insert.run(item.fact.chunkId, item.inputSha256, provider.model, PROMPT_VERSION, text, text.length, nowMs);
      stat.generated++;
    } catch (err) {
      stat.failed++;
      stat.errors.push(`#${item.fact.id}: ${(err as Error).message}`);
    }
  }
  return stat;
}

/** Drop every generated dream. The evidence and the promotions are untouched. */
export function forgetDreams(db: Db): number {
  const n = (db.prepare("select count(*) c from memory_dreams").get() as { c: number }).c;
  db.prepare("delete from memory_dreams").run();
  return n;
}
