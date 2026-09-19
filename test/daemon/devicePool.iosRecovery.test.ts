import { expect, test } from "bun:test";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import { isRecoverableDaemonReleaseReason } from "../../src/db/deviceSessionRepository";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo, SomePlatform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

const IOS_SIMULATOR: BootedDevice = {
  name: "iPhone 16 Pro",
  platform: "ios",
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  iosVersion: "18.0",
};

const IOS_PHYSICAL_DEVICE: BootedDevice = {
  name: "Physical iPhone",
  platform: "ios",
  deviceId: "00008030-001C2D3E1234567A",
  iosVersion: "18.0",
};

const ANDROID_EMULATOR: BootedDevice = {
  name: "Pixel_8_API_35",
  platform: "android",
  deviceId: "emulator-5554",
};

const ANDROID_IMAGE: DeviceInfo = {
  name: ANDROID_EMULATOR.name,
  platform: "android",
  isRunning: true,
  source: "local",
};

class DiscoveryCountingDeviceManager extends FakeDeviceManager {
  discoveryCalls = 0;

  override async getBootedDevicesDetailed(platform: SomePlatform) {
    this.discoveryCalls++;
    return await super.getBootedDevicesDetailed(platform);
  }
}

interface DevicePoolRecoveryInternals {
  evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    attemptDeviceLossRecovery?: boolean,
  ): Promise<void>;
  getSessionPreservingRecoveryTarget(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ): { device: PooledDevice; session: Session } | undefined;
}

function createPool(
  sessions: SessionManager,
  timer: FakeTimer,
  manager: FakeDeviceManager,
  continuityEnabled = true,
  onLoss = false,
): DevicePool {
  return new DevicePool(
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
    { onLoss, maxAttempts: 1 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    continuityEnabled,
  );
}

async function setupOwnedIOS(
  manager: FakeDeviceManager = new FakeDeviceManager([], [IOS_SIMULATOR]),
  onLoss = false,
) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const pool = createPool(sessions, timer, manager, true, onLoss);
  manager.bootedDevices = [IOS_SIMULATOR];
  await pool.initializeWithDevices([IOS_SIMULATOR]);
  await pool.bindOrReuseDeviceSession(
    "ios-session",
    IOS_SIMULATOR.deviceId,
    "ios",
    undefined,
    undefined,
    IOS_SIMULATOR,
  );
  const captured = pool.getDevice(IOS_SIMULATOR.deviceId);
  if (!captured) {
    throw new Error("expected the simulator to be pooled");
  }
  return { timer, persistence, sessions, pool, manager, captured };
}

async function evictAsMissing(pool: DevicePool, device: PooledDevice): Promise<void> {
  await (pool as unknown as DevicePoolRecoveryInternals).evictMissingPooledDevice(
    device,
    "not present in iOS simulator discovery",
    true,
  );
}

async function seedRecoverableIOSSession(
  persistence: FakeDeviceSessionPersistence,
  releaseReason = "daemon-restart",
): Promise<void> {
  await persistence.upsertActiveSession({
    sessionUuid: "ios-session",
    deviceId: IOS_SIMULATOR.deviceId,
    stableDeviceId: IOS_SIMULATOR.deviceId,
    platform: "ios",
    createdAtMs: 0,
    lastUsedAtMs: 0,
    expiresAtMs: 60_000,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    hasReceivedHeartbeat: true,
  });
  await persistence.markReleased("ios-session", "released", 0, releaseReason);
}

test("owned iOS simulator loss and same-UDID return preserve the session with a new connection", async () => {
  const { sessions, persistence, pool, manager, captured } = await setupOwnedIOS();
  const originalConnectionId = `${captured.id}#${captured.incarnation}`;
  manager.bootedDevices = [];

  try {
    await evictAsMissing(pool, captured);

    expect(sessions.getSession("ios-session")).toBeNull();
    expect(await persistence.getSession?.("ios-session")).toMatchObject({
      status: "released",
      release_reason: `device-restart:${IOS_SIMULATOR.deviceId}`,
    });
    expect(manager.startedDevices).toEqual([]);

    manager.bootedDevices = [IOS_SIMULATOR];
    await pool.refreshDevices();
    const recovered = await sessions.getOrCreateSession(
      "ios-session",
      pool,
      "ios",
      undefined,
      true,
    );
    const replacement = pool.getDevice(IOS_SIMULATOR.deviceId);

    expect(recovered).toMatchObject({
      sessionId: "ios-session",
      assignedDevice: IOS_SIMULATOR.deviceId,
      stableDeviceId: IOS_SIMULATOR.deviceId,
      platform: "ios",
    });
    expect(replacement).toMatchObject({ sessionId: "ios-session", status: "busy" });
    expect(`${replacement?.id}#${replacement?.incarnation}`).not.toBe(originalConnectionId);
    expect(manager.startedDevices).toEqual([]);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("awaiting-owner iOS simulator loss is admitted and rehydrates onto the same UDID", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  await seedRecoverableIOSSession(persistence);
  const sessions = new SessionManager(timer, persistence);
  const manager = new FakeDeviceManager([], [IOS_SIMULATOR]);
  const pool = createPool(sessions, timer, manager);
  await pool.initializeWithDevices([IOS_SIMULATOR]);

  try {
    await expect(sessions.rehydratePersistedSessions(pool)).resolves.toEqual({
      rehydrated: ["ios-session"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
    expect(sessions.getSession("ios-session")).toMatchObject({ ownership: "awaiting-owner" });
    const captured = pool.getDevice(IOS_SIMULATOR.deviceId);
    if (!captured) {
      throw new Error("expected the awaiting-owner simulator to be pooled");
    }

    manager.bootedDevices = [];
    await evictAsMissing(pool, captured);
    expect(await persistence.getSession?.("ios-session")).toMatchObject({
      release_reason: `device-restart:${IOS_SIMULATOR.deviceId}`,
    });

    manager.bootedDevices = [IOS_SIMULATOR];
    await pool.refreshDevices();
    await expect(sessions.rehydratePersistedSessions(pool)).resolves.toEqual({
      rehydrated: ["ios-session"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
    expect(sessions.getSession("ios-session")).toMatchObject({
      sessionId: "ios-session",
      assignedDevice: IOS_SIMULATOR.deviceId,
      stableDeviceId: IOS_SIMULATOR.deviceId,
      ownership: "awaiting-owner",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("iOS simulator continuity survives a daemon restart before the same UDID returns", async () => {
  const { timer, sessions, persistence, pool, manager, captured } = await setupOwnedIOS();
  manager.bootedDevices = [];

  try {
    await evictAsMissing(pool, captured);
  } finally {
    sessions.stopCleanupTimer();
  }

  const restartedSessions = new SessionManager(timer, persistence);
  const restartedPool = createPool(restartedSessions, timer, manager);
  manager.bootedDevices = [IOS_SIMULATOR];
  await restartedPool.initializeWithDevices([IOS_SIMULATOR]);

  try {
    await expect(restartedSessions.rehydratePersistedSessions(restartedPool)).resolves.toEqual({
      rehydrated: ["ios-session"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
    expect(restartedSessions.getSession("ios-session")).toMatchObject({
      sessionId: "ios-session",
      assignedDevice: IOS_SIMULATOR.deviceId,
      stableDeviceId: IOS_SIMULATOR.deviceId,
      ownership: "awaiting-owner",
    });
  } finally {
    restartedSessions.stopCleanupTimer();
  }
});

test("onLoss-enabled iOS recovery only polls discovery while a user-shut-down simulator is absent", async () => {
  const manager = new DiscoveryCountingDeviceManager([], [IOS_SIMULATOR]);
  const { timer, sessions, pool, captured } = await setupOwnedIOS(manager, true);
  manager.bootedDevices = [];

  try {
    await evictAsMissing(pool, captured);
    const recovery = sessions.getOrCreateSession("ios-session", pool, "ios", undefined, true);
    for (let i = 0; i < 10 && manager.discoveryCalls === 0; i++) {
      await Promise.resolve();
    }

    expect(manager.discoveryCalls).toBeGreaterThan(0);
    expect(manager.startedDevices).toEqual([]);

    manager.bootedDevices = [IOS_SIMULATOR];
    timer.advanceTime(1_000);
    await expect(recovery).resolves.toMatchObject({ sessionId: "ios-session" });
    expect(manager.startedDevices).toEqual([]);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("physical iOS device loss remains terminal", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new FakeDeviceManager([], [IOS_PHYSICAL_DEVICE]);
  const pool = createPool(sessions, timer, manager);
  await pool.initializeWithDevices([IOS_PHYSICAL_DEVICE]);
  await pool.bindOrReuseDeviceSession(
    "physical-session",
    IOS_PHYSICAL_DEVICE.deviceId,
    "ios",
    undefined,
    undefined,
    IOS_PHYSICAL_DEVICE,
  );
  const captured = pool.getDevice(IOS_PHYSICAL_DEVICE.deviceId);
  if (!captured) {
    throw new Error("expected the physical iOS device to be pooled");
  }
  manager.bootedDevices = [];

  try {
    await evictAsMissing(pool, captured);
    const persisted = await persistence.getSession?.("physical-session");

    expect(sessions.getSession("physical-session")).toBeNull();
    expect(persisted?.release_reason).toBeDefined();
    expect(isRecoverableDaemonReleaseReason(persisted?.release_reason ?? "")).toBe(false);
    expect(pool.getDevice(IOS_PHYSICAL_DEVICE.deviceId)).toBeNull();
    expect(manager.startedDevices).toEqual([]);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("Android emulators and iOS simulators resolve through the shared continuity target", async () => {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new FakeDeviceManager([], [ANDROID_EMULATOR, IOS_SIMULATOR]);
  const pool = createPool(sessions, timer, manager);
  await pool.addDevice(ANDROID_EMULATOR, ANDROID_IMAGE);
  await pool.addDevice(IOS_SIMULATOR);
  await pool.bindOrReuseDeviceSession(
    "android-session",
    ANDROID_EMULATOR.deviceId,
    "android",
    ANDROID_IMAGE,
    undefined,
    ANDROID_EMULATOR,
  );
  await pool.bindOrReuseDeviceSession(
    "ios-session",
    IOS_SIMULATOR.deviceId,
    "ios",
    undefined,
    undefined,
    IOS_SIMULATOR,
  );
  const android = pool.getDevice(ANDROID_EMULATOR.deviceId);
  const ios = pool.getDevice(IOS_SIMULATOR.deviceId);
  if (!android || !ios) {
    throw new Error("expected both virtual devices to be pooled");
  }
  const internals = pool as unknown as DevicePoolRecoveryInternals;

  try {
    expect(
      internals.getSessionPreservingRecoveryTarget(android.id, android)?.session,
    ).toMatchObject({ sessionId: "android-session", platform: "android" });
    expect(internals.getSessionPreservingRecoveryTarget(ios.id, ios)?.session).toMatchObject({
      sessionId: "ios-session",
      platform: "ios",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});
