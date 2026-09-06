/**
 * Issue #6220: `observe` could stamp `freshness.verified/isFresh: true` on a
 * hierarchy that carries NO foreground application window at all —
 * `activeWindow.appId` empty, content confined to `com.android.systemui`
 * status-bar nodes — even when the async, device-confirmed window-identity
 * gate (issue #5867/#6151) cannot fire because the ground-truth foreground
 * read itself came back empty. This is the synchronous backstop: derived
 * entirely from the observation already in hand, no device round-trip needed.
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

const noOpWindow = (appId: string) => ({
  getActive: async () => ({ appId, activityName: "", layoutSeqSum: 0 }),
  getActiveHash: async () => "hash",
  getCachedActiveWindow: async () => null,
  setCachedActiveWindow: async () => undefined,
  clearCache: async () => undefined,
});

describe("ObserveScreen missing-foreground-window freshness (issue #6220)", () => {
  afterEach(() => {
    resetObserveCacheStore();
  });

  test("retracts freshness for a status-bar-only hierarchy with no foreground window, even without a ground-truth foreground read", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    // The exact #6220 repro shape: only com.android.systemui status-bar nodes,
    // no packageName/foregroundActivity the accessibility path can attribute.
    viewHierarchy.configureHierarchy({
      updatedAt: now,
      receivedAt: now,
      fresh: true,
      screenWidth: 1080,
      screenHeight: 2400,
      systemInsets: { top: 63, right: 0, bottom: 0, left: 0 },
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
          node: [
            {
              "resource-id": "com.android.systemui:id/clock",
              text: "8:33",
              bounds: { left: 21, top: 0, right: 107, bottom: 63 },
            },
          ],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    // getForegroundApp returns null (default): the async, device-confirmed
    // gate cannot fire without ground truth. The synchronous check must still
    // catch this from the observation alone.

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: noOpWindow(""),
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe("");
    expect(result.freshness?.verified).toBe(false);
    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("foreground application window");
  });

  test("does not retract freshness for a normal capture with a real foreground app", async () => {
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
      packageName: "com.google.android.deskclock",
      foregroundActivity: "com.google.android.deskclock/.DeskClock",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [{ text: "Add alarm", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.google.android.deskclock", userId: 0 });

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

    expect(result.activeWindow?.appId).toBe("com.google.android.deskclock");
    expect(result.freshness?.verified).toBe(true);
    expect(result.freshness?.isFresh).toBe(true);
  });

  // Regression (P1 review finding on #6239): a READABLE hierarchy carrying a
  // real `viewHierarchy.packageName` but no usable `foregroundActivity` used to
  // be reported as having no foreground window at all. The accessibility path
  // never sets `activeWindow` in this shape, so the legacy `Window.getActive()`
  // fallback runs and, on failure, returns its normal TRUTHY sentinel
  // (`{appId:"", ...}`) — which must not (a) block the package-name fallback
  // from running, nor (b) itself be read as "no foreground window" by the new
  // #6220 predicate. A package-attributed capture must stay verified/fresh.
  test("a package-attributed hierarchy with no usable foregroundActivity stays verified/isFresh:true", async () => {
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
      // Real package attribution, but no usable foregroundActivity: the
      // accessibility path leaves `activeWindow` unset, so the legacy Window
      // query (mocked below to fail) and then the package-name fallback run.
      packageName: "com.google.android.deskclock",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [{ text: "Add alarm", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.google.android.deskclock", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        // The legacy Window query's normal failure sentinel: a TRUTHY object
        // with an empty appId, not `undefined`/`null`.
        window: noOpWindow(""),
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBe("com.google.android.deskclock");
    expect(result.freshness?.verified).toBe(true);
    expect(result.freshness?.isFresh).toBe(true);
  });

  // Regression (P2 review finding on #6239): a hierarchy that carries a valid
  // `foregroundActivity` but lacks `packageName` AND screen dimensions used to
  // be reported as having no foreground window at all. `collectAllData` only
  // derives `activeWindow` from `foregroundActivity` inside the
  // dimensions-present branch, so without dimensions `activeWindow` is never
  // set; the legacy Window fallback then returns its empty-appId sentinel, and
  // (before this fix) the missing-foreground predicate ignored the remaining
  // `foregroundActivity` signal entirely. A capture that names a real activity
  // must stay verified/fresh regardless of whether `activeWindow` got derived.
  test("a hierarchy with a valid foregroundActivity but no packageName/dimensions stays verified/isFresh:true", async () => {
    const now = 1_700_000_000_000;
    const timer = new FakeTimer();
    timer.setCurrentTime(now);

    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy({
      updatedAt: now,
      receivedAt: now,
      fresh: true,
      // No screenWidth/screenHeight: the dimensions-present branch that would
      // derive `activeWindow` from `foregroundActivity` is skipped entirely.
      // No packageName either, so the package-attribution fallback cannot fire.
      foregroundActivity: "com.google.android.deskclock/.DeskClock",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [{ text: "Add alarm", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp({ packageName: "com.google.android.deskclock", userId: 0 });

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        // The legacy Window query's normal failure sentinel: a TRUTHY object
        // with an empty appId, not `undefined`/`null`.
        window: noOpWindow(""),
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.activeWindow?.appId).toBeFalsy();
    expect(result.viewHierarchy?.packageName).toBeFalsy();
    expect(result.freshness?.verified).toBe(true);
    expect(result.freshness?.isFresh).toBe(true);
  });

  // The genuine no-identity case (#6220 itself) must remain caught: no
  // packageName, no usable foregroundActivity, no activeWindow appId at all.
  test("keeps the genuine no-identity systemui-only case unverified", async () => {
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
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
          node: [
            {
              "resource-id": "com.android.systemui:id/clock",
              text: "8:33",
              bounds: { left: 21, top: 0, right: 107, bottom: 63 },
            },
          ],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();

    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(fakeAdb),
      {
        viewHierarchy,
        window: noOpWindow(""),
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as any,
        accessibilityAuditor: { run: async () => undefined } as any,
        accessibilityStateDetector: { run: async () => undefined } as any,
      },
      timer,
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.freshness?.verified).toBe(false);
    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("foreground application window");
  });

  // Regression (P1 review finding on #6239): status-bar-ONLY geometry must
  // dominate any lingering `packageName`/`foregroundActivity` metadata. A
  // hierarchy confined to the status-bar strip can still carry attribution
  // stamped from a PRIOR resumed app even once the tree itself has collapsed
  // to chrome-only content — that identity must not rescue the verdict when
  // both ADB foreground reads (the async, device-confirmed gate) come back
  // empty and there is no ground truth to confirm or refute the staleness.
  test("status-bar-only geometry with stale packageName/foregroundActivity is still UNVERIFIED", async () => {
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
      // Stale identity metadata from a previously-resumed app, left over even
      // though the tree itself is now confined to the status-bar strip.
      packageName: "com.android.settings",
      foregroundActivity: "com.android.settings/.SubSettings",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
          node: [
            {
              "resource-id": "com.android.systemui:id/clock",
              text: "8:33",
              bounds: { left: 21, top: 0, right: 107, bottom: 63 },
            },
          ],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    // Both ADB foreground reads come back empty: no ground truth to confirm
    // or refute the stale attribution, so the async gate cannot fire either.
    fakeAdb.setForegroundApp(null);

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

    expect(result.freshness?.verified).toBe(false);
    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("status-bar content");
  });

  // The counterpart: a legitimate FULL-height SystemUI shade capture (the
  // notification shade IS a valid full SystemUI window) must stay verified —
  // `isStatusBarOnlyHierarchy` only fires when EVERY node is confined to the
  // status-bar strip, so a full-height shade never trips the geometry check.
  test("a full-height SystemUI shade capture stays verified/isFresh:true", async () => {
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
      foregroundActivity: "com.android.systemui/.shade.NotificationPanelView",
      hierarchy: {
        node: {
          // The expanded shade extends well past the status-bar strip.
          bounds: { left: 0, top: 0, right: 1080, bottom: 1400 },
          node: [{ text: "Silent", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
        },
      },
    } as any);

    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setForegroundApp(null);

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

    expect(result.freshness?.verified).toBe(true);
    expect(result.freshness?.isFresh).toBe(true);
  });
});
