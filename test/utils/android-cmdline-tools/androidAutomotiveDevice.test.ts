import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import {
  CachedAndroidAutomotiveDetector,
  AUTOMOTIVE_FEATURE,
  ANDROID_AUTOMOTIVE_DEVICE_CACHE_TTL_MS,
} from "../../../src/utils/android-cmdline-tools/androidAutomotiveDevice";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const probe = `shell pm has-feature ${AUTOMOTIVE_FEATURE}`;
const unknown: Pick<BootedDevice, "deviceId" | "platform" | "formFactor"> = {
  deviceId: "emulator-5554",
  platform: "android",
};

describe("CachedAndroidAutomotiveDetector", () => {
  test("trusts a known form factor without probing", async () => {
    const adb = new FakeAdbExecutor();
    const detector = new CachedAndroidAutomotiveDetector(new FakeTimer());

    expect(
      await detector.isAndroidAutomotive({ device: { ...unknown, formFactor: "automotive" }, adb }),
    ).toBe(true);
    expect(
      await detector.isAndroidAutomotive({ device: { ...unknown, formFactor: "tv" }, adb }),
    ).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("never probes a non-Android device", async () => {
    const adb = new FakeAdbExecutor();
    const detector = new CachedAndroidAutomotiveDetector(new FakeTimer());

    expect(
      await detector.isAndroidAutomotive({ device: { ...unknown, platform: "ios" }, adb }),
    ).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("answers false without a device handle", async () => {
    expect(
      await new CachedAndroidAutomotiveDetector(new FakeTimer()).isAndroidAutomotive({
        device: unknown,
      }),
    ).toBe(false);
  });

  test("caches a definite probe answer until the TTL expires", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(probe, createExecResult("true", ""));
    const timer = new FakeTimer();
    const detector = new CachedAndroidAutomotiveDetector(timer);

    expect(await detector.isAndroidAutomotive({ device: unknown, adb })).toBe(true);
    expect(await detector.isAndroidAutomotive({ device: unknown, adb })).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([probe]);

    timer.advanceTime(ANDROID_AUTOMOTIVE_DEVICE_CACHE_TTL_MS);
    expect(await detector.isAndroidAutomotive({ device: unknown, adb })).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([probe, probe]);
  });

  test("a failed probe answers false and is asked again next time", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(probe, new Error("adb: closed"));
    const detector = new CachedAndroidAutomotiveDetector(new FakeTimer());

    expect(await detector.isAndroidAutomotive({ device: unknown, adb })).toBe(false);
    expect(await detector.isAndroidAutomotive({ device: unknown, adb })).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([probe, probe]);
  });
});
