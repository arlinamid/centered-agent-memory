import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientTargets, SERVER_KEY, SKILL_NAME } from "../src/install/clients.js";
import { dreamConfigFor, DreamModelRequiredError, describeBin, type DreamCandidate } from "../src/install/dream.js";
import { install, uninstall } from "../src/install/index.js";
import { locate } from "../src/install/locate.js";
import {
  EphemeralInstallError,
  ephemeralRoot,
  removeToml,
  serverEntry,
  upsertJson,
  upsertToml,
} from "../src/install/mcp.js";
import { schedulePlan, scheduleState, type SchedulePlan } from "../src/install/schedule.js";
import { renderSkill } from "../src/install/skills.js";

/**
 * The installer writes into other people's configuration files and registers
 * jobs with the operating system, so almost everything here runs against a
 * fixture home directory. The parts that cannot — the scheduler recipes for
 * three platforms this suite will never run on — are pure functions returning
 * the files and commands, and those are checked as text.
 */

const ENTRY = { command: "node", args: ["/opt/cam/dist/mcp/server.js"] };

let home: string;
let cwd: string;

/**
 * Resolved, because the installer writes resolved paths on purpose: a
 * scheduled task pointing at a symlink breaks the day the link moves. The
 * temp root is a symlink on macOS (`/var` → `/private/var`) and a short 8.3
 * name on some Windows setups, so a fixture path that skipped this would
 * differ from the installer's output for reasons that have nothing to do with
 * what the test is checking.
 */
const tmpdir = (prefix: string): string =>
  fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

beforeEach(() => {
  home = tmpdir("cam-install-");
  cwd = tmpdir("cam-project-");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const mk = (...parts: string[]): string => {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const read = (file: string): string => fs.readFileSync(file, "utf8");

describe("client detection", () => {
  it("reports a tool as absent rather than inventing a home for it", () => {
    const targets = clientTargets("user", home, cwd);
    expect(targets.every((t) => !t.installed)).toBe(true);
  });

  it("finds a tool by its own directory", () => {
    mk(".codex");
    const codex = clientTargets("user", home, cwd).find((t) => t.id === "codex");
    expect(codex?.installed).toBe(true);
    expect(codex?.mcpFormat).toBe("toml");
  });

  it("offers project scope only where the client reads a per-repository file", () => {
    const ids = clientTargets("project", home, cwd).map((t) => t.id);
    expect(ids).toEqual(["claude_code", "cursor"]);
  });
});

describe("mcp config", () => {
  it("adds the server without disturbing what is already there", () => {
    const before = JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }, null, 2);
    const edit = upsertJson(before, "c.json", SERVER_KEY, ENTRY);
    const after = JSON.parse(edit.text) as { mcpServers: Record<string, unknown>; theme: string };

    expect(edit.change).toBe("added");
    expect(after.theme).toBe("dark");
    expect(Object.keys(after.mcpServers)).toEqual(["other", SERVER_KEY]);
  });

  it("says nothing changed when the entry is already right", () => {
    const once = upsertJson("{}", "c.json", SERVER_KEY, ENTRY);
    expect(upsertJson(once.text, "c.json", SERVER_KEY, ENTRY).change).toBe("unchanged");
  });

  it("keeps the file's own indentation", () => {
    const four = JSON.stringify({ mcpServers: {} }, null, 4);
    expect(upsertJson(four, "c.json", SERVER_KEY, ENTRY).text).toContain('\n    "mcpServers"');
  });

  it("refuses to guess at a config it cannot parse", () => {
    expect(() => upsertJson("{ this is not json", "c.json", SERVER_KEY, ENTRY)).toThrow(/c\.json/);
  });

  it("appends a TOML table and leaves the comments alone", () => {
    const before = '# my notes\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const edit = upsertToml(before, `mcp_servers.${SERVER_KEY}`, ENTRY);

    expect(edit.change).toBe("added");
    expect(edit.text).toContain("# my notes");
    expect(edit.text).toContain("[mcp_servers.other]");
    expect(edit.text).toContain(`[mcp_servers.${SERVER_KEY}]`);
  });

  it("replaces only its own TOML table on a second run", () => {
    const once = upsertToml("", `mcp_servers.${SERVER_KEY}`, ENTRY);
    const twice = upsertToml(once.text, `mcp_servers.${SERVER_KEY}`, { command: "other", args: [] });

    expect(twice.text.match(/\[mcp_servers\.cam\]/g)).toHaveLength(1);
    expect(twice.text).toContain('command = "other"');
  });

  it("removes its table and reports when there was none", () => {
    const once = upsertToml("", `mcp_servers.${SERVER_KEY}`, ENTRY);
    expect(removeToml(once.text, `mcp_servers.${SERVER_KEY}`).change).toBe("removed");
    expect(removeToml("", `mcp_servers.${SERVER_KEY}`).change).toBe("absent");
  });

  it("names an absolute server path, so a client without a PATH can start it", () => {
    const entry = serverEntry({ PATH: "" });
    expect(path.isAbsolute(entry.args?.[0] ?? entry.command)).toBe(true);
  });

  it("stays absolute even where a bare command would look like it works", () => {
    // A desktop app launched from the dock inherits no login PATH, so what the
    // installing shell can resolve says nothing about what the client can.
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, process.platform === "win32" ? "cam-mcp.cmd" : "cam-mcp"), "");

    const entry = serverEntry({ PATH: bin });
    expect(entry.command).not.toBe("cam-mcp");
    expect(path.isAbsolute(entry.args?.[0] ?? entry.command)).toBe(true);
  });

  it("refuses to write anything from a throwaway npx directory", () => {
    // Both halves of the npx trap: the unpacked copy is garbage-collected, and
    // its bin directory is on the PATH only while the install itself runs.
    expect(ephemeralRoot("/home/u/.npm/_npx/2b1c/node_modules/centered-agent-memory")).toBe(true);
    expect(ephemeralRoot("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\9f\\node_modules\\cam")).toBe(true);
    expect(ephemeralRoot("/usr/lib/node_modules/centered-agent-memory")).toBe(false);
    expect(ephemeralRoot("C:\\work\\centered-agent-memory")).toBe(false);
    // A project that happens to be named for the cache must not be mistaken for it.
    expect(ephemeralRoot("/home/u/src/_npx-notes")).toBe(false);
  });

  it("says what to do instead, rather than failing at first use", () => {
    const err = new EphemeralInstallError("/home/u/.npm/_npx/2b1c");
    expect(err.message).toContain("npm i -g");
    expect(err.message).toContain("/home/u/.npm/_npx/2b1c");
  });
});

describe("skills", () => {
  it("renders frontmatter and the client's own surface", () => {
    const [claudeCode] = clientTargets("user", home, cwd);
    const text = renderSkill(claudeCode!, "Törzs.\n\n{{SURFACE}}\n");

    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain(`name: ${SKILL_NAME}`);
    expect(text).toContain("Törzs.");
    expect(text).not.toContain("{{SURFACE}}");
  });

  it("ships a discoverable skill so `npx skills add` can find it", () => {
    // The skills CLI looks for `<name>/SKILL.md` with `name` and `description`
    // in the frontmatter. The installer template is `assets/skill-body.md`
    // (not named SKILL.md — on a case-insensitive disk the CLI would treat
    // that as a broken skill and skip it with a warning).
    const published = path.join(process.cwd(), "skills", SKILL_NAME, "SKILL.md");
    expect(fs.existsSync(published)).toBe(true);
    const text = fs.readFileSync(published, "utf8");
    expect(text).toMatch(/^---\nname: agent-memory\n/);
    expect(text).toContain("description:");
    expect(text).not.toContain("{{SURFACE}}");
    const [claudeCode] = clientTargets("user", home, cwd);
    expect(text).toBe(renderSkill(claudeCode!));
  });

  it("tells a terminal-less client not to promise a sync it cannot run", () => {
    const targets = clientTargets("user", home, cwd);
    const desktop = renderSkill(targets.find((t) => t.id === "claude_desktop")!, "{{SURFACE}}");
    const code = renderSkill(targets.find((t) => t.id === "claude_code")!, "{{SURFACE}}");

    expect(desktop).toContain("ask the user");
    expect(code).toContain("cam sync");
  });
});

describe("gemini, antigravity and devin targets", () => {
  it("merges into Gemini's settings document instead of replacing it", () => {
    mk(".gemini");
    const settings = path.join(home, ".gemini", "settings.json");
    // `mcpServers` is one key among many here, and the others are the user's
    // theme, auth choice and retention policy. Losing them would be silent.
    fs.writeFileSync(
      settings,
      JSON.stringify({ ui: { theme: "GitHub" }, mcpServers: { "example-mcp": { command: "example-mcp" } } }, null, 2),
      "utf8",
    );

    install({ scope: "user", home, cwd, entry: ENTRY });

    const doc = JSON.parse(read(settings)) as {
      ui: { theme: string };
      mcpServers: Record<string, unknown>;
    };
    expect(doc.ui.theme).toBe("GitHub");
    expect(Object.keys(doc.mcpServers).sort()).toEqual([SERVER_KEY, "example-mcp"]);
    expect(read(path.join(home, ".gemini", "skills", SKILL_NAME, "SKILL.md"))).toContain(`name: ${SKILL_NAME}`);
  });

  it("writes Antigravity's canonical config, not the surface that links to it", () => {
    mk(".gemini", "antigravity");
    install({ scope: "user", home, cwd, entry: ENTRY });

    // All three surfaces read `~/.gemini/config/mcp_config.json`; the copy at
    // `antigravity/mcp_config.json` is a symlink to it.
    const canonical = path.join(home, ".gemini", "config", "mcp_config.json");
    expect(JSON.parse(read(canonical)).mcpServers[SERVER_KEY]).toBeDefined();
    expect(fs.existsSync(path.join(home, ".gemini", "antigravity", "mcp_config.json"))).toBe(false);
    expect(
      read(path.join(home, ".gemini", "antigravity", "skills", SKILL_NAME, "SKILL.md")),
    ).toContain(`name: ${SKILL_NAME}`);
  });

  it("gives Devin the server but not a second copy of the skill", () => {
    const devinHome = mk("AppData", "Roaming", "devin");
    mk(".claude");
    install({ scope: "user", home, cwd, entry: ENTRY });

    expect(JSON.parse(read(path.join(devinHome, "mcp_config.json"))).mcpServers[SERVER_KEY]).toBeDefined();
    // Devin scans `~/.claude/skills/`, which the Claude Code target already
    // filled: a Devin-owned copy would list the same skill twice.
    const targets = clientTargets("user", home, cwd);
    expect(targets.find((t) => t.id === "devin")!.skillFile).toBeNull();
    expect(read(path.join(home, ".claude", "skills", SKILL_NAME, "SKILL.md"))).toContain(`name: ${SKILL_NAME}`);
  });

  it("leaves all three alone when none of them is installed", () => {
    install({ scope: "user", home, cwd, entry: ENTRY });
    expect(fs.existsSync(path.join(home, ".gemini"))).toBe(false);
    expect(fs.existsSync(path.join(home, "AppData", "Roaming", "devin"))).toBe(false);
  });

  it("removes itself from all three again", () => {
    mk(".gemini", "antigravity");
    mk("AppData", "Roaming", "devin");
    install({ scope: "user", home, cwd, entry: ENTRY });
    uninstall({ scope: "user", home, cwd });

    for (const file of [
      path.join(home, ".gemini", "settings.json"),
      path.join(home, ".gemini", "config", "mcp_config.json"),
      path.join(home, "AppData", "Roaming", "devin", "mcp_config.json"),
    ]) {
      expect(JSON.parse(read(file)).mcpServers[SERVER_KEY]).toBeUndefined();
    }
    expect(fs.existsSync(path.join(home, ".gemini", "skills", SKILL_NAME, "SKILL.md"))).toBe(false);
  });

  it("names every tool it indexes in the skill it hands out", () => {
    const [claudeCode] = clientTargets("user", home, cwd);
    const text = renderSkill(claudeCode!);
    for (const tool of ["Claude Code", "Codex", "Cursor", "Gemini CLI", "Antigravity", "Devin"]) {
      expect(text).toContain(tool);
    }
  });
});

describe("install", () => {
  it("touches nothing on a dry run", () => {
    mk(".codex");
    const report = install({ scope: "user", home, cwd, entry: ENTRY, dryRun: true });

    expect(report.clients.find((c) => c.id === "codex")?.mcpChange).toBe("added");
    expect(fs.existsSync(path.join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("writes the server and the skill for a tool that is installed", () => {
    mk(".codex");
    install({ scope: "user", home, cwd, entry: ENTRY });

    expect(read(path.join(home, ".codex", "config.toml"))).toContain("[mcp_servers.cam]");
    expect(read(path.join(home, ".codex", "skills", SKILL_NAME, "SKILL.md"))).toContain(`name: ${SKILL_NAME}`);
  });

  it("leaves an uninstalled tool alone entirely", () => {
    install({ scope: "user", home, cwd, entry: ENTRY });
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".cursor"))).toBe(false);
  });

  it("is idempotent: the second run changes nothing", () => {
    mk(".cursor");
    install({ scope: "user", home, cwd, entry: ENTRY });
    const again = install({ scope: "user", home, cwd, entry: ENTRY });
    const cursor = again.clients.find((c) => c.id === "cursor");

    expect(cursor?.mcpChange).toBe("unchanged");
    expect(cursor?.skillChange).toBe("unchanged");
  });

  it("backs a config up before the first change to it", () => {
    mk(".cursor");
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), '{"mcpServers":{"keep":{"command":"x"}}}');
    install({ scope: "user", home, cwd, entry: ENTRY });

    const saved = fs.readdirSync(path.join(home, ".cursor")).filter((f) => f.includes("cam-backup"));
    expect(saved).toHaveLength(1);
    expect(read(path.join(home, ".cursor", "mcp.json"))).toContain("keep");
  });

  it("reports a broken config instead of overwriting it", () => {
    mk(".cursor");
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), "{ not json");
    const report = install({ scope: "user", home, cwd, entry: ENTRY });

    expect(report.clients.find((c) => c.id === "cursor")?.error).toMatch(/mcp\.json/);
    expect(read(path.join(home, ".cursor", "mcp.json"))).toBe("{ not json");
  });

  it("puts a project install in the repository, not the home directory", () => {
    mk(".claude");
    install({ scope: "project", home, cwd, entry: ENTRY });

    expect(fs.existsSync(path.join(cwd, ".mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("can be limited to one client", () => {
    mk(".codex");
    mk(".cursor");
    install({ scope: "user", home, cwd, entry: ENTRY, only: ["codex"] });

    expect(fs.existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".cursor", "mcp.json"))).toBe(false);
  });
});

describe("uninstall", () => {
  it("takes back the entry and the skill and leaves the rest", () => {
    mk(".cursor");
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), '{"mcpServers":{"keep":{"command":"x"}}}');
    install({ scope: "user", home, cwd, entry: ENTRY });
    uninstall({ scope: "user", home, cwd, entry: ENTRY });

    const after = JSON.parse(read(path.join(home, ".cursor", "mcp.json"))) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(after.mcpServers)).toEqual(["keep"]);
    expect(fs.existsSync(path.join(home, ".cursor", "skills", SKILL_NAME))).toBe(false);
  });

  it("is quiet about a client it was never installed into", () => {
    mk(".codex");
    const report = uninstall({ scope: "user", home, cwd, entry: ENTRY });
    expect(report.clients.find((c) => c.id === "codex")?.mcpChange).toBe("absent");
  });
});

/**
 * Three of these four recipes run on platforms this suite will never see, so
 * the plan is checked as text. The point is that each one names an absolute
 * node and an absolute script: a scheduler starts with neither a shell nor a
 * PATH, and a bare `cam` there resolves to nothing.
 */
describe("schedule", () => {
  const opts = { node: "/usr/bin/node", cli: "/opt/cam/dist/cli.js", home: "/home/me" };

  it("registers an hourly sync and a nightly maintenance pass everywhere", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const plan = schedulePlan({ ...opts, platform });
      const text = [...plan.files.map((f) => f.contents), ...plan.install.map((s) => s.argv.join(" "))].join("\n");

      // Named as tokens rather than a command line: launchd takes its argv one
      // XML element at a time.
      for (const action of ["sync", "consolidate", "prune", "--quiet", opts.node]) {
        expect(text, `${platform} kihagyta: ${action}`).toContain(action);
      }
    }
  });

  it("builds paths for the target platform, not the one it runs on", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const plan = schedulePlan({ ...opts, platform });
      expect(plan.files.every((f) => !f.path.includes("\\"))).toBe(true);
    }
  });

  it("asks Windows to catch up a run the machine slept through", () => {
    const plan = schedulePlan({ ...opts, platform: "win32" });
    expect(plan.install[0]?.argv.join(" ")).toContain("-StartWhenAvailable");
    expect(plan.install[0]?.argv.join(" ")).toContain("IgnoreNew");
  });

  it("does the same on Linux, and says what a logged-out machine needs", () => {
    const plan = schedulePlan({ ...opts, platform: "linux" });
    expect(plan.files.map((f) => f.contents).join()).toContain("Persistent=true");
    expect(plan.notes.join()).toContain("linger");
  });

  it("writes the launchd agents under the given home", () => {
    const plan = schedulePlan({ ...opts, platform: "darwin" });
    expect(plan.files.every((f) => f.path.startsWith("/home/me/Library/LaunchAgents"))).toBe(true);
  });

  it("can undo every job it registers", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const plan = schedulePlan({ ...opts, platform });
      const undo = plan.remove.map((s) => s.argv.join(" ")).join("\n");
      for (const job of plan.jobs) expect(undo).toContain(job);
    }
  });

  it("names the copy of the package that owns the jobs", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(schedulePlan({ ...opts, platform }).cli).toBe(opts.cli);
    }
  });

  // The unit files carry the whole command, so the POSIX states can be checked
  // against a real directory. Windows asks the scheduler, which this suite
  // cannot stand in for.
  describe("recognising an existing registration", () => {
    const posix = (cli: string): SchedulePlan =>
      schedulePlan({ node: "/usr/bin/node", cli, home, platform: "linux" });

    const write = (plan: SchedulePlan): void => {
      for (const f of plan.files) {
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        fs.writeFileSync(f.path, f.contents);
      }
    };

    it("reports nothing registered when nothing is", () => {
      expect(scheduleState(posix("/opt/cam/dist/cli.js")).state).toBe("absent");
    });

    it("recognises its own jobs, so a second install is a no-op", () => {
      const plan = posix("/opt/cam/dist/cli.js");
      write(plan);
      expect(scheduleState(plan).state).toBe("same");
    });

    it("refuses to mistake another copy's jobs for its own", () => {
      // The names are fixed, so the danger is not two sync jobs but one that
      // quietly belongs to a checkout somebody has since deleted.
      write(posix("/opt/cam/dist/cli.js"));
      const other = scheduleState(posix("/home/me/src/cam/dist/cli.js"));

      expect(other.state).toBe("different");
      expect(other.current).not.toHaveLength(0);
    });
  });
});

describe("finding the program behind the launcher", () => {
  it("prefers a real executable over a batch shim earlier on the PATH", () => {
    const shimDir = mk("shims");
    const binDir = mk("bin");
    fs.writeFileSync(path.join(shimDir, "tool.cmd"), "@echo off\n");
    fs.writeFileSync(path.join(binDir, "tool.exe"), "MZ");

    const found = locate(["tool"], [], { PATH: [shimDir, binDir].join(path.delimiter) });
    if (process.platform !== "win32") return;
    expect(found?.bin).toBe(path.join(binDir, "tool.exe"));
    expect(found?.kind).toBe("native");
  });

  it("reads an npm shim through to the script it would run", () => {
    const dir = mk("npm");
    fs.mkdirSync(path.join(dir, "node_modules", "pkg", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "bin", "t.js"), "// hi");
    fs.writeFileSync(path.join(dir, "t.cmd"), '"%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\t.js" %*\n');

    const found = locate(["t"], [], { PATH: dir });
    if (process.platform !== "win32") return;
    expect(found?.kind).toBe("script");
    expect(found?.prefix[0]).toBe(path.join(dir, "node_modules", "pkg", "bin", "t.js"));
  });

  it("looks in a tool's own install directory, which no PATH may mention", () => {
    const hidden = mk("hidden");
    const name = process.platform === "win32" ? "tool.exe" : "tool";
    fs.writeFileSync(path.join(hidden, name), "MZ");

    expect(locate(["tool"], [hidden], { PATH: "" })?.bin).toBe(path.join(hidden, name));
  });

  it("finds nothing when there is nothing", () => {
    expect(locate(["definitely-not-installed"], [], { PATH: home })).toBeNull();
  });
});

describe("dream setup", () => {
  const candidate = (over: Partial<DreamCandidate> = {}): DreamCandidate => ({
    id: "codex",
    name: "Codex CLI",
    bin: "/opt/codex",
    prefix: [],
    kind: "native",
    via: "/opt/codex",
    args: [],
    modelRequired: false,
    models: [],
    ...over,
  });

  it("keeps the dream from being indexed as a conversation of its own", () => {
    const cmd = dreamConfigFor(candidate(), null).command ?? [];
    expect(cmd).toContain("--ephemeral");
  });

  it("gives the model no way to read the disk", () => {
    const codex = (dreamConfigFor(candidate(), null).command ?? []).join(" ");
    const claude = (dreamConfigFor(candidate({ id: "claude", name: "Claude Code" }), null).command ?? []).join(" ");

    expect(codex).toContain("-s read-only");
    expect(claude).toContain("--tools");
  });

  it("leaves the model unnamed unless one was chosen", () => {
    const without = dreamConfigFor(candidate(), null);
    const with_ = dreamConfigFor(candidate(), "gpt-5.6-sol");

    expect(without.command).not.toContain("-m");
    expect(without.model).toBe("codex");
    expect(with_.command?.join(" ")).toContain("-m gpt-5.6-sol");
    expect(with_.model).toBe("gpt-5.6-sol");
  });

  it("puts the model flag where the tool expects it, after the subcommand", () => {
    const cmd = dreamConfigFor(candidate(), "m1").command ?? [];
    expect(cmd.indexOf("exec")).toBeLessThan(cmd.indexOf("-m"));
  });

  it("runs the program itself, not the launcher it was found through", () => {
    const script = candidate({ id: "gemini", kind: "script", bin: "/usr/bin/node", prefix: ["/lib/gemini.js"] });
    expect(dreamConfigFor(script, null).command?.slice(0, 2)).toEqual(["/usr/bin/node", "/lib/gemini.js"]);
    expect(describeBin(script)).toBe("node /lib/gemini.js");
  });

  it("asks for a model when the tool cannot start without one", () => {
    expect(() => dreamConfigFor(candidate({ id: "ollama", name: "Ollama" }), null)).toThrow(DreamModelRequiredError);
    expect(dreamConfigFor(candidate({ id: "ollama" }), "llama3").command).toContain("llama3");
  });
});
