import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { effectiveLastHeartbeat } from "../../src/daemon/livenessOwnerLease";
import { PROXY_HEARTBEAT_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import type { DeviceSessionActivityUpdate } from "../../src/db/deviceSessionRepository";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * #11079: a heartbeat is acknowledged before its activity write settles, so the write's outcome
 * must never undo the lease it renewed, and a heartbeat that changes no persisted field must not
 * touch the database at all (a peer daemon holding the write lock would otherwise stall it).
 */
const SESSION = "heartbeat-write";

class ScriptedActivityPersistence extends FakeDeviceSessionPersistence {
  readonly writes: DeviceSessionActivityUpdate[] = [];
  mode: "succeed" | "reject" | "hang" = "succeed";

  override async recordActivity(
    sessionId: string,
    update: DeviceSessionActivityUpdate,
  ): Promise<void> {
    this.writes.push(update);
    if (this.mode === "reject") {
      throw new Error("SQLITE_FULL: database or disk is full");
    }
    if (this.mode === "hang") {
      // A peer daemon holds the write lock: the write never settles while the test runs.
      await new Promise<never>(() => {});
    }
    await super.recordActivity(sessionId, update);
  }
}

describe("heartbeat activity writes (#11079)", () => {
  let timer: FakeTimer;
  let persistence: ScriptedActivityPersistence;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let released: string[];
  let warn: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new ScriptedActivityPersistence();
    manager = new SessionManager(timer, persistence);
    released = [];
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        released.push(`${sessionId}:${reason}`);
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    await manager.createSession(SESSION, "emulator-5554", "android");
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
    warn.mockRestore();
  });

  /** Heartbeat every proxy interval for `durationMs`, letting each scan and write settle. */
  async function heartbeatFor(durationMs: number): Promise<void> {
    for (let elapsed = 0; elapsed < durationMs; elapsed += PROXY_HEARTBEAT_INTERVAL_MS) {
      await timer.advanceTimeAsync(PROXY_HEARTBEAT_INTERVAL_MS);
      manager.recordHeartbeat(SESSION);
      expect(effectiveLastHeartbeat(manager.getSession(SESSION)!)).toBe(timer.now());
    }
  }

  test("a rejected activity write keeps the acknowledged lease and the owner", async () => {
    persistence.mode = "reject";
    monitor.start();

    manager.recordHeartbeat(SESSION);
    await heartbeatFor(12_000);

    const session = manager.getSession(SESSION);
    expect(session).not.toBeNull();
    expect(effectiveLastHeartbeat(session!)).toBe(timer.now());
    expect(session!.ownership).toBe("owned");
    expect(released).toEqual([]);
    // Each heartbeat retries the unstored row, and each failure is logged at warn.
    expect(persistence.writes.length).toBeGreaterThan(1);
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes("Failed to record heartbeat activity"),
      ),
    ).toBe(true);
  });

  test("heartbeats that change no persisted field issue no DB write", async () => {
    manager.recordHeartbeat(SESSION);
    await timer.advanceTimeAsync(0);
    expect(persistence.writes).toHaveLength(1);
    expect(persistence.writes[0]!.hasReceivedHeartbeat).toBe(true);

    // From here on, even a failing database is never reached by a heartbeat.
    persistence.mode = "reject";
    monitor.start();
    await heartbeatFor(12_000);

    expect(persistence.writes).toHaveLength(1);
    expect(released).toEqual([]);
  });

  test("a failed write is retried by the next heartbeat until the row is stored", async () => {
    persistence.mode = "reject";
    manager.recordHeartbeat(SESSION);
    await timer.advanceTimeAsync(0);
    expect(persistence.writes).toHaveLength(1);

    persistence.mode = "succeed";
    await heartbeatFor(2 * PROXY_HEARTBEAT_INTERVAL_MS);

    // One retry stored the row; the heartbeat after it had nothing to write.
    expect(persistence.writes).toHaveLength(2);
    expect((await persistence.getSession?.(SESSION))?.has_received_heartbeat).toBe(1);
  });

  test("a write stuck behind a busy lock is not stacked by later heartbeats", async () => {
    persistence.mode = "hang";
    monitor.start();

    manager.recordHeartbeat(SESSION);
    await heartbeatFor(12_000);

    // The in-flight write already carries this row, so later heartbeats queue nothing behind it,
    // and the lease keeps renewing in memory regardless.
    expect(persistence.writes).toHaveLength(1);
    expect(effectiveLastHeartbeat(manager.getSession(SESSION)!)).toBe(timer.now());
    expect(released).toEqual([]);
  });
});
