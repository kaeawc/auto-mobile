import { describe, expect, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

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
