import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import {
  guardDatabaseStartup,
  handleFatalDatabaseStartupFailure,
  resolveDaemonStartupExitCode,
  MAX_STARTUP_BACKOFF_MS,
} from "../../src/daemon/daemonStartupGuard";
import { DAEMON_STARTUP_TIMEOUT_MS } from "../../src/daemon/constants";
import { DefaultStartupFailureTracker } from "../../src/daemon/DaemonStartupFailureTracker";
import {
  createIncompleteExtractionError,
  isIncompleteExtractionError,
  INCOMPLETE_EXTRACTION_EXIT_CODE,
} from "../../src/db/migrationDependencyIntegrity";
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

    await guardDatabaseStartup(
      async () => {
        await initializer.initialize();
      },
      tracker,
      timer,
    );

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
      guardDatabaseStartup(
        async () => {
          // Simulates a migrated-but-malformed feature_flags table query failing
          // during FeatureFlagService.initialize(), not just a migration failure.
          throw new Error("database disk image is malformed");
        },
        tracker,
        timer,
      ),
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
      handleFatalDatabaseStartupFailure(new Error("file is not a database"), tracker, timer),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(timer.getSleepHistory()).toEqual([]);

    // Later permanent failures park with the concrete exponentialBackoff tiers
    // (1000ms * 2^(attempt-1)): count 2 -> 1000ms, count 3 -> 2000ms. Asserting
    // the exact values catches an accidental multiplier/initial-delay change that
    // a "strictly increasing" check would miss.
    tracker.setCounts([2, 3]);
    await expect(
      handleFatalDatabaseStartupFailure(new Error("file is not a database"), tracker, timer),
    ).rejects.toBeInstanceOf(ActionableError);
    const afterSecond = [...timer.getSleepHistory()];
    await expect(
      handleFatalDatabaseStartupFailure(new Error("file is not a database"), tracker, timer),
    ).rejects.toBeInstanceOf(ActionableError);
    const afterThird = [...timer.getSleepHistory()];

    expect(afterSecond).toEqual([1000]);
    expect(afterThird).toEqual([1000, 2000]);
  });

  test("backoff is capped strictly below the daemon startup timeout", async () => {
    // A sleep >= DAEMON_STARTUP_TIMEOUT_MS would be truncated: DaemonManager
    // reports startup failure at that timeout and the next spawn SIGTERMs the
    // still-sleeping child, so the backoff would never actually throttle.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tracker = new FakeStartupFailureTracker();
    tracker.setCounts([50]); // far past the cap tier

    await expect(
      handleFatalDatabaseStartupFailure(new Error("file is not a database"), tracker, timer),
    ).rejects.toBeInstanceOf(ActionableError);

    const [delay] = timer.getSleepHistory();
    expect(delay).toBe(MAX_STARTUP_BACKOFF_MS);
    expect(delay!).toBeLessThan(DAEMON_STARTUP_TIMEOUT_MS);
  });

  test("an unpersistable permanent failure still parks (throttle wiring end-to-end)", async () => {
    // Real tracker + a store whose writes fail: recordFailure() must return a
    // backoff-triggering count so the handler actually sleeps, not just return >=2.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tracker = new DefaultStartupFailureTracker({
      read: () => null,
      write: () => {
        throw new Error("EACCES: permission denied");
      },
      clear: () => {},
    });

    await expect(
      handleFatalDatabaseStartupFailure(new Error("file is not a database"), tracker, timer),
    ).rejects.toBeInstanceOf(ActionableError);

    expect(timer.getSleepHistory()).toEqual([1000]);
  });

  test("transient failures never park (fast restart to clear a locked file)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tracker = new FakeStartupFailureTracker();
    tracker.setCounts([9]);

    await expect(
      handleFatalDatabaseStartupFailure(
        new Error("SQLITE_BUSY: database is locked"),
        tracker,
        timer,
      ),
    ).rejects.toBeInstanceOf(ActionableError);

    expect(timer.getSleepHistory()).toEqual([]);
    expect(tracker.recorded[0]!.kind).toBe("transient");
  });

  test("an incomplete-extraction failure re-stamps its code onto the rethrown error", async () => {
    // `toActionableError` rewraps the plain Error and drops its `code`; the
    // handler must re-stamp it so main()'s exit-code resolution can detect the
    // recoverable case (issue #2833). It still classifies permanent (the same
    // half-linked extraction reproduces every respawn) → backoff applies.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tracker = new FakeStartupFailureTracker();
    tracker.setCounts([1]);

    let thrown: unknown;
    try {
      await handleFatalDatabaseStartupFailure(
        createIncompleteExtractionError("kysely"),
        tracker,
        timer,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(isIncompleteExtractionError(thrown)).toBe(true);
    expect(tracker.recorded[0]!.kind).toBe("permanent");
  });
});

describe("resolveDaemonStartupExitCode", () => {
  test("returns EX_TEMPFAIL (75) for an incomplete-extraction failure", () => {
    expect(resolveDaemonStartupExitCode(createIncompleteExtractionError("kysely"))).toBe(
      INCOMPLETE_EXTRACTION_EXIT_CODE,
    );
  });

  test("returns 1 for every other fatal (generic, unchanged behavior)", () => {
    expect(resolveDaemonStartupExitCode(new Error("file is not a database"))).toBe(1);
    expect(resolveDaemonStartupExitCode(new ActionableError("something else"))).toBe(1);
    expect(resolveDaemonStartupExitCode(undefined)).toBe(1);
  });
});
