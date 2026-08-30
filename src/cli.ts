#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configFilePath, loadConfig, type HubConfig } from "./config.js";
import {
  HubUnreadableError,
  getMeta,
  initSchema,
  isCorruption,
  openHub,
  openSourceReadonly,
  quickCheck,
  sqliteVersion,
  type Db,
} from "./db/open.js";
import { acquireLock, describeHolder } from "./db/lock.js";
import { checkPortability } from "./db/portability.js";
import { claudeCodeCollector } from "./collectors/claude-code.js";
import { claudeDesktopCollector } from "./collectors/claude-desktop.js";
import { codexCollector } from "./collectors/codex.js";
import { coworkCollector } from "./collectors/cowork.js";
import { cursorCollector } from "./collectors/cursor.js";
import { cursorHistoryCollector } from "./collectors/cursor-history.js";
import { artifactsCollector } from "./collectors/artifacts.js";
import type { Collector, CollectorCtx } from "./collectors/types.js";
import {
  RULE_VERSION,
  collectCwdEvidence,
  correlateTime,
  learnRoots,
  makeResolver,
  reattribute,
  resolveFileEvents,
} from "./attribution/resolve.js";
import { rebuildFts } from "./index/rebuild.js";
import * as log from "./log.js";
import { backup, defaultBackupPath } from "./ops/backup.js";
import { describeFreshness, freshness } from "./ops/freshness.js";
import { ForgetTargetError, forget, prune, vacuum } from "./ops/prune.js";
import { consolidate, DEFAULT_BUDGET_CHARS } from "./memory/consolidate.js";
import { getFact, listFacts, listTopics, memoryStatus } from "./memory/facts.js";
import { DreamNotConfiguredError, forgetDreams, planDream, runDream } from "./memory/dream.js";
import { dossier, listProjects, timeline } from "./query/dossier.js";
import {
  day,
  formatDossier,
  formatMemory,
  formatMemoryFact,
  formatRecall,
  formatTimeline,
  formatTopics,
  formatTurns,
} from "./query/format.js";
import { getTurns, parseCitation, recall } from "./query/recall.js";
import {
  EphemeralInstallError,
  ephemeralRoot,
  install,
  installRoot,
  isClientId,
  resolved,
  uninstall,
  type Scope,
} from "./install/index.js";
import {
  DreamModelRequiredError,
  clearDreamConfig,
  describeBin,
  dreamCandidates,
  dreamConfigFor,
  listModels,
  noCandidatesHint,
  probeDream,
  writeDreamConfig,
  type DreamCandidate,
} from "./install/dream.js";
import { ask, interactive, select } from "./install/prompt.js";
import { applySchedule, schedulePlan, scheduleState } from "./install/schedule.js";
import { dateFlag, flag, has, limit, parseArgs, type FlagSpec, type ParsedArgs } from "./args.js";

/** Order matters: transcripts first, then enrichment, then derived artifacts. */
const COLLECTORS: Collector[] = [
  claudeCodeCollector,
  codexCollector,
  coworkCollector,
  cursorCollector,
  claudeDesktopCollector,
  cursorHistoryCollector,
  artifactsCollector,
];

/**
 * Exit codes are part of the CLI contract: a scheduled `cam sync` has nothing
 * else to go on.
 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/**
 * Overrides coming from the command line (`--db`). Set once per run, before any
 * command opens anything, so every caller of `cfg()` sees the same answer.
 */
let cliOverrides: Partial<HubConfig> = {};

function cfg(): HubConfig {
  return loadConfig(cliOverrides, log.warn);
}

function ctxFor(hub: Db, repair = false): CollectorCtx {
  const cfg = loadConfig(cliOverrides, log.warn);
  return {
    hub,
    roots: cfg.roots,
    openSource: openSourceReadonly,
    now: () => Date.now(),
    log: log.warn,
    repair,
    maxInlineBytes: cfg.maxInlineBytes,
  };
}

function open(): Db {
  const db = openHub(cfg().dbPath);
  initSchema(db);
  return db;
}

/** Open, run, close — so no command can leak a handle on an early return. */
function withHub<T>(fn: (db: Db) => T): T {
  const db = open();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function withHubAsync<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = open();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** Flags shared by the read commands, so `--limit` means the same everywhere. */
const QUERY_FLAGS: FlagSpec = { bools: ["json"], values: ["limit"] };

/**
 * Accepted by every command: where the index is, and how much the command says
 * about what it is doing. Neither is a per-command concern, and an unattended
 * `cam sync --quiet` must not have to know which subcommand supports it.
 */
const GLOBAL_VALUES = ["db"] as const;
const GLOBAL_BOOLS = ["quiet", "verbose"] as const;

const withGlobals = (spec: FlagSpec): FlagSpec => ({
  bools: [...(spec.bools ?? []), ...GLOBAL_BOOLS],
  values: [...(spec.values ?? []), ...GLOBAL_VALUES],
});

/** Exported so the test suite can assert that every command is exercised. */
export const SPECS: Record<string, FlagSpec> = {
  sync: { bools: ["repair"], values: ["tool"] },
  projects: { bools: [...(QUERY_FLAGS.bools ?? []), "unattributed"], values: [...(QUERY_FLAGS.values ?? [])] },
  timeline: {
    bools: [...(QUERY_FLAGS.bools ?? []), "subagents"],
    values: [...(QUERY_FLAGS.values ?? []), "since", "until", "tool"],
  },
  dossier: QUERY_FLAGS,
  recall: {
    bools: [...(QUERY_FLAGS.bools ?? []), "include-weak"],
    values: [...(QUERY_FLAGS.values ?? []), "project", "tool", "since"],
  },
  get: QUERY_FLAGS,
  alias: {},
  attribute: {},
  reattribute: {},
  rebuild: {},
  doctor: {},
  memory: {
    bools: [...(QUERY_FLAGS.bools ?? []), "dry-run", "force"],
    values: [...(QUERY_FLAGS.values ?? []), "project", "budget", "min-score", "model"],
  },
  status: QUERY_FLAGS,
  prune: {
    bools: [...(QUERY_FLAGS.bools ?? []), "dry-run", "vacuum"],
    values: [...(QUERY_FLAGS.values ?? []), "recall-days", "keep-runs", "missing-days"],
  },
  forget: {
    bools: [...(QUERY_FLAGS.bools ?? []), "dry-run"],
    values: [...(QUERY_FLAGS.values ?? []), "project", "session"],
  },
  backup: QUERY_FLAGS,
  install: {
    bools: [
      ...(QUERY_FLAGS.bools ?? []),
      "project",
      "dry-run",
      "no-mcp",
      "no-skills",
      "no-dream",
      "no-schedule",
      "force",
    ],
    values: [...(QUERY_FLAGS.values ?? []), "client", "dream", "model"],
  },
  uninstall: {
    bools: [...(QUERY_FLAGS.bools ?? []), "project", "dry-run", "no-mcp", "no-skills", "no-dream", "no-schedule"],
    values: [...(QUERY_FLAGS.values ?? []), "client"],
  },
};

async function cmdSync(a: ParsedArgs): Promise<number> {
  const repair = has(a, "repair");
  const only = flag(a, "tool");
  return withHubAsync(async (db) => {
    const lock = acquireLock(db, "sync");
    if (!lock.ok) {
      log.fail(`Already running: ${lock.heldBy.what} (${describeHolder(lock.heldBy)}) — exiting.`);
      return EXIT_OK; // Not a failure: the other run is doing the work.
    }

    const started = Date.now();
    const runId = Number(
      db.prepare("insert into sync_runs(started_ms, tool) values (?, ?)").run(started, only ?? null).lastInsertRowid,
    );

    let turns = 0;
    let sessions = 0;
    let errors = 0;

    try {
      for (const c of COLLECTORS) {
        if (only && c.tool !== only && c.name !== only) continue;
        const t0 = Date.now();
        // One collector failing must never stop the rest: a locked Cursor store
        // cannot be allowed to block Codex.
        let stat;
        try {
          stat = await c.sync(ctxFor(db, repair));
        } catch (err) {
          errors++;
          log.fail(`${(c.name ?? c.tool).padEnd(15)} ERROR: ${(err as Error).message}`);
          continue;
        }
        turns += stat.turns;
        sessions += stat.sessions;
        errors += stat.errors;
        log.status(
          `${(c.name ?? c.tool).padEnd(15)} session:${String(stat.sessions).padStart(4)}` +
            `  turn:${String(stat.turns).padStart(6)}  unchanged:${String(stat.skipped).padStart(4)}` +
            `  error:${stat.errors}  ${Date.now() - t0} ms`,
        );
      }

      const phase = <T>(name: string, fn: () => T): T => {
        const t0 = Date.now();
        const out = fn();
        log.detail(`  ${name.padEnd(20)} ${Date.now() - t0} ms`);
        return out;
      };

      phase("cwd-evidence", () => collectCwdEvidence(db));
      const roots = phase("workspace-roots", () => learnRoots(db));
      const files = phase("file-paths", () => resolveFileEvents(db, makeResolver(db)));
      phase("time-correlation", () => correlateTime(db));
      const attr = phase("attribution", () => reattribute(db));

      log.detail(
        `  ${"path-cache".padEnd(20)} ${files.cached}/${files.resources} ready, ` +
          `${files.computed} newly resolved, ${files.resolved} point to a project`,
      );

      db.prepare(
        "update sync_runs set ended_ms = ?, sessions_seen = ?, turns_added = ?, errors = ? where id = ?",
      ).run(Date.now(), sessions, turns, errors, runId);

      log.status(`\nlearned workspace root(s): ${roots.length}`);
      log.status(
        `bound to a project: ${attr.attributed}/${attr.sessions}` +
          ` (${attr.sessions ? Math.round((attr.attributed / attr.sessions) * 100) : 0}%)`,
      );
      log.status(`${sessions} session(s), ${turns} new turn(s), ${Date.now() - started} ms`);
    } finally {
      lock.handle.release();
    }

    // A scheduled run learns about a broken source only from the exit code, so
    // this stays visible even under --quiet.
    if (errors > 0) log.fail(`${errors} error(s) during sync`);
    return errors > 0 ? EXIT_FAILED : EXIT_OK;
  });
}

function cmdProjects(a: ParsedArgs): number {
  const max = limit(a, 40);
  if (a.errors.length > 0) return reportErrors(a);
  return withHub((db) => {
    if (has(a, "unattributed")) {
      const rows = db
        .prepare(
          `select s.tool, s.ext_id, s.title, s.turn_count from sessions s
           where s.project_id is null and s.turn_count > 0 order by s.turn_count desc limit ?`,
        )
        .all(max) as Array<{ tool: string; ext_id: string; title: string | null; turn_count: number }>;
      if (has(a, "json")) {
        log.result(JSON.stringify(rows, null, 2));
        return EXIT_OK;
      }
      for (const r of rows) {
        log.result(`${r.tool.padEnd(15)} ${String(r.turn_count).padStart(5)}t  ${r.title ?? r.ext_id}`);
      }
      log.status(`\n${rows.length} unattributed session(s) (the largest)`);
      return EXIT_OK;
    }

    const all = listProjects(db);
    const projects = all.slice(0, max);
    if (has(a, "json")) {
      log.result(JSON.stringify(projects, null, 2));
      return EXIT_OK;
    }
    for (const p of projects) {
      log.result(
        `${p.key.padEnd(30)} ${String(p.sessions).padStart(4)} session ${String(p.turns).padStart(7)} turn` +
          `  last: ${day(p.lastMs)}`,
      );
    }
    const un = db.prepare("select count(*) c from sessions where project_id is null").get() as { c: number };
    const shown = projects.length < all.length ? ` (of ${all.length})` : "";
    log.status(`\n${projects.length} project(s)${shown}, ${un.c} session(s) with no project`);
    return EXIT_OK;
  });
}

function cmdTimeline(a: ParsedArgs): number {
  const [project, ...extra] = a.positional;
  if (!project || extra.length > 0) return usage("cam timeline <project>");
  const max = limit(a, 200);
  const sinceMs = dateFlag(a, "since");
  const untilMs = dateFlag(a, "until");
  if (a.errors.length > 0) return reportErrors(a);

  return withHub((db) => {
    const entries = timeline(db, {
      project,
      sinceMs,
      untilMs,
      tools: flag(a, "tool") ? [flag(a, "tool")!] : null,
      includeSubagents: has(a, "subagents"),
      limit: max,
    });
    log.result(has(a, "json") ? JSON.stringify(entries, null, 2) : formatTimeline(entries, project));
    return EXIT_OK;
  });
}

function cmdDossier(a: ParsedArgs): number {
  const [project, ...extra] = a.positional;
  if (!project || extra.length > 0) return usage("cam dossier <project>");
  const max = limit(a, 8);
  if (a.errors.length > 0) return reportErrors(a);

  return withHub((db) => {
    const d = dossier(db, project, max);
    if (!d) {
      log.fail(`No such project: ${project}`);
      return EXIT_FAILED;
    }
    log.result(has(a, "json") ? JSON.stringify(d, null, 2) : formatDossier(d));
    return EXIT_OK;
  });
}

function cmdRecall(a: ParsedArgs): number {
  const query = a.positional.join(" ");
  if (!query) return usage('cam recall "<query>"');
  const max = limit(a, 10);
  const sinceMs = dateFlag(a, "since");
  if (a.errors.length > 0) return reportErrors(a);

  return withHub((db) => {
    const hits = recall(db, {
      query,
      project: flag(a, "project") ?? null,
      tool: flag(a, "tool") ?? null,
      sinceMs,
      limit: max,
      minConfidence: has(a, "include-weak") ? "weak" : "medium",
    });
    log.result(has(a, "json") ? JSON.stringify(hits, null, 2) : formatRecall(hits, query));
    return EXIT_OK;
  });
}

/**
 * The other half of `cam recall`: the citations it prints are only useful if
 * something can open them. Same parser, same renderer and same failure modes as
 * the `cam_get` tool — a hit found in the terminal reads the same way there.
 */
function cmdGet(a: ParsedArgs): number {
  const [citation, ...extra] = a.positional;
  if (!citation || extra.length > 0) return usage("cam get <tool:sessionId[#seqN-M]>");
  if (a.errors.length > 0) return reportErrors(a);

  const parsed = parseCitation(citation);
  if (!parsed) {
    log.fail(`Unreadable citation: ${citation}\nThe form is tool:sessionId#seqN-M, as cam recall prints it.`);
    return EXIT_USAGE;
  }

  return withHub((db) => {
    const turns = getTurns(db, parsed.tool, parsed.sessionExtId, parsed.seqStart, parsed.seqEnd);
    if (turns.length === 0) {
      log.fail(`No such session: ${citation}`);
      return EXIT_FAILED;
    }
    log.result(has(a, "json") ? JSON.stringify(turns, null, 2) : formatTurns(turns));
    return EXIT_OK;
  });
}

function cmdAlias(a: ParsedArgs): number {
  const [alias, key, ...extra] = a.positional;
  if (!alias || !key || extra.length > 0) return usage("cam alias <folder> <project-key>");
  return withHub((db) => {
    db.prepare("insert or replace into project_aliases(alias, key, kind) values (?,?, 'manual')").run(
      alias.toLowerCase(),
      key,
    );
    log.status(`alias: ${alias} → ${key}`);
    const stats = reattribute(db);
    log.status(`recomputed: ${stats.attributed}/${stats.sessions}`);
    return EXIT_OK;
  });
}

function cmdAttribute(a: ParsedArgs): number {
  const [ref, project, ...extra] = a.positional;
  if (!ref || !project || extra.length > 0) return usage("cam attribute <tool:sessionId> <project-key>");
  const [tool, ...rest] = ref.split(":");
  const extId = rest.join(":");

  return withHub((db) => {
    const s = db.prepare("select id from sessions where tool = ? and ext_id = ?").get(tool, extId) as
      | { id: number }
      | undefined;
    if (!s) {
      log.fail(`No such session: ${ref}`);
      return EXIT_FAILED;
    }
    // A manual decision outweighs every inferred signal and survives reattribute.
    db.prepare("delete from path_evidence where session_id = ? and origin = 'manual'").run(s.id);
    db.prepare(
      "insert into path_evidence(session_id, origin, raw_path, project_key, weight) values (?, 'manual', ?, ?, 1000)",
    ).run(s.id, `~manual:${project}`, project);
    const stats = reattribute(db);
    log.status(`${ref} → ${project}; recomputed: ${stats.attributed}/${stats.sessions}`);
    return EXIT_OK;
  });
}

function cmdReattribute(): number {
  return withHub((db) => {
    const t0 = Date.now();
    // Full recompute: an alias or a new workspace root changes what a path
    // resolves to, and the cache would keep answering with yesterday's verdict.
    const files = resolveFileEvents(db, makeResolver(db), { recompute: true });
    log.detail(`  ${files.computed} file path(s) re-resolved, ${files.resolved} point to a project`);
    correlateTime(db);
    const stats = reattribute(db);
    log.status(`bound to a project: ${stats.attributed}/${stats.sessions}  (${Date.now() - t0} ms)`);
    for (const [method, n] of Object.entries(stats.byMethod).sort((a, b) => b[1] - a[1])) {
      log.status(`  ${method.padEnd(20)} ${n}`);
    }
    return EXIT_OK;
  });
}

/**
 * Re-read every chunk's text from the sources and rebuild the full-text index.
 * `sync --repair` cannot do this: it re-reads sources for turns it does not
 * have yet, and a contentless index cannot be rebuilt from within SQLite.
 */
function cmdRebuild(): number {
  return withHub((db) => {
    const lock = acquireLock(db, "rebuild");
    if (!lock.ok) {
      log.fail(`Already running: ${lock.heldBy.what} (${describeHolder(lock.heldBy)}) — exiting.`);
      return EXIT_OK;
    }
    const t0 = Date.now();
    try {
      const stat = rebuildFts(db, (done, total) => {
        if (done % 5000 === 0 || done === total) log.detail(`  ${done}/${total} chunk`);
      });
      log.status(
        `reindexed: ${stat.indexed}/${stat.chunks} chunk(s)` +
          `  changed source: ${stat.stale}  missing: ${stat.missing}  ${Date.now() - t0} ms`,
      );
      if (stat.missing > 0) {
        log.status("Chunks whose source is missing were left out of the index; those turns are marked 'missing'.");
      }
      return EXIT_OK;
    } finally {
      lock.handle.release();
    }
  });
}

/**
 * The memory layer: consolidate the recall trace, then read what it promoted.
 *
 * A promotion is never shown without its evidence — the whole claim of this
 * layer is that a fact earned its place by coming back, and that is only
 * believable if you can see when and to which questions.
 */
async function cmdMemory(a: ParsedArgs): Promise<number> {
  const [sub = "list", ...rest] = a.positional;
  const max = limit(a, sub === "topics" ? 20 : 20);
  if (a.errors.length > 0) return reportErrors(a);

  switch (sub) {
    case "consolidate":
      return withHub((db) => {
        const lock = acquireLock(db, "memory");
        if (!lock.ok) {
          log.fail(`Already running: ${lock.heldBy.what} (${describeHolder(lock.heldBy)}) — exiting.`);
          return EXIT_OK;
        }
        try {
          const t0 = Date.now();
          const budget = Number(flag(a, "budget") ?? DEFAULT_BUDGET_CHARS);
          const minScore = flag(a, "min-score") ? Number(flag(a, "min-score")) : undefined;
          if (!Number.isFinite(budget) || budget < 1) return usage("cam memory consolidate --budget <characters>");
          if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)) {
            return usage("cam memory consolidate --min-score <0..1>");
          }
          const stat = consolidate(db, { budgetChars: budget, minScore });
          if (has(a, "json")) {
            log.result(JSON.stringify(stat, null, 2));
            return EXIT_OK;
          }
          log.status(`trace: ${stat.traces} chunk(s)  ·  recurring topic(s): ${stat.topics}  ·  candidate(s): ${stat.candidates}`);
          log.status(
            `promoted: ${stat.promoted} new, ${stat.refreshed} refreshed, ${stat.demoted} demoted, ` +
              `${stat.evicted} evicted by the budget`,
          );
          log.status(
            `long-term memory: ${stat.facts} fact(s), ${stat.usedChars}/${stat.budgetChars} character(s) ` +
              `(${Date.now() - t0} ms)`,
          );
          return EXIT_OK;
        } finally {
          lock.handle.release();
        }
      });

    case "list":
      return withHub((db) => {
        const facts = listFacts(db, { project: flag(a, "project") ?? null, limit: max });
        log.result(has(a, "json") ? JSON.stringify(facts, null, 2) : formatMemory(facts));
        return EXIT_OK;
      });

    case "show": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id < 1) return usage("cam memory show <id>");
      return withHub((db) => {
        const found = getFact(db, id);
        if (!found) {
          log.fail(`No such memory: #${id}`);
          return EXIT_FAILED;
        }
        log.result(has(a, "json") ? JSON.stringify(found, null, 2) : formatMemoryFact(found.fact, found.evidence));
        return EXIT_OK;
      });
    }

    case "dream": {
      // The one command that may hand conversation text to a model. Never
      // called by consolidate, never automatic, and it says what it will send
      // before it sends it.
      const dream = { ...cfg().dream };
      if (flag(a, "model")) dream.model = flag(a, "model");
      const forgetRequested = rest[0] === "forget";

      return withHubAsync(async (db) => {
        if (forgetRequested) {
          log.status(`${forgetDreams(db)} dream(s) dropped. Promotions and evidence are untouched.`);
          return EXIT_OK;
        }

        const dryRun = has(a, "dry-run");
        const items = planDream(db, {
          config: dream,
          project: flag(a, "project") ?? null,
          limit: max,
          force: has(a, "force"),
        });
        const todo = items.filter((i) => !i.cached);
        const chars = todo.reduce((n, i) => n + i.prompt.length, 0);

        // The disclosure of what leaves the machine is not a progress report:
        // it stays on stderr at every level, including --quiet.
        log.fail(
          `${items.length} fact(s) · ${todo.length} new · ${chars} characters would go out` +
            ` to model ${dream.model ?? "?"} (${(dream.command ?? ["—"]).join(" ")})`,
        );

        if (dryRun) {
          if (has(a, "json")) {
            log.result(JSON.stringify(todo.map((i) => ({ id: i.fact.id, prompt: i.prompt })), null, 2));
          } else if (todo[0]) {
            log.result("--- the first prompt, verbatim ---");
            log.result(todo[0].prompt);
          } else log.result("Nothing to send.");
          return EXIT_OK;
        }

        try {
          const stat = await runDream(db, {
            config: dream,
            project: flag(a, "project") ?? null,
            limit: max,
            force: has(a, "force"),
          });
          if (has(a, "json")) {
            log.result(JSON.stringify(stat, null, 2));
            return stat.failed > 0 ? EXIT_FAILED : EXIT_OK;
          }
          log.status(
            `dream: ${stat.generated} new, ${stat.cached} already had, ${stat.failed} error(s)` +
              `  ·  ${stat.sentChars} character(s) sent  ·  model: ${stat.model}`,
          );
          for (const e of stat.errors.slice(0, 5)) log.warn(e);
          // A failure is retryable tomorrow; it must not look like success.
          return stat.failed > 0 ? EXIT_FAILED : EXIT_OK;
        } catch (err) {
          if (err instanceof DreamNotConfiguredError) {
            log.fail(err.message);
            return EXIT_USAGE;
          }
          throw err;
        }
      });
    }

    case "topics":
      return withHub((db) => {
        const topics = listTopics(db, max);
        log.result(has(a, "json") ? JSON.stringify(topics, null, 2) : formatTopics(topics));
        return EXIT_OK;
      });

    case "status":
      return withHub((db) => {
        const st = memoryStatus(db);
        if (has(a, "json")) {
          log.result(JSON.stringify(st, null, 2));
          return EXIT_OK;
        }
        log.result(`recall events ${st.events}  ·  distinct queries ${st.queries}`);
        log.result(`traced chunks ${st.traces}  ·  past the gate ${st.candidates}  ·  topics ${st.topics}`);
        log.result(
          `promoted facts ${st.facts}  ·  ${st.chars} characters` +
            `  ·  dreams ${st.dreams}${st.dreamModels.length > 0 ? ` (${st.dreamModels.join(", ")})` : ""}`,
        );
        log.result(`last consolidation: ${st.lastConsolidatedMs ? day(st.lastConsolidatedMs) : "not run yet"}`);
        return EXIT_OK;
      });

    default:
      return usage("cam memory <consolidate|list|show <id>|dream [forget]|topics|status>");
  }
}

function cmdDoctor(): number {
  const c = cfg();
  const configFile = configFilePath();
  log.status(`database          ${c.dbPath}`);
  log.status(`config            ${configFile}${fs.existsSync(configFile) ? "" : " (none, defaults)"}`);

  let db: Db;
  try {
    db = openHub(c.dbPath);
  } catch (err) {
    if (err instanceof HubUnreadableError || isCorruption(err)) {
      log.fail(`  ! the database cannot be opened: ${(err as Error).message}`);
      log.fail("    The file is corrupt. Save it, delete it, then: cam sync — sources are untouched.");
      return EXIT_FAILED;
    }
    throw err;
  }

  try {
    log.status(`sqlite            ${sqliteVersion(db)}`);

    // Diagnosis before anything writes: initSchema would fail on a damaged file
    // and take the diagnostic command down with it.
    const problems = quickCheck(db);
    if (problems.length > 0) {
      log.fail(`  ! corrupt database (${problems.length} error(s)):`);
      for (const p of problems.slice(0, 5)) log.fail(`    ${p}`);
      log.fail("    If only the text index is corrupt: cam rebuild — rebuilds it from the sources.");
      log.fail("    If the data is corrupt too: save the file, delete it, then cam sync.");
      return EXIT_FAILED;
    }
    log.status("integrity         ok");

    try {
      initSchema(db);
    } catch (err) {
      log.fail(`  ! the schema cannot be updated: ${(err as Error).message}`);
      return EXIT_FAILED;
    }

    log.status(`schema version    ${getMeta(db, "schema_version")}`);
    log.status(`rule version      ${RULE_VERSION}`);
    log.status(describeFreshness(freshness(db, Date.now(), c.staleAfterMs)));

    const c2 = db
      .prepare(
        `select (select count(*) from sessions) s, (select count(*) from turns) t,
                (select count(*) from chunks) ch, (select count(*) from sources) src,
                (select count(*) from artifacts) art, (select count(*) from file_events) fe`,
      )
      .get() as Record<string, number>;
    log.status(
      `source ${c2.src} · session ${c2.s} · turn ${c2.t} · chunk ${c2.ch} · artifact ${c2.art} · file event ${c2.fe}`,
    );

    const group = (sql: string, label: string): void => {
      const rows = db.prepare(sql).all() as Array<{ k: string; c: number }>;
      if (rows.length > 0) log.status(`  ${label}: ` + rows.map((r) => `${r.k}=${r.c}`).join("  "));
    };
    group("select status k, count(*) c from sources group by k", "source");
    group("select availability k, count(*) c from turns group by k", "turn");
    group("select confidence k, count(*) c from attribution group by k", "attribution");
    group("select tool k, count(*) c from sessions group by k", "tool");

    let healthy = true;
    const drift = db.prepare("select count(*) c from attribution where rule_version <> ?").get(RULE_VERSION) as {
      c: number;
    };
    if (drift.c > 0) {
      log.status(`  ! ${drift.c} attribution(s) on an old rule version — run: cam reattribute`);
      healthy = false;
    }

    // An index copied from a machine with the other path-folding convention
    // answers every question with silence. Nothing else would report it.
    const portability = checkPortability(db);
    if (portability.message) {
      log.fail(`  ! ${portability.message}`);
      healthy = false;
    }

    const mem = memoryStatus(db);
    log.status(
      `memory: ${mem.facts} fact(s) (${mem.chars} character(s)) · ${mem.events} recall(s) from ${mem.queries} queries` +
        ` · past the gate ${mem.candidates}`,
    );
    if (mem.facts === 0 && mem.candidates > 0) {
      log.status("  ! there is promotable trace — run: cam memory consolidate");
    }

    const bytes = size(db);
    log.status(`database size     ${(bytes / 2 ** 20).toFixed(1)} MB`);

    const lock = db.prepare("select value from meta where key = 'sync_lock'").get() as { value: string } | undefined;
    if (lock) log.status(`  ! sync lock is held: ${lock.value}`);

    // The FTS index is where corruption shows up first, and it is the one part
    // that has a repair path of its own.
    try {
      const fts = db.prepare("select count(*) c from chunks_fts").get() as { c: number };
      const chunks = c2.ch ?? 0;
      log.status(`  fts: ok (${fts.c} indexed chunk(s))`);
      if (chunks > 0 && fts.c === 0) {
        log.status("  ! empty text index — run: cam rebuild");
        healthy = false;
      }
    } catch (err) {
      log.status(`  ! fts broken: ${(err as Error).message} — run: cam rebuild`);
      healthy = false;
    }
    return healthy ? EXIT_OK : EXIT_FAILED;
  } finally {
    db.close();
  }
}

const size = (db: Db): number =>
  (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number);

/**
 * The index's age, on its own. `doctor` answers "is anything broken"; this
 * answers "is what I am about to read current", which is the question a
 * scheduled sync and an agent both actually have.
 */
function cmdStatus(a: ParsedArgs): number {
  const staleAfterMs = cfg().staleAfterMs;
  return withHub((db) => {
    const f = freshness(db, Date.now(), staleAfterMs);
    if (has(a, "json")) {
      log.result(JSON.stringify(f, null, 2));
    } else {
      log.result(describeFreshness(f));
      const portability = checkPortability(db);
      if (portability.message) log.fail(`  ! ${portability.message}`);
    }
    // Stale is a real answer, not a failure: an index nobody synced today is
    // still readable, and a scheduled job wants the distinction.
    return EXIT_OK;
  });
}

/**
 * Retention. Everything it removes is either derived (the recall trace, the run
 * log) or unreadable (sessions whose source is gone) — never a source file.
 */
function cmdPrune(a: ParsedArgs): number {
  const num = (name: string): number | undefined => {
    const raw = flag(a, name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      a.errors.push(`--${name} must be a non-negative integer, not "${raw}"`);
      return undefined;
    }
    return n;
  };
  const policy = {
    ...cfg().retention,
    ...definedOnly({ recallDays: num("recall-days"), keepRuns: num("keep-runs"), missingDays: num("missing-days") }),
  };
  if (a.errors.length > 0) return reportErrors(a);

  const dryRun = has(a, "dry-run");
  return withHub((db) => {
    const lock = acquireLock(db, "prune");
    if (!lock.ok) {
      log.fail(`Already running: ${lock.heldBy.what} (${describeHolder(lock.heldBy)}) — exiting.`);
      return EXIT_OK;
    }
    try {
      const before = size(db);
      const stat = prune(db, { policy, dryRun });
      const vac = !dryRun && has(a, "vacuum") ? vacuum(db) : null;

      if (has(a, "json")) {
        log.result(JSON.stringify({ ...stat, beforeBytes: before, afterBytes: vac?.afterBytes ?? size(db) }, null, 2));
        return EXIT_OK;
      }

      const verb = dryRun ? "would delete" : "deleted";
      log.status(`recall events     ${stat.recallEvents} ${verb}  ·  queries ${stat.queries} ${verb}`);
      if (stat.protectedEvents > 0) {
        log.status(`  ${stat.protectedEvents} old event(s) kept: evidence of a live promotion`);
      }
      log.status(`sync log          ${stat.syncRuns} ${verb}`);
      if (stat.missingSessions > 0) {
        log.status(`missing source    ${stat.missingSessions} session(s) (${stat.missingTurns} turn(s)) ${verb}`);
      }
      log.detail(`  path-cache ${stat.resolutionCache} row(s) ${verb}`);
      if (vac) {
        log.status(
          `size: ${(vac.beforeBytes / 2 ** 20).toFixed(1)} MB → ${(vac.afterBytes / 2 ** 20).toFixed(1)} MB`,
        );
      } else if (!dryRun) {
        log.status(`size: ${(size(db) / 2 ** 20).toFixed(1)} MB (--vacuum reclaims the space)`);
      }
      if (dryRun) log.status("Dry run: nothing was deleted.");
      return EXIT_OK;
    } finally {
      lock.handle.release();
    }
  });
}

/** Drop `undefined` so a missing flag does not overwrite the configured value. */
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Forget a project or a session. This removes it from the index only; the
 * conversation files are somebody else's and are never touched, so a later
 * sync brings it back unless the source is gone too.
 */
function cmdForget(a: ParsedArgs): number {
  const project = flag(a, "project") ?? null;
  const session = flag(a, "session") ?? a.positional[0] ?? null;
  if ((project === null) === (session === null)) {
    return usage("cam forget --project <key> | cam forget <tool:sessionId>");
  }
  const dryRun = has(a, "dry-run");

  return withHub((db) => {
    let stat;
    try {
      stat = forget(db, { project, session }, { dryRun });
    } catch (err) {
      if (err instanceof ForgetTargetError) {
        log.fail(err.message);
        return EXIT_FAILED;
      }
      throw err;
    }

    if (has(a, "json")) {
      log.result(JSON.stringify(stat, null, 2));
      return EXIT_OK;
    }
    const what = project ? `project ${project}` : `session ${session}`;
    log.status(
      `${dryRun ? "would forget" : "forgotten"}: ${what} — ${stat.sessions} session(s), ${stat.turns} turn(s), ` +
        `${stat.chunks} chunk(s), ${stat.facts} fact(s), ${stat.artifacts} artifact(s)`,
    );
    log.status(
      dryRun
        ? "Dry run: nothing was deleted."
        : "Source files are untouched; a later cam sync will reindex them if they are still there.",
    );
    return EXIT_OK;
  });
}

/**
 * A consistent snapshot of the live index, verified before it is called a
 * backup. `cp` would not do: with WAL on, the newest writes live in a sidecar
 * file that a naive copy leaves behind.
 */
async function cmdBackup(a: ParsedArgs): Promise<number> {
  const c = cfg();
  const target = a.positional[0] ?? defaultBackupPath(c.dbPath);
  if (a.positional.length > 1) return usage("cam backup [<file>]");

  return withHubAsync(async (db) => {
    const res = await backup(db, target);
    if (res.problems.length > 0) {
      log.fail(`The backup is corrupt (${res.problems.length} error(s)): ${res.problems.slice(0, 3).join("; ")}`);
      return EXIT_FAILED;
    }
    if (has(a, "json")) {
      log.result(JSON.stringify({ ...res, caseFold: checkPortability(db).caseFold }, null, 2));
      return EXIT_OK;
    }
    log.result(res.file);
    log.status(`${(res.bytes / 2 ** 20).toFixed(1)} MB, verified.`);
    const p = checkPortability(db);
    log.status(
      `To restore on another machine: copy it into place, or pass it with --db.` +
        (p.stamped ? ` On another OS, CAM_CASE_FOLD=${p.caseFold ? "1" : "0"} is required.` : ""),
    );
    return EXIT_OK;
  });
}

/**
 * Wiring the tool into everything on the machine that can use it: the MCP
 * config of every agent tool, a skill telling that agent when to reach for it,
 * a model for the dream phase taken from an agent CLI that is already here, and
 * the scheduled run.
 *
 * All four parts are optional and each is reported separately, because a
 * machine where three of them succeed and one fails is the normal case, and an
 * installer that collapses that into "done" is how a broken MCP entry goes
 * unnoticed for a week.
 */
async function cmdInstall(a: ParsedArgs, remove: boolean): Promise<number> {
  const scope: Scope = has(a, "project") ? "project" : "user";
  const dryRun = has(a, "dry-run");
  const only = flag(a, "client");
  if (only !== undefined && !isClientId(only)) {
    return usage("cam install --client <claude_code|claude_desktop|codex|cursor>");
  }
  const doDream = !has(a, "no-dream") && !remove;
  const doSchedule = !has(a, "no-schedule");

  // Checked here rather than only where the entry is built, because the
  // scheduled task would write the same doomed path, and --dry-run should
  // report the refusal instead of a plan that cannot be carried out.
  if (!remove && ephemeralRoot()) {
    log.fail(new EphemeralInstallError(installRoot()).message);
    return 1;
  }

  const report = (remove ? uninstall : install)({
    scope,
    only: only ? [only] : [],
    mcp: !has(a, "no-mcp"),
    skills: !has(a, "no-skills"),
    dryRun,
  });

  const verb = remove ? "uninstall" : "install";
  log.status(`${scope === "project" ? "Project" : "User"}-level ${verb}${dryRun ? " (dry run)" : ""}`);
  if (!remove) {
    log.status(`server command:  ${[report.entry.command, ...(report.entry.args ?? [])].join(" ")}`);
    // Where the index lands is not obvious — a checkout that already has one
    // keeps it, everything else goes to the user data directory — and every
    // part of this install (MCP, schedule) will read exactly this file.
    log.status(`index:           ${loadConfig().dbPath}`);
  }
  log.status("");

  let failed = false;
  for (const c of report.clients) {
    if (!c.installed) {
      log.detail(`${c.name.padEnd(24)} not installed`);
      continue;
    }
    if (c.error) {
      log.fail(`${c.name.padEnd(24)} ERROR — ${c.error}`);
      failed = true;
      continue;
    }
    const parts = [
      c.mcpChange ? `MCP ${c.mcpChange}` : null,
      c.skillChange
        ? `skill ${c.skillChange}`
        : // A client with no skill directory is not a failure: the server's own
          // instructions reach it with every response.
          !has(a, "no-skills")
          ? "skill: not supported"
          : null,
    ].filter((p): p is string => p !== null);
    log.status(`${c.name.padEnd(24)} ${parts.join("  ·  ") || "nothing to do"}`);
    if (c.mcpFile) log.detail(`  ${c.mcpFile}`);
    if (c.skillFile) log.detail(`  ${c.skillFile}`);
  }
  for (const b of report.backups) log.detail(`backup: ${b}`);

  if (doDream) failed = (await installDream(a, dryRun)) || failed;
  else if (remove && clearDreamConfig()) log.status("\ndream model: removed from the config");

  if (doSchedule) failed = installSchedule(dryRun, remove, has(a, "force")) || failed;

  log.status("");
  if (dryRun) {
    log.status("Dry run: no files were changed. Run without --dry-run to apply.");
  } else if (failed) {
    // Partial success is the normal case, and calling it "done" is how a
    // broken entry goes unnoticed for a week. On stderr with the errors it
    // belongs to, so the verdict cannot land above the reason for it.
    log.fail(`Partially ${remove ? "uninstalled" : "installed"} — the parts that failed were skipped.`);
  } else if (remove) {
    log.status("Done. The index is untouched — cam forget or deleting the file removes it.");
  } else {
    log.status("Done. Restart the agent clients so they pick up the server.");
  }
  return failed ? EXIT_FAILED : EXIT_OK;
}

/**
 * Give the dream phase a model taken from an agent CLI already on the machine,
 * and prove it answers before writing it down. A template with the wrong flag
 * is indistinguishable from a working one until the first nightly run fails
 * into a log nobody reads, so the installer spends thirty seconds finding out.
 *
 * Returns true on failure, so the caller can finish the other parts and still
 * exit non-zero.
 */
async function installDream(a: ParsedArgs, dryRun: boolean): Promise<boolean> {
  log.status("");
  const found = dreamCandidates();
  if (found.length === 0) {
    for (const line of noCandidatesHint.split("\n")) log.status(`dream model: ${line}`);
    return false;
  }

  const wanted = flag(a, "dream");
  if (wanted !== undefined && !found.some((c) => c.id === wanted)) {
    log.fail(`dream model: not installed: ${wanted} (have: ${found.map((c) => c.id).join(", ")})`);
    return true;
  }

  // Which tool and which model are the two things the installer cannot work
  // out: they depend on which subscription the user would rather spend. So it
  // asks, and falls back to trying everything in order when there is nobody to
  // answer — a script gets the same command without a prompt hanging in it.
  let queue = wanted !== undefined ? found.filter((c) => c.id === wanted) : found;
  let model = flag(a, "model") ?? null;

  if (wanted === undefined && interactive() && !dryRun) {
    const pick = await select(
      "dream model — which tool should write the summaries?",
      found.map((c) => ({ value: c.id, label: c.name, hint: describeBin(c) })),
      { escape: "none (the dream phase stays without a model)" },
    );
    if (pick === null) {
      log.status("dream model: skipped.");
      return false;
    }
    queue = found.filter((c) => c.id === pick);
  } else {
    log.status(`dream model — found: ${found.map((c) => c.id).join(", ")}`);
  }

  if (model === null && queue.length === 1 && interactive() && !dryRun) {
    model = await chooseModel(queue[0]!);
  }

  const problems: string[] = [];
  for (const candidate of queue) {
    if (candidate.modelRequired && !model) candidate.models = listModels(candidate);

    let dream;
    try {
      dream = dreamConfigFor(candidate, model);
    } catch (err) {
      if (err instanceof DreamModelRequiredError) {
        problems.push(`${candidate.name}: ${err.message}`);
        continue;
      }
      throw err;
    }

    log.status(`  ${candidate.name}: ${(dream.command ?? []).join(" ")}`);
    if (dryRun) {
      log.status("  dry run: not writing the config, and not calling it.");
      return false;
    }

    log.detail("    sending it a short prompt…");
    const probe = await probeDream(dream);
    if (probe.ok) {
      writeDreamConfig(dream);
      log.status(`  answered in ${probe.ms} ms: ${probe.answer.replace(/\s+/g, " ").slice(0, 60)}`);
      log.status(`  written: ${configFilePath()}  ·  usage: cam memory dream`);
      for (const p of problems) log.detail(`  (skipped — ${p})`);
      return false;
    }
    problems.push(`${candidate.name}: ${probe.error}`);
    log.status(`  did not answer (${probe.ms} ms), trying the next`);
  }

  for (const p of problems) log.fail(`  ${p}`);
  log.fail("  none answered; nothing was written to the config.");
  log.fail("  Specific tool: --dream <id>, model: --model <name>, skip: --no-dream");
  return true;
}

/**
 * Three of these tools can say what they are able to run; the rest cannot, and
 * inventing a list for them here would be stale within weeks. Either way,
 * naming no model is a valid answer that leaves the tool on its own default.
 */
async function chooseModel(candidate: DreamCandidate): Promise<string | null> {
  candidate.models = listModels(candidate);
  const own = "the tool's default";

  if (candidate.models.length === 0) {
    const typed = await ask(`Model for ${candidate.name} (leave empty for ${own}): `);
    return typed || null;
  }

  const picked = await select(
    `Model — ${candidate.name} offers these:`,
    candidate.models.map((m) => ({ value: m.id, label: m.id, hint: m.label })),
    candidate.modelRequired ? {} : { escape: own },
  );
  return picked;
}

function installSchedule(dryRun: boolean, remove: boolean, force: boolean): boolean {
  log.status("");
  const plan = schedulePlan({ node: resolved(process.execPath), cli: fileURLToPath(import.meta.url) });
  log.status(`schedule (${plan.mechanism}):`);

  if (!remove) {
    const { state, current } = scheduleState(plan);
    if (state === "same") {
      log.status(`  ${plan.jobs.join(", ")} — already set up, nothing to do`);
      return false;
    }
    if (state === "different" && !force) {
      // Re-registering would take the jobs over silently, and the previous
      // owner would look installed while nothing runs on its behalf. One call,
      // so stdout cannot interleave itself into the middle of the reason.
      log.fail(
        [
          `  ${plan.jobs.join(", ")} — ERROR: already registered, but points at a different copy:`,
          `    now: ${current}`,
          `    this copy: ${plan.cli}`,
          "    to take over: cam install --force, or first from the other copy: cam uninstall",
        ].join("\n"),
      );
      return true;
    }
  }

  if (dryRun) {
    for (const f of plan.files) log.status(`  file: ${f.path}`);
    for (const s of remove ? plan.remove : plan.install) {
      log.status(`  ${s.describe}`);
      log.detail(`    ${s.argv.join(" ")}`);
    }
    return false;
  }

  let failed = false;
  for (const r of applySchedule(plan, remove)) {
    if (r.ok) log.status(`  ${r.describe}`);
    else {
      log.fail(`  ${r.describe} — ERROR: ${r.detail}`);
      failed = true;
    }
  }
  for (const n of plan.notes) log.warn(n);
  if (!failed && !remove) log.status("  check: cam status");
  return failed;
}

function usage(line: string): number {
  log.fail(`Usage: ${line}`);
  return EXIT_USAGE;
}

function reportErrors(a: ParsedArgs): number {
  for (const e of a.errors) log.fail(`Error: ${e}`);
  return EXIT_USAGE;
}

const USAGE = `cam — shared context from Claude Code / Claude Desktop / Codex / Cursor conversations

  cam sync [--repair] [--tool <name>]    read sources (incremental)
  cam projects [--unattributed]          projects, or unattributed sessions
  cam timeline <project> [--since d]     timeline across every tool
  cam dossier <project> [--json]         the full picture of a project
  cam recall "<query>" [--project p]     search the conversations
  cam get <tool:id[#seqN-M]>             full text of a hit or session
  cam alias <folder> <project>           merge two folders into one project
  cam attribute <tool:id> <project>      manual attribution (overrides everything)
  cam reattribute                        recompute without reading stores
  cam rebuild                            rebuild the text index from sources
  cam memory <subcommand>                long-term memory (see below)

  cam status [--json]                    when the index last synced
  cam doctor                             health report
  cam prune [--vacuum] [--dry-run]       retention: old traces, logs, missing sources
  cam forget --project <p> | <tool:id>   forget a project or session
  cam backup [<file>]                    verified copy of the index
  cam memory consolidate [--budget N]    promote from the recall trace
  cam memory list [--project p]          the promoted facts
  cam memory show <id>                   one fact with its evidence
  cam memory dream [--dry-run]           write a summary with a model (optional)
  cam memory topics                      recurring topics
  cam memory status                      how much trace gathered, what was promoted

  cam install [--dry-run] [--project]    wire into every agent tool found:
                                         MCP server, skill, dream model, schedule
  cam uninstall [--dry-run]              the same in reverse; does not touch the index

Shared flags: --json, --limit N, --tool <tool>, --include-weak,
              --db <path> (index location; see: cam doctor),
              --quiet (errors only), --verbose (details)
Exit code: 0 ok, 1 error, 2 bad usage.
Scheduling (Task Scheduler, launchd, systemd, cron): docs/operations.md
`;

/** Every command returns its exit code; nothing here calls process.exit. */
export async function run(argv: ReadonlyArray<string>): Promise<number> {
  const [cmd, ...rest] = argv;

  // A fresh level every run: `run()` is called repeatedly in-process by the
  // tests, and a leftover --quiet would silence the next command.
  log.setLogLevel("normal");

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    log.result(USAGE);
    return EXIT_OK;
  }

  const raw = SPECS[cmd];
  const spec = raw ? withGlobals(raw) : undefined;
  if (!spec) {
    log.fail(`Unknown command: ${cmd}\n`);
    log.fail(USAGE);
    return EXIT_USAGE;
  }

  const a = parseArgs(rest, spec);
  if (a.errors.length > 0) return reportErrors(a);
  if (has(a, "quiet") && has(a, "verbose")) return usage("--quiet and --verbose cannot be used together");
  log.setLogLevel(has(a, "quiet") ? "quiet" : has(a, "verbose") ? "verbose" : "normal");
  cliOverrides = flag(a, "db") ? { dbPath: flag(a, "db") } : {};

  try {
    switch (cmd) {
      case "sync":
        return await cmdSync(a);
      case "projects":
        return cmdProjects(a);
      case "timeline":
        return cmdTimeline(a);
      case "dossier":
        return cmdDossier(a);
      case "recall":
        return cmdRecall(a);
      case "get":
        return cmdGet(a);
      case "alias":
        return cmdAlias(a);
      case "attribute":
        return cmdAttribute(a);
      case "reattribute":
        return cmdReattribute();
      case "rebuild":
        return cmdRebuild();
      case "memory":
        return await cmdMemory(a);
      case "status":
        return cmdStatus(a);
      case "doctor":
        return cmdDoctor();
      case "prune":
        return cmdPrune(a);
      case "forget":
        return cmdForget(a);
      case "backup":
        return await cmdBackup(a);
      case "install":
        return await cmdInstall(a, false);
      case "uninstall":
        return await cmdInstall(a, true);
      default:
        log.fail(USAGE);
        return EXIT_USAGE;
    }
  } catch (err) {
    // A damaged hub is the one failure with a named way out; everything else
    // keeps its stack trace.
    if (err instanceof HubUnreadableError || isCorruption(err)) {
      log.fail(`The database is corrupt: ${(err as Error).message}`);
      log.fail("Run: cam doctor — for options; sources are untouched.");
      return EXIT_FAILED;
    }
    log.fail(err instanceof Error ? err.stack ?? String(err) : String(err));
    return EXIT_FAILED;
  }
}

/**
 * Was this file run, or imported? A filename match would also fire on an
 * import, so the two paths are compared in full — but resolved first.
 *
 * Node hands out `import.meta.url` with symlinks resolved and `process.argv[1]`
 * exactly as the shell wrote it, and a Node version manager puts a symlink in
 * the middle of every global install (`C:\nvm\current`, `~/.nvm/versions/...`).
 * Comparing them raw made the globally installed CLI do nothing at all and exit
 * zero, which a scheduled task reports as an hourly success.
 */
export function isEntryPoint(entry = import.meta.url, argv1 = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(fileURLToPath(entry)) === real(argv1);
}

if (isEntryPoint()) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exitCode = EXIT_FAILED;
    },
  );
}
