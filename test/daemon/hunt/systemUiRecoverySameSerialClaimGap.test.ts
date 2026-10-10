import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { DeviceInfo } from "../../../src/models";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

/**
 * Hunt: #11437 (claim the System UI recovery replacement) on a SAME-SERIAL replacement, the usual
 * shape of the recovery (the same AVD restarted on the same console port).
 *
 * The recovery removes the stopped incarnation from the pool, which withdraws this daemon's claim
 * file, adds the replacement, and only then publishes a new claim before rebinding the session.
 * Between the withdrawal and the new claim the device this daemon's session is mid-recovery on is
 * unclaimed, although the session never let go of it. Claims are published atomically now (one
 * `link()` wins), so another daemon whose allocation looks in that gap takes the claim cleanly,
 * and this daemon's recovery then fails with `device_owned_by_other_daemon`, removes the
 * replacement and releases the session. A session that held its device the whole time loses it
 * to another daemon; the claim should be carried across a same-serial replacement, not dropped.
 */

const DAEMON_A_PID = 1111;
const DAEMON_B_PID = 2222;
const SESSION = "owner-session";
const SERIAL = "emulator-5554";

describe("cross-daemon claim across a same-serial System UI ANR recovery", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;

  beforeEach(() => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  });
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("the session's device is never unclaimed while the session still holds it", async () => {
    /** One host's claim files: device id -> owning daemon PID. */
    const claims = new Map<string, number>();
    /** Every moment the device had no claim file while daemon A's session was bound to it. */
    const unclaimedWhileHeld: string[] = [];
    let daemonBIsAllocating = false;
    const daemonA: ForeignDeviceOwnership = {
      async refresh(): Promise<void> {},
      foreignOwnerPid: (deviceId) =>
        claims.get(deviceId) === DAEMON_B_PID ? DAEMON_B_PID : undefined,
      async claim(deviceId) {
        if (claims.has(deviceId) && claims.get(deviceId) !== DAEMON_A_PID) {
          return false;
        }
        claims.set(deviceId, DAEMON_A_PID);
        return true;
      },
      release(deviceId) {
        if (claims.get(deviceId) !== DAEMON_A_PID) {
          return;
        }
        claims.delete(deviceId);
        if (sessions.getSession(SESSION)?.assignedDevice === deviceId) {
          unclaimedWhileHeld.push(deviceId);
        }
        if (daemonBIsAllocating) {
          // Daemon B's allocation finds the booted device with no claim file and links its own.
          claims.set(deviceId, DAEMON_B_PID);
        }
      },
    };
    const original = { deviceId: SERIAL, name: "Pixel 8", platform: "android" as const };
    // The same AVD, restarted on the same console port.
    const replacement = { deviceId: SERIAL, name: "Pixel 8", platform: "android" as const };
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
    await pool.bindOrReuseDeviceSession(SESSION, SERIAL, "android", sourceImage);
    expect(claims.get(SERIAL)).toBe(DAEMON_A_PID);

    const reservation = await pool.reserveDeviceForShutdown(SERIAL);
    if (!reservation) {
      throw new Error("expected shutdown reservation");
    }
    daemonBIsAllocating = true;
    let recoveryError: unknown;
    try {
      await pool.replaceDeviceForSystemUiAnrRecovery(reservation.device, replacement, sourceImage);
    } catch (error) {
      recoveryError = error;
    } finally {
      daemonBIsAllocating = false;
      await reservation.release();
    }

    // Another daemon must not be able to take the device out from under a session that held it
    // throughout: the recovery succeeds and the session still drives its device...
    expect({
      recoveryError: recoveryError === undefined ? undefined : String(recoveryError),
      claimOwner: claims.get(SERIAL),
      pooledSession: pool.getDevice(SERIAL)?.sessionId,
      sessionDevice: sessions.getSession(SESSION)?.assignedDevice,
    }).toEqual({
      recoveryError: undefined,
      claimOwner: DAEMON_A_PID,
      pooledSession: SESSION,
      sessionDevice: SERIAL,
    });
    // ...because its claim was never withdrawn in between.
    expect(unclaimedWhileHeld).toEqual([]);
  });
});
