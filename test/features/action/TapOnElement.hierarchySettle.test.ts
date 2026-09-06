import { describe, expect, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import type {
  ConditionEvaluation,
  ConditionPredicate,
  WaitForCondition,
} from "../../../src/features/observe/interfaces/WaitForCondition";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

// Issue #6266 (review on #6258): a hierarchy-only tap effect (activeWindow
// unchanged, only viewHierarchy differs) must be SETTLED — confirmed stable
// across consecutive polls, or promoted to an authoritative activeWindow
// change — before it is trusted as the terminal effect. Otherwise a transient
// intermediate mutation (a focused/selected/checked flip, or a partial
// hierarchy update before a delayed dialog/nav) can be returned in place of
// the actual destination.

function makeHierarchy(marker: string): ViewHierarchyResult {
  return { hierarchy: { node: { marker } } } as unknown as ViewHierarchyResult;
}

function makeObservation(overrides: Partial<ObserveResult>): ObserveResult {
  return {
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  };
}

function createTapOnElement(waitForCondition?: WaitForCondition): {
  tap: TapOnElement;
  timer: FakeTimer;
} {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    { timer, waitForCondition },
  );
  return { tap, timer };
}

/**
 * Simulates the real `pollObserveUntil` loop driving a `ConditionPredicate`
 * across a fixed sequence of subsequent poll observations, stopping as soon
 * as the predicate matches (mirroring the real poll's stop-on-match
 * semantics) and otherwise exhausting the sequence (timeout).
 */
function makeSequencedWaitForCondition(sequence: ObserveResult[]): WaitForCondition {
  return {
    execute: async (predicate: ConditionPredicate) => {
      let lastEvaluation: ConditionEvaluation = { matched: false, candidates: [] };
      let lastObservation = sequence[sequence.length - 1];
      for (const observation of sequence) {
        lastEvaluation = predicate(observation);
        lastObservation = observation;
        if (lastEvaluation.matched) {
          return {
            matched: true,
            candidates: [],
            observation,
            polls: 1,
            waitMs: 0,
            timedOut: false,
          };
        }
      }
      return {
        matched: false,
        candidates: lastEvaluation.candidates ?? [],
        observation: lastObservation,
        polls: sequence.length,
        waitMs: 0,
        timedOut: true,
      };
    },
  };
}

describe("deriveTapEffectAfterPostTapObservation settles hierarchy-only changes (#6266)", () => {
  const activeWindow = {
    appId: "com.example.app",
    activityName: "com.example.app.MainActivity",
    layoutSeqSum: 7,
  };

  test("returns the settled DESTINATION (dialog) rather than a transient intermediate flip", async () => {
    const previous = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline"),
    });
    // First post-tap frame: activeWindow unchanged, hierarchy shows a
    // transient attribute flip — NOT the real destination yet.
    const transientFlip = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline-focused-flip"),
    });
    const dialog = makeObservation({
      activeWindow, // dialogs don't move activeWindow (#6151)
      viewHierarchy: makeHierarchy("time-picker-dialog"),
    });

    const waitForCondition = makeSequencedWaitForCondition([dialog, dialog]);
    const { tap } = createTapOnElement(waitForCondition);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(
      previous,
      transientFlip,
    );

    expect(postTap.effect).toEqual({
      screenChanged: true,
      basis: "viewHierarchy changed",
    });
    expect(postTap.observation).toEqual(dialog);
  });

  test("does not report a spurious screen change when the transient flip reverts to baseline", async () => {
    const previous = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline"),
    });
    const transientFlip = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline-focused-flip"),
    });
    // Reverts back to the original baseline hierarchy and stays there.
    const reverted = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline"),
    });

    const waitForCondition = makeSequencedWaitForCondition([reverted, reverted]);
    const { tap } = createTapOnElement(waitForCondition);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(
      previous,
      transientFlip,
    );

    expect(postTap.effect?.screenChanged).toBe(false);
  });

  test("an activeWindow change is authoritative and returns immediately without settling", async () => {
    const previous = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline"),
    });
    const navigated = makeObservation({
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
    const { tap } = createTapOnElement(waitForCondition);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(previous, navigated);

    expect(waitCalls).toBe(0);
    expect(postTap.effect).toEqual({
      screenChanged: true,
      basis: "activeWindow changed",
    });
    expect(postTap.observation).toBe(navigated);
  });

  test("settles to an activeWindow change discovered mid-poll, stopping immediately", async () => {
    const previous = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline"),
    });
    const transientFlip = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline-focused-flip"),
    });
    const navigated = makeObservation({
      activeWindow: {
        ...activeWindow,
        activityName: "com.example.app.DetailActivity",
        layoutSeqSum: 8,
      },
      viewHierarchy: makeHierarchy("detail-screen"),
    });

    // The activeWindow-changed poll should match immediately (authoritative),
    // even though the hierarchy also changed from the prior poll's baseline.
    const waitForCondition = makeSequencedWaitForCondition([navigated]);
    const { tap } = createTapOnElement(waitForCondition);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(
      previous,
      transientFlip,
    );

    expect(postTap.effect).toEqual({
      screenChanged: true,
      basis: "activeWindow changed",
    });
    expect(postTap.observation).toEqual(navigated);
  });

  test("on settle timeout, falls back to the last-polled observation rather than blocking forever", async () => {
    const previous = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline"),
    });
    const transientFlip = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("baseline-focused-flip"),
    });
    // Keeps mutating every poll — never two consecutive equal hashes, and
    // activeWindow never changes. The sequenced fake exhausts and times out.
    const stillMoving1 = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("mutation-1"),
    });
    const stillMoving2 = makeObservation({
      activeWindow,
      viewHierarchy: makeHierarchy("mutation-2"),
    });

    const waitForCondition = makeSequencedWaitForCondition([stillMoving1, stillMoving2]);
    const { tap } = createTapOnElement(waitForCondition);

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(
      previous,
      transientFlip,
    );

    expect(postTap.observation).toEqual(stillMoving2);
    expect(postTap.effect?.screenChanged).toBe(true);
    expect(postTap.effect?.basis).toBe("viewHierarchy changed");
  });
});
