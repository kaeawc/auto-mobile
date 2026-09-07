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
  test("seeds the first poll from the caller's DEVICE-domain floor, never the host clock", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    // Host clock is far ahead of the device clock (device trails the daemon).
    timer.advanceTime(1_000_000);
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(10, "a"), obs(20, "b")]);

    let polls = 0;
    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150, initialMinTimestampMs: 10 },
      () => ++polls >= 2,
    );

    expect(outcome.stopped).toBe(true);
    // First poll floors on the device-domain seed (10), NOT the host clock
    // (1_000_000). A host-domain floor would reject every genuinely fresh
    // device capture and burn the whole budget.
    expect(fake.getExecuteMinTimestamps()).toEqual([10, 10]);
  });

  test("with no seed, the first poll floors at 0 (no host clock) then seeds from the first observation's device timestamp", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    timer.advanceTime(1_000_000); // host clock far ahead
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(100, "a"), obs(200, "b")]);

    let polls = 0;
    await pollObserveUntil(fake, timer, { timeoutMs: 5000, pollMs: 150 }, () => ++polls >= 2);

    // First poll: no floor (0), not the host clock. Second poll: floor seeded
    // from the FIRST observation's own device timestamp (100).
    expect(fake.getExecuteMinTimestamps()).toEqual([0, 100]);
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

    // floor: undefined -> 10 -> 30 -> max(30,20)=30 -> 40. The 4th poll's floor
    // is 30, NOT the stale 20 — so the same stale hash cannot be re-served.
    expect(fake.getExecuteMinTimestamps()).toEqual([0, 10, 30, 30]);
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
