/**
 * A language-server process listing that every platform's port reader accepts.
 *
 * Windows asks PowerShell for one number per line; Linux asks `ss` then `lsof`;
 * macOS asks `lsof`. A mock that only speaks PowerShell passes on the author's
 * machine and fails in CI.
 *
 * `commandLine` must contain `language_server`: Linux and macOS list every
 * process with `ps` and keep only those whose args match that substring.
 * Windows filters by process name before we see the listing, so a short
 * `ls.exe` mock is green locally and empty everywhere else.
 */

export interface FakeDaemon {
  pid: number;
  commandLine: string;
  ports: number[];
}

export function fakeLanguageServers(daemons: ReadonlyArray<FakeDaemon>) {
  for (const d of daemons) {
    if (!/language_server/.test(d.commandLine)) {
      throw new Error(
        `fakeLanguageServers: commandLine must contain "language_server" so Linux/macOS ps filtering sees it (got ${JSON.stringify(d.commandLine)})`,
      );
    }
  }
  return ((cmd: string, args: string[]) => {
    const joined = [cmd, ...args].join(" ");
    if (/Win32_Process|-eo/.test(joined)) {
      return {
        status: 0,
        stdout: daemons.map((d) => `${d.pid}\t${d.commandLine}`).join("\n"),
        stderr: "",
      };
    }

    if (cmd === "ss") {
      return {
        status: 0,
        stdout: daemons
          .flatMap((d) =>
            d.ports.map(
              (port) =>
                `LISTEN 0 4096 127.0.0.1:${port} 0.0.0.0:* users:(("language_server",pid=${d.pid},fd=1))`,
            ),
          )
          .join("\n"),
        stderr: "",
      };
    }

    const pid = pidOf(args, joined);
    const match = daemons.find((d) => d.pid === pid);
    const ports = match?.ports ?? [];

    if (cmd === "lsof") {
      return {
        status: 0,
        stdout: ports
          .map((port) => `ls ${pid} user 1u IPv4 0t0 TCP 127.0.0.1:${port} (LISTEN)`)
          .join("\n"),
        stderr: "",
      };
    }

    return { status: 0, stdout: ports.join("\n") + "\n", stderr: "" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function pidOf(args: string[], joined: string): number {
  const flag = args.indexOf("-p");
  if (flag >= 0) return Number.parseInt(args[flag + 1] ?? "", 10);
  const eq = /(?:-eq|\.OwningProcess -eq|eq)\s+(\d+)/.exec(joined);
  if (eq) return Number.parseInt(eq[1]!, 10);
  return Number.NaN;
}
