import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { pollObserveUntil } from "../../../src/features/observe/ObservePoll";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Unit tests for `pollObserveUntil`'s `minTimestamp` floor (issue #6284).
 *
 * The floor lives in ONE clock domain end-to-end: the device-authored
 * `updatedAt`. It is seeded from the caller's device-domain
 * `initialMinTimestampMs` (or from the first observation when unseeded), never
 * from the host clock, and only ever raised — so a device clock trailing the
 * daemon does not make fresh captures look stale, and a stale/cached poll
 * cannot lower it. All time control flows through FakeTimer; every test runs
 * well under 100ms and never touches a device or the DB.
 */

function obs(updatedAt: number, marker: string): ObserveResult {
  return {
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.example",
      hierarchy: { node: { marker } as any },
    },
  } as ObserveResult;
}

describe("pollObserveUntil minTimestamp floor (#6284)", () => {
  test("forces the first poll STRICTLY past the caller's DEVICE-domain seed, never the host clock", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    // Host clock is far ahead of the device clock (device trails the daemon).
    timer.advanceTime(1_000_000);
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(20, "a"), obs(30, "b")]);

    let polls = 0;
    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150, initialMinTimestampMs: 10 },
      () => ++polls >= 2,
    );

    expect(outcome.stopped).toBe(true);
    // First poll is forced strictly past the device-domain seed (10 -> 11), NOT
    // the host clock (1_000_000): it can neither re-read nor accept the entering
    // capture as terminal evidence (#6284 P1). Once a strictly-newer capture
    // (20) arrives the floor relaxes to the inclusive monotonic device floor.
    expect(fake.getExecuteMinTimestamps()).toEqual([11, 20]);
  });

  test("an unseeded first poll is a non-terminal baseline; terminal evidence must be strictly newer", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    timer.advanceTime(1_000_000); // host clock far ahead
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(100, "a"), obs(200, "b")]);

    // A predicate that would match on EVERY observation (including the pre-call
    // baseline). It must not terminate on the baseline — only on a genuine
    // post-invocation capture.
    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150 },
      () => true,
    );

    expect(outcome.stopped).toBe(true);
    // The baseline poll (100) is suppressed; the loop stops on poll 2 (200).
    expect(outcome.polls).toBe(2);
    expect(outcome.observation.updatedAt).toBe(200);
    // First poll: no floor (0), not the host clock. Second poll: forced strictly
    // past the baseline's own device timestamp (100 -> 101).
    expect(fake.getExecuteMinTimestamps()).toEqual([0, 101]);
  });

  test("a stale/cached poll cannot LOWER the monotonic floor", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Poll 3 returns an OLDER device timestamp (20) than poll 2 (30) — a stale
    // cache served by a timed-out sub-poll. The floor must stay at 30.
    fake.setObserveSequence([obs(10, "a"), obs(30, "b"), obs(20, "stale"), obs(40, "c")]);

    let polls = 0;
    await pollObserveUntil(fake, timer, { timeoutMs: 5000, pollMs: 150 }, () => ++polls >= 4);

    // minTimestamp: 0 (unseeded baseline) -> 11 (forced strictly past the
    // baseline 10, still no post-invocation capture) -> 30 (inclusive floor,
    // post-invocation reached) -> max(30,20)=30. The 4th poll's floor is 30, NOT
    // the stale 20 — the same stale hash cannot be re-served.
    expect(fake.getExecuteMinTimestamps()).toEqual([0, 11, 30, 30]);
  });

  test("a seeded poll that re-serves the entering capture is never accepted as terminal (#6284 P1)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // The delegate first re-serves the very entering capture (updatedAt 10 ===
    // the seed) before a genuinely-newer destination (20) arrives. A match on
    // the re-served entering capture would report a condition that may already
    // be false; only the strictly-newer capture may terminate.
    fake.setObserveSequence([obs(10, "entering"), obs(20, "destination")]);

    const matchedMarkers: string[] = [];
    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150, initialMinTimestampMs: 10 },
      (observation) => {
        matchedMarkers.push((observation.viewHierarchy!.hierarchy.node as any).marker as string);
        return true; // would match on every poll, including the re-served entering one
      },
    );

    expect(outcome.stopped).toBe(true);
    // Both polls were evaluated, but only the strictly-newer "destination"
    // terminated — the re-served "entering" capture was ignored as non-terminal.
    expect(matchedMarkers).toEqual(["entering", "destination"]);
    expect((outcome.observation.viewHierarchy!.hierarchy.node as any).marker).toBe("destination");
    expect(outcome.observation.updatedAt).toBe(20);
  });

  test("a screen-off (Asleep) capture fast-fails the loop rather than burning the budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([{ ...obs(10, "a"), wakefulness: "Asleep" } as ObserveResult]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150 },
      () => false,
    );

    expect(outcome.stopped).toBe(false);
    expect(outcome.polls).toBe(1);
  });
});
