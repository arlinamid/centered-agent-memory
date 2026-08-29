import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFilePath, readConfigFile, type FileConfig } from "../config.js";
import { makeProvider, type DreamConfig } from "../memory/dream.js";
import { knownDirs, locate, type BinKind } from "./locate.js";

/**
 * Picking a model for the dream phase out of what is already on the machine.
 *
 * The dream is the one part of this tool that needs a model, and the plan says
 * it stays opt-in. That does not mean it has to be laborious: every user of
 * this tool has at least one agent CLI installed — that is the entire premise
 * of the index — and any command that reads a prompt and writes text will do.
 * So the setup offers what it finds rather than asking for an API key.
 *
 * Nothing here trusts its own list. A candidate is written into the config only
 * after it has answered a real prompt, because a template with the wrong flag
 * looks exactly like a working one until the first dream run fails.
 */

export interface DreamCandidate {
  id: string;
  name: string;
  /** Resolved so a launchd or Task Scheduler context without a PATH still works. */
  bin: string;
  /** Argv before the tool's own flags: the script, when the tool is a shim. */
  prefix: string[];
  /** A native executable, or a Node program we run with an explicit node. */
  kind: BinKind;
  /** The launcher it was found through, when that is not what we ended up with. */
  via: string;
  /** Argv after the binary, with `{model}` substituted where a model was named. */
  args: string[];
  /** Some of these cannot run without being told which model to use. */
  modelRequired: boolean;
  /** Filled in by `listModels` when the choice is about to be offered. */
  models: ModelChoice[];
}

interface Provider {
  id: string;
  name: string;
  /** Command name first, then any alias it is also installed under. */
  bin: string[];
  /** Install locations that an unattended process would not find on its PATH. */
  dirs?: (home: string, env: NodeJS.ProcessEnv) => string[];
  /** Argv when the user did not name a model: let the tool use its own default. */
  args: string[];
  /** Where to splice `--model x` in. */
  modelArgs: string[];
  modelRequired?: boolean;
  /**
   * What the tool can run, where that is knowable. Three of them keep the
   * answer somewhere — a subcommand or a cache file — and the rest are left to
   * the user, because a model list hardcoded here would be wrong within weeks.
   */
  models?: (c: DreamCandidate, env: NodeJS.ProcessEnv) => ModelChoice[];
}

export interface ModelChoice {
  id: string;
  label: string;
}

/**
 * The four flags that matter here, and why each one is in the list.
 *
 * The prompt goes on stdin wherever the tool allows it: a digest prompt carries
 * a few thousand characters of conversation, and argv is the wrong place for
 * that on every platform.
 *
 * These are coding agents, so left alone they will happily read the filesystem
 * to answer a question about text they were handed. Every template therefore
 * pins the tool to read-only or no tools at all — the dream summarises what it
 * is given, and nothing else.
 *
 * Session persistence is switched off for the tools `cam` itself indexes.
 * Without `--ephemeral` on Codex and `--no-session-persistence` on Claude Code,
 * the next sync would index the dream prompts, the dream after that would
 * summarise them, and the index would slowly fill with its own reflection.
 *
 * Where a tool can write the bare answer to a file, it is asked to: `codex
 * exec` otherwise wraps it in a banner and a token count.
 */
const PROVIDERS: Provider[] = [
  {
    id: "codex",
    name: "Codex CLI",
    bin: ["codex"],
    dirs: (home, env) => [
      path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin"),
      path.join(home, ".codex", "bin"),
    ],
    args: [
      "exec",
      "{modelArgs}",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "--color",
      "never",
      "-o",
      "{outFile}",
      "-",
    ],
    modelArgs: ["-m", "{model}"],
    models: codexModels,
  },
  {
    id: "claude",
    name: "Claude Code",
    bin: ["claude"],
    dirs: (home) => [path.join(home, ".local", "bin"), path.join(home, ".claude", "local")],
    args: ["-p", "{modelArgs}", "--no-session-persistence", "--output-format", "text", "--tools", ""],
    modelArgs: ["--model", "{model}"],
    // Claude Code has no way to list models from the command line — the
    // request for one is still open — but its aliases are documented and each
    // always points at the current model, which is what we want anyway.
    models: () => [
      { id: "sonnet", label: "Sonnet — a napi munka modellje" },
      { id: "opus", label: "Opus — összetettebb gondolatmenethez" },
      { id: "haiku", label: "Haiku — gyors és olcsó" },
      { id: "fable", label: "Fable — a leghosszabb feladatokhoz" },
    ],
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    bin: ["cursor-agent"],
    dirs: (home, env) => [
      path.join(home, ".local", "bin"),
      path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "cursor-agent"),
    ],
    // `ask` mode answers without editing, which is all a digest needs.
    args: ["-p", "{modelArgs}", "--output-format", "text", "--mode", "ask"],
    modelArgs: ["--model", "{model}"],
    models: (c) => marked(runTool(c, ["--list-models"])),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    bin: ["gemini"],
    // -p is what makes it headless, and its text is appended to stdin, so the
    // instruction goes here and the material goes through the pipe.
    args: ["{modelArgs}", "--approval-mode", "plan", "-o", "text", "-p", "Kövesd a bemeneten kapott utasítást."],
    modelArgs: ["-m", "{model}"],
  },
  {
    id: "agy",
    name: "Antigravity CLI",
    bin: ["agy"],
    dirs: (home, env) => [
      path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "agy", "bin"),
      path.join(home, ".agy", "bin"),
    ],
    args: ["{modelArgs}", "-p", "{prompt}"],
    modelArgs: ["--model", "{model}"],
    // Prints `id<TAB>label` after a progress line.
    models: (c) => tabbed(runTool(c, ["models"])),
  },
  {
    id: "ollama",
    name: "Ollama",
    bin: ["ollama"],
    dirs: (home, env) => [
      path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "Ollama"),
      "/usr/local/bin",
    ],
    args: ["run", "{model}"],
    modelArgs: [],
    modelRequired: true,
    models: (c) => columns(runTool(c, ["list"])),
  },
];

/** Ask a tool a question and take its stdout; a failure just means no list. */
function runTool(c: DreamCandidate, args: string[], timeoutMs = 20_000): string {
  const r = spawnSync(c.bin, [...c.prefix, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return r.status === 0 && r.stdout ? r.stdout : "";
}

const clean = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "").trim();

/** `id<TAB>Human label` lines, ignoring anything without a tab. */
function tabbed(out: string): ModelChoice[] {
  const found: ModelChoice[] = [];
  for (const line of out.split("\n")) {
    const [id, ...rest] = clean(line).split("\t");
    if (!id || rest.length === 0) continue;
    found.push({ id, label: clean(rest.join(" ")) });
  }
  return found;
}

/** One identifier per line, some carrying a `(default)` or `(current)` note. */
function marked(out: string): ModelChoice[] {
  const found: ModelChoice[] = [];
  for (const line of out.split("\n")) {
    const m = /^[-*•\s]*([A-Za-z0-9][A-Za-z0-9._:/-]{2,})\s*(\(.*\))?\s*$/.exec(clean(line));
    if (m?.[1]) found.push({ id: m[1], label: m[2] ?? "" });
  }
  return found;
}

/** A table with a header row: take the first column. */
function columns(out: string): ModelChoice[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => clean(l).split(/\s{2,}|\t/))
    .filter((cells) => cells[0])
    .map((cells) => ({ id: cells[0]!, label: cells.slice(1).filter(Boolean).join(" · ") }));
}

/**
 * Codex has no `models` subcommand, but it keeps the list it fetched from the
 * service in its own cache — which is both current and the exact set this
 * install is entitled to.
 */
function codexModels(_c: DreamCandidate, env: NodeJS.ProcessEnv): ModelChoice[] {
  const home = env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")) as {
      models?: Array<{ slug?: string; display_name?: string; description?: string }>;
    };
    return (raw.models ?? [])
      .filter((m): m is { slug: string; display_name?: string } => typeof m.slug === "string")
      .map((m) => ({ id: m.slug, label: m.display_name ?? m.slug }));
  } catch {
    return [];
  }
}

export function dreamCandidates(env = process.env, home = os.homedir()): DreamCandidate[] {
  const out: DreamCandidate[] = [];
  for (const p of PROVIDERS) {
    const found = locate(p.bin, [...(p.dirs?.(home, env) ?? []), ...knownDirs(home, env)], env);
    if (!found) continue;
    out.push({
      id: p.id,
      name: p.name,
      bin: found.bin,
      prefix: found.prefix,
      kind: found.kind,
      via: found.via,
      args: p.args,
      modelRequired: p.modelRequired ?? false,
      models: [],
    });
  }
  return out;
}

/**
 * Ask a tool what it can run. An empty answer is not a failure: naming no model
 * lets the tool use its own default, which is usually the right one and is
 * always more current than anything this file could hold.
 */
export function listModels(candidate: DreamCandidate, env = process.env): ModelChoice[] {
  const p = PROVIDERS.find((x) => x.id === candidate.id);
  if (!p?.models) return [];
  try {
    return p.models(candidate, env).slice(0, 40);
  } catch {
    return [];
  }
}

export class DreamModelRequiredError extends Error {
  constructor(candidate: DreamCandidate) {
    const models = candidate.models.length > 0 ? ` Van: ${candidate.models.map((m) => m.id).join(", ")}` : "";
    super(`a ${candidate.name} nem tudja, melyik modellt futtassa — add meg: --model <név>.${models}`);
    this.name = "DreamModelRequiredError";
  }
}

export function dreamConfigFor(candidate: DreamCandidate, model: string | null): DreamConfig {
  const p = PROVIDERS.find((x) => x.id === candidate.id);
  if (!p) throw new Error(`ismeretlen szolgáltató: ${candidate.id}`);
  if (!model && p.modelRequired) throw new DreamModelRequiredError(candidate);

  const args: string[] = [];
  for (const a of p.args) {
    if (a === "{modelArgs}") {
      if (model) args.push(...p.modelArgs.map((x) => x.replace("{model}", model)));
      continue;
    }
    // `{prompt}` and `{outFile}` are filled in per call; the model is fixed the
    // moment it is chosen, so the stored command shows it plainly.
    args.push(model ? a.replace("{model}", model) : a);
  }

  return {
    provider: "command",
    // Recorded with every digest, so a dream can always name its author. With
    // no model named the tool picks its own, and the tool's name is the most
    // honest label available.
    model: model ?? candidate.id,
    command: [candidate.bin, ...candidate.prefix, ...args],
  };
}

export interface DreamProbe {
  ok: boolean;
  /** What the model answered, trimmed — evidence that it answered at all. */
  answer: string;
  error: string | null;
  ms: number;
}

const PROBE_PROMPT = "Válaszolj egyetlen szóval: OK";

/**
 * Send one short prompt through the very code path the dream phase uses. A
 * template that fails here would otherwise fail silently at 3am, per memory,
 * with the run recorded as an error nobody reads.
 */
export async function probeDream(cfg: DreamConfig, timeoutMs = 60_000): Promise<DreamProbe> {
  const started = Date.now();
  try {
    const provider = makeProvider({ ...cfg, timeoutMs });
    const answer = (await provider.generate(PROBE_PROMPT)).trim();
    return {
      ok: answer.length > 0,
      answer: answer.slice(0, 200),
      error: answer.length > 0 ? null : "üres válasz",
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, answer: "", error: (err as Error).message, ms: Date.now() - started };
  }
}

/**
 * Merge the dream block into the config file without disturbing anything else
 * in it — the same file holds the index location, the retention policy and the
 * staleness threshold.
 */
export function writeDreamConfig(cfg: DreamConfig, file = configFilePath()): void {
  const current: FileConfig = readConfigFile(file);
  const next: FileConfig = { ...current, memory: { ...(current.memory ?? {}), dream: cfg } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function readDreamConfig(file = configFilePath()): DreamConfig | null {
  return readConfigFile(file).memory?.dream ?? null;
}

export function clearDreamConfig(file = configFilePath()): boolean {
  const current = readConfigFile(file);
  if (!current.memory?.dream) return false;
  const memory = { ...current.memory };
  delete memory.dream;
  const next: FileConfig = { ...current, memory };
  if (Object.keys(memory).length === 0) delete next.memory;
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}

/**
 * What the user should see about where a tool came from. Not every tool has a
 * native binary — the Gemini CLI is a Node bundle and nothing more — so the
 * distinction worth showing is what it is, not which launcher we came through.
 */
export function describeBin(c: DreamCandidate): string {
  switch (c.kind) {
    case "native":
      return c.bin;
    case "script":
      return `node ${c.prefix[0] ?? ""}`;
    case "launcher":
      return `${c.bin} (indító — a program magát nem találtam)`;
    default: {
      const never: never = c.kind;
      throw new Error(`ismeretlen fajta: ${String(never)}`);
    }
  }
}

/** Reported by `cam install` when nothing suitable is installed. */
export const noCandidatesHint =
  "nincs telepítve olyan ágens-CLI, amit modellként használni tudnék (codex, claude, cursor-agent, gemini, ollama).\n" +
  "Az álom fázis enélkül is kihagyható — a memória-réteg modell nélkül működik.";
