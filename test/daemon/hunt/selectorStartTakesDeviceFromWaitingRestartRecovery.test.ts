import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool, type PooledDevice } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

// Hunt 2026-10-11, device-restart recovery, cell 2 (who can take the device during S's recovery
// window).
//
// S holds a simulator. The simulator restarts: S is released with the recoverable
// `device-restart:<udid>` reason and its owner is told to retry under the same session. S's next
// control call is admitted and waits, in flight, inside the pool for that exact device to return.
//
// Nothing holds the device for S meanwhile. When the simulator comes back, a selector start from
// any other session (`getApple`/`startDevice` by platform) is an ordinary allocation: it sees an
// idle device and takes it. S's waiting call is then answered `identity-recovery-target-busy` and
// its UUID is fenced for good, although it was first, was told to wait, and was waiting.
//
// A daemon restart reserves each recoverable row's device up front for exactly this reason
// (#11294, `reserveDevicesForRehydration`: "an allocation arriving meanwhile cannot take a device a
// row is about to recover onto"). A device restart has no such hold, even while the row's own
// recovery call is in flight.

const SIMULATOR: BootedDevice = {
  name: "iPhone 16 Pro",
  platform: "ios",
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  iosVersion: "18.0",
};
const HOLDER = "session-holding-the-simulator";
const NEWCOMER = "session-starting-by-selector";

interface DevicePoolLossInternals {
  evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    options?: { attemptDeviceLossRecovery?: boolean },
  ): Promise<void>;
}

describe("a session waiting in flight for its restarting device", () => {
  let sessions: SessionManager;

  afterEach(() => {
    sessions.stopCleanupTimer();
  });

  /** The holder's simulator restarts, and the holder's next control call waits for it. */
  async function holderWaitsForItsRestartingSimulator() {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const persistence = new FakeDeviceSessionPersistence();
    sessions = new SessionManager(timer, persistence);
    sessions.stopCleanupTimer();
    const manager = new FakeDeviceManager([], [SIMULATOR]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon", {
        timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
        deviceSessionContinuityEnabled: true,
      }),
    );
    await pool.initializeWithDevices([SIMULATOR]);
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      SIMULATOR.deviceId,
      "ios",
      undefined,
      undefined,
      SIMULATOR,
    );
    const held = pool.getDevice(SIMULATOR.deviceId);
    if (!held) {
      throw new Error("expected the simulator to be pooled");
    }

    manager.bootedDevices = [];
    await (pool as unknown as DevicePoolLossInternals).evictMissingPooledDevice(
      held,
      "not present in iOS simulator discovery",
      { attemptDeviceLossRecovery: true },
    );
    expect((await persistence.getSession?.(HOLDER))?.release_reason).toBe(
      `device-restart:${SIMULATOR.deviceId}`,
    );

    const answers: Record<string, string> = {};
    const record = (who: string, call: Promise<{ assignedDevice: string }>) =>
      call.then(
        (session) => (answers[who] = `holds ${session.assignedDevice}`),
        (error: unknown) => (answers[who] = (error as Error).name),
      );
    const holderCall = record(
      HOLDER,
      sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true),
    );
    // Two and a half seconds into the restart the holder's call is still waiting.
    await timer.advanceTimeAsync(2_500, () => drainMicrotasks(50));
    expect(answers).toEqual({});

    return { timer, persistence, pool, manager, answers, record, holderCall };
  }

  test("control: resumes on the same simulator when it comes back", async () => {
    const { timer, manager, answers, holderCall } = await holderWaitsForItsRestartingSimulator();

    manager.bootedDevices = [SIMULATOR];
    await timer.advanceTimeAsync(2_000, () => drainMicrotasks(50));
    await holderCall;

    expect(answers).toEqual({ [HOLDER]: `holds ${SIMULATOR.deviceId}` });
  });

  test("keeps it when another session starts a device by selector as it comes back", async () => {
    const { timer, persistence, pool, manager, answers, record, holderCall } =
      await holderWaitsForItsRestartingSimulator();

    manager.bootedDevices = [SIMULATOR];
    const newcomerCall = record(NEWCOMER, sessions.getOrCreateSession(NEWCOMER, pool, "ios"));
    await timer.advanceTimeAsync(2_000, () => drainMicrotasks(50));
    await Promise.all([holderCall, newcomerCall]);

    expect({
      holder: answers[HOLDER],
      deviceHeldBy: pool.getDevice(SIMULATOR.deviceId)?.sessionId,
      holderRow: (await persistence.getSession?.(HOLDER))?.release_reason ?? null,
    }).toEqual({
      holder: `holds ${SIMULATOR.deviceId}`,
      deviceHeldBy: HOLDER,
      holderRow: null,
    });
  });
});
