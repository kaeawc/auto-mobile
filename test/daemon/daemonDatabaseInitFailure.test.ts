import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { ActionableError } from "../../src/models/ActionableError";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { DefaultDatabaseHealthProbe } from "../../src/db/DatabaseHealthProbe";
import { FakeToolSelectionProfileProvenanceLoader } from "../fakes/FakeToolSelectionProfileProvenanceLoader";

/**
 * Issue #2784: startup DB/migration failure must be FATAL — `initializeDatabase()`
 * (awaited first thing in `start()`, before any server is opened) must REJECT so
 * `main().catch` → `process.exit(1)` restarts a clean daemon, instead of a
 * query-dead daemon reporting healthy.
 */
class SpyDeviceSessionRepository extends DeviceSessionRepository {
  markStaleCalls = 0;
  private failure: unknown = null;

  failWith(error: unknown): void {
    this.failure = error;
  }

  override async markStaleActiveSessionsExpired(): Promise<void> {
    this.markStaleCalls += 1;
    if (this.failure !== null) {
      throw this.failure;
    }
  }
}

interface DaemonInternals {
  initializeDatabase(): Promise<void>;
}

function buildDaemon(overrides: {
  initializer: FakeDatabaseInitializer;
  tracker: FakeStartupFailureTracker;
  timer: FakeTimer;
  deviceSessionRepository?: SpyDeviceSessionRepository;
  installedAppsRepository?: FakeInstalledAppsRepository;
}): {
  daemon: Daemon;
  deviceSessionRepository: SpyDeviceSessionRepository;
  installedAppsRepository: FakeInstalledAppsRepository;
} {
  const deviceSessionRepository =
    overrides.deviceSessionRepository ?? new SpyDeviceSessionRepository();
  const installedAppsRepository =
    overrides.installedAppsRepository ?? new FakeInstalledAppsRepository();
  const daemon = new Daemon(
    {},
    installedAppsRepository,
    overrides.timer,
    deviceSessionRepository,
    new CountingIdGenerator("daemon-session"),
    overrides.initializer,
    overrides.tracker,
    new DefaultDatabaseHealthProbe({ timer: overrides.timer }),
    undefined,
    process.env,
    undefined,
    // Never resolve the production default (real getDatabase()) — issue #3067.
    new FakeToolSelectionProfileProvenanceLoader(),
  );
  return { daemon, deviceSessionRepository, installedAppsRepository };
}

describe("Daemon.initializeDatabase fatality", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("rejects (does not swallow) when startup migrations fail", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const initializer = new FakeDatabaseInitializer(
      new Error(
        "Database startup migrations failed; refusing to run queries until the daemon restarts.",
      ),
    );
    const tracker = new FakeStartupFailureTracker();
    tracker.setCounts([1]);
    const { daemon } = buildDaemon({ initializer, tracker, timer });

    await expect(
      (daemon as unknown as DaemonInternals).initializeDatabase(),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(initializer.initializeCalls).toBe(1);
    expect(tracker.recorded).toHaveLength(1);
    expect(tracker.recorded[0]!.kind).toBe("permanent");
    expect(tracker.resetCalls).toBe(0);
  });

  test("successful DB bring-up resolves and runs cache cleanup without resetting the breaker", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const initializer = new FakeDatabaseInitializer();
    const tracker = new FakeStartupFailureTracker();
    const { daemon, deviceSessionRepository } = buildDaemon({ initializer, tracker, timer });

    await (daemon as unknown as DaemonInternals).initializeDatabase();

    expect(initializer.initializeCalls).toBe(1);
    expect(deviceSessionRepository.markStaleCalls).toBe(1);
    expect(tracker.recorded).toHaveLength(0);
    // Reset happens only at the END of start() (after all startup DB reads),
    // not here — a later permanent failure recorded before its fatal exit must
    // not be erased by a bring-up that merely got past migrations (issue #2784).
    expect(tracker.resetCalls).toBe(0);
  });

  test("permanent failures back off with increasing delay to avoid a restart hot-loop", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const initializer = new FakeDatabaseInitializer(new Error("database disk image is malformed"));
    const tracker = new FakeStartupFailureTracker();
    // First permanent failure: no backoff (quick restart in case it was a fluke).
    // Second and third: increasing backoff.
    tracker.setCounts([1, 2, 3]);
    const { daemon } = buildDaemon({ initializer, tracker, timer });

    await expect(
      (daemon as unknown as DaemonInternals).initializeDatabase(),
    ).rejects.toBeInstanceOf(ActionableError);
    const afterFirst = [...timer.getSleepHistory()];

    await expect(
      (daemon as unknown as DaemonInternals).initializeDatabase(),
    ).rejects.toBeInstanceOf(ActionableError);
    const afterSecond = [...timer.getSleepHistory()];

    await expect(
      (daemon as unknown as DaemonInternals).initializeDatabase(),
    ).rejects.toBeInstanceOf(ActionableError);
    const afterThird = [...timer.getSleepHistory()];

    // First failure did not park; subsequent failures park with the concrete
    // exponentialBackoff tiers (count 2 -> 1000ms, count 3 -> 2000ms).
    expect(afterFirst).toEqual([]);
    expect(afterSecond).toEqual([1000]);
    expect(afterThird).toEqual([1000, 2000]);
  });

  test("transient failures do not park (fast restart to clear a locked file)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const initializer = new FakeDatabaseInitializer(new Error("SQLITE_BUSY: database is locked"));
    const tracker = new FakeStartupFailureTracker();
    tracker.setCounts([5]); // even at a high count, transient does not back off
    const { daemon } = buildDaemon({ initializer, tracker, timer });

    await expect(
      (daemon as unknown as DaemonInternals).initializeDatabase(),
    ).rejects.toBeInstanceOf(ActionableError);

    expect(timer.getSleepHistory()).toEqual([]);
    expect(tracker.recorded[0]!.kind).toBe("transient");
  });

  test("a non-migration query failure during cache cleanup is also fatal", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const initializer = new FakeDatabaseInitializer(); // DB opens fine
    const deviceSessionRepository = new SpyDeviceSessionRepository();
    deviceSessionRepository.failWith(new Error("SQLITE_BUSY: database is locked"));
    const tracker = new FakeStartupFailureTracker();
    const { daemon } = buildDaemon({ initializer, tracker, timer, deviceSessionRepository });

    await expect(
      (daemon as unknown as DaemonInternals).initializeDatabase(),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(tracker.recorded).toHaveLength(1);
    expect(tracker.resetCalls).toBe(0);
  });
});
