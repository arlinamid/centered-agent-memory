import { describe, expect, it } from "vitest";
import {
  bumpKind,
  decide,
  moveUnreleased,
  nextVersion,
  setLockVersion,
} from "../.github/scripts/cut-release-tag.mjs";

describe("cut-release-tag", () => {
  const named = "## [Unreleased]\n\n## [0.6.0] — 2026-08-30\n\n- something\n";

  it("tags a new version that the changelog already names", () => {
    expect(
      decide({
        version: "0.6.0",
        lockVersion: "0.6.0",
        changelog: named,
        released: false,
        tagged: false,
        ahead: false,
      }),
    ).toEqual({ action: "tag", reason: "v0.6.0 is new" });
  });

  it("does nothing when HEAD is the already-released tag", () => {
    expect(
      decide({
        version: "0.5.0",
        lockVersion: "0.5.0",
        changelog: named,
        released: true,
        tagged: true,
        ahead: false,
      }).action,
    ).toBe("skip");
  });

  it("does nothing when the tag exists but the release job has not finished", () => {
    expect(
      decide({
        version: "0.6.0",
        lockVersion: "0.6.0",
        changelog: named,
        released: false,
        tagged: true,
        ahead: false,
      }).action,
    ).toBe("skip");
  });

  it("bumps the patch when a released version has new commits and no breaking note", () => {
    const out = decide({
      version: "0.5.0",
      lockVersion: "0.5.0",
      changelog: "## [Unreleased]\n\n- a fix\n\n## [0.5.0] — 2026-08-29\n",
      released: true,
      tagged: true,
      ahead: true,
    });
    expect(out).toMatchObject({ action: "bump", next: "0.5.1", kind: "patch" });
  });

  it("bumps the minor when Unreleased names a breaking change", () => {
    const out = decide({
      version: "0.5.0",
      lockVersion: "0.5.0",
      changelog: "## [Unreleased]\n\n> **Breaking change:** Node 24\n\n## [0.5.0]\n",
      released: true,
      tagged: true,
      ahead: true,
    });
    expect(out).toMatchObject({ action: "bump", next: "0.6.0", kind: "minor" });
  });

  it("refuses to tag when the human bumped the number but left Unreleased only", () => {
    const out = decide({
      version: "0.6.0",
      lockVersion: "0.6.0",
      changelog: "## [Unreleased]\n\n- not moved yet\n",
      released: false,
      tagged: false,
      ahead: false,
    });
    expect(out.action).toBe("fail");
    expect(out.reason).toMatch(/CHANGELOG/);
  });

  it("refuses when the lockfile still carries the previous version", () => {
    const out = decide({
      version: "0.6.0",
      lockVersion: "0.5.0",
      changelog: named,
      released: false,
      tagged: false,
      ahead: false,
    });
    expect(out.action).toBe("fail");
    expect(out.reason).toMatch(/package-lock/);
  });

  it("computes the next patch and minor", () => {
    expect(nextVersion("0.5.0", "patch")).toBe("0.5.1");
    expect(nextVersion("0.5.0", "minor")).toBe("0.6.0");
    expect(bumpKind("## [Unreleased]\n\n- docs\n")).toBe("patch");
    expect(bumpKind("## [Unreleased]\n\n> **Breaking change:** x\n")).toBe("minor");
  });

  it("moves Unreleased under the new version heading", () => {
    const out = moveUnreleased("## [Unreleased]\n\n- a fix\n\n## [0.5.0] — 2026-08-29\n", "0.5.1", "2026-08-30");
    expect(out).toContain("## [Unreleased]\n\n## [0.5.1] — 2026-08-30\n\n- a fix\n");
    expect(out).toContain("## [0.5.0] — 2026-08-29");
  });

  it("rewrites only the package's own lockfile version fields", () => {
    const lock = `{\n  "version": "0.5.0",\n  "packages": {\n    "": {\n      "version": "0.5.0"\n    },\n    "node_modules/x": {\n      "version": "0.5.0"\n    }\n  }\n}\n`;
    expect(setLockVersion(lock, "0.5.0", "0.5.1")).toBe(
      `{\n  "version": "0.5.1",\n  "packages": {\n    "": {\n      "version": "0.5.1"\n    },\n    "node_modules/x": {\n      "version": "0.5.0"\n    }\n  }\n}\n`,
    );
  });
});
