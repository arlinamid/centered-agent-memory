import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREFIX_BYTES, pluck, prefixHash, prefixWindow, readJsonlFrom, readLineAt } from "../src/index/jsonl.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-jsonl-"));
  file = path.join(dir, "session.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("readJsonlFrom", () => {
  it("records byte offsets that round-trip back to the same record", () => {
    fs.writeFileSync(
      file,
      line({ type: "user", message: { content: "első üzenet" } }) +
        line({ type: "assistant", message: { content: "válasz ékezettel: őű" } }),
      "utf8",
    );
    const { lines, endOffset } = readJsonlFrom(file);
    expect(lines).toHaveLength(2);
    expect(endOffset).toBe(fs.statSync(file).size);

    for (const l of lines) {
      expect(readLineAt(file, l.off, l.len)).toEqual(l.json);
    }
  });

  it("resumes from a watermark and returns only new lines", () => {
    fs.writeFileSync(file, line({ i: 1 }) + line({ i: 2 }), "utf8");
    const first = readJsonlFrom(file);
    expect(first.lines).toHaveLength(2);

    fs.appendFileSync(file, line({ i: 3 }), "utf8");
    const second = readJsonlFrom(file, first.endOffset);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]!.json).toEqual({ i: 3 });
    expect(readLineAt(file, second.lines[0]!.off, second.lines[0]!.len)).toEqual({ i: 3 });
  });

  it("does not consume a half-written trailing line", () => {
    fs.writeFileSync(file, line({ i: 1 }) + '{"i":2', "utf8");
    const r = readJsonlFrom(file);
    expect(r.lines).toHaveLength(1);
    expect(r.endOffset).toBeLessThan(fs.statSync(file).size);

    fs.appendFileSync(file, '}\n', "utf8");
    const r2 = readJsonlFrom(file, r.endOffset);
    expect(r2.lines[0]!.json).toEqual({ i: 2 });
  });

  it("skips a malformed line without losing the offsets after it", () => {
    fs.writeFileSync(file, line({ i: 1 }) + "{ not json at all\n" + line({ i: 3 }), "utf8");
    const { lines } = readJsonlFrom(file);
    expect(lines).toHaveLength(3);
    expect(lines[1]!.json).toBeNull();
    expect(lines[2]!.json).toEqual({ i: 3 });
    expect(readLineAt(file, lines[2]!.off, lines[2]!.len)).toEqual({ i: 3 });
  });

  it("tolerates CRLF", () => {
    fs.writeFileSync(file, '{"i":1}\r\n{"i":2}\r\n', "utf8");
    const { lines } = readJsonlFrom(file);
    expect(lines.map((l) => l.json)).toEqual([{ i: 1 }, { i: 2 }]);
  });

  it("handles a line larger than the read buffer", () => {
    const big = { text: "x".repeat(3 * 1024 * 1024) };
    fs.writeFileSync(file, line(big), "utf8");
    const { lines } = readJsonlFrom(file);
    expect(lines).toHaveLength(1);
    expect((lines[0]!.json as { text: string }).text).toHaveLength(3 * 1024 * 1024);
  });

  it("returns nothing when the watermark is already at the end", () => {
    fs.writeFileSync(file, line({ i: 1 }), "utf8");
    const size = fs.statSync(file).size;
    expect(readJsonlFrom(file, size).lines).toHaveLength(0);
  });
});

describe("prefixHash", () => {
  it("is stable across appends when the same window is used", () => {
    fs.writeFileSync(file, line({ i: 1 }), "utf8");
    const indexed = fs.statSync(file).size;
    const win = prefixWindow(indexed);
    const a = prefixHash(file, win);
    expect(a).not.toBeNull();

    fs.appendFileSync(file, line({ i: 2 }), "utf8");
    expect(prefixHash(file, win)).toBe(a); // append-only: window intact
  });

  it("changes when the head of the file is rewritten", () => {
    fs.writeFileSync(file, line({ i: 1 }), "utf8");
    const win = prefixWindow(fs.statSync(file).size);
    const a = prefixHash(file, win);
    fs.writeFileSync(file, line({ i: 9 }), "utf8");
    expect(prefixHash(file, win)).not.toBe(a); // rotated in place
  });

  it("reports truncation as null rather than a different hash", () => {
    fs.writeFileSync(file, line({ i: 1 }) + line({ i: 2 }), "utf8");
    const win = prefixWindow(fs.statSync(file).size);
    expect(prefixHash(file, win)).not.toBeNull();
    fs.writeFileSync(file, "{}\n", "utf8"); // now shorter than the window
    expect(prefixHash(file, win)).toBeNull();
  });

  it("caps the window at PREFIX_BYTES", () => {
    fs.writeFileSync(file, "x".repeat(PREFIX_BYTES * 3), "utf8");
    expect(prefixWindow(PREFIX_BYTES * 3)).toBe(PREFIX_BYTES);
    expect(prefixHash(file, PREFIX_BYTES * 3)).toBe(prefixHash(file, PREFIX_BYTES));
  });

  it("returns null for an unindexed source and for a missing file", () => {
    expect(prefixHash(file, prefixWindow(0))).toBeNull();
    expect(prefixHash(path.join(dir, "nope.jsonl"))).toBeNull();
  });
});

describe("pluck", () => {
  const rec = {
    message: {
      content: [
        { type: "thinking", signature: "BASE64GARBAGE" },
        { type: "text", text: "első" },
        { type: "text", text: "második" },
      ],
    },
    payload: { message: "codex szöveg" },
  };

  it("reads a plain pointer", () => {
    expect(pluck(rec, "payload.message")).toBe("codex szöveg");
  });

  it("reads an indexed pointer", () => {
    expect(pluck(rec, "message.content[1].text")).toBe("első");
  });

  it("concatenates every text block with [*]", () => {
    expect(pluck(rec, "message.content[*].text")).toBe("első\nmásodik");
  });

  it("returns null for a missing path", () => {
    expect(pluck(rec, "message.nope.text")).toBeNull();
    expect(pluck(rec, "message.content[9].text")).toBeNull();
  });

  it("returns null for a non-string leaf", () => {
    expect(pluck(rec, "message.content")).toBeNull();
  });
});
