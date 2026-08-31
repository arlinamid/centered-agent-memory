import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_FAILED, EXIT_OK, run } from "../src/cli.js";
import { SchemaTooNewError, getMeta, initSchema, openHub } from "../src/db/open.js";
import { migrate } from "../src/db/migrate.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import {
  DEFAULT_REPO,
  UpdateDisabledError,
  compareVersions,
  fetchLatestRelease,
  installedVersion,
  latestReleaseUrl,
  verdict,
  type FetchLike,
} from "../src/update/check.js";
import {
  downloadRelease,
  installTarball,
  installedCliSpawn,
  isSelfReplacing,
  npmInvocation,
  postUpdateWithNewBinary,
  stageUpdater,
  updaterScript,
} from "../src/update/apply.js";
import { findRunningServers, stopServers } from "../src/update/servers.js";
import type { spawnSync } from "node:child_process";

/**
 * The update path is the only part of this package besides the dream phase
 * that can reach the network, so most of what is checked here is that it does
 * NOT: not before the user turns it on, and not on a dry run.
 */

const RELEASE = {
  tag_name: "v9.9.9",
  html_url: "https://github.com/demo/cam/releases/tag/v9.9.9",
  assets: [
    { name: "notes.txt", browser_download_url: "https://example.invalid/notes.txt", size: 10 },
    { name: "centered-agent-memory-9.9.9.tgz", browser_download_url: "https://example.invalid/pkg.tgz", size: 4242 },
  ],
};

const stubFetch = (body: unknown, status = 200): { impl: FetchLike; calls: string[] } => {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { impl, calls };
};

describe("version comparison", () => {
  it("orders releases the way a release does", () => {
    expect(compareVersions("0.7.0", "0.6.1")).toBeGreaterThan(0);
    expect(compareVersions("0.6.1", "0.6.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("v0.6.1", "0.6.1")).toBe(0);
    expect(compareVersions("0.6.1-rc.1", "0.6.1")).toBe(0);
  });

  it("names the three states plainly", () => {
    expect(verdict("0.6.1", "0.7.0")).toBe("behind");
    expect(verdict("0.6.1", "0.6.1")).toBe("current");
    // A checkout built ahead of the last release is not "up to date".
    expect(verdict("0.7.0", "0.6.1")).toBe("ahead");
  });

  it("reads the running version from the package it shipped in", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(installedVersion()).toBe(pkg.version);
  });
});

describe("release lookup", () => {
  it("asks GitHub for exactly one thing", async () => {
    const { impl, calls } = stubFetch(RELEASE);
    const release = await fetchLatestRelease({ repo: "demo/cam", fetchImpl: impl });
    expect(calls).toEqual(["https://api.github.com/repos/demo/cam/releases/latest"]);
    expect(release.version).toBe("9.9.9");
    expect(release.tag).toBe("v9.9.9");
  });

  it("picks the packed tarball out of the attached files", async () => {
    const { impl } = stubFetch(RELEASE);
    const release = await fetchLatestRelease({ repo: "demo/cam", fetchImpl: impl });
    expect(release.assetName).toBe("centered-agent-memory-9.9.9.tgz");
    expect(release.assetUrl).toBe("https://example.invalid/pkg.tgz");
    expect(release.assetBytes).toBe(4242);
  });

  it("reports a release with nothing attached rather than inventing a URL", async () => {
    const { impl } = stubFetch({ ...RELEASE, assets: [] });
    const release = await fetchLatestRelease({ repo: "demo/cam", fetchImpl: impl });
    expect(release.assetUrl).toBeNull();
  });

  it("says what went wrong instead of reporting no update", async () => {
    const notFound = stubFetch({}, 404);
    await expect(fetchLatestRelease({ repo: "demo/cam", fetchImpl: notFound.impl })).rejects.toThrow("404");

    const broken = stubFetch({ html_url: "x" });
    await expect(fetchLatestRelease({ repo: "demo/cam", fetchImpl: broken.impl })).rejects.toThrow("no tag");

    const down = stubFetch({}, 503);
    await expect(fetchLatestRelease({ repo: "demo/cam", fetchImpl: down.impl })).rejects.toThrow("503");
  });

  it("names the default repository in the URL it would contact", () => {
    expect(latestReleaseUrl()).toBe(`https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`);
  });
});

describe("installing a release", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-upd-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const release = {
    tag: "v9.9.9",
    version: "9.9.9",
    htmlUrl: "https://example.invalid",
    assetName: "pkg.tgz",
    assetUrl: "https://example.invalid/pkg.tgz",
    assetBytes: 4,
  };

  it("writes the tarball it was given", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("tgz!").buffer,
    })) as unknown as typeof globalThis.fetch;

    const out = await downloadRelease(release, { fetchImpl, dir });
    expect(fs.readFileSync(out.file, "utf8")).toBe("tgz!");
    expect(out.bytes).toBe(4);
  });

  it("refuses an empty download instead of handing npm a broken package", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof globalThis.fetch;
    await expect(downloadRelease(release, { fetchImpl, dir })).rejects.toThrow("empty");
  });

  it("refuses a release with no tarball", async () => {
    await expect(downloadRelease({ ...release, assetUrl: null, assetName: null }, { dir })).rejects.toThrow(
      "no packed tarball",
    );
  });

  it("installs the file globally and reports a failure as a failure", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ok = installTarball("/tmp/pkg.tgz", {
      npm: "npm",
      run: ((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { status: 0, stdout: "added 1 package", stderr: "", error: undefined };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });
    expect(calls).toEqual([{ cmd: "npm", args: ["install", "-g", "/tmp/pkg.tgz"] }]);
    expect(ok.ok).toBe(true);

    const bad = installTarball("/tmp/pkg.tgz", {
      npm: "npm",
      run: (() => ({ status: 1, stdout: "", stderr: "EACCES: permission denied", error: undefined })) as any,
    });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("EACCES");
  });

  it("does not spawn npm.cmd, which Node refuses with EINVAL", () => {
    const { cmd } = npmInvocation();
    expect(cmd.toLowerCase()).not.toMatch(/npm\.cmd$/);
    const { cmd: explicit } = npmInvocation("npm");
    expect(explicit).toBe("npm");
  });
});

/**
 * Nothing may be running the code that is about to be replaced. On Windows npm
 * cannot overwrite an open file at all; everywhere else a live server would go
 * on running the old code against a migrated index.
 */
describe("quiescing before an install", () => {
  const psLine = (pid: number, cmd: string) => `${pid}\t${cmd}`;

  const listing = (lines: string[], status = 0) =>
    ((() => ({ status, stdout: lines.join("\n"), stderr: "", error: undefined })) as unknown) as typeof spawnSync;

  it("finds the servers this package started", () => {
    const found = findRunningServers({
      self: 111,
      run: listing([
        psLine(222, "node /usr/lib/node_modules/centered-agent-memory/dist/mcp/server.js"),
        psLine(333, "C:\\node.exe C:\\npm\\cam-mcp"),
        psLine(444, "node /some/other/project/server.js"),
        psLine(555, "code --unrelated"),
      ]),
    });
    expect(found.listed).toBe(true);
    expect(found.servers.map((s) => s.pid)).toEqual([222, 333]);
  });

  it("never counts the process doing the asking", () => {
    const found = findRunningServers({
      self: 222,
      run: listing([psLine(222, "node /opt/cam/dist/mcp/server.js")]),
    });
    expect(found.servers).toEqual([]);
  });

  it("says it could not look, rather than saying there were none", () => {
    const found = findRunningServers({ self: 1, run: listing([], 1) });
    expect(found.listed).toBe(false);
    expect(found.servers).toEqual([]);
  });

  it("asks a server to stop, and counts one already gone as stopped", () => {
    const signals: Array<[number, string]> = [];
    const results = stopServers([{ pid: 10, command: "a" }, { pid: 20, command: "b" }], {
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === 20) {
          const err = new Error("no such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
      },
    });
    // SIGTERM, so the server closes its database handle on the way out.
    expect(signals).toEqual([
      [10, "SIGTERM"],
      [20, "SIGTERM"],
    ]);
    expect(results.every((r) => r.stopped)).toBe(true);
    expect(results[1]!.detail).toBe("already gone");
  });

  it("reports a server it could not stop as not stopped", () => {
    const results = stopServers([{ pid: 10, command: "a" }], {
      kill: () => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
    });
    expect(results[0]!.stopped).toBe(false);
    expect(results[0]!.detail).toContain("not permitted");
  });

  it("on Windows force-kills a server that is still alive after SIGTERM", () => {
    const calls: string[][] = [];
    const results = stopServers([{ pid: 10, command: "a" }], {
      kill: () => {},
      alive: () => true,
      waitMs: 0,
      run: ((cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: "", stderr: "", error: undefined };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });
    if (process.platform === "win32") {
      expect(calls[0]).toEqual(["taskkill", "/F", "/T", "/PID", "10"]);
      expect(results[0]!.detail).toBe("still running");
    } else {
      expect(calls).toEqual([]);
      expect(results[0]).toEqual({ pid: 10, stopped: false, detail: "still running" });
    }
  });
});

/**
 * The updater cannot be the file being updated. When the running copy is the
 * global one, the install has to happen from outside it.
 */
describe("replacing the running copy", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-stage-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const npmRoot = (root: string | null, status = 0) =>
    ((() => ({ status, stdout: root ?? "", stderr: "", error: undefined })) as unknown) as typeof spawnSync;

  it("knows when it would be overwriting itself", () => {
    const globalDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cam-glob-")));
    const pkg = path.join(globalDir, "centered-agent-memory");
    fs.mkdirSync(pkg);
    try {
      expect(isSelfReplacing({ run: npmRoot(globalDir), self: pkg })).toBe(true);
      // A checkout run with `node dist/cli.js` lives somewhere else entirely.
      expect(isSelfReplacing({ run: npmRoot(globalDir), self: dir })).toBe(false);
      // npm refusing to answer is not a reason to take the risky path.
      expect(isSelfReplacing({ run: npmRoot(null, 1), self: pkg })).toBe(false);
    } finally {
      fs.rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("writes an updater that depends on nothing it is about to replace", () => {
    const text = updaterScript();
    // Every import it could make is a file npm is about to overwrite.
    for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
      expect(m[1]!.startsWith("node:")).toBe(true);
    }
    expect(text).toContain("install");
    expect(text).toContain("npm-cli.js");
    expect(text).toContain("sync");
    expect(text).toContain("--repair");
    expect(text).toContain("process.execPath");
    expect(text).not.toContain("cam.cmd");
    // It waits for the caller to let go of its own files.
    expect(text).toContain("process.kill");
  });

  it("starts the updater detached, so it outlives this process", () => {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const staged = stageUpdater({
      tarball: "/tmp/pkg.tgz",
      dbPath: "/tmp/hub.sqlite",
      dir,
      npm: "npm",
      cam: "cam",
      spawnImpl: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
        calls.push({ cmd, args, opts });
        return { pid: 4242, unref: () => undefined };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });

    expect(fs.existsSync(staged.script)).toBe(true);
    expect(fs.existsSync(staged.logFile)).toBe(true);
    expect(staged.pid).toBe(4242);

    const call = calls[0]!;
    // The Node running this is known to exist and to be new enough; PATH in a
    // scheduled job is not PATH in a terminal.
    expect(call.cmd).toBe(process.execPath);
    expect(call.opts.detached).toBe(true);
    expect(call.opts.stdio).toBe("ignore");
    expect(call.args).toEqual([
      staged.script,
      "/tmp/pkg.tgz",
      String(process.pid),
      staged.logFile,
      "/tmp/hub.sqlite",
      "npm",
    ]);
  });
});

describe("post-update repair sync", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-post-upd-"));
    dbPath = path.join(dir, "hub.sqlite");
    const db = openHub(dbPath);
    initSchema(db);
    db.close();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("uses node + dist/cli.js on every platform when npm names a global root", () => {
    const cli = path.join(dir, "centered-agent-memory", "dist", "cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "// stub\n", "utf8");

    const spawn = installedCliSpawn(["sync", "--repair", "--quiet"], dbPath, { root: dir });
    expect(spawn).toEqual({
      cli,
      cmd: process.execPath,
      args: [cli, "sync", "--repair", "--quiet", "--db", dbPath],
    });
  });

  it("falls back to cam on PATH only off Windows", () => {
    const spawn = installedCliSpawn(["status", "--quiet"], dbPath, { root: "" });
    if (process.platform === "win32") {
      expect(spawn).toBeNull();
    } else {
      expect(spawn).toEqual({
        cli: "cam",
        cmd: "cam",
        args: ["status", "--quiet", "--db", dbPath],
      });
    }
  });

  it("migrates, then runs sync --repair with the new binary", () => {
    const cli = path.join(dir, "cli.js");
    fs.writeFileSync(cli, "// stub\n", "utf8");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "", stderr: "", error: undefined };
    }) as unknown as typeof spawnSync;

    const out = postUpdateWithNewBinary(dbPath, { run, cli });
    expect(out).toEqual({ ok: true, detail: "migrated and reindexed from sources" });
    expect(calls).toEqual([
      { cmd: process.execPath, args: [cli, "status", "--quiet", "--db", dbPath] },
      { cmd: process.execPath, args: [cli, "sync", "--repair", "--quiet", "--db", dbPath] },
    ]);
  });

  it("reports migration failure and skips repair sync", () => {
    const cli = path.join(dir, "cli.js");
    let n = 0;
    const run = (() => {
      n++;
      return { status: n === 1 ? 1 : 0, stdout: "bad schema", stderr: "", error: undefined };
    }) as unknown as typeof spawnSync;

    const out = postUpdateWithNewBinary(dbPath, { run, cli });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("migration FAILED");
    expect(n).toBe(1);
  });

  it("keeps the update successful when repair sync fails", () => {
    const cli = path.join(dir, "cli.js");
    let n = 0;
    const run = (() => {
      n++;
      return { status: n === 1 ? 0 : 1, stdout: "source locked", stderr: "", error: undefined };
    }) as unknown as typeof spawnSync;

    const out = postUpdateWithNewBinary(dbPath, { run, cli });
    expect(out).toEqual({ ok: true, detail: "migrated; repair sync failed — source locked" });
  });
});

describe("cam update", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  const before = { config: process.env.CAM_CONFIG, db: process.env.CAM_DB };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-upd-cli-"));
    process.env.CAM_CONFIG = path.join(dir, "config.json");
    process.env.CAM_DB = path.join(dir, "hub.sqlite");
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => out.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => err.push(a.map(String).join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (before.config === undefined) delete process.env.CAM_CONFIG;
    else process.env.CAM_CONFIG = before.config;
    if (before.db === undefined) delete process.env.CAM_DB;
    else process.env.CAM_DB = before.db;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The strongest claim this feature makes: with `fetch` removed from the
   * runtime, these paths still work. Anything that reached the network would
   * throw instead.
   */
  const withoutNetwork = async (fn: () => Promise<number>): Promise<number> => {
    const real = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = () => {
      throw new Error("the network was contacted");
    };
    try {
      return await fn();
    } finally {
      (globalThis as any).fetch = real;
    }
  };

  it("contacts nothing on a dry run, and says what it would contact", async () => {
    fs.writeFileSync(process.env.CAM_CONFIG!, JSON.stringify({ update: { enabled: true } }), "utf8");
    expect(await withoutNetwork(() => run(["update", "--dry-run"]))).toBe(EXIT_OK);

    const text = out.join("\n");
    expect(text).toContain(latestReleaseUrl());
    expect(text).toContain("nothing about this machine");
    expect(text).toContain(installedVersion());
  });

  it("contacts nothing until the user turns it on, and says how", async () => {
    expect(await withoutNetwork(() => run(["update", "--check"]))).toBe(EXIT_FAILED);
    const text = err.join("\n");
    expect(text).toContain("off");
    expect(text).toContain('"update": { "enabled": true }');
    expect(text).toContain(process.env.CAM_CONFIG!);
  });

  it("stays off when the config says anything other than true", async () => {
    fs.writeFileSync(process.env.CAM_CONFIG!, JSON.stringify({ update: { enabled: "yes" } }), "utf8");
    expect(await withoutNetwork(() => run(["update"]))).toBe(EXIT_FAILED);
  });

  it("explains itself in a sentence the user can act on", () => {
    const message = new UpdateDisabledError("/tmp/config.json").message;
    expect(message).toContain("/tmp/config.json");
    expect(message).toContain("enabled");
  });
});

/**
 * A release can move the schema, and migrations only go forward. These are the
 * two ways that hurts: an index left un-migrated until an unattended job opens
 * it, and an older build silently downgrading a newer index.
 */
describe("schema across an update", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-schema-"));
    dbPath = path.join(dir, "hub.sqlite");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("migrates an index written by an older version, without losing it", () => {
    const first = openHub(dbPath);
    initSchema(first);
    // An index as an older build left it: the columns this version added are
    // not there yet, and the stamp is behind.
    first.exec("alter table turns drop column loc_table");
    first.exec("alter table turns drop column loc_column");
    first.prepare("insert or replace into meta(key, value) values ('schema_version', '4')").run();
    first.close();

    const second = openHub(dbPath);
    const applied = migrate(second);
    expect(applied).toContain("turns.loc_table");
    expect(applied).toContain("turns.loc_column");

    initSchema(second);
    expect(getMeta(second, "schema_version")).toBe(String(SCHEMA_VERSION));
    const cols = (second.prepare("pragma table_info(turns)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("loc_table");
    expect(cols).toContain("loc_column");
    second.close();
  });

  it("refuses an index a newer version wrote, instead of stamping it back", () => {
    const db = openHub(dbPath);
    initSchema(db);
    db.prepare("insert or replace into meta(key, value) values ('schema_version', ?)").run(
      String(SCHEMA_VERSION + 1),
    );
    db.close();

    const older = openHub(dbPath);
    try {
      expect(() => initSchema(older)).toThrow(SchemaTooNewError);
      // The refusal has to leave the evidence intact: stamping it down to this
      // build's number is exactly the damage being prevented.
      expect(getMeta(older, "schema_version")).toBe(String(SCHEMA_VERSION + 1));
    } finally {
      older.close();
    }
  });

  it("names both ways out of a too-new index", () => {
    const message = new SchemaTooNewError(9, 5).message;
    expect(message).toContain("schema version 9");
    expect(message).toContain("understands 5");
    expect(message).toContain("cam update");
    expect(message).toContain("--db");
  });

  it("reports a too-new index as a plain answer, not a stack trace", async () => {
    const db = openHub(dbPath);
    initSchema(db);
    db.prepare("insert or replace into meta(key, value) values ('schema_version', '99')").run();
    db.close();

    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => out.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => err.push(a.map(String).join(" ")));
    try {
      expect(await run(["status", "--db", dbPath])).toBe(EXIT_FAILED);
      expect(err.join("\n")).toContain("schema version 99");
      expect(err.join("\n")).not.toContain("at Object.");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("still opens a fresh index that has never been stamped", () => {
    const db = openHub(dbPath);
    expect(() => initSchema(db)).not.toThrow();
    expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
    db.close();
  });
});
