import { beforeEach, describe, expect, test } from "bun:test";
import { DisplayedTimeMetricsCollector } from "../../../src/features/performance/DisplayedTimeMetricsCollector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

describe("DisplayedTimeMetricsCollector - Unit Tests", function () {
  let collector: DisplayedTimeMetricsCollector;

  beforeEach(function () {
    // Use FakeAdbExecutor to avoid starting real adb daemon
    const fakeAdb = new FakeAdbExecutor();
    collector = new DisplayedTimeMetricsCollector(
      { deviceId: "test", name: "test", platform: "android" },
      fakeAdb as any,
    );
  });

  test("parses ActivityManager displayed metrics with millisecond duration", function () {
    const output =
      "1694099696.789  1234  5678 I ActivityManager: Displayed com.example/.MainActivity: +824ms";
    const result = (collector as any).parseDisplayedMetrics(output, {
      packageName: "com.example",
      startTimestampMs: 1694099696000,
      endTimestampMs: 1694099697000,
    });

    expect(result.length).toBe(1);
    expect(result[0].packageName).toBe("com.example");
    expect(result[0].activityName).toBe("com.example.MainActivity");
    expect(result[0].displayedTimeMs).toBe(824);
    expect(result[0].logcatTag).toBe("ActivityManager");
  });

  test("parses ActivityTaskManager displayed metrics with seconds duration", function () {
    const output =
      "1694099697.123  1111  2222 I ActivityTaskManager: Displayed com.example/com.example.MainActivity: +1s234ms";
    const result = (collector as any).parseDisplayedMetrics(output, {
      packageName: "com.example",
      startTimestampMs: 1694099697000,
      endTimestampMs: 1694099698000,
    });

    expect(result.length).toBe(1);
    expect(result[0].activityName).toBe("com.example.MainActivity");
    expect(result[0].displayedTimeMs).toBe(1234);
    expect(result[0].logcatTag).toBe("ActivityTaskManager");
  });

  test("filters metrics by package and time window", function () {
    const output = [
      "1694099696.100  1234  5678 I ActivityManager: Displayed com.example/.SplashActivity: +200ms",
      "1694099600.000  1234  5678 I ActivityManager: Displayed com.example/.OldActivity: +400ms",
      "1694099696.200  1234  5678 I ActivityManager: Displayed com.other/.MainActivity: +300ms",
    ].join("\n");

    const result = (collector as any).parseDisplayedMetrics(output, {
      packageName: "com.example",
      startTimestampMs: 1694099696000,
      endTimestampMs: 1694099697000,
    });

    expect(result.length).toBe(1);
    expect(result[0].activityName).toBe("com.example.SplashActivity");
    expect(result[0].displayedTimeMs).toBe(200);
  });

  describe("getPreferredLogcatTag API-level boundary", function () {
    type ConstructorAdb = ConstructorParameters<typeof DisplayedTimeMetricsCollector>[1];
    type LogcatTagProbe = { getPreferredLogcatTag(): Promise<string> };

    function collectorForApiLevel(apiLevel: number | null): DisplayedTimeMetricsCollector {
      const fakeAdb = {
        executeCommand: async () => ({ stdout: "", stderr: "" }),
        getAndroidApiLevel: async () => apiLevel,
      };
      return new DisplayedTimeMetricsCollector(
        { deviceId: "test", name: "test", platform: "android" },
        fakeAdb as unknown as ConstructorAdb,
      );
    }

    const cases: Array<[string, number | null, string]> = [
      ["API 28 (below the boundary) uses ActivityManager", 28, "ActivityManager"],
      ["API 29 (the boundary) switches to ActivityTaskManager", 29, "ActivityTaskManager"],
      ["API 30 (above the boundary) uses ActivityTaskManager", 30, "ActivityTaskManager"],
      ["an unknown API level falls back to ActivityManager", null, "ActivityManager"],
    ];

    test.each(cases)("%s", async function (_name, apiLevel, expected) {
      const collector = collectorForApiLevel(apiLevel);
      const tag = await (collector as unknown as LogcatTagProbe).getPreferredLogcatTag();
      expect(tag).toBe(expected);
    });

    test("falls back to ActivityManager when the executor cannot report an API level", async function () {
      const fakeAdb = { executeCommand: async () => ({ stdout: "", stderr: "" }) };
      const collector = new DisplayedTimeMetricsCollector(
        { deviceId: "test", name: "test", platform: "android" },
        fakeAdb as unknown as ConstructorAdb,
      );
      const tag = await (collector as unknown as LogcatTagProbe).getPreferredLogcatTag();
      expect(tag).toBe("ActivityManager");
    });
  });
});
