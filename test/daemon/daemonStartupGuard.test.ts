import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import { guardDatabaseStartup, handleFatalDatabaseStartupFailure } from "../../src/daemon/daemonStartupGuard";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";

/**
 * The shared guard runs BEFORE any DB-backed service in `--daemon-mode` (issue
 * #2784): in `main()` the first DB touch is `FeatureFlagService.initialize()`,
 * which would otherwise exit via `main().catch` before the daemon's own fatal
 * handler could record the failure or back off — re-spawning in a tight loop.
 */
describe("guardDatabaseStartup", () => {
  test("resolves without resetting the tracker when the early DB work succeeds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const initializer = new FakeDatabaseInitializer();
    const tracker = new FakeStartupFailureTracker();

    await guardDatabaseStartup(async () => {
      await initializer.initialize();
    }, tracker, timer);

    expect(initializer.initializeCalls).toBe(1);
    // Reset must NOT happen here — only after the ENTIRE daemon startup DB path
    // (Daemon.initializeDatabase cleanup) succeeds, or a later recorded permanent
    // failure would be erased by the next launch's preflight success.
    expect(tracker.resetCalls).toBe(0);
    expect(tracker.recorded).toHaveLength(0);
  });

  test("rethrows an ActionableError (fatal) when any guarded DB work fails", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tracker = new FakeStartupFailureTracker();
    tracker.setCounts([1]);

    await expect(
      guardDatabaseStartup(async () => {
        // Simulates a migrated-but-malformed feature_flags table query failing
        // during FeatureFlagService.initialize(), not just a migration failure.
        throw new Error("database disk image is malformed");
      }, tracker, timer)
    ).rejects.toBeInstanceOf(ActionableError);
    expect(tracker.recorded[0]!.kind).toBe("permanent");
    expect(tracker.resetCalls).toBe(0);
  });

  test("permanent failures escalate backoff to avoid a restart hot-loop", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tracker = new FakeStartupFailureTracker();

    // First permanent failure: no park (allow a quick restart in case of a fluke).
    await expect(
      handleFatalDatabaseStartupFailure(new Error("file is not a database"), tracker, timer)
    ).rejects.toBeInstanceOf(ActionableError);
    expect(timer.getSleepHistory()).toEqual([]);

    // Later permanent failures park with a strictly increasing delay.
    tracker.setCounts([2, 3]);
    await expect(
      handleFatalDatabaseStartupFailure(new Error("file is not a database"), tracker, timer)
    ).rejects.toBeInstanceOf(ActionableError);
    const afterSecond = [...timer.getSleepHistory()];
    await expect(
      handleFatalDatabaseStartupFailure(new Error("file is not a database"), tracker, timer)
    ).rejects.toBeInstanceOf(ActionableError);
    const afterThird = [...timer.getSleepHistory()];

    expect(afterSecond).toHaveLength(1);
    expect(afterThird).toHaveLength(2);
    expect(afterThird[1]!).toBeGreaterThan(afterThird[0]!);
  });

  test("transient failures never park (fast restart to clear a locked file)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tracker = new FakeStartupFailureTracker();
    tracker.setCounts([9]);

    await expect(
      handleFatalDatabaseStartupFailure(new Error("SQLITE_BUSY: database is locked"), tracker, timer)
    ).rejects.toBeInstanceOf(ActionableError);

    expect(timer.getSleepHistory()).toEqual([]);
    expect(tracker.recorded[0]!.kind).toBe("transient");
  });
});
