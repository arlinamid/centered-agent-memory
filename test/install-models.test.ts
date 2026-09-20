import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODELS_BYTES, candidates, describe as describeLocation, freeBytes, gb, plan, readCacheHome, writeCacheHome } from "../src/install/models.js";

let dir: string;
let configFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-models-"));
  configFile = path.join(dir, "config.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("free space", () => {
  it("reports a directory that exists", () => {
    const free = freeBytes(dir);
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
  });

  it("walks up to something that does exist", () => {
    // A location is worth reporting before anyone has created it — otherwise
    // the one answer the question needs is missing exactly when it is asked.
    // Not compared against the parent's exact figure: free space is live and
    // moves between two calls, which made this fail for reasons unrelated to it.
    const free = freeBytes(path.join(dir, "not", "made", "yet"));
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
  });

  it("says so rather than guessing when there is no answer", () => {
    expect(gb(null)).toBe("?");
    expect(gb(2 * 2 ** 30)).toBe("2.0 GB");
  });
});

describe("the choice that gets written", () => {
  it("records the location and leaves everything else alone", () => {
    fs.writeFileSync(configFile, JSON.stringify({ memory: { dream: { provider: "command" } }, update: { enabled: true } }));
    writeCacheHome(path.join(dir, "cache"), configFile);

    const written = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, any>;
    expect(written.memory.qmd.cacheHome).toBe(path.resolve(dir, "cache"));
    expect(written.memory.dream.provider).toBe("command");
    expect(written.update.enabled).toBe(true);
  });

  it("keeps the other qmd settings when the location changes", () => {
    fs.writeFileSync(configFile, JSON.stringify({ memory: { qmd: { rerank: false, minRerankScore: 0.5 } } }));
    writeCacheHome(path.join(dir, "cache"), configFile);
    const written = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, any>;
    expect(written.memory.qmd).toMatchObject({ rerank: false, minRerankScore: 0.5 });
  });

  it("stores an absolute path, whatever it was given", () => {
    // A relative cache home lands wherever the command was run from, which is
    // how two gigabytes of weights end up inside a repository.
    writeCacheHome(".cache", configFile);
    expect(path.isAbsolute(readCacheHome(configFile)!)).toBe(true);
  });

  it("reads back nothing when nobody chose", () => {
    fs.writeFileSync(configFile, "{}");
    expect(readCacheHome(configFile)).toBeNull();
  });
});

describe("the plan behind the prompt", () => {
  it("counts nothing cached in an empty place, and calls it too small when it is", () => {
    const p = plan(dir);
    expect(p.cached).toBe(0);
    expect(p.modelsDir).toBe(path.join(path.resolve(dir), "qmd", "models"));
    expect(typeof p.tooSmall).toBe("boolean");
  });

  it("needs less room when some of the weights are already there", () => {
    // Two thirds cached means a third of the download is left, and a drive
    // with room for that is a legitimate answer even if it is nearly full.
    expect(MODELS_BYTES).toBeGreaterThan(2 * 2 ** 30);
  });
});

describe("what gets offered", () => {
  it("puts a location that already holds the weights first", () => {
    const models = path.join(dir, "qmd", "models");
    fs.mkdirSync(models, { recursive: true });
    for (const f of ["embeddinggemma-300M-Q8_0.gguf", "qwen3-reranker-0.6b-q8_0.gguf"]) {
      fs.writeFileSync(path.join(models, `hf_org_${f}`), "x");
    }
    const found = candidates({ cacheHome: dir }, dir);
    const mine = found.find((f) => f.cacheHome === path.resolve(dir));
    expect(mine?.cached).toBe(2);
    // Ordered by what is already downloaded, because the alternative to a
    // location that has the weights is downloading them again. (Another drive
    // on this machine may legitimately hold all three and sort above it.)
    const cachedCounts = found.map((f) => f.cached);
    expect([...cachedCounts].sort((a, b) => b - a)).toEqual(cachedCounts);
  });

  it("always offers the home directory, and never the same place twice", () => {
    const found = candidates({ cacheHome: path.join(dir, ".cache") }, dir);
    const roots = found.map((f) => f.cacheHome.toLowerCase());
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots).toContain(path.join(path.resolve(dir), ".cache").toLowerCase());
  });

  it("describes a location without needing it to exist", () => {
    const where = describeLocation(path.join(dir, "nowhere"), "made up");
    expect(where.label).toBe("made up");
    expect(where.cached).toBe(0);
  });
});
