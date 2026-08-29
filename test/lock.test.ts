import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, describeHolder, LOCK_STALE_MS } from "../src/db/lock.js";
import { initSchema, openHub, type Db } from "../src/db/open.js";

let dir: string;
let db: Db;

const NOW = 1_700_000_000_000;

/** A pid that is certainly alive on this machine but is not us. */
const OTHER_PID = process.ppid;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-lock-"));
  db = openHub(path.join(dir, "hub.sqlite"));
  initSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const holder = (over: Partial<{ pid: number; host: string; startedMs: number; what: string }>): void => {
  db.prepare("insert or replace into meta(key, value) values ('sync_lock', ?)").run(
    JSON.stringify({ pid: OTHER_PID, host: os.hostname(), startedMs: NOW, what: "sync", ...over }),
  );
};

describe("sync lock", () => {
  it("is free on a fresh hub", () => {
    const got = acquireLock(db, "sync", NOW);
    expect(got.ok).toBe(true);
  });

  it("turns away a second holder while the first is alive", () => {
    holder({});
    const got = acquireLock(db, "sync", NOW + 1000);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.heldBy.pid).toBe(OTHER_PID);
  });

  it("frees the lock on release, and only its own", () => {
    const got = acquireLock(db, "sync", NOW);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    got.handle.release();
    expect(db.prepare("select value from meta where key = 'sync_lock'").get()).toBeUndefined();

    // Releasing twice is harmless, and does not remove somebody else's lock.
    holder({});
    got.handle.release();
    expect(db.prepare("select value from meta where key = 'sync_lock'").get()).toBeDefined();
  });

  it("takes over a lock older than the staleness window", () => {
    holder({ startedMs: NOW - LOCK_STALE_MS - 1 });
    expect(acquireLock(db, "sync", NOW).ok).toBe(true);
  });

  it("takes over a lock whose process is gone", () => {
    // A pid that cannot be running: process 0 is never a normal process, and a
    // huge pid is not allocated.
    holder({ pid: 0x7fff_fffe });
    expect(acquireLock(db, "sync", NOW).ok).toBe(true);
  });

  it("treats a lock from another machine as live until it goes stale", () => {
    holder({ host: "másik-gép", pid: 1 });
    expect(acquireLock(db, "sync", NOW).ok).toBe(false);
    expect(acquireLock(db, "sync", NOW + LOCK_STALE_MS + 1).ok).toBe(true);
  });

  it("ignores a garbled lock value rather than wedging the hub", () => {
    db.prepare("insert or replace into meta(key, value) values ('sync_lock', 'nem json')").run();
    expect(acquireLock(db, "sync", NOW).ok).toBe(true);
  });

  it("describes the holder in a way a human can act on", () => {
    expect(describeHolder({ pid: 42, host: "gep", startedMs: NOW - 5000, what: "sync" }, NOW)).toContain("pid 42");
  });
});
