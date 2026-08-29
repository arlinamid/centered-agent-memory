import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ancestors, basename, normalizePath } from "../paths.js";
import { PROJECT_MARKERS, excludedPrefixes, isRejectedSegment } from "../config.js";

export interface ProjectRef {
  /** Canonical short name, e.g. "notes-app". */
  key: string;
  /** Normalized absolute directory the key was derived from, when known. */
  rootPath: string | null;
  /** How the root was found. */
  via: "marker" | "learned" | "alias" | "workspace-root";
}

export interface ResolverOptions {
  markers?: ReadonlyArray<string>;
  /** Normalized prefixes we never look inside. */
  excluded?: ReadonlyArray<string>;
  /** Roots already known to the hub: normalized rootPath -> key. */
  learned?: ReadonlyMap<string, string>;
  /** alias (lowercase) -> canonical key, user-maintained. */
  aliases?: ReadonlyMap<string, string>;
  /** Injectable for tests; defaults to a real filesystem probe. */
  exists?: (p: string) => boolean;
  /**
   * Directories known to hold projects rather than be one, learned from the
   * corpus by `detectWorkspaceRoots`. Normalized.
   */
  workspaceRoots?: Iterable<string>;
  /** The walk never goes above this directory. Defaults to the user's home. */
  home?: string | null;
}

/**
 * Derives a project from a path by walking up to the nearest directory that
 * carries a project marker (.git, package.json, …). No hardcoded workspace
 * roots, no assumptions about the user profile or platform.
 *
 * Returns null rather than guessing: an unattributed session is honest, a
 * wrongly attributed one is not.
 */
export class ProjectResolver {
  private readonly markers: ReadonlyArray<string>;
  private readonly excluded: ReadonlyArray<string>;
  private readonly learned: Map<string, string>;
  private readonly aliases: ReadonlyMap<string, string>;
  private readonly existsFn: (p: string) => boolean;
  private readonly home: string | null;
  private readonly workspaceRoots: Set<string>;
  private readonly markerCache = new Map<string, boolean>();
  private readonly resultCache = new Map<string, ProjectRef | null>();

  constructor(opts: ResolverOptions = {}) {
    this.markers = opts.markers ?? PROJECT_MARKERS;
    this.excluded = opts.excluded ?? excludedPrefixes();
    this.learned = new Map(opts.learned ?? []);
    this.aliases = opts.aliases ?? new Map();
    this.existsFn = opts.exists ?? ((p) => fs.existsSync(p));
    this.home = opts.home === null ? null : normalizePath(opts.home ?? os.homedir());
    this.workspaceRoots = new Set(
      [...(opts.workspaceRoots ?? [])].map((r) => normalizePath(r)).filter((r): r is string => r !== null),
    );
  }

  /** Add roots learned later (e.g. after a corpus pass) and drop stale answers. */
  addWorkspaceRoots(roots: Iterable<string>): void {
    let added = false;
    for (const r of roots) {
      const n = normalizePath(r);
      if (n && !this.workspaceRoots.has(n)) {
        this.workspaceRoots.add(n);
        added = true;
      }
    }
    if (added) this.resultCache.clear();
  }

  /** Register a root discovered elsewhere (persisted `projects` rows). */
  learn(rootPath: string, key: string): void {
    const norm = normalizePath(rootPath);
    if (norm) this.learned.set(norm, key);
  }

  private isExcluded(p: string): boolean {
    return this.excluded.some((x) => p === x || p.startsWith(x + "/"));
  }

  private hasMarker(dir: string): boolean {
    const cached = this.markerCache.get(dir);
    if (cached !== undefined) return cached;
    let found = false;
    for (const m of this.markers) {
      if (this.existsFn(path.join(dir, m))) {
        found = true;
        break;
      }
    }
    this.markerCache.set(dir, found);
    return found;
  }

  private applyAlias(key: string, rootPath: string | null, via: ProjectRef["via"]): ProjectRef {
    const alias = this.aliases.get(key.toLowerCase());
    return alias ? { key: alias, rootPath, via: "alias" } : { key, rootPath, via };
  }

  resolve(raw: string | null | undefined): ProjectRef | null {
    const norm = normalizePath(raw);
    if (!norm) return null;
    const cached = this.resultCache.get(norm);
    if (cached !== undefined) return cached;
    const out = this.compute(norm);
    this.resultCache.set(norm, out);
    return out;
  }

  /** Convenience for callers that only need the name. */
  key(raw: string | null | undefined): string | null {
    return this.resolve(raw)?.key ?? null;
  }

  private compute(norm: string): ProjectRef | null {
    if (this.isExcluded(norm)) return null;

    // A leaf that looks like a file cannot itself be a project root; skipping
    // it saves one marker probe per turn across tens of thousands of turns.
    const leaf = basename(norm);
    const looksLikeFile = leaf.includes(".") && !leaf.startsWith(".");
    const chain = ancestors(norm);
    const candidates = looksLikeFile ? chain : [norm, ...chain];

    let below: string | null = null; // the candidate one level under `dir`
    for (const dir of candidates) {
      if (this.isExcluded(dir)) break;
      if (this.home && dir === this.home) break; // home is never a project

      // A root we already know beats a filesystem probe: it survives the
      // project being moved or deleted.
      const learnedKey = this.learned.get(dir);
      if (learnedKey) return this.decide(dir, this.applyAlias(learnedKey, dir, "learned"));

      // Reuse a decided ancestor: everything under a resolved directory
      // shares its answer.
      const hit = this.resultCache.get(dir);
      if (hit !== undefined) return hit;

      const name = basename(dir);

      // A workspace root ends the walk: the project is the child we came from,
      // even when that child carries no marker of its own. Reaching a root with
      // nothing below it means the session worked in the root itself — that is
      // genuinely ambiguous, so we stay unattributed.
      if (this.workspaceRoots.has(dir)) {
        if (below) {
          const childName = basename(below);
          if (childName && !isRejectedSegment(childName)) {
            return this.decide(below, this.applyAlias(childName, below, "workspace-root"));
          }
          // A generated run directory under a root (codex-runs/<uuid>) names
          // nothing; keep walking up to find the project that owns the run.
          below = dir;
          continue;
        }
        break;
      }

      // Nearest ancestor carrying a marker, skipping generic names (src/,
      // backend/) so a monorepo leaf does not win over the project itself.
      if (name && !isRejectedSegment(name) && this.hasMarker(dir)) {
        return this.decide(dir, this.applyAlias(name, dir, "marker"));
      }
      below = dir;
    }

    return null;
  }

  /** Cache an answer against the directory that produced it, not just the leaf. */
  private decide(dir: string, ref: ProjectRef): ProjectRef {
    this.resultCache.set(dir, ref);
    return ref;
  }
}
