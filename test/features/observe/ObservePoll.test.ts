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
      updatedAt,
    },
  } as ObserveResult;
}

describe("pollObserveUntil minTimestamp floor (#6284)", () => {
  test.each([undefined, true])(
    "forwards the push-wait opt-out without changing floors (%s)",
    async (skipWaitForFresh) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const fake = new FakeObserveScreen();
      fake.setObserveSequence([obs(20, "stable"), obs(20, "stable")]);
      const outcome = await pollObserveUntil(
        fake,
        timer,
        { timeoutMs: 1000, pollMs: 150, initialMinTimestampMs: 10, skipWaitForFresh },
        (_observation, previous) => previous !== undefined,
      );
      expect(outcome.stopped).toBe(true);
      expect(fake.getExecuteMinTimestamps()).toEqual([11, 20]);
      expect(fake.getExecuteOptions().map((options) => options.skipWaitForFresh)).toEqual([
        skipWaitForFresh ?? false,
        skipWaitForFresh ?? false,
      ]);
    },
  );

  test("admits only post-baseline evidence after exact poll intervals and preserves cache ordering", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    const baseline = obs(10, "baseline");
    const stale = obs(30, "stale");
    stale.freshness = { isFresh: false, verified: false };
    const fresh = obs(20, "fresh");
    fake.setObserveSequence([baseline, stale, fresh]);
    const calls: Array<{
      observation: ObserveResult;
      previous: ObserveResult | undefined;
      time: number;
    }> = [];
    const pending = pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 25, pollMs: 10 },
      (observation, previous) => {
        calls.push({ observation, previous, time: timer.now() });
        return true;
      },
    );
    for (let turn = 0; turn < 20; turn++) {
      await Promise.resolve();
    }
    expect(fake.getExecuteCallCount()).toBe(1);
    timer.advanceTime(9);
    for (let turn = 0; turn < 20; turn++) {
      await Promise.resolve();
    }
    expect(fake.getExecuteCallCount()).toBe(1);
    timer.advanceTime(1);
    for (let turn = 0; turn < 20; turn++) {
      await Promise.resolve();
    }
    expect(fake.getExecuteCallCount()).toBe(2);
    timer.advanceTime(10);
    const outcome = await pending;
    expect(calls).toEqual([
      { observation: baseline, previous: undefined, time: 0 },
      { observation: fresh, previous: baseline, time: 20 },
    ]);
    expect(outcome).toMatchObject({
      observation: fresh,
      polls: 3,
      waitMs: 20,
      terminalReason: "matched",
    });
    expect(
      fake.getExecuteOptions().map((options) => [options.minTimestamp, options.timeoutMs]),
    ).toEqual([
      [0, 25],
      [11, 15],
      [11, 5],
    ]);
    expect(timer.getSleepHistory()).toEqual([10, 10]);
    expect(fake.getExecutedOperations()).toEqual([
      "execute",
      "execute",
      "execute",
      "collectDeferredBackStack",
      "cacheObserveResult",
    ]);
  });

  test("caps a long poll sleep at the remaining budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(10, "baseline"));

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 10000 },
      () => false,
    );

    expect(timer.getSleepHistory()).toEqual([100]);
    expect(outcome).toMatchObject({ polls: 1, waitMs: 100, terminalReason: "timeout" });
  });

  test("rejects an abort while the poll sleep is still pending", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(10, "baseline"));
    const controller = new AbortController();
    const pending = pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 10000, signal: controller.signal },
      () => false,
    );
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(timer.getPendingSleepCount()).toBe(1);
    controller.abort(new Error("cancel poll sleep"));
    // Give cancellation a chance to settle without resolving the fake sleep.
    const settled = await Promise.race([
      pending.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      (async () => {
        for (let i = 0; i < 20; i++) {
          await Promise.resolve();
        }
        return "still pending";
      })(),
    ]);
    try {
      expect(settled).toBeInstanceOf(Error);
      expect(settled).toMatchObject({ message: "Operation cancelled" });
      expect(timer.now()).toBe(0);
      expect(timer.getPendingSleepCount()).toBe(1);
    } finally {
      timer.resolveAll();
      await pending.catch(() => undefined);
    }
  });

  test("returns the last trustworthy observation when sleep passes the deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const last = obs(20, "last");
    fake.setObserveSequence([obs(10, "baseline"), last]);
    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 60 },
      () => false,
    );
    expect(outcome).toMatchObject({ polls: 2, stopped: false, terminalReason: "timeout" });
    expect(outcome.observation).toBe(last);
    expect(fake.getExecuteCallCount()).toBe(2);
    expect(fake.getExecuteOptions().map((options) => options.timeoutMs)).toEqual([100, 40]);
    expect(timer.getSleepHistory()).toEqual([60, 40]);
  });

  test("returns the last received observation when no complete hierarchy was trustworthy", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const incomplete = { ...obs(10, "incomplete"), viewHierarchy: undefined };
    fake.setObserveResult(incomplete);
    const outcome = await pollObserveUntil(fake, timer, { timeoutMs: 50, pollMs: 60 }, () => false);
    expect(outcome).toMatchObject({ polls: 1, terminalReason: "timeout" });
    expect(outcome.observation).toBe(incomplete);
    expect(fake.getExecuteCallCount()).toBe(1);
  });
  test("passes the remaining poll deadline into each device observation", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(10, "baseline"), obs(20, "fresh")]);
    await pollObserveUntil(fake, timer, { timeoutMs: 1000, pollMs: 150 }, () => true);
    expect(fake.getExecuteOptions().map((options) => options.timeoutMs)).toEqual([1000, 850]);
  });
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

    await pollObserveUntil(fake, timer, { timeoutMs: 5000, pollMs: 150 }, (observation) => {
      return (observation.viewHierarchy!.hierarchy.node as any).marker === "c";
    });

    // minTimestamp: 0 (unseeded baseline) -> 11 (forced strictly past the
    // baseline 10, still no post-invocation capture) -> 30 (inclusive floor,
    // post-invocation reached) -> max(30,20)=30. The 4th poll's floor is 30, NOT
    // the stale 20 — the same stale hash cannot be re-served.
    expect(fake.getExecuteMinTimestamps()).toEqual([0, 11, 30, 30]);
  });

  test("does not accept or return a regressed terminal sample after raising the floor", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // The final 20 is later than the entering baseline (10), but it is older
    // than the 30 already accepted into the device floor. It must not become
    // terminal evidence or replace the newer trustworthy evidence on timeout.
    fake.setObserveSequence([obs(10, "baseline"), obs(30, "newest"), obs(20, "regressed")]);
    let polls = 0;

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 301, pollMs: 150 },
      () => ++polls >= 3,
    );

    expect(outcome.stopped).toBe(false);
    expect((outcome.observation.viewHierarchy!.hierarchy.node as any).marker).toBe("newest");
    expect(outcome.observation.updatedAt).toBe(30);
    expect(fake.getCollectDeferredBackStackObservations()).toEqual([outcome.observation]);
    expect(fake.getCacheObserveResultObservations()).toEqual([outcome.observation]);
    expect(fake.getExecuteMinTimestamps()).toEqual([0, 11, 30]);
  });

  test("does not let below-floor or explicitly stale frames advance a stateful predicate", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const stale = {
      ...obs(20, "regressed"),
      freshness: { isFresh: false, verified: false, category: "window_identity" },
    } as ObserveResult;
    fake.setObserveSequence([obs(10, "baseline"), obs(30, "B"), stale, obs(40, "A")]);
    const seen: string[] = [];

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 451, pollMs: 150 },
      (value) => {
        seen.push((value.viewHierarchy!.hierarchy.node as any).marker);
        return false;
      },
    );

    expect(seen).toEqual(["baseline", "B", "A"]);
    expect((outcome.observation.viewHierarchy!.hierarchy.node as any).marker).toBe("A");
  });

  test("does not use a host-created observation timestamp as a device floor", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const hostStampedPartial = {
      ...obs(1_000_000, "partial"),
      // A base observation's top-level timestamp is host metadata. No
      // hierarchy timestamp means this capture cannot establish device
      // freshness or be accepted as terminal evidence.
      viewHierarchy: { packageName: "com.example", hierarchy: { node: { marker: "partial" } } },
    } as ObserveResult;
    fake.setObserveSequence([hostStampedPartial, obs(20, "device-baseline"), obs(30, "device")]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150 },
      () => true,
    );

    expect(outcome.stopped).toBe(true);
    expect(outcome.observation.updatedAt).toBe(30);
    // The second read is still unfloored: no device timestamp was available
    // from the partial first result to turn into a device-side minTimestamp.
    // It establishes the actual device baseline for the third read.
    expect(fake.getExecuteMinTimestamps()).toEqual([0, 0, 21]);
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

  test("does not accept an unseeded cached hierarchy screen-off before a post-invocation capture", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const cachedAsleep = {
      ...obs(10, "cached-asleep"),
      wakefulness: "Asleep",
      wakefulnessSource: "hierarchy",
      freshness: { isFresh: true, verified: true },
    } as ObserveResult;
    const awake = { ...obs(20, "awake"), wakefulness: "Awake" } as ObserveResult;
    fake.setObserveSequence([cachedAsleep, awake]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150 },
      () => true,
    );

    expect(outcome.stopped).toBe(true);
    expect(outcome.polls).toBe(2);
    expect(outcome.observation).toBe(awake);
  });

  test("does not accept an equal-timestamp delegate-unverified cache entry", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const unverifiedFallback = {
      ...obs(20, "cached"),
      freshness: { isFresh: true, verified: false },
    } as ObserveResult;
    fake.setObserveSequence([unverifiedFallback, obs(30, "verified")]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150, initialMinTimestampMs: 10 },
      () => true,
    );

    expect(outcome.stopped).toBe(true);
    expect(outcome.polls).toBe(2);
    expect((outcome.observation.viewHierarchy!.hierarchy.node as any).marker).toBe("verified");
  });

  test("does not fast-fail on a stale Asleep cache entry", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const staleAsleep = {
      ...obs(10, "cached-asleep"),
      wakefulness: "Asleep",
      freshness: { isFresh: true, verified: false },
    } as ObserveResult;
    fake.setObserveSequence([staleAsleep, obs(20, "awake")]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150, initialMinTimestampMs: 10 },
      () => true,
    );

    expect(outcome.stopped).toBe(true);
    expect(outcome.polls).toBe(2);
    expect(outcome.observation.wakefulness).not.toBe("Asleep");
  });

  test("returns a live independently sampled rootless Asleep state", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const rootlessAsleep = {
      ...obs(20, "rootless"),
      wakefulness: "Asleep",
      wakefulnessSource: "adb",
      viewHierarchy: undefined,
    } as ObserveResult;
    fake.setObserveSequence([obs(10, "awake"), rootlessAsleep]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 5000, pollMs: 150 },
      () => false,
    );

    expect(outcome.terminalReason).toBe("screen_off");
    expect(outcome.observation).toBe(rootlessAsleep);
  });

  test("does not label an all-stale Asleep timeout as a screen-off terminal", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const staleAsleep = {
      ...obs(10, "cached-asleep"),
      wakefulness: "Asleep",
      wakefulnessSource: "hierarchy",
      freshness: { isFresh: false, verified: false, category: "cache_age" },
    } as ObserveResult;
    fake.setObserveSequence([staleAsleep]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 300, pollMs: 150, initialMinTimestampMs: 10 },
      () => false,
    );

    expect(outcome.terminalReason).toBe("timeout");
    expect(outcome.observation.wakefulness).toBe("Asleep");
  });
});

describe("pollObserveUntil cache writes", () => {
  test("writes only the matched observation after three polls without changing the result", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const baseline = obs(10, "baseline");
    const intermediate = obs(20, "intermediate");
    const matched = obs(30, "matched");
    fake.setObserveSequence([baseline, intermediate, matched]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 1000, pollMs: 150 },
      (observation) => observation === matched,
    );

    expect(outcome.observation).toBe(matched);
    expect(outcome.observation).toEqual(matched);
    expect(outcome).toMatchObject({ polls: 3, stopped: true, terminalReason: "matched" });
    expect(fake.getExecuteOptions().map((options) => options.skipCache)).toEqual([
      true,
      true,
      true,
    ]);
    expect(fake.getExecuteOptions().every((options) => options.skipBackStack === true)).toBe(true);
    expect(fake.getCollectDeferredBackStackObservations()).toEqual([outcome.observation]);
    expect(fake.getCacheObserveResultObservations()).toEqual([outcome.observation]);
  });

  test("writes the last returned observation on timeout", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const last = obs(20, "last");
    fake.setObserveSequence([obs(10, "baseline"), last]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 60 },
      () => false,
    );

    expect(outcome).toMatchObject({ polls: 2, stopped: false, terminalReason: "timeout" });
    expect(outcome.observation).toBe(last);
    expect(outcome.observation).toEqual(last);
    expect(fake.getCollectDeferredBackStackObservations()).toEqual([outcome.observation]);
    expect(fake.getCacheObserveResultObservations()).toEqual([outcome.observation]);
  });

  test("does not write when aborted between polls", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(10, "baseline"));
    const controller = new AbortController();

    await expect(
      pollObserveUntil(
        fake,
        timer,
        { timeoutMs: 100, pollMs: 10, signal: controller.signal },
        () => {
          controller.abort();
          return false;
        },
      ),
    ).rejects.toThrow();

    expect(fake.getCollectDeferredBackStackCallCount()).toBe(0);
    expect(fake.getCacheObserveResultCallCount()).toBe(0);
  });
});

describe("pollObserveUntil recomposition tracking (#6932)", () => {
  test("returns the terminal observation when cache finalization exceeds the remaining poll budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const terminal = obs(20, "terminal");
    fake.setObserveResult(terminal);
    fake.setNeverResolving("cacheObserveResult", true);

    const outcomePromise = pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 10, initialMinTimestampMs: 10, skipRecompositionTracking: true },
      () => true,
    );

    const outcome = await outcomePromise;

    expect(outcome.observation).toBe(terminal);
    expect(fake.getProcessRecompositionCallCount()).toBe(1);
    expect(fake.getCacheObserveResultCallCount()).toBe(1);
  });

  test("returns the terminal observation when finalization is aborted after the loop settles", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    const terminal = obs(20, "terminal");
    const controller = new AbortController();
    fake.setObserveResult(terminal);
    fake.setNeverResolving("processRecomposition", true);

    const outcomePromise = pollObserveUntil(
      fake,
      timer,
      {
        timeoutMs: 100,
        pollMs: 10,
        initialMinTimestampMs: 10,
        signal: controller.signal,
        skipRecompositionTracking: true,
      },
      () => true,
    );
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(fake.getProcessRecompositionCallCount()).toBe(1);
    controller.abort();

    const outcome = await outcomePromise;

    expect(outcome.observation).toBe(terminal);
    expect(fake.getProcessRecompositionCallCount()).toBe(1);
  });

  test("does not process a stale independently sampled Asleep hierarchy but caches its return", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const staleAsleep = {
      ...obs(20, "stale-asleep"),
      wakefulness: "Asleep",
      wakefulnessSource: "adb",
      freshness: { isFresh: false, verified: false, category: "cache_age" },
    } as ObserveResult;
    fake.setObserveResult(staleAsleep);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 1000, pollMs: 150, initialMinTimestampMs: 10, skipRecompositionTracking: true },
      () => false,
    );

    expect(outcome.terminalReason).toBe("screen_off");
    expect(fake.getProcessRecompositionCallCount()).toBe(0);
    expect(fake.getCollectDeferredBackStackObservations()).toEqual([outcome.observation]);
    expect(fake.getCacheObserveResultObservations()).toEqual([outcome.observation]);
  });

  test("persists the terminal observation with its captured cache generation", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const terminal = obs(30, "terminal");
    fake.setObserveSequence([obs(10, "baseline"), obs(20, "intermediate"), terminal]);
    fake.setCacheGenerationSequence([17, 23, 29]);

    await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 1000, pollMs: 150, skipRecompositionTracking: true },
      (observation) => observation === terminal,
    );

    expect(fake.getCacheObserveResultObservations()).toEqual([terminal]);
    expect(fake.getCacheObserveResultGenerations()).toEqual([29]);
  });

  test("persists a deferred terminal observation at its poll-start HOST time despite future device time (#6999 round 5)", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const terminal = obs(1_600_000, "future-device-terminal");
    fake.setObserveSequence([obs(10, "baseline"), terminal]);

    await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 1000, pollMs: 150, skipRecompositionTracking: true },
      (observation) => observation === terminal,
    );

    // The second poll begins after the 150ms interval. Its device-authored
    // timestamp is deliberately far ahead and must never enter cache recency.
    expect(fake.getCacheObserveResultCachedAts()).toEqual([1_000_150]);
  });

  test("skips every poll and processes only the terminal observation once", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const terminal = obs(30, "terminal");
    fake.setObserveSequence([obs(10, "baseline"), obs(20, "intermediate"), terminal]);

    await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 1000, pollMs: 150, skipRecompositionTracking: true },
      (observation) => observation === terminal,
    );

    expect(fake.getExecuteOptions().every((option) => option.skipRecompositionTracking)).toBe(true);
    expect(fake.getProcessRecompositionCallCount()).toBe(1);
    expect(fake.getProcessRecompositionObservations()).toEqual([terminal]);
    expect(fake.getCacheObserveResultCallCount()).toBe(1);
    expect(fake.getCacheObserveResultObservations()).toEqual([terminal]);
  });

  test("does not process an all-stale timeout fallback but caches its return", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const stale = {
      ...obs(10, "cached-stale"),
      freshness: { isFresh: false, verified: false, category: "cache_age" },
    } as ObserveResult;
    fake.setObserveSequence([stale]);

    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 300, pollMs: 150, initialMinTimestampMs: 10, skipRecompositionTracking: true },
      () => false,
    );

    expect(outcome.terminalReason).toBe("timeout");
    expect(outcome.observation).toBe(stale);
    expect(fake.getProcessRecompositionCallCount()).toBe(0);
    expect(fake.getCollectDeferredBackStackObservations()).toEqual([outcome.observation]);
    expect(fake.getCacheObserveResultObservations()).toEqual([outcome.observation]);
  });
});

describe("pollObserveUntil deferred back stack (D42/#6598)", () => {
  test.each([3, 5])("%i polls collect only the returned back stack before caching", async (n) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult((i) => obs(i + 10, "stable"));
    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 1000, pollMs: 10 },
      (_observation, _previous, index) => index === n,
    );
    expect(outcome.polls).toBe(n);
    expect(fake.getExecuteCallCount()).toBe(n);
    expect(fake.getCollectDeferredBackStackObservations()).toEqual([outcome.observation]);
    expect(fake.getExecutedOperations()).toEqual([
      ...Array<string>(n).fill("execute"),
      "collectDeferredBackStack",
      "cacheObserveResult",
    ]);
    expect(fake.getExecuteOptions().every((o) => o.skipBackStack === true)).toBe(true);
  });

  test("disagreement takes one full poll and caches its own generation and start time", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    const original = obs(20, "matched");
    const refreshed = obs(30, "no-longer-matched");
    fake.setObserveSequence([original, refreshed]);
    fake.setDeferredBackStackDisagreement(true);
    fake.setCacheGenerationSequence([4, 5]);
    const collect = fake.collectDeferredBackStack.bind(fake);
    fake.collectDeferredBackStack = async (observation, options) => {
      timer.advanceTime(7);
      return collect(observation, options);
    };
    const execute = fake.execute.bind(fake);
    fake.execute = async (options) => {
      const result = await execute(options);
      timer.advanceTime(3);
      return result;
    };
    const predicateCalls: ObserveResult[] = [];
    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 10, initialMinTimestampMs: 10, skipRecompositionTracking: true },
      (observation) => {
        predicateCalls.push(observation);
        return observation === original;
      },
    );
    expect(outcome.observation).toBe(refreshed);
    expect(outcome).toMatchObject({
      polls: 2,
      waitMs: 13,
      stopped: false,
      terminalReason: "timeout",
    });
    expect(predicateCalls).toEqual([original, refreshed]);
    expect(fake.getExecuteOptions().map((o) => o.skipBackStack)).toEqual([true, undefined]);
    expect(fake.getExecuteOptions().every((o) => o.skipCache === true)).toBe(true);
    expect(fake.getCollectDeferredBackStackObservations()).toEqual([original]);
    expect(fake.getProcessRecompositionObservations()).toEqual([refreshed]);
    expect(fake.getCacheObserveResultObservations()).toEqual([refreshed]);
    expect(fake.getCacheObserveResultGenerations()).toEqual([5]);
    expect(fake.getCacheObserveResultCachedAts()).toEqual([10]);
  });

  test("disagreement on timeout takes one full poll beyond the exhausted budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const refreshed = obs(30, "newest");
    fake.setObserveSequence([obs(20, "original"), refreshed]);
    fake.setDeferredBackStackDisagreement(true);
    const outcome = await pollObserveUntil(fake, timer, { timeoutMs: 1, pollMs: 10 }, () => false);
    expect(outcome.observation).toBe(refreshed);
    expect(outcome).toMatchObject({ polls: 2, stopped: false, terminalReason: "timeout" });
    expect(fake.getExecuteOptions()[1]?.timeoutMs).toBeUndefined();
    expect(fake.getExecuteOptions()[1]?.minTimestamp).toBe(21);
    expect(fake.getExecuteOptions()[1]?.skipBackStack).toBeUndefined();
    expect(fake.getCacheObserveResultObservations()).toEqual([refreshed]);
    expect(fake.getCollectDeferredBackStackCallCount()).toBe(1);
  });

  test("abort during the extra poll rejects without a cache write", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    const controller = new AbortController();
    fake.setObserveResult(obs(20, "original"));
    fake.setDeferredBackStackDisagreement(true);
    const execute = fake.execute.bind(fake);
    fake.execute = async (options) => {
      const observation = await execute(options);
      if (fake.getExecuteCallCount() === 2) {
        expect(options?.signal).toBe(controller.signal);
        return new Promise<ObserveResult>(() => {});
      }
      return observation;
    };
    const pending = pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 10, initialMinTimestampMs: 10, signal: controller.signal },
      () => true,
    );
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
    controller.abort(new Error("cancel extra poll"));
    await expect(pending).rejects.toThrow("Operation cancelled");
    expect(fake.getExecuteCallCount()).toBe(2);
    expect(fake.getCacheObserveResultCallCount()).toBe(0);
  });

  test("extra poll failure returns the original with its terminal back stack", async () => {
    const fake = new FakeObserveScreen();
    const original = obs(20, "original");
    const backStack: NonNullable<ObserveResult["backStack"]> = {
      depth: 0,
      activities: [],
      tasks: [],
      source: "adb",
      capturedAt: 0,
      currentActivity: { name: "com.example.OtherActivity", taskId: 1 },
    };
    fake.setDeferredBackStack(backStack);
    fake.setDeferredBackStackDisagreement(true);
    fake.setObserveResult((index) => {
      if (index === 1) {
        throw new Error("extra poll failed");
      }
      return original;
    });
    const outcome = await pollObserveUntil(
      fake,
      new FakeTimer(),
      { timeoutMs: 100, pollMs: 10, initialMinTimestampMs: 10 },
      () => true,
    );
    expect(fake.getExecuteCallCount()).toBe(2);
    expect(outcome.observation).toBe(original);
    expect(outcome.observation.backStack).toBe(backStack);
    expect(fake.getCacheObserveResultObservations()).toEqual([original]);
    expect(fake.getCollectDeferredBackStackCallCount()).toBe(1);
  });

  test("explicit skipBackStack adapter omits both terminal read and extra poll", async () => {
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(20, "terminal"));
    fake.setDeferredBackStackDisagreement(true);
    const adapter = {
      execute: (options: Parameters<FakeObserveScreen["execute"]>[0]) =>
        fake.execute({ ...options, skipBackStack: true }),
      cacheObserveResult: fake.cacheObserveResult.bind(fake),
    };
    await pollObserveUntil(
      adapter,
      new FakeTimer(),
      { timeoutMs: 100, pollMs: 10, initialMinTimestampMs: 10 },
      () => true,
    );
    expect(fake.getExecuteCallCount()).toBe(1);
    expect(fake.getCollectDeferredBackStackCallCount()).toBe(0);
    expect(fake.getCacheObserveResultCallCount()).toBe(1);
  });

  test("screen-off terminal collects the returned back stack", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult({
      ...obs(20, "asleep"),
      wakefulness: "Asleep",
      wakefulnessSource: "adb",
    });
    const outcome = await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 10 },
      () => false,
    );
    expect(outcome.terminalReason).toBe("screen_off");
    expect(fake.getCollectDeferredBackStackObservations()).toEqual([outcome.observation]);
  });

  test("activity predicates keep per-poll reads and skip the terminal read", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(10, "baseline"), obs(20, "activity")]);
    fake.setDeferredBackStackDisagreement(true);
    await pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 100, pollMs: 10, readBackStackEachPoll: true },
      () => true,
    );
    expect(fake.getExecuteCallCount()).toBe(2);
    expect(fake.getExecuteOptions().map((o) => o.skipBackStack)).toEqual([undefined, undefined]);
    expect(fake.getCollectDeferredBackStackCallCount()).toBe(0);
  });

  test("unexpected terminal collector failure rejects without caching", async () => {
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(20, "terminal"));
    fake.setFailureMode("collectDeferredBackStack", new Error("collector failed"));
    await expect(
      pollObserveUntil(
        fake,
        new FakeTimer(),
        { timeoutMs: 100, pollMs: 10, initialMinTimestampMs: 10 },
        () => true,
      ),
    ).rejects.toThrow("collector failed");
    expect(fake.getCollectDeferredBackStackCallCount()).toBe(1);
    expect(fake.getCacheObserveResultCallCount()).toBe(0);
  });

  test("a pending terminal read survives the exhausted budget but aborts without caching", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(20, "terminal"));
    fake.setNeverResolving("collectDeferredBackStack", true);
    const controller = new AbortController();
    const pending = pollObserveUntil(
      fake,
      timer,
      { timeoutMs: 1, pollMs: 10, signal: controller.signal },
      () => false,
    );
    // Let the first execute schedule its sleep, then exhaust the fake budget.
    await Promise.resolve();
    timer.advanceTime(10);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    const readsBeforeAbort = fake.getCollectDeferredBackStackCallCount();
    controller.abort(new Error("cancel terminal"));
    await expect(pending).rejects.toThrow("cancel terminal");
    expect(timer.now()).toBeGreaterThanOrEqual(1);
    expect(readsBeforeAbort).toBe(1);
    expect(fake.getCacheObserveResultCallCount()).toBe(0);
  });
});

test("abort after terminal collection writes neither recomposition nor cache", async () => {
  const fake = new FakeObserveScreen();
  const controller = new AbortController();
  const terminal = obs(20, "terminal");
  fake.setObserveResult(terminal);
  fake.setDeferredBackStackDisagreement(true);
  const collect = fake.collectDeferredBackStack.bind(fake);
  fake.collectDeferredBackStack = async (observation, options): Promise<void> => {
    expect(options?.signal).toBe(controller.signal);
    await collect(observation, options);
    controller.abort();
  };
  await expect(
    pollObserveUntil(
      fake,
      new FakeTimer(),
      {
        timeoutMs: 100,
        pollMs: 10,
        initialMinTimestampMs: 10,
        skipRecompositionTracking: true,
        signal: controller.signal,
      },
      () => true,
    ),
  ).rejects.toThrow();
  expect(fake.getCollectDeferredBackStackObservations()).toEqual([terminal]);
  expect(fake.getExecuteCallCount()).toBe(1);
  expect(fake.getProcessRecompositionCallCount()).toBe(0);
  expect(fake.getCacheObserveResultCallCount()).toBe(0);
});

test("a collector resolving after abort never writes the returned observation", async () => {
  const fake = new FakeObserveScreen();
  const controller = new AbortController();
  const terminal = obs(20, "terminal");
  fake.setObserveResult(terminal);
  let release = (): void => {};
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  const collect = fake.collectDeferredBackStack.bind(fake);
  fake.collectDeferredBackStack = async (observation, options): Promise<void> => {
    await collect(observation, options);
    await work;
  };
  const pending = pollObserveUntil(
    fake,
    new FakeTimer(),
    {
      timeoutMs: 100,
      pollMs: 10,
      initialMinTimestampMs: 10,
      signal: controller.signal,
    },
    () => true,
  );
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  controller.abort(new Error("late collector cancelled"));
  await expect(pending).rejects.toThrow("late collector cancelled");
  release();
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  expect(fake.getCollectDeferredBackStackObservations()).toEqual([terminal]);
  expect(fake.getCacheObserveResultCallCount()).toBe(0);
});
