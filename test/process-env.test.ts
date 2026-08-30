import { describe, expect, it } from "vitest";
import {
  WINDSURF_CSRF_ENV,
  parseEnvironBlock,
  parseKernProcargs2,
  parsePsEwwEnv,
  readProcessEnvVar,
} from "../src/sources/process-env.js";

const TOKEN = "aaaaaaaa-1111-2222-3333-444444444444";

/** `sysctl -b kern.procargs2.<pid>`: argc, exec path, argv, then env. */
function kernProcargs2(exec: string, argv: ReadonlyArray<string>, env: Record<string, string>): Buffer {
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(argv.length, 0);
  const chunks: Buffer[] = [argc, Buffer.from(`${exec}\0`), Buffer.alloc(8)];
  for (const a of argv) chunks.push(Buffer.from(`${a}\0`));
  chunks.push(Buffer.alloc(4));
  const pairs = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\0");
  chunks.push(Buffer.from(`${pairs}\0\0`));
  return Buffer.concat(chunks);
}

describe("reading one variable from another process", () => {
  it("reads a null-separated KEY=VALUE block, as /proc/pid/environ uses", () => {
    const env = parseEnvironBlock(`PATH=/usr/bin\0${WINDSURF_CSRF_ENV}=${TOKEN}\0HOME=/home/x\0`);
    expect(env.get(WINDSURF_CSRF_ENV)).toBe(TOKEN);
    expect(env.get("PATH")).toBe("/usr/bin");
    expect(parseEnvironBlock("").size).toBe(0);
  });

  it("skips the padding between the exec path and argv on macOS", () => {
    // A short argv with a long zero pad is how this parser used to swallow
    // the environment: it treated the pad as missing arguments.
    const buf = kernProcargs2("/opt/devin/language_server", ["language_server", "--stdio"], {
      PATH: "/usr/bin",
      [WINDSURF_CSRF_ENV]: TOKEN,
    });
    const env = parseKernProcargs2(buf);
    expect(env.get(WINDSURF_CSRF_ENV)).toBe(TOKEN);
    expect(parseKernProcargs2(Buffer.alloc(0)).size).toBe(0);
  });

  it("reads KEY=value words out of ps eww, which is enough for a GUID", () => {
    const line =
      `/opt/devin/language_server --parent_pipe_path /tmp/p ${WINDSURF_CSRF_ENV}=${TOKEN} PATH=/usr/bin`;
    expect(parsePsEwwEnv(line).get(WINDSURF_CSRF_ENV)).toBe(TOKEN);
    expect(parsePsEwwEnv("no equals signs here").size).toBe(0);
  });

  it("uses the injected lookup, so the suite never opens a real process", () => {
    expect(
      readProcessEnvVar(9, WINDSURF_CSRF_ENV, {
        envOf: (pid, name) => (pid === 9 && name === WINDSURF_CSRF_ENV ? TOKEN : null),
      }),
    ).toBe(TOKEN);
    expect(readProcessEnvVar(9, "OTHER", { envOf: () => TOKEN })).toBe(TOKEN);
    expect(readProcessEnvVar(9, "not a name!", { envOf: () => TOKEN })).toBeNull();
  });
});
