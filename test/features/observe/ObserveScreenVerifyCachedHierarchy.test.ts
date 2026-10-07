/**
 * Issue #9963: on a Compose app the explicit `observe` accepted CtrlProxy's push-cache
 * entry (age 96-133 ms, inside the 1 s serve window) without a device read and reported
 * `verified: false` / `isFresh: false`, so the next `tapOn` re-observed in full. Settings
 * was reported verified only because its hierarchy names no activity, which forces the
 * back-stack attribution recapture. Values below come from the mt36 Playground capture
 * (scratch/mt36 i2t N-obs1: updatedAt 1791248093499, ageMs 125, verified false).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import type { ViewHierarchyResult } from "../../../src/models";
import type { HierarchyCapture } from "../../../src/features/observe/HierarchyCapture";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { createHierarchyForTest, createObserveScreenForTest } from "./observeScreenTestBuilders";

const device = { deviceId: "emulator-5600", name: "Pixel", platform: "android" as const };
const PLAYGROUND = "dev.jasonpearson.automobile.playground";
const PLAYGROUND_ACTIVITY = `${PLAYGROUND}.MainActivity`;
const CACHED_UPDATED_AT = 1_791_248_093_499;
const CACHE_AGE_MS = 125;
const NOW = CACHED_UPDATED_AT + CACHE_AGE_MS;

beforeEach(() => displayTransitions.reset(device.deviceId));
afterEach(() => displayTransitions.reset(device.deviceId));

function composeHierarchy(options: {
  updatedAt: number;
  receivedAt: number;
  fresh: boolean;
  packageName?: string;
  foregroundActivity?: string;
  label?: string;
}): ViewHierarchyResult {
  return createHierarchyForTest({
    updatedAt: options.updatedAt,
    receivedAt: options.receivedAt,
    fresh: options.fresh,
    screenWidth: 1080,
    screenHeight: 2400,
    packageName: options.packageName ?? PLAYGROUND,
    foregroundActivity: options.foregroundActivity ?? `${PLAYGROUND}/.MainActivity`,
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [
          {
            text: options.label ?? "Regular Button",
            clickable: "true",
            bounds: { left: 84, top: 1778, right: 529, bottom: 1904 },
          },
        ],
      },
    },
  });
}

/** The tree CtrlProxy's host cache kept from the previous tap. */
function cachedHit(): ViewHierarchyResult {
  return composeHierarchy({
    updatedAt: CACHED_UPDATED_AT,
    receivedAt: NOW - CACHE_AGE_MS,
    fresh: false,
  });
}

function synced(
  overrides: {
    label?: string;
    packageName?: string;
    fresh?: boolean;
    foregroundActivity?: string;
  } = {},
) {
  return composeHierarchy({
    updatedAt: CACHED_UPDATED_AT + 40,
    receivedAt: NOW,
    fresh: overrides.fresh ?? true,
    label: overrides.label ?? "Regular Button (pressed)",
    packageName: overrides.packageName,
    foregroundActivity: overrides.foregroundActivity,
  });
}

const SAMPLED_LOCK = { locked: true, keyguardShowing: true, secure: true };
const RESAMPLED_LOCK = { locked: false, keyguardShowing: false, secure: false };

function setup(
  hierarchies: ViewHierarchyResult[],
  overrides: {
    /** Activity per back-stack read; the last entry repeats. */
    backStackActivities?: string[];
    foreground?: string;
    onBackStackRead?: (readNumber: number) => Promise<void> | void;
    timer?: FakeTimer;
    hierarchyCapture?: HierarchyCapture;
  } = {},
): { screen: RealObserveScreen; hierarchy: FakeViewHierarchy; backStackReads: () => number } {
  const timer = overrides.timer ?? new FakeTimer();
  timer.setCurrentTime(NOW);
  const hierarchy = new FakeViewHierarchy();
  hierarchy.configureHierarchySequence(hierarchies);
  const adb = new FakeAdbExecutor();
  adb.setForegroundApp({ packageName: overrides.foreground ?? PLAYGROUND, userId: 0 });
  adb.setDeviceLockSequence([SAMPLED_LOCK, RESAMPLED_LOCK]);
  const activities = overrides.backStackActivities ?? [PLAYGROUND_ACTIVITY];
  let backStackReads = 0;
  const screen = createObserveScreenForTest(
    device,
    new FakeAdbClientFactory(adb),
    {
      viewHierarchy: hierarchy,
      backStack: {
        execute: async () => {
          const read = backStackReads++;
          if (overrides.onBackStackRead) {
            await overrides.onBackStackRead(read + 1);
          }
          return {
            depth: 1,
            activities: [],
            tasks: [{ id: 421, packageName: PLAYGROUND }],
            currentActivity: {
              name: activities[Math.min(read, activities.length - 1)],
              taskId: 421,
            },
            source: "adb" as const,
          };
        },
      },
      cacheStore: new FakeObserveCacheStore(timer),
      ...(overrides.hierarchyCapture ? { hierarchyCapture: overrides.hierarchyCapture } : {}),
    },
    timer,
  );
  return { screen, hierarchy, backStackReads: () => backStackReads };
}

const EXPLICIT_OBSERVE = {
  skipWaitForFresh: true,
  skipScreenshot: true,
  skipPerformanceAudit: true,
  skipAccessibilityAudit: true,
} as const;

describe("ObserveScreen explicit observe verifies a cached Android hierarchy (#9963)", () => {
  test("pin: without the option a cache hit is served unverified (one read)", async () => {
    const { screen, hierarchy } = setup([cachedHit()]);

    const result = await screen.execute(EXPLICIT_OBSERVE);

    expect(hierarchy.getCallCount()).toBe(1);
    expect(result.freshness).toMatchObject({
      verified: false,
      isFresh: false,
      ageMs: CACHE_AGE_MS,
    });
    expect(result.freshness?.category).toBe("cache_age");
  });

  test("a cache hit is replaced by one synchronous read and reported verified", async () => {
    const { screen, hierarchy, backStackReads } = setup([cachedHit(), synced()]);

    const result = await screen.execute({ ...EXPLICIT_OBSERVE, verifyCachedHierarchy: true });

    expect(hierarchy.getCallCount()).toBe(2);
    // Inclusive device floor at the cached tree's own stamp, extraction required.
    expect(hierarchy.getCalls()[1]).toEqual({
      skipWaitForFresh: true,
      minTimestamp: CACHED_UPDATED_AT,
    });
    expect(hierarchy.getReadOptions()[1]).toMatchObject({ requireFreshExtraction: true });
    expect(result.freshness).toMatchObject({ verified: true, isFresh: true });
    expect(result.freshness?.warning).toBeUndefined();
    expect(result.updatedAt).toBe(CACHED_UPDATED_AT + 40);
    expect(JSON.stringify(result.elements)).toContain("Regular Button (pressed)");
    // Output shape: the side samples taken with the tree are kept, not discarded, and
    // the same-window path adds no lock or back-stack device call.
    expect(result.backStack?.currentActivity?.name).toBe(PLAYGROUND_ACTIVITY);
    expect(result.deviceLock).toEqual(SAMPLED_LOCK);
    expect(backStackReads()).toBe(1);
    expect(result.activeWindow).toEqual({
      appId: PLAYGROUND,
      activityName: PLAYGROUND_ACTIVITY,
      layoutSeqSum: 0,
    });
  });

  test("a same-package A->B move during the verifying read does not publish B under A", async () => {
    const { screen, hierarchy, backStackReads } = setup(
      [
        cachedHit(),
        synced({ foregroundActivity: `${PLAYGROUND}/.DetailActivity`, label: "Detail" }),
      ],
      { backStackActivities: [PLAYGROUND_ACTIVITY, `${PLAYGROUND}.DetailActivity`] },
    );

    const result = await screen.execute({ ...EXPLICIT_OBSERVE, verifyCachedHierarchy: true });

    // No hierarchy read beyond the verifying one.
    expect(hierarchy.getCallCount()).toBe(2);
    expect(JSON.stringify(result.elements)).toContain("Detail");
    expect(result.freshness).toMatchObject({ verified: true, isFresh: true });
    // Identity from the replaced tree is not carried over: unknown, as the other recapture paths.
    expect(result.activeWindow).toEqual({ appId: PLAYGROUND, activityName: "", layoutSeqSum: 0 });
    // The samples taken with A are replaced by a re-read of B's, not left absent (#9982).
    expect(backStackReads()).toBe(2);
    expect(result.backStack?.currentActivity?.name).toBe(`${PLAYGROUND}.DetailActivity`);
    expect(result.deviceLock).toEqual(RESAMPLED_LOCK);
  });

  test("skipBackStack re-reads only the lock state after a same-package move", async () => {
    const { screen, backStackReads } = setup([
      cachedHit(),
      synced({ foregroundActivity: `${PLAYGROUND}/.DetailActivity`, label: "Detail" }),
    ]);

    const result = await screen.execute({
      ...EXPLICIT_OBSERVE,
      skipBackStack: true,
      verifyCachedHierarchy: true,
    });

    expect(backStackReads()).toBe(0);
    expect(result.backStack).toBeUndefined();
    expect(result.deviceLock).toEqual(RESAMPLED_LOCK);
  });

  test("a verifying tree that names no activity cannot be compared and is re-correlated", async () => {
    const { screen, backStackReads } = setup(
      [cachedHit(), synced({ foregroundActivity: `${PLAYGROUND}/android.widget.FrameLayout` })],
      { backStackActivities: [PLAYGROUND_ACTIVITY, `${PLAYGROUND}.OtherActivity`] },
    );

    const result = await screen.execute({ ...EXPLICIT_OBSERVE, verifyCachedHierarchy: true });

    expect(result.freshness?.verified).toBe(true);
    expect(result.activeWindow).toEqual({ appId: PLAYGROUND, activityName: "", layoutSeqSum: 0 });
    expect(backStackReads()).toBe(2);
    expect(result.backStack?.currentActivity?.name).toBe(`${PLAYGROUND}.OtherActivity`);
  });

  test("a back-stack re-read that outlives the remaining budget is dropped, not published late", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(NOW);
    let release: (() => void) | undefined;
    const { screen, backStackReads } = setup(
      [cachedHit(), synced({ foregroundActivity: `${PLAYGROUND}/.DetailActivity` })],
      {
        backStackActivities: [PLAYGROUND_ACTIVITY, `${PLAYGROUND}.DetailActivity`],
        onBackStackRead: (readNumber) =>
          readNumber === 2
            ? new Promise<void>((resolve) => {
                release = resolve;
              })
            : undefined,
        timer,
      },
    );

    const pending = screen.execute({ ...EXPLICIT_OBSERVE, verifyCachedHierarchy: true });
    // Let the verifying read finish and the re-read start, then run out the 500 ms budget.
    for (let i = 0; i < 200 && backStackReads() < 2; i++) {
      await Promise.resolve();
    }
    expect(backStackReads()).toBe(2);
    timer.advanceTime(600);
    const result = await pending;
    release?.();

    expect(result.freshness?.verified).toBe(true);
    expect(result.backStack).toBeUndefined();
  });

  test("an already verified read costs no extra device read", async () => {
    const { screen, hierarchy } = setup([synced()]);

    const result = await screen.execute({ ...EXPLICIT_OBSERVE, verifyCachedHierarchy: true });

    expect(hierarchy.getCallCount()).toBe(1);
    expect(result.freshness?.verified).toBe(true);
  });

  test("a hierarchy without an activity signal is not read a third time (Settings shape)", async () => {
    // Attribution already re-extracts (fresh second read), so verification adds nothing.
    const viewClassHit = composeHierarchy({
      updatedAt: CACHED_UPDATED_AT,
      receivedAt: NOW - CACHE_AGE_MS,
      fresh: false,
      foregroundActivity: `${PLAYGROUND}/android.widget.FrameLayout`,
    });
    const { screen, hierarchy } = setup([viewClassHit, synced()]);

    const result = await screen.execute({ ...EXPLICIT_OBSERVE, verifyCachedHierarchy: true });

    expect(hierarchy.getCallCount()).toBe(2);
    expect(result.freshness).toMatchObject({ verified: true, isFresh: true });
  });

  test("when the verifying read fails the cached tree stays and says it is unverified", async () => {
    const { screen, hierarchy } = setup([cachedHit(), synced({ fresh: false })]);

    const result = await screen.execute({ ...EXPLICIT_OBSERVE, verifyCachedHierarchy: true });

    expect(hierarchy.getCallCount()).toBe(2);
    expect(result.updatedAt).toBe(CACHED_UPDATED_AT);
    expect(JSON.stringify(result.elements)).toContain("Regular Button");
    expect(JSON.stringify(result.elements)).not.toContain("pressed");
    expect(result.freshness).toMatchObject({ verified: false, isFresh: false });
    expect(result.freshness?.warning).toContain("without being re-verified");
  });

  test("a verifying read from another package never replaces the tree", async () => {
    const { screen } = setup([cachedHit(), synced({ packageName: "com.android.settings" })]);

    const result = await screen.execute({ ...EXPLICIT_OBSERVE, verifyCachedHierarchy: true });

    expect(result.viewHierarchy?.packageName).toBe(PLAYGROUND);
    expect(result.freshness?.verified).toBe(false);
  });

  test("session-free observer reads never verify", async () => {
    // Observer reads go through the capture seam; inject it so nothing dials a real client.
    const capture = new FakeHierarchyCapture(() => cachedHit());
    const { screen, hierarchy } = setup([cachedHit(), synced()], { hierarchyCapture: capture });

    await screen.execute({
      ...EXPLICIT_OBSERVE,
      observerMode: true,
      skipCache: true,
      verifyCachedHierarchy: true,
    });

    expect(hierarchy.getReadOptions().filter((options) => options !== undefined)).toEqual([]);
    expect(capture.requests).toHaveLength(1);
  });
});
