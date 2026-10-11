import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import {
  isRecoverableDaemonReleaseReason,
  isTerminalReleaseReason,
} from "../../../src/daemon/releaseReasons";
import { SessionManager, TerminalSessionError } from "../../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
} from "../../../src/daemon/sessionLivenessWindows";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

// Hunt 2026-10-11, device-restart recovery, cell 4 (stacked causes): the device restarts under a
// session whose owner has already been silent for the whole no-heartbeat budget.
//
// The owner's heartbeats stopped while a control call was in flight, so the monitor's reap was
// vetoed. Then the device restarts: the call is cut and the session is released with the
// recoverable `device-restart:<id>` reason.
//
// `heartbeatReapUpgradesNonTerminalRelease.test.ts` ("an owner that had already lost its lease when
// the release began is still reaped") pins that this owner's session ends as `heartbeat-timeout`,
// but only while the handoff release is still tearing down when the next scan runs. When the
// teardown finishes first (nothing to restore: the common case for a device that just died), the
// session leaves the map, the monitor never sees it again, and the row stays a recoverable
// handoff. Nothing tracks the owner during the handoff, so for the rest of the recovery window
// (up to three minutes) a call naming the UUID is issued the session again, although its owner
// was lost for more than the 10 s budget before the device ever restarted.

const SESSION = "hunt-lapsed-owner-session";
const DEVICE = "emulator-5554";
const OWNER = "hunt-owner-token";
const HANDOFF = "device-restart:Pixel_A";
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;

describe("a device restart under a session whose owner already lost its heartbeat lease", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaped: string[];
  let callInFlight: boolean;

  function createOnPixelA(sessionId: string) {
    return manager.createSession(sessionId, DEVICE, "android", undefined, undefined, "Pixel_A");
  }

  /** `restoreMs` is how long the handoff release's device teardown takes. */
  async function start(restoreMs: number): Promise<void> {
    timer = new FakeTimer();
    timer.setCurrentTime(0);
    callInFlight = false;
    reaped = [];
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      undefined,
      undefined,
      {
        networkCondition: () => ({ restore: async () => undefined }),
        clock: () => ({ restore: () => timer.sleep(restoreMs) }),
      },
    );
    manager.stopCleanupTimer();
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => callInFlight,
      async (sessionId, reason) => {
        reaped.push(reason);
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    const session = await createOnPixelA(SESSION);
    if (restoreMs > 0) {
      manager.setClock(session, {
        initialAutomaticTime: 1,
        clockChangedByUs: true,
        rootedByUs: true,
      });
    }
    expect(await manager.claimLivenessOwnership(SESSION, OWNER)).toBe("claimed");
    manager.recordHeartbeat(SESSION);
    monitor.start();
  }

  /** The owner dies under an in-flight call, then the device restarts and cuts that call. */
  async function ownerLapsesThenDeviceRestarts(): Promise<{
    recorded: string | undefined;
    reaped: string[];
    resumed: "issued-again" | "terminal";
    settledBeforeNextScan: boolean;
  }> {
    let settledBeforeNextScan = false;
    callInFlight = true;
    await timer.advanceTimeAsync(NO_HEARTBEAT_RELEASE_BUDGET_MS + 1, () => drainMicrotasks(20));
    expect(reaped).toEqual([]);

    const release = manager.releaseSession(SESSION, HANDOFF);
    callInFlight = false;
    // Everything the release can do without the device answering happens before any scan.
    await drainMicrotasks(200);
    settledBeforeNextScan = manager.getSession(SESSION) === null;
    await timer.advanceTimeAsync(2 * SCAN_MS, () => drainMicrotasks(50));
    expect(await release).toBe(DEVICE);

    // Thirty seconds later something names the UUID again.
    await timer.advanceTimeAsync(30_000, () => drainMicrotasks(20));
    const resumed = await manager
      .getOrCreateSession(
        SESSION,
        {
          assignDeviceToSession: async (id: string) => (await createOnPixelA(id)).assignedDevice,
        },
        "android",
        undefined,
        true,
      )
      .then(
        () => "issued-again" as const,
        (error: unknown) => {
          if (error instanceof TerminalSessionError) {
            return "terminal" as const;
          }
          throw error;
        },
      );
    return {
      recorded: (await manager.getReleasedSessionReason(SESSION)) ?? undefined,
      reaped: [...reaped],
      resumed,
      settledBeforeNextScan,
    };
  }

  beforeEach(() => {
    expect(isRecoverableDaemonReleaseReason(HANDOFF)).toBe(true);
    expect(isTerminalReleaseReason(HANDOFF)).toBe(false);
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  test("control: with a teardown still running at the next scan the session ends as heartbeat-timeout", async () => {
    await start(SCAN_MS + 500);

    expect(await ownerLapsesThenDeviceRestarts()).toEqual({
      recorded: "heartbeat-timeout",
      reaped: ["heartbeat-timeout"],
      resumed: "terminal",
      settledBeforeNextScan: false,
    });
  });

  test("with a teardown that finishes before the next scan it ends the same way", async () => {
    await start(0);

    const outcome = await ownerLapsesThenDeviceRestarts();

    expect(outcome).toMatchObject({
      settledBeforeNextScan: true,
      recorded: "heartbeat-timeout",
      resumed: "terminal",
    });
  });
});
