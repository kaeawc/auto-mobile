import { describe, expect, test } from "bun:test";
import { PerformanceAudit } from "../../../src/features/performance/PerformanceAudit";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";

/** Reports API 29 so the audit picks the ActivityTaskManager logcat tag. */
class Api29AdbClient extends FakeAdbClient {
  async getAndroidApiLevel(): Promise<number> {
    return 29;
  }
}

describe("PerformanceAudit TTFF parsing", function () {
  test.each([
    ["+850ms", 850],
    ["+1s200ms", 1200],
    ["+2s", 2000],
  ])("parses %s", async function (duration, expected) {
    const adb = new Api29AdbClient();
    adb.setCommandResult(
      `shell "logcat -d -s ActivityTaskManager:I | grep -E 'Displayed.*''com.ex' | tail -1"`,
      `I ActivityTaskManager: Displayed com.ex/.Main: ${duration}`,
    );
    const audit = new PerformanceAudit(
      { deviceId: "test-device", name: "test", platform: "android" },
      new FakeAdbClientFactory(adb),
    );

    const result = await audit.measureTimeToFirstFrame("com.ex", new NoOpPerformanceTracker());

    expect(result).toBe(expected);
    expect(adb.getAllCommands().join("\n")).toContain("ActivityTaskManager:I");
  });
});
