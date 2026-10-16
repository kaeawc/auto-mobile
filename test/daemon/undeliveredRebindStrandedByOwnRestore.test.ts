import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AcquisitionReceipt } from "../../src/daemon/acquisitionReceipt";
import { DevicePool } from "../../src/daemon/devicePool";
import { SESSION_CREATE_WAIT_TIMEOUT_MS, SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Hunt (session-rebind-1, cell 5). #11593: a rebind whose answer never reached its client moves
// the session back to the device it held. The documented exception is a previous device another
// session acquired meanwhile. Here nobody else took it: the rebind's own keep-awake restore on the
// old device failed once and is retrying, which quarantines that device, so the undo's bind back
// is refused and the session is left on the device its client never learned about.

const AVD_A = "emulator-5554";
const AVD_B = "emulator-5556";

let timer: FakeTimer;
let sessions: SessionManager;
let restoreAttempts: number;

beforeEach(() => {
  timer = new FakeTimer();
  restoreAttempts = 0;
  sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
    keepScreenAwakeRestorer: () => ({
      restore: async () => {
        restoreAttempts++;
        if (restoreAttempts === 1) {
          throw new Error("adb: device offline");
        }

        return { status: "restored" as const };
      },
    }),
  });
});
afterEach(() => {
  sessions.stopCleanupTimer();
  timer.reset();
});

const spin = async (turns = 50): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
};

test("an undelivered rebind is moved back once its own old-device restore settles", async () => {
  const booted: BootedDevice[] = [
    { deviceId: AVD_A, name: "avd-a", platform: "android" },
    { deviceId: AVD_B, name: "avd-b", platform: "android" },
  ];
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
  await pool.bindOrReuseDeviceSession("held", AVD_A, "android");
  sessions.setKeepScreenAwake("held", { applied: true, method: "svc", svcWasEnabled: false });

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
  // Control: the session moved, and the old device is quarantined only by this rebind's own retry.
  expect(receipt.rebound).toMatchObject({ deviceId: AVD_B, fromDeviceId: AVD_A });
  expect(restoreAttempts).toBe(0);
  timer.advanceTime(SESSION_CREATE_WAIT_TIMEOUT_MS);
  await spin();
  expect(restoreAttempts).toBe(1);
  expect(sessions.hasDeviceCleanupInProgress(AVD_A)).toBe(true);
  expect(sessions.getSessionForDevice(AVD_A)).toBeNull();

  // The client cancelled before the answer: the call is undone.
  const undo = pool.releaseUndeliveredAcquisition(receipt);
  await spin();
  // The retry succeeds 250 ms later and the old device leaves quarantine.
  timer.advanceTime(1_000);
  await spin();
  await undo;
  timer.advanceTime(1_000);
  await spin();

  expect(restoreAttempts).toBe(2);
  expect(sessions.getKeepScreenAwake("held")).toBeUndefined();
  expect(sessions.hasDeviceCleanupInProgress(AVD_A)).toBe(false);
  // Nobody else took the old device, yet the session its client believes is on it stays moved.
  expect(sessions.getAllSessions().map((session) => session.sessionId)).toEqual(["held"]);
  expect(sessions.getSession("held")?.assignedDevice).toBe(AVD_A);
  expect(pool.getDevice(AVD_A)).toMatchObject({ sessionId: "held", status: "busy" });
  expect(pool.getDevice(AVD_B)).toMatchObject({ sessionId: null, status: "idle" });
});
