import { normalizePath } from "../paths.js";
import { isRejectedSegment } from "../config.js";

export interface DetectedRoot {
  root: string;
  /** Distinct child directories observed as working directories. */
  children: number;
}

/**
 * Learn workspace roots from the corpus rather than from configuration.
 *
 * A directory whose children are the working directories of several different
 * sessions is a place where projects are kept, not a project. This works on any
 * machine and any platform because it is derived from observed data — and it is
 * the only signal that separates a junk-drawer git repo — a folder that is a
 * repository itself and holds twenty unrelated projects — from one large
 * project whose subdirectories happen to carry markers.
 */
export function detectWorkspaceRoots(
  cwds: Iterable<string>,
  minChildren = 3,
): DetectedRoot[] {
  const childrenByParent = new Map<string, Set<string>>();

  for (const raw of cwds) {
    const norm = normalizePath(raw);
    if (!norm) continue;
    const idx = norm.lastIndexOf("/");
    if (idx <= 0) continue;
    const parent = norm.slice(0, idx);
    const child = norm.slice(idx + 1);
    if (!child || isRejectedSegment(child)) continue;
    if (/^[a-zA-Z]:$/.test(parent)) continue; // a drive root is not a workspace
    let set = childrenByParent.get(parent);
    if (!set) {
      set = new Set();
      childrenByParent.set(parent, set);
    }
    set.add(child);
  }

  const out: DetectedRoot[] = [];
  for (const [root, children] of childrenByParent) {
    if (children.size >= minChildren) out.push({ root, children: children.size });
  }
  out.sort((a, b) => b.children - a.children || a.root.localeCompare(b.root));
  return out;
}
