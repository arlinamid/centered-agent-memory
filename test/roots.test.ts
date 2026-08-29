import { describe, expect, it } from "vitest";
import { detectWorkspaceRoots } from "../src/attribution/roots.js";

describe("detectWorkspaceRoots", () => {
  it("finds a directory whose children are several different working directories", () => {
    const cwds = [
      "C:/work/ras",
      "C:/work/linter",
      "C:/work/boardgame",
      "C:/work/ras/src",
      "C:/code/notes-app",
    ];
    const got = detectWorkspaceRoots(cwds);
    expect(got.map((d) => d.root)).toEqual(["c:/work"]);
    expect(got[0]!.children).toBe(3);
  });

  it("does not promote a directory with too few distinct children", () => {
    expect(detectWorkspaceRoots(["C:/code/notes-app", "C:/code/notes-app/backend"])).toEqual([]);
  });

  it("works on POSIX paths", () => {
    const got = detectWorkspaceRoots(["/home/d/src/a", "/home/d/src/b", "/home/d/src/c"], 3);
    expect(got.map((d) => d.root)).toEqual(["/home/d/src"]);
  });

  it("ignores drive roots and generic child names", () => {
    expect(detectWorkspaceRoots(["D:/a", "D:/b", "D:/c"])).toEqual([]);
    expect(
      detectWorkspaceRoots(["D:/w/node_modules", "D:/w/dist", "D:/w/build", "D:/w/temp"]),
    ).toEqual([]);
  });

  it("respects a custom threshold", () => {
    const cwds = ["D:/w/a", "D:/w/b"];
    expect(detectWorkspaceRoots(cwds, 3)).toEqual([]);
    expect(detectWorkspaceRoots(cwds, 2).map((d) => d.root)).toEqual(["d:/w"]);
  });

  it("skips paths it cannot normalize", () => {
    expect(detectWorkspaceRoots(["/sessions/foo", "https://x/y", "", "D:/w/a"])).toEqual([]);
  });
});
