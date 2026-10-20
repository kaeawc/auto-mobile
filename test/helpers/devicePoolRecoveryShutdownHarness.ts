import { recoveryInternals } from "../helpers/devicePoolRecoveryInternals";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { expect } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncidentStore,
} from "../../src/daemon/emulatorLossIncident";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

export const original: BootedDevice = {
  name: "Pixel_8_API_35",
  platform: "android",
  deviceId: "emulator-5554",
};
export const image: DeviceInfo = {
  name: original.name,
  platform: "android",
  isRunning: true,
  source: "local",
};
export const RECOVERY_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS",
  "AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS",
  "AUTOMOBILE_ANDROID_REBOOT_ON_DEATH",
  "AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH",
] as const;

export async function withRecoveryEnvUnset<T>(action: () => Promise<T>): Promise<T> {
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

export class LaggingShutdownManager extends FakeDeviceManager {
  readonly killAccepted = Promise.withResolvers<void>();

  constructor(private readonly replacementDeviceId = "emulator-5560") {
    super();
  }

  override async killDevice(_device?: BootedDevice): Promise<void> {
    this.killAccepted.resolve();
  }
  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    this.startedDevices.push(device);
    this.bootedDevices = [{ ...original, deviceId: this.replacementDeviceId }];
    return { pid: 0 } as ChildProcess;
  }
  override async waitForDeviceReady(_device?: DeviceInfo): Promise<BootedDevice> {
    return this.bootedDevices[0];
  }
}
export class KillTrackingShutdownManager extends LaggingShutdownManager {
  readonly kills: string[] = [];

  override async killDevice(device: BootedDevice): Promise<void> {
    this.kills.push(device.deviceId);
    await super.killDevice(device);
  }
}
export class BlockingRecoveryReadyManager extends LaggingShutdownManager {
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
export class RearmableShutdownManager extends LaggingShutdownManager {
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

export class PerAvdBlockingReadyManager extends LaggingShutdownManager {
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
export class FailingGetIncidentStore extends InMemoryEmulatorLossIncidentStore {
  failGets = false;
  override async get(incidentId: string) {
    if (this.failGets) {
      throw new Error("incident repository unavailable");
    }
    return await super.get(incidentId);
  }
}

export function setup(
  manager: LaggingShutdownManager = new LaggingShutdownManager(),
  cancelDeviceSessionExecutions?: (sessionId: string, reason: string) => Promise<number>,
  emulatorLossIncidentStore?: EmulatorLossIncidentStore,
  apps = new FakeInstalledAppsRepository(),
) {
  return setupWith(manager, cancelDeviceSessionExecutions, emulatorLossIncidentStore, apps);
}

/** {@link setup} that keeps the concrete manager type, so its own recording members stay visible. */
export async function setupWith<M extends LaggingShutdownManager>(
  manager: M,
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
  await pool.bindOrReuseDeviceSession({
    sessionId: "session",
    deviceId: original.deviceId,
    platform: "android",
    sourceImage: image,
    expectedIdentity: original,
  });
  const captured = pool.getDevice(original.deviceId)!;
  return { timer, sessions, manager, pool, captured, persistence };
}

export async function setupPassiveRestart(release = true) {
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
  await pool.bindOrReuseDeviceSession({
    sessionId: "session",
    deviceId: original.deviceId,
    platform: "android",
    sourceImage: image,
    expectedIdentity: original,
  });
  const captured = pool.getDevice(original.deviceId)!;
  manager.bootedDevices = [];
  if (release) {
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).resolves.toBe("released");
  }
  return { timer, persistence, sessions, manager, pool, captured, incidents };
}

export async function setupAwaitingOwner(manager: LaggingShutdownManager) {
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

export function assertNoRecoveryReservationsRemain(pool: DevicePool, sessionId: string): void {
  const internals = pool.testHooks;
  const recoveryState = recoveryInternals(pool);
  expect(pool.isSessionRecoveryInFlight(sessionId)).toBe(false);
  expect(recoveryState.sessionPreservingRecoveries.has(sessionId)).toBe(false);
  expect(recoveryState.recoveringSessionLosses.has(sessionId)).toBe(false);
  expect(internals.adbServerResetQuarantinedSessions.has(sessionId)).toBe(false);
  expect(recoveryState.failedTerminalRecoveryReleases.has(sessionId)).toBe(false);
  expect(recoveryState.recoveringAndroidImages.has(original.name)).toBe(false);
  expect(internals.recoveryCoordinator.recoveringAndroidImageSettlements.has(original.name)).toBe(
    false,
  );
  expect(internals.adbServerResetRecoveryReservations.has(original.name)).toBe(false);
  expect(recoveryState.recoveringAndroidDeviceIds.has(original.deviceId)).toBe(false);
  expect(recoveryState.androidRecoveryHandoffOwners.has(original.deviceId)).toBe(false);
}

export async function flush(): Promise<void> {
  // Persisted rows are read back through the session-clock conversion (#11162), one turn each.
  for (let i = 0; i < 80; i++) {
    await Promise.resolve();
  }
}

export async function setupSettledRestart(
  outcome: "not-attempted" | "exhausted" = "not-attempted",
) {
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
