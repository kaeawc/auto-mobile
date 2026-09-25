import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncidentStore,
} from "../../src/daemon/emulatorLossIncident";
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
) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
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
    undefined,
    emulatorLossIncidentStore,
    cancelDeviceSessionExecutions,
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

async function setupPassiveRestart() {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager();
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
    { onLoss: false, maxAttempts: 1 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
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
  await expect(
    pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
  ).resolves.toBe("released");
  return { timer, persistence, sessions, manager, pool };
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
    sessions,
    "restarted-daemon",
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

interface DevicePoolRecoveryInternals {
  adbServerResetQuarantinedSessions: Set<string>;
  adbServerResetRecoveryReservations: Map<
    string,
    { sessionId?: string; recoveryGeneration?: number; resolve(): void }
  >;
  recoveringAndroidImages: Map<string, DeviceInfo>;
  recoveringAndroidImageSettlements: Map<string, unknown>;
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
  expect(internals.recoveringAndroidImageSettlements.has(original.name)).toBe(false);
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

test("same-serial emulator continuity is enabled when the recovery environment is unset", async () => {
  await withRecoveryEnvUnset(async () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new KillTrackingShutdownManager(original.deviceId);
    const releaseCancellation = Promise.withResolvers<void>();
    let cancellationCalls = 0;
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
      { onLoss: false, maxAttempts: 1 },
      undefined,
      undefined,
      async () => {
        cancellationCalls++;
        await releaseCancellation.promise;
        return 0;
      },
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
    { onLoss: false, maxAttempts: 1 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
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
  manager.bootedDevices = [];

  try {
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured),
    ).resolves.toBe("released");
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
    expect(await persistence.getSession?.("session")).toMatchObject({
      status: "released",
      release_reason: `device-restart:${original.name}`,
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

test("device-restart resume waits for the same serial and preserves its session UUID", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true);
    await flush();
    expect(timer.getPendingSleeps()).toEqual([1_000]);
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
    await flush();
    expect(timer.getPendingSleeps()).toEqual([1_000]);
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

test("device-restart resume terminalizes absence at the persisted restart deadline", async () => {
  const { timer, persistence, sessions, pool } = await setupPassiveRestart();
  try {
    const resume = sessions.getOrCreateSession("session", pool, "android", undefined, true);
    await flush();
    expect(timer.getPendingSleeps()).toEqual([1_000]);
    timer.advanceTime(30_000);
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
    expect(timer.getPendingSleeps()).toEqual([1_000]);
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
    expect(internals.recoveringAndroidImageSettlements.has(second.name)).toBe(false);
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
  timer.enableAutoAdvance();
  timer.advanceTime(20_001);
  for (const [index, delay] of [
    5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
  ].entries()) {
    await expect(monitor.tick()).rejects.toThrow("persist release failed");
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
  timer.enableAutoAdvance();
  sessions.cleanupExpiredSessions();
  await expect(pool.waitForSessionPreservingRecovery("session")).rejects.toThrow(
    "persist release failed",
  );
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
