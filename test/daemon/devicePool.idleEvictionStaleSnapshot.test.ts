import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../src/models";
import type { BootedDeviceDiscovery } from "../../src/utils/deviceUtils";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

// Regression for #7951: multi-device allocation runs its pre-allocation cleanup
// (pruneStaleIdleIosDevices / evictUnavailableIdleDevicesMatching) outside
// assignmentMutex, while lock holders (bindOrReuseDeviceSession) await discovery
// I/O between reading the pooled entry and publishing sessionId/"busy".

/**
 * Parks the next detailed discovery for `parkNext` on a deferred the test
 * resolves. The listing is snapshotted when the call is made, so the parked
 * caller later acts on evidence older than whatever happened meanwhile.
 */
class ParkingFakeDeviceManager extends FakeDeviceManager {
  parkNext: Platform | null = null;
  parked: Array<{ resolve: () => void }> = [];
  parkRecoveryStart = false;
  parkedRecoveryStarts: Array<{ resolve: () => void }> = [];

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    if (platform !== "either" && platform === this.parkNext) {
      this.parkNext = null;
      const snapshot = await super.getBootedDevicesDetailed(platform);
      await new Promise<void>((resolve) => this.parked.push({ resolve }));
      return snapshot;
    }
    return super.getBootedDevicesDetailed(platform);
  }

  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    if (this.parkRecoveryStart) {
      this.parkRecoveryStart = false;
      await new Promise<void>((resolve) => this.parkedRecoveryStarts.push({ resolve }));
    }
    return super.startDevice(device);
  }
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

describe("idle eviction with a stale discovery snapshot", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let deviceManager: ParkingFakeDeviceManager;
  let pool: DevicePool;

  beforeEach(() => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    deviceManager = new ParkingFakeDeviceManager();
    pool = new DevicePool(
      sessionManager,
      "repro-6393-daemon",
      timer,
      new FakeInstalledAppsRepository(),
      deviceManager,
      new DefaultRetryExecutor(timer),
    );
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  // The issue's recipe verbatim. On current main this is caught AFTER publish by
  // createSessionOrRestore's isSessionAssignmentCurrent check (#5341): the bind
  // rejects and the transient session is released, so no ghost-busy session
  // survives. Kept as the regression guard for the issue's headline claim.
  test("iOS: bind parked in liveness await does not leak a session on a pruned entry", async () => {
    const udid = "11111111-2222-3333-4444-555555555555";
    const sim: BootedDevice = { name: "iPhone 16", platform: "ios", deviceId: udid };
    deviceManager.bootedDevices = [sim];
    await pool.initializeWithDevices([sim]);
    const pooledBefore = pool.getDevice(udid);

    // Connection B: exact bind parks inside assertIdleDeviceAssignable's
    // getIosLivenessSnapshot() while holding assignmentMutex.
    deviceManager.parkNext = "ios";
    const bind = pool.bindOrReuseDeviceSession("session-b", udid, "ios").then(
      (sessionId) => ({ ok: true as const, sessionId }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await flushMicrotasks();
    expect(deviceManager.parked).toHaveLength(1);

    // Connection A: multi-device allocation prunes the idle simulator with no
    // lock held (simctl no longer lists it), then fails for lack of capacity.
    deviceManager.bootedDevices = [];
    await pool.assignMultipleDevices(["session-a"], 1_000, "ios").catch(() => undefined);
    expect(pool.getDevice(udid)).toBeNull();

    // B's parked snapshot resolves as still-booted; B resumes and publishes.
    deviceManager.parked[0].resolve();
    const outcome = await bind;

    const boundIsPooled = outcome.ok && pool.getDevice(udid) === pooledBefore;
    const rejectedActionably = !outcome.ok && outcome.error instanceof ActionableError;
    expect(boundIsPooled || rejectedActionably).toBe(true);
    expect(sessionManager.getSession("session-b")).toBeNull();
  });

  // The issue's second verification case: an unlocked eviction must not remove
  // an entry a lock holder claimed after the eviction's discovery was taken.
  test("Android: stale unlocked eviction must not release/remove a device bound meanwhile", async () => {
    const serial = "R58M1234ABC"; // physical handset: no emulator recovery path
    const handset: BootedDevice = { name: "SM-S911B", platform: "android", deviceId: serial };
    deviceManager.bootedDevices = [handset];
    await pool.initializeWithDevices([handset]);

    // Connection A: assignMultipleDevices' evictUnavailableIdleDevicesMatching
    // takes an adb snapshot while the handset is briefly absent, then parks
    // (no lock held) before acting on it.
    deviceManager.bootedDevices = [];
    deviceManager.parkNext = "android";
    const allocation = pool
      .assignMultipleDevices(["session-a"], 1_000, "android")
      .catch((error: unknown) => error);
    await flushMicrotasks();
    expect(deviceManager.parked).toHaveLength(1);

    // Handset is back. Connection B binds it under the mutex, with its own
    // fresher discovery confirming presence.
    deviceManager.bootedDevices = [handset];
    const sessionId = await pool.bindOrReuseDeviceSession("session-b", serial, "android");
    expect(sessionId).toBe("session-b");
    const bound = pool.getDevice(serial);
    expect(bound?.sessionId).toBe("session-b");

    // A resumes on its stale "absent" snapshot.
    deviceManager.parked[0].resolve();
    await allocation;
    await flushMicrotasks();

    const diagnostic = {
      poolEntryIsBound: pool.getDevice(serial) === bound,
      boundSessionId: bound?.sessionId ?? null,
      sessionBAssignedDevice: sessionManager.getSession("session-b")?.assignedDevice ?? null,
    };
    expect(diagnostic).toEqual({
      poolEntryIsBound: true,
      boundSessionId: "session-b",
      sessionBAssignedDevice: serial,
    });
  });

  test("Android: a device still absent and unbound is evicted", async () => {
    const serial = "R58M1234ABC";
    const handset: BootedDevice = { name: "SM-S911B", platform: "android", deviceId: serial };
    deviceManager.bootedDevices = [handset];
    await pool.initializeWithDevices([handset]);

    deviceManager.bootedDevices = [];
    await pool.assignMultipleDevices(["session-a"], 1_000, "android").catch(() => undefined);

    expect(pool.getDevice(serial)).toBeNull();
    expect(sessionManager.getSessionForDevice(serial)).toBeNull();
  });

  test("Android: idle emulator recovery does not hold the assignment lock", async () => {
    const emulator: BootedDevice = {
      name: "Pixel_8_API_35",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: emulator.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    const handset: BootedDevice = {
      name: "SM-S911B",
      platform: "android",
      deviceId: "R58M1234ABC",
    };
    pool = new DevicePool(
      sessionManager,
      "repro-6393-daemon",
      timer,
      new FakeInstalledAppsRepository(),
      deviceManager,
      new DefaultRetryExecutor(timer),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { onLoss: true, maxAttempts: 1 },
    );
    deviceManager.bootedDevices = [handset];
    await pool.initializeWithDevices([handset]);
    await pool.addDevice(emulator, image);
    expect(pool.getRecoveryEligibility(emulator.deviceId).eligible).toBe(true);

    deviceManager.parkRecoveryStart = true;
    const eviction = pool.assignMultipleDevices([], 1_000, "android");
    await flushMicrotasks(100);
    expect(deviceManager.parkedRecoveryStarts).toHaveLength(1);

    let bindAndReleaseSettled = false;
    const bindAndRelease = pool
      .bindOrReuseDeviceSession("unrelated", handset.deviceId, "android")
      .then(async (sessionId) => {
        await pool.releaseDevice(handset.deviceId, sessionId);
        bindAndReleaseSettled = true;
        return sessionId;
      });
    try {
      await flushMicrotasks(100);
      expect(bindAndReleaseSettled).toBe(true);
    } finally {
      deviceManager.parkedRecoveryStarts[0].resolve();
      await Promise.allSettled([eviction, bindAndRelease]);
    }
    expect(await bindAndRelease).toBe("unrelated");
  });
});
