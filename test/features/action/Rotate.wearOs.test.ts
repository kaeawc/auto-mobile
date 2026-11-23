import { afterEach, describe, expect, test } from "bun:test";
import { Rotate } from "../../../src/features/action/Rotate";
import { RotateUnsupportedError } from "../../../src/features/action/RotateUnsupportedError";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import {
  CachedWearOsDetector,
  WATCH_FEATURE,
  type WearOsDetector,
} from "../../../src/utils/android-cmdline-tools/wearOsDevice";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWearOsDetector } from "../../fakes/FakeWearOsDetector";
import { FakeWindow } from "../../fakes/FakeWindow";

const watch: BootedDevice = {
  name: "Wear OS Large Round",
  platform: "android",
  deviceId: "emulator-5556",
  source: "local",
  formFactor: "watch",
};

function setup(
  wearOsDetector: WearOsDetector,
  device: BootedDevice = watch,
  xrDetector = new FakeAndroidXrDetector(false),
) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const awaitIdle = new FakeAwaitIdle();
  const observeScreen = new FakeObserveScreen();
  const rotate = new Rotate(device, {
    adb,
    timer,
    options: { xrDetector, wearOsDetector },
    collaborators: { awaitIdle, observeScreen, window: new FakeWindow() },
  });
  return { adb, timer, awaitIdle, observeScreen, rotate };
}

describe("Rotate on a Wear OS watch (#18959)", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  for (const orientation of ["portrait", "landscape"] as const) {
    test(`refuses ${orientation} before any settings write or rotation wait`, async () => {
      const { adb, timer, awaitIdle, observeScreen, rotate } = setup(
        new CachedWearOsDetector(new FakeTimer()),
      );

      const error = await rotate.execute(orientation).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RotateUnsupportedError);
      expect((error as Error).message).toContain("not supported on Wear OS watch emulator-5556");
      expect(adb.getExecutedCommands()).toEqual([]);
      expect(awaitIdle.getCallCount("waitForRotation")).toBe(0);
      expect(observeScreen.getExecutedOperations().length).toBe(0);
      expect(timer.getSleepCallCount()).toBe(0);
      expect(timer.now()).toBe(0);
    });
  }

  test("refuses a non-default display too", async () => {
    const { adb, rotate } = setup(new FakeWearOsDetector(true));

    await expect(rotate.execute("landscape", { display: 1 })).rejects.toBeInstanceOf(
      RotateUnsupportedError,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("refuses a device of unknown form factor that declares the watch feature", async () => {
    const { adb, rotate } = setup(new CachedWearOsDetector(new FakeTimer()), {
      ...watch,
      formFactor: undefined,
    });
    adb.setCommandResponse(`shell pm has-feature ${WATCH_FEATURE}`, createExecResult("true", ""));

    await expect(rotate.execute("portrait")).rejects.toBeInstanceOf(RotateUnsupportedError);
    expect(adb.getExecutedCommands()).toEqual([`shell pm has-feature ${WATCH_FEATURE}`]);
  });

  test("an Android XR refusal wins without asking the Wear OS predicate", async () => {
    const wearOs = new FakeWearOsDetector(true);
    const { rotate } = setup(wearOs, watch, new FakeAndroidXrDetector(true));

    const error = await rotate.execute("landscape").catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("not supported on Android XR");
    expect(wearOs.queries).toEqual([]);
  });

  test("asks the Wear OS predicate and goes on to rotate a phone", async () => {
    const detector = new FakeWearOsDetector(false);
    const phone: BootedDevice = { ...watch, formFactor: undefined, name: "Phone" };
    const { observeScreen, rotate } = setup(detector, phone);

    // The fake observe screen has no result configured, so the call fails once it starts the
    // observed rotation; reaching that point is the evidence it was not refused.
    const outcome = await rotate.execute("landscape").catch((caught: unknown) => caught);

    expect(detector.queries).toEqual([phone.deviceId]);
    expect(outcome).not.toBeInstanceOf(RotateUnsupportedError);
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(0);
  });
});
