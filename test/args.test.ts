import { describe, expect, it } from "vitest";
import { dateFlag, flag, has, limit, parseArgs, type FlagSpec } from "../src/args.js";

const SPEC: FlagSpec = { bools: ["json", "subagents"], values: ["project", "limit", "since"] };

describe("parseArgs", () => {
  it("keeps the positional that follows a bool flag", () => {
    const a = parseArgs(["--json", "mi volt a hiba?"], SPEC);
    expect(a.positional).toEqual(["mi volt a hiba?"]);
    expect(has(a, "json")).toBe(true);
    expect(a.errors).toEqual([]);
  });

  it("consumes the value of a value flag", () => {
    const a = parseArgs(["--project", "demo", "kérdés"], SPEC);
    expect(flag(a, "project")).toBe("demo");
    expect(a.positional).toEqual(["kérdés"]);
  });

  it("accepts the --flag=value form for both kinds", () => {
    const a = parseArgs(["--project=demo", "x"], SPEC);
    expect(flag(a, "project")).toBe("demo");
    expect(parseArgs(["--json=igen"], SPEC).errors[0]).toContain("does not take a value");
  });

  it("reports an unknown flag rather than dropping it", () => {
    const a = parseArgs(["--projct", "demo"], SPEC);
    expect(a.errors[0]).toContain("unknown flag: --projct");
  });

  it("reports a value flag at the end of the line", () => {
    expect(parseArgs(["--project"], SPEC).errors[0]).toContain("requires a value");
    expect(parseArgs(["--project", "--json"], SPEC).errors[0]).toContain("requires a value");
  });

  it("treats everything after a bare -- as positional", () => {
    const a = parseArgs(["--json", "--", "--project", "-x"], SPEC);
    expect(a.positional).toEqual(["--project", "-x"]);
    expect(a.errors).toEqual([]);
  });

  it("takes the last value when a flag is repeated", () => {
    expect(flag(parseArgs(["--project", "a", "--project", "b"], SPEC), "project")).toBe("b");
  });
});

describe("limit", () => {
  it("falls back when absent and caps at the maximum", () => {
    expect(limit(parseArgs([], SPEC), 10)).toBe(10);
    expect(limit(parseArgs(["--limit", "5000"], SPEC), 10, 1000)).toBe(1000);
  });

  it("rejects zero, negatives and non-numbers", () => {
    for (const bad of ["0", "-3", "kettő", "2.5"]) {
      const a = parseArgs(["--limit", bad], SPEC);
      expect(limit(a, 10)).toBe(10);
      expect(a.errors[0]).toContain("--limit");
    }
  });
});

describe("dateFlag", () => {
  it("parses a date and reports an unparsable one", () => {
    expect(dateFlag(parseArgs(["--since", "2026-08-01"], SPEC), "since")).toBe(Date.parse("2026-08-01"));
    const a = parseArgs(["--since", "tegnapelőtt"], SPEC);
    expect(dateFlag(a, "since")).toBeNull();
    expect(a.errors[0]).toContain("--since");
  });
});
