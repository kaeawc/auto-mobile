import { afterEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import { SUSPECT_GRACE_MS } from "../../../src/daemon/wire/sessionLivenessWindows";
import { SessionManager } from "../../../src/daemon/sessionManager";
import {
  HeartbeatTaskLeaseKeepalive,
  type TaskLeaseSessions,
} from "../../../src/daemon/tasks/taskLeaseKeepalive";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";

/*
 * A task holding a device keeps that session's lease alive until it settles (#4668, owner
 * decision 2026-10-18): the keepalive renews it through the session manager's own heartbeat.
 */

const HOLD = { taskId: "task-1", ownerKey: "key-a", sessionUuid: "session-1" };
const HEARTBEAT_TIMEOUT_MS = 1_000;

/** Like the session manager, `peekSession` returns the same object for one session incarnation. */
class RecordingSessions implements TaskLeaseSessions {
  private readonly sessions = new Map<string, { readonly heartbeatTimeoutMs: number }>();
  readonly heartbeats: string[] = [];
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS;

  constructor() {
    this.live.add("session-1");
  }

  readonly live = {
    add: (sessionId: string) => {
      this.sessions.set(sessionId, { heartbeatTimeoutMs: this.heartbeatTimeoutMs });
    },
    delete: (sessionId: string) => this.sessions.delete(sessionId),
  };

  peekSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }

  recordHeartbeat(sessionId: string): void {
    this.heartbeats.push(sessionId);
  }
}

describe("HeartbeatTaskLeaseKeepalive", () => {
  test("heartbeats at once and then under the session's heartbeat timeout until released", () => {
    const timer = new FakeTimer();
    const sessions = new RecordingSessions();
    const keepalive = new HeartbeatTaskLeaseKeepalive({ sessions: () => sessions, timer });

    const release = keepalive.hold(HOLD);
    expect(sessions.heartbeats).toEqual(["session-1"]);
    timer.advanceTime(HEARTBEAT_TIMEOUT_MS * 3);
    // Half the 1 s lease: six renewals over three lease lengths, plus the one at hold.
    expect(sessions.heartbeats.length).toBe(7);

    release();
    release();
    timer.advanceTime(HEARTBEAT_TIMEOUT_MS * 3);
    expect(sessions.heartbeats.length).toBe(7);
    expect(keepalive.heldCount).toBe(0);
  });

  test("a session that is not live is not held", () => {
    const timer = new FakeTimer();
    const sessions = new RecordingSessions();
    const keepalive = new HeartbeatTaskLeaseKeepalive({ sessions: () => sessions, timer });

    keepalive.hold({ ...HOLD, sessionUuid: "gone" })();
    expect(sessions.heartbeats).toEqual([]);
    expect(keepalive.heldCount).toBe(0);
  });

  test("a session that ends under the task stops the hold", () => {
    const timer = new FakeTimer();
    const sessions = new RecordingSessions();
    const keepalive = new HeartbeatTaskLeaseKeepalive({ sessions: () => sessions, timer });

    keepalive.hold(HOLD);
    sessions.live.delete("session-1");
    timer.advanceTime(HEARTBEAT_TIMEOUT_MS);
    expect(sessions.heartbeats).toEqual(["session-1"]);
    expect(keepalive.heldCount).toBe(0);
  });

  test("a session released and recreated under the same uuid is not renewed by the old hold (#13143)", () => {
    const timer = new FakeTimer();
    const sessions = new RecordingSessions();
    const keepalive = new HeartbeatTaskLeaseKeepalive({ sessions: () => sessions, timer });

    keepalive.hold(HOLD);
    sessions.live.delete("session-1");
    sessions.live.add("session-1");
    timer.advanceTime(HEARTBEAT_TIMEOUT_MS * 3);
    expect(sessions.heartbeats).toEqual(["session-1"]);
    expect(keepalive.heldCount).toBe(0);
  });

  test("daemon shutdown releases every hold and refuses new ones", () => {
    const timer = new FakeTimer();
    const sessions = new RecordingSessions();
    const keepalive = new HeartbeatTaskLeaseKeepalive({ sessions: () => sessions, timer });
    keepalive.hold(HOLD);
    keepalive.hold({ ...HOLD, taskId: "task-2" });

    expect(keepalive.releaseAll()).toBe(2);
    timer.advanceTime(HEARTBEAT_TIMEOUT_MS * 2);
    keepalive.hold({ ...HOLD, taskId: "task-3" });
    expect(sessions.heartbeats).toEqual(["session-1", "session-1"]);
    expect(keepalive.heldCount).toBe(0);
  });

  describe("against the real session manager and heartbeat monitor", () => {
    const CHECK_INTERVAL_MS = 500;
    let manager: SessionManager | undefined;

    afterEach(() => {
      manager?.stopCleanupTimer();
      manager = undefined;
    });

    async function boundSession(timer: FakeTimer) {
      manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
        barrier: () => new FakeDbWriteBarrier(),
      });
      await manager.createSession("session-1", "emulator-5554", "android", {
        timeoutMs: 60 * 60 * 1000,
        heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      });
      manager.stopCleanupTimer();
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        manager,
        () => false,
        async (sessionId, reason) => {
          reaped.push(`${sessionId}:${reason}`);
          await manager?.releaseSession(sessionId, reason);
        },
        { timer, graceMs: HEARTBEAT_TIMEOUT_MS, checkIntervalMs: CHECK_INTERVAL_MS },
      );
      /** Run the monitor on schedule for `ms`, as the daemon's interval would. */
      const runFor = async (ms: number): Promise<void> => {
        for (let elapsed = 0; elapsed < ms; elapsed += CHECK_INTERVAL_MS) {
          timer.advanceTime(CHECK_INTERVAL_MS);
          await monitor.tick();
        }
      };
      return { sessions: manager, reaped, runFor };
    }

    // Far past lease plus suspect grace: a cold boot that takes minutes.
    const LONG_BOOT_MS = SUSPECT_GRACE_MS + 120_000;

    test("an unheld session is reaped once its heartbeat lease lapses", async () => {
      const timer = new FakeTimer();
      const { reaped, runFor } = await boundSession(timer);

      await runFor(LONG_BOOT_MS);
      expect(reaped).toHaveLength(1);
    });

    test("a held session outlives a long boot and lapses only after the task releases it", async () => {
      const timer = new FakeTimer();
      const { sessions, reaped, runFor } = await boundSession(timer);
      const keepalive = new HeartbeatTaskLeaseKeepalive({ sessions: () => sessions, timer });

      const release = keepalive.hold(HOLD);
      await runFor(LONG_BOOT_MS);
      expect(reaped).toEqual([]);

      release();
      await runFor(LONG_BOOT_MS);
      expect(reaped).toEqual(["session-1:heartbeat-timeout"]);
    });
  });
});
