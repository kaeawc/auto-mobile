import { describe, expect, test } from "bun:test";
import { NavigationRetentionMonitor } from "../../src/daemon/NavigationRetentionMonitor";
import { FakeTimer } from "../fakes/FakeTimer";
import type {
  NavigationRetention,
  NavigationRetentionSummary,
} from "../../src/db/navigationRetention";

/**
 * Minimal stand-in for {@link NavigationRetention} that records the clock values
 * it was pruned at, so the monitor's cadence + guard can be driven purely with a
 * FakeTimer (no DB, no real waits).
 */
function fakeRetention(options: { onPrune?: () => void; throwOnce?: boolean } = {}): {
  retention: NavigationRetention;
  prunedAt: number[];
} {
  const prunedAt: number[] = [];
  let thrown = false;
  const retention = {
    async prune(now: number): Promise<NavigationRetentionSummary> {
      options.onPrune?.();
      if (options.throwOnce && !thrown) {
        thrown = true;
        throw new Error("boom");
      }
      prunedAt.push(now);
      return {
        screenshotsCleared: 0,
        nodeObservationsDeleted: 0,
        edgeObservationsDeleted: 0,
        buildKeysDeleted: 0,
        prunedAt: now,
      };
    },
  } as unknown as NavigationRetention;
  return { retention, prunedAt };
}

describe("NavigationRetentionMonitor", () => {
  test("fires prune once per interval using the injected clock", async () => {
    const timer = new FakeTimer();
    const { retention, prunedAt } = fakeRetention();
    const monitor = new NavigationRetentionMonitor(retention, timer, 1_000);
    monitor.start();

    expect(prunedAt).toEqual([]);
    await timer.advanceTimersByTimeAsync(1_000);
    await timer.advanceTimersByTimeAsync(1_000);
    monitor.stop();

    expect(prunedAt.length).toBe(2);
    // now() advances with the fake clock, proving the clock is the seam.
    expect(prunedAt[0]).toBe(1_000);
    expect(prunedAt[1]).toBe(2_000);
  });

  test("stop() halts further passes", async () => {
    const timer = new FakeTimer();
    const { retention, prunedAt } = fakeRetention();
    const monitor = new NavigationRetentionMonitor(retention, timer, 1_000);
    monitor.start();
    await timer.advanceTimersByTimeAsync(1_000);
    monitor.stop();
    await timer.advanceTimersByTimeAsync(5_000);
    expect(prunedAt.length).toBe(1);
  });

  test("drops overlapping ticks while a pass is in flight", async () => {
    const timer = new FakeTimer();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const retention = {
      async prune(now: number): Promise<NavigationRetentionSummary> {
        calls++;
        await gate; // hold the first pass open across the next tick
        return {
          screenshotsCleared: 0,
          nodeObservationsDeleted: 0,
          edgeObservationsDeleted: 0,
          buildKeysDeleted: 0,
          prunedAt: now,
        };
      },
    } as unknown as NavigationRetention;

    const monitor = new NavigationRetentionMonitor(retention, timer, 1_000);
    monitor.start();
    const pass1 = monitor.tick(); // pass #1, blocks on gate
    await Promise.resolve();
    await monitor.tick(); // dropped: still running
    expect(calls).toBe(1);

    release?.();
    await pass1; // let pass #1 finish and clear the running guard
    await monitor.tick(); // now allowed again
    expect(calls).toBe(2);
    monitor.stop();
  });

  test("swallows a failing pass and keeps running", async () => {
    const timer = new FakeTimer();
    const { retention, prunedAt } = fakeRetention({ throwOnce: true });
    const monitor = new NavigationRetentionMonitor(retention, timer, 1_000);

    await monitor.tick(); // throws internally, swallowed
    expect(monitor.getLastSummary()).toBeNull();
    await monitor.tick(); // recovers
    expect(prunedAt.length).toBe(1);
    expect(monitor.getLastSummary()).not.toBeNull();
  });
});
