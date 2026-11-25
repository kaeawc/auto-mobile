import { afterEach, describe, expect, test } from "bun:test";
import { RecentApps } from "../../../src/features/action/RecentApps";
import {
  RecentAppsUnsupportedError,
  type RecentAppsFormFactorOptions,
} from "../../../src/features/action/RecentAppsUnsupportedError";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import {
  CachedAndroidTvDetector,
  LEANBACK_FEATURE,
} from "../../../src/utils/android-cmdline-tools/androidTvDevice";
import { CachedWearOsDetector } from "../../../src/utils/android-cmdline-tools/wearOsDevice";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidTvDetector } from "../../fakes/FakeAndroidTvDetector";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWearOsDetector } from "../../fakes/FakeWearOsDetector";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeXrGlassesDetector } from "../../fakes/FakeXrGlassesDetector";
import { CachedXrGlassesDetector } from "../../../src/utils/android-cmdline-tools/xrGlassesDevice";
import { XR_PERIPHERAL_FEATURE } from "../../../src/utils/android-cmdline-tools/androidXrDevice";

const base: BootedDevice = {
  name: "device",
  platform: "android",
  deviceId: "emulator-5562",
  source: "local",
};

function setup(
  device: BootedDevice,
  formFactors: RecentAppsFormFactorOptions,
): {
  adb: FakeAdbExecutor;
  timer: FakeTimer;
  observeScreen: FakeObserveScreen;
  recent: RecentApps;
} {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observeScreen = new FakeObserveScreen();
  const recent = new RecentApps(device, adb, timer, {
    awaitIdle: new FakeAwaitIdle(),
    observeScreen,
    window: new FakeWindow(),
    ...formFactors,
  });
  return { adb, timer, observeScreen, recent };
}

describe("recentApps on a form factor without a recents overview (#19180)", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  const cases = [
    { formFactor: "watch", label: "Wear OS watch" },
    { formFactor: "tv", label: "Android TV" },
    { formFactor: "xr-glasses", label: "Android XR glasses" },
  ] as const;
  for (const { formFactor, label } of cases) {
    test(`refuses a ${formFactor} before any press, observe or wait`, async () => {
      const { adb, timer, observeScreen, recent } = setup(
        { ...base, formFactor },
        {
          wearOsDetector: new CachedWearOsDetector(new FakeTimer()),
          tvDetector: new CachedAndroidTvDetector(new FakeTimer()),
          glassesDetector: new CachedXrGlassesDetector(new FakeTimer()),
        },
      );

      const error = await recent.execute().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RecentAppsUnsupportedError);
      expect((error as Error).message).toContain(`not supported on ${label} emulator-5562`);
      expect(adb.getExecutedCommands()).toEqual([]);
      expect(observeScreen.getExecuteCallCount()).toBe(0);
      expect(timer.getSleepCallCount()).toBe(0);
    });
  }

  test("refuses a device of unknown form factor that declares leanback", async () => {
    const { adb, recent } = setup(base, {
      wearOsDetector: new FakeWearOsDetector(false),
      tvDetector: new CachedAndroidTvDetector(new FakeTimer()),
    });
    adb.setCommandResponse(
      `shell pm has-feature ${LEANBACK_FEATURE}`,
      createExecResult("true", ""),
    );

    await expect(recent.execute()).rejects.toBeInstanceOf(RecentAppsUnsupportedError);
    expect(adb.getExecutedCommands()).toEqual([`shell pm has-feature ${LEANBACK_FEATURE}`]);
  });

  test("refuses a device of unknown form factor that declares xr_peripheral (#19233)", async () => {
    const { adb, recent } = setup(base, {
      wearOsDetector: new FakeWearOsDetector(false),
      tvDetector: new FakeAndroidTvDetector(false),
      glassesDetector: new CachedXrGlassesDetector(new FakeTimer(), 60_000, () => undefined),
    });
    adb.setCommandResponse(
      `shell pm has-feature ${XR_PERIPHERAL_FEATURE}`,
      createExecResult("true", ""),
    );

    const error = await recent.execute().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RecentAppsUnsupportedError);
    expect((error as Error).message).toContain("Android XR glasses");
    expect(adb.getExecutedCommands()).toEqual([`shell pm has-feature ${XR_PERIPHERAL_FEATURE}`]);
  });

  test("asks every predicate and goes on for a phone", async () => {
    const wearOsDetector = new FakeWearOsDetector(false);
    const tvDetector = new FakeAndroidTvDetector(false);
    const glassesDetector = new FakeXrGlassesDetector(false);
    const { observeScreen, recent } = setup(base, { wearOsDetector, tvDetector, glassesDetector });

    // The fake observe screen has no result configured, so the call fails once it starts the
    // observed interaction; reaching that point is the evidence it was not refused.
    const outcome = await recent.execute().catch((caught: unknown) => caught);

    expect(wearOsDetector.queries).toEqual([base.deviceId]);
    expect(tvDetector.queries).toEqual([base.deviceId]);
    expect(glassesDetector.queries).toEqual([base.deviceId]);
    expect(outcome).not.toBeInstanceOf(RecentAppsUnsupportedError);
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(0);
  });

  test("never asks the Android predicates on iOS", async () => {
    const wearOsDetector = new FakeWearOsDetector(true);
    const tvDetector = new FakeAndroidTvDetector(true);
    const { recent } = setup({ ...base, platform: "ios" }, { wearOsDetector, tvDetector });

    const outcome = await recent.execute().catch((caught: unknown) => caught);

    expect(outcome).not.toBeInstanceOf(RecentAppsUnsupportedError);
    expect(wearOsDetector.queries).toEqual([]);
    expect(tvDetector.queries).toEqual([]);
  });
});
