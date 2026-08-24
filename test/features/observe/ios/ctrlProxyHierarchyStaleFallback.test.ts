/**
 * Stale-fallback freshness for the iOS hierarchy delegate (issue #4261).
 *
 * `getLatestHierarchy` captures the cache at entry. When an invalidated entry
 * takes the `skipWaitForFresh` override (issue #4193 / PR #4230) the sync fetch
 * is awaited — and an unsolicited `hierarchy_update` push handled by
 * `IOSCtrlProxyClient.processMessage` can replace the cache while that await is
 * in flight. If the sync then fails, the fallback must hand back the cache as it
 * stands, not the pre-await snapshot the invalidation was meant to retire.
 *
 * Clearing the cache instead is not an option here: under `skipWaitForFresh` a
 * missing cache yields no hierarchy at all rather than a refetch.
 */

import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type {
  CtrlProxyCachedHierarchy,
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../../src/features/observe/ios/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

const CACHE_TTL_MS = 500;

function makeHierarchy(updatedAt: number, marker: string): XCTestHierarchy {
  return {
    updatedAt,
    packageName: "com.test.app",
    hierarchy: { text: marker },
  } as XCTestHierarchy;
}

interface Harness {
  hierarchy: CtrlProxyHierarchy;
  timer: FakeTimer;
  getCached: () => CtrlProxyCachedHierarchy | null;
  setCached: (entry: CtrlProxyCachedHierarchy | null) => void;
}

/**
 * @param onSend runs when the sync request hits the socket, standing in for
 *   whatever the runner does while the caller is parked on the await.
 */
function createHarness(
  onSend: (requestManager: RequestManager, requestId: string) => void,
): Harness {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  let cached: CtrlProxyCachedHierarchy | null = null;

  const context: HierarchyDelegateContext = {
    getWebSocket: () =>
      ({
        readyState: 1,
        send: (data: string) => {
          const message = JSON.parse(data) as { requestId: string };
          onSend(requestManager, message.requestId);
        },
      }) as never,
    requestManager,
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    cacheFreshTtlMs: CACHE_TTL_MS,
    getCachedHierarchy: () => cached,
    setCachedHierarchy: (h) => {
      cached = h;
    },
  };

  return {
    hierarchy: new CtrlProxyHierarchy(context),
    timer,
    getCached: () => cached,
    setCached: (entry) => {
      cached = entry;
    },
  };
}

describe("iOS CtrlProxyHierarchy stale fallback", () => {
  test("a push that lands during a failing sync wins over the invalidated snapshot", async () => {
    let harness: Harness | null = null;

    harness = createHarness((requestManager, requestId) => {
      // An unsolicited hierarchy_update arrives while the sync is outstanding;
      // processMessage replaces the cache with it.
      harness!.setCached({
        hierarchy: makeHierarchy(42, "pushed"),
        receivedAt: harness!.timer.now(),
        fresh: true,
      } as CtrlProxyCachedHierarchy);
      // The sync itself comes back empty (timed out / failed).
      requestManager.resolve(requestId, { hierarchy: undefined });
    });

    harness.setCached({
      hierarchy: makeHierarchy(1, "invalidated"),
      receivedAt: harness.timer.now(),
      fresh: false,
    } as CtrlProxyCachedHierarchy);

    const result = await harness.hierarchy.getLatestHierarchy(false, 1000, undefined, true);

    expect(result.hierarchy).not.toBeNull();
    expect((result.hierarchy as XCTestHierarchy).hierarchy.text).toBe("pushed");
    expect(result.updatedAt).toBe(42);
    expect(result.fresh).toBe(true);
  });

  test("with no push during the sync the invalidated entry is still the fallback", async () => {
    // Guard against 'fixing' this by dropping the stale fallback altogether:
    // under skipWaitForFresh a missing cache yields no hierarchy at all.
    const harness = createHarness((requestManager, requestId) => {
      requestManager.resolve(requestId, { hierarchy: undefined });
    });

    harness.setCached({
      hierarchy: makeHierarchy(1, "invalidated"),
      receivedAt: harness.timer.now(),
      fresh: false,
    } as CtrlProxyCachedHierarchy);

    const result = await harness.hierarchy.getLatestHierarchy(false, 1000, undefined, true);

    expect((result.hierarchy as XCTestHierarchy).hierarchy.text).toBe("invalidated");
    expect(result.fresh).toBe(false);
  });

  test("an SDK-enriched push with the same capture timestamp is still fresh", async () => {
    let harness: Harness | null = null;
    harness = createHarness((requestManager, requestId) => {
      harness!.setCached({
        hierarchy: makeHierarchy(1, "sdk-enriched"),
        receivedAt: harness!.timer.now(),
        fresh: true,
      } as CtrlProxyCachedHierarchy);
      requestManager.resolve(requestId, { hierarchy: undefined });
    });

    harness.setCached({
      hierarchy: makeHierarchy(1, "before-sdk-enrichment"),
      receivedAt: harness.timer.now(),
      fresh: false,
    } as CtrlProxyCachedHierarchy);

    const result = await harness.hierarchy.getLatestHierarchy(false, 1000, undefined, true);

    expect((result.hierarchy as XCTestHierarchy).hierarchy.text).toBe("sdk-enriched");
    expect(result.fresh).toBe(true);
  });
});
