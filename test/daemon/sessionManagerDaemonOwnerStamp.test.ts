import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import type { DeviceSessionRecord } from "../../src/db/deviceSessionRepository";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Every active row names the daemon that owns it, so a second daemon sharing the database never
 * mistakes a live peer's sessions for a dead predecessor's (#11114).
 */
class RecordingDeviceSessionRepository extends FakeDeviceSessionRepository {
  readonly records: DeviceSessionRecord[] = [];

  override async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    this.records.push(record);
    await super.upsertActiveSession(record);
  }
}

describe("daemon owner stamp on persisted sessions (#11114)", () => {
  afterEach(() => {
    // Constructing a Daemon initializes the process-wide DaemonState; do not leak it.
    DaemonState.getInstance().reset();
  });

  function managerFor(daemonSessionId: string, persistence: FakeDeviceSessionPersistence) {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const manager = new SessionManager(timer, persistence);
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId(daemonSessionId);
    return manager;
  }

  test("a session created without persistence metadata is stamped with the current daemon", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = managerFor("daemon-a", persistence);

    await manager.createSession("plain-session", "emulator-5554", "android");

    expect((await persistence.getSession?.("plain-session"))?.daemon_session_id).toBe("daemon-a");
  });

  test("a rehydrated session is re-owned by the current daemon, not the dead one", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const predecessor = managerFor("dead-daemon", persistence);
    await predecessor.createSession(
      "restarted-session",
      "emulator-5554",
      "android",
      undefined,
      undefined,
      "Pixel_8_API_35",
    );
    await persistence.markReleased("restarted-session", "expired", 1_000, "daemon-restart");

    const restarted = managerFor("daemon-b", persistence);
    const pool: SessionDeviceAssigner = {
      async assignDeviceToSession(id, _platform, target): Promise<string> {
        const session = await restarted.createSession(
          id,
          "emulator-5554",
          "android",
          target?.liveness?.sessionTimeoutMs,
          target?.liveness?.heartbeatTimeoutMs,
          target?.stableDeviceId,
          target?.liveness,
          target?.initialOwnership,
        );
        return session.assignedDevice;
      },
    };
    const summary = await restarted.rehydratePersistedSessions(pool);

    expect(summary.rehydrated).toEqual(["restarted-session"]);
    expect(restarted.getSession("restarted-session")?.persistenceMetadata?.daemonSessionId).toBe(
      "daemon-b",
    );
    expect((await persistence.getSession?.("restarted-session"))?.daemon_session_id).toBe(
      "daemon-b",
    );
  });

  test("the daemon wires its own id into its session manager", async () => {
    const timer = new FakeTimer();
    const repository = new RecordingDeviceSessionRepository(undefined, timer);
    const daemon = new Daemon({}, undefined, timer, repository);
    daemon.getSessionManager().stopCleanupTimer();

    await daemon.getSessionManager().createSession("daemon-session", "emulator-5554", "android");

    expect(repository.records.map((record) => record.daemonSessionId)).toEqual([
      daemon["daemonSessionId"],
    ]);
  });
});
