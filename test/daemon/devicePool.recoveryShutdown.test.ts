import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
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
async function setup() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new LaggingShutdownManager();
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

test("ordinary session recovery preserves quarantined ownership after unconfirmed shutdown", async () => {
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
  } finally {
    sessions.stopCleanupTimer();
  }
});
