import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientTargets, SERVER_KEY, type ClientId, type ClientTarget, type Scope } from "./clients.js";
import {
  backupOnce,
  ConfigParseError,
  removeJson,
  removeToml,
  serverEntry,
  upsertJson,
  upsertToml,
  type Change,
  type Edit,
  type ServerEntry,
} from "./mcp.js";
import { removeSkill, renderSkill, skillBody, skillState, writeSkill, type SkillChange } from "./skills.js";

/**
 * Wiring the server into every agent tool on the machine.
 *
 * The whole operation is a plan first and a write second, so `--dry-run`
 * reports exactly what the real run would do rather than an approximation of
 * it — the same discipline `cam prune --dry-run` follows, for the same reason:
 * these are other people's files.
 */

export interface InstallOptions {
  scope?: Scope;
  /** Restrict to these clients; empty or absent means every one detected. */
  only?: ClientId[];
  mcp?: boolean;
  skills?: boolean;
  dryRun?: boolean;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override what gets written as the server command. */
  entry?: ServerEntry;
}

export interface ClientReport {
  id: ClientId;
  name: string;
  scope: Scope;
  installed: boolean;
  mcpFile: string | null;
  mcpChange: Change | null;
  skillFile: string | null;
  skillChange: SkillChange | null;
  error: string | null;
}

export interface InstallReport {
  scope: Scope;
  entry: ServerEntry;
  clients: ClientReport[];
  backups: string[];
  dryRun: boolean;
}

const stamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");

function editFor(target: ClientTarget, entry: ServerEntry, remove: boolean): Edit {
  const file = target.mcpFile!;
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  switch (target.mcpFormat) {
    case "json":
      return remove ? removeJson(text, file, SERVER_KEY) : upsertJson(text, file, SERVER_KEY, entry);
    case "toml":
      return remove
        ? removeToml(text, `mcp_servers.${SERVER_KEY}`)
        : upsertToml(text, `mcp_servers.${SERVER_KEY}`, entry);
    default: {
      const never: never = target.mcpFormat;
      throw new Error(`ismeretlen formátum: ${String(never)}`);
    }
  }
}

function apply(opts: InstallOptions, remove: boolean): InstallReport {
  const scope = opts.scope ?? "user";
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const entry = opts.entry ?? serverEntry(env);
  const dryRun = opts.dryRun ?? false;
  const doMcp = opts.mcp ?? true;
  const doSkills = opts.skills ?? true;
  const only = new Set(opts.only ?? []);
  const backups = new Set<string>();
  const at = stamp();

  const clients: ClientReport[] = [];
  for (const target of clientTargets(scope, home, cwd)) {
    if (only.size > 0 && !only.has(target.id)) continue;

    const report: ClientReport = {
      id: target.id,
      name: target.name,
      scope: target.scope,
      installed: target.installed,
      mcpFile: doMcp ? target.mcpFile : null,
      mcpChange: null,
      skillFile: doSkills ? target.skillFile : null,
      skillChange: null,
      error: null,
    };
    clients.push(report);
    // A tool that is not installed gets nothing: creating its config would be
    // how you end up with a ~/.codex that no Codex ever wrote.
    if (!target.installed) continue;

    try {
      if (doMcp && target.mcpFile) {
        const edit = editFor(target, entry, remove);
        report.mcpChange = edit.change;
        if (!dryRun && edit.change !== "unchanged" && edit.change !== "absent") {
          const made = backupOnce(target.mcpFile, backups, at);
          if (made) backups.add(made);
          fs.mkdirSync(path.dirname(target.mcpFile), { recursive: true });
          fs.writeFileSync(target.mcpFile, edit.text, "utf8");
        }
      }

      if (doSkills && target.skillFile) {
        if (remove) {
          report.skillChange = dryRun
            ? fs.existsSync(target.skillFile)
              ? "removed"
              : "absent"
            : removeSkill(target.skillFile);
        } else {
          const text = renderSkill(target, skillBody());
          report.skillChange = skillState(target.skillFile, text);
          if (!dryRun && report.skillChange !== "unchanged") writeSkill(target.skillFile, text);
        }
      }
    } catch (err) {
      report.error = err instanceof ConfigParseError ? err.message : (err as Error).message;
    }
  }

  return { scope, entry, clients, backups: [...backups].filter((b) => b.includes("cam-backup")), dryRun };
}

export const install = (opts: InstallOptions = {}): InstallReport => apply(opts, false);
export const uninstall = (opts: InstallOptions = {}): InstallReport => apply(opts, true);

export { clientTargets, SERVER_KEY, SKILL_NAME, isClientId } from "./clients.js";
export type { ClientId, ClientTarget, Scope } from "./clients.js";
export { serverEntry, ephemeralRoot, installRoot, resolved, EphemeralInstallError } from "./mcp.js";
export { renderSkill, skillBody } from "./skills.js";
