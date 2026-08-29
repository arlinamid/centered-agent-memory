import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFilePath, loadConfig, readConfigFile, userConfigDir, userDataDir } from "../src/config.js";

/**
 * Where the index and the settings live. This is what makes a global install
 * usable: writing under the install directory would put the database inside
 * `node_modules`, and an `npx` run would throw it away between invocations.
 */

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["CAM_DB", "CAM_CONFIG", "CAM_HOME", "LOCALAPPDATA", "APPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-cfg-"));
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const isWin = process.platform === "win32";

describe("user directories", () => {
  it("uses the platform's data location, not the install directory", () => {
    if (isWin) {
      process.env.LOCALAPPDATA = path.join(dir, "Local");
      expect(userDataDir()).toBe(path.join(dir, "Local", "centered-agent-memory"));
    } else {
      process.env.XDG_DATA_HOME = path.join(dir, "share");
      expect(userDataDir()).toBe(path.join(dir, "share", "centered-agent-memory"));
    }
  });

  it("falls back to a sensible place inside the home directory", () => {
    const home = path.join(dir, "home");
    const dataFallback = isWin
      ? path.join(home, "AppData", "Local", "centered-agent-memory")
      : path.join(home, ".local", "share", "centered-agent-memory");
    expect(userDataDir(home)).toBe(dataFallback);

    const configFallback = isWin
      ? path.join(home, "AppData", "Roaming", "centered-agent-memory")
      : path.join(home, ".config", "centered-agent-memory");
    expect(userConfigDir(home)).toBe(configFallback);
  });

  it("lets CAM_CONFIG move the config file", () => {
    process.env.CAM_CONFIG = path.join(dir, "sajat.json");
    expect(configFilePath()).toBe(path.join(dir, "sajat.json"));
  });
});

describe("config file", () => {
  const write = (body: string): string => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, body, "utf8");
    process.env.CAM_CONFIG = file;
    return file;
  };

  it("is optional", () => {
    process.env.CAM_CONFIG = path.join(dir, "nincs.json");
    expect(readConfigFile()).toEqual({});
  });

  it("supplies the db path and the store locations", () => {
    write(JSON.stringify({ dbPath: "D:/index/hub.sqlite", roots: { codexStateDb: "D:/codex/state_5.sqlite" } }));
    const cfg = loadConfig();
    expect(cfg.dbPath).toBe("D:/index/hub.sqlite");
    expect(cfg.roots.codexStateDb).toBe("D:/codex/state_5.sqlite");
    // Overriding one store leaves the other nine alone.
    expect(cfg.roots.claudeProjects).toContain(".claude");
  });

  it("is reported and ignored when it is broken, never fatal", () => {
    write("{ ez nem json");
    const warnings: string[] = [];
    const cfg = loadConfig({}, (m) => warnings.push(m));
    expect(warnings[0]).toContain("nem olvasható");
    expect(cfg.dbPath).toContain("hub.sqlite");
  });
});

describe("precedence", () => {
  it("puts the explicit override above the environment, and that above the file", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ dbPath: path.join(dir, "file.sqlite") }), "utf8");
    process.env.CAM_CONFIG = file;

    expect(loadConfig().dbPath).toBe(path.join(dir, "file.sqlite"));

    process.env.CAM_DB = path.join(dir, "env.sqlite");
    expect(loadConfig().dbPath).toBe(path.join(dir, "env.sqlite"));

    expect(loadConfig({ dbPath: path.join(dir, "flag.sqlite") }).dbPath).toBe(path.join(dir, "flag.sqlite"));
  });

  it("lands in the user data directory when nothing says otherwise", () => {
    // The checkout this test runs from has a .data/hub.sqlite only sometimes;
    // point the profile elsewhere and assert the shape of the default.
    process.env.CAM_HOME = path.join(dir, "home");
    if (isWin) process.env.LOCALAPPDATA = path.join(dir, "Local");
    else process.env.XDG_DATA_HOME = path.join(dir, "share");

    const p = loadConfig().dbPath;
    // A checkout with an existing index keeps it; otherwise the data dir wins.
    const inDataDir = p.startsWith(isWin ? path.join(dir, "Local") : path.join(dir, "share"));
    expect(inDataDir || p.endsWith(path.join(".data", "hub.sqlite"))).toBe(true);
    expect(p.endsWith("hub.sqlite")).toBe(true);
    expect(p).not.toContain("node_modules");
  });
});
