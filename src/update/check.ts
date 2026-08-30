/**
 * Looking for a newer release.
 *
 * This is the second thing in the package that can touch the network, and like
 * the first (`cam memory dream`) it is off until the user turns it on, it
 * announces what it is about to contact before contacting it, and it sends
 * nothing about this machine: one unauthenticated GET, no identifier, no
 * telemetry, no conversation content.
 *
 * The package is `private: true` and is not on any registry, so the release
 * tarball attached to a GitHub release is the distribution.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface UpdateConfig {
  /** Off unless the user writes `true`. Nothing here happens by default. */
  enabled?: boolean;
  /** `owner/name`. Overridable so a fork can point at its own releases. */
  repo?: string;
}

export const DEFAULT_REPO = "arlinamid/centered-agent-memory";

/**
 * The version of the copy that is running.
 *
 * Read from `package.json` rather than imported from the MCP server, which
 * also holds it: that module pulls in the MCP SDK, and every `cam` invocation
 * would pay for it. The release gate keeps the two in step.
 */
export function installedVersion(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Everything the check would contact, so it can be shown before it is used. */
export function latestReleaseUrl(repo: string = DEFAULT_REPO): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export class UpdateDisabledError extends Error {
  constructor(configFile: string) {
    super(
      "checking for updates is off. Nothing in this tool contacts the network until you say so.\n" +
        `  To turn it on, put this in ${configFile}:\n` +
        '    { "update": { "enabled": true } }',
    );
    this.name = "UpdateDisabledError";
  }
}

export interface Release {
  tag: string;
  version: string;
  htmlUrl: string;
  /** The packed tarball, when the release has one attached. */
  assetName: string | null;
  assetUrl: string | null;
  assetBytes: number | null;
}

/**
 * Compare two `x.y.z` versions. Returns >0 when `a` is newer.
 *
 * Deliberately not a semver library: the only versions compared here are this
 * package's own, and a dependency that runs before an update check is a
 * dependency that can block one.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface GhRelease {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

/**
 * Ask GitHub for the latest release. `fetchImpl` is a parameter so the test
 * suite can exercise every branch without a network.
 */
export async function fetchLatestRelease(opts: {
  repo?: string;
  fetchImpl?: FetchLike;
}): Promise<Release> {
  const repo = opts.repo ?? DEFAULT_REPO;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!doFetch) throw new Error("no fetch available in this runtime");

  const res = await doFetch(latestReleaseUrl(repo), {
    headers: { accept: "application/vnd.github+json", "user-agent": "centered-agent-memory" },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `no published release for ${repo} (HTTP 404)`
        : `GitHub answered HTTP ${res.status}`,
    );
  }

  const body = (await res.json()) as GhRelease;
  const tag = typeof body.tag_name === "string" ? body.tag_name : null;
  if (!tag) throw new Error("the release carries no tag");

  const assets = Array.isArray(body.assets) ? body.assets : [];
  const tarball = assets.find(
    (a): a is { name: string; browser_download_url: string; size?: number } =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as { name?: unknown }).name === "string" &&
      (a as { name: string }).name.endsWith(".tgz") &&
      typeof (a as { browser_download_url?: unknown }).browser_download_url === "string",
  );

  return {
    tag,
    version: tag.replace(/^v/, ""),
    htmlUrl: typeof body.html_url === "string" ? body.html_url : `https://github.com/${repo}/releases`,
    assetName: tarball?.name ?? null,
    assetUrl: tarball?.browser_download_url ?? null,
    assetBytes: typeof tarball?.size === "number" ? tarball.size : null,
  };
}

export type UpdateVerdict = "current" | "behind" | "ahead";

export function verdict(installed: string, latest: string): UpdateVerdict {
  const d = compareVersions(latest, installed);
  return d > 0 ? "behind" : d < 0 ? "ahead" : "current";
}
