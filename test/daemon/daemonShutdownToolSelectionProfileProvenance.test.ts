import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import * as databaseModule from "../../src/db";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import type { ToolSelectionProfileProvenanceRepository } from "../../src/db/toolSelectionProfileProvenanceRepository";
import { PersistentToolSelectionProfileRegistry } from "../../src/server/toolSelectionProfileRegistry";
import { logger } from "../../src/utils/logger";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * A fake repository whose `insert` hangs on a manually-released gate, modeling
 * a slow/queued SQLite write mid-shutdown (issue #6225 review round 2).
 */
class DelayedToolSelectionProfileProvenanceRepository {
  readonly stored = new Set<string>();
  readonly releaseInsert: () => void;
  private readonly gate: Promise<void>;

  constructor(private readonly events: string[]) {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseInsert = release;
  }

  async insert(profileUuid: string): Promise<void> {
    await this.gate;
    this.stored.add(profileUuid);
    this.events.push("insert-committed");
  }

  async loadAll(): Promise<string[]> {
    return [...this.stored];
  }
}

function asRepository(
  fake: DelayedToolSelectionProfileProvenanceRepository,
): ToolSelectionProfileProvenanceRepository {
  return fake as unknown as ToolSelectionProfileProvenanceRepository;
}

/**
 * Yields to the real event loop (a macrotask, not just a microtask) so timers
 * and I/O-driven promises elsewhere in `daemon.stop()`'s cleanup stages (e.g.
 * the real `stopManagedAdbServer` probe) get a chance to progress between
 * checks — a pure `await Promise.resolve()` spin could starve them and never
 * observe the state we're waiting for. Uses the injectable `Timer` (real
 * `defaultTimer`, not a raw `setTimeout`) per the repo's timer convention —
 * this genuinely needs real wall-clock scheduling to interleave with
 * `daemon.stop()`'s own real timers/I-O, so `FakeTimer` is not applicable here.
 */
function nextMacrotask(): Promise<void> {
  return defaultTimer.sleep(1);
}

/**
 * Polls `predicate` until it is true, bounded by `timeoutMs`. Throws (failing
 * the test with a clear message) rather than hanging or silently passing when
 * the predicate never becomes true — which is exactly what must happen here if
 * `record()`'s write-through is ever untracked again: an untracked write never
 * makes the barrier's `inFlightCount()` non-zero, so `drain()` sees no
 * outstanding work and returns immediately without this predicate ever holding.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: condition did not become true within ${timeoutMs}ms`);
    }
    await nextMacrotask();
  }
}

/**
 * Issue #6225 review round 2 (first pass): `record()`'s write-through must be
 * enlisted in the shared `DbWriteBarrier` — the exact barrier `Daemon.stop()`'s
 * "database write drain" stage awaits before the "database" stage closes the
 * connection (issue #2792's mechanism). Without that enlistment, a graceful
 * restart mid-write could have the drain see no outstanding work and close the
 * DB before the insert commits: the repository swallows that failure, and the
 * next daemon rejects the profile this PR is meant to let it recognize. This
 * is the production race the restart integration test cannot exercise (it
 * awaits the repository write directly, bypassing `record()`'s fire-and-forget
 * path entirely).
 *
 * Review round 2 (second pass): the first version of this test released the
 * insert gate immediately after starting `daemon.stop()` and only asserted
 * that both the insert and `closeDatabase()` EVENTUALLY happened — not their
 * relative order, and not that the insert was ever actually in-flight when the
 * drain began. `daemon.stop()` yields at its very first cleanup-stage `await`
 * (long before the write-drain stage), so that assertion passed trivially, and
 * an UNTRACKED insert (reverting the fix) would have passed it too. This
 * version fixes both problems:
 *   1. It does not release the insert gate until it has directly observed, via
 *      the SAME shared barrier `daemon.stop()` drains, that draining has begun
 *      AND the tracked write is actually counted (`isDraining() &&
 *      inFlightCount() >= 1`) — bounded so an untracked write (which can never
 *      make `inFlightCount()` non-zero) fails the test instead of hanging or
 *      passing.
 *   2. It records both events into one ordered log and asserts the insert's
 *      commit precedes the `closeDatabase()` call, not merely that both
 *      eventually occurred.
 */
describe("Daemon shutdown drains an in-flight tool-selection-profile provenance write (issue #6225)", () => {
  beforeEach(() => resetDbWriteBarrier());

  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("record()'s write-through commits before the database closes, in that order", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer);
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    const events: string[] = [];
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
      events.push("closeDatabase-called");
    });

    const repo = new DelayedToolSelectionProfileProvenanceRepository(events);
    const registry = new PersistentToolSelectionProfileRegistry(asRepository(repo));

    try {
      registry.record("minted-uuid");
      // The write-through is gated open (not yet committed) — models the write
      // still being in flight when shutdown begins.
      expect(repo.stored.has("minted-uuid")).toBe(false);

      const stop = daemon.stop();

      // Do NOT release the gate yet. Wait until shutdown has genuinely reached
      // the "database write drain" stage AND the barrier counts our write as
      // in-flight — the only state in which releasing the gate now actually
      // exercises the drain-then-close ordering this test is for. If the fix
      // regresses to an untracked `void this.repository.insert(...)`,
      // `inFlightCount()` can never become non-zero and this throws instead of
      // passing.
      await waitUntil(
        () => getDbWriteBarrier().isDraining() && getDbWriteBarrier().inFlightCount() >= 1,
        2000,
      );
      expect(closeDatabaseSpy).not.toHaveBeenCalled();

      repo.releaseInsert();
      await stop;

      // Both happened, AND in the required order: the write committed before
      // the database closed.
      expect(events).toEqual(["insert-committed", "closeDatabase-called"]);
      expect(repo.stored.has("minted-uuid")).toBe(true);
    } finally {
      loggerCloseSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
    }
  }, 5000);
});
