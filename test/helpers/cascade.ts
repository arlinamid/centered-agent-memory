import fs from "node:fs";
import path from "node:path";
import type { ResolvedRoots } from "../../src/paths.js";

/** An empty encrypted Cascade file. The collector records the name, not the bytes. */
export function writeCascadePb(roots: ResolvedRoots, id: string, bytes: Buffer = Buffer.alloc(16)): string {
  const dir = path.join(roots.windsurfHome, "cascade");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.pb`);
  fs.writeFileSync(file, bytes);
  return file;
}

export const cascadeTrajectory = (cascadeId: string, userText: string, assistantText: string) => ({
  trajectory: {
    trajectoryId: "bbbbbbbb-1111-2222-3333-555555555555",
    cascadeId,
    metadata: {
      createdAt: "2026-07-02T14:00:45.438063200Z",
      workspaces: [{ workspaceFolderAbsoluteUri: "file:///D:/work/demo" }],
    },
    steps: [
      {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        metadata: { createdAt: "2026-07-02T14:02:04.817881200Z" },
        userInput: { items: [{ text: userText }] },
      },
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: { thinking: "belső gondolatmenet", toolCalls: [{ name: "view_file" }] },
      },
      {
        type: "CORTEX_STEP_TYPE_NOTIFY_USER",
        notifyUser: { notificationContent: assistantText },
      },
    ],
  },
});
