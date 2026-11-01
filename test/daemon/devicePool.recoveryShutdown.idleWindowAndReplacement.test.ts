import { ExitedChildProcess } from "../helpers/exitedChildProcess";
import { expect, test } from "bun:test";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import { warmedTests } from "../helpers/warmedTests";
import {
  original,
  image,
  LaggingShutdownManager,
  KillTrackingShutdownManager,
  setup,
  setupWith,
  setupPassiveRestart,
  setupAwaitingOwner,
  flush,
  setupSettledRestart,
} from "../helpers/devicePoolRecoveryShutdownHarness";

// These tests exercise the three-minute restart recovery window, which the idle deadline caps.
useSessionIdleWindowForSuite();

// The owner-decided idle window: a session is released this long after its last tool call ends.
const RESTART_TEST_IDLE_MS = 2 * 60_000;

/** A device-restart release whose idle deadline (two minutes) falls inside the cold-boot window. */
async function setupPassiveRestartWithIdleWindow() {
  const setup = await setupPassiveRestart();
  const persisted = await setup.persistence.getSession("session");
  if (!persisted) {
    throw new Error("Expected a persisted restart release");
  }
  persisted.session_timeout_ms = RESTART_TEST_IDLE_MS;
  persisted.expires_at_ms = RESTART_TEST_IDLE_MS;
  return setup;
}

function trackSettlement<T>(promise: Promise<T>): {
  result: Promise<T | unknown>;
  settled: () => boolean;
} {
  let settled = false;
  const result = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  return { result, settled: () => settled };
}

async function advanceUntil(timer: FakeTimer, untilMs: number, stepMs = 1_000): Promise<void> {
  while (timer.now() < untilMs) {
    timer.advanceTime(Math.min(stepMs, untilMs - timer.now()));
    await flush();
  }
}

// Each fake-time step runs a real pass of the pool's one-second recovery assignment poll, with a
// real device refresh once the refresh cache's TTL has lapsed: at one-second steps that is ~150
// passes, the bulk of the test's time (#15841). The in-flight scenario only needs fake time to
// cross the idle deadline while the call waits, so it steps 30 s at a time: the pending poll still
// fires on every step, and a step lands exactly on the two-minute idle deadline, where the pool's
// idle hold rechecks the row.
const IN_FLIGHT_STEP_MS = 30_000;

// The first restart-recovery scenario in this file pays one-time module and first-use compilation
// (~70 ms) for the recovery, persistence and pool paths: run it once in beforeAll, outside the
// per-test budget, before it runs again as the measured test.
const warmed = warmedTests(() => {});

warmed("an in-flight caller keeps device-restart recovery past the idle window", async () => {
  const { timer, sessions, manager, pool } = await setupPassiveRestartWithIdleWindow();
  try {
    const resume = trackSettlement(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    );
    await flush();
    // The call is in flight, so it is activity: the two-minute idle deadline does not apply.
    await advanceUntil(timer, 150_000, IN_FLIGHT_STEP_MS);
    expect(resume.settled()).toBe(false);
    // The row's idle deadline has passed, but the recovery is still running: a heartbeat or
    // session-info lookup keeps naming the handoff, never `expired` (#11361).
    expect(await sessions.getReleasedSessionReason("session")).toMatch(/^device-restart:/);
    expect(await sessions.getExpiredReleaseSnapshot("session")).toBeUndefined();
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    timer.advanceTime(1_000);
    expect(await resume.result).toMatchObject({
      sessionId: "session",
      assignedDevice: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a client retrying through a cold boot keeps its session past the idle window", async () => {
  const { timer, sessions, manager, pool } = await setupPassiveRestartWithIdleWindow();
  try {
    // Each call gives up at its own request deadline; the daemon records each call's end.
    for (const requestDeadlineMs of [60_000, 120_000]) {
      const attempt = trackSettlement(
        sessions.getOrCreateSession("session", pool, "android", {
          requireIssuedSession: true,
          requestDeadlineMs,
        }),
      );
      await flush();
      await advanceUntil(timer, requestDeadlineMs);
      expect(String(await attempt.result)).toContain("Cannot safely recover session");
      sessions.recordToolCallEnded("session");
    }
    // Past the idle deadline recorded at the device loss, the retrying client is still admitted.
    const retry = trackSettlement(
      sessions.getOrCreateSession("session", pool, "android", {
        requireIssuedSession: true,
        requestDeadlineMs: 180_000,
      }),
    );
    await flush();
    await advanceUntil(timer, 170_000);
    expect(retry.settled()).toBe(false);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    timer.advanceTime(1_000);
    expect(await retry.result).toMatchObject({
      sessionId: "session",
      assignedDevice: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("restart-recovery activity survives a daemon restart during the device restart (#10713)", async () => {
  const { timer, persistence, sessions, pool } = await setupPassiveRestartWithIdleWindow();
  try {
    const attempt = trackSettlement(
      sessions.getOrCreateSession("session", pool, "android", {
        requireIssuedSession: true,
        requestDeadlineMs: 60_000,
      }),
    );
    await flush();
    await advanceUntil(timer, 60_000);
    expect(String(await attempt.result)).toContain("Cannot safely recover session");
    sessions.recordToolCallEnded("session");
    await flush();
    expect(await persistence.getSession("session")).toMatchObject({
      expires_at_ms: 60_000 + RESTART_TEST_IDLE_MS,
    });
  } finally {
    sessions.stopCleanupTimer();
  }

  // A fresh daemon has no in-memory activity; past the expiry stored at the device loss it still
  // admits the retrying client because the activity was persisted.
  const restarted = new SessionManager(timer, persistence);
  try {
    timer.setCurrentTime(RESTART_TEST_IDLE_MS + 30_000);
    expect(await restarted.isReleasedSessionInRestartRecoveryWindow("session")).toBe(true);
  } finally {
    restarted.stopCleanupTimer();
  }
});

test("a quiet client loses device-restart recovery two minutes after its last call ends", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestartWithIdleWindow();
  try {
    const attempt = trackSettlement(
      sessions.getOrCreateSession("session", pool, "android", {
        requireIssuedSession: true,
        requestDeadlineMs: 30_000,
      }),
    );
    await flush();
    await advanceUntil(timer, 30_000);
    expect(String(await attempt.result)).toContain("Cannot safely recover session");
    sessions.recordToolCallEnded("session");
    const lastCallEndedAt = timer.now();

    // The client goes quiet; the device comes back inside the cold-boot window but too late.
    await advanceUntil(timer, lastCallEndedAt + RESTART_TEST_IDLE_MS);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    // The lapsed recovery is the typed terminal refusal, not an untyped not-found (#11361).
    const lapsed = await sessions
      .getOrCreateSession("session", pool, "android", { requireIssuedSession: true })
      .catch((error: unknown) => error);
    expect(lapsed).toBeInstanceOf(TerminalSessionError);
    expect((lapsed as TerminalSessionError).release.releaseReason).toBe("expired");
    expect(await persistence.getSession("session")).toMatchObject({
      status: "expired",
      release_reason: "expired",
    });
    expect(sessions.getSession("session")).toBeNull();
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a resolved old-serial replacement keeps recovery pending despite another unknown emulator", async () => {
  const { persistence, sessions, manager, pool } = await setupSettledRestart();
  try {
    manager.bootedDevices = [
      { ...original, name: "Different_AVD" },
      { ...original, deviceId: "emulator-5556", name: "Unknown (emulator-5556)" },
    ];
    await pool.refreshDevices();
    await expect(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    ).rejects.toMatchObject({
      name: "SessionRecoveryAssignmentError",
      details: { code: "session_recovery_pending", retryable: true },
    });
    expect(await persistence.getSession("session")).toMatchObject({
      release_reason: `device-restart:${original.name}`,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("active emulator loss adopts a same-AVD replacement at a new serial", async () => {
  const { sessions, manager, pool, captured } = await setupWith(new KillTrackingShutdownManager());
  try {
    const returned = { ...original, deviceId: "emulator-5556" };
    manager.bootedDevices = [returned];
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).resolves.toBe("recovered");
    expect(sessions.getSession("session")).toMatchObject({
      sessionId: "session",
      assignedDevice: returned.deviceId,
    });
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("active emulator loss rebinds a pooled same-AVD replacement at a new serial", async () => {
  const { sessions, manager, pool, captured } = await setupWith(new KillTrackingShutdownManager());
  try {
    const returned = { ...original, deviceId: "emulator-5556" };
    manager.bootedDevices = [returned];
    await pool.addDevice(returned, image);
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).resolves.toBe("recovered");
    expect(sessions.getSession("session")?.assignedDevice).toBe(returned.deviceId);
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("active emulator loss adopts a new serial after its tracked process exits", async () => {
  const { sessions, manager, pool, captured } = await setupWith(new KillTrackingShutdownManager());
  try {
    const exitedProcess = new ExitedChildProcess();
    pool.testHooks.startedDeviceProcesses.set(original.deviceId, exitedProcess);
    const returned = { ...original, deviceId: "emulator-5556" };
    manager.bootedDevices = [returned];
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).resolves.toBe("recovered");
    expect(sessions.getSession("session")?.assignedDevice).toBe(returned.deviceId);
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("awaiting-owner emulator loss and same-serial return preserve the rehydrated session", async () => {
  const manager = new LaggingShutdownManager(original.deviceId);
  const { timer, sessions, pool, captured } = await setupAwaitingOwner(manager);
  const originalSession = sessions.getSession("session");
  const originalConnectionId = `${captured.id}#${captured.incarnation}`;
  try {
    expect(originalSession).toMatchObject({ ownership: "awaiting-owner" });
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    manager.bootedDevices = [];
    timer.advanceTime(1_000);

    await expect(recovery).resolves.toBe("recovered");
    const replacement = pool.getDevice(original.deviceId)!;
    expect(sessions.getSession("session")).toBe(originalSession);
    expect(sessions.getSession("session")).toMatchObject({
      sessionId: "session",
      assignedDevice: original.deviceId,
      stableDeviceId: original.name,
      ownership: "awaiting-owner",
    });
    expect(replacement).toMatchObject({ sessionId: "session", status: "busy" });
    expect(`${replacement.id}#${replacement.incarnation}`).not.toBe(originalConnectionId);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("emulator loss and port change preserve the session while updating its runtime device", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const originalSession = sessions.getSession("session");
  const originalConnectionId = `${captured.id}#${captured.incarnation}`;
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    manager.bootedDevices = [];
    timer.advanceTime(1_000);

    await expect(recovery).resolves.toBe("recovered");
    const replacement = pool.getDevice("emulator-5560")!;
    expect(sessions.getSession("session")).toBe(originalSession);
    expect(sessions.getSession("session")).toMatchObject({
      sessionId: "session",
      assignedDevice: "emulator-5560",
      stableDeviceId: original.name,
    });
    expect(replacement).toMatchObject({
      avdName: original.name,
      sessionId: "session",
      status: "busy",
    });
    expect(`${replacement.id}#${replacement.incarnation}`).not.toBe(originalConnectionId);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("recovery fails within its shutdown bound and preserves the old ownership when disappearance is unconfirmed", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await recovery).toBe(false);
    expect(manager.startedDevices).toHaveLength(0);
    expect(pool.getDevice(original.deviceId)).toBe(captured);
    expect(sessions.getSession("session")?.assignedDevice).toBe(original.deviceId);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("failed or unresolved Android discovery cannot authorize a recovery relaunch", async () => {
  for (const unresolved of [false, true]) {
    const { sessions, manager, pool, captured } = await setup();
    try {
      if (unresolved) {
        manager.bootedDevices = [{ ...original, name: "Unknown (emulator-5554)" }];
      } else {
        manager.failedPlatforms.add("android");
      }
      expect(
        await pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(original.deviceId, captured),
      ).toBe(false);
      expect(manager.startedDevices).toHaveLength(0);
      expect(pool.getDevice(original.deviceId)).toBe(captured);
    } finally {
      sessions.stopCleanupTimer();
    }
  }
});

test("hung checked discovery times out without a late kill or relaunch", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const scan =
    Promise.withResolvers<Awaited<ReturnType<FakeDeviceManager["getBootedDevicesDetailed"]>>>();
  const entered = Promise.withResolvers<void>();
  manager.getBootedDevicesDetailed = async () => {
    entered.resolve();
    return scan.promise;
  };
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await entered.promise;
    timer.advanceTime(30_000);
    expect(await recovery).toBe(false);
    scan.resolve({ devices: [original], succeededPlatforms: new Set(["android"]) });
    await flush();
    expect(manager.startedDevices).toHaveLength(0);
    expect(pool.getDevice(original.deviceId)).toBe(captured);
    expect(sessions.getSession("session")?.assignedDevice).toBe(original.deviceId);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a different AVD reusing the serial is preserved after shutdown", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  let killCalls = 0;
  manager.killDevice = async () => {
    killCalls++;
    manager.killAccepted.resolve();
  };
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    manager.bootedDevices = [{ ...original, name: "Pixel_9" }];
    timer.advanceTime(1_000);
    expect(await recovery).toBe(true);
    expect(killCalls).toBe(1);
    expect(manager.startedDevices).toHaveLength(1);
  } finally {
    sessions.stopCleanupTimer();
  }
});
