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

interface DevicePoolRecoveryInternals {
  recoveringAndroidImages: Map<string, DeviceInfo>;
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
