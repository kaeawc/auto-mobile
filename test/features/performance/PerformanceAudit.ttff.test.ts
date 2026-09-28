import { describe, expect, test } from "bun:test";
import { PerformanceAudit } from "../../../src/features/performance/PerformanceAudit";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";

describe("PerformanceAudit TTFF parsing", function () {
  test.each([
    ["+850ms", 850],
    ["+1s200ms", 1200],
    ["+2s", 2000],
  ])("parses %s", async function (duration, expected) {
    let command = "";
    const adb = {
      executeCommand: async (value: string) => {
        command = value;
        return { stdout: `I ActivityTaskManager: Displayed com.ex/.Main: ${duration}`, stderr: "" };
      },
      getAndroidApiLevel: async () => 29,
    };
    const audit = new PerformanceAudit(
      { deviceId: "test-device", name: "test", platform: "android" },
      new FakeAdbClientFactory(adb as any),
    );

    const result = await (audit as any).measureTimeToFirstFrame(
      "com.ex",
      new NoOpPerformanceTracker(),
    );

    expect(result).toBe(expected);
    expect(command).toContain("ActivityTaskManager:I");
  });
});
