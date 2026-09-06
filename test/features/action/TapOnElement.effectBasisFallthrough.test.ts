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

  test("does NOT report screenChanged from a viewHierarchy diff when freshness.isFresh is false (#6266)", () => {
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
      activeWindow, // unchanged
      viewHierarchy: makeHierarchy("time-picker-dialog"), // changed, but...
      freshness: { isFresh: false, warning: "retries exhausted, unverified cache entry" },
    });

    const effect = (tap as any).deriveTapEffect(previous, current);

    // An explicitly-stale hierarchy diff is not trustworthy proof of a screen
    // change — must NOT assert screenChanged:true from stale data.
    expect(effect.screenChanged).toBe(false);
    expect(effect.basis).toBe("activeWindow unchanged");
  });

  test("still trusts a viewHierarchy diff when freshness.isFresh is true (dialog case)", () => {
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
      activeWindow,
      viewHierarchy: makeHierarchy("time-picker-dialog"),
      freshness: { isFresh: true },
    });

    const effect = (tap as any).deriveTapEffect(previous, current);

    expect(effect.screenChanged).toBe(true);
    expect(effect.basis).toBe("viewHierarchy changed");
  });

  test("does NOT report screenChanged when the PRE-tap baseline is stale even though the post-tap capture is fresh (#6266)", () => {
    const tap = createTapOnElement();
    const activeWindow = {
      appId: "com.android.deskclock",
      activityName: "com.android.deskclock.DeskClock",
      layoutSeqSum: 42,
    };
    const previous = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("alarm-list"),
      // The cached PRE-tap baseline is explicitly stale — a mismatch against
      // it may predate the tap entirely, not be caused by it.
      freshness: { isFresh: false, warning: "cached baseline, unverified" },
    });
    const current = makeObservation({
      activeWindow, // unchanged
      viewHierarchy: makeHierarchy("time-picker-dialog"), // changed, but baseline is stale
      freshness: { isFresh: true },
    });

    const effect = (tap as any).deriveTapEffect(previous, current);

    expect(effect.screenChanged).toBe(false);
    expect(effect.basis).toBe("activeWindow unchanged");
  });

  test("trusts a viewHierarchy diff when BOTH baseline and post-tap capture are fresh", () => {
    const tap = createTapOnElement();
    const activeWindow = {
      appId: "com.android.deskclock",
      activityName: "com.android.deskclock.DeskClock",
      layoutSeqSum: 42,
    };
    const previous = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("alarm-list"),
      freshness: { isFresh: true },
    });
    const current = makeObservation({
      activeWindow, // unchanged
      viewHierarchy: makeHierarchy("time-picker-dialog"), // changed
      freshness: { isFresh: true },
    });

    const effect = (tap as any).deriveTapEffect(previous, current);

    expect(effect.screenChanged).toBe(true);
    expect(effect.basis).toBe("viewHierarchy changed");
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
