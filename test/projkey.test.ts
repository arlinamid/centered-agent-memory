import { describe, expect, it } from "vitest";
import { ProjectResolver } from "../src/attribution/projkey.js";
import { normalizePath, ancestors, basename, CASE_INSENSITIVE_FS } from "../src/paths.js";
import { PROJECT_MARKERS } from "../src/config.js";

/** Fake filesystem: a set of existing paths, normalized like the resolver does. */
function fakeExists(paths: string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => normalizePath(p)!));
  return (p) => set.has(normalizePath(p)!);
}

const REPO = [
  "C:/code/notes-app/.git",
  "C:/code/notes-app/backend/package.json",
  "C:/work/ras/package.json",
  "C:/work/árvíztűrő-terv/.git",
  "/home/dev/projects/api-gateway/go.mod",
];

function resolver(extra: Partial<ConstructorParameters<typeof ProjectResolver>[0]> = {}) {
  return new ProjectResolver({
    excluded: ["c:/users/x/appdata", "/tmp"],
    exists: fakeExists(REPO),
    ...extra,
  });
}

describe("case folding", () => {
  it("is pinned by CAM_CASE_FOLD, so an index is readable on any platform", () => {
    // The suite sets CAM_CASE_FOLD=1 (vitest.config.ts). Without the override
    // this flips with process.platform and every stored path flips with it.
    expect(process.env.CAM_CASE_FOLD).toBe("1");
    expect(CASE_INSENSITIVE_FS).toBe(true);
    expect(normalizePath("C:\\Work\\Demo")).toBe("c:/work/demo");
  });
});

describe("normalizePath", () => {
  const cases: Array<[string, string | null]> = [
    ["C:\\work\\RAS\\manifest.json", "c:/work/ras/manifest.json"],
    ["\\\\?\\C:\\code\\notes-app", "c:/code/notes-app"],
    ["file:///c%3A/code/Notes_app/x.py", "c:/code/notes_app/x.py"],
    ["/C:/work/RAS", "c:/work/ras"],
    ["C:/work//RAS//", "c:/work/ras"],
    ["https://www.w3.org/2000/svg", null],
    ["vscode-userdata:/User/settings.json", null],
    ["untitled:Untitled-1", null],
    ["", null],
  ];
  for (const [input, want] of cases) {
    it(`normalizes ${JSON.stringify(input)}`, () => {
      expect(normalizePath(input, true)).toBe(want);
    });
  }

  it("keeps POSIX absolute paths", () => {
    expect(normalizePath("/home/dev/projects/api-gateway/main.go", false)).toBe(
      "/home/dev/projects/api-gateway/main.go",
    );
  });

  it("preserves case when the host filesystem is case-sensitive", () => {
    expect(normalizePath("/home/Dev/App.ts", false)).toBe("/home/Dev/App.ts");
  });

  it("survives a malformed percent escape", () => {
    expect(normalizePath("file:///c%3A/work/ras/100%.md", true)).toBe("c:/work/ras/100%.md");
  });

  it("walks ancestors nearest-first", () => {
    expect(ancestors("c:/work/ras/src/x.ts")).toEqual(["c:/work/ras/src", "c:/work/ras", "c:/work"]);
    expect(basename("c:/work/ras")).toBe("ras");
  });
});

describe("ProjectResolver (marker-based, no hardcoded roots)", () => {
  it("finds the project from a .git marker", () => {
    const r = resolver();
    const got = r.resolve("C:/code/notes-app/frontend/src/App.tsx");
    expect(got).toEqual({ key: "notes-app", rootPath: "c:/code/notes-app", via: "marker" });
  });

  it("skips generic directory names when choosing the root", () => {
    // backend/ has its own package.json but 'backend' never names a project
    const r = resolver();
    expect(r.key("C:/code/notes-app/backend/app/main.py")).toBe("notes-app");
  });

  it("works on POSIX paths with no drive letter", () => {
    const r = new ProjectResolver({ excluded: [], exists: fakeExists(REPO) });
    expect(r.key("/home/dev/projects/api-gateway/cmd/serve/main.go")).toBe("api-gateway");
  });

  it("handles accented project directories", () => {
    expect(resolver().key("C:/work/árvíztűrő-terv/index.html")).toBe("árvíztűrő-terv");
  });

  it("returns null when no marker is found anywhere", () => {
    expect(resolver().key("E:/random/thing/file.txt")).toBeNull();
  });

  it("refuses to look inside excluded prefixes", () => {
    const r = resolver();
    expect(r.key("C:/Users/x/AppData/Local/Temp/claude/whatever/x.log")).toBeNull();
    expect(r.key("/tmp/scratch/x")).toBeNull();
  });

  it("rejects non-file locations", () => {
    const r = resolver();
    expect(r.key("https://github.com/o/r")).toBeNull();
    expect(r.key("/sessions/happy-great-cray")).toBeNull();
  });

  it("prefers a learned root over a filesystem probe, so deleted projects still resolve", () => {
    const r = resolver({ learned: new Map([["d:/gone/old-project", "old-project"]]) });
    expect(r.resolve("D:/gone/old-project/src/x.ts")).toEqual({
      key: "old-project",
      rootPath: "d:/gone/old-project",
      via: "learned",
    });
  });

  it("applies user aliases to merge duplicate checkouts", () => {
    const r = resolver({ aliases: new Map([["notes-app", "notes"]]) });
    const got = r.resolve("C:/code/notes-app/x.ts");
    expect(got?.key).toBe("notes");
    expect(got?.via).toBe("alias");
  });

  it("uses a learned workspace root when the project itself carries no marker", () => {
    const r = resolver({ workspaceRoots: ["C:/work"] });
    expect(r.resolve("C:/work/wide-font/src/x.ts")).toEqual({
      key: "wide-font",
      rootPath: "c:/work/wide-font",
      via: "workspace-root",
    });
  });

  it("stays unattributed for a session working in the workspace root itself", () => {
    const r = resolver({ workspaceRoots: ["C:/work"] });
    expect(r.key("C:/work")).toBeNull();
  });

  it("lets a workspace root override a marker on the aggregator directory", () => {
    // C:/work is itself a git repo holding twenty projects — the marker must
    // not win over the learned root.
    const r = new ProjectResolver({
      excluded: [],
      exists: fakeExists([...REPO, "C:/work/.git"]),
      workspaceRoots: ["C:/work"],
    });
    expect(r.key("C:/work/wifi/scan.py")).toBe("wifi");
  });

  it("never treats the user home as a project", () => {
    const r = new ProjectResolver({
      excluded: [],
      exists: fakeExists(["C:/Users/x/package.json"]),
      home: "C:/Users/x",
    });
    expect(r.key("C:/Users/x/notes.md")).toBeNull();
  });

  it("costs nothing to resolve further paths under a decided directory", () => {
    let probes = 0;
    const exists = fakeExists(REPO);
    const r = new ProjectResolver({
      excluded: [],
      exists: (p) => {
        probes++;
        return exists(p);
      },
    });
    expect(r.key("C:/code/notes-app/a/b/c.ts")).toBe("notes-app");
    const afterFirst = probes;
    expect(afterFirst).toBeGreaterThan(0);

    // sibling file in an already decided directory: free
    expect(r.key("C:/code/notes-app/a/b/d.ts")).toBe("notes-app");
    expect(probes).toBe(afterFirst);

    // a new subtree still has to be probed (it could be a nested project),
    // but only for its own directories — the project root stays cached
    const beforeSubtree = probes;
    expect(r.key("C:/code/notes-app/x/y/z.ts")).toBe("notes-app");
    const perDir = probes - beforeSubtree;
    expect(perDir).toBeGreaterThan(0);
    expect(perDir).toBeLessThanOrEqual(2 * PROJECT_MARKERS.length);
  });
});
