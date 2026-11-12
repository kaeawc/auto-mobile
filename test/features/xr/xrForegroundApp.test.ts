import { expect, test } from "bun:test";
import { xrForegroundApp } from "../../../src/features/xr/xrForegroundApp";

test("empty active app falls back to the current back-stack task", () => {
  expect(
    xrForegroundApp({
      activeWindow: { appId: "", activityName: "", layoutSeqSum: 0 },
      backStack: {
        depth: 0,
        activities: [],
        currentTaskId: 2,
        tasks: [
          { id: 1, packageName: "com.background" },
          { id: 2, packageName: "com.foreground" },
        ],
      },
    }),
  ).toBe("com.foreground");
});
