import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import {
  CachedAndroidTvDetector,
  LEANBACK_FEATURE,
  ANDROID_TV_DEVICE_CACHE_TTL_MS,
} from "../../../src/utils/android-cmdline-tools/androidTvDevice";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const probe = `shell pm has-feature ${LEANBACK_FEATURE}`;
const unknown: Pick<BootedDevice, "deviceId" | "platform" | "formFactor"> = {
  deviceId: "emulator-5554",
  platform: "android",
};

describe("CachedAndroidTvDetector", () => {
  test("trusts a known form factor without probing", async () => {
    const adb = new FakeAdbExecutor();
    const detector = new CachedAndroidTvDetector(new FakeTimer());

    expect(await detector.isAndroidTv({ device: { ...unknown, formFactor: "tv" }, adb })).toBe(
      true,
    );
    expect(await detector.isAndroidTv({ device: { ...unknown, formFactor: "watch" }, adb })).toBe(
      false,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("never probes a non-Android device", async () => {
    const adb = new FakeAdbExecutor();
    const detector = new CachedAndroidTvDetector(new FakeTimer());

    expect(await detector.isAndroidTv({ device: { ...unknown, platform: "ios" }, adb })).toBe(
      false,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("answers false without a device handle", async () => {
    expect(
      await new CachedAndroidTvDetector(new FakeTimer()).isAndroidTv({ device: unknown }),
    ).toBe(false);
  });

  test("caches a definite probe answer until the TTL expires", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(probe, createExecResult("true", ""));
    const timer = new FakeTimer();
    const detector = new CachedAndroidTvDetector(timer);

    expect(await detector.isAndroidTv({ device: unknown, adb })).toBe(true);
    expect(await detector.isAndroidTv({ device: unknown, adb })).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([probe]);

    timer.advanceTime(ANDROID_TV_DEVICE_CACHE_TTL_MS);
    expect(await detector.isAndroidTv({ device: unknown, adb })).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([probe, probe]);
  });

  test("a failed probe answers false and is asked again next time", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(probe, new Error("adb: closed"));
    const detector = new CachedAndroidTvDetector(new FakeTimer());

    expect(await detector.isAndroidTv({ device: unknown, adb })).toBe(false);
    expect(await detector.isAndroidTv({ device: unknown, adb })).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([probe, probe]);
  });
});
