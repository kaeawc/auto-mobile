import { afterEach, describe, expect, test } from "bun:test";
import { Rotate } from "../../../src/features/action/Rotate";
import { RotateUnsupportedError } from "../../../src/features/action/RotateUnsupportedError";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import {
  CachedAndroidTvDetector,
  LEANBACK_FEATURE,
  type AndroidTvDetector,
} from "../../../src/utils/android-cmdline-tools/androidTvDevice";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidTvDetector } from "../../fakes/FakeAndroidTvDetector";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWearOsDetector } from "../../fakes/FakeWearOsDetector";
import { FakeWindow } from "../../fakes/FakeWindow";

const tv: BootedDevice = {
  name: "Television 1080p",
  platform: "android",
  deviceId: "emulator-5560",
  source: "local",
  formFactor: "tv",
};

function setup(
  tvDetector: AndroidTvDetector,
  device: BootedDevice = tv,
  wearOsDetector = new FakeWearOsDetector(false),
) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const awaitIdle = new FakeAwaitIdle();
  const observeScreen = new FakeObserveScreen();
  const rotate = new Rotate(device, {
    adb,
    timer,
    options: { xrDetector: new FakeAndroidXrDetector(false), wearOsDetector, tvDetector },
    collaborators: { awaitIdle, observeScreen, window: new FakeWindow() },
  });
  return { adb, timer, awaitIdle, observeScreen, rotate };
}

describe("Rotate on an Android TV (#19178)", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  for (const orientation of ["portrait", "landscape"] as const) {
    test(`refuses ${orientation} before any settings write or rotation wait`, async () => {
      const { adb, timer, awaitIdle, observeScreen, rotate } = setup(
        new CachedAndroidTvDetector(new FakeTimer()),
      );

      const error = await rotate.execute(orientation).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RotateUnsupportedError);
      expect((error as Error).message).toContain("not supported on Android TV emulator-5560");
      expect(adb.getExecutedCommands()).toEqual([]);
      expect(awaitIdle.getCallCount("waitForRotation")).toBe(0);
      expect(observeScreen.getExecutedOperations().length).toBe(0);
      expect(timer.getSleepCallCount()).toBe(0);
    });
  }

  test("refuses a non-default display too", async () => {
    const { adb, rotate } = setup(new FakeAndroidTvDetector(true));

    await expect(rotate.execute("landscape", { display: 1 })).rejects.toBeInstanceOf(
      RotateUnsupportedError,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("refuses a device of unknown form factor that declares leanback", async () => {
    const { adb, rotate } = setup(new CachedAndroidTvDetector(new FakeTimer()), {
      ...tv,
      formFactor: undefined,
    });
    adb.setCommandResponse(
      `shell pm has-feature ${LEANBACK_FEATURE}`,
      createExecResult("true", ""),
    );

    await expect(rotate.execute("portrait")).rejects.toBeInstanceOf(RotateUnsupportedError);
    expect(adb.getExecutedCommands()).toEqual([`shell pm has-feature ${LEANBACK_FEATURE}`]);
  });

  test("a Wear OS refusal wins without asking the TV predicate", async () => {
    const tvDetector = new FakeAndroidTvDetector(true);
    const { rotate } = setup(tvDetector, tv, new FakeWearOsDetector(true));

    const error = await rotate.execute("landscape").catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("not supported on Wear OS");
    expect(tvDetector.queries).toEqual([]);
  });

  test("asks the TV predicate and goes on to rotate a phone", async () => {
    const detector = new FakeAndroidTvDetector(false);
    const phone: BootedDevice = { ...tv, formFactor: undefined, name: "Phone" };
    const { observeScreen, rotate } = setup(detector, phone);

    // The fake observe screen has no result configured, so the call fails once it starts the
    // observed rotation; reaching that point is the evidence it was not refused.
    const outcome = await rotate.execute("landscape").catch((caught: unknown) => caught);

    expect(detector.queries).toEqual([phone.deviceId]);
    expect(outcome).not.toBeInstanceOf(RotateUnsupportedError);
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(0);
  });
});
