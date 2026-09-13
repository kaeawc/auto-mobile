import { describe, expect, test } from "bun:test";
import {
  createAmortizedRetentionState,
  runAmortizedRetentionGate,
} from "../../src/db/retentionGate";

/**
 * Direct unit coverage for the shared amortized single-flight gate (#6702) that
 * `eventRetention.ts` (`pruneEventTableByCount`) and `rowCapRetention.ts`
 * (`runAmortizedRetention`) both now delegate to, so the counter/guard state
 * machine is pinned exactly once instead of split across the two callers'
 * integration suites. These tests cover:
 *   1. counter bumps advance by `inserted` (default 1, and an explicit batch
 *      size for the event-repository caller),
 *   2. the gate fires the cleanup body at most once per `checkInterval`,
 *   3. the in-progress guard drops overlapping runs and is released via
 *      `finally` even when the cleanup body throws,
 *   4. the #6657 invariant: a cleanup already in flight leaves the counter
 *      armed rather than letting a bailed-out call silently re-zero it.
 */
describe("runAmortizedRetentionGate (#6702)", () => {
  test("fires the cleanup body at most once per checkInterval calls", async () => {
    const state = createAmortizedRetentionState();
    let runs = 0;
    const interval = 5;

    for (let i = 0; i < interval - 1; i++) {
      await runAmortizedRetentionGate(
        state,
        async () => {
          runs++;
        },
        interval,
      );
    }
    expect(runs).toBe(0);

    await runAmortizedRetentionGate(
      state,
      async () => {
        runs++;
      },
      interval,
    );
    expect(runs).toBe(1);
    expect(state.insertsSinceCleanup).toBe(0);
  });

  test("a single call reporting a batch `inserted` count immediately arms the gate", async () => {
    const state = createAmortizedRetentionState();
    let runs = 0;
    const interval = 5;

    // Fewer than the interval: no-op.
    await runAmortizedRetentionGate(
      state,
      async () => {
        runs++;
      },
      interval,
      interval - 1,
    );
    expect(runs).toBe(0);
    expect(state.insertsSinceCleanup).toBe(interval - 1);

    // The remaining single insert tips it over the interval.
    await runAmortizedRetentionGate(
      state,
      async () => {
        runs++;
      },
      interval,
      1,
    );
    expect(runs).toBe(1);
  });

  test("the in-progress guard drops an overlapping run", async () => {
    const state = createAmortizedRetentionState();
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

    const first = runAmortizedRetentionGate(state, body, 1);
    const second = runAmortizedRetentionGate(state, body, 1);

    release();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
  });

  test("a bailed-out call while a cleanup is in flight leaves the counter armed for the next insert (#6657)", async () => {
    const state = createAmortizedRetentionState();
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
    const first = runAmortizedRetentionGate(state, body, checkInterval);

    // A burst of checkInterval-worth of further inserts lands before that
    // cleanup resolves. Each is fired without awaiting the prior one, so they
    // run synchronously up to their own guard check while `first` is still
    // parked — the exact interleaving from a sustained write burst.
    const burst: Promise<void>[] = [];
    for (let i = 0; i < checkInterval; i++) {
      burst.push(runAmortizedRetentionGate(state, body, checkInterval));
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
    await runAmortizedRetentionGate(state, body, checkInterval);
    expect(runs).toBe(2);
    expect(state.insertsSinceCleanup).toBe(0);
  });

  test("propagates a cleanup body error but still releases the guard", async () => {
    const state = createAmortizedRetentionState();

    await expect(
      runAmortizedRetentionGate(
        state,
        async () => {
          throw new Error("boom");
        },
        1,
      ),
    ).rejects.toThrow("boom");

    expect(state.cleanupInProgress).toBe(false);

    let ran = false;
    await runAmortizedRetentionGate(
      state,
      async () => {
        ran = true;
      },
      1,
    );
    expect(ran).toBe(true);
  });
});
