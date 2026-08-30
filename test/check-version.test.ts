import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION_MARK, checkVersion } from "../.github/scripts/check-version.mjs";

describe("check-version", () => {
  it("accepts the working tree when every surface names package.json", () => {
    const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
    expect(checkVersion(process.cwd(), version)).toEqual([]);
  });

  it("names every surface that is missing the version", () => {
    const problems = checkVersion(process.cwd(), "9.9.9");
    expect(problems.some((p) => p.includes("package.json"))).toBe(true);
    expect(problems.some((p) => p.includes("CHANGELOG.md"))).toBe(true);
    expect(problems.some((p) => p.includes("README.md"))).toBe(true);
    expect(problems.some((p) => p.includes("README.hu.md"))).toBe(true);
    expect(problems.some((p) => p.includes(VERSION_MARK("9.9.9")) || p.includes("SERVER_VERSION"))).toBe(true);
  });
});
