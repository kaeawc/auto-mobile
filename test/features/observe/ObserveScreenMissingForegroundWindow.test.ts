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
    expect(result.freshness?.warning).toContain("no foreground application window");
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
});
