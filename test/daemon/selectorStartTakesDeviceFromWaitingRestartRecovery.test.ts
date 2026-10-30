import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { drainUntil, settleByFakeEvents } from "../helpers/fakeTimerStepping";

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

/** A real pool that lets the test report the simulator missing, as device discovery would. */
class EvictablePool extends DevicePool {
  override evictMissingPooledDevice(
    ...args: Parameters<DevicePool["evictMissingPooledDevice"]>
  ): Promise<void> {
    return super.evictMissingPooledDevice(...args);
  }
}

describe("a session waiting in flight for its restarting device", () => {
  let fixtures: Awaited<ReturnType<typeof createSimulatorHolder>>[];
  let active: Awaited<ReturnType<typeof createSimulatorHolder>>;

  beforeAll(async () => {
    // Independent bound holders: only fixture construction is outside the timed tests.
    // Each test still performs the real loss, handoff, absent retry and returning-device path.
    fixtures = [await createSimulatorHolder(), await createSimulatorHolder()];
  });

  afterEach(() => {
    active.pool.releaseDeviceClaimsForShutdown();
    active.sessions.stopCleanupTimer();
    active.timer.reset();
  });

  async function createSimulatorHolder() {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const persistence = new FakeDeviceSessionPersistence();
    const sessions = new SessionManager(timer, persistence);
    sessions.stopCleanupTimer();
    const manager = new FakeDeviceManager([], [SIMULATOR]);
    const pool = new EvictablePool(
      createDevicePoolDependencies(sessions, "daemon", {
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
        timer,
        deviceManager: manager,
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
        deviceSessionContinuityEnabled: true,
      }),
    );
    await pool.initializeWithDevices([SIMULATOR]);
    await pool.bindOrReuseDeviceSession({
      sessionId: HOLDER,
      deviceId: SIMULATOR.deviceId,
      platform: "ios",
      expectedIdentity: SIMULATOR,
    });
    const held = pool.getDevice(SIMULATOR.deviceId);
    if (!held) {
      throw new Error("expected the simulator to be pooled");
    }
    return { timer, persistence, sessions, manager, pool, held };
  }

  /** The holder's simulator restarts, and the holder's next control call waits for it. */
  async function holderWaitsForItsRestartingSimulator(index: number) {
    active = fixtures[index];
    const { timer, persistence, sessions, manager, pool, held } = active;
    manager.bootedDevices = [];
    await pool.evictMissingPooledDevice(held, "not present in iOS simulator discovery", {
      attemptDeviceLossRecovery: true,
    });
    expect((await persistence.getSession(HOLDER))?.release_reason).toBe(
      `device-restart:${SIMULATOR.deviceId}`,
    );

    const answers: Record<string, string> = {};
    const record = (who: string, call: Promise<{ assignedDevice: string }>) =>
      call.then(
        (session) => (answers[who] = `holds ${session.assignedDevice}`),
        (error: unknown) => (answers[who] = error instanceof Error ? error.name : String(error)),
      );
    const holderCall = record(
      HOLDER,
      sessions.getOrCreateSession(HOLDER, pool, "ios", { requireIssuedSession: true }),
    );
    await drainUntil(() => timer.getPendingTimeouts().includes(1_000), {
      description: "holder's first restart retry",
    });
    // Exercise one absent-device retry, then wait for its next poll to park.
    timer.advanceTime(1_000);
    await drainUntil(() => timer.getPendingTimeouts().includes(1_000), {
      description: "holder still waiting after absent-device retry",
    });
    expect(answers).toEqual({});

    return { timer, persistence, sessions, pool, manager, answers, record, holderCall };
  }

  test("control: resumes on the same simulator when it comes back", async () => {
    const { timer, manager, answers, holderCall } = await holderWaitsForItsRestartingSimulator(0);

    manager.bootedDevices = [SIMULATOR];
    timer.advanceTime(1_000);
    await holderCall;

    expect(answers).toEqual({ [HOLDER]: `holds ${SIMULATOR.deviceId}` });
  });

  test("keeps it when another session starts a device by selector as it comes back", async () => {
    const { timer, persistence, sessions, pool, manager, answers, record, holderCall } =
      await holderWaitsForItsRestartingSimulator(1);

    manager.bootedDevices = [SIMULATOR];
    const newcomerCall = record(NEWCOMER, sessions.getOrCreateSession(NEWCOMER, pool, "ios"));
    timer.advanceTime(1_000);
    await holderCall;
    await settleByFakeEvents(timer, newcomerCall, {
      description: "selector refusal while holder owns device",
    });
    expect(answers[NEWCOMER]).toBe("Error");

    expect({
      holder: answers[HOLDER],
      deviceHeldBy: pool.getDevice(SIMULATOR.deviceId)?.sessionId,
      holderRow: (await persistence.getSession(HOLDER))?.release_reason ?? null,
    }).toEqual({
      holder: `holds ${SIMULATOR.deviceId}`,
      deviceHeldBy: HOLDER,
      holderRow: null,
    });
  });
});
