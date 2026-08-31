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
    packageName: "com.google.android.calendar",
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

  test("falls back when accessibility foreground metadata is a View class", async () => {
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
      packageName: "com.example.app",
      foregroundActivity: "com.example.app/android.widget.FrameLayout",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    const fallbackWindow = {
      getActive: async () => ({
        appId: "com.example.app",
        activityName: "com.example.app.MainActivity",
        layoutSeqSum: 0,
      }),
      getActiveHash: async () => "hash",
      getCachedActiveWindow: async () => null,
      setCachedActiveWindow: async () => undefined,
      clearCache: async () => undefined,
    };

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: fallbackWindow,
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow).toEqual({
      appId: "com.example.app",
      activityName: "com.example.app.MainActivity",
      layoutSeqSum: 0,
    });
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
    expect(result.freshness?.warning).toContain(
      'pressButton { platform: "android", button: "home" }',
    );
    expect(result.freshness?.warning).toContain("relaunch the target app");
  });

  test("the freshness verdict is present when the result is cached (survives serialization)", async () => {
    // The filesystem observe cache serializes the result at put() time, so the
    // verdict must be attached BEFORE caching — otherwise a daemon-restart cache
    // reload loses the isFresh:false signal (issue #5867). Snapshot the result as
    // the real store would (deep clone at put) and assert the verdict is there.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(calendarHierarchy(now));

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });

    let putSnapshot: any;
    const snapshotStore = {
      async put(_deviceId: string, result: any): Promise<void> {
        putSnapshot = JSON.parse(JSON.stringify(result));
      },
      async getMostRecent(): Promise<any> {
        return undefined;
      },
      getRecentInMemory: () => undefined,
      getRecentInMemoryForDevice: () => undefined,
      clear: () => undefined,
      currentGeneration: () => 0,
    };

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        cacheStore: snapshotStore as any,
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(putSnapshot).toBeDefined();
    expect(putSnapshot.freshness?.verified).toBe(false);
    expect(putSnapshot.freshness?.isFresh).toBe(false);
    expect(putSnapshot.freshness?.warning).toContain("wrong-window");
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

  test("reconciles stale CtrlProxy attribution when hierarchy and foreground agree", async () => {
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
      // The recovered hierarchy is the launcher, but CtrlProxy still attributes
      // its active root to Calendar (issue #5972).
      packageName: "com.google.android.apps.nexuslauncher",
      foregroundActivity: "com.google.android.calendar/.AllInOneCalendarActivity",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [{ text: "Gmail", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.google.android.apps.nexuslauncher", userId: 0 });
    let performanceAuditAppId: string | undefined;

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: {
          run: async (observedResult: ObserveResult) => {
            performanceAuditAppId = observedResult.activeWindow?.appId;
          },
        } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow).toEqual({
      appId: "com.google.android.apps.nexuslauncher",
      activityName: "",
      layoutSeqSum: 0,
    });
    expect(performanceAuditAppId).toBe("com.google.android.apps.nexuslauncher");
    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.verified).toBe(true);
    expect(result.freshness?.warning).toBeUndefined();
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
      packageName: "com.android.systemui",
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

  test("retracts freshness for a system-UI hierarchy confined to the status bar", async () => {
    // Regression for #5981: after in-app navigation, CtrlProxy can report the
    // active status-bar window while Settings remains the resumed activity.
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
      systemInsets: { top: 63, right: 0, bottom: 0, left: 0 },
      packageName: "com.android.systemui",
      foregroundActivity: "com.android.settings/.SubSettings",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
          // CtrlProxy serializes a singleton child as an object rather than an
          // array. The freshness traversal must accept both wire shapes.
          node: { text: "12:34", bounds: { left: 21, top: 0, right: 107, bottom: 63 } },
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
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

    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.verified).toBe(false);
    expect(result.freshness?.warning).toContain("status-bar");
    expect(result.freshness?.warning).toContain("com.android.settings");
    expect(result.error).toBeUndefined();
    expect(result.freshness?.warning).toContain(
      'pressButton { platform: "android", button: "home" }',
    );
  });

  test("retracts freshness for system-chrome-only multiple hierarchy roots", async () => {
    // CtrlProxy preserves multiple extracted windows as a top-level node array.
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
      systemInsets: { top: 63, right: 0, bottom: 63, left: 63 },
      packageName: "com.android.systemui",
      foregroundActivity: "com.android.settings/.SubSettings",
      hierarchy: {
        node: [
          { text: "12:34", bounds: { left: 21, top: 0, right: 107, bottom: 63 } },
          {
            contentDesc: "Wifi signal full.",
            bounds: { left: 892, top: 11, right: 931, bottom: 50 },
          },
          {
            contentDesc: "Home",
            bounds: { left: 486, top: 2337, right: 594, bottom: 2400 },
          },
          {
            contentDesc: "Back",
            bounds: { left: 0, top: 63, right: 63, bottom: 2337 },
          },
        ],
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
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

    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.verified).toBe(false);
  });

  test("does not retract a same-package hierarchy reduced to status-bar content", async () => {
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
      systemInsets: { top: 63, right: 0, bottom: 63, left: 0 },
      packageName: "com.google.android.calendar",
      foregroundActivity: "com.google.android.calendar/.MainActivity",
      hierarchy: {
        node: { text: "12:34", bounds: { left: 21, top: 0, right: 107, bottom: 63 } },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.google.android.calendar", userId: 0 });
    const screen = makeScreen(viewHierarchy, fakeAdb);

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

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
    viewHierarchy.configureHierarchy({
      ...calendarHierarchy(now),
      // CtrlProxy has not yet updated the active window from Settings.
      foregroundActivity: "com.android.settings/.Settings",
    }); // observed = calendar

    // First getForegroundApp read lags (still reports settings); the confirming
    // read reports calendar, matching the observed hierarchy.
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

    expect(result.activeWindow?.appId).toBe("com.google.android.calendar");
    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.verified).toBe(true);
  });

  test("does not overwrite a newer active window with a stale hierarchy", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy({
      ...calendarHierarchy(now),
      foregroundActivity: "com.android.settings/.Settings",
    });

    // The initial parallel sample agrees with the stale Calendar hierarchy,
    // while the post-capture sample confirms the newer Settings window.
    const sequence = [
      { packageName: "com.google.android.calendar", userId: 0 },
      { packageName: "com.android.settings", userId: 0 },
    ];
    class SequencedForegroundAdb extends FakeAdbExecutor {
      async getForegroundApp(): Promise<{ packageName: string; userId: number } | null> {
        return sequence.shift() ?? { packageName: "com.android.settings", userId: 0 };
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

    expect(result.activeWindow?.appId).toBe("com.android.settings");
    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.verified).toBe(true);
  });

  test("an active IME is not flagged: the check uses the captured hierarchy's package", async () => {
    // With a soft keyboard active, the a11y foregroundActivity (→ activeWindow.appId)
    // can be the IME root's package while the captured hierarchy is the underlying
    // app. The window-identity check must compare the hierarchy's own package
    // (viewHierarchy.packageName), so a valid app hierarchy is not retracted.
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
      packageName: "com.google.android.calendar", // the captured tree is the app
      foregroundActivity: "com.google.android.inputmethod.latin/.LatinIME", // IME root
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [{ text: "Note", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    // Ground truth: the app is the resumed activity (the IME is not an activity).
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
    expect(result.activeWindow?.appId).toBe("com.google.android.calendar");
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
