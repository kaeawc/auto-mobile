import { expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SUSPECT_GRACE_MS } from "../../src/daemon/sessionLivenessWindows";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

test.each([[60_000, "monitor"]] as const)(
  "heartbeat expiry persists and broadcasts after grace with a %i ms idle timeout via %s",
  async (idleTimeoutMs, expiryPath) => {
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    const manager = new SessionManager(timer, persistence);
    const emitted: Array<{ sessionId: string; reason?: string }> = [];
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      emitted.push({ sessionId, reason });
    });
    manager.onSessionRelease((sessionId, _deviceId, reason, snapshot) => {
      SessionReleaseBroadcaster.emit(sessionId, reason, snapshot);
    });
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );

    try {
      await manager.createSession(
        "heartbeat-expired",
        "emulator-5554",
        "android",
        idleTimeoutMs,
        1_000,
      );
      manager.recordHeartbeat("heartbeat-expired");
      monitor.start();

      // One grace window after the heartbeat: the 1 s lease has lapsed, the grace has 1 s left.
      await timer.advanceTimeAsync(SUSPECT_GRACE_MS);

      expect(await persistence.getSession?.("heartbeat-expired")).toMatchObject({
        status: "active",
        release_reason: null,
      });
      expect(manager.getSessionLeaseState("heartbeat-expired")).toEqual({
        phase: "suspect",
        remainingMs: 1_000,
      });
      expect(manager.getSessionForDevice("emulator-5554")).toBe("heartbeat-expired");
      expect(emitted).toEqual([]);

      if (expiryPath === "lookup") {
        await monitor.stop();
      }
      // Each scan settles before the next clock advance, so drift forgiveness does not apply.
      await timer.advanceTimeAsync(10_000);
      if (expiryPath === "lookup") {
        expect(manager.getSession("heartbeat-expired")).toBeNull();
      }
      await manager.waitForSessionRelease("heartbeat-expired");

      expect(await persistence.getSession?.("heartbeat-expired")).toMatchObject({
        status: "expired",
        release_reason: "heartbeat-timeout",
      });
      expect(emitted).toEqual([{ sessionId: "heartbeat-expired", reason: "heartbeat-timeout" }]);
      expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
    } finally {
      unsubscribe();
      await monitor.stop();
      manager.stopCleanupTimer();
    }
  },
);

test("idle expiry before the heartbeat lease lapses keeps its idle diagnostic", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence);
  try {
    await manager.createSession("idle-expired", "emulator-5554", "android", 1_000, 10_000);
    manager.recordHeartbeat("idle-expired");
    timer.advanceTime(11_001);

    expect(manager.getSession("idle-expired")).toBeNull();
    await manager.waitForSessionRelease("idle-expired");

    expect(await persistence.getSession?.("idle-expired")).toMatchObject({
      status: "expired",
      release_reason: "lazy-expiry",
    });
  } finally {
    manager.stopCleanupTimer();
  }
});

test("an idle window as short as the lease releases at the idle deadline, without the suspect grace (#11107)", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence);
  try {
    await manager.createSession("idle-at-deadline", "emulator-5554", "android", 1_000, 1_000);
    manager.recordHeartbeat("idle-at-deadline");
    timer.advanceTime(1_000);
    expect(manager.getSession("idle-at-deadline")).not.toBeNull();

    // The lease is now suspect, but the suspect grace never extends the idle deadline.
    timer.advanceTime(1);
    expect(manager.getSessionLeaseState("idle-at-deadline")?.phase).toBe("suspect");
    expect(manager.getSession("idle-at-deadline")).toBeNull();
    await manager.waitForSessionRelease("idle-at-deadline");

    expect(await persistence.getSession?.("idle-at-deadline")).toMatchObject({
      status: "expired",
      release_reason: "lazy-expiry",
    });
  } finally {
    manager.stopCleanupTimer();
  }
});

test("a lookup that finds both the idle deadline and the lease lapsed keeps the heartbeat diagnostic", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence);
  try {
    await manager.createSession("lease-lapsed", "emulator-5554", "android", 1_000, 1_000);
    manager.recordHeartbeat("lease-lapsed");
    timer.advanceTime(1_000 + SUSPECT_GRACE_MS + 1);

    expect(manager.getSession("lease-lapsed")).toBeNull();
    await manager.waitForSessionRelease("lease-lapsed");

    expect(await persistence.getSession?.("lease-lapsed")).toMatchObject({
      status: "expired",
      release_reason: "heartbeat-timeout",
    });
  } finally {
    manager.stopCleanupTimer();
  }
});
