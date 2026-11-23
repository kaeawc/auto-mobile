import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import {
  CachedWearOsDetector,
  WATCH_FEATURE,
  WEAR_OS_DEVICE_CACHE_TTL_MS,
} from "../../../src/utils/android-cmdline-tools/wearOsDevice";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const probe = `shell pm has-feature ${WATCH_FEATURE}`;
const unknown: Pick<BootedDevice, "deviceId" | "platform" | "formFactor"> = {
  deviceId: "emulator-5554",
  platform: "android",
};

describe("CachedWearOsDetector", () => {
  test("trusts a known form factor without probing", async () => {
    const adb = new FakeAdbExecutor();
    const detector = new CachedWearOsDetector(new FakeTimer());

    expect(await detector.isWearOs({ device: { ...unknown, formFactor: "watch" }, adb })).toBe(
      true,
    );
    expect(await detector.isWearOs({ device: { ...unknown, formFactor: "tv" }, adb })).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("never probes a non-Android device", async () => {
    const adb = new FakeAdbExecutor();
    const detector = new CachedWearOsDetector(new FakeTimer());

    expect(await detector.isWearOs({ device: { ...unknown, platform: "ios" }, adb })).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("answers false without a device handle", async () => {
    expect(await new CachedWearOsDetector(new FakeTimer()).isWearOs({ device: unknown })).toBe(
      false,
    );
  });

  test("caches a definite probe answer until the TTL expires", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(probe, createExecResult("true", ""));
    const timer = new FakeTimer();
    const detector = new CachedWearOsDetector(timer);

    expect(await detector.isWearOs({ device: unknown, adb })).toBe(true);
    expect(await detector.isWearOs({ device: unknown, adb })).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([probe]);

    timer.advanceTime(WEAR_OS_DEVICE_CACHE_TTL_MS);
    expect(await detector.isWearOs({ device: unknown, adb })).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([probe, probe]);
  });

  test("a failed probe answers false and is asked again next time", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(probe, new Error("adb: closed"));
    const detector = new CachedWearOsDetector(new FakeTimer());

    expect(await detector.isWearOs({ device: unknown, adb })).toBe(false);
    expect(await detector.isWearOs({ device: unknown, adb })).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([probe, probe]);
  });
});
