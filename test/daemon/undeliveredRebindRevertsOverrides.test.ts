import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commitAcquisition, type AcquisitionReceipt } from "../../src/daemon/acquisitionReceipt";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  SESSION_CREATE_WAIT_TIMEOUT_MS,
  SessionManager,
  type SessionCacheData,
} from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Hunt (session-rebind-1, cell 5). #11593: a setActiveDevice rebind whose answer never reached its
// client is undone: "every provisioning failure rolls back what this call created and nothing
// else". The undo moves the session back to the device it held, but the rebind had already
// reverted every override the session applied to that device and dropped its record, so the
// client that never saw the call succeed keeps its device with its overrides silently gone
// (only the display pin is put back, by setActiveDevice itself).

const SIM_A = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
const SIM_B = "BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB";
const AVD_A = "emulator-5554";
const AVD_B = "emulator-5556";

describe("an undelivered rebind keeps the session's overrides on the device it goes back to", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let restoredKeepAwake: string[];
  let restoredBiometrics: string[];
  let restoredSettings: Array<{ slot: string; deviceId: string; state: unknown }>;
  let keepAwakeGate: Promise<void> | undefined;
  let resets: string[];
  let renewals: string[];

  beforeEach(() => {
    timer = new FakeTimer();
    restoredKeepAwake = [];
    restoredBiometrics = [];
    restoredSettings = [];
    keepAwakeGate = undefined;
    resets = [];
    renewals = [];
    sessions = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      (device) => ({
        restore: async () => {
          restoredKeepAwake.push(device.deviceId);
          await keepAwakeGate;
        },
      }),
      (device) => ({
        restore: async () => {
          restoredBiometrics.push(device.deviceId);
        },
      }),
      {
        networkCondition: (device) => ({
          restore: async (state) => {
            restoredSettings.push({ slot: "networkCondition", deviceId: device.deviceId, state });
          },
        }),
        clock: (device) => ({
          restore: async (state) => {
            restoredSettings.push({ slot: "clock", deviceId: device.deviceId, state });
          },
        }),
        rotation: (device) => ({
          restore: async (state) => {
            restoredSettings.push({ slot: "rotation", deviceId: device.deviceId, state });
          },
        }),
        screenReader: (device) => ({
          restore: async (state) => {
            restoredSettings.push({ slot: "screenReader", deviceId: device.deviceId, state });
          },
        }),
        iosAppNetworkRule: {
          reset: async (rule) => {
            resets.push(rule.udid);
          },
          renew: async (rule) => {
            renewals.push(rule.udid);
            return "renewed";
          },
        },
      },
    );
  });
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const poolWith = async (booted: BootedDevice[]): Promise<DevicePool> => {
    const devices = new FakeDeviceManager();
    devices.bootedDevices = booted;
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-daemon", {
        timer,
        deviceManager: devices,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(booted);
    return pool;
  };

  const spin = async (): Promise<void> => {
    for (let turn = 0; turn < 100; turn++) {
      await Promise.resolve();
    }
  };

  const bind = async (pool: DevicePool, to: string): Promise<AcquisitionReceipt> => {
    const receipt: AcquisitionReceipt = {};
    await pool.bindOrReuseDeviceSession(
      "held",
      to,
      sessions.getSession("held")!.platform,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      receipt,
    );
    return receipt;
  };

  const rebindThenUndo = async (pool: DevicePool, from: string, to: string): Promise<void> => {
    const receipt = await bind(pool, to);
    expect(receipt.rebound).toMatchObject({ deviceId: to, fromDeviceId: from });
    expect(sessions.hasDeviceCleanupInProgress(from)).toBe(true);
    await pool.releaseUndeliveredAcquisition(receipt);
    // Re-observing the cancellation cannot write settings or release A a second time.
    await pool.releaseUndeliveredAcquisition(receipt);
    timer.advanceTime(SESSION_CREATE_WAIT_TIMEOUT_MS);
    await spin();
    expect(sessions.getSession("held")?.assignedDevice).toBe(from);
    expect(pool.getDevice(from)).toMatchObject({ sessionId: "held", status: "busy" });
    expect(pool.getDevice(to)).toMatchObject({ sessionId: null, status: "idle" });
  };

  const androidOverrides = {
    keepScreenAwake: { applied: true, method: "svc", svcWasEnabled: false },
    networkCondition: { initialProfile: "none" },
    clock: { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: false },
    rotation: { accelerometerRotation: 1, userRotation: 2 },
    screenReader: { platform: "android", previousEnabled: false },
  } satisfies SessionCacheData;

  const androidPool = async (): Promise<DevicePool> => {
    const pool = await poolWith([
      { deviceId: AVD_A, name: "avd-a", platform: "android" },
      { deviceId: AVD_B, name: "avd-b", platform: "android" },
      { deviceId: "emulator-5558", name: "avd-c", platform: "android" },
    ]);
    await pool.bindOrReuseDeviceSession("held", AVD_A, "android");
    sessions.updateSessionCache("held", structuredClone(androidOverrides));
    return pool;
  };

  const settled = async (receipt: AcquisitionReceipt): Promise<void> => {
    await receipt.deferredRebindCleanup!.settled;
    await spin();
  };

  const expectAndroidRestoredOnce = (): void => {
    expect(restoredKeepAwake).toEqual([AVD_A]);
    expect(restoredSettings).toEqual([
      { slot: "networkCondition", deviceId: AVD_A, state: "none" },
      { slot: "clock", deviceId: AVD_A, state: androidOverrides.clock },
      { slot: "rotation", deviceId: AVD_A, state: androidOverrides.rotation },
      { slot: "screenReader", deviceId: AVD_A, state: androidOverrides.screenReader },
    ]);
  };

  test("iOS: the biometric enrollment the session changed is not reverted, and stays recorded", async () => {
    const pool = await poolWith([
      { deviceId: SIM_A, name: "sim-a", platform: "ios" },
      { deviceId: SIM_B, name: "sim-b", platform: "ios" },
    ]);
    await pool.bindOrReuseDeviceSession("held", SIM_A, "ios");
    sessions.setBiometricEnrollment("held", { initialEnrollment: "not_enrolled" });

    await rebindThenUndo(pool, SIM_A, SIM_B);

    // The client never learned of a rebind: its device must be as its own calls left it.
    expect(restoredBiometrics).toEqual([]);
    expect(sessions.getBiometricEnrollment("held")).toEqual({ initialEnrollment: "not_enrolled" });
  });

  test("Android: keep-screen-awake is not reverted, and stays recorded for the release", async () => {
    const pool = await poolWith([
      { deviceId: AVD_A, name: "avd-a", platform: "android" },
      { deviceId: AVD_B, name: "avd-b", platform: "android" },
    ]);
    await pool.bindOrReuseDeviceSession("held", AVD_A, "android");
    sessions.setKeepScreenAwake("held", { applied: true, method: "svc", svcWasEnabled: false });

    await rebindThenUndo(pool, AVD_A, AVD_B);

    expect(restoredKeepAwake).toEqual([]);
    expect(sessions.getKeepScreenAwake("held")).toMatchObject({ applied: true });
  });

  test("undo retains network, clock, rotation and screen reader without any restore write", async () => {
    const pool = await androidPool();
    await rebindThenUndo(pool, AVD_A, AVD_B);
    expect(sessions.getSession("held")!.cacheData).toEqual(androidOverrides);
    expect(restoredKeepAwake).toEqual([]);
    expect(restoredSettings).toEqual([]);
  });

  test("delivery restores all Android slots once, and A cannot be acquired until writes settle", async () => {
    const pool = await androidPool();
    const gate = Promise.withResolvers<void>();
    keepAwakeGate = gate.promise;
    const receipt = await bind(pool, AVD_B);
    expect(restoredKeepAwake).toEqual([]);
    await expect(pool.bindOrReuseDeviceSession("other", AVD_A, "android")).rejects.toThrow();
    commitAcquisition(receipt);
    commitAcquisition(receipt);
    await spin();
    expect(restoredKeepAwake).toEqual([AVD_A]);
    expect(restoredSettings).toEqual([]);
    expect(pool.getDevice(AVD_A)).toMatchObject({ sessionId: "held", status: "busy" });
    await expect(pool.bindOrReuseDeviceSession("other", AVD_A, "android")).rejects.toThrow();
    gate.resolve();
    await settled(receipt);
    expectAndroidRestoredOnce();
    expect(sessions.hasDeviceCleanupInProgress(AVD_A)).toBe(false);
    await pool.bindOrReuseDeviceSession("other", AVD_A, "android");
    expect(pool.getDevice(AVD_A)).toMatchObject({ sessionId: "other", status: "busy" });
    expect(sessions.getSession("held")!.cacheData).toEqual({});
  });

  test("delivery restores iOS biometric enrollment and screen reader on A once", async () => {
    const pool = await poolWith([
      { deviceId: SIM_A, name: "sim-a", platform: "ios" },
      { deviceId: SIM_B, name: "sim-b", platform: "ios" },
    ]);
    await pool.bindOrReuseDeviceSession("held", SIM_A, "ios");
    sessions.updateSessionCache("held", {
      biometricEnrollment: { initialEnrollment: "not_enrolled" },
      screenReader: { platform: "ios", previousEnabled: false },
    });
    const receipt = await bind(pool, SIM_B);
    expect(restoredBiometrics).toEqual([]);
    commitAcquisition(receipt);
    await settled(receipt);
    expect(restoredBiometrics).toEqual([SIM_A]);
    expect(restoredSettings).toEqual([
      { slot: "screenReader", deviceId: SIM_A, state: { platform: "ios", previousEnabled: false } },
    ]);
    expect(pool.getDevice(SIM_A)).toMatchObject({ sessionId: null, status: "idle" });
  });

  test.each([
    "second rebind",
    "release",
    "shutdown drain",
    "bound",
    "removal",
    "device shutdown",
  ] as const)("%s flushes the old device's deferred restores once", async (path) => {
    const pool = await androidPool();
    const receipt = await bind(pool, AVD_B);
    expect(restoredKeepAwake).toEqual([]);
    if (path === "second rebind") {
      await bind(pool, "emulator-5558");
    } else if (path === "release") {
      await sessions.releaseSession("held");
    } else if (path === "shutdown drain") {
      expect(await sessions.drainPendingDeviceCleanups(1_000)).toBe(true);
    } else if (path === "device shutdown") {
      pool.markIntentionalShutdown(AVD_A);
    } else if (path === "removal") {
      await pool.removeDevice(AVD_A);
    } else {
      timer.advanceTime(SESSION_CREATE_WAIT_TIMEOUT_MS);
    }
    await settled(receipt);
    commitAcquisition(receipt);
    timer.advanceTime(SESSION_CREATE_WAIT_TIMEOUT_MS);
    await spin();
    expectAndroidRestoredOnce();
    if (path === "removal") {
      await pool.removeDevice(AVD_A);
      expect(pool.getDevice(AVD_A)).toBeNull();
    } else {
      expect(pool.getDevice(AVD_A)).toMatchObject({ sessionId: null, status: "idle" });
    }
  });

  test("a caller without a receipt restores inline", async () => {
    const pool = await androidPool();
    await pool.bindOrReuseDeviceSession(
      "held",
      AVD_B,
      "android",
      undefined,
      undefined,
      undefined,
      true,
    );
    expectAndroidRestoredOnce();
    expect(pool.getDevice(AVD_A)).toMatchObject({ sessionId: null, status: "idle" });
  });

  test("undo after the bound keeps restored override records absent", async () => {
    const pool = await androidPool();
    const receipt = await bind(pool, AVD_B);
    timer.advanceTime(SESSION_CREATE_WAIT_TIMEOUT_MS);
    await settled(receipt);
    await pool.releaseUndeliveredAcquisition(receipt);
    expectAndroidRestoredOnce();
    expect(sessions.getSession("held")!.cacheData).toEqual({});
    expect(pool.getDevice(AVD_A)).toMatchObject({ sessionId: "held", status: "busy" });
    expect(pool.getDevice(AVD_B)).toMatchObject({ sessionId: null, status: "idle" });
  });

  test("another session took A after cleanup: undo keeps B and never restores A again", async () => {
    const pool = await androidPool();
    const receipt = await bind(pool, AVD_B);
    commitAcquisition(receipt);
    await settled(receipt);
    await pool.bindOrReuseDeviceSession("other", AVD_A, "android");
    await pool.releaseUndeliveredAcquisition(receipt);
    expectAndroidRestoredOnce();
    expect(pool.getDevice(AVD_A)).toMatchObject({ sessionId: "other", status: "busy" });
    expect(pool.getDevice(AVD_B)).toMatchObject({ sessionId: "held", status: "busy" });
  });

  test("deferred restores refuse an intervening holder even if its binding bypassed the pool", async () => {
    const pool = await androidPool();
    const receipt = await bind(pool, AVD_B);
    await sessions.createSession("other", AVD_A, "android");
    commitAcquisition(receipt);
    await settled(receipt);
    expect(restoredKeepAwake).toEqual([]);
    expect(restoredSettings).toEqual([]);
    await pool.releaseUndeliveredAcquisition(receipt);
    expect(sessions.getSession("held")!.assignedDevice).toBe(AVD_B);
    expect(sessions.getSession("other")!.assignedDevice).toBe(AVD_A);
  });

  test("undo preserves the original network TTL deadline", async () => {
    const pool = await androidPool();
    const held = sessions.getSession("held")!;
    sessions.scheduleNetworkConditionExpiry(held, 100);
    const expiry = sessions.peekNetworkConditionExpiry("held");
    const receipt = await bind(pool, AVD_B);
    expect(sessions.peekNetworkConditionExpiry("held")).toBeUndefined();
    timer.advanceTime(1_000);
    await pool.releaseUndeliveredAcquisition(receipt);
    expect(sessions.peekNetworkConditionExpiry("held")).toEqual(expiry);
    expect(restoredSettings).toEqual([]);
    timer.advanceTime(99_000);
    await spin();
    expect(restoredSettings).toEqual([
      { slot: "networkCondition", deviceId: AVD_A, state: "none" },
    ]);
    expect(sessions.getNetworkCondition("held")).toBeUndefined();
  });

  test("an iOS per-app lease keeps renewing A while deferred and resumes on undo", async () => {
    const pool = await poolWith([
      { deviceId: SIM_A, name: "sim-a", platform: "ios" },
      { deviceId: SIM_B, name: "sim-b", platform: "ios" },
    ]);
    await pool.bindOrReuseDeviceSession("held", SIM_A, "ios");
    const held = sessions.getSession("held")!;
    const { rule } = sessions.beginIosAppNetworkRule(held, {
      udid: SIM_A,
      bundleId: "dev.example",
    });
    sessions.confirmIosAppNetworkRule(held, rule);
    const cache = structuredClone(held.cacheData);
    const receipt = await bind(pool, SIM_B);
    timer.advanceTime(5_000);
    await spin();
    expect(renewals).toEqual([SIM_A]);
    expect(resets).toEqual([]);
    await pool.releaseUndeliveredAcquisition(receipt);
    expect(held.cacheData).toEqual(cache);
    expect(sessions.activeIosAppNetworkLease("held")).toEqual(rule);
    timer.advanceTime(5_000);
    await spin();
    expect(renewals).toEqual([SIM_A, SIM_A]);
    expect(resets).toEqual([]);
  });

  test("delayed cleanup snapshots A and preserves new settings and TTL recorded on B", async () => {
    const pool = await androidPool();
    const receipt = await bind(pool, AVD_B);
    const replacement = {
      ...structuredClone(androidOverrides),
      clock: { initialAutomaticTime: 0 as const, clockChangedByUs: true, rootedByUs: true },
    };
    sessions.updateSessionCache("held", replacement);
    sessions.scheduleNetworkConditionExpiry(sessions.getSession("held")!, 100);
    const expiry = sessions.peekNetworkConditionExpiry("held");
    commitAcquisition(receipt);
    await settled(receipt);
    expectAndroidRestoredOnce();
    expect(sessions.getSession("held")!.cacheData).toEqual(replacement);
    expect(sessions.peekNetworkConditionExpiry("held")).toEqual(expiry);
  });

  test("a holder appearing during a delayed first restore prevents subsequent writes to A", async () => {
    const pool = await androidPool();
    const gate = Promise.withResolvers<void>();
    keepAwakeGate = gate.promise;
    const receipt = await bind(pool, AVD_B);
    commitAcquisition(receipt);
    await spin();
    await sessions.createSession("other", AVD_A, "android");
    gate.resolve();
    await settled(receipt);
    expect(restoredKeepAwake).toEqual([AVD_A]);
    expect(restoredSettings).toEqual([]);
  });

  test("iOS delivery resets the deferred rule once and retires its renewal lease", async () => {
    const pool = await poolWith([
      { deviceId: SIM_A, name: "sim-a", platform: "ios" },
      { deviceId: SIM_B, name: "sim-b", platform: "ios" },
    ]);
    await pool.bindOrReuseDeviceSession("held", SIM_A, "ios");
    const held = sessions.getSession("held")!;
    const { rule } = sessions.beginIosAppNetworkRule(held, {
      udid: SIM_A,
      bundleId: "dev.example",
    });
    sessions.confirmIosAppNetworkRule(held, rule);
    const receipt = await bind(pool, SIM_B);
    commitAcquisition(receipt);
    await settled(receipt);
    commitAcquisition(receipt);
    timer.advanceTime(SESSION_CREATE_WAIT_TIMEOUT_MS);
    await spin();
    expect(resets).toEqual([SIM_A]);
    expect(renewals).toEqual([]);
    expect(sessions.activeIosAppNetworkLease("held")).toBeUndefined();
    expect(pool.getDevice(SIM_A)).toMatchObject({ sessionId: null, status: "idle" });
  });

  test("undo restores A's platform as well as its retained override cache", async () => {
    const pool = await poolWith([
      { deviceId: SIM_A, name: "sim-a", platform: "ios" },
      { deviceId: AVD_B, name: "avd-b", platform: "android" },
    ]);
    await pool.bindOrReuseDeviceSession("held", SIM_A, "ios");
    sessions.setBiometricEnrollment("held", { initialEnrollment: "not_enrolled" });
    const receipt: AcquisitionReceipt = {};
    await pool.bindOrReuseDeviceSession(
      "held",
      AVD_B,
      "android",
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      receipt,
    );
    await pool.releaseUndeliveredAcquisition(receipt);
    expect(sessions.getSession("held")).toMatchObject({
      assignedDevice: SIM_A,
      platform: "ios",
      cacheData: { biometricEnrollment: { initialEnrollment: "not_enrolled" } },
    });
    expect(restoredBiometrics).toEqual([]);
    expect(pool.getDevice(SIM_A)).toMatchObject({ sessionId: "held", status: "busy" });
    expect(pool.getDevice(AVD_B)).toMatchObject({ sessionId: null, status: "idle" });
  });
});
