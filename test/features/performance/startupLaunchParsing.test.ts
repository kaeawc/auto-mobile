import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseAmStartWaitOutput,
  parseFullyDrawnReports,
  parseResolvedActivity,
  summarizeStartupSamples,
} from "../../../src/features/performance/startupLaunchParsing";
import { readAmStartCapture } from "../../helpers/androidAmStartCapture";

const PLAYGROUND = "dev.jasonpearson.automobile.playground";
const COMPONENT = `${PLAYGROUND}/.MainActivity`;

function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dir, "../../fixtures/android-startup", name), "utf8");
}

describe("parseAmStartWaitOutput", () => {
  test.each([
    ["am-start-W-cold-api34.txt", "COLD", 1342, 1351],
    ["am-start-W-warm-api34.txt", "WARM", 412, 420],
    ["am-start-W-hot-api34.txt", "HOT", 98, 104],
  ])("%s reports its launch state and times", (file, launchState, totalTimeMs, waitTimeMs) => {
    expect(parseAmStartWaitOutput(fixture(file))).toEqual({
      status: "ok",
      launchState,
      totalTimeMs,
      waitTimeMs,
      activity: COMPONENT,
      error: null,
    });
  });

  test("API 28 output has no LaunchState but still a TotalTime", () => {
    const parsed = parseAmStartWaitOutput(fixture("am-start-W-cold-api28.txt"));
    expect(parsed.launchState).toBeNull();
    expect(parsed.totalTimeMs).toBe(1180);
  });

  test("an intent delivered to the top-most instance has no TotalTime", () => {
    const parsed = parseAmStartWaitOutput(fixture("am-start-W-already-top-api34.txt"));
    expect(parsed.launchState).toBe("UNKNOWN (0)");
    expect(parsed.totalTimeMs).toBeNull();
    expect(parsed.error).toBeNull();
  });

  test("a captured missing-activity failure is reported as an error", () => {
    const [, waited] = readAmStartCapture("am-start-installed-wrong-activity-emulator-5600.txt");
    expect(waited.command).toContain("am start -W");
    const parsed = parseAmStartWaitOutput(waited.output);
    expect(parsed.error).toBe("Error type 3");
    expect(parsed.totalTimeMs).toBeNull();
  });
});

describe("parseFullyDrawnReports", () => {
  test("reads the package's Fully drawn line on API 34 and ignores Displayed and other apps", () => {
    expect(parseFullyDrawnReports(fixture("logcat-fully-drawn-api34.txt"), PLAYGROUND, 0)).toEqual([
      { componentName: COMPONENT, fullyDrawnMs: 2118, timestampMs: 1729500000900 },
    ]);
  });

  test("reads the ActivityManager tag used before API 29", () => {
    const [report] = parseFullyDrawnReports(fixture("logcat-fully-drawn-api28.txt"), PLAYGROUND, 0);
    expect(report.fullyDrawnMs).toBe(1950);
  });

  test("reads CRLF output, as adb on a Windows host can print it", () => {
    const crlf = fixture("logcat-fully-drawn-api34.txt").replace(/\r?\n/g, "\r\n");
    expect(parseFullyDrawnReports(crlf, PLAYGROUND, 0)).toHaveLength(1);
    const resolved = fixture("resolve-activity-launcher.txt").replace(/\r?\n/g, "\r\n");
    expect(parseResolvedActivity(resolved, PLAYGROUND)).toBe(COMPONENT);
  });

  test("drops lines logged before the launch", () => {
    expect(
      parseFullyDrawnReports(fixture("logcat-fully-drawn-api34.txt"), PLAYGROUND, 1729500000901),
    ).toEqual([]);
  });
});

describe("parseResolvedActivity", () => {
  test("returns the launcher component", () => {
    expect(parseResolvedActivity(fixture("resolve-activity-launcher.txt"), PLAYGROUND)).toBe(
      COMPONENT,
    );
  });

  test("returns null when nothing resolved or another package answered", () => {
    expect(parseResolvedActivity("No activity found\n", PLAYGROUND)).toBeNull();
    expect(parseResolvedActivity(fixture("resolve-activity-launcher.txt"), "com.other")).toBeNull();
  });
});

describe("summarizeStartupSamples", () => {
  test("reports min, interpolated p50/p90 and max, keeping samples in iteration order", () => {
    expect(summarizeStartupSamples([500, 100, 300, 200, 400])).toEqual({
      min: 100,
      p50: 300,
      p90: 460,
      max: 500,
      samples: [500, 100, 300, 200, 400],
    });
  });

  test("returns null for no samples", () => {
    expect(summarizeStartupSamples([])).toBeNull();
  });
});
