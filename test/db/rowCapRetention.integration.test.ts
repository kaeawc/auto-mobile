import { describe, expect, test } from "bun:test";
import { createRowCapRetentionState, runAmortizedRetention } from "../../src/db/rowCapRetention";

/**
 * Unit coverage for the amortized row-cap retention wrapper shared by the
 * audit / failure-analytics / test-execution repositories (#3435/#3436/#3440).
 *
 * The wrapper owns exactly one concern: an offset-probe cleanup must not run on
 * every insert. These tests pin:
 *   1. amortization — the cleanup body fires at most once per `checkInterval`
 *      calls; the other N-1 calls are synchronous no-ops,
 *   2. the in-progress guard drops overlapping runs,
 *   3. the guard is released even when the cleanup body throws.
 */
describe("runAmortizedRetention (#3435/#3436/#3440)", () => {
  test("fires the cleanup body at most once per checkInterval calls", async () => {
    const state = createRowCapRetentionState();
    let runs = 0;
    const interval = 5;

    // interval-1 calls are pure no-ops.
    for (let i = 0; i < interval - 1; i++) {
      await runAmortizedRetention(
        state,
        async () => {
          runs++;
        },
        interval,
      );
    }
    expect(runs).toBe(0);

    // The interval-th call fires exactly once and resets the counter.
    await runAmortizedRetention(
      state,
      async () => {
        runs++;
      },
      interval,
    );
    expect(runs).toBe(1);

    // The cycle repeats: another interval-1 no-ops, then one fire.
    for (let i = 0; i < interval - 1; i++) {
      await runAmortizedRetention(
        state,
        async () => {
          runs++;
        },
        interval,
      );
    }
    expect(runs).toBe(1);
    await runAmortizedRetention(
      state,
      async () => {
        runs++;
      },
      interval,
    );
    expect(runs).toBe(2);
  });

  test("the in-progress guard drops an overlapping run", async () => {
    const state = createRowCapRetentionState();
    let running = 0;
    let maxConcurrent = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const body = async (): Promise<void> => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await gate;
      running--;
    };

    // First call arms and enters the body (and parks on `gate`).
    const first = runAmortizedRetention(state, body, 1);
    // Second call arms again but must be dropped by the in-progress guard.
    const second = runAmortizedRetention(state, body, 1);

    release();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
  });

  test("a bailed-out call while a cleanup is in flight leaves the counter armed for the next insert (#6657)", async () => {
    const state = createRowCapRetentionState();
    const checkInterval = 3;
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = async (): Promise<void> => {
      runs++;
      await gate;
    };

    // One insert away from tripping the gate.
    state.insertsSinceCleanup = checkInterval - 1;

    // This call trips the gate and parks inside the cleanup body (on `gate`).
    const first = runAmortizedRetention(state, body, checkInterval);

    // A burst of checkInterval-worth of further inserts lands before that
    // cleanup resolves. Each is fired without awaiting the prior one, so they
    // run synchronously up to their own guard check while `first` is still
    // parked — the exact interleaving from a sustained write burst.
    const burst: Promise<void>[] = [];
    for (let i = 0; i < checkInterval; i++) {
      burst.push(runAmortizedRetention(state, body, checkInterval));
    }

    // Buggy behavior: the counter is zeroed before the in-progress check, so
    // every burst call above would already have re-tripped and re-zeroed it,
    // ending near 0 (well under checkInterval) and silently discarding the
    // in-flight cleanup's gate. Fixed behavior: none of the bailed-out burst
    // calls reset the counter, so it stays >= checkInterval.
    expect(state.cleanupInProgress).toBe(true);
    expect(state.insertsSinceCleanup).toBeGreaterThanOrEqual(checkInterval);
    expect(runs).toBe(1); // only the in-flight cleanup has run so far

    release();
    await Promise.all(burst);
    await first;
    expect(state.cleanupInProgress).toBe(false);

    // With the counter left armed, the very next insert retries the gate
    // immediately rather than waiting another full checkInterval.
    await runAmortizedRetention(state, body, checkInterval);
    expect(runs).toBe(2);
    expect(state.insertsSinceCleanup).toBe(0);
  });

  test("releases the guard even when the cleanup body throws", async () => {
    const state = createRowCapRetentionState();

    await expect(
      runAmortizedRetention(
        state,
        async () => {
          throw new Error("boom");
        },
        1,
      ),
    ).rejects.toThrow("boom");

    // The guard is released, so a subsequent gated call can still run.
    let ran = false;
    await runAmortizedRetention(
      state,
      async () => {
        ran = true;
      },
      1,
    );
    expect(ran).toBe(true);
  });
});
