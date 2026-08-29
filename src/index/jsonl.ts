import fs from "node:fs";
import { createHash } from "node:crypto";

export interface JsonlLine {
  /** Byte offset of the first byte of the line. */
  off: number;
  /** Byte length of the line, newline excluded. */
  len: number;
  /** Parsed JSON, or null when the line was malformed. */
  json: unknown;
  /** Raw text of the line (useful for diagnostics). */
  raw: string;
}

export interface ReadResult {
  lines: JsonlLine[];
  /** Byte offset after the last complete line — the next watermark. */
  endOffset: number;
  /** The file shrank below the watermark: it was rewritten, not appended to. */
  rotated?: boolean;
}

export const PREFIX_BYTES = 4096;

/**
 * SHA-256 over a FIXED window at the head of the file — the cheap guard that
 * tells an append (window unchanged) from a rewrite (window changed).
 *
 * The window length must be the same on both sides of a comparison, so callers
 * pass the length they used last time: `min(PREFIX_BYTES, bytes_indexed)`.
 * Hashing "whatever the file currently holds" would flag every append on a
 * file shorter than the window as a rotation.
 */
export function prefixHash(filePath: string, length = PREFIX_BYTES): string | null {
  const want = Math.max(0, Math.min(length, PREFIX_BYTES));
  if (want === 0) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(want);
    const read = fs.readSync(fd, buf, 0, want, 0);
    if (read < want) return null; // file shorter than the window: truncated
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Window length to use for a source that has `bytesIndexed` bytes indexed. */
export function prefixWindow(bytesIndexed: number): number {
  return Math.min(PREFIX_BYTES, Math.max(0, bytesIndexed));
}

/**
 * Read complete JSONL lines starting at `from`, tracking exact byte offsets so
 * every turn can be addressed by (path, off, len) instead of being copied.
 *
 * A partial trailing line (writer mid-append) is not returned and not counted
 * in `endOffset`, so the next run picks it up whole.
 */
export function readJsonlFrom(filePath: string, from = 0): ReadResult {
  const lines: JsonlLine[] = [];
  const stat = fs.statSync(filePath);

  // The file can shrink between the watermark check and this read (an atomic
  // replace, a crash-recovery rewrite). Treating that as "nothing new" would
  // reset the watermark to the smaller size and the rewritten content would
  // never be read again — silent, permanent loss.
  if (from > 0 && from > stat.size) return { lines, endOffset: 0, rotated: true };
  if (from >= stat.size) return { lines, endOffset: stat.size };

  const fd = fs.openSync(filePath, "r");
  try {
    const CHUNK = 1 << 20;
    let pos = from;
    let pending = Buffer.alloc(0);
    let pendingStart = from;

    while (pos < stat.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, stat.size - pos));
      const read = fs.readSync(fd, buf, 0, buf.length, pos);
      if (read <= 0) break;
      pos += read;
      pending = pending.length === 0 ? buf.subarray(0, read) : Buffer.concat([pending, buf.subarray(0, read)]);

      let nl: number;
      while ((nl = pending.indexOf(0x0a)) !== -1) {
        let lineBuf = pending.subarray(0, nl);
        // tolerate CRLF
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
          lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
        }
        const off = pendingStart;
        const len = lineBuf.length;
        const raw = lineBuf.toString("utf8");
        if (raw.trim().length > 0) {
          let json: unknown = null;
          try {
            json = JSON.parse(raw);
          } catch {
            json = null; // malformed line: skip the content, keep the offset
          }
          lines.push({ off, len, json, raw });
        }
        pendingStart += nl + 1;
        pending = pending.subarray(nl + 1);
      }
    }
    return { lines, endOffset: pendingStart };
  } finally {
    fs.closeSync(fd);
  }
}

/** Re-read one line by its recorded locator. */
export function readLineAt(filePath: string, off: number, len: number): unknown | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, off);
    return JSON.parse(buf.subarray(0, read).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Resolve a dotted/bracketed pointer such as `message.content[2].text`.
 * `content[*].text` concatenates every text block in order.
 */
export function pluck(root: unknown, pointer: string): string | null {
  const parts = pointer.split(".");
  let cur: unknown = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // `content[*].text` walks every element; `content[*type=text].text` walks
    // only the elements whose `type` field matches — the same rule the indexer
    // applied when it extracted the text, so the two cannot disagree and
    // produce a spurious "stale" verdict.
    const m = /^([^[]*)(?:\[(\*|\d+)(?:(\w+)=(\w+))?\])?$/.exec(part);
    if (!m) return null;
    const [, name = "", idx, filterKey, filterValue] = m;
    if (name) {
      if (cur === null || typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[name];
    }
    if (idx !== undefined) {
      if (!Array.isArray(cur)) return null;
      if (idx === "*") {
        const rest = parts.slice(i + 1).join(".");
        const out: string[] = [];
        for (const item of cur) {
          if (filterKey !== undefined) {
            if (!item || typeof item !== "object") continue;
            if ((item as Record<string, unknown>)[filterKey] !== filterValue) continue;
          }
          const v = rest ? pluck(item, rest) : item;
          if (typeof v === "string" && v.length > 0) out.push(v);
        }
        return out.length > 0 ? out.join("\n") : null;
      }
      cur = cur[Number.parseInt(idx, 10)];
    }
  }
  return typeof cur === "string" ? cur : null;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
