import { afterEach, describe, expect, test } from "bun:test";
import { Rotate } from "../../../src/features/action/Rotate";
import { RotateUnsupportedError } from "../../../src/features/action/RotateUnsupportedError";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import {
  AUTOMOTIVE_FEATURE,
  CachedAndroidAutomotiveDetector,
  type AndroidAutomotiveDetector,
} from "../../../src/utils/android-cmdline-tools/androidAutomotiveDevice";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidAutomotiveDetector } from "../../fakes/FakeAndroidAutomotiveDetector";
import { FakeAndroidTvDetector } from "../../fakes/FakeAndroidTvDetector";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeXrGlassesDetector } from "../../fakes/FakeXrGlassesDetector";
import { FakeWearOsDetector } from "../../fakes/FakeWearOsDetector";
import { FakeWindow } from "../../fakes/FakeWindow";

const car: BootedDevice = {
  name: "Automotive 1024p landscape",
  platform: "android",
  deviceId: "emulator-5562",
  source: "local",
  formFactor: "automotive",
};

function setup(
  automotiveDetector: AndroidAutomotiveDetector,
  device: BootedDevice = car,
  tvDetector = new FakeAndroidTvDetector(false),
) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const awaitIdle = new FakeAwaitIdle();
  const observeScreen = new FakeObserveScreen();
  const rotate = new Rotate(device, {
    adb,
    timer,
    options: {
      xrDetector: new FakeAndroidXrDetector(false),
      glassesDetector: new FakeXrGlassesDetector(),
      wearOsDetector: new FakeWearOsDetector(false),
      tvDetector,
      automotiveDetector,
    },
    collaborators: { awaitIdle, observeScreen, window: new FakeWindow() },
  });
  return { adb, timer, awaitIdle, observeScreen, rotate };
}

describe("Rotate on Android Automotive (#19201)", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  for (const orientation of ["portrait", "landscape"] as const) {
    test(`refuses ${orientation} before any settings write or rotation wait`, async () => {
      const { adb, timer, awaitIdle, observeScreen, rotate } = setup(
        new CachedAndroidAutomotiveDetector(new FakeTimer()),
      );

      const error = await rotate.execute(orientation).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RotateUnsupportedError);
      expect((error as Error).message).toContain(
        "not supported on Android Automotive device emulator-5562",
      );
      expect((error as Error).message).toContain("fixed orientation");
      expect(adb.getExecutedCommands()).toEqual([]);
      expect(awaitIdle.getCallCount("waitForRotation")).toBe(0);
      expect(observeScreen.getExecutedOperations().length).toBe(0);
      expect(timer.getSleepCallCount()).toBe(0);
    });
  }

  test("refuses a non-default display too", async () => {
    const { adb, rotate } = setup(new FakeAndroidAutomotiveDetector(true));

    await expect(rotate.execute("landscape", { display: 1 })).rejects.toBeInstanceOf(
      RotateUnsupportedError,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("refuses a device of unknown form factor that declares the automotive feature", async () => {
    const { adb, rotate } = setup(new CachedAndroidAutomotiveDetector(new FakeTimer()), {
      ...car,
      formFactor: undefined,
    });
    adb.setCommandResponse(
      `shell pm has-feature ${AUTOMOTIVE_FEATURE}`,
      createExecResult("true", ""),
    );

    await expect(rotate.execute("portrait")).rejects.toBeInstanceOf(RotateUnsupportedError);
    expect(adb.getExecutedCommands()).toEqual([`shell pm has-feature ${AUTOMOTIVE_FEATURE}`]);
  });

  test("a TV refusal wins without asking the Automotive predicate", async () => {
    const automotiveDetector = new FakeAndroidAutomotiveDetector(true);
    const { rotate } = setup(automotiveDetector, car, new FakeAndroidTvDetector(true));

    const error = await rotate.execute("landscape").catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("not supported on Android TV");
    expect(automotiveDetector.queries).toEqual([]);
  });

  for (const formFactor of ["phone", "tablet", "foldable"] as const) {
    test(`goes on to rotate a ${formFactor}`, async () => {
      const device: BootedDevice = { ...car, formFactor, name: formFactor };
      const { adb, observeScreen, rotate } = setup(
        new CachedAndroidAutomotiveDetector(new FakeTimer()),
        device,
      );

      // The fake observe screen has no result configured, so the call fails once it starts the
      // observed rotation; reaching that point is the evidence it was not refused.
      const outcome = await rotate.execute("landscape").catch((caught: unknown) => caught);

      expect(outcome).not.toBeInstanceOf(RotateUnsupportedError);
      expect(adb.getExecutedCommands()).not.toContain(`shell pm has-feature ${AUTOMOTIVE_FEATURE}`);
      expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(0);
    });
  }

  test("asks the Automotive predicate and goes on to rotate an unknown phone", async () => {
    const detector = new FakeAndroidAutomotiveDetector(false);
    const phone: BootedDevice = { ...car, formFactor: undefined, name: "Phone" };
    const { observeScreen, rotate } = setup(detector, phone);

    const outcome = await rotate.execute("landscape").catch((caught: unknown) => caught);

    expect(detector.queries).toEqual([phone.deviceId]);
    expect(outcome).not.toBeInstanceOf(RotateUnsupportedError);
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(0);
  });
});
