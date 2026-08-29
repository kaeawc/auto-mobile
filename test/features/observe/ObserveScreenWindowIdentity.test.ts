/**
 * Issue #5867: `observe` could return a stale wrong-window hierarchy (e.g. a
 * status-bar-only Calendar tree) while the device's top resumed activity was a
 * different app entirely, and still report `freshness.verified: true`.
 *
 * These tests drive the real `RealObserveScreen` Android path through fakes.
 * They pin the fix: when the app the hierarchy was captured from does not match
 * the device's current top resumed activity (`adb getForegroundApp`, i.e.
 * dumpsys `topResumedActivity`), freshness is retracted — `verified: false`,
 * `isFresh: false`, with a warning naming both apps.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { BootedDevice } from "../../../src/models";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 7",
  platform: "android",
};

function makeScreen(viewHierarchy: FakeViewHierarchy, fakeAdb: FakeAdbExecutor): RealObserveScreen {
  return new RealObserveScreen(androidDevice, new FakeAdbClientFactory(fakeAdb), {
    viewHierarchy,
    cacheStore: new FakeObserveCacheStore(new FakeTimer()),
    performanceAuditor: { run: async () => undefined } as any,
    accessibilityAuditor: { run: async () => undefined } as any,
    accessibilityStateDetector: { run: async () => undefined } as any,
  });
}

function calendarHierarchy(now: number): any {
  return {
    updatedAt: now,
    receivedAt: now,
    fresh: true,
    screenWidth: 1080,
    screenHeight: 2400,
    foregroundActivity: "com.google.android.calendar/.MainActivity",
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [{ text: "12:34", bounds: { left: 0, top: 0, right: 200, bottom: 60 } }],
      },
    },
  };
}

describe("ObserveScreen window-identity freshness (issue #5867)", () => {
  afterEach(() => {
    resetObserveCacheStore();
  });

  test("retracts freshness when the observed window is not the top resumed activity", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(calendarHierarchy(now));

    const fakeAdb = new FakeAdbExecutor();
    // Ground truth: Settings is the resumed activity, not Calendar.
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe("com.google.android.calendar");
    expect(result.freshness?.verified).toBe(false);
    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("com.google.android.calendar");
    expect(result.freshness?.warning).toContain("com.android.settings");
  });

  test("does not retract freshness when the observed window matches the top resumed activity", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(calendarHierarchy(now));

    const fakeAdb = new FakeAdbExecutor();
    // Ground truth agrees with the observed window.
    fakeAdb.setForegroundApp({ packageName: "com.google.android.calendar", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.verified).toBe(true);
  });

  test("an expanded system-UI shade is not flagged as a wrong-window capture", async () => {
    // When the notification shade / quick settings takes accessibility focus,
    // the observed window is com.android.systemui while the resumed activity
    // behind it is the underlying app. That legitimate divergence must NOT be
    // reported as a stale wrong-window capture (the systemTray workflow relies
    // on observing the expanded shade).
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy({
      updatedAt: now,
      receivedAt: now,
      fresh: true,
      screenWidth: 1080,
      screenHeight: 2400,
      foregroundActivity: "com.android.systemui/.shade.NotificationPanelView",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [{ text: "Silent", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.google.android.calendar", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.verified).toBe(true);
  });

  test("a transient app transition is not flagged: the confirming read settles onto the observed app", async () => {
    // The parallel foreground sample lags the newer captured hierarchy during an
    // A→B transition: sample1 = the old app, observed hierarchy = the new app.
    // The confirming read (taken after capture) sees the device settled on the
    // new app, so freshness must NOT be retracted.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(calendarHierarchy(now)); // observed = calendar

    // First getForegroundApp read lags (still reports settings); the confirming
    // read reports calendar, matching the observed window.
    const sequence = [
      { packageName: "com.android.settings", userId: 0 },
      { packageName: "com.google.android.calendar", userId: 0 },
    ];
    class SequencedForegroundAdb extends FakeAdbExecutor {
      async getForegroundApp(): Promise<{ packageName: string; userId: number } | null> {
        return sequence.shift() ?? { packageName: "com.google.android.calendar", userId: 0 };
      }
    }
    const fakeAdb = new SequencedForegroundAdb();

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.verified).toBe(true);
  });

  test("no ground-truth foreground app leaves freshness unchanged (no false alarm)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(calendarHierarchy(now));

    const fakeAdb = new FakeAdbExecutor();
    // getForegroundApp returns null (default) — cannot compare, must not flag.
    const screen = makeScreen(viewHierarchy, fakeAdb);

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.verified).toBe(true);
  });
});
