#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configFilePath, loadConfig, type HubConfig } from "./config.js";
import {
  HubUnreadableError,
  SchemaTooNewError,
  getMeta,
  setMeta,
  initSchema,
  isCorruption,
  openHub,
  openSourceReadonly,
  quickCheck,
  sqliteVersion,
  type Db,
} from "./db/open.js";
import { TOOL_IDS } from "./db/schema.js";
import { isEntryPoint as isEntry } from "./entry.js";
import { acquireLock, describeHolder } from "./db/lock.js";
import { checkPortability } from "./db/portability.js";
import { claudeCodeCollector } from "./collectors/claude-code.js";
import { claudeDesktopCollector } from "./collectors/claude-desktop.js";
import { codexCollector } from "./collectors/codex.js";
import { coworkCollector } from "./collectors/cowork.js";
import { cursorCollector } from "./collectors/cursor.js";
import { cursorHistoryCollector } from "./collectors/cursor-history.js";
import { geminiCliCollector } from "./collectors/gemini-cli.js";
import { devinCliCollector } from "./collectors/devin-cli.js";
import { devinCascadeCollector } from "./collectors/devin-cascade.js";
import { antigravityCollector } from "./collectors/antigravity.js";
import { artifactsCollector } from "./collectors/artifacts.js";
import type { Collector, CollectorCtx } from "./collectors/types.js";
import {
  DEFAULT_REPO,
  UpdateDisabledError,
  fetchLatestRelease,
  installedVersion,
  latestReleaseUrl,
  verdict,
} from "./update/check.js";
import {
  downloadRelease,
  installTarball,
  isSelfReplacing,
  postUpdateWithNewBinary,
  stageUpdater,
} from "./update/apply.js";
import { findRunningServers, stopServers } from "./update/servers.js";
import { DaemonSession } from "./sources/language-server.js";
import { fetchConversation } from "./sources/antigravity-fetch.js";
import { fetchDevinCascade } from "./sources/devin-fetch.js";
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
import {
  DocsError,
  collectionName,
  docsDbPath,
  formatCollections,
  formatDocHits,
  formatNotes,
  KNOWN_DEFAULTS,
  knownOptions,
  openDocs,
  planKnown,
  qmdInstalled,
  rememberKey,
  type DocsIndex,
  type KnownOptions,
  type KnownPlan,
  type KnownProject,
} from "./docs/files.js";
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
import { getTurns, parseCitation, recallWithEmbeddings } from "./query/recall.js";
import { planEmbeddings, runEmbeddings } from "./search/embeddings.js";
import {
  EphemeralInstallError,
  ephemeralRoot,
  install,
  refreshSkills,
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
  geminiCliCollector,
  devinCliCollector,
  devinCascadeCollector,
  antigravityCollector,
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
  try {
    initSchema(db);
  } catch (err) {
    // `withHub` only closes what `open` returned, so a schema that refuses to
    // load here would leave the handle open for the life of the process — and
    // on Windows that keeps a lock on a file the caller may want to move.
    db.close();
    throw err;
  }
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
  get: { bools: [...(QUERY_FLAGS.bools ?? []), "refresh"], values: [...(QUERY_FLAGS.values ?? [])] },
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
  docs: { bools: [...(QUERY_FLAGS.bools ?? []), "known", "dry-run", "force"], values: [...(QUERY_FLAGS.values ?? []), "project", "pattern", "collection"] },
  note: { bools: [...(QUERY_FLAGS.bools ?? [])], values: ["collection"] },
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
      "refresh-skills",
    ],
    values: [...(QUERY_FLAGS.values ?? []), "client", "dream", "model"],
  },
  uninstall: {
    bools: [...(QUERY_FLAGS.bools ?? []), "project", "dry-run", "no-mcp", "no-skills", "no-dream", "no-schedule"],
    values: [...(QUERY_FLAGS.values ?? []), "client"],
  },
  update: {
    bools: [...(QUERY_FLAGS.bools ?? []), "check", "dry-run", "yes", "keep-servers"],
    values: [...(QUERY_FLAGS.values ?? []), "repo"],
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

    // Only a full sync: `--tool` asks about one conversation store.
    if (!only) errors += await refreshDocs(db);

    // A repair sync is the one step every released updater runs with the NEW
    // binary, so it is where the installed skills catch up with it — an
    // updater staged by an older version knows nothing of --refresh-skills.
    if (repair && !only) refreshInstalledSkills();

    // A scheduled run learns about a broken source only from the exit code, so
    // this stays visible even under --quiet.
    if (errors > 0) log.fail(`${errors} error(s) during sync`);
    return errors > 0 ? EXIT_FAILED : EXIT_OK;
  });
}

/**
 * Folders `cam docs add --known` leaves alone, with the reason: removed by the
 * user, or found too large. Kept in the hub, because the hub is what knows the
 * projects; the file index only knows what it was given.
 */
const DOCS_SKIPPED = "docs_skipped";

function readSkipped(db: Db): Record<string, string> {
  try {
    const parsed = JSON.parse(getMeta(db, DOCS_SKIPPED) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeSkipped(db: Db, skipped: Record<string, string>): void {
  setMeta(db, DOCS_SKIPPED, JSON.stringify(skipped));
}

/** Every project with a learned folder, and when it was last worked on. */
function knownProjects(db: Db): KnownProject[] {
  return (
    db
      .prepare(
        `select p.key, p.root_path root, max(coalesce(s.ended_ms, s.started_ms)) last_ms
         from projects p join sessions s on s.project_id = p.id
         group by p.id order by last_ms desc`,
      )
      .all() as Array<{ key: string; root: string | null; last_ms: number | null }>
  ).map((r) => ({ key: r.key, root: r.root, lastMs: r.last_ms }));
}

/** Plan, and unless it is a dry run, add. Indexing the added ones is the caller's. */
async function addKnown(db: Db, docs: DocsIndex | null, opts: Required<KnownOptions>, dryRun: boolean): Promise<KnownPlan> {
  const skipped = readSkipped(db);
  const plan = await planKnown(knownProjects(db), docs ? await docs.list() : [], skipped, opts);
  if (dryRun || !docs) return plan;
  for (const x of plan.add) await docs.add(x.root, { name: x.name });
  if (Object.keys(plan.remember).length > 0) writeSkipped(db, { ...skipped, ...plan.remember });
  return plan;
}

/**
 * Keep the project file index current alongside the conversations, so an
 * agent searching it through the MCP server — which never writes — sees the
 * files as they are. Incremental by content hash: an unchanged project costs a
 * directory walk. Skipped without a word when nothing was ever indexed, unless
 * `docs.autoAdd` asks for the known projects to be added as they appear.
 */
async function refreshDocs(db: Db): Promise<number> {
  const c = cfg();
  if (c.docs.enabled === false) return 0;
  const auto = knownOptions(c.docs);
  const t0 = Date.now();
  let docs: DocsIndex | null = null;
  try {
    docs = await openDocs(docsDbPath(c.dbPath, c.docs), { create: auto !== null, maxFileBytes: c.docs.maxFileBytes });
    if (!docs) return 0;
    let added = 0;
    if (auto) {
      const plan = await addKnown(db, docs, auto, false);
      added = plan.add.length;
      for (const x of plan.add) log.detail(`  + ${x.name.padEnd(28)} ${x.root}`);
    }
    const r = await docs.refresh();
    if (r.collections === 0) return 0;
    log.status(
      `${"project files".padEnd(15)} collection:${String(r.collections).padStart(2)}${added ? ` (+${added})` : ""}` +
        `  changed:${r.checked}  new:${r.indexed}  updated:${r.updated}  removed:${r.removed}  ${Date.now() - t0} ms`,
    );
    return 0;
  } catch (err) {
    log.fail(`${"project files".padEnd(15)} ERROR: ${(err as Error).message}`);
    return 1;
  } finally {
    await docs?.close();
  }
}

/** Open the file index for a command, or say why it cannot be. */
async function withDocs(fn: (docs: DocsIndex) => Promise<number>, create = true): Promise<number> {
  const c = cfg();
  if (c.docs.enabled === false) {
    log.fail('Project file search is turned off in the config ("docs": { "enabled": false }).');
    return EXIT_FAILED;
  }
  let docs: DocsIndex | null = null;
  try {
    docs = await openDocs(docsDbPath(c.dbPath, c.docs), { create, maxFileBytes: c.docs.maxFileBytes });
    if (!docs) {
      log.result("No file collections. Add one with: cam docs add [path]");
      return EXIT_OK;
    }
    return await fn(docs);
  } catch (err) {
    if (!(err instanceof DocsError)) throw err;
    log.fail(err.message);
    return EXIT_FAILED;
  } finally {
    await docs?.close();
  }
}

/**
 * A project's own files, searched by keyword. `add` also indexes, because a
 * collection nobody has indexed answers every question with silence.
 */
async function cmdDocs(a: ParsedArgs): Promise<number> {
  const [sub = "list", ...rest] = a.positional;
  const max = limit(a, 10, 50);
  if (a.errors.length > 0) return reportErrors(a);
  const json = has(a, "json");

  switch (sub) {
    case "add":
      if (has(a, "known")) {
        if (rest.length > 0) return usage("cam docs add --known [--dry-run]");
        return cmdDocsKnown(has(a, "dry-run"), json);
      }
      if (rest.length > 1) return usage("cam docs add [path] [--project p] [--pattern glob] | --known");
      return withDocs(async (docs) => {
        const project = flag(a, "project");
        const added = await docs.add(rest[0] ?? process.cwd(), {
          name: project ? collectionName(project) : undefined,
          pattern: flag(a, "pattern"),
        });
        // Added by hand overrides an earlier "removed" or "too large".
        withHub((db) => {
          const skipped = readSkipped(db);
          if (delete skipped[rememberKey(added.root)]) writeSkipped(db, skipped);
        });
        const t0 = Date.now();
        const r = await docs.refresh([added.name]);
        if (json) {
          log.result(JSON.stringify({ ...added, ...r }, null, 2));
        } else {
          log.status(`collection ${added.name} -> ${added.root}`);
          log.result(`${r.indexed + r.updated + r.unchanged} file(s) indexed, ${Date.now() - t0} ms`);
        }
        return EXIT_OK;
      });
    case "list":
      return withDocs(async (docs) => {
        const rows = await docs.list();
        log.result(json ? JSON.stringify(rows, null, 2) : formatCollections(rows));
        return EXIT_OK;
      }, false);
    case "index":
      return withDocs(async (docs) => {
        const t0 = Date.now();
        const r = await docs.refresh(rest, { force: has(a, "force") });
        // Removed files leave their text behind until the index is compacted;
        // this is the explicit command, so it pays for that here and not in
        // every scheduled sync.
        const compacted = r.removed > 0 ? await docs.compact() : null;
        if (json) {
          log.result(JSON.stringify({ ...r, compacted }, null, 2));
        } else {
          log.result(
            `${r.collections} collection(s), ${r.checked} changed: new ${r.indexed}, updated ${r.updated}, ` +
              `unchanged ${r.unchanged}, removed ${r.removed} — ${Date.now() - t0} ms`,
          );
          if (compacted) {
            const mb = (n: number): string => (n / 2 ** 20).toFixed(1);
            log.status(`compacted: ${mb(compacted.before)} MB -> ${mb(compacted.after)} MB`);
          }
        }
        return EXIT_OK;
      }, false);
    case "query":
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) return usage('cam docs query "<words>" [--collection c] [--limit N]');
      return withDocs(async (docs) => {
        const hits = await docs.search(query, { collection: flag(a, "collection"), limit: max });
        log.result(json ? JSON.stringify(hits, null, 2) : formatDocHits(hits, query));
        return EXIT_OK;
      }, false);
    }
    case "get": {
      const target = rest[0];
      if (!target || rest.length > 1) return usage("cam docs get <path|collection/path|#docid>");
      return withDocs(async (docs) => {
        const doc = await docs.read(target, { collection: flag(a, "collection") });
        if (!doc) {
          log.fail(`Not in any collection: ${target}`);
          return EXIT_FAILED;
        }
        log.result(json ? JSON.stringify(doc, null, 2) : doc.text);
        return EXIT_OK;
      }, false);
    }
    case "remove":
    case "rm": {
      const name = rest[0];
      if (!name || rest.length > 1) return usage("cam docs remove <collection>");
      return withDocs(async (docs) => {
        const root = (await docs.list()).find((c) => c.name === name)?.root;
        if (root && (await docs.remove(name))) {
          // Otherwise `--known` and `autoAdd` would put it straight back.
          withHub((db) => writeSkipped(db, { ...readSkipped(db), [rememberKey(root)]: "removed by the user" }));
          log.result(`removed ${name}`);
          return EXIT_OK;
        }
        log.fail(`No such collection: ${name}`);
        return EXIT_FAILED;
      }, false);
    }
    default:
      return usage("cam docs <add|list|index|query|get|remove>");
  }
}

/**
 * Index the projects the hub already knows, where their folder is still there
 * and they were worked on recently. The rest are listed with the reason.
 */
async function cmdDocsKnown(dryRun: boolean, json: boolean): Promise<number> {
  const c = cfg();
  if (c.docs.enabled === false) {
    log.fail('Project file search is turned off in the config ("docs": { "enabled": false }).');
    return EXIT_FAILED;
  }
  const opts = knownOptions(c.docs) ?? { ...KNOWN_DEFAULTS };
  return withHubAsync(async (db) => {
    let docs: DocsIndex | null = null;
    try {
      // A dry run creates nothing, not even an empty index.
      docs = await openDocs(docsDbPath(c.dbPath, c.docs), { create: !dryRun, maxFileBytes: c.docs.maxFileBytes });
      const t0 = Date.now();
      const plan = await addKnown(db, docs, opts, dryRun);
      const r = !dryRun && docs && plan.add.length > 0 ? await docs.refresh(plan.add.map((x) => x.name)) : null;
      if (json) {
        log.result(JSON.stringify({ add: plan.add, skip: plan.skip, indexed: r }, null, 2));
        return EXIT_OK;
      }
      for (const x of plan.add) {
        log.result(`${dryRun ? "would add" : "added    "}  ${x.name.padEnd(30)} ${String(x.files).padStart(5)} file(s)  ${x.root}`);
      }
      // Inactive projects are the long tail; a count says enough about them.
      const inactive = plan.skip.filter((x) => x.reason.startsWith("no session in"));
      for (const x of plan.skip) {
        if (inactive.includes(x)) continue;
        log.status(`skipped    ${x.key.padEnd(30)} ${x.reason}${x.root ? `  ${x.root}` : ""}`);
      }
      if (inactive.length > 0) log.status(`skipped    ${inactive.length} project(s) with no session in ${opts.sinceDays} days`);
      log.status(
        dryRun
          ? `${plan.add.length} project(s) would be added. Run without --dry-run to index them.`
          : `${plan.add.length} project(s) added${r ? `, ${r.indexed} file(s) indexed` : ""}, ${Date.now() - t0} ms`,
      );
      return EXIT_OK;
    } catch (err) {
      if (!(err instanceof DocsError)) throw err;
      log.fail(err.message);
      return EXIT_FAILED;
    } finally {
      await docs?.close();
    }
  });
}

/** What a file or folder is for, kept next to the path it is about. */
async function cmdNote(a: ParsedArgs): Promise<number> {
  const [sub = "list", ...rest] = a.positional;
  if (a.errors.length > 0) return reportErrors(a);
  const collection = flag(a, "collection");

  switch (sub) {
    case "add":
    case "set": {
      const [target, ...words] = rest;
      const text = words.join(" ").trim();
      if (!target || !text) return usage('cam note add <path> "<what it is for>"');
      return withDocs(async (docs) => {
        const n = await docs.note(target, text, { collection });
        log.result(has(a, "json") ? JSON.stringify(n, null, 2) : `${n.collection}/${n.path}\n  ${n.note}`);
        return EXIT_OK;
      }, false);
    }
    case "rm":
    case "remove": {
      const target = rest[0];
      if (!target || rest.length > 1) return usage("cam note rm <path>");
      return withDocs(async (docs) => {
        if (await docs.unnote(target, { collection })) {
          log.result(`removed the note on ${target}`);
          return EXIT_OK;
        }
        log.fail(`No note on ${target}`);
        return EXIT_FAILED;
      }, false);
    }
    case "list":
      return withDocs(async (docs) => {
        const notes = await docs.notes(collection);
        log.result(has(a, "json") ? JSON.stringify(notes, null, 2) : formatNotes(notes));
        return EXIT_OK;
      }, false);
    default:
      return usage("cam note <add|list|rm>");
  }
}

/**
 * Rewrite the skills cam installed earlier to this version's text. Never adds
 * one, and never fails the caller: a skill that cannot be written is reported,
 * and the old text keeps working until the next try.
 */
function refreshInstalledSkills(): void {
  try {
    // CAM_HOME stands in for the profile everywhere else, and must here too:
    // a test's repair sync would otherwise rewrite the developer's own skills.
    for (const r of refreshSkills({ home: process.env.CAM_HOME || undefined })) {
      if (r.change === "updated") log.status(`${"skill".padEnd(15)} ${r.client}: updated to this version`);
    }
  } catch (err) {
    log.warn(`skills not refreshed: ${(err as Error).message}`);
  }
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

async function cmdRecall(a: ParsedArgs): Promise<number> {
  const query = a.positional.join(" ");
  if (!query) return usage('cam recall "<query>"');
  const max = limit(a, 10);
  const sinceMs = dateFlag(a, "since");
  if (a.errors.length > 0) return reportErrors(a);

  return withHubAsync(async (db) => {
    const hits = await recallWithEmbeddings(db, {
      query,
      project: flag(a, "project") ?? null,
      tool: flag(a, "tool") ?? null,
      sinceMs,
      limit: max,
      minConfidence: has(a, "include-weak") ? "weak" : "medium",
    }, cfg().embedding, log.warn);
    log.result(has(a, "json") ? JSON.stringify(hits, null, 2) : formatRecall(hits, query));
    return EXIT_OK;
  });
}

/**
 * The other half of `cam recall`: the citations it prints are only useful if
 * something can open them. Same parser, same renderer and same failure modes as
 * the `cam_get` tool — a hit found in the terminal reads the same way there.
 */
async function cmdGet(a: ParsedArgs): Promise<number> {
  const [citation, ...extra] = a.positional;
  if (!citation || extra.length > 0) return usage("cam get <tool:sessionId[#seqN-M]>");
  if (a.errors.length > 0) return reportErrors(a);

  const parsed = parseCitation(citation);
  if (!parsed) {
    log.fail(`Unreadable citation: ${citation}\nThe form is tool:sessionId#seqN-M, as cam recall prints it.`);
    return EXIT_USAGE;
  }

  return withHubAsync(async (db) => {
    // An Antigravity conversation is in the index as a title, a working
    // directory and a time — its body is encrypted, and only Antigravity's own
    // daemon can undo that. Asking for one by name is exactly the moment to go
    // and get it, so this is the only place that does.
    if (parsed.tool === "antigravity") await hydrateAntigravity(db, parsed.sessionExtId, has(a, "refresh"));
    if (parsed.tool === "devin") await hydrateDevin(db, parsed.sessionExtId, has(a, "refresh"));

    const turns = getTurns(db, parsed.tool, parsed.sessionExtId, parsed.seqStart, parsed.seqEnd);
    if (turns.length === 0) {
      log.fail(`No such session: ${citation}`);
      return EXIT_FAILED;
    }
    log.result(has(a, "json") ? JSON.stringify(turns, null, 2) : formatTurns(turns));
    return EXIT_OK;
  });
}

/**
 * Bring one Antigravity conversation's text into the index, if it is not there.
 *
 * Never fatal: the conversation is worth showing with a title and a date even
 * when its body cannot be read, and "Antigravity is closed" is a normal state
 * rather than a failure.
 */
async function hydrateAntigravity(db: Db, cascadeId: string, force: boolean): Promise<void> {
  const session = new DaemonSession({ log: log.warn });
  try {
    const outcome = await fetchConversation(db, cascadeId, { session, log: log.warn, force });
    switch (outcome.status) {
      case "fetched":
        log.status(`read ${outcome.turns} turn(s) from Antigravity (${outcome.steps} steps)`);
        break;
      case "no-daemon":
        log.status(
          "Antigravity is not running, so this conversation's text cannot be read — " +
            "its body is encrypted on disk. Open Antigravity and ask again.",
        );
        break;
      case "failed":
        log.warn(`antigravity: ${outcome.detail}`);
        break;
      case "cached":
      case "not-found":
        break;
      default: {
        const _never: never = outcome;
        throw new Error(`unhandled antigravity fetch: ${String(_never)}`);
      }
    }
  } finally {
    session.close();
  }
}

/**
 * Bring one Devin Cascade conversation's text into the index, if it is not
 * a CLI session (those already have locators) and the desktop app is open.
 *
 * Never fatal: "Devin is closed" is a normal state rather than a failure.
 */
async function hydrateDevin(db: Db, cascadeId: string, force: boolean): Promise<void> {
  const session = new DaemonSession({ log: log.warn });
  try {
    const outcome = await fetchDevinCascade(db, cascadeId, {
      session,
      cascadeDir: path.join(cfg().roots.windsurfHome, "cascade"),
      log: log.warn,
      force,
    });
    switch (outcome.status) {
      case "fetched":
        log.status(`read ${outcome.turns} turn(s) from Devin (${outcome.steps} steps)`);
        break;
      case "no-daemon":
        log.status(
          "Devin is not running, so this conversation's text cannot be read — " +
            "its body is encrypted on disk. Open Devin and ask again.",
        );
        break;
      case "failed":
        log.warn(`devin: ${outcome.detail}`);
        break;
      case "cached":
      case "cli-session":
        break;
      default: {
        const _never: never = outcome;
        throw new Error(`unhandled devin fetch: ${String(_never)}`);
      }
    }
  } finally {
    session.close();
  }
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
    case "embed":
      return withHubAsync(async (db) => {
        const config = cfg().embedding;
        if (config.provider !== "command" || !config.model || !config.command?.length) {
          return usage("Configure memory.embedding with provider: command, model, and command; see docs/memory.md.");
        }
        const items = planEmbeddings(db, config, { project: flag(a, "project"), limit: max, force: has(a, "force") });
        log.fail(`${items.length} chunk(s) · ${items.reduce((sum, item) => sum + item.text.length, 0)} characters would go to embedding model ${config.model}`);
        if (has(a, "dry-run")) {
          log.result(JSON.stringify({ candidates: items.length, model: config.model, dryRun: true }));
          return EXIT_OK;
        }
        const stat = await runEmbeddings(db, config, items);
        log.result(has(a, "json") ? JSON.stringify(stat, null, 2) : `embeddings: ${stat.generated} generated, ${stat.failed} failed`);
        for (const error of stat.errors.slice(0, 5)) log.warn(error);
        return stat.failed ? EXIT_FAILED : EXIT_OK;
      });
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
      // This command hands promoted conversation excerpts to a model. Never
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
      return usage("cam memory <consolidate|list|show <id>|embed|dream [forget]|topics|status>");
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
    // Not a crash and not corruption: the index is simply newer than this
    // build. The message already says both ways out, so no stack trace.
    if (err instanceof SchemaTooNewError) {
      log.fail(err.message);
      return EXIT_FAILED;
    }
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
    // Every known tool, including zeros: a missing name looks like the
    // collector was never wired, which is a different fact from "nothing yet".
    const toolRows = db.prepare("select tool k, count(*) c from sessions group by k").all() as Array<{
      k: string;
      c: number;
    }>;
    const byTool = new Map(toolRows.map((r) => [r.k, r.c]));
    log.status("  tool: " + TOOL_IDS.map((id) => `${id}=${byTool.get(id) ?? 0}`).join("  "));

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

    // Read from the filesystem only: doctor must not depend on qmd loading.
    const docsPath = docsDbPath(c.dbPath, c.docs);
    log.status(
      `project files     ${
        c.docs.enabled === false
          ? "off in the config"
          : !qmdInstalled()
            ? "unavailable — qmd is not installed"
            : fs.existsSync(docsPath)
              ? docsPath
              : "none indexed (cam docs add [path])"
      }`,
    );

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
 * Looking for a newer release, and installing one.
 *
 * The second and last thing in this package that can reach the network. It is
 * off until the config file says otherwise, it prints what it is about to
 * contact BEFORE contacting it — on stderr, so `--quiet` cannot hide it — and
 * the request carries nothing about this machine.
 *
 * Two steps, deliberately: `--check` answers "am I behind" and stops there.
 * Changing what is installed is a separate decision, taken separately.
 */
async function cmdUpdate(a: ParsedArgs): Promise<number> {
  const config = cfg();
  const repo = flag(a, "repo") ?? config.update.repo ?? DEFAULT_REPO;
  const url = latestReleaseUrl(repo);
  const installed = installedVersion();
  const dryRun = has(a, "dry-run");
  const checkOnly = has(a, "check");

  // A dry run is the answer to "what would this contact?", so it must not
  // contact it. Nothing below this point runs.
  if (dryRun) {
    log.result(`installed:  ${installed}`);
    log.result(`would GET:  ${url}`);
    log.result("would send: nothing about this machine — no identifier, no telemetry.");
    if (has(a, "check")) {
      log.result("then:       report the comparison, install nothing.");
      return EXIT_OK;
    }
    log.result("then:       download the tarball, stop any running cam-mcp server, npm install -g it,");
    log.result("            open the index with the new binary so it migrates now, then cam sync --repair.");
    const running = findRunningServers();
    log.result(
      running.listed
        ? `would stop: ${running.servers.length} cam-mcp server(s)${running.servers.length > 0 ? ` (pid ${running.servers.map((s) => s.pid).join(", ")})` : ""}`
        : `would stop: unknown — could not list processes (${running.detail})`,
    );
    log.result(
      isSelfReplacing()
        ? "install by: a script in a temp directory, after this process exits (it would be replacing itself)"
        : "install by: this process (the running copy is not the one npm would replace)",
    );
    return EXIT_OK;
  }

  if (config.update.enabled !== true) {
    log.fail(new UpdateDisabledError(configFilePath()).message);
    return EXIT_FAILED;
  }

  // The disclosure is not a progress report: it stays on stderr at every
  // level, including --quiet, and it happens before the request.
  log.fail(`contacting ${url} — one GET, nothing about this machine goes with it.`);

  let release;
  try {
    release = await fetchLatestRelease({ repo });
  } catch (err) {
    log.fail(`update check failed: ${(err as Error).message}`);
    return EXIT_FAILED;
  }

  const state = verdict(installed, release.version);
  if (has(a, "json")) {
    log.result(
      JSON.stringify(
        { installed, latest: release.version, tag: release.tag, state, releaseUrl: release.htmlUrl },
        null,
        2,
      ),
    );
  } else {
    log.result(`installed ${installed}  ·  latest ${release.version}  ·  ${state}`);
    if (state === "behind") log.result(`  ${release.htmlUrl}`);
  }

  if (checkOnly || state !== "behind") return EXIT_OK;

  if (!has(a, "yes")) {
    log.result("");
    log.result(`To install ${release.tag}: cam update --yes`);
    return EXIT_OK;
  }

  if (!release.assetUrl) {
    log.fail(`release ${release.tag} has no packed tarball attached — install it by hand.`);
    return EXIT_FAILED;
  }

  log.fail(`downloading ${release.assetName} from ${release.assetUrl}`);
  let downloaded;
  try {
    downloaded = await downloadRelease(release);
  } catch (err) {
    log.fail(`download failed: ${(err as Error).message}`);
    return EXIT_FAILED;
  }

  // Nothing else may be running while the package is replaced and the index is
  // migrated. Two different things can be: a scheduled `cam sync`, which the
  // hub lock stops cleanly, and a live MCP server, which holds the files npm
  // is about to overwrite.
  return withHub((db) => {
    const lock = acquireLock(db, "update");
    if (!lock.ok) {
      log.fail(`Already running: ${lock.heldBy.what} (${describeHolder(lock.heldBy)}) — not updating.`);
      return EXIT_FAILED;
    }
    try {
      if (!quiesceServers(has(a, "keep-servers"))) return EXIT_FAILED;

      // A program cannot overwrite the files it is running from: on Windows
      // npm cannot replace them at all, and everywhere else this process would
      // carry on executing code that no longer matches the disk. When the
      // running copy IS the global one, the install is handed to a script in a
      // temporary directory that waits for this process to exit first.
      if (isSelfReplacing()) {
        const staged = stageUpdater({ tarball: downloaded.file, dbPath: config.dbPath });
        log.status(`handing the install to ${staged.script} (pid ${staged.pid ?? "?"})`);
        log.result("");
        log.result(`Installing ${release.tag} after this process exits.`);
        log.result(`  log:    ${staged.logFile}`);
        log.result("  verify: cam update --check");
        return EXIT_OK;
      }

      let result = installTarball(downloaded.file);
      for (let i = 1; !result.ok && i < 5; i++) {
        log.status(`install retry ${i}: ${result.detail}`);
        if (!quiesceServers(has(a, "keep-servers"))) return EXIT_FAILED;
        result = installTarball(downloaded.file);
      }
      if (!result.ok) {
        log.fail(`${result.command}: ${result.detail}`);
        return EXIT_FAILED;
      }
      log.status(`installed ${release.tag} (${downloaded.bytes} bytes)`);
    } finally {
      lock.handle.release();
    }

    // Migrate NOW, and with the new binary.
    //
    // The schema only ever moves forward, and a release may add columns. This
    // process is still the OLD code, so it must not open the index itself: it
    // would migrate to the version it knows, not the one just installed. Left
    // alone, the first thing to open the index would be the scheduled sync at
    // 04:00, where a failed migration is invisible until someone goes looking.
    //
    // The lock is released first: the new binary opens the same index, and
    // would find it held by this process.
    const migrated = postUpdateWithNewBinary(config.dbPath);
    log.status(`index: ${migrated.detail}`);
    return finishUpdate(migrated.ok);
  });
}

/**
 * Stop the MCP servers still running the version being replaced.
 *
 * Returns false when the update must not go ahead: a server we could not stop
 * still holds the files npm is about to overwrite, and a half-written package
 * is worse than an update that did not happen.
 */
function quiesceServers(keep: boolean): boolean {
  const found = findRunningServers();
  if (!found.listed) {
    // Not knowing is not the same as none. Say which happened.
    log.status(`could not list processes (${found.detail}) — close any editor using cam before continuing.`);
    return true;
  }
  if (found.servers.length === 0) return true;

  if (keep) {
    log.status(`${found.servers.length} cam-mcp server(s) left running at your request.`);
    return true;
  }

  log.fail(
    `stopping ${found.servers.length} running cam-mcp server(s): ${found.servers.map((s) => s.pid).join(", ")}` +
      " — the MCP client starts a fresh one on its next tool call.",
  );
  const results = stopServers(found.servers);
  const failed = results.filter((r) => !r.stopped);
  for (const f of failed) log.fail(`  pid ${f.pid}: ${f.detail}`);
  if (failed.length > 0) {
    log.fail("Not updating: a running server still holds the files npm would replace.");
    log.fail("Close the editors using cam, or re-run with --keep-servers to try anyway.");
    return false;
  }
  return true;
}

function finishUpdate(migrated: boolean): number {
  // The scheduled job holds the path of the copy that registered it. A global
  // install can land somewhere else, and then the hourly sync would keep
  // running a version that is no longer there.
  log.result("");
  log.result("If `cam sync` is scheduled, re-register it so the job points at the new copy:");
  log.result("  cam install --no-mcp --no-skills --no-dream");
  return migrated ? EXIT_OK : EXIT_FAILED;
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
    return usage(
      "cam install --client <claude_code|claude_desktop|codex|cursor|gemini_cli|antigravity|devin>",
    );
  }

  // Only the skill text, only where it is already installed: what an update
  // runs after replacing the package. MCP entries, the dream model and the
  // schedule are the user's choices, and an update has no business re-asking.
  if (has(a, "refresh-skills")) {
    if (remove) return usage("cam install --refresh-skills");
    // CAM_HOME, like the repair sync: the profile a test points at, not the real one.
    const refreshed = refreshSkills({ scope, only: only ? [only] : [], dryRun, home: process.env.CAM_HOME || undefined });
    if (has(a, "json")) {
      log.result(JSON.stringify(refreshed, null, 2));
      return EXIT_OK;
    }
    for (const r of refreshed) {
      log.status(`${r.client.padEnd(24)} skill ${r.change === "updated" ? (dryRun ? "would be updated" : "updated") : "unchanged"}`);
    }
    if (refreshed.length === 0) log.status("No installed skills to refresh. Install them with: cam install");
    return EXIT_OK;
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
    if (state === "stale") {
      log.status(`  ${plan.jobs.join(", ")} — updating so the hourly run has no window`);
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

const USAGE = `cam — shared context from Claude Code / Desktop / Codex / Cursor / Gemini CLI / Antigravity / Devin

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
  cam docs <subcommand>                  search the project's own files (see below)

  cam status [--json]                    when the index last synced
  cam doctor                             health report
  cam prune [--vacuum] [--dry-run]       retention: old traces, logs, missing sources
  cam forget --project <p> | <tool:id>   forget a project or session
  cam backup [<file>]                    verified copy of the index
  cam memory consolidate [--budget N]    promote from the recall trace
  cam memory list [--project p]          the promoted facts
  cam memory show <id>                   one fact with its evidence
  cam memory dream [--dry-run]           write a summary with a model (optional)
  cam memory embed [--dry-run]           index vectors with a configured model (optional)
  cam memory topics                      recurring topics
  cam memory status                      how much trace gathered, what was promoted
  cam docs add [path] [--project p]      index a project's files (code and prose)
  cam docs add --known [--dry-run]       index the known, recently active projects
  cam docs query "<words>"               keyword search in them, with the notes
  cam docs get <path|collection/path>    one file's indexed text
  cam docs index [--force] | list | remove <c>   re-read what changed (cam sync does too), list, drop
  cam note add <path> "<text>"           what a file or folder is for
  cam note list | rm <path>              the notes

  cam install [--dry-run] [--project]    wire into every agent tool found:
                                         MCP server, skill, dream model, schedule
  cam install --refresh-skills           rewrite installed skills to this version (update does it)
  cam uninstall [--dry-run]              the same in reverse; does not touch the index
  cam update [--check] [--yes]           look for a newer release (off by default:
                                         needs {"update":{"enabled":true}} in the config)
                                         --dry-run says what it would contact, and contacts
                                         nothing; --keep-servers leaves running cam-mcp alone

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
        return await cmdRecall(a);
      case "get":
        return await cmdGet(a);
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
      case "docs":
        return await cmdDocs(a);
      case "note":
        return await cmdNote(a);
      case "install":
        return await cmdInstall(a, false);
      case "uninstall":
        return await cmdInstall(a, true);
      case "update":
        return await cmdUpdate(a);
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

export function isEntryPoint(entry = import.meta.url, argv1 = process.argv[1]): boolean {
  return isEntry(entry, argv1);
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
