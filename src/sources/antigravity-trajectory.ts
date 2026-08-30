import type { TurnInput } from "../index/indexer.js";

/**
 * Turning a decrypted Antigravity trajectory into turns.
 *
 * A trajectory is a step log, not a transcript: on the reference conversation,
 * 523 steps carry 20 turns. The census of what those steps are:
 *
 *   168  PLANNER_RESPONSE      the model thinking, and calling tools
 *   160  EPHEMERAL_MESSAGE     system reminders injected between turns
 *    46  TASK_BOUNDARY         planning bookkeeping
 *    39  CODE_ACTION           edits
 *    26  VIEW_FILE  18 RUN_COMMAND  14 COMMAND_STATUS  4 GREP_SEARCH  1 LIST_DIRECTORY
 *    11  USER_INPUT            what the user typed
 *     9  NOTIFY_USER           what the agent said back
 *     8  ERROR_MESSAGE         provider failures
 *     7  BROWSER_SUBAGENT   4 CONVERSATION_HISTORY  4 KNOWLEDGE_ARTIFACTS  4 CHECKPOINT
 *
 * Three of those carry speech, and the awkward one is `PLANNER_RESPONSE`.
 * Most of them are the model thinking: `thinking`, `toolCalls[]` and a base64
 * `thinkingSignature`, which is the same shape this hub already excludes from
 * Claude Code transcripts. But some also carry `response` — the sentence the
 * user actually reads — and a sample of the three largest planner steps in one
 * conversation had none, which is exactly how this field gets missed. So the
 * step is neither taken whole nor skipped whole: only `response` is read.
 *
 * `NOTIFY_USER.notifyUser.notificationContent` is the other half of what the
 * agent says, used when it stops and waits for an answer.
 *
 * Whitelisting fields rather than excluding step types keeps both a new step
 * type and a new field from quietly entering the index.
 */

export const USER_STEP = "CORTEX_STEP_TYPE_USER_INPUT";
export const NOTIFY_STEP = "CORTEX_STEP_TYPE_NOTIFY_USER";
export const PLANNER_STEP = "CORTEX_STEP_TYPE_PLANNER_RESPONSE";

interface Step {
  type?: unknown;
  metadata?: { createdAt?: unknown } | undefined;
  userInput?: { items?: unknown; userResponse?: unknown } | undefined;
  notifyUser?: { notificationContent?: unknown } | undefined;
  plannerResponse?: { response?: unknown } | undefined;
}

export interface Trajectory {
  cascadeId: string | null;
  trajectoryId: string | null;
  /** `workspaceFolderAbsoluteUri` of each workspace, as file URIs. */
  workspaces: string[];
  createdMs: number | null;
  turns: TurnInput[];
  /** Steps seen, so a caller can report how much was left out and why. */
  totalSteps: number;
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);

function parseTs(raw: unknown): number | null {
  const s = asString(raw);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The text a user-input step holds.
 *
 * `userResponse` repeats `items[].text` on every step measured, but items is
 * the structured field and can hold several blocks, so it wins and the flat
 * one is the fallback.
 */
function userText(step: Step): string | null {
  const items = step.userInput?.items;
  if (Array.isArray(items)) {
    const parts: string[] = [];
    for (const item of items) {
      if (item && typeof item === "object") {
        const t = asString((item as { text?: unknown }).text);
        if (t) parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return asString(step.userInput?.userResponse);
}

export function parseTrajectory(payload: unknown): Trajectory | null {
  const root = payload as { trajectory?: unknown } | null;
  const t = root?.trajectory as
    | {
        cascadeId?: unknown;
        trajectoryId?: unknown;
        steps?: unknown;
        metadata?: { workspaces?: unknown; createdAt?: unknown };
      }
    | undefined;
  if (!t || typeof t !== "object") return null;

  const steps = Array.isArray(t.steps) ? (t.steps as Step[]) : [];
  const turns: TurnInput[] = [];
  let seq = 0;

  for (const step of steps) {
    let role: "user" | "assistant" | null = null;
    let text: string | null = null;

    if (step.type === USER_STEP) {
      role = "user";
      text = userText(step);
    } else if (step.type === NOTIFY_STEP) {
      role = "assistant";
      text = asString(step.notifyUser?.notificationContent);
    } else if (step.type === PLANNER_STEP) {
      // Only `response`. The rest of this step is reasoning and tool calls.
      role = "assistant";
      text = asString(step.plannerResponse?.response);
    }
    if (!role || !text) continue;

    turns.push({
      seq: seq++,
      role,
      tsMs: parseTs(step.metadata?.createdAt),
      text,
      // The plaintext exists nowhere on disk — the store holds it encrypted and
      // only the daemon can undo that — so this is the one case where a turn
      // carries its own text, the way a volatile source does.
      locator: { kind: "inline" },
    });
  }

  const workspaces: string[] = [];
  const raw = t.metadata?.workspaces;
  if (Array.isArray(raw)) {
    for (const w of raw) {
      if (w && typeof w === "object") {
        const uri = asString((w as { workspaceFolderAbsoluteUri?: unknown }).workspaceFolderAbsoluteUri);
        if (uri) workspaces.push(uri);
      }
    }
  }

  return {
    cascadeId: asString(t.cascadeId),
    trajectoryId: asString(t.trajectoryId),
    workspaces,
    createdMs: parseTs(t.metadata?.createdAt),
    turns,
    totalSteps: steps.length,
  };
}
