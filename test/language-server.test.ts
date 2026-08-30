import { describe, expect, it } from "vitest";
import {
  CSRF_HEADER,
  DaemonSession,
  SERVICE,
  callRpc,
  csrfTokenFor,
  csrfTokenOf,
  httpPortCandidates,
  parseLsofPorts,
  parsePorts,
  parseProcessLines,
  parseSsPorts,
} from "../src/sources/language-server.js";
import { WINDSURF_CSRF_ENV } from "../src/sources/process-env.js";
import { fakeLanguageServers } from "./helpers/daemon.js";

/**
 * The parts of the Antigravity daemon protocol that were measured rather than
 * assumed. Each case here is a mistake that looked right at the time.
 */

describe("finding the daemon", () => {
  it("reads pid and command line out of a process listing", () => {
    const procs = parseProcessLines(
      [
        "46680\tC:\\Program Files\\language_server_windows_x64.exe --csrf_token abc --extension_server_port 1",
        "   49636  /opt/antigravity/language_server --csrf_token=def",
        "not a process line",
        "",
      ].join("\n"),
    );
    expect(procs.map((p) => p.pid)).toEqual([46680, 49636]);
  });

  it("takes --csrf_token and not the similarly named one beside it", () => {
    // `--extension_server_csrf_token` guards a different service. Matching by
    // substring would pick whichever came first and fail with a token that
    // looks entirely plausible.
    const cmd = "language_server.exe --extension_server_csrf_token WRONG --csrf_token the-real-one --port 1";
    expect(csrfTokenOf(cmd)).toBe("the-real-one");

    expect(csrfTokenOf('ls.exe --csrf_token="quoted-token"')).toBe("quoted-token");
    expect(csrfTokenOf("ls.exe --csrf_token=equals-form")).toBe("equals-form");
    expect(csrfTokenOf("ls.exe --extension_server_csrf_token only-the-other-one")).toBeNull();
    expect(csrfTokenOf("ls.exe --no-token-at-all")).toBeNull();
  });

  it("falls back to WINDSURF_CSRF_TOKEN when argv has no --csrf_token", () => {
    const proc = { pid: 42, commandLine: "language_server.exe --parent_pipe_path \\\\.\\pipe\\s" };
    expect(csrfTokenFor(proc, { envOf: () => null })).toBeNull();
    expect(
      csrfTokenFor(proc, {
        envOf: (pid, name) => (pid === 42 && name === WINDSURF_CSRF_ENV ? "from-env" : null),
      }),
    ).toBe("from-env");
    expect(
      csrfTokenFor(
        { pid: 42, commandLine: "ls.exe --csrf_token from-argv" },
        { envOf: () => "from-env" },
      ),
    ).toBe("from-argv");
  });

  it("tries the higher port first, because the lower one is the HTTPS side", () => {
    // Measured: the daemon opened one port for HTTPS/gRPC and the next for HTTP.
    expect(httpPortCandidates([55026, 55027])).toEqual([55027, 55026]);
    expect(httpPortCandidates([53977, 53978, 53989])).toEqual([53989, 53978, 53977]);
  });

  it("reads a port list that has blank lines in it", () => {
    expect(parsePorts("55027\r\n55026\r\n\r\n")).toEqual([55026, 55027]);
    expect(parsePorts("")).toEqual([]);
  });

  it("reads the LISTEN column of lsof -nP -iTCP", () => {
    // macOS, and Linux where lsof exists. The name column is
    // "127.0.0.1:55027 (LISTEN)"; a connected socket on the same pid is not.
    const stdout = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "ls  46680 user   19u  IPv4  0t0  TCP 127.0.0.1:55026 (LISTEN)",
      "ls  46680 user   20u  IPv4  0t0  TCP 127.0.0.1:55027 (LISTEN)",
      "ls  46680 user   21u  IPv4  0t0  TCP 127.0.0.1:55027->127.0.0.1:9 (ESTABLISHED)",
      "",
    ].join("\n");
    expect(parseLsofPorts(stdout)).toEqual([55026, 55027]);
    expect(parseLsofPorts("")).toEqual([]);
  });

  it("reads only the pid's own sockets out of ss -ltnp", () => {
    // `ss` filters by state, not by process: every listener on the machine
    // comes back, and the pid sits inside users:(("name",pid=N,fd=M)).
    // Matching the wrong pid would attribute sshd's port 22 to the daemon.
    const stdout = [
      "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      'LISTEN 0 4096 127.0.0.1:55026 0.0.0.0:* users:(("language_server",pid=46680,fd=19))',
      'LISTEN 0 4096 [::1]:55027 0.0.0.0:* users:(("language_server",pid=46680,fd=20))',
      'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
      'LISTEN 0 4096 127.0.0.1:53989 0.0.0.0:* users:(("language_server",pid=99999,fd=8))',
      "",
    ].join("\n");
    expect(parseSsPorts(stdout, 46680)).toEqual([55026, 55027]);
    expect(parseSsPorts(stdout, 1)).toEqual([22]);
    expect(parseSsPorts(stdout, 404)).toEqual([]);
  });
});

describe("calling the daemon", () => {
  const daemon = { port: 55027, csrfToken: "tok" };

  it("sends the vendor-prefixed CSRF header, not the obvious one", async () => {
    // With `x-csrf-token` the daemon answers
    // {"code":"unauthenticated","message":"missing CSRF token"} — a 401 that
    // reads like a wrong token rather than a wrong header name.
    expect(CSRF_HEADER).toBe("x-codeium-csrf-token");

    let seen: Record<string, string> = {};
    let url = "";
    const fetchImpl = (async (u: string, init: { headers: Record<string, string> }) => {
      url = u;
      seen = init.headers;
      return { ok: true, status: 200, text: async () => '{"trajectories":[]}' };
    }) as unknown as typeof globalThis.fetch;

    const r = await callRpc(daemon, "GetAllCascadeTrajectories", {}, { fetchImpl });
    expect(url).toBe(`http://127.0.0.1:55027/${SERVICE}/GetAllCascadeTrajectories`);
    expect(seen[CSRF_HEADER]).toBe("tok");
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ trajectories: [] });
  });

  it("hands back the plaintext complaint from the HTTPS port as-is", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      text: async () => "Client sent an HTTP request to an HTTPS server.",
    })) as unknown as typeof globalThis.fetch;

    const r = await callRpc(daemon, "GetAllCascadeTrajectories", {}, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.body).toBe("Client sent an HTTP request to an HTTPS server.");
  });

  it("reports a dead port instead of throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const r = await callRpc(daemon, "GetAllCascadeTrajectories", {}, { fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 0, detail: "fetch failed" });
  });
});

/**
 * The MCP server answers one question at a time, seconds apart. Finding the
 * daemon means listing every process on the machine, so the address is cached —
 * but only for a while, because Antigravity picks new random ports every time
 * it starts.
 */
describe("holding on to the daemon address", () => {
  const DEVIN = {
    pid: 46680,
    commandLine: "language_server.exe --csrf_token tok",
    ports: [55027, 55026],
  };

  const listing = (present: boolean, count?: { n: number }) => {
    const run = fakeLanguageServers(present ? [DEVIN] : []);
    if (!count) return run;
    return ((cmd: string, args: string[]) => {
      if (/Win32_Process|-eo/.test([cmd, ...args].join(" "))) count.n++;
      return run(cmd, args);
    }) as typeof run;
  };

  const answering = (async () => ({
    ok: true,
    status: 200,
    text: async () => '{"trajectories":[]}',
  })) as unknown as typeof globalThis.fetch;

  it("finds a running daemon and reports its address", async () => {
    const session = new DaemonSession({ run: listing(true), fetchImpl: answering });
    expect(await session.acquire()).toEqual({ pid: 46680, port: 55027, csrfToken: "tok" });
  });

  it("says there is none when Antigravity is closed, rather than starting one", async () => {
    // Measured with Antigravity shut: `agy agentapi get-conversation-metadata`
    // exits 1 with "ANTIGRAVITY_LS_ADDRESS is not set" — it is a client of a
    // daemon, not a way to start one. So this has to answer null and say so.
    const session = new DaemonSession({ run: listing(false), fetchImpl: answering });
    expect(await session.acquire()).toBeNull();
  });

  it("reuses the address instead of listing every process again", async () => {
    const count = { n: 0 };
    const session = new DaemonSession({ run: listing(true, count), fetchImpl: answering });
    await session.acquire();
    expect(count.n).toBe(1);
    await session.acquire();
    await session.acquire();
    expect(count.n).toBe(1);
  });

  it("looks again once the address is old enough to be wrong", async () => {
    // Antigravity restarts on fresh random ports, so a cached address outlives
    // its truth — and a stale one fails in a way that looks like "not running".
    const count = { n: 0 };
    let clock = 1_000_000;
    const session = new DaemonSession({
      run: listing(true, count),
      fetchImpl: answering,
      ttlMs: 1000,
      now: () => clock,
    });

    await session.acquire();
    expect(count.n).toBe(1);

    clock += 500;
    await session.acquire();
    expect(count.n).toBe(1);

    clock += 600;
    await session.acquire();
    expect(count.n).toBe(2);
  });

  it("forgets the address on close", async () => {
    const count = { n: 0 };
    const session = new DaemonSession({ run: listing(true, count), fetchImpl: answering });
    await session.acquire();
    session.close();
    await session.acquire();
    expect(count.n).toBe(2);
  });

  it("finds a daemon whose token is only in the environment", async () => {
    const run = fakeLanguageServers([
      { pid: 7, commandLine: "language_server.exe --parent_pipe_path \\\\.\\pipe\\s", ports: [56027, 56026] },
    ]);
    const session = new DaemonSession({
      run,
      fetchImpl: answering,
      envOf: (pid, name) => (pid === 7 && name === WINDSURF_CSRF_ENV ? "env-tok" : null),
    });
    expect(await session.acquire()).toEqual({ pid: 7, port: 56027, csrfToken: "env-tok" });
  });

  it("returns every live daemon, because the first one may be the wrong surface", async () => {
    const run = fakeLanguageServers([
      { pid: 1, commandLine: "language_server --csrf_token a", ports: [55027, 55026] },
      { pid: 2, commandLine: "language_server --csrf_token b", ports: [56027, 56026] },
    ]);
    const session = new DaemonSession({ run, fetchImpl: answering });
    expect(await session.acquireAll()).toEqual([
      { pid: 1, port: 55027, csrfToken: "a" },
      { pid: 2, port: 56027, csrfToken: "b" },
    ]);
  });
});
