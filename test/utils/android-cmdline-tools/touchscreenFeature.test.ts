import { describe, expect, test } from "bun:test";
import {
  CachedTouchscreenFeature,
  parseFailedHasFeature,
  parseHasFeature,
  TOUCHSCREEN_FEATURE_CACHE_TTL_MS,
} from "../../../src/utils/android-cmdline-tools/touchscreenFeature";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const PROBE = "pm has-feature android.hardware.touchscreen";
const LEANBACK = "pm has-feature android.software.leanback";
const TELEVISION = "pm has-feature android.hardware.type.television";

function adbAnswering(stdout: string): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(PROBE, createExecResult(stdout, ""));
  return adb;
}

/** `pm has-feature` prints `false` and exits 1 for a feature the device lacks. */
function missingFeature(): Error {
  const exitOne = Object.assign(new Error("Command failed: exit 1"), { stdout: "false\n" });
  return new Error("adb command failed", { cause: exitOne });
}

const probes = (adb: FakeAdbExecutor): number =>
  adb.getExecutedCommands().filter((command) => command.includes(PROBE)).length;

describe("parseHasFeature", () => {
  test.each([
    ["true\n", true],
    ["false\n", false],
    ["", null],
    ["Error: unknown command", null],
  ] as const)("%j -> %p", (raw, expected) => {
    expect(parseHasFeature(raw)).toBe(expected);
  });
});

describe("parseFailedHasFeature", () => {
  test.each([
    ["false\n", false],
    ["false\n\nfalse\n", false],
    ["false\ntrue", null],
    ["", null],
  ] as const)("%j -> %p", (raw, expected) => {
    expect(parseFailedHasFeature(raw)).toBe(expected);
  });
});

describe("CachedTouchscreenFeature", () => {
  test("reports a TV that declares no touchscreen and caches the answer within the TTL", async () => {
    const timer = new FakeTimer();
    const feature = new CachedTouchscreenFeature(timer);
    const adb = adbAnswering("false\n");

    expect(await feature.hasTouchscreen(adb, "emulator-5554")).toBe(false);
    timer.advanceTime(TOUCHSCREEN_FEATURE_CACHE_TTL_MS - 1);
    expect(await feature.hasTouchscreen(adb, "emulator-5554")).toBe(false);
    expect(probes(adb)).toBe(1);

    timer.advanceTime(1);
    expect(await feature.hasTouchscreen(adb, "emulator-5554")).toBe(false);
    expect(probes(adb)).toBe(2);
  });

  test("reads the false answer pm has-feature prints with exit status 1", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    const adb = new FakeAdbExecutor();
    // AdbClient rejects the non-zero exit; the raw execFile error on `cause` keeps the stdout.
    const exitOne = Object.assign(new Error("Command failed: exit 1"), { stdout: "false\n" });
    adb.setCommandError(PROBE, new Error("adb command failed", { cause: exitOne }));
    expect(await feature.hasTouchscreen(adb, "tv")).toBe(false);
    expect(await feature.hasTouchscreen(adb, "tv")).toBe(false);
    expect(probes(adb)).toBe(1);
  });

  test("reports a phone's touchscreen", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    expect(await feature.hasTouchscreen(adbAnswering("true\n"), "phone")).toBe(true);
  });

  // mt0091b (#17316): API 36 android-tv and google-tv emulators answer `true` for both the
  // touchscreen and leanback features, though they have no touch input device.
  test("a TV emulator that declares a touchscreen and leanback reads as touchless", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    const adb = adbAnswering("true\n");
    adb.setCommandResponse(LEANBACK, createExecResult("true\n", ""));

    expect(await feature.hasTouchscreen(adb, "emulator-5554")).toBe(false);
    expect(await feature.hasTouchscreen(adb, "emulator-5554")).toBe(false);
    expect(probes(adb)).toBe(1);
  });

  test("a television feature without leanback also reads as touchless", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    const adb = adbAnswering("true\n");
    adb.setCommandError(LEANBACK, missingFeature());
    adb.setCommandResponse(TELEVISION, createExecResult("true\n", ""));
    expect(await feature.hasTouchscreen(adb, "tv")).toBe(false);
  });

  test("a phone that declares neither TV feature keeps its cached touchscreen", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    const adb = adbAnswering("true\n");
    adb.setCommandError(LEANBACK, missingFeature());
    adb.setCommandError(TELEVISION, missingFeature());
    expect(await feature.hasTouchscreen(adb, "phone")).toBe(true);
    expect(await feature.hasTouchscreen(adb, "phone")).toBe(true);
    expect(probes(adb)).toBe(1);
  });

  test("an unreadable TV-feature probe keeps touch input and is not cached", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    const adb = adbAnswering("true\n");
    adb.setCommandError(LEANBACK, new Error("device offline"));
    expect(await feature.hasTouchscreen(adb, "tv")).toBe(true);
    expect(await feature.hasTouchscreen(adb, "tv")).toBe(true);
    expect(probes(adb)).toBe(2);
  });

  test("a device without a touchscreen is not asked about TV features", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    const adb = adbAnswering("false\n");
    expect(await feature.hasTouchscreen(adb, "tv")).toBe(false);
    expect(adb.getExecutedCommands().filter((command) => command.includes(LEANBACK))).toEqual([]);
  });

  test("a failed or unreadable probe returns null and is not cached", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    const failing = new FakeAdbExecutor();
    failing.setCommandError(PROBE, new Error("device offline"));
    expect(await feature.hasTouchscreen(failing, "tv")).toBeNull();

    const garbled = adbAnswering("???\n");
    expect(await feature.hasTouchscreen(garbled, "tv")).toBeNull();
    expect(await feature.hasTouchscreen(garbled, "tv")).toBeNull();
    expect(probes(garbled)).toBe(2);
  });

  test("an aborted probe rejects instead of reading as unknown", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    const adb = new FakeAdbExecutor();
    adb.setCommandError(PROBE, new Error("aborted"));
    const controller = new AbortController();
    controller.abort();
    await expect(feature.hasTouchscreen(adb, "tv", controller.signal)).rejects.toThrow();
  });
});
