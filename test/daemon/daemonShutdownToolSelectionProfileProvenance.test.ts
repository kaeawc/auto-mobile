import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import * as databaseModule from "../../src/db";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import {
  PersistentToolSelectionProfileRegistry,
  type ToolSelectionProfileProvenanceStore,
} from "../../src/server/toolSelectionProfileRegistry";
import { logger } from "../../src/utils/logger";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * A fake store whose `insert` hangs on a manually-released gate, modeling a
 * slow/queued SQLite write mid-shutdown (issue #6225 review rounds 2-3).
 * Implements `ToolSelectionProfileProvenanceStore` directly (the narrow
 * interface `PersistentToolSelectionProfileRegistry` actually depends on) —
 * no `as unknown as` cast against the concrete repository type.
 */
class DelayedToolSelectionProfileProvenanceStore implements ToolSelectionProfileProvenanceStore {
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

/**
 * Issue #6225 review round 2: `record()`'s write-through must be enlisted in
 * the shared `DbWriteBarrier` — the exact barrier `Daemon.stop()`'s
 * "database write drain" stage awaits before the "database" stage closes the
 * connection (issue #2792's mechanism). Without that enlistment, a graceful
 * restart mid-write could have the drain see no outstanding work and close the
 * DB before the insert commits: the repository swallows that failure, and the
 * next daemon rejects the profile this PR is meant to let it recognize. This
 * is the production race the restart integration test cannot exercise (it
 * awaits the repository write directly, bypassing `record()`'s fire-and-forget
 * path entirely).
 *
 * Round 2 (second pass) replaced a naive "release immediately, check both
 * eventually happened" test with a bounded wall-clock poll
 * (`defaultTimer.sleep` in a loop) for `isDraining() && inFlightCount() >= 1`
 * before releasing the gate.
 *
 * Round 3: that poll could in principle consume its whole bounded deadline
 * before `daemon.stop()` reaches the drain stage under a stalled/loaded event
 * loop — flaking even when barrier ordering is correct — and it depended on
 * wall-clock despite the test already constructing a `FakeTimer`. This version
 * removes ALL timing dependence:
 *   1. `getDbWriteBarrier().inFlightCount()` is asserted to be exactly 1
 *      IMMEDIATELY and SYNCHRONOUSLY after `record()` returns, with no wait at
 *      all. `DbWriteBarrier.track()` increments the in-flight count
 *      synchronously, before its first internal `await` — so this is a
 *      deterministic, instant signal that the write is barrier-tracked. An
 *      untracked write (the regression this test guards against) can never
 *      make this non-zero, so this assertion alone fails the test immediately
 *      if the fix regresses, before `daemon.stop()` is even called.
 *   2. The insert gate is released from inside a `drain()` spy on the SAME
 *      shared barrier `daemon.stop()` drains — i.e. exactly when shutdown's
 *      "database write drain" stage invokes it. A deterministic hook, not a
 *      polled guess. The spy delegates to the real implementation, so
 *      `drain()`'s actual blocking-until-idle behavior is exercised for real.
 *   3. The ordered event log still asserts the insert's commit strictly
 *      precedes the `closeDatabase()` call, confirming the real ordering
 *      guarantee end to end.
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

    const store = new DelayedToolSelectionProfileProvenanceStore(events);
    const registry = new PersistentToolSelectionProfileRegistry(store);

    // Grab the shared barrier before record() so both this test and record()
    // observe/mutate the identical instance (resetDbWriteBarrier() above means
    // none exists yet; getDbWriteBarrier() lazily creates it on first call).
    const barrier = getDbWriteBarrier();
    const originalDrain = barrier.drain.bind(barrier);
    const drainSpy = spyOn(barrier, "drain").mockImplementation(async (timeoutMs: number) => {
      // Release the gated insert at the EXACT moment shutdown's write-drain
      // stage invokes drain() — a deterministic hook, not a wall-clock guess.
      store.releaseInsert();
      return originalDrain(timeoutMs);
    });

    try {
      registry.record("minted-uuid");

      // The write-through is gated open (not yet committed) — models the
      // write still being in flight when shutdown begins.
      expect(store.stored.has("minted-uuid")).toBe(false);

      // The deterministic, non-polled proof that the write is barrier-tracked.
      // If `record()` regresses to an untracked `void store.insert(...)`, this
      // is 0 and the test fails right here, before `daemon.stop()` even runs.
      expect(barrier.inFlightCount()).toBe(1);
      expect(barrier.isDraining()).toBe(false);

      await daemon.stop();

      expect(drainSpy).toHaveBeenCalled();
      // Both happened, AND in the required order: the write committed before
      // the database closed.
      expect(events).toEqual(["insert-committed", "closeDatabase-called"]);
      expect(store.stored.has("minted-uuid")).toBe(true);
    } finally {
      loggerCloseSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
      drainSpy.mockRestore();
    }
  });
});
