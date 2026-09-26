import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { PROJECT_MARKERS } from "../config.js";
import { fileURLToPath } from "node:url";

/**
 * A project's own files, searchable by keyword, with notes attached to paths.
 *
 * This is the one place cam puts documents into an index rather than locators:
 * conversations live in other applications' stores, a project's files are
 * already on disk and already the user's. qmd does the indexing and the BM25
 * search; cam never asks it for a model. 0.11.0 used qmd's embedding and
 * reranking too, and on a CPU-only machine a first `cam docs index` measured in
 * hours — keyword search over the same files answers in milliseconds and needs
 * no weights at all.
 *
 * A note is qmd's `context` for a path: a sentence about what a file or folder
 * is for, which every hit under that path carries. It is the thing a codebase
 * cannot say about itself.
 */

export interface DocsConfig {
  /** `false` turns project file search off entirely, including the sync step. */
  enabled?: boolean;
  /**
   * The file index. Defaults to `docs.sqlite` next to the hub, so moving the
   * hub (`--db`, `CAM_DB`) moves this with it and a test never touches the
   * real one. Point it at qmd's own index to share collections with the `qmd`
   * command.
   */
  dbPath?: string;
  /**
   * Index the projects cam already knows about, on every `cam sync`.
   * **Off by default**: it reads every active project's files into an index,
   * which a user should decide once rather than discover. `true` takes the
   * defaults below; an object moves them.
   */
  autoAdd?: boolean | KnownOptions;
  /**
   * Files larger than this are left out. A project's own writing is rarely
   * past a megabyte; what is — an offline HTML bundle, a tokenizer, a scene
   * dump — is generated, drowns every search it matches, and took the first
   * real index to half a gigabyte. Default 1 MB.
   */
  maxFileBytes?: number;
}

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** Which known projects are worth indexing without being asked for each one. */
export interface KnownOptions {
  /** A project with no session this recent is left alone. Default 90. */
  sinceDays?: number;
  /**
   * Past this many matching files a folder is not a project but a checkout
   * of something large, or a folder of projects. Default 3000.
   */
  maxFiles?: number;
}

export const KNOWN_DEFAULTS = { sinceDays: 90, maxFiles: 3000 } as const;

export function knownOptions(config: DocsConfig): Required<KnownOptions> | null {
  if (!config.autoAdd) return null;
  return { ...KNOWN_DEFAULTS, ...(config.autoAdd === true ? {} : config.autoAdd) };
}

export function docsDbPath(hubDbPath: string, config: DocsConfig = {}): string {
  return config.dbPath ? path.resolve(config.dbPath) : path.join(path.dirname(path.resolve(hubDbPath)), "docs.sqlite");
}

/**
 * What gets indexed when nobody says otherwise: code as well as prose. A
 * collection that skipped `.ts` and `.py` would answer questions about the docs
 * folder while pretending the code was not there.
 */
export const DEFAULT_PATTERN =
  "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,pyi,go,rs,java,kt,kts,scala,groovy,gradle,rb,php,cs,fs,vb," +
  "swift,m,mm,c,h,cc,cpp,hpp,dart,lua,r,jl,pl,ex,exs,erl,hs,clj,zig,nim,gd,sol,astro,vue,svelte," +
  "sql,graphql,gql,proto,prisma,tf,sh,bash,zsh,fish,ps1,psm1,bat,cmd," +
  "yml,yaml,toml,ini,cfg,json,jsonc,xml,md,mdx,rst,txt,html,css,scss,sass,less}";

/**
 * Generated, vendored or enormous. Indexing `node_modules` buries a project's
 * own files under a hundred thousand someone else wrote.
 */
export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/vendor/**",
  "**/*.min.js",
  "**/*.lock",
  "**/package-lock.json",
];

export interface Collection {
  name: string;
  root: string;
  pattern: string;
  files: number;
}

export interface DocHit {
  collection: string;
  /** Relative to the collection root, as the file is named on disk. */
  path: string;
  /** Absolute, so an agent can open it without knowing the root. */
  file: string;
  title: string | null;
  score: number;
  /** 1-based line the snippet starts on, when qmd located one. */
  line: number | null;
  snippet: string;
  /** Every note on this path, the folder's before the file's. */
  note: string | null;
  docid: string | null;
}

export interface Note {
  collection: string;
  /** Relative to the collection root; a folder ends in `/`. */
  path: string;
  note: string;
}

export interface DocsIndex {
  readonly dbPath: string;
  list(): Promise<Collection[]>;
  add(dir: string, opts?: { name?: string; pattern?: string }): Promise<Collection>;
  remove(name: string): Promise<boolean>;
  /**
   * Bring collections up to date. A collection whose folder has not changed
   * since the last refresh is not read at all — see `fingerprint` — unless
   * `force` says to.
   */
  refresh(names?: string[], opts?: { force?: boolean }): Promise<RefreshResult>;
  /** Drop what refreshes left behind and give the space back. Seconds on a large index. */
  compact(): Promise<{ before: number; after: number }>;
  search(query: string, opts?: { collection?: string; limit?: number }): Promise<DocHit[]>;
  read(target: string, opts?: { collection?: string }): Promise<{ collection: string; path: string; file: string; text: string } | null>;
  note(target: string, text: string, opts?: { collection?: string }): Promise<Note>;
  unnote(target: string, opts?: { collection?: string }): Promise<boolean>;
  notes(collection?: string): Promise<Note[]>;
  close(): Promise<void>;
}

export interface RefreshResult {
  collections: number;
  /** Collections read this time; the rest were unchanged by their fingerprint. */
  checked: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
}

/** Raised for a mistake the user can fix; the CLI prints the message alone. */
export class DocsError extends Error {}

/** A collection is named after the project, in a form qmd accepts in a path. */
export function collectionName(project: string): string {
  const slug = project
    // Accents off first: `prezentáció` should read `prezentacio`, not `prezent-ci`.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

/** The slice of qmd's SDK used here — BM25, collections and contexts, no model. */
interface QmdStore {
  addCollection(name: string, opts: { path: string; pattern?: string; ignore?: string[] }): Promise<void>;
  removeCollection(name: string): Promise<boolean>;
  listCollections(): Promise<Array<{ name: string; pwd: string; glob_pattern: string; active_count: number }>>;
  update(opts?: { collections?: string[] }): Promise<{ collections: number; indexed: number; updated: number; unchanged: number; removed: number }>;
  searchLex(query: string, opts?: { limit?: number; collection?: string | string[] }): Promise<Array<Record<string, unknown>>>;
  get(pathOrDocid: string, opts?: { includeBody?: boolean }): Promise<Record<string, unknown>>;
  addContext(collection: string, pathPrefix: string, text: string): Promise<boolean>;
  removeContext(collection: string, pathPrefix: string): Promise<boolean>;
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;
  close(): Promise<void>;
  /** qmd's own store; cam uses its database handle for a table of its own. */
  internal?: {
    db?: {
      exec(sql: string): void;
      prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
    };
  };
}

interface QmdModule {
  createStore(options: { dbPath: string }): Promise<QmdStore>;
  extractSnippet(body: string, query: string, maxLen?: number): { line: number; snippet: string };
  Maintenance: new (internal: unknown) => {
    deleteInactiveDocs(): number;
    cleanupOrphanedContent(): number;
    optimizeFts(): void;
    vacuum(): void;
  };
}

const QMD = "@tobilu/qmd";

/**
 * Whether qmd is installed, asked without loading it: `cam doctor` reports
 * this and must not pay for, or fail on, the import. The package directory is
 * looked for the way Node resolves it, walking up from this module.
 */
export function qmdInstalled(from = path.dirname(fileURLToPath(import.meta.url))): boolean {
  for (let d = from; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "node_modules", ...QMD.split("/"), "package.json"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

const slash = (p: string): string => p.split(path.sep).join("/").split("\\").join("/");

/** Same file on Windows whatever the case of the drive letter or the folders. */
const sameCase = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

/** A project from the hub, with the folder attribution learned for it. */
export interface KnownProject {
  key: string;
  root: string | null;
  lastMs: number | null;
}

export interface KnownPlan {
  add: Array<{ name: string; root: string; files: number }>;
  skip: Array<{ key: string; root: string | null; reason: string }>;
  /**
   * Verdicts worth keeping, by folder: counting a large tree's files took
   * seconds, and a scheduled sync must not pay that again every hour to reach
   * the same answer.
   */
  remember: Record<string, string>;
}

/**
 * The files a project uses to say what is not its own: build output, local
 * config, secrets, generated code. Read at every level, as git reads them.
 *
 * `.npmignore` and `.dockerignore` are left out on purpose: they describe what
 * goes into a package or an image, and routinely list `src/` and `test/` —
 * the very files a search of the project is for.
 */
export const IGNORE_FILES = [".gitignore", ".ignore", ".vercelignore", ".cursorignore"] as const;

/** Folder names never walked into, whatever the ignore files say. */
const SKIP_DIRS = new Set(
  DEFAULT_IGNORE.map((g) => /^\*\*\/([^*/]+)\/\*\*$/.exec(g)?.[1]).filter((d): d is string => Boolean(d)),
);

/** A literal path as a glob that matches only itself. */
const globEscape = (p: string): string => p.replace(/[*?[\]{}()!+@\\]/g, "\\$&");

export interface FolderScan {
  /**
   * Glob patterns for what the ignore files exclude, relative to the folder.
   * An ignored folder is one `dir/**` entry: git does not look inside a folder
   * it ignores, so a `!` rule below it cannot bring a file back, and neither
   * does this.
   */
  ignored: string[];
  /** Files matching the pattern that survive the ignore files. */
  files: number;
  /** The walk stopped at `cap`, so `ignored` is incomplete. */
  truncated: boolean;
  /** Matching files left out for being over the size limit. */
  tooLarge: number;
  /**
   * What the walk saw, hashed: every included file's path, size and mtime, and
   * the ignore list. Equal signatures mean nothing qmd would read has changed.
   */
  signature: string;
}

/**
 * Walk a folder the way git sees it: every ignore file applies to its own
 * folder and everything under it, and a folder that is ignored is not entered
 * — which is also what keeps the walk cheap in a tree with a large build
 * output. Hidden entries are passed over, as qmd skips them anyway.
 */
export async function scanFolder(
  root: string,
  pattern = DEFAULT_PATTERN,
  cap = Number.POSITIVE_INFINITY,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<FolderScan> {
  const scan: FolderScan = { ignored: [], files: 0, truncated: false, tooLarge: 0, signature: "" };
  const seen: string[] = [];
  const read = (file: string): string | null => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const rootRules = ignore();
  const exclude = read(path.join(root, ".git", "info", "exclude"));
  if (exclude) rootRules.add(exclude);

  type Rules = Array<{ base: string; ig: Ignore }>;
  const stack: Array<{ rel: string; rules: Rules }> = [{ rel: "", rules: [{ base: "", ig: rootRules }] }];
  while (stack.length > 0) {
    const { rel, rules: inherited } = stack.pop()!;
    const dir = path.join(root, ...rel.split("/").filter(Boolean));
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const here = ignore();
    let own = false;
    for (const name of IGNORE_FILES) {
      const text = entries.some((e) => e.name === name && e.isFile()) ? read(path.join(dir, name)) : null;
      if (text) {
        here.add(text);
        own = true;
      }
    }
    const rules = own ? [...inherited, { base: rel, ig: here }] : inherited;

    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const isDir = e.isDirectory();
      if (isDir && SKIP_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      const ignored = rules.some(({ base, ig }) => {
        const inside = base ? child.slice(base.length + 1) : child;
        return ig.ignores(isDir ? `${inside}/` : inside);
      });
      if (ignored) {
        scan.ignored.push(isDir ? `${globEscape(child)}/**` : globEscape(child));
      } else if (isDir) {
        stack.push({ rel: child, rules });
      } else if (e.isFile() && path.matchesGlob(child, pattern)) {
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(path.join(dir, e.name));
        } catch {
          continue;
        }
        if (st.size > maxBytes) {
          scan.ignored.push(globEscape(child));
          scan.tooLarge++;
          continue;
        }
        seen.push(`${child}\t${st.size}\t${Math.trunc(st.mtimeMs)}`);
        if (++scan.files > cap) {
          scan.truncated = true;
          return scan;
        }
      }
    }
  }
  scan.signature = sha256([...seen.sort(), "--", ...[...scan.ignored].sort()].join("\n"));
  return scan;
}

/** `Promise.all` over `items`, with at most `limit` running at a time; results keep their order. */
async function mapLimit<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Bumped when what a fingerprint covers changes, so every stored one goes stale at once. */
const FINGERPRINT_VERSION = 2;

export interface Fingerprint {
  value: string;
  method: "git" | "walk";
  /** The walk, when one was needed to answer; reused rather than walked again. */
  scan?: FolderScan;
}

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/**
 * Whether a folder changed since it was last indexed, answered as cheaply as
 * the folder allows.
 *
 * In a git work tree, git already knows: the commit checked out, plus every
 * file `git status` reports as changed or new — each with its size and mtime,
 * because a file edited twice between refreshes shows the same status line
 * both times. That covers the ignore files too, which are ordinary files to
 * git. It costs one `git status`, not a read of every file.
 *
 * Anywhere else — no git, git not installed, a repository git refuses to open
 * — the folder is walked and every included file's size and mtime hashed.
 * Still no file is read, and the walk is the one `configure` needs anyway
 * when something did change.
 */
export async function fingerprint(root: string, pattern: string, maxBytes: number): Promise<Fingerprint> {
  const salt = `v${FINGERPRINT_VERSION}\n${pattern}\n${maxBytes}\n`;
  try {
    // Two processes, not four: on Windows starting git costs more than the
    // answer, and a sync asks this of every collection. Fails outside a work
    // tree, which is the signal to walk instead.
    const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
    if (top) {
      const status = await git(root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."]);
      let head = "unborn";
      const lines: string[] = [];
      const entries = status.split("\0").filter(Boolean);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        // Of the headers only the commit counts: ahead/behind moves with every
        // fetch, and says nothing about the files on disk.
        if (entry.startsWith("# branch.oid ")) {
          head = entry.slice("# branch.oid ".length);
          continue;
        }
        if (entry.startsWith("#")) continue;
        // Porcelain v2: the path follows a fixed number of fields per kind,
        // and is relative to the repository root, not to \`root\`.
        const fields = { "1": 8, "2": 9, u: 10 }[entry[0] as "1" | "2" | "u"] ?? 1;
        const code = entry.split(" ", fields).join(" ");
        const file = entry.slice(code.length + 1);
        // A rename is followed by its source path, which needs no stat.
        if (entry[0] === "2") i++;
        let stat = "gone";
        try {
          const st = await fs.promises.stat(path.join(top, file));
          // A nested repository shows up as one untracked folder, whatever
          // changes inside it; walk that folder rather than miss them.
          stat = st.isDirectory() ? (await scanFolder(path.join(top, file), pattern, undefined, maxBytes)).signature : `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          // Deleted: the status line itself is the change.
        }
        lines.push(`${code} ${file} ${stat}`);
      }
      let exclude = "";
      try {
        exclude = String(Math.trunc((await fs.promises.stat(path.join(top, ".git", "info", "exclude"))).mtimeMs));
      } catch {
        // No exclude file is the common case.
      }
      return { value: sha256(`${salt}git\n${head}\n${exclude}\n${lines.sort().join("\n")}`), method: "git" };
    }
  } catch {
    // Not a repository, or no git on this machine: walk instead.
  }
  const scan = await scanFolder(root, pattern, undefined, maxBytes);
  return { value: sha256(`${salt}walk\n${scan.signature}`), method: "walk", scan };
}

/**
 * Which of the hub's projects to index, and why the rest are not.
 *
 * A folder that holds other projects' folders is skipped rather than its
 * children: the children are where the sessions were attributed, and indexing
 * both puts every file in the answer twice. Anything `remembered` — removed by
 * the user, or too large last time — stays out until the user adds it by hand.
 */
export async function planKnown(
  projects: ReadonlyArray<KnownProject>,
  existing: ReadonlyArray<Collection>,
  remembered: Readonly<Record<string, string>>,
  opts: Required<KnownOptions>,
  nowMs = Date.now(),
): Promise<KnownPlan> {
  const plan: KnownPlan = { add: [], skip: [], remember: {} };
  const key = rememberKey;
  const indexed = new Map(existing.map((c) => [key(c.root), c.name] as const));
  const names = new Set(existing.map((c) => c.name));
  const home = key(os.homedir());
  const cutoff = nowMs - opts.sinceDays * 24 * 60 * 60 * 1000;
  const within = (inner: string, outer: string): boolean => inner !== outer && inner.startsWith(`${outer}/`);

  // First the verdicts that need no other project to reach.
  const candidates: Array<KnownProject & { k: string }> = [];
  for (const p of projects) {
    const skip = (reason: string): void => void plan.skip.push({ key: p.key, root: p.root, reason });
    if (!p.root) {
      skip("no folder known");
      continue;
    }
    const k = key(p.root);
    if (indexed.has(k)) continue;
    if (!fs.existsSync(p.root)) skip("folder is gone");
    else if ((p.lastMs ?? 0) < cutoff) skip(`no session in ${opts.sinceDays} days`);
    else if (k === home || path.dirname(k) === k) skip("a home or drive folder");
    // Test runs and tool scratch space (`.livetest-themes/t1`), not projects;
    // qmd would not read a hidden file inside a project either.
    else if (k.split("/").some((part) => part.startsWith("."))) skip("inside a hidden folder");
    else if (remembered[k]) skip(remembered[k]!);
    else candidates.push({ ...p, k });
  }

  // Outermost first, so a project is decided before the folders inside it.
  // A folder with a project marker keeps its sub-projects: they are part of
  // it, and indexing both would put every file in the answer twice. A folder
  // without one that holds projects (a Codex workspace of dated folders) is a
  // shelf, not a project, and its projects are indexed on their own.
  candidates.sort((x, y) => x.k.split("/").length - y.k.split("/").length);
  const accepted = new Map(indexed);
  for (const p of candidates) {
    const skip = (reason: string): void => void plan.skip.push({ key: p.key, root: p.root, reason });
    const outer = [...accepted].find(([root]) => within(p.k, root));
    if (outer) {
      skip(`inside ${outer[1]}`);
      continue;
    }
    const heldIndexed = [...indexed].find(([root]) => within(root, p.k));
    if (heldIndexed) {
      skip(`holds ${heldIndexed[1]}, which is indexed on its own`);
      continue;
    }
    const inner = candidates.filter((c) => within(c.k, p.k));
    if (inner.length > 0 && !PROJECT_MARKERS.some((m) => fs.existsSync(path.join(p.root!, m)))) {
      skip(`a folder of ${inner.length} project(s), indexed one by one`);
      continue;
    }
    const { files } = await scanFolder(p.root!, DEFAULT_PATTERN, opts.maxFiles);
    if (files > opts.maxFiles) {
      const reason = `more than ${opts.maxFiles} files`;
      plan.remember[p.k] = reason;
      skip(reason);
      continue;
    }
    if (files === 0) {
      skip("no text files");
      continue;
    }
    let name = collectionName(p.key);
    for (let i = 2; names.has(name); i++) name = `${collectionName(p.key)}-${i}`;
    names.add(name);
    accepted.set(p.k, name);
    plan.add.push({ name, root: p.root!, files });
  }
  return plan;
}

/** The key `remembered` verdicts are stored under, for one folder. */
export const rememberKey = (root: string): string => sameCase(slash(path.resolve(root))).replace(/\/+$/, "");

/**
 * qmd is an optional dependency: it brings native tree-sitter grammars and a
 * llama.cpp binding, and a machine that cannot install those should still get
 * everything else cam does. Loaded on first use, never at startup.
 */
async function loadQmd(): Promise<QmdModule> {
  try {
    // Through a variable, so the compiler does not tie the build to a package
    // that is allowed to be missing.
    const specifier: string = QMD;
    return (await import(specifier)) as QmdModule;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" && String((err as Error).message).includes(QMD)) {
      throw new DocsError(`Project file search needs qmd, which is not installed. Reinstall cam, or: npm install ${QMD}`);
    }
    throw err;
  }
}

/**
 * Open the file index.
 *
 * `create: false` is for callers that only read — the MCP server, `cam sync` —
 * and returns null when there is no index yet, without importing qmd at all.
 */
export async function openDocs(
  dbPath: string,
  opts: { create?: boolean; maxFileBytes?: number } = {},
): Promise<DocsIndex | null> {
  if (!opts.create && !fs.existsSync(dbPath)) return null;
  const qmd = await loadQmd();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // No `config` on purpose: with an inline config qmd deletes every collection
  // the config does not name, and the collections are the index's own state.
  const store = await qmd.createStore({ dbPath });
  return wrap(store, qmd, dbPath, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
}


function isInside(root: string, file: string): boolean {
  const rel = path.relative(sameCase(root), sameCase(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function wrap(store: QmdStore, qmd: QmdModule, dbPath: string, maxBytes: number): DocsIndex {
  /**
   * Fingerprints live in the index file itself, in a table of cam's own: if
   * the index is deleted or replaced, the fingerprints go with it, and nothing
   * can claim a folder is indexed when the index no longer holds it.
   */
  const db = store.internal?.db;
  db?.exec("create table if not exists cam_docs_state (collection text primary key, fingerprint text not null, method text not null, checked_ms integer not null)");
  const storedFingerprint = (name: string): string | null =>
    (db?.prepare("select fingerprint from cam_docs_state where collection = ?").get(name) as { fingerprint: string } | undefined)?.fingerprint ?? null;
  const saveFingerprint = (name: string, fp: Fingerprint): void =>
    void db?.prepare("insert or replace into cam_docs_state(collection, fingerprint, method, checked_ms) values (?, ?, ?, ?)").run(name, fp.value, fp.method, Date.now());
  const forgetFingerprint = (name: string): void => void db?.prepare("delete from cam_docs_state where collection = ?").run(name);

  const collections = async (): Promise<Collection[]> =>
    (await store.listCollections()).map((c) => ({
      name: c.name,
      root: c.pwd,
      pattern: c.glob_pattern,
      files: c.active_count ?? 0,
    }));

  /**
   * The key a note is stored under. qmd matches it as a plain prefix of the
   * file's path, so a folder keeps its trailing slash — otherwise a note on
   * `src/doc` would also land on everything in `src/docs`.
   */
  const noteKey = (rel: string, folder: boolean): string => (rel === "" ? "/" : `/${rel}${folder ? "/" : ""}`);

  /**
   * Which collection a path belongs to, and where in it.
   *
   * A path on disk picks its collection by containment — the deepest root
   * wins, so a package inside a monorepo collection goes to its own. A path
   * that is not on disk is read as relative to the named collection, or to the
   * only one there is; `<collection>/<path>` names both at once, which is the
   * form a hit is shown in.
   */
  const locate = async (target: string, named?: string): Promise<{ collection: Collection; rel: string; folder: boolean }> => {
    const all = await collections();
    if (all.length === 0) throw new DocsError("No file collections yet. Add one with: cam docs add [path]");
    const byName = (n: string): Collection => {
      const c = all.find((x) => x.name === n);
      if (!c) throw new DocsError(`No such collection: ${n}. Known: ${all.map((x) => x.name).join(", ")}`);
      return c;
    };

    const abs = path.resolve(target);
    if (fs.existsSync(abs)) {
      const folder = fs.statSync(abs).isDirectory();
      const owners = (named ? [byName(named)] : all).filter((c) => isInside(c.root, abs));
      owners.sort((a, b) => b.root.length - a.root.length);
      const owner = owners[0];
      if (owner) return { collection: owner, rel: slash(path.relative(owner.root, abs)), folder };
      if (named || path.isAbsolute(target)) {
        throw new DocsError(`${abs} is not inside ${named ? `collection ${named}` : "any collection"}.`);
      }
    }

    const clean = slash(target).replace(/^\.?\/+/, "");
    const folder = clean.endsWith("/");
    const rel = clean.replace(/\/+$/, "");
    if (named) return { collection: byName(named), rel, folder };
    const [head, ...rest] = rel.split("/");
    const prefixed = all.find((c) => c.name === head);
    if (prefixed && rest.length > 0) return { collection: prefixed, rel: rest.join("/"), folder };
    if (all.length === 1) return { collection: all[0]!, rel, folder };
    throw new DocsError(`Several collections; name one with --collection: ${all.map((c) => c.name).join(", ")}`);
  };

  /**
   * Point a collection at a folder with the ignore list it has today.
   *
   * qmd's upsert replaces the whole row, notes included — re-adding a folder
   * would silently erase every note on it — so the notes are read first and
   * written back after.
   */
  const configure = async (name: string, root: string, pattern: string, scan?: FolderScan): Promise<void> => {
    const { ignored } = scan ?? (await scanFolder(root, pattern, undefined, maxBytes));
    const notes = (await store.listContexts()).filter((c) => c.collection === name);
    // Forward slashes, as qmd's own CLI stores them on every platform.
    await store.addCollection(name, { path: slash(root), pattern, ignore: [...DEFAULT_IGNORE, ...ignored] });
    for (const n of notes) await store.addContext(name, n.path, n.context);
  };

  return {
    dbPath,

    list: collections,

    async add(dir, opts = {}) {
      const root = path.resolve(dir);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new DocsError(`Not a folder: ${root}`);
      const name = opts.name ?? collectionName(path.basename(root));
      await configure(name, root, opts.pattern ?? DEFAULT_PATTERN);
      const added = (await collections()).find((c) => c.name === name);
      return added ?? { name, root, pattern: opts.pattern ?? DEFAULT_PATTERN, files: 0 };
    },

    async remove(name) {
      forgetFingerprint(name);
      return store.removeCollection(name);
    },

    async refresh(names, opts = {}) {
      const targets = (await collections()).filter((c) => !names?.length || names.includes(c.name));
      const out: RefreshResult = { collections: targets.length, checked: 0, indexed: 0, updated: 0, unchanged: 0, removed: 0 };
      const changed: Array<{ name: string; fp: Fingerprint | null }> = [];
      // Asked of every collection at once, a few at a time: each is mostly
      // waiting on a git process or the disk, and a sync with fifty projects
      // should not wait for them one after another.
      const fps = await mapLimit(targets, 8, (c) =>
        fs.existsSync(c.root) ? fingerprint(c.root, c.pattern, maxBytes) : Promise.resolve(null),
      );
      for (const [i, c] of targets.entries()) {
        const fp = fps[i]!;
        if (!fp) {
          // The folder is gone: qmd's update empties the collection.
          forgetFingerprint(c.name);
          changed.push({ name: c.name, fp: null });
          continue;
        }
        if (!opts.force && fp.value === storedFingerprint(c.name)) {
          out.unchanged += c.files;
          continue;
        }
        // The ignore files are read again with every change: a new
        // `.gitignore` line should take a file out of the index, not only out
        // of the next add.
        await configure(c.name, c.root, c.pattern, fp.scan);
        changed.push({ name: c.name, fp });
      }
      // One at a time: an empty list would mean "every collection" to qmd.
      for (const { name, fp } of changed) {
        const r = await store.update({ collections: [name] });
        out.checked++;
        out.indexed += r.indexed;
        out.updated += r.updated;
        out.unchanged += r.unchanged;
        out.removed += r.removed;
        if (fp) saveFingerprint(name, fp);
      }
      return out;
    },

    async compact() {
      const size = (): number => {
        try {
          return fs.statSync(dbPath).size;
        } catch {
          return 0;
        }
      };
      const before = size();
      const m = new qmd.Maintenance(store.internal);
      m.deleteInactiveDocs();
      m.cleanupOrphanedContent();
      m.optimizeFts();
      m.vacuum();
      return { before, after: size() };
    },

    async search(query, opts = {}) {
      const all = await collections();
      if (opts.collection && !all.some((c) => c.name === opts.collection)) {
        throw new DocsError(`No such collection: ${opts.collection}. Known: ${all.map((c) => c.name).join(", ") || "none"}`);
      }
      const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
      const rows = await store.searchLex(query, { limit, collection: opts.collection });
      return rows.map((r) => {
        const collection = String(r.collectionName ?? "");
        const root = all.find((c) => c.name === collection)?.root ?? "";
        const rel = String(r.displayPath ?? "").slice(collection.length + 1);
        const body = typeof r.body === "string" ? r.body : "";
        const snip = body ? qmd.extractSnippet(body, query, 400) : null;
        return {
          collection,
          path: rel,
          file: root ? path.join(root, ...rel.split("/")) : rel,
          title: typeof r.title === "string" ? r.title : null,
          score: Number(r.score ?? 0),
          line: snip?.line ?? null,
          // qmd opens a snippet with a diff-style `@@ … @@` locator; the line
          // number already says where it is.
          snippet: (snip?.snippet ?? "").replace(/^@@[^\n]*\n/, "").replace(/^\s*\n/, "").trimEnd(),
          note: typeof r.context === "string" && r.context ? r.context : null,
          docid: typeof r.docid === "string" ? r.docid : null,
        };
      });
    },

    async read(target, opts = {}) {
      let key = target;
      let known: { collection: Collection; rel: string } | null = null;
      if (!/^#?[0-9a-f]{6,}$/i.test(target)) {
        const at = await locate(target, opts.collection);
        known = at;
        // The virtual path is an exact match; a bare one falls through to
        // qmd's fuzzy lookup, which can answer with a different file.
        key = `qmd://${at.collection.name}/${at.rel}`;
      }
      const doc = await store.get(key, { includeBody: true });
      if (!doc || "error" in doc) return null;
      const display = String(doc.displayPath ?? key);
      const collection = known?.collection.name ?? String(doc.collectionName ?? display.split("/")[0]);
      const root = known?.collection.root ?? (await collections()).find((c) => c.name === collection)?.root ?? "";
      const rel = known?.rel ?? display.slice(collection.length + 1);
      return {
        collection,
        path: rel,
        file: root ? path.join(root, ...rel.split("/")) : rel,
        text: typeof doc.body === "string" ? doc.body : "",
      };
    },

    async note(target, text, opts = {}) {
      const at = await locate(target, opts.collection);
      const key = noteKey(at.rel, at.folder);
      await store.addContext(at.collection.name, key, text);
      return { collection: at.collection.name, path: at.rel + (at.folder && at.rel ? "/" : ""), note: text };
    },

    async unnote(target, opts = {}) {
      const at = await locate(target, opts.collection);
      const key = noteKey(at.rel, at.folder);
      // A note written by the `qmd` command itself may be spelled without the
      // leading or the trailing slash.
      for (const k of new Set([key, key.slice(1), key.replace(/(.)\/$/, "$1"), key.slice(1).replace(/\/$/, "")])) {
        if (k && (await store.removeContext(at.collection.name, k))) return true;
      }
      return false;
    },

    async notes(collection) {
      const known = new Set((await collections()).map((c) => c.name));
      return (await store.listContexts())
        .filter((c) => known.has(c.collection) && (!collection || c.collection === collection))
        .map((c) => ({ collection: c.collection, path: c.path.replace(/^\/+/, ""), note: c.context }));
    },

    close: () => store.close(),
  };
}

export function formatDocHits(hits: ReadonlyArray<DocHit>, query: string): string {
  if (hits.length === 0) return `No files matched: ${query}`;
  const lines: string[] = [];
  for (const h of hits) {
    lines.push(`${h.score.toFixed(2)}  ${h.collection}/${h.path}${h.line ? `:${h.line}` : ""}`);
    if (h.note) for (const n of h.note.split(/\n\n+/)) lines.push(`  note: ${n}`);
    if (h.snippet) for (const s of h.snippet.split("\n").slice(0, 6)) lines.push(`  | ${s}`);
    lines.push("");
  }
  lines.push(`${hits.length} file(s). Keyword match (BM25); read one with: cam docs get <collection>/<path>`);
  return lines.join("\n");
}

export function formatNotes(notes: ReadonlyArray<Note>): string {
  if (notes.length === 0) return 'No file notes yet. Add one with: cam note add <path> "<what it is for>"';
  return notes.map((n) => `${n.collection}/${n.path}\n  ${n.note}`).join("\n\n");
}

export function formatCollections(rows: ReadonlyArray<Collection>): string {
  if (rows.length === 0) return "No file collections. Add one with: cam docs add [path]";
  return rows.map((r) => `${r.name.padEnd(28)} ${String(r.files).padStart(6)} file(s)  ${r.root}`).join("\n");
}
