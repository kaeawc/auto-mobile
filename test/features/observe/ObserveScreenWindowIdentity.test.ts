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
    // The recapture still demands a tree newer than the initial capture (the
    // cache is rejected) but skips the WebSocket fresh wait and goes straight
    // to sync, so a static screen does not burn the full wait (#6099).
    expect(viewHierarchy.getCalls()[1]).toEqual({ skipWaitForFresh: true, minTimestamp: now + 1 });
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
    // Note this fixture is indistinguishable from a STABLE screen whose
    // recapture fails: the code cannot tell the two apart, and tolerating a
    // failed recapture on agreement would reinstate the #6088 skew, so the
    // honest verdict for both is unknown + retracted.
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

  test("confirms a stable bootstrap observation through the recapture without retracting freshness (#6088)", async () => {
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

  test("mirrors a SystemUI surface that takes focus during the bootstrap recapture instead of the app beneath it (#6088)", async () => {
    // The focused-SystemUI check (#6078) runs before the recapture. When the
    // shade takes focus mid-recapture, the replacement tree still carries the
    // occluded app's package, so the package and back-stack checks accept it;
    // the overlay reconciliation must run again on the installed tree.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    const shadeOverSettings = {
      ...settingsHierarchy(now + 50, "Notifications"),
      windows: [
        {
          packageName: "com.android.systemui",
          type: 3,
          isFocused: true,
          windowLayer: 200,
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        },
        {
          packageName: "com.android.settings",
          type: 1,
          isFocused: false,
          windowLayer: 10,
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        },
      ],
    };
    viewHierarchy.configureHierarchySequence([
      settingsHierarchy(now, "Sub settings"),
      shadeOverSettings,
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

    expect(viewHierarchy.getCallCount()).toBe(2);
    // The published tree is the recaptured shade tree...
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Notifications");
    // ...and the window names the surface on top, never the occluded app's activity.
    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    expect(result.activeWindow?.activityName).toBe("");
    expect(result.activeWindow?.systemOverlay).toBe(true);
  });

  // Issue #6100: side samples taken BEFORE the recapture (device lock, the
  // bootstrap window's layoutSeqSum) must not be published against the
  // replacement tree. An accepted recapture re-reads both; the non-recapture
  // path pays no extra device reads.
  const keyguardOverSettings = (now: number) => ({
    ...settingsHierarchy(now + 50, "Swipe up to unlock"),
    windows: [
      {
        packageName: "com.android.systemui",
        type: 3,
        isFocused: true,
        windowLayer: 200,
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
      },
    ],
  });

  // Each window read records the number of hierarchy reads that preceded it,
  // so a test can prove the re-read happened AFTER the recapture.
  const countingBootstrapWindow = (sequence: number[], viewHierarchy?: FakeViewHierarchy) => {
    const reads: number[] = [];
    const hierarchyReadsBefore: number[] = [];
    const window = {
      getActive: async () => {
        const layoutSeqSum = sequence[Math.min(reads.length, sequence.length - 1)] ?? 0;
        reads.push(layoutSeqSum);
        hierarchyReadsBefore.push(viewHierarchy?.getCallCount() ?? 0);
        if (layoutSeqSum === 0) {
          // The production Window.getActive failure shape: a sentinel, not a throw.
          return { appId: "", activityName: "", layoutSeqSum: 0 };
        }
        return {
          appId: "com.android.settings",
          activityName: "com.android.settings.SubSettings",
          layoutSeqSum,
        };
      },
      getActiveHash: async () => "hash",
      getCachedActiveWindow: async () => null,
      setCachedActiveWindow: async () => undefined,
      clearCache: async () => undefined,
    } as any;
    return { window, reads, hierarchyReadsBefore };
  };

  test("re-collects device lock state when the recapture accepts a keyguard tree (#6100)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      settingsHierarchy(now, "Sub settings"),
      keyguardOverSettings(now),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    // Unlocked at the original capture; locked by the time the recapture lands.
    fakeAdb.setDeviceLockSequence([
      { locked: false, keyguardShowing: false, secure: false },
      { locked: true, keyguardShowing: true, secure: true },
    ]);

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

    expect(viewHierarchy.getCallCount()).toBe(2);
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Swipe up to unlock");
    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    expect(result.deviceLock?.locked).toBe(true);
    expect(result.deviceLock?.keyguardShowing).toBe(true);
  });

  test("pairs an accepted bootstrap recapture with a post-recapture layoutSeqSum (#6100)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(settingsHierarchy(now, "Sub settings") as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    fakeAdb.setDeviceLock({ locked: false, keyguardShowing: false, secure: false });

    // A same-activity layout pass completes during the recapture: the window
    // read before it reports 5120, the one after it 5121.
    const { window, reads, hierarchyReadsBefore } = countingBootstrapWindow(
      [5120, 5121],
      viewHierarchy,
    );
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window,
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
    expect(reads).toEqual([5120, 5121]);
    // The first window read precedes the recapture (one hierarchy read so far);
    // the second follows it (two hierarchy reads), so the published sequence is
    // the one correlated with the accepted tree.
    expect(hierarchyReadsBefore).toEqual([1, 2]);
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
    expect(result.activeWindow?.layoutSeqSum).toBe(5121);
    expect(result.freshness?.verified).toBe(true);
  });

  test("keeps the earlier correlated layoutSeqSum when the post-recapture window read fails (#6100)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(settingsHierarchy(now, "Sub settings") as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    fakeAdb.setDeviceLock({ locked: false, keyguardShowing: false, secure: false });

    // The re-read returns the production failure shape (zero sentinel).
    const { window, reads } = countingBootstrapWindow([5120, 0], viewHierarchy);
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window,
        backStack: subSettingsBackStack,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(reads).toEqual([5120, 0]);
    // Never the zero sentinel: it would blind tap-effect detection (#6070).
    expect(result.activeWindow?.layoutSeqSum).toBe(5120);
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
    expect(result.freshness?.verified).toBe(true);
  });

  test("adopts the post-recapture layoutSeqSum when the window reports the activity in dumpsys shorthand (#6100)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(settingsHierarchy(now, "Sub settings") as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    fakeAdb.setDeviceLock({ locked: false, keyguardShowing: false, secure: false });

    // `dumpsys window` names an in-package activity as `pkg/.Activity`; the
    // Window parser keeps the shorthand while the back stack expands it.
    let windowReads = 0;
    const window = {
      getActive: async () => {
        windowReads += 1;
        return {
          appId: "com.android.settings",
          activityName: ".SubSettings",
          layoutSeqSum: windowReads === 1 ? 5120 : 5121,
        };
      },
      getActiveHash: async () => "hash",
      getCachedActiveWindow: async () => null,
      setCachedActiveWindow: async () => undefined,
      clearCache: async () => undefined,
    } as any;
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window,
        backStack: subSettingsBackStack,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(windowReads).toBe(2);
    expect(result.activeWindow?.layoutSeqSum).toBe(5121);
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
  });

  test("keeps the earlier correlated layoutSeqSum when the post-recapture window names a different activity (#6100)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(settingsHierarchy(now, "Sub settings") as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    fakeAdb.setDeviceLock({ locked: false, keyguardShowing: false, secure: false });

    // A navigation lands between the back-stack confirmation and the window
    // re-read: the second read names the NEXT activity with a newer sequence.
    let windowReads = 0;
    const window = {
      getActive: async () => {
        windowReads += 1;
        return windowReads === 1
          ? {
              appId: "com.android.settings",
              activityName: "com.android.settings.SubSettings",
              layoutSeqSum: 5120,
            }
          : {
              appId: "com.android.settings",
              activityName: "com.android.settings.DeviceInfoSettings",
              layoutSeqSum: 5400,
            };
      },
      getActiveHash: async () => "hash",
      getCachedActiveWindow: async () => null,
      setCachedActiveWindow: async () => undefined,
      clearCache: async () => undefined,
    } as any;
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window,
        backStack: subSettingsBackStack,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(windowReads).toBe(2);
    // The next screen's sequence is not grafted onto the confirmed tree.
    expect(result.activeWindow?.layoutSeqSum).toBe(5120);
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
  });

  test("does not re-read the window on a non-bootstrap recapture (#6100)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    // The accessibility service names a stale activity that disagrees with the
    // back stack, so the #5992 recapture runs — but the window's layoutSeqSum
    // is the accessibility-path zero, and there is nothing to refresh.
    viewHierarchy.configureHierarchy({
      ...settingsHierarchy(now, "Sub settings"),
      foregroundActivity: "com.android.settings/.Settings",
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    fakeAdb.setDeviceLock({ locked: false, keyguardShowing: false, secure: false });

    const { window, reads } = countingBootstrapWindow([9000], viewHierarchy);
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window,
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
    expect(reads).toEqual([]);
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
    expect(result.activeWindow?.layoutSeqSum).toBe(0);
  });

  test("reports device lock as unknown when the post-recapture lock read fails (#6100)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      settingsHierarchy(now, "Sub settings"),
      keyguardOverSettings(now),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    // Unlocked at the original capture; the confirming re-read yields nothing.
    fakeAdb.setDeviceLockSequence([{ locked: false, keyguardShowing: false, secure: false }, null]);

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

    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    // The stale pre-recapture "unlocked" sample is not published as fact.
    expect(result.deviceLock).toBeUndefined();
  });

  test("adds no device reads on the non-recapture path (#6100)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    // The accessibility service names the activity, and it agrees with the
    // back stack: no recapture, so no second lock read and no window read.
    viewHierarchy.configureHierarchy({
      ...settingsHierarchy(now, "Sub settings"),
      foregroundActivity: "com.android.settings/.SubSettings",
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    fakeAdb.setDeviceLockSequence([
      { locked: false, keyguardShowing: false, secure: false },
      { locked: true, keyguardShowing: true, secure: true },
    ]);

    const { window, reads } = countingBootstrapWindow([9000]);
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window,
        backStack: subSettingsBackStack,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(viewHierarchy.getCallCount()).toBe(1);
    expect(reads).toEqual([]);
    expect(result.deviceLock?.locked).toBe(false);
    expect(result.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
  });

  test("surfaces a failed confirming back-stack read on the retracted result (#6088)", async () => {
    // The bootstrap recapture now runs on every agreeing observation, so an adb
    // hiccup on the confirming back-stack read retracts a stable observation.
    // The cause must reach `result.errors` so the retraction is diagnosable.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(settingsHierarchy(now, "Sub settings") as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });

    let backStackReads = 0;
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
        backStack: {
          execute: async () => {
            backStackReads += 1;
            if (backStackReads > 1) {
              throw new Error("adb: device offline");
            }
            return {
              depth: 1,
              activities: [],
              tasks: [],
              currentActivity: { name: "com.android.settings.SubSettings", taskId: 14 },
              source: "adb",
            };
          },
        } as any,
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true });

    expect(backStackReads).toBe(2);
    expect(result.activeWindow?.activityName).toBe("");
    expect(result.freshness?.verified).toBe(false);
    const backStackErrors = (result.errors ?? []).filter((e) => e.phase === "backStack");
    expect(backStackErrors.length).toBeGreaterThan(0);
    expect(backStackErrors[0]?.cause).toContain("device offline");
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

  // Issue #6091: the adb `mCurrentFocus` fallback read is not atomic with the
  // hierarchy capture, so a shade transition inside that interval can pair a
  // stale hierarchy with the wrong attribution. The fallback (topmost-suspect,
  // no `isFocused` flag) therefore recaptures the hierarchy and re-classifies so
  // the published tree and the overlay attribution are sampled together.
  const appContentHierarchy = (now: number): any => ({
    updatedAt: now,
    receivedAt: now,
    fresh: true,
    screenWidth: 1080,
    screenHeight: 2400,
    packageName: OCCLUDED_APP,
    foregroundActivity: OCCLUDED_ACTIVITY,
    // Topmost window is the app itself: the shade is gone, so classification is
    // "none" (no overlay) with no further adb read.
    windows: [
      {
        packageName: OCCLUDED_APP,
        type: 1,
        isFocused: true,
        windowLayer: 200,
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
      },
    ],
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [{ text: "App content", bounds: { left: 0, top: 300, right: 400, bottom: 360 } }],
      },
    },
  });

  test("fallback path: shade closes between capture and focus read — recapture drops the overlay and publishes the fresh app tree (#6091)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    // No isFocused flag on this API level: topmost SystemUI surface is a suspect
    // that reaches the adb fallback. The recapture returns the app tree (the
    // shade closed in the interval).
    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)]),
      appContentHierarchy(now + 25),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });
    // If the code still read mCurrentFocus against the stale shade tree, this
    // would confirm the (already-gone) shade. It must not be trusted.
    fakeAdb.setCommandResponse("dumpsys window", {
      stdout: "  mCurrentFocus=Window{8ddaeb2 u0 NotificationShade}\n",
      stderr: "",
      exitCode: 0,
    } as any);

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    // The recapture ran (initial capture + one recapture).
    expect(viewHierarchy.getCallCount()).toBe(2);
    // The published tree is the fresh app tree, not the stale shade.
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("App content");
    // Attribution agrees with the fresh tree: the app, not a SystemUI overlay.
    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
    expect(result.freshness?.verified).toBe(true);
    expect(result.freshness?.isFresh).toBe(true);
  });

  test("fallback path: shade genuinely up — recapture yields a fresh shade tree and the overlay is mirrored (#6091)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    // Both captures are the shade; the recapture is a fresher shade tree with a
    // distinct marker so the test can prove the published tree is the recapture.
    const staleShade = shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)]);
    staleShade.hierarchy.node.node = [
      { text: "Stale shade", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
    ];
    const freshShade = shadeHierarchy(now + 25, [unfocusedShade, occludedAppWindow(false)]);
    freshShade.hierarchy.node.node = [
      { text: "Fresh shade", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
    ];
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([staleShade, freshShade] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });
    fakeAdb.setCommandResponse("dumpsys window", {
      stdout: "  mCurrentFocus=Window{8ddaeb2 u0 NotificationShade}\n",
      stderr: "",
      exitCode: 0,
    } as any);

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(viewHierarchy.getCallCount()).toBe(2);
    // The published shade tree is the recaptured one, paired with the overlay.
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Fresh shade");
    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    expect(result.activeWindow?.systemOverlay).toBe(true);
    expect(result.activeWindow?.activityName).toBe("");
  });

  test("fallback path: re-reads device lock when the recapture accepts a keyguard tree (#6091, #6100 seam)", async () => {
    // A keyguard that appears during the fallback recapture must not be published
    // with the pre-capture "unlocked" sample: the overlay recapture replaces the
    // tree, so the lock sample is re-read paired with the replacement tree.
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    const keyguardTree = shadeHierarchy(now + 25, [unfocusedShade, occludedAppWindow(false)]);
    keyguardTree.hierarchy.node.node = [
      { text: "Swipe up to unlock", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
    ];
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)]),
      keyguardTree,
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });
    // Unlocked at the original capture; locked by the time the recapture lands.
    fakeAdb.setDeviceLockSequence([
      { locked: false, keyguardShowing: false, secure: false },
      { locked: true, keyguardShowing: true, secure: true },
    ]);
    fakeAdb.setCommandResponse("dumpsys window", {
      stdout: "  mCurrentFocus=Window{8ddaeb2 u0 Keyguard}\n",
      stderr: "",
      exitCode: 0,
    } as any);

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(viewHierarchy.getCallCount()).toBe(2);
    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    expect(result.activeWindow?.systemOverlay).toBe(true);
    // The lock state published is the post-recapture read, not the stale sample.
    expect(result.deviceLock?.locked).toBe(true);
    expect(result.deviceLock?.keyguardShowing).toBe(true);
  });

  test("primary (isFocused) path never recaptures — the race-free signal is trusted as captured (#6091)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    // A different tree is queued as the (would-be) recapture; it must never be
    // consumed, because the primary isFocused path takes no adb round-trip.
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      shadeHierarchy(now, [focusedShadeWindow(), occludedAppWindow(false)]),
      appContentHierarchy(now + 25),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    // No recapture on the primary path.
    expect(viewHierarchy.getCallCount()).toBe(1);
    expect(result.activeWindow?.appId).toBe("com.android.systemui");
    expect(result.activeWindow?.systemOverlay).toBe(true);
    // No adb dumpsys read either — the captured windows[] carried the flag.
    expect(fakeAdb.getExecutedCommands().some((c) => c.includes("dumpsys window"))).toBe(false);
  });

  // Issue #6108: after the SystemUI-overlay fallback recapture replaces the tree,
  // the dependent side samples (`activeWindow.layoutSeqSum`, `activeWindow`
  // activity) and the focus read must be re-correlated against the fresh tree so
  // the published observation never pairs a fresh hierarchy with stale
  // attribution. These drive the fallback (topmost-suspect, no `isFocused`) path.

  const appTreeWithActivity = (now: number, foregroundActivity: string, marker: string): any => ({
    updatedAt: now,
    receivedAt: now,
    fresh: true,
    screenWidth: 1080,
    screenHeight: 2400,
    packageName: OCCLUDED_APP,
    foregroundActivity,
    // App window focused: classification is "none" (no overlay), no adb read.
    windows: [
      {
        packageName: OCCLUDED_APP,
        type: 1,
        isFocused: true,
        windowLayer: 200,
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
      },
    ],
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [{ text: marker, bounds: { left: 0, top: 300, right: 400, bottom: 360 } }],
      },
    },
  });

  const bootstrapWindow = (activeWindow: {
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

  test("gap 1: shade closes to the same app — the stale bootstrap layoutSeqSum is reset against the fresh tree (#6108)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    // The captured shade tree names no usable activity (a framework View class),
    // so the bootstrap Window.getActive() read supplies activeWindow — with a
    // non-zero layoutSeqSum sampled against the shade-era window read.
    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)], {
        foregroundActivity: `${OCCLUDED_APP}/android.widget.FrameLayout`,
      }),
      // Recapture: the shade closed, so the fresh tree is the underlying app.
      appTreeWithActivity(now + 25, OCCLUDED_ACTIVITY, "App content"),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: bootstrapWindow({
          appId: OCCLUDED_APP,
          activityName: OCCLUDED_ACTIVITY,
          // A stale sequence sampled with the pre-recapture (shade-era) window read.
          layoutSeqSum: 4096,
        }),
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    // The recapture ran and the fresh app tree is published, no overlay.
    expect(viewHierarchy.getCallCount()).toBe(2);
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("App content");
    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
    // The stale 4096 sampled with the shade window read must NOT be published
    // against the fresh app tree: re-correlated to the accessibility zero.
    expect(result.activeWindow?.layoutSeqSum).toBe(0);
  });

  const appTreeForPackage = (
    now: number,
    packageName: string,
    foregroundActivity: string,
    marker: string,
  ): any => ({
    updatedAt: now,
    receivedAt: now,
    fresh: true,
    screenWidth: 1080,
    screenHeight: 2400,
    packageName,
    foregroundActivity,
    windows: [
      {
        packageName,
        type: 1,
        isFocused: true,
        windowLayer: 200,
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
      },
    ],
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [{ text: marker, bounds: { left: 0, top: 300, right: 400, bottom: 360 } }],
      },
    },
  });

  // Bug 1 (#6108 review): the caller-local window `reconcileActiveWindowAttribution`
  // captured BEFORE the overlay recapture must not be reused after it. When a
  // suspect shade attributed to app A closes onto a DIFFERENT app B during the
  // recapture, the overlay path re-derives `result.activeWindow` to B, but a
  // pre-await local (A) drove the cross-package branch — spreading A's stale
  // window (its non-zero layoutSeqSum) and erasing the re-derivation.
  test("bug 1: cross-package shade A closes onto app B — the cross-package reconcile does not re-publish A's stale window (#6108)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const APP_B = "com.example.appb";
    // Suspect shade attributed to app A, no usable activity -> bootstrap window
    // supplies A's identity with a non-zero (shade-era) layoutSeqSum.
    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)], {
        foregroundActivity: `${OCCLUDED_APP}/android.widget.FrameLayout`,
      }),
      // Recapture: the shade closed onto a DIFFERENT app B.
      appTreeForPackage(now + 25, APP_B, `${APP_B}/${APP_B}.MainActivity`, "App B content"),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    // Ground truth agrees with the fresh tree (B): on the buggy path this drives
    // the cross-package branch that spreads A's stale window.
    fakeAdb.setForegroundApp({ packageName: APP_B, userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: bootstrapWindow({
          appId: OCCLUDED_APP,
          activityName: `${OCCLUDED_APP}.modules.search.SearchActivity`,
          layoutSeqSum: 7000,
        }),
        cacheStore: new FakeObserveCacheStore(timer),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(viewHierarchy.getCallCount()).toBe(2);
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("App B content");
    // Published window is B's re-derived identity, NOT A's stale window with only
    // the appId swapped: A's 7000 must not survive onto the fresh B tree.
    expect(result.activeWindow?.appId).toBe(APP_B);
    expect(result.activeWindow?.layoutSeqSum).toBe(0);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
  });

  // Bug 2 (#6108 review): CtrlProxy's `foregroundActivity` can lag the tree it is
  // attached to. On a same-app A->B transition the fresh recapture describes B
  // while `foregroundActivity` still names A, so trusting it stamps a
  // confidently-wrong activity. After a recapture the activity is UNKNOWN unless
  // independently confirmed (a back stack, absent here under skipBackStack).
  test("bug 2: same-app A->B with foregroundActivity lagging to A — the recaptured activity is unknown, not stale A (#6108)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const activityA = `${OCCLUDED_APP}.modules.search.SearchActivity`;
    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      // Captured shade names activity A (same package).
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)]),
      // Recapture: the tree is B ("Screen B") but foregroundActivity still lags to A.
      appTreeForPackage(now + 25, OCCLUDED_APP, `${OCCLUDED_APP}/${activityA}`, "Screen B"),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(viewHierarchy.getCallCount()).toBe(2);
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Screen B");
    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
    // The lagged foregroundActivity A must NOT be published against the B tree.
    expect(result.activeWindow?.activityName).toBe("");
    expect(result.activeWindow?.activityName).not.toBe(activityA);
  });

  // Bug 3 (#6108 review): a back stack sampled with the pre-recapture screen A
  // must not be published against a recaptured screen B. The bounded gap-2 second
  // recapture lands on same-package activity B while `backStack` still describes
  // A; a stale back stack that still agrees with a stale window would let
  // reconcileAgainstBackStack skip confirmation and record A's depth/task.
  test("bug 3: a bounded re-capture lands on same-package B — the stale backStack sampled at A is dropped to unknown (#6108)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const activityA = `${OCCLUDED_APP}.modules.search.SearchActivity`;
    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    // Capture: suspect shade. Recapture #1: still a suspect shade. The focus read
    // then names the app (disagreement) -> bounded recapture #2 lands app B.
    const freshShade = shadeHierarchy(now + 25, [unfocusedShade, occludedAppWindow(false)]);
    freshShade.hierarchy.node.node = [
      { text: "Fresh shade", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
    ];
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)]),
      freshShade,
      appTreeForPackage(
        now + 50,
        OCCLUDED_APP,
        `${OCCLUDED_APP}/${OCCLUDED_APP}.modules.details.DetailsActivity`,
        "Details B",
      ),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });
    fakeAdb.setCommandResponse("dumpsys window", {
      stdout: `  mCurrentFocus=Window{1a2b3c u0 ${OCCLUDED_ACTIVITY}}\n`,
      stderr: "",
      exitCode: 0,
    } as any);

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        // Back stack sampled with the pre-recapture screen A.
        backStack: {
          execute: async () => ({
            depth: 3,
            activities: [],
            tasks: [{ id: 14, packageName: OCCLUDED_APP }],
            currentActivity: { name: activityA, taskId: 14 },
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

    // NOTE: backStack is collected (skipBackStack NOT set) so it can go stale.
    const result = await screen.execute({ skipScreenshot: true });

    // Initial capture + suspect recapture + the bounded re-capture.
    expect(viewHierarchy.getCallCount()).toBe(3);
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("Details B");
    // The back stack sampled at A must not be published against B's tree: it is
    // dropped to unknown rather than recording A's depth/task against B's node.
    expect(result.backStack).toBeUndefined();
    // And the activity is not the stale A (it is unknown here).
    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.activityName).not.toBe(activityA);
  });

  test("gap 2: shade closes during the focus dumpsys — a bounded re-capture converges on the app tree, no confidently-wrong overlay (#6108)", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const unfocusedShade = { ...focusedShadeWindow(), isFocused: undefined };
    // Capture: shade suspect. First recapture: shade STILL up (suspect). The adb
    // focus read then returns an app (the shade closed while dumpsys ran) —
    // disagreement. The bounded re-capture lands the fresh app tree.
    const freshShade = shadeHierarchy(now + 25, [unfocusedShade, occludedAppWindow(false)]);
    freshShade.hierarchy.node.node = [
      { text: "Fresh shade", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
    ];
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchySequence([
      shadeHierarchy(now, [unfocusedShade, occludedAppWindow(false)]),
      freshShade,
      appTreeWithActivity(now + 50, OCCLUDED_ACTIVITY, "App content"),
    ] as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: OCCLUDED_APP, userId: 0 });
    // mCurrentFocus names the app: the shade closed during the dumpsys read.
    fakeAdb.setCommandResponse("dumpsys window", {
      stdout: `  mCurrentFocus=Window{1a2b3c u0 ${OCCLUDED_ACTIVITY}}\n`,
      stderr: "",
      exitCode: 0,
    } as any);

    const screen = makeOverlayScreen(viewHierarchy, fakeAdb, timer);
    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    // Initial capture + first recapture + the bounded re-capture.
    expect(viewHierarchy.getCallCount()).toBe(3);
    // The published tree is the converged app tree, NOT the fresh shade paired
    // with the app's attribution (the #6091 gap-2 incoherence).
    expect(result.viewHierarchy?.hierarchy.node.node?.[0]?.text).toBe("App content");
    expect(result.activeWindow?.appId).toBe(OCCLUDED_APP);
    expect(result.activeWindow?.systemOverlay).toBeUndefined();
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
