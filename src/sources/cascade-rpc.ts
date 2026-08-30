import { callRpc, type DaemonSession } from "./language-server.js";
import { parseTrajectory, type Trajectory } from "./antigravity-trajectory.js";

/**
 * One conversation, from whichever language server actually holds it.
 *
 * Antigravity and Devin both answer `GetCascadeTrajectory`, and a daemon only
 * knows its own surface. The first process we see can therefore be the wrong
 * one — the IDE answers `trajectory not found` for a conversation the other
 * app created. Trying each, and taking the first parseable body, is the
 * whole algorithm.
 */
export type TrajectoryFetch =
  | { status: "no-daemon" }
  | { status: "failed"; detail: string }
  | { status: "ok"; parsed: Trajectory };

export async function fetchTrajectory(
  session: DaemonSession,
  cascadeId: string,
  opts: { fetchImpl?: typeof globalThis.fetch } = {},
): Promise<TrajectoryFetch> {
  const daemons = await session.acquireAll();
  if (daemons.length === 0) return { status: "no-daemon" };

  let last = "no language server answered";
  for (const daemon of daemons) {
    const res = await callRpc(daemon, "GetCascadeTrajectory", { cascadeId }, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: 60_000,
    });
    if (!res.ok) {
      last = res.detail || `HTTP ${res.status}`;
      continue;
    }
    const parsed = parseTrajectory(res.body);
    if (!parsed) {
      last = "the daemon answered something that is not a trajectory";
      continue;
    }
    return { status: "ok", parsed };
  }
  return { status: "failed", detail: last };
}
