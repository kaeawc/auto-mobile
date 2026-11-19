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

const API_28_PACKAGE = "dev.jasonpearson.automobile.playground";
const APP = "dev.l18722.dbg";
const COMPONENT = `${APP}/dev.l18722.Main`;
const FULLY_DRAWN_TIMESTAMP_MS = 1795080634318;

function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dir, "../../fixtures/android-startup", name), "utf8");
}

describe("parseAmStartWaitOutput", () => {
  test.each([
    ["am-start-W-cold-api35.txt", "COLD", 457, 461],
    ["am-start-W-warm-api35.txt", "WARM", 75, 76],
    ["am-start-W-hot-api35.txt", "HOT", 86, 88],
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

  test("an intent delivered to the top-most instance reports zero TotalTime", () => {
    expect(parseAmStartWaitOutput(fixture("am-start-W-already-top-api35.txt"))).toEqual({
      status: "ok",
      launchState: "UNKNOWN (0)",
      totalTimeMs: 0,
      waitTimeMs: 2,
      activity: COMPONENT,
      error: null,
    });
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
  test("reads the package's Fully drawn line on API 35 and ignores Displayed and other apps", () => {
    const logcat = fixture("logcat-fully-drawn-api35.txt");
    const otherApp = `${FULLY_DRAWN_TIMESTAMP_MS / 1000} 568 588 I ActivityTaskManager: Fully drawn com.example.other/.Main: +457ms`;
    expect(parseFullyDrawnReports(`${logcat}\n${otherApp}`, APP, 0)).toEqual([
      { componentName: COMPONENT, fullyDrawnMs: 1781, timestampMs: FULLY_DRAWN_TIMESTAMP_MS },
    ]);
  });

  test("reads the ActivityManager tag used before API 29", () => {
    const [report] = parseFullyDrawnReports(
      fixture("logcat-fully-drawn-api28.txt"),
      API_28_PACKAGE,
      0,
    );
    expect(report.fullyDrawnMs).toBe(1950);
  });

  test("reads CRLF output, as adb on a Windows host can print it", () => {
    const crlf = fixture("logcat-fully-drawn-api35.txt").replace(/\r?\n/g, "\r\n");
    expect(parseFullyDrawnReports(crlf, APP, 0)).toHaveLength(1);
    const resolved = fixture("resolve-activity-launcher.txt").replace(/\r?\n/g, "\r\n");
    expect(parseResolvedActivity(resolved, APP)).toBe(COMPONENT);
  });

  test("drops lines logged before the launch", () => {
    expect(
      parseFullyDrawnReports(
        fixture("logcat-fully-drawn-api35.txt"),
        APP,
        FULLY_DRAWN_TIMESTAMP_MS + 1,
      ),
    ).toEqual([]);
  });
});

describe("parseResolvedActivity", () => {
  test("returns the launcher component", () => {
    expect(parseResolvedActivity(fixture("resolve-activity-launcher.txt"), APP)).toBe(COMPONENT);
  });

  test("returns null when nothing resolved or another package answered", () => {
    expect(parseResolvedActivity("No activity found\n", APP)).toBeNull();
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
