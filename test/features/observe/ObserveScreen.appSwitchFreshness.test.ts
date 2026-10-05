import { afterEach, describe, expect, test } from "bun:test";
import { deviceLikeAndroidHierarchy } from "../../helpers/deviceLikeAndroidHierarchy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { createObserveScreenForTest } from "./observeScreenTestBuilders";

afterEach(() => {
  resetObserveCacheStore();
  displayTransitions.reset("fake-settle-cache");
});

async function harness(switched: boolean, answerSync = true) {
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
  const screen = createObserveScreenForTest(
    h.device,
    new FakeAdbClientFactory(h.adb),
    {
      viewHierarchy: h.viewHierarchy,
      cacheStore: new FakeObserveCacheStore(h.timer),
    },
    h.timer,
  );
  return { ...h, screen };
}

const options = { skipScreenshot: true, skipBackStack: true, timeoutMs: 500 };

describe("observe app-switch cache recovery", () => {
  test("within 300ms of switching extracts the new app exactly once", async () => {
    const h = await harness(true);
    try {
      const result = await h.screen.execute(options);
      expect(result.activeWindow?.appId).toBe("com.example.new");
      expect(result.activeWindow?.activityName).toBe("com.example.new.MainActivity");
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

  test("an unverified unchanged cache gets one independent extraction", async () => {
    const h = await harness(false);
    try {
      const result = await h.screen.execute(options);
      expect(result.freshness).toMatchObject({ isFresh: true, verified: true });
      expect(h.extractions()).toBe(1);
      expect(h.reads).toHaveLength(2);
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
});
