import { recoveryInternals } from "../helpers/devicePoolRecoveryInternals";
import { expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  original,
  image,
  BlockingRecoveryReadyManager,
  PerAvdBlockingReadyManager,
  FailingGetIncidentStore,
  setup,
  assertNoRecoveryReservationsRemain,
  flush,
} from "../helpers/devicePoolRecoveryShutdownHarness";

type RecoveryFixture = Pick<
  Awaited<ReturnType<typeof setup>>,
  "timer" | "manager" | "pool" | "captured"
>;

/** First loss recovery cannot confirm the emulator shutdown, so it defers after the 30s cooldown. */
const deferFirstLossRecovery = async (
  { timer, manager, pool, captured }: RecoveryFixture,
  incidentId?: string,
): Promise<void> => {
  const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
    original.deviceId,
    incidentId,
    captured,
  );
  await manager.killAccepted.promise;
  await flush();
  timer.advanceTime(30_000);
  expect(await firstRecovery).toBe("deferred");
};

/** First ADB-reset recovery cannot confirm the emulator shutdown, so it returns false after 30s. */
const deferFirstAdbResetRecovery = async ({
  timer,
  manager,
  pool,
  captured,
}: RecoveryFixture): Promise<void> => {
  const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
    original.deviceId,
    captured,
  );
  await manager.killAccepted.promise;
  await flush();
  timer.advanceTime(30_000);
  expect(await firstRecovery).toBe(false);
};

/** Step a terminal recovery attempt through its cooldown and release-retry windows. */
const advanceThroughTerminalRecovery = async (timer: FakeTimer): Promise<void> => {
  await flush();
  timer.advanceTime(30_000);
  await flush();
  timer.advanceTime(1_000);
  await flush();
  timer.advanceTime(1_000);
};

const recordLossIncident = async (pool: RecoveryFixture["pool"]): Promise<string> => {
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "device-discovery-miss",
    undefined,
    "absent",
  );
  if (!incidentId) {
    throw new Error("Expected emulator-loss incident to be recorded");
  }
  return incidentId;
};

// These tests exercise the three-minute restart recovery window, which the idle deadline caps.
useSessionIdleWindowForSuite();

test("detached ADB-reset ownership remains quarantined when emulator shutdown is unconfirmed", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    const cohort = await pool.detachAdbServerResetCohort([captured]);
    expect(cohort.devices).toHaveLength(1);
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await recovery).toBe(false);
    expect(manager.startedDevices).toHaveLength(0);
    expect(sessions.getSession("session")?.assignedDevice).toBe(original.deviceId);
    await pool.releaseAdbServerResetCohortReservations(cohort.devices);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);
    const waiting = new AbortController();
    let admitted = false;
    const admission = pool
      .waitForAdbServerResetRecoveryMatchingName(original.name, waiting.signal)
      .then(
        () => {
          admitted = true;
        },
        () => {},
      );
    await flush();
    expect(admitted).toBe(false);
    waiting.abort();
    await admission;
    manager.bootedDevices = [];
    expect(
      await pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(original.deviceId, captured),
    ).toBe(true);
    await pool.releaseAdbServerResetCohortReservations(cohort.devices);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
    await pool.waitForAdbServerResetRecoveryMatchingName(original.name);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("ADB-reset recovery settles its incident when the deferred sweep runs", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    await pool.detachAdbServerResetCohort([captured]);
    const incidentId = captured.adbServerResetIncidentId;
    if (!incidentId) {
      throw new Error("Expected ADB-reset incident to be recorded");
    }
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    expect(pool.getRecoveringAndroidTargets().serials.has(original.deviceId)).toBe(true);
    timer.advanceTime(30_000);
    expect(await recovery).toBe(false);
    expect(
      (await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome,
    ).toBeUndefined();

    manager.bootedDevices = [];
    timer.advanceTime(30_000);
    await pool.retryDueDeferredSessionRecoveries();

    expect(pool.getRecoveringAndroidTargets().names.has(original.name)).toBe(false);
    expect(pool.getRecoveringAndroidTargets().serials.has(original.deviceId)).toBe(false);
    expect((await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome).toMatch(
      /^(recovered|exhausted)$/,
    );
    let reservationReleased = false;
    void pool.waitForAdbServerResetRecoveryMatchingName(original.name).then(() => {
      reservationReleased = true;
    });
    await flush();
    expect(reservationReleased).toBe(true);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("ADB-reset recovery releases after its retry also has unconfirmed shutdown", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    const cohort = await pool.detachAdbServerResetCohort([captured]);
    const incidentId = captured.adbServerResetIncidentId;
    if (!incidentId) {
      throw new Error("Expected ADB-reset incident to be recorded");
    }
    await deferFirstAdbResetRecovery({ timer, manager, pool, captured });
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);

    timer.advanceTime(30_000);
    const retry = pool.retryDueDeferredSessionRecoveries();
    await flush();
    timer.advanceTime(30_000);
    await retry;

    expect(sessions.getSession("session")).toBeNull();
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
    expect(recoveryInternals(pool).recoveringSessionLosses.has("session")).toBe(false);
    expect(recoveryInternals(pool).recoveringAndroidImages.has(original.name)).toBe(false);
    expect((await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome).toMatch(
      /^(recovered|exhausted)$/,
    );
    await pool.releaseAdbServerResetCohortReservations(cohort.devices);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("ADB-reset terminal release failure retains its recovery fence", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const internals = pool.testHooks;
  const recoveryState = recoveryInternals(pool);
  const originalReleaseSession = sessions.releaseSession.bind(sessions);
  sessions.releaseSession = async () => {
    throw new Error("ADB-reset release persistence failed");
  };
  try {
    await pool.detachAdbServerResetCohort([captured]);
    await deferFirstAdbResetRecovery({ timer, manager, pool, captured });

    timer.advanceTime(30_000);
    const terminalRecovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await advanceThroughTerminalRecovery(timer);
    await expect(terminalRecovery).rejects.toThrow("ADB-reset release persistence failed");

    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(true);
    expect(recoveryState.recoveringSessionLosses.has("session")).toBe(true);
    expect(recoveryState.recoveringAndroidImages.has(original.name)).toBe(true);
  } finally {
    sessions.releaseSession = originalReleaseSession;
    sessions.stopCleanupTimer();
  }
});

test("ADB-reset recovery clears its failed-release fence after a later release", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const internals = pool.testHooks;
  const recoveryState = recoveryInternals(pool);
  const originalReleaseSession = sessions.releaseSession.bind(sessions);
  sessions.releaseSession = async () => {
    throw new Error("ADB-reset release persistence failed");
  };
  try {
    const cohort = await pool.detachAdbServerResetCohort([captured]);
    await deferFirstAdbResetRecovery({ timer, manager, pool, captured });

    timer.advanceTime(30_000);
    const failedRecovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await advanceThroughTerminalRecovery(timer);
    await expect(failedRecovery).rejects.toThrow("ADB-reset release persistence failed");
    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(true);
    expect(recoveryState.recoveringSessionLosses.has("session")).toBe(true);

    // The retained fence is not a due deferred retry: the sweep must wait for
    // a later durable release rather than re-running the failed recovery.
    sessions.releaseSession = originalReleaseSession;
    timer.advanceTime(30_000);
    await pool.retryDueDeferredSessionRecoveries();
    await flush();
    expect(recoveryState.failedTerminalRecoveryReleases.has("session")).toBe(true);
    expect(recoveryState.recoveringSessionLosses.has("session")).toBe(true);
    expect(manager.startedDevices).toHaveLength(0);

    await originalReleaseSession("session", "explicit-release");
    await flush();

    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(false);
    expect(recoveryState.recoveringSessionLosses.has("session")).toBe(false);
    expect(recoveryState.failedTerminalRecoveryReleases.has("session")).toBe(false);

    const abort = new AbortController();
    let reservationReleased = false;
    const reservation = pool
      .waitForAdbServerResetRecoveryMatchingName(original.name, abort.signal)
      .then(
        () => {
          reservationReleased = true;
        },
        () => {},
      );
    await flush();
    abort.abort();
    await reservation;
    expect(reservationReleased).toBe(true);
    expect(cohort.devices).toHaveLength(1);
  } finally {
    sessions.releaseSession = originalReleaseSession;
    sessions.stopCleanupTimer();
  }
});

test("ordinary session recovery retries after its deferred shutdown cooldown", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await recovery).toBe("deferred");
    expect(manager.startedDevices).toHaveLength(0);
    expect(sessions.getSession("session")?.assignedDevice).toBe(original.deviceId);
    expect(pool.getDevice(original.deviceId)).toBe(captured);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);
    expect(pool.getRecoveringAndroidTargets().serials.has(original.deviceId)).toBe(true);

    manager.bootedDevices = [];
    expect(
      await pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).toBe("deferred");
    expect(manager.startedDevices).toHaveLength(0);

    timer.advanceTime(30_000);
    expect(
      await pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).toBe("recovered");
    expect(manager.startedDevices).toHaveLength(1);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a deferred session recovery incident remains pending until its retry recovers", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    const incidentId = await recordLossIncident(pool);
    await deferFirstLossRecovery({ timer, manager, pool, captured }, incidentId);
    expect(
      (await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome,
    ).toBeUndefined();

    manager.bootedDevices = [];
    timer.advanceTime(30_000);
    await pool.retryDueDeferredSessionRecoveries();

    expect((await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome).toBe(
      "recovered",
    );
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("release during shutdown confirmation finalizes session recovery instead of deferring it", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const internals = pool.testHooks;
  let finalizations = 0;
  const restoreComplete = internals.completeEmulatorLossRecovery.intercept(
    (completeRecovery) =>
      async (...args) => {
        finalizations++;
        await completeRecovery(...args);
      },
  );
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await sessions.releaseSession("session", "explicit-release");
    await flush();

    timer.advanceTime(30_000);
    expect(await recovery).toBe("released");
    assertNoRecoveryReservationsRemain(pool, "session");
    expect(finalizations).toBe(1);

    const releaseLease = await pool.reserveAndroidStartupLease(original.name, true);
    await releaseLease();
  } finally {
    restoreComplete();
    sessions.stopCleanupTimer();
  }
});

test("release fires while awaiting incident-store persistence", async () => {
  const cancellation = Promise.withResolvers<number>();
  const cancellationStarted = Promise.withResolvers<void>();
  const { sessions, pool, captured } = await setup(undefined, async () => {
    cancellationStarted.resolve();
    return await cancellation.promise;
  });
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "device-discovery-miss",
    undefined,
    "absent",
  );
  if (!incidentId) {
    throw new Error("Expected emulator-loss incident to be recorded");
  }
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      incidentId,
      captured,
    );
    await cancellationStarted.promise;
    await sessions.releaseSession("session", "explicit-release");
    cancellation.resolve(0);

    expect(await recovery).toBe("released");
    expect((await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome).toBeDefined();
    assertNoRecoveryReservationsRemain(pool, "session");
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("release with an unavailable incident repository still finalizes the released record", async () => {
  const cancellation = Promise.withResolvers<number>();
  const cancellationStarted = Promise.withResolvers<void>();
  const store = new FailingGetIncidentStore(new FakeTimer());
  const { sessions, pool, captured } = await setup(
    undefined,
    async () => {
      cancellationStarted.resolve();
      return await cancellation.promise;
    },
    store,
  );
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "device-discovery-miss",
    undefined,
    "absent",
  );
  if (!incidentId) {
    throw new Error("Expected emulator-loss incident to be recorded");
  }
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      incidentId,
      captured,
    );
    await cancellationStarted.promise;
    await sessions.releaseSession("session", "explicit-release");
    store.failGets = true;
    cancellation.resolve(0);

    expect(await recovery).toBe("released");
    expect(recoveryInternals(pool).failedTerminalRecoveryReleases.has("session")).toBe(false);
    assertNoRecoveryReservationsRemain(pool, "session");
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a stale due-recovery snapshot does not finalize a record another sweep is recovering", async () => {
  const manager = new PerAvdBlockingReadyManager();
  const { timer, sessions, pool, captured } = await setup(manager);
  const internals = pool.testHooks;
  const recoveryState = recoveryInternals(pool);
  const second: BootedDevice = {
    name: "Pixel_8_API_35_2",
    platform: "android",
    deviceId: "emulator-5556",
  };
  const secondImage: DeviceInfo = { ...image, name: second.name };
  manager.bootedDevices = [original, second];
  await pool.addDevice(second, secondImage);
  await pool.bindOrReuseDeviceSession({
    sessionId: "session-2",
    deviceId: second.deviceId,
    platform: "android",
    sourceImage: secondImage,
    expectedIdentity: second,
  });
  const capturedSecond = pool.getDevice(second.deviceId)!;
  try {
    for (const [deviceId, device] of [
      [original.deviceId, captured],
      [second.deviceId, capturedSecond],
    ] as const) {
      const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(deviceId, undefined, device);
      await flush();
      timer.advanceTime(30_000);
      expect(await recovery).toBe("deferred");
    }
    expect(manager.kills).toEqual([original.deviceId, second.deviceId]);

    manager.bootedDevices = [];
    timer.advanceTime(30_000);
    const sweepA = pool.retryDueDeferredSessionRecoveries();
    await manager.readinessStartedFor(original.name);
    const sweepB = pool.retryDueDeferredSessionRecoveries();
    await manager.readinessStartedFor(second.name);
    expect(manager.startedDevices.map((device) => device.name)).toEqual([
      original.name,
      second.name,
    ]);

    await sessions.releaseSession("session-2", "explicit-release");
    manager.releaseReadinessFor(original.name);
    await sweepA;

    // Sweep B still owns session-2's reboot: sweep A must leave its record alone.
    expect(recoveryState.sessionPreservingRecoveries.has("session-2")).toBe(true);
    expect(recoveryState.recoveringSessionLosses.has("session-2")).toBe(true);
    expect(internals.adbServerResetQuarantinedSessions.has("session-2")).toBe(true);
    expect(recoveryState.recoveringAndroidImages.has(second.name)).toBe(true);
    expect(sessions.getSession("session")?.assignedDevice).toBe(`${original.name}-replacement`);

    manager.releaseReadinessFor(second.name);
    await sweepB;
    expect(manager.startedDevices).toHaveLength(2);
    expect(recoveryState.sessionPreservingRecoveries.has("session-2")).toBe(false);
    expect(recoveryState.recoveringSessionLosses.has("session-2")).toBe(false);
    expect(internals.adbServerResetQuarantinedSessions.has("session-2")).toBe(false);
    expect(recoveryState.recoveringAndroidImages.has(second.name)).toBe(false);
    expect(internals.recoveryCoordinator.recoveringAndroidImageSettlements.has(second.name)).toBe(
      false,
    );
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("an old ADB-reset cohort sweep cannot clear a newer recovery record", async () => {
  const { sessions, pool, captured } = await setup();
  const internals = pool.testHooks;
  const recoveryState = recoveryInternals(pool);
  try {
    const oldRecord = internals.startAndroidRecoveryRecord(
      "session",
      { deviceId: original.deviceId, avdName: original.name },
      ["quarantine", "loss", "reset-cohort"],
      true,
    );
    captured.adbServerResetSessionId = "session";
    captured.adbServerResetSession = sessions.getSession("session") ?? undefined;
    captured.adbServerResetRecoveryGeneration = oldRecord.generation;
    let resolved = false;
    const reservationSettled = Promise.withResolvers<void>();
    internals.adbServerResetRecoveryReservations.set(original.name, {
      deviceId: original.deviceId,
      image,
      cancelled: false,
      settled: reservationSettled.promise,
      sessionId: "session",
      recoveryGeneration: oldRecord.generation,
      resolve: () => {
        resolved = true;
        reservationSettled.resolve();
      },
    });

    const newRecord = internals.startAndroidRecoveryRecord(
      "session",
      { deviceId: "emulator-5560", avdName: original.name },
      ["quarantine", "loss", "reset-cohort"],
      true,
    );
    internals.adbServerResetRecoveryReservations.get(original.name)!.recoveryGeneration =
      newRecord.generation;

    await pool.releaseAdbServerResetCohortReservations([captured]);

    expect(recoveryState.recoveringSessionLosses.get("session")?.generation).toBe(
      newRecord.generation,
    );
    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(true);
    expect(internals.adbServerResetRecoveryReservations.has(original.name)).toBe(true);
    expect(resolved).toBe(false);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("terminal recovery release failure retains the recovery fence until a later release", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const internals = pool.testHooks;
  const recoveryState = recoveryInternals(pool);
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "device-discovery-miss",
    undefined,
    "absent",
  );
  if (!incidentId) {
    throw new Error("Expected emulator-loss incident to be recorded");
  }
  const originalReleaseSession = sessions.releaseSession.bind(sessions);
  sessions.releaseSession = async () => {
    throw new Error("release persistence failed");
  };
  try {
    await deferFirstLossRecovery({ timer, manager, pool, captured }, incidentId);

    timer.advanceTime(30_000);
    const terminalRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      incidentId,
      captured,
    );
    await advanceThroughTerminalRecovery(timer);
    await expect(terminalRecovery).rejects.toThrow("release persistence failed");

    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(true);
    expect(recoveryState.recoveringSessionLosses.has("session")).toBe(true);
    expect(recoveryState.recoveringAndroidImages.has(original.name)).toBe(true);
    expect((await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome).toBe(
      "exhausted",
    );

    sessions.releaseSession = originalReleaseSession;
    const lease = pool.reserveAndroidStartupLease(original.name, true);
    let releaseLease: (() => Promise<void>) | undefined;
    const leaseReady = lease.then((release) => {
      releaseLease = release;
    });
    await flush();
    expect(releaseLease).toBeUndefined();

    await originalReleaseSession("session", "explicit-release");
    await leaseReady;
    assertNoRecoveryReservationsRemain(pool, "session");
    await releaseLease?.();
  } finally {
    sessions.releaseSession = originalReleaseSession;
    sessions.stopCleanupTimer();
  }
});

test("a retained failure fence is not re-swept as a due deferred recovery", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const recoveryState = recoveryInternals(pool);
  const originalReleaseSession = sessions.releaseSession.bind(sessions);
  sessions.releaseSession = async () => {
    throw new Error("release persistence failed");
  };
  try {
    await deferFirstLossRecovery({ timer, manager, pool, captured });

    timer.advanceTime(30_000);
    const terminalRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await advanceThroughTerminalRecovery(timer);
    await expect(terminalRecovery).rejects.toThrow("release persistence failed");
    expect(recoveryState.failedTerminalRecoveryReleases.has("session")).toBe(true);
    expect(manager.startedDevices).toHaveLength(0);

    // Shutdown is now confirmable, so a relaunch would actually start a device.
    manager.bootedDevices = [];
    for (let poll = 0; poll < 3; poll++) {
      timer.advanceTime(30_000);
      await pool.retryDueDeferredSessionRecoveries();
      await flush();
    }
    expect(manager.startedDevices).toHaveLength(0);
    expect(recoveryState.failedTerminalRecoveryReleases.has("session")).toBe(true);
    expect(recoveryState.recoveringSessionLosses.has("session")).toBe(true);
    expect(sessions.getSession("session")?.assignedDevice).toBe(original.deviceId);
    expect(
      await pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).toBe("deferred");
    expect(manager.startedDevices).toHaveLength(0);

    sessions.releaseSession = originalReleaseSession;
    await originalReleaseSession("session", "explicit-release");
    await flush();
    assertNoRecoveryReservationsRemain(pool, "session");
    expect(manager.startedDevices).toHaveLength(0);
  } finally {
    sessions.releaseSession = originalReleaseSession;
    sessions.stopCleanupTimer();
  }
});

test("disconnect recovery retries through the daemon after its deferred shutdown cooldown", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const daemon = new Daemon(
    {},
    { installedAppsRepository: new FakeInstalledAppsRepository(), timer },
  );
  const internals = daemon.testHooks;
  internals.replaceDevicePool(pool);
  internals.replaceSessionManager(sessions);
  pool.isCurrentDisconnectedDevice = async () => "current";
  try {
    const firstPass = internals.recordAndTryRecoverCapturedDisconnect(
      original.deviceId,
      captured,
      captured.assignmentCount,
      "session",
      sessions.getSession("session"),
      undefined,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstPass).toMatchObject({ handled: true });
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);

    manager.bootedDevices = [];
    timer.advanceTime(30_000);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
    const secondPass = await internals.recordAndTryRecoverCapturedDisconnect(
      original.deviceId,
      captured,
      captured.assignmentCount,
      "session",
      sessions.getSession("session"),
      undefined,
    );

    expect(secondPass).toMatchObject({ handled: true });
    expect(manager.startedDevices).toHaveLength(1);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
  } finally {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    sessions.stopCleanupTimer();
  }
});

test("a tracked deferred recovery sweep does not block another due-retry check", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const daemon = new Daemon(
    {},
    { installedAppsRepository: new FakeInstalledAppsRepository(), timer },
  );
  const internals = daemon.testHooks;
  try {
    await deferFirstLossRecovery({ timer, manager, pool, captured });

    timer.advanceTime(30_000);
    const blockedRetry = pool.retryDueDeferredSessionRecoveries();
    daemon.trackDeferredSessionRecoverySweep(blockedRetry);
    await flush();
    expect(internals.deferredSessionRecoverySweeps.has(blockedRetry)).toBe(true);

    await pool.retryDueDeferredSessionRecoveries();
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);

    manager.bootedDevices = [];
    timer.advanceTime(1_000);
    await blockedRetry;
    await flush();
    expect(internals.deferredSessionRecoverySweeps.has(blockedRetry)).toBe(false);
  } finally {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    sessions.stopCleanupTimer();
  }
});

test("ordinary session recovery releases after its retry also has unconfirmed shutdown", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    await deferFirstLossRecovery({ timer, manager, pool, captured });

    timer.advanceTime(30_000);
    const retry = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await flush();
    timer.advanceTime(30_000);
    expect(await retry).toBe("released");
    expect(sessions.getSession("session")).toBeNull();
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a deferred session recovery incident is not terminal before its retry releases", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    const incidentId = await recordLossIncident(pool);
    await deferFirstLossRecovery({ timer, manager, pool, captured }, incidentId);
    expect(
      (await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome,
    ).toBeUndefined();

    timer.advanceTime(30_000);
    const retry = pool.retryDueDeferredSessionRecoveries();
    await flush();
    timer.advanceTime(30_000);
    await retry;

    expect((await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome).toBe(
      "exhausted",
    );
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("due deferred session recovery releases while its AVD remains visible", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    await deferFirstLossRecovery({ timer, manager, pool, captured });
    expect(manager.bootedDevices).toEqual([original]);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);

    timer.advanceTime(30_000);
    const retry = pool.retryDueDeferredSessionRecoveries();
    await flush();
    timer.advanceTime(30_000);
    await retry;

    expect(sessions.getSession("session")).toBeNull();
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
    const releaseLease = await pool.reserveAndroidStartupLease(original.name, true);
    await releaseLease();
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("releasing a deferred ADB-reset session clears its retained AVD startup reservation", async () => {
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
    expect(recoveryInternals(pool).recoveringAndroidImages.has(original.name)).toBe(true);

    await sessions.releaseSession("session", "explicit-release");
    const releaseLease = await pool.reserveAndroidStartupLease(original.name, true);
    await releaseLease();
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("matching startup lease wakes when a deferred recovery settles", async () => {
  const manager = new BlockingRecoveryReadyManager();
  const { timer, sessions, pool, captured } = await setup(manager);
  try {
    await deferFirstLossRecovery({ timer, manager, pool, captured });

    let releaseLease: (() => Promise<void>) | undefined;
    const lease = pool.reserveAndroidStartupLease(original.name, true).then((release) => {
      releaseLease = release;
    });
    await flush();
    expect(releaseLease).toBeUndefined();

    manager.bootedDevices = [];
    timer.advanceTime(30_000);
    const retry = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.readinessStarted.promise;
    await flush();
    manager.releaseReadiness.resolve();
    expect(await retry).toBe("recovered");
    await lease;
    expect(releaseLease).toBeDefined();
    expect(timer.now()).toBe(60_000);
    await releaseLease?.();
  } finally {
    manager.releaseReadiness.resolve();
    sessions.stopCleanupTimer();
  }
});

test("startup lease does not cool down when matching recovery clears before settlement lookup", async () => {
  const manager = new BlockingRecoveryReadyManager();
  const { timer, sessions, pool, captured } = await setup(manager);
  try {
    await deferFirstLossRecovery({ timer, manager, pool, captured });

    manager.bootedDevices = [];
    timer.advanceTime(30_000);
    const retry = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.readinessStarted.promise;

    let releaseLease: (() => Promise<void>) | undefined;
    const internals = pool.testHooks;
    internals.setAfterAndroidStartupRecoverySnapshot(() => {
      manager.releaseReadiness.resolve();
      internals.recoveryCoordinator.clearRecoveringAndroidImage(original.name);
    });
    const recoverySettledAt = timer.now();
    const lease = pool.reserveAndroidStartupLease(original.name, true).then((release) => {
      releaseLease = release;
    });
    await flush();
    if (!releaseLease) {
      timer.advanceTime(30_000);
    }
    await lease;
    expect(await retry).toBe("recovered");
    expect(releaseLease).toBeDefined();
    expect(timer.now() - recoverySettledAt).toBeLessThan(30_000);
    await releaseLease?.();
  } finally {
    manager.releaseReadiness.resolve();
    sessions.stopCleanupTimer();
  }
});

test("unnamed startup lease ignores a different AVD's deferred recovery", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  manager.deviceImages = [
    { ...image, isRunning: false },
    { ...image, name: "Pixel_9_API_36", isRunning: false },
  ];
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await recovery).toBe("deferred");
    expect(recoveryInternals(pool).recoveringAndroidImages.has(original.name)).toBe(true);

    const releaseLease = await pool.reserveAndroidStartupLease(undefined, false);
    await releaseLease();
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("startup lease beats a shorter timeout when matching recovery settles", async () => {
  const manager = new BlockingRecoveryReadyManager();
  const { timer, sessions, pool, captured } = await setup(manager);
  try {
    await deferFirstLossRecovery({ timer, manager, pool, captured });

    manager.bootedDevices = [];
    timer.advanceTime(30_000);
    const retry = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.readinessStarted.promise;

    const abort = new AbortController();
    const timeout = timer.setTimeout(() => abort.abort(new Error("startup timed out")), 10_000);
    let releaseLease: (() => Promise<void>) | undefined;
    const lease = pool
      .reserveAndroidStartupLease(original.name, true, abort.signal)
      .then((release) => {
        releaseLease = release;
      });
    await flush();

    manager.releaseReadiness.resolve();
    expect(await retry).toBe("recovered");
    await lease;
    expect(releaseLease).toBeDefined();
    expect(timer.now()).toBe(60_000);
    timer.clearTimeout(timeout);
    await releaseLease?.();
  } finally {
    manager.releaseReadiness.resolve();
    sessions.stopCleanupTimer();
  }
});
