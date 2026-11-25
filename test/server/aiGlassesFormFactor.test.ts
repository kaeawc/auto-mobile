import { afterEach, describe, expect, test } from "bun:test";
import { Rotate } from "../../src/features/action/Rotate";
import { RotateUnsupportedError } from "../../src/features/action/RotateUnsupportedError";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { ActionableError, type BootedDevice } from "../../src/models";
import { requireWatch, type FormFactorRead } from "../../src/server/requireWatch";
import {
  CachedAndroidXrDetector,
  XR_PERIPHERAL_FEATURE,
  XR_SPATIAL_FEATURE,
} from "../../src/utils/android-cmdline-tools/androidXrDevice";
import { CachedXrGlassesDetector } from "../../src/utils/android-cmdline-tools/xrGlassesDevice";
import {
  AndroidDeviceTraitsReader,
  BUILD_CHARACTERISTICS_PROP,
} from "../../src/utils/android-cmdline-tools/deviceTraits";
import {
  CachedWearOsDetector,
  WATCH_FEATURE,
} from "../../src/utils/android-cmdline-tools/wearOsDevice";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAndroidTvDetector } from "../fakes/FakeAndroidTvDetector";
import { FakeAwaitIdle } from "../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";

/** `pm has-feature` prints `false` and exits 1 for a missing feature. */
const missing = () =>
  new Error("adb command failed", {
    cause: Object.assign(new Error("Command failed: exit 1"), { stdout: "false\n" }),
  });

/** The Android AI glasses image as found in #19196. */
function aiGlassesAdb(): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1\n", ""));
  adb.setCommandResponse(
    `getprop ${BUILD_CHARACTERISTICS_PROP}`,
    createExecResult("nosdcard,watch\n", ""),
  );
  adb.setCommandError(`pm has-feature ${WATCH_FEATURE}`, missing());
  adb.setCommandError(`pm has-feature ${XR_SPATIAL_FEATURE}`, missing());
  adb.setCommandResponse(`pm has-feature ${XR_PERIPHERAL_FEATURE}`, createExecResult("true\n", ""));
  return adb;
}

/** A Wear OS emulator: the same `watch` characteristic, and the watch feature declared. */
function wearOsAdb(): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1\n", ""));
  adb.setCommandResponse(
    `getprop ${BUILD_CHARACTERISTICS_PROP}`,
    createExecResult("nosdcard,watch\n", ""),
  );
  adb.setCommandResponse(`pm has-feature ${WATCH_FEATURE}`, createExecResult("true\n", ""));
  return adb;
}

const glasses: BootedDevice = {
  name: "AI Glasses",
  platform: "android",
  deviceId: "emulator-5560",
  source: "local",
  formFactor: "xr-glasses",
};

const readerFormFactor =
  (adb: FakeAdbExecutor): FormFactorRead =>
  async (device) =>
    (await new AndroidDeviceTraitsReader(new FakeTimer()).read(adb, device.deviceId)).formFactor;

const refusal = { tool: "ambient", purpose: "ambient mode" };

describe("AI glasses device traits (#19196)", () => {
  test("a watch characteristic without the watch feature reads as xr-glasses", async () => {
    const traits = await new AndroidDeviceTraitsReader(new FakeTimer()).read(
      aiGlassesAdb(),
      glasses.deviceId,
    );

    expect(traits.formFactor).toBe("xr-glasses");
  });

  test("a watch characteristic denied by both features is no announced form factor", async () => {
    const adb = aiGlassesAdb();
    adb.setCommandError(`pm has-feature ${XR_PERIPHERAL_FEATURE}`, missing());

    const traits = await new AndroidDeviceTraitsReader(new FakeTimer()).read(adb, "emulator-5562");

    expect(traits.formFactor).toBeNull();
  });

  test("a real Wear OS watch still reads as a watch without the XR probe", async () => {
    const adb = wearOsAdb();

    const traits = await new AndroidDeviceTraitsReader(new FakeTimer()).read(adb, "emulator-5556");

    expect(traits.formFactor).toBe("watch");
    expect(adb.getExecutedCommands()).not.toContain(
      `shell pm has-feature ${XR_PERIPHERAL_FEATURE}`,
    );
  });

  test("an unreadable watch feature probe keeps the watch characteristic", async () => {
    const adb = wearOsAdb();
    adb.setCommandError(`pm has-feature ${WATCH_FEATURE}`, new Error("device offline"));

    const traits = await new AndroidDeviceTraitsReader(new FakeTimer()).read(adb, "emulator-5556");

    expect(traits.formFactor).toBe("watch");
  });
});

describe("Wear gate on AI glasses (#19196)", () => {
  test("refuses the glasses image whose build characteristics name a watch", async () => {
    const device = { ...glasses, formFactor: undefined };

    const error = await requireWatch(device, readerFormFactor(aiGlassesAdb()), refusal).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("form factor is xr-glasses");
  });

  for (const formFactor of ["xr-glasses", "xr-headset"] as const) {
    test(`refuses a session recorded as ${formFactor} even when the build announces a watch`, async () => {
      const error = await requireWatch(
        { ...glasses, formFactor },
        async () => "watch",
        refusal,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ActionableError);
      expect((error as Error).message).toContain(`form factor is ${formFactor}`);
    });
  }

  test("a real Wear OS watch passes the gate", async () => {
    const watch: BootedDevice = { ...glasses, deviceId: "emulator-5556", formFactor: "watch" };

    await requireWatch(watch, readerFormFactor(wearOsAdb()), refusal);
    await requireWatch({ ...watch, formFactor: undefined }, readerFormFactor(wearOsAdb()), refusal);
  });
});

describe("Rotate on AI glasses (#19196)", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  function setup(device: BootedDevice) {
    const adb = aiGlassesAdb();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const awaitIdle = new FakeAwaitIdle();
    const rotate = new Rotate(device, {
      adb,
      timer,
      options: {
        xrDetector: new CachedAndroidXrDetector(new FakeTimer()),
        glassesDetector: new CachedXrGlassesDetector(new FakeTimer()),
        wearOsDetector: new CachedWearOsDetector(new FakeTimer()),
        tvDetector: new FakeAndroidTvDetector(false),
      },
      collaborators: {
        awaitIdle,
        observeScreen: new FakeObserveScreen(),
        window: new FakeWindow(),
      },
    });
    return { adb, timer, awaitIdle, rotate };
  }

  const rotationCommands = (adb: FakeAdbExecutor) =>
    adb
      .getExecutedCommands()
      .filter((command) => command.includes("settings put") || command.includes("user-rotation"));

  for (const formFactor of ["xr-glasses", undefined] as const) {
    test(`refuses landscape on glasses with ${formFactor ?? "no"} recorded form factor though the spatial feature is absent`, async () => {
      const { adb, timer, awaitIdle, rotate } = setup({ ...glasses, formFactor });

      const error = await rotate.execute("landscape").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RotateUnsupportedError);
      expect((error as Error).message).toContain(
        "not supported on Android XR device emulator-5560",
      );
      expect(rotationCommands(adb)).toEqual([]);
      expect(awaitIdle.getCallCount("waitForRotation")).toBe(0);
      expect(timer.now()).toBe(0);
    });
  }
});

describe("CachedXrGlassesDetector", () => {
  test("a known non-glasses form factor answers false without a probe", async () => {
    const adb = aiGlassesAdb();
    const detector = new CachedXrGlassesDetector(new FakeTimer());

    expect(await detector.isXrGlasses({ device: { ...glasses, formFactor: "phone" }, adb })).toBe(
      false,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("caches a definite peripheral answer and retries an unreadable one", async () => {
    const detector = new CachedXrGlassesDetector(new FakeTimer());
    const device = { ...glasses, formFactor: undefined };
    const flaky = new FakeAdbExecutor();
    flaky.setCommandError(`pm has-feature ${XR_PERIPHERAL_FEATURE}`, new Error("device offline"));
    expect(await detector.isXrGlasses({ device, adb: flaky })).toBe(false);

    const adb = aiGlassesAdb();
    expect(await detector.isXrGlasses({ device, adb })).toBe(true);
    expect(await detector.isXrGlasses({ device, adb })).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([`shell pm has-feature ${XR_PERIPHERAL_FEATURE}`]);
  });
});
