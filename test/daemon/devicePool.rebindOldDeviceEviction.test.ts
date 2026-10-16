import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commitAcquisition, type AcquisitionReceipt } from "../../src/daemon/acquisitionReceipt";
import { holderOf } from "../../src/daemon/deviceBinding";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// A setActiveDevice rebind (receipt, refusePreparedForOtherRequest) keeps the OLD device pool-bound
// to the session until its deferred cleanup settles. Losing OLD in that window must drop only OLD:
// the session now lives on NEW, and releasing it would strand NEW under a session that is gone.

const OLD = "emulator-5554";
const NEW = "emulator-5556";

describe("losing the old device during a deferred rebind cleanup", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let devices: FakeDeviceManager;
  let pool: DevicePool;
  let releaseGate: () => void = () => {};
  const booted: BootedDevice[] = [
    { deviceId: OLD, name: "avd-a", platform: "android" },
    { deviceId: NEW, name: "avd-b", platform: "android" },
  ];

  const spin = async (): Promise<void> => {
    for (let turn = 0; turn < 300; turn++) {
      await Promise.resolve();
    }
  };

  beforeEach(async () => {
    timer = new FakeTimer();
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
      // The old-device restore is slow (real adb): it holds the deferred cleanup window open.
      keepScreenAwakeRestorer: () => ({
        restore: async () => {
          await gate;
          return { status: "restored" as const };
        },
      }),
    });
    devices = new FakeDeviceManager();
    devices.bootedDevices = booted;
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "rebind-eviction-daemon", {
        timer,
        deviceManager: devices,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(booted);
    await pool.bindOrReuseDeviceSession("s1", OLD, "android");
    sessions.updateSessionCache("s1", {
      keepScreenAwake: { applied: true, method: "svc", svcWasEnabled: false },
    });
    // setActiveDevice's shape (src/server/setActiveDevice.ts): receipt, refuse=true, then commit.
    const receipt: AcquisitionReceipt = {};
    await pool.bindOrReuseDeviceSession(
      "s1",
      NEW,
      "android",
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      receipt,
      true,
    );
    commitAcquisition(receipt);
    await spin();
    expect(sessions.getSession("s1")?.assignedDevice).toBe(NEW);
    expect(holderOf(pool.getDevice(OLD)!)).toBe("s1"); // deferred: OLD still held under s1
    expect(holderOf(pool.getDevice(NEW)!)).toBe("s1");
  });
  afterEach(() => {
    releaseGate();
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const expectSessionKeptOnNew = (): void => {
    expect(sessions.getSession("s1")?.assignedDevice).toBe(NEW);
    expect(holderOf(pool.getDevice(NEW)!)).toBe("s1");
    expect(sessions.getSessionForDevice(NEW)).toBe("s1");
    expect(pool.getDevice(OLD) ?? null).toBeNull();
  };

  test("runtime identity replacement on refresh keeps the session on its new device", async () => {
    // emulator-5554's console port now hosts a different AVD.
    devices.bootedDevices = [{ deviceId: OLD, name: "avd-z", platform: "android" }, booted[1]!];
    await pool.refreshDevices();
    await spin();
    expect(sessions.getSession("s1")).toBeDefined();
    expect(holderOf(pool.getDevice(NEW)!)).toBe("s1");
    expect(sessions.getSession("s1")?.assignedDevice).toBe(NEW);
    expect(sessions.getSessionForDevice(NEW)).toBe("s1");
  });

  const evictOld = async (attemptDeviceLossRecovery: boolean): Promise<void> => {
    devices.bootedDevices = [booted[1]!];
    const evict = (
      pool as unknown as {
        evictMissingPooledDevice(
          device: NonNullable<ReturnType<DevicePool["getDevice"]>>,
          reason: string,
          options?: { attemptDeviceLossRecovery?: boolean },
        ): Promise<void>;
      }
    ).evictMissingPooledDevice.bind(pool);
    await evict(pool.getDevice(OLD)!, "not present in adb devices", { attemptDeviceLossRecovery });
    await spin();
    expectSessionKeptOnNew();
  };

  test("plain missing-device eviction keeps the session on its new device", async () => {
    await evictOld(false);
  });

  test("eviction with device-loss recovery does not recover the session onto the old device", async () => {
    await evictOld(true);
  });

  test("a newer identity observation during eviction leaves the deferred release to free the old device", async () => {
    const internals = pool as unknown as {
      tryPreserveSessionForMissingDevice(): Promise<boolean>;
      releaseDeviceClaim(deviceId: string): void;
      evictMissingPooledDevice(
        device: NonNullable<ReturnType<DevicePool["getDevice"]>>,
        reason: string,
        options: {
          identityObservation: {
            deviceId: string;
            name: string;
            platform: "android";
            observedAt: number;
          };
        },
      ): Promise<void>;
    };
    const old = pool.getDevice(OLD)!;
    old.identityObservedAt = 1;
    const claimsReleased: string[] = [];
    const releaseClaim = internals.releaseDeviceClaim.bind(pool);
    internals.releaseDeviceClaim = (deviceId) => {
      claimsReleased.push(deviceId);
      releaseClaim(deviceId);
    };
    // The eviction awaits here; a newer observation reconfirms OLD meanwhile.
    internals.tryPreserveSessionForMissingDevice = async () => {
      old.identityObservedAt = 5;
      return false;
    };
    await internals.evictMissingPooledDevice(old, "runtime identity changed", {
      identityObservation: { deviceId: OLD, name: "avd-z", platform: "android", observedAt: 3 },
    });
    releaseGate();
    await spin();
    expect(pool.getDevice(OLD)).toBe(old);
    expect(sessions.getSession("s1")?.assignedDevice).toBe(NEW);
    expect(holderOf(old)).toBeNull();
    expect(old.status).toBe("idle");
    expect(claimsReleased).toContain(OLD);
  });
});
