import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AcquisitionReceipt } from "../../../src/daemon/acquisitionReceipt";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

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

  beforeEach(() => {
    timer = new FakeTimer();
    restoredKeepAwake = [];
    restoredBiometrics = [];
    sessions = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      (device) => ({
        restore: async () => {
          restoredKeepAwake.push(device.deviceId);
        },
      }),
      (device) => ({
        restore: async () => {
          restoredBiometrics.push(device.deviceId);
        },
      }),
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

  /** Move the session to `to`, as setActiveDevice does, then undo it as a cancelled call does. */
  const rebindThenUndo = async (pool: DevicePool, from: string, to: string): Promise<void> => {
    const platform = sessions.getSession("held")!.platform;
    const receipt: AcquisitionReceipt = {};
    await pool.bindOrReuseDeviceSession(
      "held",
      to,
      platform,
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
    // Control: the rebind was recorded as a move, and the undo puts the session back.
    expect(receipt.rebound).toMatchObject({ deviceId: to, fromDeviceId: from });
    await pool.releaseUndeliveredAcquisition(receipt);
    expect(sessions.getSession("held")?.assignedDevice).toBe(from);
    expect(pool.getDevice(from)).toMatchObject({ sessionId: "held", status: "busy" });
    expect(pool.getDevice(to)).toMatchObject({ sessionId: null, status: "idle" });
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
});
