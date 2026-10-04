import { drainUntil, drainUntilQuiescent, settleWithFakeTime } from "../helpers/fakeTimerStepping";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { ActionableError } from "../../src/models/ActionableError";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncidentStore,
  type OpenEmulatorLossIncidentInput,
  type EmulatorLossRecoverySettlement,
  type EmulatorRecoveryOutcome,
} from "../../src/daemon/emulatorLossIncident";
import {
  SessionManager,
  TerminalSessionError,
  type Session,
} from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
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
const RECOVERY_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS",
  "AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS",
  "AUTOMOBILE_ANDROID_REBOOT_ON_DEATH",
  "AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH",
] as const;

async function withRecoveryEnvUnset<T>(action: () => Promise<T>): Promise<T> {
  const originalValues = new Map(RECOVERY_ENV_KEYS.map((key) => [key, process.env[key]] as const));
  for (const key of RECOVERY_ENV_KEYS) {
    delete process.env[key];
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

class LaggingShutdownManager extends FakeDeviceManager {
  readonly killAccepted = Promise.withResolvers<void>();

  constructor(private readonly replacementDeviceId = "emulator-5560") {
    super();
  }

  override async killDevice(): Promise<void> {
    this.killAccepted.resolve();
  }
  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    this.startedDevices.push(device);
    this.bootedDevices = [{ ...original, deviceId: this.replacementDeviceId }];
    return { pid: 0 } as ChildProcess;
  }
  override async waitForDeviceReady(): Promise<BootedDevice> {
    return this.bootedDevices[0];
  }
}
class KillTrackingShutdownManager extends LaggingShutdownManager {
  readonly kills: string[] = [];

  override async killDevice(device: BootedDevice): Promise<void> {
    this.kills.push(device.deviceId);
    await super.killDevice();
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

/**
 * A `LaggingShutdownManager` whose kill signal can be re-armed for a second
 * recovery cycle on the same manager instance -- the base class's
 * `killAccepted` only ever resolves once. Used to verify a cancelled Android
 * recovery does not spend the crash-loop budget: a second, genuine recovery
 * on the same AVD name must still be able to relaunch it (#7545).
 */
class RearmableShutdownManager extends LaggingShutdownManager {
  private pendingKillResolvers: Array<() => void> = [];

  override async killDevice(): Promise<void> {
    await super.killDevice();
    const resolve = this.pendingKillResolvers.shift();
    resolve?.();
  }

  nextKillAccepted(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pendingKillResolvers.push(resolve);
    });
  }
}

class PerAvdBlockingReadyManager extends LaggingShutdownManager {
  readonly kills: string[] = [];
  private readonly readinessStarted = new Map<string, PromiseWithResolvers<void>>();
  private readonly readinessReleases = new Map<string, PromiseWithResolvers<void>>();

  private gate(map: Map<string, PromiseWithResolvers<void>>, avdName: string) {
    let gate = map.get(avdName);
    if (!gate) {
      gate = Promise.withResolvers<void>();
      map.set(avdName, gate);
    }
    return gate;
  }
  override async killDevice(device: BootedDevice): Promise<void> {
    this.kills.push(device.deviceId);
  }
  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    this.startedDevices.push(device);
    return { pid: 0 } as ChildProcess;
  }
  override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
    this.gate(this.readinessStarted, device.name).resolve();
    await this.gate(this.readinessReleases, device.name).promise;
    const ready: BootedDevice = {
      name: device.name,
      platform: "android",
      deviceId: `${device.name}-replacement`,
    };
    this.bootedDevices = [...this.bootedDevices, ready];
    return ready;
  }
  readinessStartedFor(avdName: string): Promise<void> {
    return this.gate(this.readinessStarted, avdName).promise;
  }
  releaseReadinessFor(avdName: string): void {
    this.gate(this.readinessReleases, avdName).resolve();
  }
}
class FailingGetIncidentStore extends InMemoryEmulatorLossIncidentStore {
  failGets = false;
  override async get(incidentId: string) {
    if (this.failGets) {
      throw new Error("incident repository unavailable");
    }
    return await super.get(incidentId);
  }
}

async function setup(
  manager: LaggingShutdownManager = new LaggingShutdownManager(),
  cancelDeviceSessionExecutions?: (sessionId: string, reason: string) => Promise<number>,
  emulatorLossIncidentStore?: EmulatorLossIncidentStore,
  apps = new FakeInstalledAppsRepository(),
) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer: timer,
      installedAppsRepository: apps,
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: true, maxAttempts: 1 },
      emulatorLossIncidentStore: emulatorLossIncidentStore,
      cancelDeviceSessionExecutions: cancelDeviceSessionExecutions,
    }),
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
  return { timer, sessions, manager, pool, captured, persistence };
}

async function setupPassiveRestart(release = true) {
  const timer = new FakeTimer();
  const incidents = new InMemoryEmulatorLossIncidentStore(timer);
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer: timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      deviceSessionContinuityEnabled: true,
      emulatorLossIncidentStore: incidents,
    }),
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
  manager.bootedDevices = [];
  if (release) {
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).resolves.toBe("released");
  }
  return { timer, persistence, sessions, manager, pool, captured, incidents };
}

async function setupAwaitingOwner(manager: LaggingShutdownManager) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  await persistence.upsertActiveSession({
    sessionUuid: "session",
    deviceId: original.deviceId,
    stableDeviceId: original.name,
    platform: "android",
    createdAtMs: 0,
    lastUsedAtMs: 0,
    expiresAtMs: 60_000,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    hasReceivedHeartbeat: true,
  });
  await persistence.markReleased("session", "expired", 0, "daemon-restart");
  const sessions = new SessionManager(timer, persistence);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "restarted-daemon", {
      timer: timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: true, maxAttempts: 1 },
    }),
  );
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  await sessions.rehydratePersistedSessions(pool);
  const captured = pool.getDevice(original.deviceId)!;
  return { timer, sessions, manager, pool, captured, persistence };
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

interface DevicePoolProcessExitInternals {
  trackStartedDeviceProcess(device: BootedDevice, child: ChildProcess): Promise<void>;
  emulatorLossRecoverySettlements: Map<string, Promise<void>>;
}

interface DevicePoolRecoveryInternals {
  adbServerResetQuarantinedSessions: Set<string>;
  adbServerResetRecoveryReservations: Map<
    string,
    { sessionId?: string; recoveryGeneration?: number; resolve(): void }
  >;
  recoveringAndroidImages: Map<string, DeviceInfo>;
  recoveryCoordinator: { recoveringAndroidImageSettlements: Map<string, unknown> };
  recoveringAndroidDeviceIds: Set<string>;
  recoveringSessionLosses: Map<string, { generation: number }>;
  failedTerminalRecoveryReleases: Set<string>;
  sessionPreservingRecoveries: Map<string, unknown>;
  androidRecoveryHandoffOwners: Map<string, unknown>;
  startAndroidRecoveryRecord(
    sessionId: string,
    details: { deviceId: string; avdName?: string },
    reservations: readonly string[],
    replace?: boolean,
  ): { generation: number };
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
  ): Promise<void>;
}

function assertNoRecoveryReservationsRemain(pool: DevicePool, sessionId: string): void {
  const internals = pool as unknown as DevicePoolRecoveryInternals;
  expect(pool.isSessionRecoveryInFlight(sessionId)).toBe(false);
  expect(internals.sessionPreservingRecoveries.has(sessionId)).toBe(false);
  expect(internals.recoveringSessionLosses.has(sessionId)).toBe(false);
  expect(internals.adbServerResetQuarantinedSessions.has(sessionId)).toBe(false);
  expect(internals.failedTerminalRecoveryReleases.has(sessionId)).toBe(false);
  expect(internals.recoveringAndroidImages.has(original.name)).toBe(false);
  expect(internals.recoveryCoordinator.recoveringAndroidImageSettlements.has(original.name)).toBe(
    false,
  );
  expect(internals.adbServerResetRecoveryReservations.has(original.name)).toBe(false);
  expect(internals.recoveringAndroidDeviceIds.has(original.deviceId)).toBe(false);
  expect(internals.androidRecoveryHandoffOwners.has(original.deviceId)).toBe(false);
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

test("onLoss recovery still actively relaunches an owned emulator and preserves its session", async () => {
  const manager = new LaggingShutdownManager(original.deviceId);
  const { timer, sessions, pool, captured } = await setup(manager);
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
    expect(manager.startedDevices).toEqual([
      {
        name: original.name,
        platform: "android",
        isRunning: false,
        source: "local",
      },
    ]);
    const replacement = pool.getDevice(original.deviceId)!;
    expect(sessions.getSession("session")).toBe(originalSession);
    expect(sessions.getSession("session")).toMatchObject({
      sessionId: "session",
      assignedDevice: original.deviceId,
      stableDeviceId: original.name,
      ownership: "owned",
    });
    expect(replacement).toMatchObject({ sessionId: "session", status: "busy" });
    expect(`${replacement.id}#${replacement.incarnation}`).not.toBe(originalConnectionId);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("same-serial recovery drops stale automation readiness until setup runs again", async () => {
  const manager = new LaggingShutdownManager(original.deviceId);
  const { timer, sessions, pool, captured } = await setup(manager);
  try {
    expect(sessions.getDeviceReadiness("session")).toBeUndefined();
    sessions.setDeviceReadiness("session", "automationReady");
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    manager.bootedDevices = [];
    timer.advanceTime(1_000);

    await expect(recovery).resolves.toBe("recovered");
    expect(pool.getDevice(original.deviceId)).toMatchObject({ sessionId: "session" });
    expect(sessions.getDeviceReadiness("session")).toBe("booted");
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("same-serial emulator continuity is enabled when the recovery environment is unset", async () => {
  await withRecoveryEnvUnset(async () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new KillTrackingShutdownManager(original.deviceId);
    const releaseCancellation = Promise.withResolvers<void>();
    let cancellationCalls = 0;
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
        cancelDeviceSessionExecutions: async () => {
          cancellationCalls++;
          await releaseCancellation.promise;
          return 0;
        },
      }),
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
    try {
      expect(pool.getRecoveryPolicy().onLoss).toBe(false);
      const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
        original.deviceId,
        undefined,
        captured,
      );
      await flush();
      expect(cancellationCalls).toBe(1);

      await pool.releaseDevice(original.deviceId, "session");
      await pool.removeDevice(original.deviceId, true, captured);
      await pool.addDevice(original, image);
      const replacement = pool.getDevice(original.deviceId);
      releaseCancellation.resolve();

      await expect(recovery).resolves.toBe("recovered");
      expect(pool.getDevice(original.deviceId)).toBe(replacement);
      expect(sessions.getSession("session")).toMatchObject({
        sessionId: "session",
        assignedDevice: original.deviceId,
      });
      expect(manager.kills).toEqual([]);
      expect(manager.startedDevices).toEqual([]);
    } finally {
      releaseCancellation.resolve();
      sessions.stopCleanupTimer();
    }
  });
});

test("continuity releases an externally closed emulator without relaunch and rehydrates it on return", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager("emulator-5599");
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer: timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      deviceSessionContinuityEnabled: true,
    }),
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
  const originalConnectionId = `${captured.id}#${captured.incarnation}`;
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "device-discovery-miss",
  );
  if (!incidentId) {
    throw new Error("Expected emulator-loss incident to be recorded");
  }
  manager.bootedDevices = [];

  try {
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, incidentId, captured),
    ).resolves.toBe("released");
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "released",
      release_reason: `device-restart:${original.name}`,
    });
    expect(await pool.waitForEmulatorLossIncident(incidentId, 0)).toMatchObject({
      avdName: original.name,
      session: { state: "awaiting-device" },
      recovery: { attempts: [], outcome: "not-attempted" },
    });
    expect(sessions.getSession("session")).toBeNull();
    assertNoRecoveryReservationsRemain(pool, "session");

    const returned = { ...original, deviceId: "emulator-5599" };
    manager.bootedDevices = [returned];
    await pool.addDevice(returned, image);
    await expect(sessions.rehydratePersistedSessions(pool)).resolves.toEqual({
      rehydrated: ["session"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });

    const replacement = pool.getDevice(returned.deviceId)!;
    expect(sessions.getSession("session")).toMatchObject({
      sessionId: "session",
      assignedDevice: returned.deviceId,
      stableDeviceId: original.name,
    });
    expect(replacement).toMatchObject({ sessionId: "session", status: "busy" });
    expect(`${replacement.id}#${replacement.incarnation}`).not.toBe(originalConnectionId);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a pool-allocated emulator without a recorded image still persists as device-restart and rehydrates (#7546)", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer: timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      deviceSessionContinuityEnabled: true,
    }),
  );
  manager.bootedDevices = [original];
  // Discovery-only refresh -- no sourceImage, so unlike `addDevice(device, image)`
  // the pooled entry gets neither `avdName` nor `androidImage` (#7546's gap).
  await pool.refreshDevices();
  const pooled = pool.getDevice(original.deviceId);
  expect(pooled?.avdName).toBeUndefined();
  expect(pooled?.androidImage).toBeUndefined();

  // Idle allocation (assignDeviceToSession), not startDevice/getAndroid image
  // enrichment -- the client-supplied/runner-minted sessionUuid path.
  await sessions.getOrCreateSession("session", pool, "android");
  expect(pool.getDevice(original.deviceId)).toMatchObject({ sessionId: "session" });

  try {
    manager.bootedDevices = [];
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(
        original.deviceId,
        undefined,
        pool.getDevice(original.deviceId),
      ),
    ).resolves.toBe("released");
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "released",
      release_reason: `device-restart:${original.name}`,
    });
    expect(sessions.getSession("session")).toBeNull();

    const returned = { ...original, deviceId: "emulator-5599" };
    manager.bootedDevices = [returned];
    await pool.refreshDevices();
    await expect(sessions.rehydratePersistedSessions(pool)).resolves.toEqual({
      rehydrated: ["session"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
    expect(pool.getDevice(returned.deviceId)).toMatchObject({
      sessionId: "session",
      status: "busy",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("onLoss recovery does not actively relaunch a pool-allocated emulator without a recorded image (#7546)", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer: timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: true, maxAttempts: 1 },
      deviceSessionContinuityEnabled: true,
    }),
  );
  manager.bootedDevices = [original];
  await pool.refreshDevices();
  await sessions.getOrCreateSession("session", pool, "android");

  try {
    manager.bootedDevices = [];
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(
        original.deviceId,
        undefined,
        pool.getDevice(original.deviceId),
      ),
    ).resolves.toBe("released");
    // Active relaunch stays gated on a recorded configured image even though
    // onLoss is enabled: passive continuity's looser identity check must not
    // widen what `isAndroidEmulatorActiveRelaunchEligible` permits.
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "released",
      release_reason: `device-restart:${original.name}`,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("continuity-disabled emulator loss keeps a terminal released settlement", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer: timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      deviceSessionContinuityEnabled: false,
    }),
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
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "device-discovery-miss",
  );
  if (!incidentId) {
    throw new Error("Expected emulator-loss incident to be recorded");
  }
  try {
    const eviction = pool as unknown as {
      evictMissingPooledDevice(
        device: PooledDevice,
        reason: string,
        options: { attemptDeviceLossRecovery: boolean; incidentId: string },
      ): Promise<void>;
    };
    await eviction.evictMissingPooledDevice(captured, "not present in adb devices", {
      attemptDeviceLossRecovery: true,
      incidentId,
    });

    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "released",
      release_reason: `device-disconnected:${original.deviceId};incident=${incidentId}`,
    });
    expect(await pool.waitForEmulatorLossIncident(incidentId, 0)).toMatchObject({
      session: { state: "released" },
      recovery: { attempts: [], outcome: "not-attempted" },
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("restart recovery remains pending after 60 seconds and recovers at 120 seconds", async () => {
  const { timer, sessions, manager, pool } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  let settled = false;
  const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true);
  void resume.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flush();
  for (let second = 1; second <= 120; second++) {
    timer.advanceTime(1_000);
    await flush();
    expect(settled).toBe(false);
  }
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  timer.advanceTime(1_000);
  await expect(resume).resolves.toMatchObject({
    sessionId: "session",
    assignedDevice: original.deviceId,
  });
});

test.each(["not-attempted", "exhausted"] as const)(
  "restart assignment reports a %s loss incident on the next retry tick",
  async (outcome) => {
    const { timer, sessions, pool, incidents, persistence } = await setupPassiveRestart();
    sessions.stopCleanupTimer();
    const incident = await incidents.open({
      deviceId: original.deviceId,
      avdName: original.name,
      detectionPath: "watched-process-exit",
      processExit: { code: null, signal: "SIGKILL" },
      session: {
        sessionUuid: "session",
        state: "recovering",
        lastHeartbeatMs: 0,
        hasReceivedHeartbeat: false,
        heartbeatTimeoutMs: 60_000,
      },
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });
    let failure: unknown;
    const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true).then(
      () => {},
      (error: unknown) => {
        failure = error;
      },
    );
    await flush();
    expect(timer.getPendingTimeouts()).toEqual([1_000]);
    await incidents.completeRecovery(incident.id, outcome, { sessionState: "awaiting-device" });
    timer.advanceTime(1_000);
    await drainUntilQuiescent(timer);
    // Drain the unfixed wait too, so the red test never leaves work behind.
    const failureAtNextTick = failure;
    const rowAtNextTick = await persistence.getSession?.("session");
    timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    await resume;
    expect(failureAtNextTick).toBeInstanceOf(ActionableError);
    expect(rowAtNextTick).toMatchObject({ release_reason: `device-restart:${original.name}` });
    expect(String(failureAtNextTick)).toContain("Cannot safely recover session");
    expect(String(failureAtNextTick)).toContain(incident.id);
    expect(String(failureAtNextTick)).toContain("watched-process-exit");
    expect(String(failureAtNextTick)).toContain("SIGKILL");
    expect(String(failureAtNextTick)).toContain("getAndroid or getApple");
    expect(String(failureAtNextTick)).toContain("179 seconds remaining");
  },
);

test("restart assignment keeps waiting while the loss incident has no recovery outcome", async () => {
  const { timer, sessions, pool, manager, incidents } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  await incidents.open({
    deviceId: original.deviceId,
    avdName: original.name,
    detectionPath: "watched-process-exit",
    recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    session: {
      sessionUuid: "session",
      state: "recovering",
      lastHeartbeatMs: 0,
      hasReceivedHeartbeat: false,
      heartbeatTimeoutMs: 60_000,
    },
  });
  let settled = false;
  const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true);
  void resume.then(() => {
    settled = true;
  });
  await flush();
  timer.advanceTime(1_000);
  await flush();
  expect(settled).toBe(false);
  expect(timer.getPendingTimeouts()).toEqual([1_000]);
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  timer.advanceTime(1_000);
  await expect(resume).resolves.toMatchObject({ assignedDevice: original.deviceId });
});

test.each([
  [3_500, 60_000],
  [undefined, 3_500],
  [3_500, undefined],
  [60_000, 3_500],
] as const)(
  "joined restart acquisition keeps caller deadlines separate (%s, %s)",
  async (firstDeadline, secondDeadline) => {
    const { timer, sessions, pool, manager } = await setupPassiveRestart();
    sessions.stopCleanupTimer();
    try {
      const acquire = (requestDeadlineMs: number | undefined) =>
        sessions.getOrCreateSession("session", pool, "android", undefined, true, {
          requestDeadlineMs,
        });
      let firstResult: unknown;
      let secondResult: unknown;
      let firstSettled = false;
      let secondSettled = false;
      const first = acquire(firstDeadline).then(
        (session) => {
          firstResult = session;
          firstSettled = true;
        },
        (error: unknown) => {
          firstResult = error;
          firstSettled = true;
        },
      );
      await drainUntilQuiescent(timer);
      const second = acquire(secondDeadline).then(
        (session) => {
          secondResult = session;
          secondSettled = true;
        },
        (error: unknown) => {
          secondResult = error;
          secondSettled = true;
        },
      );
      await drainUntilQuiescent(timer);
      for (const step of [1_000, 1_000, 499]) {
        timer.advanceTime(step);
        await drainUntilQuiescent(timer);
      }
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      timer.advanceTime(1);
      await drainUntilQuiescent(timer);
      expect(firstSettled).toBe(firstDeadline === 3_500);
      expect(secondSettled).toBe(secondDeadline === 3_500);
      expect(String(firstDeadline === 3_500 ? firstResult : secondResult)).toContain(
        "Cannot safely recover session",
      );
      manager.bootedDevices = [original];
      timer.advanceTime(500);
      await drainUntilQuiescent(timer);
      timer.advanceTime(1_000);
      await Promise.all([first, second]);
      expect(firstDeadline === 3_500 ? secondResult : firstResult).toMatchObject({
        assignedDevice: original.deviceId,
      });
      expect(pool.getDevice(original.deviceId)?.sessionId).toBe("session");
      expect(timer.getPendingTimeouts()).toEqual([]);
    } finally {
      sessions.stopCleanupTimer();
    }
  },
);

test("last joined restart waiter aborts slow discovery and fences its late device claim", async () => {
  const { timer, sessions, pool, manager } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  const discovery =
    Promise.withResolvers<Awaited<ReturnType<typeof manager.getBootedDevicesDetailed>>>();
  const originalDiscovery = manager.getBootedDevicesDetailed.bind(manager);
  manager.getBootedDevicesDetailed = () => discovery.promise;
  const acquire = (requestDeadlineMs: number) =>
    sessions
      .getOrCreateSession("session", pool, "android", undefined, true, { requestDeadlineMs })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  const first = acquire(3_500);
  await drainUntilQuiescent(timer);
  let secondSettled = false;
  const second = acquire(4_500).then((result) => {
    secondSettled = true;
    return result;
  });
  await drainUntilQuiescent(timer);
  timer.advanceTime(2_500);
  await drainUntilQuiescent(timer);
  expect(String(await first)).toContain("Cannot safely recover session");
  expect(secondSettled).toBe(false);
  manager.bootedDevices = [original];
  const lateDiscovery = await originalDiscovery();
  timer.advanceTime(1_000);
  // Resolve in the same turn as the final deadline, before rejection cleanup runs.
  discovery.resolve(lateDiscovery);
  expect(String(await second)).toContain("Cannot safely recover session");
  await drainUntilQuiescent(timer);
  timer.advanceTime(1_000);
  await drainUntilQuiescent(timer);
  expect(sessions.getSession("session")).toBeNull();
  expect(pool.getDevice(original.deviceId)?.sessionId ?? null).toBeNull();
  expect(timer.getPendingTimeouts()).toEqual([]);
});

test("single restart acquisition retains its deadline and fences late availability", async () => {
  const { timer, sessions, pool, manager } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  const acquisition = sessions
    .getOrCreateSession("session", pool, "android", undefined, true, {
      requestDeadlineMs: 3_500,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await drainUntilQuiescent(timer);
  timer.advanceTime(2_500);
  expect(String(await acquisition)).toContain("Cannot safely recover session");
  manager.bootedDevices = [original];
  timer.advanceTime(1_000);
  await drainUntilQuiescent(timer);
  expect(sessions.getSession("session")).toBeNull();
  expect(pool.getDevice(original.deviceId)?.sessionId ?? null).toBeNull();
  expect(timer.getPendingTimeouts()).toEqual([]);
});

test("restart assignment reserves a response margin before a nearer request deadline", async () => {
  const { timer, sessions, pool } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  const target = {
    platform: original.platform,
    stableDeviceId: original.name,
    deviceId: original.deviceId,
    androidEmulator: true,
    restartRecoveryDeadlineMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
    requestDeadlineMs: 3_500,
  };
  const assignment = pool.assignDeviceToSession("session", "android", target).then(
    () => undefined,
    (error: unknown) => error,
  );
  await drainUntilQuiescent(timer);
  timer.advanceTime(1_000);
  await drainUntilQuiescent(timer);
  timer.advanceTime(1_000);
  await drainUntilQuiescent(timer);
  timer.advanceTime(500);
  const error = await assignment;
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("Cannot safely recover session");
  expect(timer.now()).toBe(2_500);
  expect(timer.getPendingTimeouts()).toEqual([]);
});

test("restart assignment waits until a recorded outcome's cleanup is settled", async () => {
  const { timer, sessions, pool, captured, incidents } = await setupPassiveRestart(false);
  sessions.stopCleanupTimer();
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "watched-process-exit",
    {
      code: null,
      signal: "SIGKILL",
    },
  );
  if (!incidentId) {
    throw new Error("Expected a recorded incident");
  }
  await pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured);
  await incidents.completeRecovery(incidentId, "exhausted", { sessionState: "awaiting-device" });
  let settled = false;
  const assignment = sessions.getOrCreateSession("session", pool, "android", undefined, true).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await drainUntilQuiescent(timer);
  timer.advanceTime(1_000);
  await drainUntilQuiescent(timer);
  expect(settled).toBe(false);
  await pool.finishEmulatorLossIncident(incidentId, "exhausted");
  timer.advanceTime(1_000);
  expect(String(await assignment)).toContain("watched-process-exit");
});

test("restart assignment bounds slow discovery and fences its late device claim", async () => {
  const { timer, sessions, pool, manager } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  const discovery =
    Promise.withResolvers<Awaited<ReturnType<typeof manager.getBootedDevicesDetailed>>>();
  const originalDiscovery = manager.getBootedDevicesDetailed.bind(manager);
  manager.getBootedDevicesDetailed = () => discovery.promise;
  const target = {
    platform: original.platform,
    stableDeviceId: original.name,
    deviceId: original.deviceId,
    restartRecoveryDeadlineMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
    requestDeadlineMs: 2_500,
  };
  const assignment = pool.assignDeviceToSession("session", "android", target).then(
    () => undefined,
    (error: unknown) => error,
  );
  await drainUntilQuiescent(timer);
  timer.advanceTime(1_500);
  expect(String(await assignment)).toContain("Cannot safely recover session");
  expect(timer.now()).toBe(1_500);
  manager.bootedDevices = [original];
  discovery.resolve(await originalDiscovery("android"));
  await drainUntilQuiescent(timer);
  expect(sessions.getSession("session")).toBeNull();
  expect(pool.getDevice(original.deviceId)?.sessionId ?? null).toBeNull();
  expect(timer.getPendingTimeouts()).toEqual([]);
});

test("binding during a gated idle process exit rejects and evicts the dead emulator", async () => {
  const timer = new FakeTimer();
  class GatedIncidentStore extends InMemoryEmulatorLossIncidentStore {
    readonly writeStarted = Promise.withResolvers<void>();
    readonly releaseWrite = Promise.withResolvers<void>();
    private firstWrite = true;

    override async open(input: OpenEmulatorLossIncidentInput) {
      if (this.firstWrite) {
        this.firstWrite = false;
        this.writeStarted.resolve();
        await this.releaseWrite.promise;
      }
      return await super.open(input);
    }
  }
  const incidents = new GatedIncidentStore(timer);
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const manager = new FakeDeviceManager();
  manager.bootedDevices = [original];
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      emulatorLossIncidentStore: incidents,
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
    }),
  );
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    stdout: null,
    stderr: null,
  }) as ChildProcess;
  await pool.addDevice(original, image);
  await pool.bindOrReuseDeviceSession(
    "owner",
    original.deviceId,
    "android",
    image,
    child,
    original,
  );
  await sessions.releaseSession("owner");
  await pool.releaseDevice(original.deviceId, "owner");
  expect(pool.getDevice(original.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await incidents.writeStarted.promise;
  let failure: unknown;
  try {
    const binding = pool.bindOrReuseDeviceSession(
      "new-session",
      original.deviceId,
      "android",
      image,
      child,
      original,
    );
    await drainUntil(() => timer.getPendingTimeouts().includes(1_000), {
      description: "bind armed the shared incident deadline",
    });
    // Keep main's ordering: bind fails before the recorder's write is released.
    timer.advanceTime(1_000);
    try {
      await binding;
    } catch (error) {
      failure = error;
    }
    expect(pool.getDevice(original.deviceId)).toBeNull();
  } finally {
    incidents.releaseWrite.resolve();
    await drainUntilQuiescent(timer);
  }
  expect(await incidents.list()).toHaveLength(1);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("exited before process tracking completed");
  expect(pool.getDevice(original.deviceId)).toBeNull();
  expect(sessions.getSession("new-session")).toBeNull();
});

function exitedChild(): ChildProcess & { exitCode: number | null } {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    stdout: null,
    stderr: null,
  }) as ChildProcess & { exitCode: number | null };
}

async function setupProcessExitPool(
  onLoss: boolean,
  continuity: boolean,
  incidents?: EmulatorLossIncidentStore,
  manager = new FakeDeviceManager(),
) {
  const timer = new FakeTimer();
  const store = incidents ?? new InMemoryEmulatorLossIncidentStore(timer);
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      emulatorLossIncidentStore: store,
      recoveryPolicy: { onLoss, maxAttempts: 1 },
      deviceSessionContinuityEnabled: continuity,
      retryExecutor: new DefaultRetryExecutor(timer),
    }),
  );
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  const child = exitedChild();
  const internals = pool as unknown as DevicePoolProcessExitInternals;
  await internals.trackStartedDeviceProcess(original, child);
  await pool.bindOrReuseDeviceSession(
    "session",
    original.deviceId,
    "android",
    image,
    child,
    original,
  );
  return { timer, store, sessions, pool, manager, child, internals };
}

test.each([
  { onLoss: true, continuity: true, listed: true, outcome: "recovered", state: "active" },
  {
    onLoss: false,
    continuity: true,
    listed: false,
    outcome: "not-attempted",
    state: "awaiting-device",
  },
  { onLoss: false, continuity: false, listed: false, outcome: "not-attempted", state: "released" },
] as const)("both process tracks preserve main's settlement fields: %j", async (config) => {
  const { timer, store, sessions, manager, child, internals } = await setupProcessExitPool(
    config.onLoss,
    config.continuity,
  );
  expect(child.listenerCount("exit")).toBe(2);
  if (!config.listed) {
    manager.bootedDevices = [];
  }
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await drainUntilQuiescent(timer);
  const rows = await store.list();
  expect(rows).toHaveLength(1);
  expect(internals.emulatorLossRecoverySettlements.size).toBe(0);
  for (const row of rows) {
    expect(row).toMatchObject({
      deviceId: original.deviceId,
      avdName: original.name,
      detectionPath: "watched-process-exit",
      processExit: { code: 1, signal: null },
      session: { sessionUuid: "session", state: config.state },
      recovery: {
        outcome: config.outcome,
        policy: { onLoss: config.onLoss, maxAttempts: 1 },
        attempts: [],
      },
    });
    expect(row.replacementDeviceId).toBeUndefined();
  }
  expect(sessions.getSession("session")?.assignedDevice ?? null).toBe(
    config.listed ? original.deviceId : null,
  );
});

test("a late dead-child track records a fresh loss and keeps its settlement guard armed", async () => {
  class GatedExhaustedStore extends InMemoryEmulatorLossIncidentStore {
    readonly completed = Promise.withResolvers<string>();
    readonly release = Promise.withResolvers<void>();
    override async completeRecovery(
      id: string,
      outcome: EmulatorRecoveryOutcome,
      settlement?: EmulatorLossRecoverySettlement,
    ) {
      await super.completeRecovery(id, outcome, settlement);
      if (outcome === "exhausted") {
        this.completed.resolve(id);
        await this.release.promise;
      }
    }
  }
  class FailingRelaunchManager extends FakeDeviceManager {
    override async startDevice(): Promise<ChildProcess> {
      throw new Error("relaunch failed");
    }
  }
  const store = new GatedExhaustedStore(new FakeTimer());
  const { timer, manager, child, internals } = await setupProcessExitPool(
    true,
    true,
    store,
    new FailingRelaunchManager(),
  );
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await drainUntilQuiescent(timer);
  const [first] = await store.list();
  expect(first).toMatchObject({ recovery: { outcome: "recovered" }, session: { state: "active" } });
  expect(internals.emulatorLossRecoverySettlements.size).toBe(0);
  manager.bootedDevices = [];
  const late = internals
    .trackStartedDeviceProcess(original, child)
    .catch((error: unknown) => error);
  try {
    const secondId = await store.completed.promise;
    // An exhausted outcome is visible before cleanup finishes. The early-error
    // guard must still see this new row as pending throughout that interval.
    expect(internals.emulatorLossRecoverySettlements.has(secondId)).toBe(true);
    expect(secondId).not.toBe(first.id);
    expect(await store.get(first.id)).toEqual(first);
  } finally {
    store.release.resolve();
    await late;
    await drainUntilQuiescent(timer);
  }
  const rows = await store.list();
  expect(rows).toHaveLength(2);
  expect(await store.get(first.id)).toEqual(first);
  expect(rows[0]).toMatchObject({
    recovery: { outcome: "exhausted" },
    session: { sessionUuid: "session", state: "awaiting-device" },
  });
  expect(internals.emulatorLossRecoverySettlements.size).toBe(0);
});

async function setupSettledRestart(outcome: "not-attempted" | "exhausted" = "not-attempted") {
  const context = await setupPassiveRestart();
  context.sessions.stopCleanupTimer();
  const incident = await context.incidents.open({
    deviceId: original.deviceId,
    avdName: original.name,
    detectionPath: "watched-process-exit",
    processExit: { code: 1, signal: null },
    session: {
      sessionUuid: "session",
      state: "recovering",
      lastHeartbeatMs: 0,
      hasReceivedHeartbeat: false,
      heartbeatTimeoutMs: 60_000,
    },
    recoveryPolicy: { onLoss: false, maxAttempts: 1 },
  });
  await context.incidents.completeRecovery(incident.id, outcome);
  return { ...context, incident };
}

test.each(["not-attempted", "exhausted"] as const)(
  "settled %s loss stays non-terminal and resumes if the device returns inside the window",
  async (outcome) => {
    const { timer, persistence, sessions, pool, manager, incident } =
      await setupSettledRestart(outcome);
    const persisted = { ...(await persistence.getSession?.("session")) };
    timer.advanceTime(60_000);
    timer.clearHistory();
    const error = await sessions
      .getOrCreateSession("session", pool, "android", undefined, true)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toBe(
      "Error: Cannot safely recover session session: android device 'Pixel_8_API_35' is unavailable or already in use. " +
        "Acquire a new device with getAndroid or getApple. " +
        `Loss incident ${incident.id}: watched-process-exit (code=1, signal=null); recovery outcome: ${outcome}. ` +
        "The session can still resume if the device returns before the recovery window ends " +
        "(120 seconds remaining); otherwise acquire a new device with getAndroid or getApple.",
    );
    expect(timer.getSleepHistory()).toEqual([]);
    expect(await persistence.getSession?.("session")).toEqual(persisted);
    expect(sessions.getTerminalReleaseSnapshot("session")).toBeUndefined();
    timer.advanceTime(60_000);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await expect(
      sessions.getOrCreateSession("session", pool, "android", undefined, true),
    ).resolves.toMatchObject({ sessionId: "session", assignedDevice: original.deviceId });
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "active",
      device_id: original.deviceId,
    });
  },
);

test.each([180_000, 240_000])(
  "settled restart loss terminalizes the same session at %s ms",
  async (elapsed) => {
    const { timer, persistence, sessions, pool, manager } = await setupSettledRestart();
    await expect(
      sessions.getOrCreateSession("session", pool, "android", undefined, true),
    ).rejects.toThrow("recovery outcome: not-attempted");
    expect(await persistence.getSession?.("session")).toMatchObject({
      release_reason: `device-restart:${original.name}`,
    });
    timer.advanceTime(elapsed);
    await expect(
      sessions.getOrCreateSession("session", pool, "android", undefined, true),
    ).rejects.toThrow("recovery reason: target-absent");
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "released",
      release_reason: "identity-recovery-target-absent",
      released_at_ms: elapsed,
    });
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await expect(
      sessions.getOrCreateSession("session", pool, "android", undefined, true),
    ).rejects.toThrow(TerminalSessionError);
  },
);

test("device-restart resume waits for the same serial and preserves its session UUID", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true);
    await flush();
    expect(timer.getPendingTimeouts()).toEqual([1_000]);
    expect(await persistence.getSession?.("session")).toMatchObject({
      release_reason: `device-restart:${original.name}`,
    });

    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    timer.advanceTime(1_000);
    await expect(resume).resolves.toMatchObject({
      sessionId: "session",
      assignedDevice: original.deviceId,
    });
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "active",
      device_id: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume waits through an unknown new serial and binds by AVD name", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    const unknown = { ...original, deviceId: "emulator-5556", name: "Unknown (emulator-5556)" };
    manager.bootedDevices = [unknown];
    await pool.refreshDevices();
    const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true);
    await drainUntilQuiescent(timer);
    expect(timer.getPendingTimeouts()).toEqual([1_000]);
    expect(await persistence.getSession?.("session")).toMatchObject({
      release_reason: `device-restart:${original.name}`,
    });

    const returned = { ...original, deviceId: unknown.deviceId };
    manager.bootedDevices = [returned];
    await pool.refreshDevices();
    timer.advanceTime(1_000);
    await expect(resume).resolves.toMatchObject({
      sessionId: "session",
      assignedDevice: returned.deviceId,
      stableDeviceId: original.name,
    });
    expect(pool.getDevice(returned.deviceId)).toMatchObject({
      sessionId: "session",
      status: "busy",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume after 45 seconds reuses the same serial and session UUID", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    timer.advanceTime(45_000);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);

    await expect(
      sessions.getOrCreateSession("session", pool, "android", undefined, true),
    ).resolves.toMatchObject({ sessionId: "session", assignedDevice: original.deviceId });
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "active",
      device_id: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume after 45 seconds binds a new serial by AVD name and preserves the UUID", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    timer.advanceTime(45_000);
    const unknown = { ...original, deviceId: "emulator-5556", name: "Unknown (emulator-5556)" };
    manager.bootedDevices = [unknown];
    await pool.refreshDevices();
    const returned = { ...original, deviceId: unknown.deviceId };
    manager.bootedDevices = [returned];
    await pool.refreshDevices();

    await expect(
      sessions.getOrCreateSession("session", pool, "android", undefined, true),
    ).resolves.toMatchObject({
      sessionId: "session",
      assignedDevice: returned.deviceId,
      stableDeviceId: original.name,
    });
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "active",
      device_id: returned.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume accepts a present device after the full recovery deadline", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS + 1);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);

    await expect(
      sessions.getOrCreateSession("session", pool, "android", undefined, true),
    ).resolves.toMatchObject({ sessionId: "session", assignedDevice: original.deviceId });
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "active",
      device_id: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume terminalizes absence at the persisted restart deadline", async () => {
  const { timer, persistence, sessions, pool } = await setupPassiveRestart();
  try {
    const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true);
    await flush();
    expect(timer.getPendingTimeouts()).toEqual([1_000]);
    timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    await expect(resume).rejects.toThrow("recovery reason: target-absent");
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "released",
      release_reason: "identity-recovery-target-absent",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume stops at the earlier session expiry", async () => {
  const { timer, persistence, sessions, pool } = await setupPassiveRestart();
  try {
    const persisted = await persistence.getSession?.("session");
    if (!persisted) {
      throw new Error("Expected a persisted restart release");
    }
    persisted.expires_at_ms = 5_000;
    const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true);
    await flush();
    expect(timer.getPendingTimeouts()).toEqual([1_000]);
    timer.advanceTime(5_000);
    await expect(resume).rejects.toThrow("recovery reason: target-absent");
    expect(await persistence.getSession?.("session")).toMatchObject({
      release_reason: "identity-recovery-target-absent",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a resolved old-serial replacement fences recovery despite another unknown emulator", async () => {
  const { persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    manager.bootedDevices = [
      { ...original, name: "Different_AVD" },
      { ...original, deviceId: "emulator-5556", name: "Unknown (emulator-5556)" },
    ];
    await pool.refreshDevices();
    await expect(
      sessions.getOrCreateSession("session", pool, "android", undefined, true),
    ).rejects.toThrow("recovery reason: identity-continuity-lost");
    expect(await persistence.getSession?.("session")).toMatchObject({
      release_reason: "identity-recovery-identity-continuity-lost",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("active emulator loss adopts a same-AVD replacement at a new serial", async () => {
  const { sessions, manager, pool, captured } = await setup(new KillTrackingShutdownManager());
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
  const { sessions, manager, pool, captured } = await setup(new KillTrackingShutdownManager());
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
  const { sessions, manager, pool, captured } = await setup(new KillTrackingShutdownManager());
  try {
    const exitedProcess = {
      pid: 42,
      exitCode: 1,
      signalCode: null,
      kill: () => {
        throw new Error("An exited process must not be killed");
      },
    } as unknown as ChildProcess;
    (
      pool as unknown as { startedDeviceProcesses: Map<string, ChildProcess> }
    ).startedDeviceProcesses.set(original.deviceId, exitedProcess);
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
    expect(
      (pool as unknown as DevicePoolRecoveryInternals).recoveringAndroidImages.has(original.name),
    ).toBe(false);
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
  const internals = pool as unknown as DevicePoolRecoveryInternals;
  const originalReleaseSession = sessions.releaseSession.bind(sessions);
  sessions.releaseSession = async () => {
    throw new Error("ADB-reset release persistence failed");
  };
  try {
    await pool.detachAdbServerResetCohort([captured]);
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe(false);

    timer.advanceTime(30_000);
    const terminalRecovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await flush();
    timer.advanceTime(30_000);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(1_000);
    await expect(terminalRecovery).rejects.toThrow("ADB-reset release persistence failed");

    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(true);
    expect(internals.recoveringSessionLosses.has("session")).toBe(true);
    expect(internals.recoveringAndroidImages.has(original.name)).toBe(true);
  } finally {
    sessions.releaseSession = originalReleaseSession;
    sessions.stopCleanupTimer();
  }
});

test("ADB-reset recovery clears its failed-release fence after a later release", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const internals = pool as unknown as DevicePoolRecoveryInternals;
  const originalReleaseSession = sessions.releaseSession.bind(sessions);
  sessions.releaseSession = async () => {
    throw new Error("ADB-reset release persistence failed");
  };
  try {
    const cohort = await pool.detachAdbServerResetCohort([captured]);
    const firstRecovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    timer.advanceTime(30_000);
    expect(await firstRecovery).toBe(false);

    timer.advanceTime(30_000);
    const failedRecovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await flush();
    timer.advanceTime(30_000);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(1_000);
    await expect(failedRecovery).rejects.toThrow("ADB-reset release persistence failed");
    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(true);
    expect(internals.recoveringSessionLosses.has("session")).toBe(true);

    // The retained fence is not a due deferred retry: the sweep must wait for
    // a later durable release rather than re-running the failed recovery.
    sessions.releaseSession = originalReleaseSession;
    timer.advanceTime(30_000);
    await pool.retryDueDeferredSessionRecoveries();
    await flush();
    expect(internals.failedTerminalRecoveryReleases.has("session")).toBe(true);
    expect(internals.recoveringSessionLosses.has("session")).toBe(true);
    expect(manager.startedDevices).toHaveLength(0);

    await originalReleaseSession("session", "explicit-release");
    await flush();

    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(false);
    expect(internals.recoveringSessionLosses.has("session")).toBe(false);
    expect(internals.failedTerminalRecoveryReleases.has("session")).toBe(false);

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
    assertNoRecoveryReservationsRemain(pool, "session");
    expect(finalizations).toBe(1);

    const releaseLease = await pool.reserveAndroidStartupLease(original.name, true);
    await releaseLease();
  } finally {
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
    expect(internals.failedTerminalRecoveryReleases.has("session")).toBe(false);
    assertNoRecoveryReservationsRemain(pool, "session");
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a stale due-recovery snapshot does not finalize a record another sweep is recovering", async () => {
  const manager = new PerAvdBlockingReadyManager();
  const { timer, sessions, pool, captured } = await setup(manager);
  const internals = pool as unknown as DevicePoolRecoveryInternals;
  const second: BootedDevice = {
    name: "Pixel_8_API_35_2",
    platform: "android",
    deviceId: "emulator-5556",
  };
  const secondImage: DeviceInfo = { ...image, name: second.name };
  manager.bootedDevices = [original, second];
  await pool.addDevice(second, secondImage);
  await pool.bindOrReuseDeviceSession(
    "session-2",
    second.deviceId,
    "android",
    secondImage,
    undefined,
    second,
  );
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
    expect(internals.sessionPreservingRecoveries.has("session-2")).toBe(true);
    expect(internals.recoveringSessionLosses.has("session-2")).toBe(true);
    expect(internals.adbServerResetQuarantinedSessions.has("session-2")).toBe(true);
    expect(internals.recoveringAndroidImages.has(second.name)).toBe(true);
    expect(sessions.getSession("session")?.assignedDevice).toBe(`${original.name}-replacement`);

    manager.releaseReadinessFor(second.name);
    await sweepB;
    expect(manager.startedDevices).toHaveLength(2);
    expect(internals.sessionPreservingRecoveries.has("session-2")).toBe(false);
    expect(internals.recoveringSessionLosses.has("session-2")).toBe(false);
    expect(internals.adbServerResetQuarantinedSessions.has("session-2")).toBe(false);
    expect(internals.recoveringAndroidImages.has(second.name)).toBe(false);
    expect(internals.recoveryCoordinator.recoveringAndroidImageSettlements.has(second.name)).toBe(
      false,
    );
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("an old ADB-reset cohort sweep cannot clear a newer recovery record", async () => {
  const { sessions, pool, captured } = await setup();
  const internals = pool as unknown as DevicePoolRecoveryInternals;
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
    internals.adbServerResetRecoveryReservations.set(original.name, {
      sessionId: "session",
      recoveryGeneration: oldRecord.generation,
      resolve: () => {
        resolved = true;
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

    expect(internals.recoveringSessionLosses.get("session")?.generation).toBe(newRecord.generation);
    expect(internals.adbServerResetQuarantinedSessions.has("session")).toBe(true);
    expect(internals.adbServerResetRecoveryReservations.has(original.name)).toBe(true);
    expect(resolved).toBe(false);
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
    assertNoRecoveryReservationsRemain(pool, "session");
    await releaseLease?.();
  } finally {
    sessions.releaseSession = originalReleaseSession;
    sessions.stopCleanupTimer();
  }
});

test("a retained failure fence is not re-swept as a due deferred recovery", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  const internals = pool as unknown as DevicePoolRecoveryInternals;
  const originalReleaseSession = sessions.releaseSession.bind(sessions);
  sessions.releaseSession = async () => {
    throw new Error("release persistence failed");
  };
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
    const terminalRecovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await flush();
    timer.advanceTime(30_000);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(1_000);
    await expect(terminalRecovery).rejects.toThrow("release persistence failed");
    expect(internals.failedTerminalRecoveryReleases.has("session")).toBe(true);
    expect(manager.startedDevices).toHaveLength(0);

    // Shutdown is now confirmable, so a relaunch would actually start a device.
    manager.bootedDevices = [];
    for (let poll = 0; poll < 3; poll++) {
      timer.advanceTime(30_000);
      await pool.retryDueDeferredSessionRecoveries();
      await flush();
    }
    expect(manager.startedDevices).toHaveLength(0);
    expect(internals.failedTerminalRecoveryReleases.has("session")).toBe(true);
    expect(internals.recoveringSessionLosses.has("session")).toBe(true);
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
      recoveryCoordinator: { clearRecoveringAndroidImage(avdName: string): void };
    };
    internals.afterAndroidStartupRecoverySnapshot = () => {
      manager.releaseReadiness.resolve();
      internals.recoveryCoordinator.clearRecoveringAndroidImage(original.name);
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

interface FailedReleaseRecord {
  generation: number;
  failedReleaseAttempts?: number;
  deferredUntil?: number;
  reservations: Set<string>;
}
interface FailedReleaseInternals {
  startAndroidRecoveryRecord(
    sessionId: string,
    details: { deviceId: string },
    reservations: readonly string[],
  ): FailedReleaseRecord;
  markAndroidRecoveryReleaseFailure(record: FailedReleaseRecord): void;
}

async function setupFailedReleaseFence() {
  const context = await setup();
  context.sessions.stopCleanupTimer();
  context.sessions.setActiveSessionExecutionChecker((id) =>
    context.pool.isSessionRecoveryInFlight(id),
  );
  const internals = context.pool as unknown as FailedReleaseInternals;
  const record = internals.startAndroidRecoveryRecord("session", { deviceId: original.deviceId }, [
    "loss",
    "quarantine",
    "failed-release",
  ]);
  (context.pool as unknown as DevicePoolRecoveryInternals).failedTerminalRecoveryReleases.add(
    "session",
  );
  const releases: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    context.sessions,
    (id) => context.pool.isSessionRecoveryInFlight(id),
    async (id, reason) => {
      releases.push(reason);
      await context.sessions.releaseSession(id, reason);
    },
    context.timer,
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
  sessions.recordHeartbeat("session");
  const before = { ...record, reservations: new Set(record.reservations) };
  await monitor.tick();
  expect(releases).toEqual([]);
  expect(record).toEqual(before);
  expect(
    (pool as unknown as DevicePoolRecoveryInternals).recoveringSessionLosses.get("session"),
  ).toBe(record);
  expect(
    (pool as unknown as DevicePoolRecoveryInternals).failedTerminalRecoveryReleases.has("session"),
  ).toBe(true);
});

test("an in-flight promise blocks reaping a failed-release fence with or without a deadline", async () => {
  const { pool, timer, monitor, releases, record } = await setupFailedReleaseFence();
  const recovery = Promise.withResolvers<void>();
  (pool as unknown as DevicePoolRecoveryInternals).sessionPreservingRecoveries.set("session", {
    promise: recovery.promise,
  });
  timer.advanceTime(20_001);
  for (const deadline of [undefined, timer.now() - 1, timer.now() + 5_000]) {
    record.deferredUntil = deadline;
    expect(pool.isSessionRecoveryInFlight("session")).toBe(true);
    await monitor.tick();
  }
  expect(releases).toEqual([]);
  recovery.resolve();
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

test("failed-release expiry preserves a declined commit fence", async () => {
  const { sessions, pool, record } = await setupFailedReleaseFence();
  const release = await sessions.releaseSessionUnlessSuperseded(
    "session",
    "heartbeat-timeout",
    () => false,
  );
  expect(release).toEqual({ superseded: true });
  expect(record.reservations.has("failed-release")).toBe(true);
  expect(record.failedReleaseAttempts).toBeUndefined();
  expect(
    (pool as unknown as DevicePoolRecoveryInternals).recoveringSessionLosses.get("session"),
  ).toBe(record);
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
  expect(await sessions.releaseSession("session", "cleanup-expired", true)).toBeNull();
  expect(attempts).toBe(1);
  finish.resolve();
  await release;
  assertNoRecoveryReservationsRemain(pool, "session");
});

test("a cancelled Android recovery does not spend the crash-loop budget (#7545)", async () => {
  const manager = new RearmableShutdownManager(original.deviceId);
  const { timer, sessions, pool, captured } = await setup(manager);
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

    // Re-provision the AVD and bind a fresh session, then simulate a
    // genuine loss. maxAttempts is 1, so this only recovers if the
    // cancelled attempt above did not spend the budget.
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession(
      "session-2",
      original.deviceId,
      "android",
      image,
      undefined,
      original,
    );
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
  const { sessions, manager, pool, captured, timer } = await setup(
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
    expect(
      (pool as unknown as { androidRecoveryHandoffOwners: Map<string, symbol> })
        .androidRecoveryHandoffOwners.size,
    ).toBe(0);
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
    const internals = pool as unknown as {
      joinSessionPreservingRecovery(
        recovery: { incidentId?: string; promise: Promise<"released"> },
        incidentId?: string,
      ): Promise<string>;
    };
    await internals.joinSessionPreservingRecovery(
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
    expect(await persistence.getSession?.("session")).toMatchObject({
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
