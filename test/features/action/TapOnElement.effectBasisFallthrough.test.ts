import { describe, expect, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../../src/models";

// Issue #6258: effect.screenChanged must not be false when a tap opens a
// dialog that the `activeWindow` basis cannot see (the known dialog-window
// gap, #6151) but that the `viewHierarchy` basis clearly reflects. The
// `activeWindow unchanged` basis must fall through to `viewHierarchy`
// instead of being taken as final proof nothing changed.

function makeHierarchy(marker: string): ViewHierarchyResult {
  return { hierarchy: { node: { marker } } } as unknown as ViewHierarchyResult;
}

function makeObservation(overrides: Partial<ObserveResult>): ObserveResult {
  return {
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  };
}

function createTapOnElement(): TapOnElement {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    { timer },
  );
}

describe("deriveTapEffect basis fallthrough (#6258)", () => {
  test("ignores a dumpsys-to-hierarchy layout sequence difference on an identical screen", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = { name: "test-device", platform: "ios", deviceId: "test-device" };
    const tap = new TapOnElement(device, new FakeAdbExecutor(), { timer });
    const hierarchy = makeHierarchy("onboarding");
    const previous = makeObservation({
      activeWindow: { appId: "com.example.app", activityName: "MainActivity", layoutSeqSum: 5120 },
      viewHierarchy: hierarchy,
    });
    const current = makeObservation({
      activeWindow: { appId: "com.example.app", activityName: "MainActivity", layoutSeqSum: 0 },
      viewHierarchy: hierarchy,
    });

    const result = await tap.deriveTapEffectAfterPostTapObservation(previous, current);
    expect(result.effect).toEqual({ screenChanged: false, basis: "activeWindow unchanged" });
  });

  test("uses hierarchy evidence when only nonzero layout sequences differ", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = { name: "test-device", platform: "ios", deviceId: "test-device" };
    const tap = new TapOnElement(device, new FakeAdbExecutor(), { timer });
    const previous = makeObservation({
      activeWindow: { appId: "com.example.app", activityName: "MainActivity", layoutSeqSum: 41 },
      viewHierarchy: makeHierarchy("onboarding"),
    });
    const current = makeObservation({
      activeWindow: { appId: "com.example.app", activityName: "MainActivity", layoutSeqSum: 42 },
      viewHierarchy: makeHierarchy("next-screen"),
    });

    const result = await tap.deriveTapEffectAfterPostTapObservation(previous, current);
    expect(result.effect).toEqual({ screenChanged: true, basis: "viewHierarchy changed" });
  });

  test("identical hierarchy hashes override stale identity metadata", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = { name: "test-device", platform: "ios", deviceId: "test-device" };
    const tap = new TapOnElement(device, new FakeAdbExecutor(), { timer });
    const hierarchy = makeHierarchy("onboarding");
    const previous = makeObservation({
      activeWindow: { appId: "com.example.app", activityName: "MainActivity", layoutSeqSum: 1 },
      viewHierarchy: hierarchy,
    });
    const current = makeObservation({
      activeWindow: { appId: "com.example.app", activityName: "OtherActivity", layoutSeqSum: 2 },
      viewHierarchy: hierarchy,
    });

    const result = await tap.deriveTapEffectAfterPostTapObservation(previous, current);
    expect(result.effect).toEqual({ screenChanged: false, basis: "viewHierarchy unchanged" });
  });

  test("falls through to viewHierarchy when activeWindow is unchanged but hierarchy changed (dialog open)", () => {
    const tap = createTapOnElement();
    const activeWindow = {
      appId: "com.android.deskclock",
      activityName: "com.android.deskclock.DeskClock",
      layoutSeqSum: 42,
    };
    const previous = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("alarm-list"),
    });
    const current = makeObservation({
      activeWindow, // unchanged — the dialog window isn't reflected here (#6151)
      viewHierarchy: makeHierarchy("time-picker-dialog"),
    });

    const effect = (tap as any).deriveTapEffect(previous, current);

    expect(effect.screenChanged).toBe(true);
    expect(effect.basis).toBe("viewHierarchy changed");
  });

  test("returns false when neither activeWindow nor viewHierarchy changed", () => {
    const tap = createTapOnElement();
    const activeWindow = {
      appId: "com.android.deskclock",
      activityName: "com.android.deskclock.DeskClock",
      layoutSeqSum: 42,
    };
    const hierarchy = makeHierarchy("alarm-list");
    const previous = makeObservation({ activeWindow, viewHierarchy: hierarchy });
    const current = makeObservation({ activeWindow, viewHierarchy: hierarchy });

    const effect = (tap as any).deriveTapEffect(previous, current);

    expect(effect.screenChanged).toBe(false);
    expect(effect.basis).toBe("activeWindow unchanged");
  });

  test("still reports true immediately when activeWindow itself changed", () => {
    const tap = createTapOnElement();
    const previous = makeObservation({
      activeWindow: {
        appId: "com.android.deskclock",
        activityName: "com.android.deskclock.DeskClock",
        layoutSeqSum: 42,
      },
      viewHierarchy: makeHierarchy("alarm-list"),
    });
    const current = makeObservation({
      activeWindow: {
        appId: "com.android.deskclock",
        activityName: "com.android.deskclock.SettingsActivity",
        layoutSeqSum: 43,
      },
      viewHierarchy: makeHierarchy("settings"),
    });

    const effect = (tap as any).deriveTapEffect(previous, current);

    expect(effect.screenChanged).toBe(true);
    expect(effect.basis).toBe("activeWindow changed");
  });
});
