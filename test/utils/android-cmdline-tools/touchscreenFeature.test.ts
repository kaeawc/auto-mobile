import { describe, expect, test } from "bun:test";
import {
  CachedTouchscreenFeature,
  parseHasFeature,
  TOUCHSCREEN_FEATURE_CACHE_TTL_MS,
} from "../../../src/utils/android-cmdline-tools/touchscreenFeature";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const PROBE = "pm has-feature android.hardware.touchscreen";

function adbAnswering(stdout: string): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(PROBE, createExecResult(stdout, ""));
  return adb;
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

  test("reports a phone's touchscreen", async () => {
    const feature = new CachedTouchscreenFeature(new FakeTimer());
    expect(await feature.hasTouchscreen(adbAnswering("true\n"), "phone")).toBe(true);
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
