import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Was this file run, or imported? A filename match would also fire on an
 * import, so the two paths are compared in full — but resolved first.
 *
 * Node hands out `import.meta.url` with symlinks resolved and `process.argv[1]`
 * exactly as the shell wrote it, and a Node version manager puts a symlink in
 * the middle of every global install (`C:\nvm\current`, `~/.nvm/versions/...`),
 * as does `npm link` (a junction on Windows). Comparing them raw made the
 * globally installed CLI do nothing at all and exit zero, which a scheduled
 * task reports as an hourly success — and made the MCP server exit before its
 * first message, which a client reports as a closed connection.
 */
export function isEntryPoint(entry: string, argv1 = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(fileURLToPath(entry)) === real(argv1);
}
