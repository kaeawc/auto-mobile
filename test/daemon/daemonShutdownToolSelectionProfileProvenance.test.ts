import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import * as databaseModule from "../../src/db";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import type { ToolSelectionProfileProvenanceRepository } from "../../src/db/toolSelectionProfileProvenanceRepository";
import { PersistentToolSelectionProfileRegistry } from "../../src/server/toolSelectionProfileRegistry";
import { logger } from "../../src/utils/logger";
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

  constructor() {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseInsert = release;
  }

  async insert(profileUuid: string): Promise<void> {
    await this.gate;
    this.stored.add(profileUuid);
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
 */
describe("Daemon shutdown drains an in-flight tool-selection-profile provenance write (issue #6225)", () => {
  beforeEach(() => resetDbWriteBarrier());

  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("record()'s write-through commits before the database closes", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer);
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockResolvedValue(undefined);

    const repo = new DelayedToolSelectionProfileProvenanceRepository();
    const registry = new PersistentToolSelectionProfileRegistry(asRepository(repo));

    try {
      registry.record("minted-uuid");
      // The write-through is gated open (not yet committed) — models the write
      // still being in flight when shutdown begins.
      expect(repo.stored.has("minted-uuid")).toBe(false);

      const stop = daemon.stop();

      // No matter how far the shutdown pipeline has progressed, it cannot reach
      // the "database" stage's closeDatabase() until the "database write drain"
      // stage's await on the barrier resolves — which cannot happen until the
      // gate below is released. This assertion holds at any point before that.
      expect(closeDatabaseSpy).not.toHaveBeenCalled();

      repo.releaseInsert();
      await stop;

      // The write committed BEFORE the database closed: the barrier awaited it.
      expect(repo.stored.has("minted-uuid")).toBe(true);
      expect(closeDatabaseSpy).toHaveBeenCalled();
    } finally {
      loggerCloseSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
    }
  });
});
