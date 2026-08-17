/**
 * Cache-invalidation semantics for the iOS hierarchy delegate (issue #4193).
 *
 * `CtrlProxyHierarchy.invalidateCache()` marks the cached entry `fresh = false`.
 * Before #4193, `getLatestHierarchy()` derived freshness from elapsed time alone
 * and never read that flag, so invalidation was an observable no-op: the next
 * call still served the stale cache for the remainder of the TTL.
 *
 * These tests drive the TTL boundary with `FakeTimer` and count wire fetches, so
 * they pin both the invalidation path and the caching controls that prove the fix
 * did not simply disable the cache.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type {
  CtrlProxyCachedHierarchy,
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../../src/features/observe/ios/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

const CACHE_TTL_MS = 500;

interface Harness {
  hierarchy: CtrlProxyHierarchy;
  timer: FakeTimer;
  /** Number of `request_hierarchy*` messages that reached the socket. */
  fetchCount: () => number;
  getCached: () => CtrlProxyCachedHierarchy | null;
  setCached: (entry: CtrlProxyCachedHierarchy | null) => void;
  /** Simulate a disconnected/reconnecting runner, so no fetch can succeed. */
  setConnected: (connected: boolean) => void;
}

function makeHierarchy(updatedAt: number, marker: string): XCTestHierarchy {
  return {
    updatedAt,
    packageName: "com.test.app",
    hierarchy: { text: marker },
  } as XCTestHierarchy;
}

function createHarness(): Harness {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  let cached: CtrlProxyCachedHierarchy | null = null;
  let fetches = 0;
  let connected = true;

  const context: HierarchyDelegateContext = {
    getWebSocket: () => ({
      readyState: 1,
      send: (data: string) => {
        const message = JSON.parse(data) as { requestId: string };
        fetches += 1;
        // Respond immediately with a hierarchy stamped at the current fake time,
        // so each fetch is distinguishable from the previously cached one.
        requestManager.resolve(message.requestId, {
          hierarchy: makeHierarchy(timer.now(), `fetch-${fetches}`),
        });
      },
    } as never),
    requestManager,
    timer,
    ensureConnected: async () => connected,
    cancelScreenshotBackoff: () => {},
    cacheFreshTtlMs: CACHE_TTL_MS,
    getCachedHierarchy: () => cached,
    setCachedHierarchy: h => { cached = h; },
  };

  return {
    hierarchy: new CtrlProxyHierarchy(context),
    timer,
    fetchCount: () => fetches,
    getCached: () => cached,
    setCached: entry => { cached = entry; },
    setConnected: value => { connected = value; },
  };
}

describe("CtrlProxyHierarchy cache invalidation (iOS)", () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  async function primeCache(): Promise<void> {
    await h.hierarchy.getLatestHierarchy(true, 1000);
    expect(h.fetchCount()).toBe(1);
    expect(h.getCached()).not.toBeNull();
  }

  test("invalidateCache forces a refetch well inside the TTL", async () => {
    await primeCache();

    h.timer.advanceTime(CACHE_TTL_MS / 2);
    h.hierarchy.invalidateCache();

    const result = await h.hierarchy.getLatestHierarchy(true, 1000);

    expect(h.fetchCount()).toBe(2);
    expect(result.fresh).toBe(true);
    expect(result.updatedAt).toBe(CACHE_TTL_MS / 2);
  });

  test("invalidateCache at the TTL boundary still refetches", async () => {
    await primeCache();

    h.timer.advanceTime(CACHE_TTL_MS - 1);
    h.hierarchy.invalidateCache();
    await h.hierarchy.getLatestHierarchy(true, 1000);

    expect(h.fetchCount()).toBe(2);
  });

  test("a refetch after invalidation restores caching", async () => {
    await primeCache();

    h.hierarchy.invalidateCache();
    await h.hierarchy.getLatestHierarchy(true, 1000);
    expect(h.fetchCount()).toBe(2);

    // The replacement entry is fresh again, so the next in-TTL call is a cache hit.
    await h.hierarchy.getLatestHierarchy(true, 1000);
    expect(h.fetchCount()).toBe(2);
  });

  test("the raw-observe invalidate keeps the unfiltered snapshot out of the next read", async () => {
    // Mirrors HierarchyCollector.collectRaw: a raw (disableAllFiltering) fetch
    // caches the *unfiltered* snapshot, then invalidates so it does not bleed into
    // the next normal observe. That caller is the one the no-op was defeating —
    // it never depended on invalidateCache() doing nothing.
    const rawResult = await h.hierarchy.requestHierarchySync(undefined, true, undefined, 1000);
    expect(h.fetchCount()).toBe(1);
    expect(rawResult).not.toBeNull();
    // The unfiltered snapshot really is in the shared cache at this point.
    expect(h.getCached()?.hierarchy).toBe(rawResult!.hierarchy);

    h.hierarchy.invalidateCache();

    const next = await h.hierarchy.getLatestHierarchy(true, 1000);
    expect(h.fetchCount()).toBe(2);
    expect(next.hierarchy).not.toBe(rawResult!.hierarchy);
  });

  test("an invalidated entry forces a refetch even on the skipWaitForFresh observe path", async () => {
    // ObserveScreen defaults to skipWaitForFresh=true, which normally suppresses the
    // sync fetch entirely. An invalidated entry must override that, or the stale
    // fallback hands back exactly the snapshot the invalidation was retiring.
    const rawResult = await h.hierarchy.requestHierarchySync(undefined, true, undefined, 1000);
    h.hierarchy.invalidateCache();

    const next = await h.hierarchy.getLatestHierarchy(false, 15000, undefined, true, 0);

    expect(h.fetchCount()).toBe(2);
    expect(next.fresh).toBe(true);
    expect(next.hierarchy).not.toBe(rawResult!.hierarchy);
  });

  test("skipWaitForFresh still skips the fetch when the cache was not invalidated", async () => {
    await primeCache();
    h.timer.advanceTime(CACHE_TTL_MS * 4); // past the TTL, but not invalidated

    const result = await h.hierarchy.getLatestHierarchy(false, 15000, undefined, true, 0);

    expect(h.fetchCount()).toBe(1);
    expect(result.fresh).toBe(false);
  });

  test("a future device timestamp cannot keep an old host-side capture fresh", async () => {
    h.setCached({
      hierarchy: makeHierarchy(h.timer.now() + 3_600_000, "ahead-device-clock"),
      receivedAt: h.timer.now(),
      captureReceivedAt: h.timer.now(),
      fresh: true,
    });

    h.timer.advanceTime(10_000);
    const result = await h.hierarchy.getLatestHierarchy(false, 1000, undefined, true, 0);

    expect(h.fetchCount()).toBe(1);
    expect(result.fresh).toBe(true);
    expect(result.updatedAt).toBe(10_000);
  });

  test("a configured freshness budget tighter than the cache TTL forces re-verification", async () => {
    const previousBudget = process.env["AUTOMOBILE_MAX_OBSERVATION_AGE_MS"];
    process.env["AUTOMOBILE_MAX_OBSERVATION_AGE_MS"] = "100";
    try {
      await primeCache();
      h.timer.advanceTime(101);

      await h.hierarchy.getLatestHierarchy(false, 1000, undefined, true, 0);

      expect(h.fetchCount()).toBe(2);
    } finally {
      if (previousBudget === undefined) {
        delete process.env["AUTOMOBILE_MAX_OBSERVATION_AGE_MS"];
      } else {
        process.env["AUTOMOBILE_MAX_OBSERVATION_AGE_MS"] = previousBudget;
      }
    }
  });

  // --- Controls: these fail if the fix simply disabled caching. ---

  test("without invalidation the cache serves inside the TTL", async () => {
    await primeCache();

    h.timer.advanceTime(CACHE_TTL_MS - 1);
    const result = await h.hierarchy.getLatestHierarchy(true, 1000);

    expect(h.fetchCount()).toBe(1);
    expect(result.fresh).toBe(true);
    expect(result.updatedAt).toBe(0);
  });

  test("without invalidation the cache refetches at and past the TTL", async () => {
    await primeCache();

    // Boundary: cacheAge === TTL is NOT fresh (strict `<`).
    h.timer.advanceTime(CACHE_TTL_MS);
    await h.hierarchy.getLatestHierarchy(true, 1000);
    expect(h.fetchCount()).toBe(2);

    h.timer.advanceTime(CACHE_TTL_MS + 1);
    await h.hierarchy.getLatestHierarchy(true, 1000);
    expect(h.fetchCount()).toBe(3);
  });

  test("invalidated cache is still returned as stale fallback when the refetch fails", async () => {
    await primeCache();
    const stale = h.getCached()!.hierarchy;
    h.hierarchy.invalidateCache();

    // Disconnected/reconnecting runner: the forced refetch cannot succeed, so the
    // invalidated entry must still be available as an explicitly-stale fallback
    // rather than disappearing. This is why invalidateCache() keeps the entry
    // instead of nulling it the way the Android delegate does.
    h.setConnected(false);
    const result = await h.hierarchy.getLatestHierarchy(false, 1000, undefined, true);

    expect(h.fetchCount()).toBe(1); // ensureConnected failed before any send
    expect(result.fresh).toBe(false);
    expect(result.hierarchy).toBe(stale);
  });
});
