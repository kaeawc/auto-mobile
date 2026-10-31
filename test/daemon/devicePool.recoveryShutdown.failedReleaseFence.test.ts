import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { recoveryInternals } from "../helpers/devicePoolRecoveryInternals";
import { settleWithFakeTime } from "../helpers/fakeTimerStepping";
import { expect, spyOn, test } from "bun:test";
import type { SessionPreservingRecoveryResult } from "../../src/daemon/devicePool";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  original,
  setup,
  assertNoRecoveryReservationsRemain,
  flush,
} from "../helpers/devicePoolRecoveryShutdownHarness";

// These tests exercise the three-minute restart recovery window, which the idle deadline caps.
useSessionIdleWindowForSuite();

async function setupFailedReleaseFence() {
  const context = await setup();
  context.sessions.stopCleanupTimer();
  context.sessions.setActiveSessionExecutionChecker((id) =>
    context.pool.isSessionRecoveryInFlight(id),
  );
  const internals = context.pool.testHooks;
  const record = internals.startAndroidRecoveryRecord("session", { deviceId: original.deviceId }, [
    "loss",
    "quarantine",
    "failed-release",
  ]);
  recoveryInternals(context.pool).failedTerminalRecoveryReleases.add("session");
  const releases: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    context.sessions,
    (id) => context.pool.isSessionRecoveryInFlight(id),
    async (id, reason) => {
      releases.push(reason);
      await context.sessions.releaseSession(id, reason);
    },
    { timer: context.timer },
  );
  return { ...context, internals, record, monitor, releases };
}

test("failed-release fence becomes reaper eligible and a successful reap finalizes it", async () => {
  const { pool, timer, monitor, releases, record } = await setupFailedReleaseFence();
  expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
  timer.advanceTime(20_001);
  await monitor.tick();
  expect(releases).toEqual(["missing-first-heartbeat"]);
  assertNoRecoveryReservationsRemain(pool, "session");
  expect(record.reservations.has("failed-release")).toBe(false);
  expect(record.failedReleaseAttempts ?? 0).toBe(0);
});

test("failed-release reaper retries back off exponentially and stop at five minutes", async () => {
  const { pool, timer, monitor, releases, record, persistence } = await setupFailedReleaseFence();
  persistence.failure = "release";
  timer.advanceTime(20_001);
  for (const [index, delay] of [
    5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
  ].entries()) {
    await expect(
      settleWithFakeTime(timer, monitor.tick(), {
        stepMs: 1000,
        maxSteps: 2,
        description: "failed terminal release retries",
      }),
    ).rejects.toThrow("persist release failed");
    expect(record.failedReleaseAttempts).toBe(index + 1);
    expect(timer.getSleepHistory()).toEqual(Array((index + 1) * 2).fill(1_000));
    expect(record.deferredUntil).toBe(timer.now() + delay);
    expect(record.reservations.has("failed-release")).toBe(true);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);
    const attempts = releases.length;
    timer.advanceTime(delay - 1);
    await monitor.tick();
    expect(releases).toHaveLength(attempts);
    timer.advanceTime(1);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
  }
  persistence.failure = null;
  await monitor.tick();
  assertNoRecoveryReservationsRemain(pool, "session");
});

test("a live heartbeat leaves a due failed-release fence untouched", async () => {
  const { pool, sessions, timer, monitor, releases, record } = await setupFailedReleaseFence();
  timer.advanceTime(20_001);
  await deliverDaemonHeartbeat(sessions, "session");
  const before = { ...record, reservations: new Set(record.reservations) };
  await monitor.tick();
  expect(releases).toEqual([]);
  expect(record).toEqual(before);
  expect(recoveryInternals(pool).recoveringSessionLosses.get("session")).toBe(record);
  expect(recoveryInternals(pool).failedTerminalRecoveryReleases.has("session")).toBe(true);
});

test("an in-flight promise blocks reaping a failed-release fence with or without a deadline", async () => {
  const { pool, timer, monitor, releases, record } = await setupFailedReleaseFence();
  const recovery = Promise.withResolvers<SessionPreservingRecoveryResult>();
  recoveryInternals(pool).sessionPreservingRecoveries.set("session", {
    promise: recovery.promise,
  });
  timer.advanceTime(20_001);
  for (const deadline of [undefined, timer.now() - 1, timer.now() + 5_000]) {
    record.deferredUntil = deadline;
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);
    await monitor.tick();
  }
  expect(releases).toEqual([]);
  recovery.resolve("released");
});

test("idle cleanup retries a failed terminal release and honors its backoff", async () => {
  const { sessions, pool, timer, persistence, record } = await setupFailedReleaseFence();
  const session = sessions.getSession("session")!;
  persistence.failure = "release";
  // A real failed terminal release leaves a durable terminal reason for idle retry.
  await expect(sessions.releaseSession("session", "device-disconnected:test")).rejects.toThrow(
    "persist release failed",
  );
  session.expiresAt = 0;
  timer.advanceTime(1);
  sessions.cleanupExpiredSessions();
  await expect(
    settleWithFakeTime(timer, pool.waitForSessionPreservingRecovery("session"), {
      stepMs: 1000,
      maxSteps: 2,
      description: "idle terminal release retries",
    }),
  ).rejects.toThrow("persist release failed");
  await flush();
  expect(record.failedReleaseAttempts).toBe(1);
  expect(record.deferredUntil).toBe(timer.now() + 5_000);
  sessions.cleanupExpiredSessions();
  await flush();
  expect(record.failedReleaseAttempts).toBe(1);
  persistence.failure = null;
  timer.advanceTime(5_000);
  sessions.cleanupExpiredSessions();
  await pool.waitForSessionPreservingRecovery("session");
  await flush();
  assertNoRecoveryReservationsRemain(pool, "session");
  expect(pool.getDevice(original.deviceId)?.sessionId).toBeNull();
});

test("idle expiry consumes a recovery capture and preserves its prior terminal reason", async () => {
  const { sessions, pool, timer, persistence } = await setupFailedReleaseFence();
  const session = sessions.getSession("session")!;
  persistence.failure = "release";
  await expect(sessions.releaseSession("session", "device-disconnected:test")).rejects.toThrow(
    "persist release failed",
  );
  persistence.failure = null;
  const releaseDevice = spyOn(pool, "releaseDevice");
  try {
    session.expiresAt = 0;
    timer.setCurrentTime(1);
    sessions.cleanupExpiredSessions();
    await pool.waitForSessionPreservingRecovery("session");
    await flush();
    expect(releaseDevice).toHaveBeenCalledTimes(1);
    expect(releaseDevice).toHaveBeenCalledWith(original.deviceId, "session");
    expect(await persistence.getSession("session")).toMatchObject({
      release_reason: "device-disconnected:test",
    });
    expect(pool.getDevice(original.deviceId)).toMatchObject({ sessionId: null, status: "idle" });
    assertNoRecoveryReservationsRemain(pool, "session");
  } finally {
    releaseDevice.mockRestore();
    sessions.stopCleanupTimer();
  }
});

test("failed-release expiry preserves a declined commit fence", async () => {
  const { sessions, pool, record } = await setupFailedReleaseFence();
  const release = await sessions.releaseSessionUnlessSuperseded("session", "heartbeat-timeout", {
    commitFence: () => false,
  });
  expect(release).toEqual({ superseded: true });
  expect(record.reservations.has("failed-release")).toBe(true);
  expect(record.failedReleaseAttempts).toBeUndefined();
  expect(recoveryInternals(pool).recoveringSessionLosses.get("session")).toBe(record);
  expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
});

test("failed-release retry flight excludes overlapping expiry releases", async () => {
  const { sessions, pool, persistence } = await setupFailedReleaseFence();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let attempts = 0;
  persistence.markReleased = async () => {
    attempts++;
    started.resolve();
    await finish.promise;
  };
  const release = sessions.releaseSession("session", "heartbeat-timeout");
  await started.promise;
  expect(pool.isSessionRecoveryInFlight("session")).toBe(true);
  expect(
    await sessions.releaseSession("session", "cleanup-expired", { allowExpired: true }),
  ).toBeNull();
  expect(attempts).toBe(1);
  finish.resolve();
  await release;
  assertNoRecoveryReservationsRemain(pool, "session");
});
