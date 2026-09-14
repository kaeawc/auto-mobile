import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

const original: BootedDevice = {
  name: "Pixel_8_API_35",
  platform: "android",
  deviceId: "emulator-5554",
};
const image: DeviceInfo = {
  name: original.name,
  platform: "android",
  isRunning: true,
  source: "local",
};
class LaggingShutdownManager extends FakeDeviceManager {
  readonly killAccepted = Promise.withResolvers<void>();
  override async killDevice(): Promise<void> {
    this.killAccepted.resolve();
  }
  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    this.startedDevices.push(device);
    this.bootedDevices = [{ ...original, deviceId: "emulator-5560" }];
    return { pid: 0 } as ChildProcess;
  }
  override async waitForDeviceReady(): Promise<BootedDevice> {
    return this.bootedDevices[0];
  }
}
class BlockingRecoveryReadyManager extends LaggingShutdownManager {
  readonly readinessStarted = Promise.withResolvers<void>();
  readonly releaseReadiness = Promise.withResolvers<void>();

  override async waitForDeviceReady(): Promise<BootedDevice> {
    this.readinessStarted.resolve();
    await this.releaseReadiness.promise;
    return await super.waitForDeviceReady();
  }
}

async function setup(manager: LaggingShutdownManager = new LaggingShutdownManager()) {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const pool = new DevicePool(
    sessions,
    "daemon",
    timer,
    new FakeInstalledAppsRepository(),
    manager,
    new DefaultRetryExecutor(timer),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { onLoss: true, maxAttempts: 1 },
  );
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  await pool.bindOrReuseDeviceSession(
    "session",
    original.deviceId,
    "android",
    image,
    undefined,
    original,
  );
  const captured = pool.getDevice(original.deviceId)!;
  return { timer, sessions, manager, pool, captured };
}

interface DaemonDisconnectInternals {
  devicePool: DevicePool;
  sessionManager: SessionManager;
  recordAndTryRecoverCapturedDisconnect(
    deviceId: string,
    pooledDevice: PooledDevice | null,
    assignmentCount: number,
    sessionId: string | null | undefined,
    session: Session | null,
    forceGeneration: number | undefined,
  ): Promise<{ incidentId: string | undefined; handled: boolean }>;
}

interface DaemonDeferredRecoverySweepInternals {
  deferredSessionRecoverySweeps: Set<Promise<void>>;
  trackDeferredSessionRecoverySweep(sweep: Promise<void>): void;
}

interface DevicePoolRecoveryInternals {
  adbServerResetQuarantinedSessions: Set<string>;
  recoveringAndroidImages: Map<string, DeviceInfo>;
  recoveringSessionLosses: Map<string, unknown>;
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
  ): Promise<void>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
  }
}

test("recovery waits for checked disappearance after an untracked emulator acknowledges kill", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    expect(manager.startedDevices).toHaveLength(0);
    expect(pool.getDevice(original.deviceId)).toBe(captured);
    manager.bootedDevices = [];
    timer.advanceTime(1_000);
    expect(await recovery).toBe(true);
    expect(manager.startedDevices).toHaveLength(1);
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
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe(false);
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);

    timer.advanceTime(30_000);
    const retry = pool.retryDueDeferredSessionRecoveries();
    await flush();
    timer.advanceTime(30_000);
    await retry;

    expect(sessions.getSession("session")).toBeNull();
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
    expect(
      (pool as unknown as DevicePoolRecoveryInternals).recoveringSessionLosses.has("session"),
    ).toBe(false);
    expect((await pool.waitForEmulatorLossIncident(incidentId, 0))?.recovery.outcome).toMatch(
      /^(recovered|exhausted)$/,
    );
    await pool.releaseAdbServerResetCohortReservations(cohort.devices);
  } finally {
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
    const incidentId = await pool.recordEmulatorLossIncident(
      original.deviceId,
      "device-discovery-miss",
      undefined,
      "absent",
    );
    if (!incidentId) {
      throw new Error("Expected emulator-loss incident to be recorded");
    }
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      incidentId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");
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
  const internals = pool as unknown as DevicePoolRecoveryInternals;
  const completeRecovery = internals.completeEmulatorLossRecovery;
  let finalizations = 0;
  internals.completeEmulatorLossRecovery = async (...args) => {
    finalizations++;
    await completeRecovery.call(pool, ...args);
  };
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
    expect(pool.isSessionRecoveryInFlight("session")).toBe(false);
    expect(
      (pool as unknown as DevicePoolRecoveryInternals).recoveringAndroidImages.has(original.name),
    ).toBe(false);
    expect(
      (pool as unknown as DevicePoolRecoveryInternals).recoveringSessionLosses.has("session"),
    ).toBe(false);
    expect(finalizations).toBe(1);

    const releaseLease = await pool.reserveAndroidStartupLease(original.name, true);
    await releaseLease();
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("terminal recovery release failure retains the recovery fence until a later release", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const internals = pool as unknown as DevicePoolRecoveryInternals;
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
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      incidentId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");

    timer.advanceTime(30_000);
    const terminalRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      incidentId,
      captured,
    );
    await flush();
    timer.advanceTime(30_000);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(1_000);
    await expect(terminalRecovery).rejects.toThrow("release persistence failed");

    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(true);
    expect(internals.recoveringSessionLosses.has("session")).toBe(true);
    expect(internals.recoveringAndroidImages.has(original.name)).toBe(true);
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
    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(false);
    expect(internals.recoveringSessionLosses.has("session")).toBe(false);
    expect(internals.recoveringAndroidImages.has(original.name)).toBe(false);
    await releaseLease?.();
  } finally {
    sessions.releaseSession = originalReleaseSession;
    sessions.stopCleanupTimer();
  }
});

test("disconnect recovery retries through the daemon after its deferred shutdown cooldown", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer);
  const internals = daemon as unknown as DaemonDisconnectInternals;
  internals.devicePool = pool;
  internals.sessionManager = sessions;
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
  const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer);
  const internals = daemon as unknown as DaemonDeferredRecoverySweepInternals;
  try {
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");

    timer.advanceTime(30_000);
    const blockedRetry = pool.retryDueDeferredSessionRecoveries();
    internals.trackDeferredSessionRecoverySweep(blockedRetry);
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
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");

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
    const incidentId = await pool.recordEmulatorLossIncident(
      original.deviceId,
      "device-discovery-miss",
      undefined,
      "absent",
    );
    if (!incidentId) {
      throw new Error("Expected emulator-loss incident to be recorded");
    }
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      incidentId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");
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
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");
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
    expect(
      (pool as unknown as DevicePoolRecoveryInternals).recoveringAndroidImages.has(original.name),
    ).toBe(true);

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
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");

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
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");

    manager.bootedDevices = [];
    timer.advanceTime(30_000);
    const retry = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.readinessStarted.promise;

    let releaseLease: (() => Promise<void>) | undefined;
    const internals = pool as unknown as {
      afterAndroidStartupRecoverySnapshot?: () => void;
      clearRecoveringAndroidImage(avdName: string): void;
    };
    internals.afterAndroidStartupRecoverySnapshot = () => {
      manager.releaseReadiness.resolve();
      internals.clearRecoveringAndroidImage(original.name);
    };
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
    expect(
      (pool as unknown as DevicePoolRecoveryInternals).recoveringAndroidImages.has(original.name),
    ).toBe(true);

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
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe("deferred");

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
