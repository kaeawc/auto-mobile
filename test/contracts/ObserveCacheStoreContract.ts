import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../src/models";
import type { ObserveResultCacheStore } from "../../src/features/observe/cache/ObserveResultCacheStore";
import { FakeTimer } from "../fakes/FakeTimer";

const TTL_MS = 5 * 60 * 1000;

export interface ObserveCacheStoreHandle {
  store: ObserveResultCacheStore;
  dispose?: () => Promise<void> | void;
}

function result(label: string, extra: Partial<ObserveResult> = {}): ObserveResult {
  return {
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    observationId: `contract-${label}`,
    updatedAt: label,
    screenSize: { width: 100, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...extra,
  };
}

/**
 * Shared behavioural contract for {@link ObserveResultCacheStore} (#11868): the in-memory fake
 * and the filesystem store run the same scenarios on the same FakeTimer.
 */
export function runObserveCacheStoreContract(
  name: string,
  make: (timer: FakeTimer) => Promise<ObserveCacheStoreHandle>,
): void {
  const withStore = async (
    body: (store: ObserveResultCacheStore, timer: FakeTimer, start: number) => Promise<void>,
  ): Promise<void> => {
    const timer = new FakeTimer();
    // The filesystem store ages disk files by their real mtime, so the fake clock starts at the
    // real clock for both implementations to see the same ages.
    const start = Date.now();
    timer.setCurrentTime(start);
    const handle = await make(timer);
    try {
      await body(handle.store, timer, start);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`ObserveResultCacheStore contract: ${name}`, () => {
    test("an empty store has nothing cached", () =>
      withStore(async (store) => {
        expect(await store.getMostRecent("d1")).toBeUndefined();
        expect(store.getRecentInMemoryEntry()).toBeUndefined();
        expect(store.getRecentInMemoryForDevice("d1")).toBeUndefined();
        expect(store.getRecentCachedAtForDevice("d1")).toBeUndefined();
        expect(await store.getReferencedScreenshotPaths()).toEqual([]);
      }));

    test("the most recent put per device wins and devices are isolated", () =>
      withStore(async (store, timer, start) => {
        await store.put("d1", result("a"));
        timer.advanceTime(10);
        await store.put("d2", result("b"));
        timer.advanceTime(10);
        await store.put("d1", result("c"));
        expect((await store.getMostRecent("d1"))?.updatedAt).toBe("c");
        expect((await store.getMostRecent("d2"))?.updatedAt).toBe("b");
        expect(store.getRecentInMemoryForDevice("d1")?.updatedAt).toBe("c");
        expect(store.getRecentInMemoryEntry()?.deviceId).toBe("d1");
        expect(store.getRecentCachedAtForDevice("d2")).toBe(start + 10);
      }));

    test("the latest insertion wins a same-tick tie", () =>
      withStore(async (store) => {
        await store.put("d1", result("first"));
        await store.put("d2", result("second"));
        expect(store.getRecentInMemoryEntry()?.deviceId).toBe("d2");
      }));

    test("entries expire at the five minute TTL", () =>
      withStore(async (store, timer) => {
        await store.put("d1", result("a", { screenshotPath: "/tmp/a.png" }));
        timer.advanceTime(TTL_MS - 1);
        expect(store.getRecentInMemoryForDevice("d1")?.updatedAt).toBe("a");
        expect(await store.getReferencedScreenshotPaths()).toEqual(["/tmp/a.png"]);
        timer.advanceTime(1);
        expect(store.getRecentInMemoryForDevice("d1")).toBeUndefined();
        // Disk files age by their real mtime, which trails the fake clock by a few ms.
        timer.advanceTime(1_000);
        expect(await store.getMostRecent("d1")).toBeUndefined();
        expect(await store.getReferencedScreenshotPaths()).toEqual([]);
      }));

    test("clear(device) is scoped, clear() empties everything, and both advance generations", () =>
      withStore(async (store) => {
        await store.put("d1", result("a"));
        await store.put("d2", result("b"));
        const g1 = store.currentGeneration("d1");
        const g2 = store.currentGeneration("d2");
        store.clear("d1");
        expect(store.currentGeneration("d1")).toBeGreaterThan(g1);
        expect(store.currentGeneration("d2")).toBe(g2);
        expect(store.getRecentInMemoryForDevice("d1")).toBeUndefined();
        expect(store.getRecentInMemoryForDevice("d2")?.updatedAt).toBe("b");
        store.clear();
        expect(store.currentGeneration("d2")).toBeGreaterThan(g2);
        expect(store.getRecentInMemoryForDevice("d2")).toBeUndefined();
      }));

    test("a put fenced by a stale generation is dropped; a current one is kept", () =>
      withStore(async (store) => {
        const stale = store.currentGeneration("d1");
        store.clear("d1");
        await store.put("d1", result("late"), stale);
        expect(store.getRecentInMemoryForDevice("d1")).toBeUndefined();
        await store.put("d1", result("ok"), store.currentGeneration("d1"));
        expect(store.getRecentInMemoryForDevice("d1")?.updatedAt).toBe("ok");
      }));

    test("a put with a known observationId updates the entry in place", () =>
      withStore(async (store, timer) => {
        await store.put("d1", result("v1", { observationId: "obs-1" }));
        const cachedAt = store.getRecentCachedAtForDevice("d1");
        timer.advanceTime(50);
        await store.put("d1", result("v2", { observationId: "obs-1" }));
        expect(store.getRecentInMemoryForDevice("d1")?.updatedAt).toBe("v2");
        expect(store.getRecentCachedAtForDevice("d1")).toBe(cachedAt);
      }));

    test("an explicit cachedAt orders entries", () =>
      withStore(async (store, _timer, timerStart) => {
        await store.put("d1", result("newer"), undefined, timerStart + 2_000);
        await store.put("d1", result("older"), undefined, timerStart + 1_000);
        expect(store.getRecentInMemoryForDevice("d1")?.updatedAt).toBe("newer");
        expect(store.getRecentCachedAtForDevice("d1")).toBe(timerStart + 2_000);
      }));

    test("referenced screenshot paths are de-duplicated across live entries", () =>
      withStore(async (store, timer) => {
        await store.put("d1", result("a", { screenshotPath: "/tmp/s.png" }));
        timer.advanceTime(5);
        await store.put("d2", result("b", { screenshotPath: "/tmp/s.png" }));
        timer.advanceTime(5);
        await store.put("d1", result("c", { screenshotPath: "/tmp/t.png" }));
        expect([...(await store.getReferencedScreenshotPaths())].sort()).toEqual([
          "/tmp/s.png",
          "/tmp/t.png",
        ]);
      }));
  });
}
