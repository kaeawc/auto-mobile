/**
 * Issue #6099: the attribution recapture asks for a tree newer than the
 * initial capture (`minTimestamp = initial + 1`). That rejects the cache, and
 * the rejected cache used to force the WebSocket fresh-data wait even when the
 * caller asked to skip it — so on a static screen (nothing is pushed) the
 * recapture burned the full `DEFAULT_FRESH_WAIT_MS` before falling back to the
 * sync that actually produces the fresh tree.
 *
 * `skipWaitForFresh` now means what its contract says: skip the wait and go
 * straight to sync. The cache is still rejected (minTimestamp semantics are
 * unchanged), and a caller that does NOT skip still waits.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  CachedHierarchy,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/android/types";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

const DEFAULT_FRESH_WAIT_MS = 1000;
const T = 1_700_000_000_000;

function tree(updatedAt: number, label: string): CachedHierarchy["hierarchy"] {
  return {
    packageName: "com.android.settings",
    updatedAt,
    screenWidth: 1080,
    screenHeight: 2400,
    hierarchy: {
      bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
      node: [{ text: label, bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
    },
  } as never;
}

interface Harness {
  hierarchy: CtrlProxyHierarchy;
  timer: FakeTimer;
  waitCalls: number[];
  /** Tree the (stubbed) sync returns; swap it to model a late, older push. */
  syncTree: CachedHierarchy["hierarchy"];
  syncCalls: () => number;
  cooldownSet: () => boolean;
  restore: () => void;
}

function createHarness(): Harness {
  const timer = new FakeTimer();
  timer.setCurrentTime(T + 10);
  let cached: CachedHierarchy | null = {
    hierarchy: tree(T, "initial"),
    receivedAt: T,
    fresh: true,
  };
  let cooldownSet = false;
  const waitCalls: number[] = [];

  const context: HierarchyDelegateContext = {
    getWebSocket: () => null,
    requestManager: new RequestManager(timer),
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { deviceId: "emulator-5554", platform: "android" } as never,
    adb: {} as never,
    getCachedHierarchy: () => cached,
    setCachedHierarchy: (h) => {
      cached = h;
    },
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {
      cooldownSet = true;
    },
  };

  const managerSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
    isAvailable: async () => true,
  } as never);

  const hierarchy = new CtrlProxyHierarchy(context);
  // A static screen: nothing is pushed, so a wait always runs to its timeout.
  const waitSpy = spyOn(
    hierarchy as never as { waitForFreshData: () => unknown },
    "waitForFreshData",
  ).mockImplementation((async (timeoutMs: number) => {
    waitCalls.push(timeoutMs);
    timer.advanceTime(timeoutMs);
    return null;
  }) as never);
  // The sync produces the genuinely fresh tree by default; a test may swap it.
  let syncCalls = 0;
  const harness = { syncTree: tree(T + 20, "synced") };
  const syncSpy = spyOn(hierarchy, "requestHierarchySync").mockImplementation(async () => {
    syncCalls += 1;
    return { hierarchy: harness.syncTree };
  });

  return {
    hierarchy,
    timer,
    waitCalls,
    get syncTree() {
      return harness.syncTree;
    },
    set syncTree(value: CachedHierarchy["hierarchy"]) {
      harness.syncTree = value;
    },
    syncCalls: () => syncCalls,
    cooldownSet: () => cooldownSet,
    restore: () => {
      managerSpy.mockRestore();
      waitSpy.mockRestore();
      syncSpy.mockRestore();
    },
  };
}

describe("Android CtrlProxyHierarchy recapture skips the fresh wait (issue #6099)", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.restore();
    h = null;
  });

  test("a skip-wait read with a rejected cache goes straight to sync without burning the fresh wait", async () => {
    h = createHarness();
    const started = h.timer.now();

    const result = await h.hierarchy.getAccessibilityHierarchy(
      undefined,
      undefined,
      true,
      T + 1,
      false,
      undefined,
    );

    expect(h.waitCalls).toEqual([]);
    expect(h.timer.now() - started).toBe(0);
    expect(h.syncCalls()).toBe(1);
    expect(h.cooldownSet()).toBe(false);
    // The cache was still rejected: the returned tree is the synced one, fresh.
    expect(result?.fresh).toBe(true);
    expect(result?.updatedAt).toBe(T + 20);
  });

  test("a sync that returns a tree older than minTimestamp is reported stale, not fresh", async () => {
    h = createHarness();
    // A late push of the pre-navigation tree lands in the sync window: its
    // device stamp is the initial capture's, below the caller's floor.
    h.syncTree = tree(T, "late pre-navigation push");

    const result = await h.hierarchy.getAccessibilityHierarchy(
      undefined,
      undefined,
      true,
      T + 1,
      false,
      undefined,
    );

    expect(h.waitCalls).toEqual([]);
    expect(h.syncCalls()).toBe(1);
    expect(result?.fresh).toBe(false);
    expect(result?.updatedAt).toBe(T);
  });

  test("a read that does not skip the wait still waits for a push before syncing", async () => {
    h = createHarness();
    const started = h.timer.now();

    const result = await h.hierarchy.getAccessibilityHierarchy(
      undefined,
      undefined,
      false,
      T + 1,
      false,
      undefined,
    );

    expect(h.waitCalls).toEqual([DEFAULT_FRESH_WAIT_MS]);
    expect(h.timer.now() - started).toBe(DEFAULT_FRESH_WAIT_MS);
    expect(h.syncCalls()).toBe(1);
    expect(result?.fresh).toBe(true);
    expect(result?.updatedAt).toBe(T + 20);
  });
});
