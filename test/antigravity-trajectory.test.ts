import { describe, expect, it } from "vitest";
import { parseTrajectory } from "../src/sources/antigravity-trajectory.js";

/**
 * Built from a real trajectory: 523 steps of which 20 were speech. Every step
 * type below was present in that measurement, and each non-speech one is here
 * because leaving it in would have looked reasonable.
 */
const step = (type: string, extra: Record<string, unknown> = {}, createdAt = "2026-02-25T14:02:04.817881200Z") => ({
  type,
  status: "CORTEX_STEP_STATUS_DONE",
  metadata: { createdAt, source: "CORTEX_STEP_SOURCE_MODEL" },
  ...extra,
});

const trajectory = () => ({
  trajectory: {
    trajectoryId: "bbbbbbbb-1111-2222-3333-555555555555",
    cascadeId: "aaaaaaaa-1111-2222-3333-444444444444",
    trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
    metadata: {
      createdAt: "2026-02-25T14:00:45.438063200Z",
      projectId: "outside-of-project",
      workspaces: [
        {
          workspaceFolderAbsoluteUri: "file:///d:/work/demo-plugin",
          gitRootAbsoluteUri: "file:///d:/work/demo-plugin",
          branchName: "main",
        },
      ],
    },
    steps: [
      step(
        "CORTEX_STEP_TYPE_USER_INPUT",
        {
          userInput: {
            items: [{ text: "Árvíztűrő tükörfúrógép: hol akad el a folyamat?" }],
            userResponse: "Árvíztűrő tükörfúrógép: hol akad el a folyamat?",
            activeUserState: { openDocuments: [{ absoluteUri: "file:///d:/work/demo-plugin/app.js" }] },
          },
        },
        "2026-02-25T14:02:04.817881200Z",
      ),
      // Injected between turns, 160 times in the measured conversation.
      step("CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE", {
        ephemeralMessage: {
          content: "The following is an <EPHEMERAL_MESSAGE> not actually sent by the user…",
          triggeredHeuristics: ["bash_command_reminder"],
        },
      }),
      // Looks like the assistant speaking and is not: thinking plus tool calls.
      step("CORTEX_STEP_TYPE_PLANNER_RESPONSE", {
        plannerResponse: {
          thinking: "**Analyzing Demo Gallery**\n\nOkay, I'm focusing on the demo concept…",
          messageId: "bot-dddddddd-1111-2222-3333-777777777777",
          toolCalls: [{ id: "eeeeeeee", name: "view_file", argumentsJson: '{"AbsolutePath":"d:\\\\work\\\\app.js"}' }],
          thinkingSignature: "EqeRAQqjkQEBvj72".repeat(40),
          thinkingDuration: "26.752071800s",
          stopReason: "STOP_REASON_STOP_PATTERN",
          response: "Sikeresen létrehoztam a fájlt.",
        },
      }),
      step("CORTEX_STEP_TYPE_RUN_COMMAND", { runCommand: {} }),
      step("CORTEX_STEP_TYPE_VIEW_FILE", { viewFile: {} }),
      step("CORTEX_STEP_TYPE_CONVERSATION_HISTORY", {
        conversationHistory: { content: "# Conversation History\nHere are the conversation IDs…" },
      }),
      step("CORTEX_STEP_TYPE_ERROR_MESSAGE", {
        errorMessage: { error: { userErrorMessage: "Encountered retryable error from model provider…" } },
      }),
      step(
        "CORTEX_STEP_TYPE_NOTIFY_USER",
        {
          notifyUser: {
            notificationContent: "Készítettem egy tervet a javításhoz.",
            reviewAbsoluteUris: ["file:///C:/Users/me/.gemini/antigravity/brain/aaaaaaaa/implementation_plan.md"],
            isBlocking: true,
            askForUserFeedback: true,
          },
        },
        "2026-02-25T14:22:17.873178800Z",
      ),
    ],
  },
});

describe("parsing an antigravity trajectory", () => {
  it("keeps only what was said, out of steps that mostly are not", () => {
    const t = parseTrajectory(trajectory())!;
    expect(t.totalSteps).toBe(8);
    expect(t.turns.map((x) => x.role)).toEqual(["user", "assistant", "assistant"]);
    expect(t.turns[0]!.text).toBe("Árvíztűrő tükörfúrógép: hol akad el a folyamat?");
    expect(t.turns[1]!.text).toBe("Sikeresen létrehoztam a fájlt.");
    expect(t.turns[2]!.text).toBe("Készítettem egy tervet a javításhoz.");
  });

  it("takes only the reply out of a planner step, never the reasoning", () => {
    // The trap: a planner step holds `thinking`, `toolCalls` AND sometimes
    // `response`. Sampling the three largest steps of one conversation found
    // no `response` at all, which is how this field gets missed entirely -
    // and taking the step whole would put the model's reasoning in the index.
    const t = parseTrajectory(trajectory())!;
    const assistant = t.turns.filter((x) => x.role === "assistant").map((x) => x.text);
    expect(assistant).toContain("Sikeresen létrehoztam a fájlt.");
    expect(assistant.join("\n")).not.toContain("Analyzing Demo Gallery");
  });

  it("skips a planner step that is reasoning and nothing else", () => {
    const doc = trajectory();
    delete (doc.trajectory.steps[2] as { plannerResponse: { response?: string } }).plannerResponse.response;
    expect(parseTrajectory(doc)!.turns.map((x) => x.role)).toEqual(["user", "assistant"]);
  });

  it("leaves the model's thinking out, however much of it there is", () => {
    // PLANNER_RESPONSE is the most common step type by far (168 of 523) and
    // reads like the assistant's output. It holds reasoning, tool calls and a
    // base64 signature — no message to the user anywhere in it.
    const all = parseTrajectory(trajectory())!.turns.map((t) => t.text).join("\n");
    expect(all).not.toContain("Analyzing Demo Gallery");
    expect(all).not.toContain("EqeRAQqjkQEB");
    expect(all).not.toContain("view_file");
  });

  it("leaves out the reminders, the injected history and the tool results", () => {
    const all = parseTrajectory(trajectory())!.turns.map((t) => t.text).join("\n");
    expect(all).not.toContain("EPHEMERAL_MESSAGE");
    expect(all).not.toContain("Conversation History");
    expect(all).not.toContain("retryable error");
  });

  it("carries the text, because it exists nowhere else to point at", () => {
    // The store holds this conversation encrypted; only the daemon can undo
    // that. There is no file and byte offset to record.
    const t = parseTrajectory(trajectory())!;
    expect(t.turns.every((x) => x.locator.kind === "inline")).toBe(true);
  });

  it("timestamps each turn from its own step", () => {
    const t = parseTrajectory(trajectory())!;
    expect(t.turns[0]!.tsMs).toBe(Date.parse("2026-02-25T14:02:04.817Z"));
    expect(t.turns[2]!.tsMs).toBe(Date.parse("2026-02-25T14:22:17.873Z"));
    expect(t.createdMs).toBe(Date.parse("2026-02-25T14:00:45.438Z"));
  });

  it("reads the workspace, which is what binds it to a project", () => {
    expect(parseTrajectory(trajectory())!.workspaces).toEqual(["file:///d:/work/demo-plugin"]);
  });

  it("numbers the turns in order, without gaps for the steps it dropped", () => {
    const t = parseTrajectory(trajectory())!;
    expect(t.turns.map((x) => x.seq)).toEqual([0, 1, 2]);
  });

  it("prefers the structured items over the flattened repeat of them", () => {
    const doc = trajectory();
    (doc.trajectory.steps[0] as { userInput: { items: unknown[]; userResponse: string } }).userInput = {
      items: [{ text: "első blokk" }, { text: "második blokk" }],
      userResponse: "csak az elsőt ismétli",
    };
    expect(parseTrajectory(doc)!.turns[0]!.text).toBe("első blokk\nmásodik blokk");
  });

  it("falls back to userResponse when there are no items", () => {
    const doc = trajectory();
    (doc.trajectory.steps[0] as { userInput: unknown }).userInput = { userResponse: "csak ez van" };
    expect(parseTrajectory(doc)!.turns[0]!.text).toBe("csak ez van");
  });

  it("skips a step whose text is empty rather than storing a blank turn", () => {
    const doc = trajectory();
    (doc.trajectory.steps[7] as { notifyUser: unknown }).notifyUser = { notificationContent: "   " };
    expect(parseTrajectory(doc)!.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("says nothing rather than guessing when the payload is not a trajectory", () => {
    expect(parseTrajectory({})).toBeNull();
    expect(parseTrajectory(null)).toBeNull();
    expect(parseTrajectory({ trajectory: null })).toBeNull();
  });

  it("survives a trajectory with no steps and no workspaces", () => {
    const t = parseTrajectory({ trajectory: { cascadeId: "x", steps: [] } })!;
    expect(t.turns).toEqual([]);
    expect(t.workspaces).toEqual([]);
    expect(t.totalSteps).toBe(0);
  });
});
