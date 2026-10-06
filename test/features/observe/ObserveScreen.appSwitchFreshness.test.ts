import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import type { AccessibilityHierarchy } from "../../../src/features/observe/android/types";
import { waitForObservation } from "../../../src/server/observeTools";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { RealWaitForCondition } from "../../../src/features/observe/WaitForCondition";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { deviceLikeAndroidHierarchy } from "../../helpers/deviceLikeAndroidHierarchy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { ObserveScreenDependencies } from "../../../src/features/observe/ObserveScreenDependencies";
import type { BackStackInfo } from "../../../src/models";
import { createObserveScreenForTest } from "./observeScreenTestBuilders";

afterEach(() => {
  resetObserveCacheStore();
  displayTransitions.reset("fake-settle-cache");
});

async function harness(
  switched: boolean,
  answerSync = true,
  backStack?: ObserveScreenDependencies["backStack"],
) {
  const h = await deviceLikeAndroidHierarchy(() => "App content", {
    packageName: (extraction) =>
      switched && extraction > 0 ? "com.example.new" : "com.android.settings",
    answerSync,
  });
  h.adb.setForegroundApp({
    packageName: switched ? "com.example.new" : "com.android.settings",
    userId: 0,
  });
  h.timer.advanceTime(300);
  const audits = { performance: 0, accessibility: 0 };
  const screenshot = new FakeScreenshotRecorder();
  const screen = createObserveScreenForTest(
    h.device,
    new FakeAdbClientFactory(h.adb),
    {
      viewHierarchy: h.viewHierarchy,
      ...(backStack ? { backStack } : {}),
      hierarchyCapture: createDeviceHierarchyCapture(h.device, {
        viewHierarchy: h.viewHierarchy,
        timer: h.timer,
        syncClientFactory: () => ({
          requestHierarchySync: async (...args) => {
            const synced = await h.hierarchy.requestHierarchySync(...args);
            if (synced) {
              h.reads.push({ floor: 0, fresh: true, updatedAt: synced.hierarchy.updatedAt });
            }
            return synced;
          },
          convertToViewHierarchyResult: (value) =>
            h.hierarchy.convertToViewHierarchyResult(value as AccessibilityHierarchy),
        }),
      }),
      cacheStore: new FakeObserveCacheStore(h.timer),
      screenshotRecorder: screenshot,
      performanceAuditor: {
        run: async () => {
          audits.performance++;
        },
      },
      accessibilityAuditor: {
        run: async () => {
          audits.accessibility++;
        },
      },
    },
    h.timer,
  );
  return { ...h, screen, audits, screenshot };
}

const options = { skipScreenshot: true, skipBackStack: true, timeoutMs: 500 };

describe("observe app-switch cache recovery", () => {
  test("within 300ms of switching extracts the new app exactly once", async () => {
    const h = await harness(true);
    try {
      const result = await h.screen.execute(options);
      expect(result.activeWindow?.appId).toBe("com.example.new");
      expect(result.activeWindow?.activityName).toBe("");
      expect(result.freshness).toMatchObject({ isFresh: true, verified: true });
      expect(h.extractions()).toBe(1);
      expect(h.reads).toHaveLength(2);
      expect(h.timer.getSleepHistory()).toEqual([]);
    } finally {
      h.restore();
    }
  });

  test("fresh verified case performs only its initial read/extraction", async () => {
    const h = await harness(false);
    h.hierarchy.invalidateCache();
    try {
      const result = await h.screen.execute(options);
      expect(result.freshness).toMatchObject({ isFresh: true, verified: true });
      expect(h.extractions()).toBe(1);
      expect(h.reads).toHaveLength(1);
      expect(h.timer.getSleepHistory()).toEqual([]);
    } finally {
      h.restore();
    }
  });

  test("plain observe same-app cache hit within 1s performs only one hierarchy collection", async () => {
    const h = await harness(false);
    try {
      const result = await h.screen.execute(options);
      expect(result.freshness).toMatchObject({
        isFresh: false,
        verified: false,
        category: "cache_age",
      });
      expect(h.extractions()).toBe(0);
      expect(h.reads).toHaveLength(1);
    } finally {
      h.restore();
    }
  });

  test("app-switch mismatch re-extracts hierarchy without repeating derived work", async () => {
    const h = await harness(true);
    const recomposition = spyOn(h.screen, "processRecomposition").mockResolvedValue();
    try {
      h.screenshot.start = () => {
        expect(h.reads).toHaveLength(2);
        h.screenshot.startCalls++;
      };
      await h.screen.execute({ ...options, skipScreenshot: false, screenshot: "async" });
      expect(h.reads).toHaveLength(2);
      expect(h.extractions()).toBe(1);
      expect(recomposition).toHaveBeenCalledTimes(1);
      expect(h.audits).toEqual({ performance: 1, accessibility: 1 });
      expect(h.screenshot.startCalls + h.screenshot.captureCalls).toBe(1);
    } finally {
      recomposition.mockRestore();
      h.restore();
    }
  });

  test("WaitForCondition poll does not trigger nested recovery", async () => {
    const h = await harness(true);
    try {
      const wait = new RealWaitForCondition(h.screen, h.timer);
      const result = await wait.execute(() => ({ matched: true }), { timeoutMs: 500 });
      expect(h.reads).toHaveLength(result.polls);
      expect(h.extractions()).toBe(1);
    } finally {
      h.restore();
    }
  });

  test("observe waitFor polling policy does not trigger nested recovery", async () => {
    const h = await harness(true);
    try {
      const result = await waitForObservation(
        h.screen,
        { text: "App content", timeoutMs: 500 },
        undefined,
        true,
        h.timer,
        "android",
        "none",
      );
      expect(result.observation.freshness?.category).toBe("window_identity");
      expect(h.reads).toHaveLength(1);
      expect(h.extractions()).toBe(0);
    } finally {
      h.restore();
    }
  });

  test("unobtainable extraction keeps the wrong-window warning within budget", async () => {
    const h = await harness(true, false);
    try {
      const started = h.timer.now();
      const result = await h.screen.execute(options);
      expect(result.activeWindow?.appId).toBe("com.android.settings");
      expect(result.freshness).toMatchObject({
        isFresh: false,
        verified: false,
        category: "window_identity",
      });
      expect(result.freshness?.warning).toContain("com.example.new");
      expect(h.extractions()).toBe(1);
      expect(h.timer.now() - started).toBeLessThanOrEqual(500);
    } finally {
      h.restore();
    }
  });

  describe("side samples after the recovery (#9982)", () => {
    const oldLock = { locked: true, keyguardShowing: true, secure: true };
    const newLock = { locked: false, keyguardShowing: false, secure: false };
    const stackFor = (activity: string): BackStackInfo => ({
      depth: 1,
      activities: [],
      tasks: [{ id: 9, packageName: "com.example.new" }],
      currentActivity: { name: activity, taskId: 9 },
      source: "adb",
    });
    /** First read describes the discarded window; later reads describe the new app. */
    function sequencedBackStack(
      outcomes: (BackStackInfo | Error)[],
    ): NonNullable<ObserveScreenDependencies["backStack"]> & { calls: number } {
      const fake = {
        calls: 0,
        execute: async () => {
          const outcome = outcomes[Math.min(fake.calls++, outcomes.length - 1)];
          if (outcome instanceof Error) {
            throw outcome;
          }
          return outcome;
        },
      };
      return fake;
    }

    test("re-reads lock state and back stack so the new app's activity is named", async () => {
      const backStack = sequencedBackStack([
        stackFor("com.android.settings.Settings"),
        stackFor("com.example.new.MainActivity"),
      ]);
      const h = await harness(true, true, backStack);
      h.adb.setDeviceLockSequence([oldLock, newLock]);
      try {
        const result = await h.screen.execute({ skipScreenshot: true, timeoutMs: 500 });
        expect(result.viewHierarchy?.packageName).toBe("com.example.new");
        expect(result.deviceLock).toEqual(newLock);
        expect(result.backStack?.currentActivity?.name).toBe("com.example.new.MainActivity");
        expect(result.activeWindow).toMatchObject({
          appId: "com.example.new",
          activityName: "com.example.new.MainActivity",
        });
        expect(backStack.calls).toBeGreaterThanOrEqual(2);
      } finally {
        h.restore();
      }
    });

    test("skipBackStack re-reads only the lock state", async () => {
      const backStack = sequencedBackStack([stackFor("com.example.new.MainActivity")]);
      const h = await harness(true, true, backStack);
      h.adb.setDeviceLockSequence([oldLock, newLock]);
      try {
        const result = await h.screen.execute({ ...options });
        expect(result.deviceLock).toEqual(newLock);
        expect(result.backStack).toBeUndefined();
        expect(backStack.calls).toBe(0);
      } finally {
        h.restore();
      }
    });

    test("a failed back-stack re-read leaves the field absent and still returns the new tree", async () => {
      const backStack = sequencedBackStack([
        stackFor("com.android.settings.Settings"),
        new Error("dumpsys failed"),
      ]);
      const h = await harness(true, true, backStack);
      h.adb.setDeviceLockSequence([oldLock, newLock]);
      try {
        const result = await h.screen.execute({ skipScreenshot: true, timeoutMs: 500 });
        expect(result.viewHierarchy?.packageName).toBe("com.example.new");
        expect(result.deviceLock).toEqual(newLock);
        expect(result.backStack).toBeUndefined();
        expect(result.activeWindow?.appId).toBe("com.example.new");
        expect(result.activeWindow?.activityName).toBe("");
      } finally {
        h.restore();
      }
    });

    test("a same-app cache hit keeps its own lock state and back stack", async () => {
      const backStack = sequencedBackStack([stackFor("com.android.settings.Settings")]);
      const h = await harness(false, true, backStack);
      h.adb.setDeviceLock(oldLock);
      try {
        const result = await h.screen.execute({ skipScreenshot: true, timeoutMs: 500 });
        expect(result.deviceLock).toEqual(oldLock);
        expect(result.backStack?.currentActivity?.name).toBe("com.android.settings.Settings");
      } finally {
        h.restore();
      }
    });
  });
});
