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

  test("recaptures before replacing stale same-app activity attribution", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      {
        ...calendarHierarchy(now),
        packageName: "com.android.settings",
        foregroundActivity: "com.android.settings/.homepage.SettingsHomepageActivity",
        hierarchy: { node: { node: [{ text: "Settings home" }] } },
      },
      {
        ...calendarHierarchy(now + 1),
        packageName: "com.android.settings",
        foregroundActivity: "com.android.settings/.SubSettings",
        hierarchy: { node: { node: [{ text: "Connected devices" }] } },
      },
    ] as any);
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        backStack: {
          execute: async () => ({
            depth: 1,
            activities: [],
            tasks: [],
            currentActivity: { name: "com.android.settings.SubSettings", taskId: 7 },
            source: "adb",
          }),
        } as any,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(viewHierarchy.getCallCount()).toBe(2);
    expect(viewHierarchy.getCalls()[1]?.minTimestamp).toBe(now + 1);
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Connected devices");
    expect(result.wakefulness).toBe("Awake");
  });

  test("uses the adb task owner for an activity outside its package namespace", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      {
        ...calendarHierarchy(now),
        packageName: "com.google.android.contacts",
        foregroundActivity: "com.google.android.contacts/.ContactsActivity",
      },
      {
        ...calendarHierarchy(now + 1),
        packageName: "com.google.android.contacts",
        foregroundActivity: "com.google.android.apps.contacts.activities.OnboardingSignInActivity",
      },
    ] as any);
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.google.android.contacts", userId: 0 });
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        backStack: {
          execute: async () => ({
            depth: 1,
            activities: [],
            tasks: [{ id: 7, packageName: "com.google.android.contacts" }],
            currentActivity: {
              name: "com.google.android.apps.contacts.activities.OnboardingSignInActivity",
              taskId: 7,
            },
            source: "adb",
          }),
        } as any,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(result.activeWindow?.activityName).toBe(
      "com.google.android.apps.contacts.activities.OnboardingSignInActivity",
    );
  });

  test("keeps the original observation when a forced attribution recapture is unusable", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      {
        ...calendarHierarchy(now),
        packageName: "com.android.settings",
        foregroundActivity: "com.android.settings/.homepage.SettingsHomepageActivity",
        hierarchy: { node: { node: [{ text: "Settings home" }] } },
      },
      { hierarchy: { error: "CtrlProxy timed out" }, fresh: false },
    ] as any);
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        backStack: {
          execute: async () => ({
            depth: 1,
            activities: [],
            tasks: [],
            currentActivity: { name: "com.android.settings.SubSettings", taskId: 7 },
            source: "adb",
          }),
        } as any,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(result.activeWindow?.activityName).toBe(
      "com.android.settings.homepage.SettingsHomepageActivity",
    );
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Settings home");
    expect(result.freshness?.verified).toBe(false);
    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("disagree about the current activity");
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
          node: [{ text: "12:34", bounds: { left: 21, top: 0, right: 107, bottom: 63 } }],
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
    expect(result.freshness?.warning).toContain(
      'pressButton { platform: "android", button: "home" }',
    );
  });

  test("uses the confirmed foreground for a status-bar-only hierarchy after transition", async () => {
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
      ctrlProxyIncomplete: true,
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
          node: [{ text: "12:34", bounds: { left: 21, top: 0, right: 107, bottom: 63 } }],
        },
      },
    } as any);

    const foregrounds = [
      { packageName: "com.android.calendar", userId: 0 },
      { packageName: "com.android.settings", userId: 0 },
    ];
    class TransitioningForegroundAdb extends FakeAdbExecutor {
      async getForegroundApp(): Promise<{ packageName: string; userId: number } | null> {
        return foregrounds.shift() ?? { packageName: "com.android.settings", userId: 0 };
      }
    }

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(new TransitioningForegroundAdb()),
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
    expect(result.freshness?.warning).toContain("com.android.settings");
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

  // Issue #6070: on the bootstrap Window.getActive() path (used when the
  // accessibility service supplies no usable foregroundActivity), a blank/stale
  // active-window record can be published with an empty activityName. An empty
  // activityName is reconciled from the adb-sourced backStack, but through the
  // SAME temporal confirmation (hierarchy recapture) the stale non-empty case
  // uses (#5992): the adb activity is only accepted once a fresh recapture
  // agrees, never blindly stamped onto the earlier hierarchy. When the recapture
  // cannot confirm (e.g. a same-app mid-flight navigation between capture and
  // back-stack read), the name resolves to unknown/mismatch rather than a
  // confidently-wrong value. The confirmed window keeps its correlated
  // layoutSeqSum (kept fresh by the getActive(true) bootstrap read), never a
  // zero sentinel that would blind tap-effect detection. The frozen-cache source
  // of the stale layoutSeqSum is eliminated at the collector (see
  // DeviceStateCollector force-refresh). System UI (#6078) is out of scope here.
  const emptyBootstrapWindow = (activeWindow: {
    appId: string;
    activityName: string;
    layoutSeqSum: number;
  }) =>
    ({
      getActive: async () => activeWindow,
      getActiveHash: async () => "hash",
      getCachedActiveWindow: async () => null,
      setCachedActiveWindow: async () => undefined,
      clearCache: async () => undefined,
    }) as any;

  test("backfills an empty activeWindow activityName from a temporally-confirmed backStack (#6070)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    // No usable foregroundActivity -> the accessibility path does not set
    // activeWindow, so the bootstrap Window.getActive() fallback runs. The device
    // is stable: the recapture re-reads the same (fresh) hierarchy and the same
    // backStack, so the adb activity is confirmed and backfilled.
    viewHierarchy.configureHierarchy({
      updatedAt: now,
      receivedAt: now,
      fresh: true,
      screenWidth: 1080,
      screenHeight: 2400,
      packageName: "com.android.settings",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [{ text: "Settings", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
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
        window: emptyBootstrapWindow({
          appId: "com.android.settings",
          activityName: "",
          // The current (force-refreshed) window layout sequence.
          layoutSeqSum: 5120,
        }),
        backStack: {
          execute: async () => ({
            depth: 1,
            activities: [],
            tasks: [],
            currentActivity: { name: "com.android.settings.Settings", taskId: 14 },
            source: "adb",
          }),
        } as any,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(result.activeWindow?.activityName).toBe("com.android.settings.Settings");
    expect(result.activeWindow?.appId).toBe("com.android.settings");
    // The correlated layoutSeqSum is preserved, NOT reset to the 0 sentinel: a
    // zero would make TapOnElement.compareActiveWindow treat a same-activity
    // content change as "unchanged" and mask it.
    expect(result.activeWindow?.layoutSeqSum).toBe(5120);
    // Temporal confirmation ran: the initial capture plus one recapture.
    expect(viewHierarchy.getCallCount()).toBe(2);
    expect(result.freshness?.verified).toBe(true);
  });

  test("does not stamp a later same-app backStack activity onto an earlier hierarchy when a recapture cannot confirm it (#6070)", async () => {
    // Temporal-skew guard: the hierarchy is captured for activity A
    // (SettingsHomepageActivity), but the back-stack read that follows reports a
    // *later* same-app activity B (SubSettings). Package equality cannot tell A
    // and B apart, so a blind backfill would confidently pair B onto A's tree. A
    // recapture that cannot confirm B (the fresh read is unusable) must leave the
    // name unknown and flag the mismatch, never publish B against A's hierarchy.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      {
        updatedAt: now,
        receivedAt: now,
        fresh: true,
        screenWidth: 1080,
        screenHeight: 2400,
        packageName: "com.android.settings",
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
            node: [
              { text: "Settings home", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
            ],
          },
        },
      },
      { hierarchy: { error: "CtrlProxy timed out" }, fresh: false },
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: emptyBootstrapWindow({
          appId: "com.android.settings",
          activityName: "",
          layoutSeqSum: 3478,
        }),
        backStack: {
          execute: async () => ({
            depth: 1,
            activities: [],
            tasks: [],
            // The later same-app activity, read after the A hierarchy was captured.
            currentActivity: { name: "com.android.settings.SubSettings", taskId: 14 },
            source: "adb",
          }),
        } as any,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    // The later activity B must NOT be stamped onto A's hierarchy; the name
    // stays unknown ("") and the divergence is surfaced as a mismatch.
    expect(result.activeWindow?.activityName).not.toBe("com.android.settings.SubSettings");
    expect(result.activeWindow?.activityName).toBe("");
    expect(result.freshness?.verified).toBe(false);
    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("disagree about the current activity");
    // The original A hierarchy is preserved (not replaced by an unusable recapture).
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Settings home");
    // Temporal confirmation was attempted: initial capture plus the recapture read.
    expect(viewHierarchy.getCallCount()).toBe(2);
  });

  // Issue #6088: on the bootstrap path the hierarchy carries no activity signal,
  // so a window read that AGREES with the back-stack read is not proof the
  // hierarchy is aligned with either: both adb reads can post-date a same-app
  // A->B navigation that the hierarchy pre-dates. The recapture must therefore
  // run whenever a back-stack attribution exists on the bootstrap path, not only
  // when the two adb reads disagree.
  const settingsHierarchy = (now: number, label: string) => ({
    updatedAt: now,
    receivedAt: now,
    fresh: true,
    screenWidth: 1080,
    screenHeight: 2400,
    packageName: "com.android.settings",
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [{ text: label, bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
      },
    },
  });

  const subSettingsBackStack = {
    execute: async () => ({
      depth: 1,
      activities: [],
      tasks: [],
      currentActivity: { name: "com.android.settings.SubSettings", taskId: 14 },
      source: "adb",
    }),
  } as any;

  test("does not publish an agreeing later same-app window/backStack activity onto an earlier hierarchy when the recapture cannot confirm it (#6088)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    // Hierarchy captured for activity A; the navigation A->B lands before the
    // back-stack and window reads, which therefore both report B and agree.
    viewHierarchy.configureHierarchySequence([
      settingsHierarchy(now, "Settings home"),
      { hierarchy: { error: "CtrlProxy timed out" }, fresh: false },
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: emptyBootstrapWindow({
          appId: "com.android.settings",
          activityName: "com.android.settings.SubSettings",
          layoutSeqSum: 3478,
        }),
        backStack: subSettingsBackStack,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    // Agreement between the two adb reads must not short-circuit the recapture.
    expect(viewHierarchy.getCallCount()).toBe(2);
    // B is not paired with A's tree: the name resolves to unknown and the
    // observation is retracted rather than confidently mis-attributed.
    expect(result.activeWindow?.activityName).toBe("");
    expect(result.activeWindow?.appId).toBe("com.android.settings");
    expect(result.freshness?.verified).toBe(false);
    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("disagree about the current activity");
    // The original A hierarchy is preserved (not replaced by an unusable recapture).
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Settings home");
  });

  test("resolves a genuine bootstrap A->B skew to B's fresh hierarchy when the recapture confirms it (#6088)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      settingsHierarchy(now, "Settings home"),
      settingsHierarchy(now + 50, "Sub settings"),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: emptyBootstrapWindow({
          appId: "com.android.settings",
          activityName: "com.android.settings.SubSettings",
          layoutSeqSum: 3478,
        }),
        backStack: subSettingsBackStack,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(viewHierarchy.getCallCount()).toBe(2);
    // The published tree is the recaptured B tree, paired with B's name.
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Sub settings");
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
    expect(result.activeWindow?.layoutSeqSum).toBe(3478);
    expect(result.freshness?.verified).toBe(true);
    expect(result.freshness?.isFresh).toBe(true);
  });

  test("does not over-retract a stable bootstrap observation whose window and backStack agree (#6088)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    // Stable device: every read returns the same fresh B hierarchy.
    viewHierarchy.configureHierarchy(settingsHierarchy(now, "Sub settings") as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: emptyBootstrapWindow({
          appId: "com.android.settings",
          activityName: "com.android.settings.SubSettings",
          layoutSeqSum: 5120,
        }),
        backStack: subSettingsBackStack,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    // The recapture ran (bootstrap path + back-stack present) and confirmed.
    expect(viewHierarchy.getCallCount()).toBe(2);
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
    expect(result.activeWindow?.appId).toBe("com.android.settings");
    expect(result.activeWindow?.layoutSeqSum).toBe(5120);
    expect(result.freshness?.verified).toBe(true);
    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.warning).toBeUndefined();
  });
});

/**
 * Issue #6078: while the notification shade (or another focused SystemUI
 * surface) is open, `observe` returns the shade's hierarchy but composes
 * `activeWindow` from the accessibility `foregroundActivity` / `getForegroundApp`
 * — both of which name the app occluded *behind* the shade, never the focused
 * surface. `waitFor.activeWindow.appId == <occluded app>` therefore
 * false-positives while the shade fully covers the app, and on API 29 the single
 * object even names two different apps.
 *
 * The fix reconciles against the focused window: when a SystemUI surface owns
 * focus, `activeWindow.appId` mirrors `com.android.systemui`, `activityName` is
 * cleared, and `systemOverlay: true` is set so callers can fail closed.
 */
describe("ObserveScreen focused SystemUI overlay attribution (issue #6078)", () => {
  afterEach(() => {
    resetObserveCacheStore();
  });

  const OCCLUDED_APP = "com.google.android.settings.intelligence";
  const OCCLUDED_ACTIVITY = `${OCCLUDED_APP}/${OCCLUDED_APP}.modules.search.SearchActivity`;

  /**
   * A full-screen expanded-shade capture: the returned hierarchy is the shade's
   * (quick-settings tiles), while CtrlProxy still reports the occluded app in
   * `foregroundActivity` and `packageName` — the exact incoherence #6078 hits on
   * API 31/34/35. `windows` describes what the accessibility window list carries.
   */
  function shadeHierarchy(
    now: number,
    windows: any[],
    overrides: { packageName?: string; foregroundActivity?: string } = {},
  ): any {
    return {
      updatedAt: now,
      receivedAt: now,
      fresh: true,
      screenWidth: 1080,
      screenHeight: 2400,
      packageName: overrides.packageName ?? OCCLUDED_APP,
      foregroundActivity: overrides.foregroundActivity ?? OCCLUDED_ACTIVITY,
      windows,
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            { text: "Silent", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
            { text: "Clear all", bounds: { left: 0, top: 200, right: 200, bottom: 260 } },
          ],
        },
      },
    };
  }

  const focusedShadeWindow = () => ({
    packageName: "com.android.systemui",
    type: 3,
    isFocused: true,
    windowLayer: 200,
    bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
  });

  const occludedAppWindow = (isFocused: boolean) => ({
    packageName: OCCLUDED_APP,
    type: 1,
    isFocused,
    windowLayer: 10,
    bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
  });

  // The status bar always exists as a SystemUI window but does not own focus
  // when the shade is collapsed — the reviewer edge the fix must not mis-mirror.
  const statusBarWindow = () => ({
    packageName: "com.android.systemui",
    type: 3,
    isFocused: false,
    windowLayer: 150,
    bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
  });

  function makeOverlayScreen(
    viewHierarchy: FakeViewHierarchy,
    fakeAdb: FakeAdbExecutor,
    timer: FakeTimer,
  ): RealObserveScreen {
    return new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );
  }

  for (const api of [31, 34, 35]) {
    test(`API ${api}: focused shade window mirrors com.android.systemui and sets systemOverlay`, async () => {
      const now = 1_700_000_000_000;
      const timer = new FakeTimer();
      timer.setCurrentTime(now);

      const viewHierarchy = new FakeViewHierarchy();
      viewHierarchy.configureHierarchy(
        shadeHierarchy(now, [focusedShadeWindow(), occludedAppWindow(false)]),
      );

      const fakeAdb = new FakeAdbExecutor();
      // dumpsys resumed/focused activity still names the occluded app.
      fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });

      const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
      const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

      // waitFor.activeWindow.appId == <occluded app> must fail closed.
      expect(result.activeWindow?.appId).toBe("com.android.systemui");
      expect(result.activeWindow?.appId).not.toBe(OCCLUDED_APP);
      expect(result.activeWindow?.systemOverlay).toBe(true);
      expect(result.activeWindow?.activityName).toBe("");
      // The shade capture is genuine — freshness stays verified.
      expect(result.freshness?.verified).toBe(true);
      expect(result.freshness?.isFresh).toBe(true);
    });
  }

  test("API 29: single activeWindow no longer names two different apps", async () => {
    // On API 29 CtrlProxy reports foregroundActivity with the systemui package
    // but the resumed activity behind it, so appId=systemui while activityName
    // names Settings — one object, two apps.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(
      shadeHierarchy(now, [focusedShadeWindow(), occludedAppWindow(false)], {
        packageName: "com.android.systemui",
        foregroundActivity:
          "com.android.systemui/com.android.settings.homepage.SettingsHomepageActivity",
      }),
    );

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    expect(result.activeWindow?.systemOverlay).toBe(true);
    // Must NOT publish the occluded app's activity — no two-app object.
    expect(result.activeWindow?.activityName).toBe("");
    expect(result.activeWindow?.activityName).not.toContain("com.android.settings");
  });

  test("adb mCurrentFocus fallback confirms overlay when windows[] carries no focus flag", async () => {
    // Some API levels do not populate isFocused on the accessibility window list.
    // The topmost window is SystemUI, so a dumpsys window read confirms the shade
    // owns focus.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)]),
    );

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });
    fakeAdb.setCommandResponse("dumpsys window", {
      stdout: "  mCurrentFocus=Window{8ddaeb2 u0 NotificationShade}\n",
      stderr: "",
      exitCode: 0,
    } as any);

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    expect(result.activeWindow?.systemOverlay).toBe(true);
    expect(result.activeWindow?.activityName).toBe("");
  });

  test("adb fallback: a package/activity mCurrentFocus (shade collapsed) is NOT an overlay", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)]),
    );

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });
    fakeAdb.setCommandResponse("dumpsys window", {
      stdout: `  mCurrentFocus=Window{1a2b3c u0 ${OCCLUDED_ACTIVITY}}\n`,
      stderr: "",
      exitCode: 0,
    } as any);

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    // The app owns focus — normal attribution, no overlay flag.
    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
  });

  test("shade closed: a focused app window keeps normal attribution and no overlay flag", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(
      shadeHierarchy(now, [occludedAppWindow(true), statusBarWindow()]),
    );

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
    // A focused app window must not trigger the adb ground-truth read.
    expect(fakeAdb.getExecutedCommands().some((c) => c.includes("dumpsys window"))).toBe(false);
  });

  test("a thin status-bar SystemUI window with no focus flags does not trigger an adb read", async () => {
    // Perf guard: when no window carries isFocused, the ever-present status bar
    // (SystemUI, high layer, but thin) must NOT be treated as an occluding
    // overlay — otherwise every observe on that API level pays a dumpsys read.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const thinStatusBar = {
      packageName: "com.android.systemui",
      type: 3,
      isFocused: undefined,
      windowLayer: 300,
      bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
    };
    const appWindow = { ...occludedAppWindow(false), isFocused: undefined };

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(shadeHierarchy(now, [thinStatusBar, appWindow]));

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
    expect(fakeAdb.getExecutedCommands().some((c) => c.includes("dumpsys window"))).toBe(false);
  });

  test("iOS: a focused TYPE_SYSTEM window never stamps an Android systemui appId", async () => {
    // iOS reuses the ViewHierarchyWindowInfo shape. The overlay branch is an
    // Android concept and must be platform-gated so it cannot mirror
    // com.android.systemui onto an iOS observation.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const iosDevice: BootedDevice = {
      deviceId: "SIM-1",
      name: "iPhone 15",
      platform: "ios",
    };

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy({
      updatedAt: now,
      receivedAt: now,
      fresh: true,
      screenWidth: 393,
      screenHeight: 852,
      packageName: "com.example.iosapp",
      windows: [{ packageName: "com.example.iosapp", type: 3, isFocused: true, windowLayer: 200 }],
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 393, bottom: 852 },
          node: [{ text: "Home" }],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    const screen = new RealObserveScreen(
      iosDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe("com.example.iosapp");
    expect(result.activeWindow?.appId).not.toBe("com.android.systemui");
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
  });

  test("a present-but-unfocused status bar does not mirror when the app owns focus", async () => {
    // The status bar (SystemUI, type 3) is always present. It must never be
    // mistaken for a focus-owning overlay when an app window is focused.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(
      // Status bar has the higher layer but the app window carries focus.
      shadeHierarchy(now, [statusBarWindow(), occludedAppWindow(true)]),
    );

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
    expect(fakeAdb.getExecutedCommands().some((c) => c.includes("dumpsys window"))).toBe(false);
  });
});
