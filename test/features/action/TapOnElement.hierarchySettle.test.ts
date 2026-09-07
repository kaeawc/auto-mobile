import { describe, expect, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { RealWaitForCondition } from "../../../src/features/observe/WaitForCondition";
import type { WaitForCondition } from "../../../src/features/observe/interfaces/WaitForCondition";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Issue #6284: a hierarchy-ONLY post-tap change (activeWindow unchanged, only
 * viewHierarchy differs) must be SETTLED across a real stability interval —
 * confirmed stable across consecutive polls, or promoted to an authoritative
 * activeWindow change — before it is trusted as the terminal effect. A
 * transient intermediate mutation (a focused/selected/checked flip, a partial
 * hierarchy update before a delayed dialog/nav) must not be returned in place
 * of the actual destination, AND a later destination must not be missed
 * (`baseline → A → A → B` reaches B).
 *
 * These tests drive the REAL settle loop (`pollObserveUntil` + the settle
 * predicate) through `RealWaitForCondition` over a scripted `FakeObserveScreen`
 * sequence, with all time controlled by FakeTimer, so the device-clock-domain
 * monotonic floor and the two-consecutive-poll stability rule are exercised
 * together. Every test runs well under 100ms and never touches a device or DB.
 */

const activeWindow = {
  appId: "com.example.app",
  activityName: "com.example.app.MainActivity",
  layoutSeqSum: 7,
};

function makeHierarchy(marker: string): ViewHierarchyResult {
  return {
    packageName: "com.example.app",
    hierarchy: { node: { marker } },
  } as unknown as ViewHierarchyResult;
}

function makeObservation(overrides: Partial<ObserveResult>): ObserveResult {
  const hierarchy = overrides.viewHierarchy;
  const updatedAt = overrides.updatedAt ?? 1;
  return {
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow,
    ...overrides,
    // The polling contract accepts only device-authored hierarchy timestamps.
    // Give each fixture its stated timestamp there too, rather than accidentally
    // exercising timeout fallback with only the outer host-style metadata.
    viewHierarchy:
      hierarchy === undefined
        ? undefined
        : ({ ...hierarchy, updatedAt: hierarchy.updatedAt ?? updatedAt } as ViewHierarchyResult),
  } as ObserveResult;
}

function createTapOnElement(waitForCondition?: WaitForCondition): TapOnElement {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    { timer, waitForCondition },
  );
}

/** A TapOnElement wired to a real settle loop over a scripted observe sequence. */
function createTapWithSettleSequence(settleFrames: ObserveResult[]): TapOnElement {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const fake = new FakeObserveScreen();
  fake.setObserveSequence(settleFrames);
  const waitForCondition = new RealWaitForCondition(fake, timer);
  return new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    { timer, waitForCondition },
  );
}

describe("deriveTapEffectAfterPostTapObservation settles hierarchy-only changes (#6284)", () => {
  test("baseline -> A -> A -> B reaches the settled destination B, not the transient A", async () => {
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("baseline") });
    // Entering capture: a transient hierarchy flip (activeWindow unchanged).
    const transientA = makeObservation({ updatedAt: 10, viewHierarchy: makeHierarchy("A") });
    // Settle poll frames: one more A, then the real destination B stabilises.
    const tap = createTapWithSettleSequence([
      makeObservation({ updatedAt: 20, viewHierarchy: makeHierarchy("A") }),
      makeObservation({ updatedAt: 30, viewHierarchy: makeHierarchy("B") }),
      makeObservation({ updatedAt: 40, viewHierarchy: makeHierarchy("B") }),
      makeObservation({ updatedAt: 50, viewHierarchy: makeHierarchy("B") }),
    ]);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(previous, transientA);

    expect(postTap.effect).toEqual({ screenChanged: true, basis: "viewHierarchy changed" });
    expect((postTap.observation.viewHierarchy.hierarchy.node as any).marker).toBe("B");
  });

  test("a transient A that persists BEYOND one poll interval before B still reaches B (#6284 P1)", async () => {
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("baseline") });
    const transientA = makeObservation({ updatedAt: 10, viewHierarchy: makeHierarchy("A") });
    // A holds for two poll frames (a normal delay for the transitions this
    // targets) before the real destination B arrives. A comparison-count settle
    // would lock onto A after a single interval; the wall-clock quiet-period
    // deadline requires A to hold for the FULL quiet period, which it never does
    // — B arrives first and is reached.
    const tap = createTapWithSettleSequence([
      makeObservation({ updatedAt: 20, viewHierarchy: makeHierarchy("A") }),
      makeObservation({ updatedAt: 30, viewHierarchy: makeHierarchy("A") }),
      makeObservation({ updatedAt: 40, viewHierarchy: makeHierarchy("B") }),
      makeObservation({ updatedAt: 50, viewHierarchy: makeHierarchy("B") }),
      makeObservation({ updatedAt: 60, viewHierarchy: makeHierarchy("B") }),
    ]);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(previous, transientA);

    expect(postTap.effect).toEqual({ screenChanged: true, basis: "viewHierarchy changed" });
    expect((postTap.observation.viewHierarchy.hierarchy.node as any).marker).toBe("B");
  });

  test("a same-activity dialog (activeWindow unchanged) settles and is reported changed (#6151)", async () => {
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("alarm-list") });
    // Dialogs don't move activeWindow; only the hierarchy reflects them.
    const dialog = makeObservation({ updatedAt: 10, viewHierarchy: makeHierarchy("time-picker") });
    const tap = createTapWithSettleSequence([
      makeObservation({ updatedAt: 20, viewHierarchy: makeHierarchy("time-picker") }),
      makeObservation({ updatedAt: 30, viewHierarchy: makeHierarchy("time-picker") }),
    ]);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(previous, dialog);

    expect(postTap.effect).toEqual({ screenChanged: true, basis: "viewHierarchy changed" });
    expect((postTap.observation.viewHierarchy.hierarchy.node as any).marker).toBe("time-picker");
  });

  test("a transient flip that reverts to baseline reports no screen change", async () => {
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("baseline") });
    const transientA = makeObservation({ updatedAt: 10, viewHierarchy: makeHierarchy("A") });
    // Reverts to the original baseline and stays there.
    const tap = createTapWithSettleSequence([
      makeObservation({ updatedAt: 20, viewHierarchy: makeHierarchy("baseline") }),
      makeObservation({ updatedAt: 30, viewHierarchy: makeHierarchy("baseline") }),
      makeObservation({ updatedAt: 40, viewHierarchy: makeHierarchy("baseline") }),
    ]);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(previous, transientA);

    expect(postTap.effect?.screenChanged).toBe(false);
  });

  test("a definitive screen-off (Asleep) terminal preserves screenChanged:true (assert the effect)", async () => {
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("baseline") });
    const transientA = makeObservation({ updatedAt: 10, viewHierarchy: makeHierarchy("A") });
    // The device goes to sleep mid-settle: the first settle poll is a screen-off
    // capture with no viewHierarchy. Re-deriving over it would find only an
    // unchanged activeWindow and erase the transition — the terminal must keep
    // the already-established screenChanged:true.
    const tap = createTapWithSettleSequence([
      makeObservation({ updatedAt: 20, wakefulness: "Asleep", viewHierarchy: undefined }),
    ]);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(previous, transientA);

    expect(postTap.effect).toEqual({ screenChanged: true, basis: "viewHierarchy changed" });
    expect(postTap.observation.wakefulness).toBe("Asleep");
  });

  test("an activeWindow change is authoritative and returns immediately WITHOUT settling", async () => {
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("baseline") });
    const navigated = makeObservation({
      updatedAt: 10,
      activeWindow: {
        ...activeWindow,
        activityName: "com.example.app.DetailActivity",
        layoutSeqSum: 8,
      },
      viewHierarchy: makeHierarchy("detail-screen"),
    });

    let waitCalls = 0;
    const waitForCondition: WaitForCondition = {
      execute: async () => {
        waitCalls++;
        throw new Error("must not poll for an authoritative activeWindow change");
      },
    };
    const tap = createTapOnElement(waitForCondition);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(previous, navigated);

    expect(waitCalls).toBe(0);
    expect(postTap.effect).toEqual({ screenChanged: true, basis: "activeWindow changed" });
    expect(postTap.observation).toBe(navigated);
  });
});

describe("freshness realignment at hierarchy-replace sites (#6284)", () => {
  test("replaceObservationHierarchy promotes a cache_age stale verdict to fresh when refreshed from device", () => {
    const tap = createTapOnElement();
    const observation = makeObservation({
      viewHierarchy: makeHierarchy("stale"),
      screenSize: { width: 1, height: 1 },
      freshness: {
        isFresh: false,
        verified: false,
        category: "cache_age",
        warning: "served from host-side cache without re-verification",
      },
    });
    const fresh = {
      packageName: "com.example.app",
      hierarchy: { node: { marker: "fresh" } },
      updatedAt: 42,
      screenWidth: 1080,
      screenHeight: 1920,
    } as unknown as ViewHierarchyResult;

    (tap as any).replaceObservationHierarchy(observation, fresh, true);

    expect(observation.viewHierarchy).toBe(fresh);
    expect(observation.screenSize).toEqual({ width: 1080, height: 1920 });
    expect(observation.freshness?.isFresh).toBe(true);
    expect(observation.freshness?.verified).toBe(true);
    expect(observation.freshness?.warning).toBeUndefined();
    expect(observation.freshness?.category).toBeUndefined();
    // The result carries the device capture time, never the FakeTimer/host
    // clock used to measure the surrounding action.
    expect(observation.freshness?.actualTimestamp).toBe(42);
    expect(observation.updatedAt).toBe(42);
  });

  test("replaceObservationHierarchy does not promote an incomplete live replacement", () => {
    const tap = createTapOnElement();
    const staleFreshness = {
      isFresh: false as const,
      verified: false,
      category: "cache_age" as const,
      warning: "served from host-side cache without re-verification",
    };
    const observation = makeObservation({
      viewHierarchy: makeHierarchy("old"),
      freshness: { ...staleFreshness },
    });
    const incomplete = {
      packageName: "com.example.app",
      hierarchy: { node: { marker: "partial" } },
      updatedAt: 42,
      ctrlProxyIncomplete: true,
    } as unknown as ViewHierarchyResult;

    (tap as any).replaceObservationHierarchy(observation, incomplete, true);

    expect(observation.viewHierarchy).toBe(incomplete);
    expect(observation.freshness).toEqual(staleFreshness);
  });

  test("replaceObservationHierarchy does NOT promote a non-cache-age freshness failure (#6284 P1)", () => {
    const tap = createTapOnElement();
    // A wrong-window / attribution failure is NOT resolved by swapping in a
    // freshly-captured hierarchy (which may itself be from the wrong window):
    // the refresh recollected only viewHierarchy, not activeWindow/attribution.
    const windowIdentityFailure = {
      isFresh: false as const,
      verified: false,
      category: "window_identity" as const,
      warning:
        "Observed hierarchy is from com.other, but the device's current top resumed activity is com.example.app.",
    };
    const observation = makeObservation({
      viewHierarchy: makeHierarchy("wrong-window"),
      freshness: { ...windowIdentityFailure },
    });
    const fresh = {
      packageName: "com.example.app",
      hierarchy: { node: { marker: "fresh" } },
      screenWidth: 1080,
      screenHeight: 1920,
    } as unknown as ViewHierarchyResult;

    (tap as any).replaceObservationHierarchy(observation, fresh, true);

    expect(observation.viewHierarchy).toBe(fresh);
    // The hierarchy was swapped, but the wrong-window verdict must survive — the
    // result must not be forged trustworthy.
    expect(observation.freshness).toEqual(windowIdentityFailure);
  });

  test("replaceObservationHierarchy leaves freshness untouched when NOT refreshed from device", () => {
    const tap = createTapOnElement();
    const staleFreshness = {
      isFresh: false,
      verified: false,
      warning: "served from host-side cache without re-verification",
    };
    const observation = makeObservation({
      viewHierarchy: makeHierarchy("old"),
      freshness: { ...staleFreshness },
    });
    const replacement = makeHierarchy("same-in-hand");

    (tap as any).replaceObservationHierarchy(observation, replacement, false);

    expect(observation.viewHierarchy).toBe(replacement);
    // No live re-capture happened, so the verdict must not be forged fresh.
    expect(observation.freshness).toEqual(staleFreshness);
  });
});

describe("enforceFreshnessConsistencyWithEffect and the screen-off terminal (#6284)", () => {
  test("does NOT retract freshness on a definitive screen-off terminal", () => {
    const tap = createTapOnElement();
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("baseline") });
    const asleep = makeObservation({
      updatedAt: 10,
      wakefulness: "Asleep",
      wakefulnessSource: "adb",
      viewHierarchy: undefined,
      freshness: { isFresh: true, verified: true },
    });
    const result = {
      effect: { screenChanged: true, basis: "viewHierarchy changed" as const },
      observation: asleep,
    };

    (tap as any).enforceFreshnessConsistencyWithEffect(previous, result);

    // The screen-off capture is the real post-tap state, not a stale pre-tap
    // tree — its freshness must be left intact.
    expect(result.observation.freshness).toEqual({ isFresh: true, verified: true });
  });

  test("does not promote stale Asleep fallback after a settle timeout", async () => {
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("baseline") });
    const transientA = makeObservation({ updatedAt: 10, viewHierarchy: makeHierarchy("A") });
    const staleAsleep = makeObservation({
      updatedAt: 10,
      wakefulness: "Asleep",
      wakefulnessSource: "hierarchy",
      viewHierarchy: makeHierarchy("cached-asleep"),
      freshness: { isFresh: false, verified: false, category: "cache_age" },
    });
    const tap = createTapWithSettleSequence([staleAsleep]);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(previous, transientA);

    expect(postTap.observation.wakefulness).not.toBe("Asleep");
    expect((postTap.observation.viewHierarchy.hierarchy.node as any).marker).toBe("A");
  });

  test("still retracts freshness on a live-hierarchy observation that predates the transition", () => {
    const tap = createTapOnElement();
    const previous = makeObservation({ updatedAt: 1, viewHierarchy: makeHierarchy("baseline") });
    // The returned observation still shows the pre-tap baseline while the effect
    // claims a change: freshness must be retracted so the client re-observes.
    const result = {
      effect: { screenChanged: true, basis: "viewHierarchy changed" as const },
      observation: makeObservation({
        updatedAt: 10,
        viewHierarchy: makeHierarchy("baseline"),
        freshness: { isFresh: true, verified: true },
      }),
    };

    (tap as any).enforceFreshnessConsistencyWithEffect(previous, result);

    expect(result.observation.freshness?.isFresh).toBe(false);
    expect(result.observation.freshness?.verified).toBe(false);
    expect(result.observation.freshness?.warning).toContain("predates the detected transition");
  });
});
