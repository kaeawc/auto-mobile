import { makePool } from "../helpers/makePool";
import { recoveryInternals } from "../helpers/devicePoolRecoveryInternals";
import { drainUntil, settleWithFakeTime } from "../helpers/fakeTimerStepping";
import { beforeAll, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  original,
  image,
  LaggingShutdownManager,
  KillTrackingShutdownManager,
  RearmableShutdownManager,
  setup,
  setupWith,
  setupPassiveRestart,
  flush,
} from "../helpers/devicePoolRecoveryShutdownHarness";

// These tests exercise the three-minute restart recovery window, which the idle deadline caps.
useSessionIdleWindowForSuite();

type IntentionalStopFixture = Awaited<ReturnType<typeof setup>> & {
  manager: RearmableShutdownManager;
};
let cancelledRecoveryFixture: IntentionalStopFixture;
let resetStopFixture: IntentionalStopFixture;
beforeAll(async () => {
  // Independent bound holders; the timed tests still perform the real cancellation and rebinding.
  const cancelledManager = new RearmableShutdownManager(original.deviceId);
  const resetManager = new RearmableShutdownManager(original.deviceId);
  cancelledRecoveryFixture = { ...(await setup(cancelledManager)), manager: cancelledManager };
  resetStopFixture = { ...(await setup(resetManager)), manager: resetManager };
});

test("a cancelled Android recovery does not spend the crash-loop budget (#7545)", async () => {
  const { timer, sessions, pool, captured, persistence, manager } = cancelledRecoveryFixture;
  try {
    pool.markIntentionalShutdown(captured.id);
    const firstKill = manager.nextKillAccepted();
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await firstKill;
    manager.bootedDevices = [];
    timer.advanceTime(1_000);

    await expect(firstRecovery).resolves.toBe("released");
    expect(manager.startedDevices).toHaveLength(0);
    expect(sessions.getSession("session")).toBeNull();

    // The holder stopped this device; cancellation must not create a recovery handoff.
    expect((await persistence.getSession("session"))?.release_reason).toBe("explicit-release");

    // Re-provision the AVD and bind a fresh session, then simulate a
    // genuine loss. maxAttempts is 1, so this only recovers if the
    // cancelled attempt above did not spend the budget.
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    expect(pool.genericAvailability(original.deviceId)).toBe("free");
    await pool.bindOrReuseDeviceSession({
      sessionId: "session-2",
      deviceId: original.deviceId,
      platform: "android",
      sourceImage: image,
      expectedIdentity: original,
    });
    const recaptured = pool.getDevice(original.deviceId)!;

    const secondKill = manager.nextKillAccepted();
    const secondRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      recaptured,
    );
    await secondKill;
    manager.bootedDevices = [];
    timer.advanceTime(1_000);

    await expect(secondRecovery).resolves.toBe("recovered");
    expect(manager.startedDevices).toHaveLength(1);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("holder stop during detached ADB-reset recovery leaves no restart handoff", async () => {
  const { timer, sessions, pool, captured, persistence, manager } = resetStopFixture;
  const detached = await pool.detachAdbServerResetCohort([captured]);
  try {
    pool.markIntentionalShutdown(original.deviceId);
    const kill = manager.nextKillAccepted();
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      detached.devices[0],
    );
    await kill;
    manager.bootedDevices = [];
    timer.advanceTime(1_000);
    await expect(recovery).resolves.toBe(false);
    expect((await persistence.getSession("session"))?.release_reason).toBe("explicit-release");
    expect(sessions.getSession("session")).toBeNull();
    await pool.releaseAdbServerResetCohortReservations(detached.devices);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    expect(pool.genericAvailability(original.deviceId)).toBe("free");
    await expect(
      pool.bindOrReuseDeviceSession({
        sessionId: "session-2",
        deviceId: original.deviceId,
        platform: "android",
        sourceImage: image,
        expectedIdentity: original,
      }),
    ).resolves.toBe("session-2");
  } finally {
    await pool.releaseAdbServerResetCohortReservations(detached.devices);
    pool.releaseDeviceClaimsForShutdown();
    sessions.stopCleanupTimer();
  }
});

test("same-AVD replacement is reserved while session tracking persistence stalls", async () => {
  const trackingStarted = Promise.withResolvers<void>();
  const finishTracking = Promise.withResolvers<void>();
  const replacement = { ...original, deviceId: "emulator-5556" };
  class BlockingTrackingRepository extends FakeInstalledAppsRepository {
    override async setSessionTracking(daemonId: string, deviceId: string, startedAt: number) {
      if (deviceId === replacement.deviceId) {
        trackingStarted.resolve();
        await finishTracking.promise;
      }
      await super.setSessionTracking(daemonId, deviceId, startedAt);
    }
  }
  const { sessions, manager, pool, captured, timer } = await setupWith(
    new KillTrackingShutdownManager(),
    undefined,
    undefined,
    new BlockingTrackingRepository(),
  );
  try {
    manager.bootedDevices = [replacement];
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await trackingStarted.promise;
    let allocated = false;
    const competing = pool.assignDeviceToSession("competitor", "android");
    void competing.then(
      () => {
        allocated = true;
      },
      () => {},
    );
    await drainUntil(() => timer.getPendingSleepCount() > 0, {
      description: "competing allocator parked behind recovery",
    });
    expect(allocated).toBe(false);
    expect(pool.getDevice(replacement.deviceId)?.sessionId).toBeNull();
    finishTracking.resolve();
    await expect(recovery).resolves.toBe("recovered");
    expect(sessions.getSession("session")?.assignedDevice).toBe(replacement.deviceId);
    expect(recoveryInternals(pool).androidRecoveryHandoffOwners.size).toBe(0);
    // End the ordinary allocator's bounded wait without any wall-clock timers.
    await settleWithFakeTime(
      timer,
      competing.then(
        () => undefined,
        () => undefined,
      ),
      { stepMs: 1000, maxSteps: 60, description: "competing allocation timeout" },
    );
    await expect(competing).rejects.toThrow();
  } finally {
    finishTracking.resolve();
    sessions.stopCleanupTimer();
  }
});

test("coalesced passive loss inherits the resolved primary awaiting-device settlement", async () => {
  const { sessions, pool, captured } = await setupPassiveRestart(false);
  try {
    const primary = await pool.recordEmulatorLossIncident(
      original.deviceId,
      "watched-process-exit",
    );
    const joined = await pool.recordEmulatorLossIncident(
      original.deviceId,
      "device-discovery-miss",
    );
    expect(primary).toBeDefined();
    expect(joined).toBeDefined();
    await pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, primary, captured);
    await pool.testHooks.joinSessionPreservingRecovery(
      { incidentId: primary, promise: Promise.resolve("released") },
      joined,
    );
    expect(await pool.waitForEmulatorLossIncident(joined!, 0)).toMatchObject({
      recovery: { outcome: "not-attempted" },
      session: { state: "awaiting-device" },
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("terminal teardown wins over a joined device-restart release settlement", async () => {
  const { sessions, pool, captured, persistence } = await setupPassiveRestart(false);
  const finishSetup = Promise.withResolvers<void>();
  try {
    const session = sessions.getSession("session")!;
    const setup = sessions.trackSessionSetup(session, () => finishSetup.promise);
    const incident = await pool.recordEmulatorLossIncident(
      original.deviceId,
      "device-discovery-miss",
    );
    const terminal = sessions.releaseSession("session", "heartbeat-timeout");
    await flush();
    expect(sessions.isCurrentSession(session)).toBe(true);
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      incident,
      captured,
    );
    await flush();
    finishSetup.resolve();
    await Promise.all([setup, terminal, recovery]);
    expect(await persistence.getSession("session")).toMatchObject({
      release_reason: "heartbeat-timeout",
    });
    expect(await pool.waitForEmulatorLossIncident(incident!, 0)).toMatchObject({
      session: { state: "released" },
    });
  } finally {
    finishSetup.resolve();
    sessions.stopCleanupTimer();
  }
});

async function setupSessionlessUnconfirmedRecovery() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new LaggingShutdownManager();
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    recoveryPolicy: { onLoss: true, maxAttempts: 1 },
  });
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  // Android discovery cannot confirm the old emulator stopped.
  manager.failedPlatforms.add("android");
  await expect(pool.removeDisconnectedDevice(original.deviceId, false)).rejects.toBeInstanceOf(
    ActionableError,
  );
  await flush();
  expect(manager.startedDevices).toHaveLength(0);
  return { timer, sessions, manager, pool };
}

test("a sessionless recovery with unconfirmed shutdown reserves the AVD and startDevice fails fast naming it", async () => {
  const { timer, sessions, pool } = await setupSessionlessUnconfirmedRecovery();
  try {
    expect(pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));
    await expect(pool.reserveAndroidStartupLease(original.name, true)).rejects.toThrow(
      `Android AVD '${original.name}' is reserved by an interrupted emulator recovery`,
    );
    // Failed without a boot-budget wait: no FakeTimer sleep or deadline was needed.
    expect(timer.getSleepHistory()).toEqual([]);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a later fresh observation showing the AVD gone lifts the sessionless reservation", async () => {
  const { sessions, manager, pool } = await setupSessionlessUnconfirmedRecovery();
  try {
    manager.failedPlatforms.clear();
    manager.bootedDevices = [];
    await pool.refreshDevices();
    expect(pool.getRecoveringAndroidTargets().names.size).toBe(0);
    const release = await pool.reserveAndroidStartupLease(original.name, true);
    await release();
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a later fresh observation showing the AVD running lifts the reservation and leaves it pooled", async () => {
  const { sessions, manager, pool } = await setupSessionlessUnconfirmedRecovery();
  try {
    manager.failedPlatforms.clear();
    manager.bootedDevices = [original];
    await pool.refreshDevices();
    expect(pool.getRecoveringAndroidTargets().names.size).toBe(0);
    expect(pool.getDevice(original.deviceId)).not.toBeNull();
    const release = await pool.reserveAndroidStartupLease(original.name, true);
    await release();
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("an inconclusive observation keeps the sessionless reservation", async () => {
  const { sessions, manager, pool } = await setupSessionlessUnconfirmedRecovery();
  try {
    // Discovery still failing, then an unresolved identity: neither proves anything.
    await pool.refreshDevices();
    expect(pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));
    manager.failedPlatforms.clear();
    manager.bootedDevices = [{ ...original, name: "Unknown (emulator-5554)" }];
    await pool.refreshDevices();
    expect(pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));
  } finally {
    sessions.stopCleanupTimer();
  }
});
