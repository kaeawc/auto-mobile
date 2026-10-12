import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceOwnedByOtherDaemonError } from "../../src/daemon/deviceAcquisitionRefusals";
import type { DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const DAEMON_A_PID = 1111;

/** One host's claim files: device id -> owning daemon PID. */
const claims = new Map<string, number>();

const DAEMON_B_PID = 2222;

const daemonA: ForeignDeviceOwnership = {
  async refresh(): Promise<void> {},
  foreignOwnerPid: (deviceId) => (claims.get(deviceId) === DAEMON_B_PID ? DAEMON_B_PID : undefined),
  async claim(deviceId) {
    if (claims.has(deviceId) && claims.get(deviceId) !== DAEMON_A_PID) {
      return false;
    }
    claims.set(deviceId, DAEMON_A_PID);
    return true;
  },
  release(deviceId) {
    if (claims.get(deviceId) === DAEMON_A_PID) {
      claims.delete(deviceId);
    }
  },
};

describe("cross-daemon claim across System UI ANR recovery", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;

  beforeEach(() => {
    claims.clear();
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  });
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("the session's rebound replacement device stays claimed against other daemons", async () => {
    const original = { deviceId: "emulator-5554", name: "Pixel 8", platform: "android" as const };
    const replacement = {
      deviceId: "emulator-5556",
      name: "Pixel 8",
      platform: "android" as const,
    };
    const sourceImage: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      isRunning: false,
      source: "local",
    };
    const devices = new FakeDeviceManager();
    devices.bootedDevices = [original];
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon-a", {
        timer,
        deviceManager: devices,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        foreignDeviceOwnership: daemonA,
      }),
    );
    await pool.initializeWithDevices([original]);
    await pool.bindOrReuseDeviceSession("owner-session", original.deviceId, "android", sourceImage);
    expect(claims.get(original.deviceId)).toBe(DAEMON_A_PID);

    const reservation = await pool.reserveDeviceForShutdown(original.deviceId);
    if (!reservation) {
      throw new Error("expected shutdown reservation");
    }
    try {
      await pool.replaceDeviceForSystemUiAnrRecovery(reservation.device, replacement, sourceImage);
    } finally {
      await reservation.release();
    }

    // Daemon A's session now drives the replacement.
    expect(pool.getDevice(replacement.deviceId)?.sessionId).toBe("owner-session");
    // ...so daemon B must still see it claimed; the claim file is how it finds out.
    expect(claims.get(replacement.deviceId)).toBe(DAEMON_A_PID);
  });

  test("a replacement another daemon already claims fails the recovery with the typed refusal", async () => {
    const original = { deviceId: "emulator-5554", name: "Pixel 8", platform: "android" as const };
    const replacement = {
      deviceId: "emulator-5556",
      name: "Pixel 8",
      platform: "android" as const,
    };
    const sourceImage: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      isRunning: false,
      source: "local",
    };
    const devices = new FakeDeviceManager();
    devices.bootedDevices = [original];
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon-a", {
        timer,
        deviceManager: devices,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        foreignDeviceOwnership: daemonA,
      }),
    );
    await pool.initializeWithDevices([original]);
    await pool.bindOrReuseDeviceSession("owner-session", original.deviceId, "android", sourceImage);
    claims.set(replacement.deviceId, DAEMON_B_PID);

    const reservation = await pool.reserveDeviceForShutdown(original.deviceId);
    if (!reservation) {
      throw new Error("expected shutdown reservation");
    }
    let thrown: unknown;
    try {
      await pool.replaceDeviceForSystemUiAnrRecovery(reservation.device, replacement, sourceImage);
    } catch (error) {
      thrown = error;
    } finally {
      await reservation.release();
    }

    expect(thrown).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect((thrown as DeviceOwnedByOtherDaemonError).ownerPid).toBe(DAEMON_B_PID);
    // No half-bound session: daemon B keeps its claim, this daemon holds nothing and drives nothing.
    expect(claims.get(replacement.deviceId)).toBe(DAEMON_B_PID);
    expect(claims.has(original.deviceId)).toBe(false);
    expect(pool.getDevice(replacement.deviceId)?.sessionId ?? null).toBeNull();
    expect(sessions.getSession("owner-session")).toBeNull();
  });
});
