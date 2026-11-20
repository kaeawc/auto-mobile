import { afterEach, describe, expect, test } from "bun:test";
import { Rotate } from "../../../src/features/action/Rotate";
import { RotateUnsupportedError } from "../../../src/features/action/RotateUnsupportedError";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import {
  CachedAndroidXrDetector,
  XR_SPATIAL_FEATURE,
} from "../../../src/utils/android-cmdline-tools/androidXrDevice";
import { createExecResult } from "../../../src/utils/execResult";
import type { AndroidXrDetector } from "../../../src/utils/android-cmdline-tools/androidXrDevice";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

const headset: BootedDevice = {
  name: "XR Headset",
  platform: "android",
  deviceId: "emulator-5554",
  source: "local",
  formFactor: "xr-headset",
};

function setup(xrDetector: AndroidXrDetector, device: BootedDevice = headset) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const awaitIdle = new FakeAwaitIdle();
  const observeScreen = new FakeObserveScreen();
  const rotate = new Rotate(device, {
    adb,
    timer,
    xrDetector,
    collaborators: { awaitIdle, observeScreen, window: new FakeWindow() },
  });
  return { adb, timer, awaitIdle, observeScreen, rotate };
}

/** Commands that would change or wait on the device's rotation. */
const rotationCommands = (adb: FakeAdbExecutor) =>
  adb
    .getExecutedCommands()
    .filter(
      (command) =>
        command.includes("settings put") ||
        command.includes("user-rotation") ||
        command.includes("dumpsys window"),
    );

describe("Rotate on Android XR (#18909)", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  for (const orientation of ["portrait", "landscape"] as const) {
    test(`refuses ${orientation} before any settings write or rotation wait`, async () => {
      const { adb, timer, awaitIdle, observeScreen, rotate } = setup(
        new FakeAndroidXrDetector(true),
      );

      const error = await rotate.execute(orientation).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RotateUnsupportedError);
      expect((error as Error).message).toContain("not supported on Android XR");
      expect(adb.getExecutedCommands()).toEqual([]);
      expect(awaitIdle.getCallCount("waitForRotation")).toBe(0);
      expect(observeScreen.getExecutedOperations().length).toBe(0);
      expect(timer.getSleepCallCount()).toBe(0);
      expect(timer.now()).toBe(0);
    });
  }

  test("refuses a non-default display too", async () => {
    const { adb, rotate } = setup(new FakeAndroidXrDetector(true));

    await expect(rotate.execute("landscape", { display: 2 })).rejects.toBeInstanceOf(
      RotateUnsupportedError,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("refuses when the device declares the XR spatial feature", async () => {
    const timer = new FakeTimer();
    const { adb, rotate } = setup(new CachedAndroidXrDetector(timer), {
      ...headset,
      formFactor: undefined,
    });
    adb.setCommandResponse(
      `shell pm has-feature ${XR_SPATIAL_FEATURE}`,
      createExecResult("true", ""),
    );

    await expect(rotate.execute("portrait")).rejects.toBeInstanceOf(RotateUnsupportedError);
    expect(adb.getExecutedCommands()).toEqual([`shell pm has-feature ${XR_SPATIAL_FEATURE}`]);
    expect(rotationCommands(adb)).toEqual([]);
  });

  test("falls back to the xr-headset form factor when the feature probe fails", async () => {
    const timer = new FakeTimer();
    const { adb, rotate } = setup(new CachedAndroidXrDetector(timer));
    adb.setCommandError(`shell pm has-feature ${XR_SPATIAL_FEATURE}`, new Error("adb: closed"));

    await expect(rotate.execute("portrait")).rejects.toBeInstanceOf(RotateUnsupportedError);
    expect(rotationCommands(adb)).toEqual([]);
  });

  test("asks the shared XR predicate and goes on to rotate a non-XR device", async () => {
    const detector = new FakeAndroidXrDetector(false);
    const phone: BootedDevice = { ...headset, formFactor: undefined, name: "Phone" };
    const { observeScreen, rotate } = setup(detector, phone);

    // The fake observe screen has no result configured, so the call fails once it starts the
    // observed rotation; reaching that point is the evidence it was not refused.
    const outcome = await rotate.execute("landscape").catch((caught: unknown) => caught);

    expect(detector.queries).toEqual([phone.deviceId]);
    expect(outcome).not.toBeInstanceOf(RotateUnsupportedError);
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(0);
  });
});
