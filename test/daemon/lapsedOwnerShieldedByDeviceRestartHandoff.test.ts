import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { sessionOwnershipLostPayload } from "../../src/daemon/deviceSessionResult";
import {
  isRecoverableDaemonReleaseReason,
  isTerminalReleaseReason,
} from "../../src/daemon/releaseReasons";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/wire/sessionLivenessWindows";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// A handoff must retain heartbeat loss already established before its start. Suspect grace
// keeps running across teardown; live owners keep the recoverable handoff (#11691).

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
  let persistence: FakeDeviceSessionPersistence;
  let announced: string[];

  function createOnPixelA(sessionId: string) {
    return manager.createSession(sessionId, DEVICE, "android", { stableDeviceId: "Pixel_A" });
  }

  /** `restoreMs` is how long the handoff release's device teardown takes. */
  async function start(restoreMs: number): Promise<void> {
    timer = new FakeTimer();
    timer.setCurrentTime(0);
    callInFlight = false;
    reaped = [];
    announced = [];
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence, {
      barrier: () => new FakeDbWriteBarrier(),
      restorers: {
        networkCondition: () => ({ restore: async () => undefined }),
        clock: () => ({ restore: () => timer.sleep(restoreMs) }),
      },
    });
    manager.stopCleanupTimer();
    manager.onSessionRelease((_session, _device, reason) => announced.push(reason));
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
    await deliverDaemonHeartbeat(manager, SESSION);
    monitor.start();
  }

  function resume() {
    return manager.getOrCreateSession(
      SESSION,
      { assignDeviceToSession: async (id: string) => (await createOnPixelA(id)).assignedDevice },
      "android",
      { requireIssuedSession: true },
    );
  }

  async function assertTerminalWires(): Promise<void> {
    const refusal: unknown = await resume().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TerminalSessionError);
    if (!(refusal instanceof TerminalSessionError)) {
      throw new Error("Expected a terminal ownership refusal");
    }
    expect(
      sessionOwnershipLostPayload({
        message: refusal.message,
        sessionUuid: refusal.sessionUuid,
        reason: refusal.release.releaseReason,
        release: refusal.release,
      }),
    ).toMatchObject({
      error: {
        code: "session_ownership_lost",
        reason: "heartbeat-timeout",
        retryable: false,
        nextAction: "acquire_new_session",
      },
    });
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        releaseDevice: async () => {},
        getStats: () => ({ total: 1, idle: 1, assigned: 0, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
      expect(
        await handleDaemonRequest(
          {
            id: method,
            type: "daemon_request",
            method,
            params: { sessionId: SESSION, livenessOwnerToken: OWNER },
          },
          state,
        ),
      ).toMatchObject({
        success: false,
        code: "daemon_session_not_found",
        releaseReason: "heartbeat-timeout",
      });
    }
    expect(await persistence.getSession!(SESSION)).toMatchObject({
      status: "expired",
      release_reason: "heartbeat-timeout",
    });
    expect(announced).toEqual(["heartbeat-timeout"]);
    expect(manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe("heartbeat-timeout");
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
        { requireIssuedSession: true },
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
    await assertTerminalWires();
  });

  test.each([0, 11_000])(
    "a live owner keeps its recoverable handoff through %d ms teardown",
    async (restoreMs) => {
      await start(restoreMs);
      const session = manager.getSession(SESSION)!;
      const heartbeat = session.lastHeartbeat;
      const release = manager.releaseSession(SESSION, HANDOFF);
      await drainMicrotasks(100);
      await timer.advanceTimeAsync(restoreMs, () => drainMicrotasks(50));
      expect(await release).toBe(DEVICE);
      expect(session.lastHeartbeat).toBe(heartbeat);
      expect(await persistence.getSession!(SESSION)).toMatchObject({ release_reason: HANDOFF });
      expect(await manager.getReleasedSessionReason(SESSION)).toBe(HANDOFF);
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
      expect(announced).toEqual([HANDOFF]);
      expect(reaped).toEqual([]);
      await timer.advanceTimeAsync(30_000, () => drainMicrotasks(20));
      expect((await resume()).assignedDevice).toBe(DEVICE);
    },
  );

  test.each([
    { restoreMs: 1_000, terminal: false },
    { restoreMs: SUSPECT_GRACE_MS, terminal: true },
  ])(
    "suspect grace runs across a $restoreMs ms handoff (terminal=$terminal)",
    async ({ restoreMs, terminal }) => {
      await start(restoreMs);
      callInFlight = true;
      await timer.advanceTimeAsync(DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + 1, () =>
        drainMicrotasks(20),
      );
      expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
      const session = manager.getSession(SESSION)!;
      const heartbeat = session.lastHeartbeat;
      const release = manager.releaseSession(SESSION, HANDOFF);
      callInFlight = false;
      await drainMicrotasks(100);
      await timer.advanceTimeAsync(restoreMs, () => drainMicrotasks(50));
      expect(await release).toBe(DEVICE);
      expect(session.lastHeartbeat).toBe(heartbeat);
      expect(reaped).toEqual([]);
      if (terminal) {
        await assertTerminalWires();
      } else {
        expect(await manager.getReleasedSessionReason(SESSION)).toBe(HANDOFF);
        expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
        expect(await persistence.getSession!(SESSION)).toMatchObject({ release_reason: HANDOFF });
        await timer.advanceTimeAsync(30_000, () => drainMicrotasks(20));
        expect((await resume()).assignedDevice).toBe(DEVICE);
      }
    },
  );

  test("plan-auto-release records terminal heartbeat loss already established at its start", async () => {
    await start(0);
    callInFlight = true;
    await timer.advanceTimeAsync(NO_HEARTBEAT_RELEASE_BUDGET_MS + 1, () => drainMicrotasks(20));
    expect(reaped).toEqual([]);
    expect(await manager.releaseSession(SESSION, "plan-auto-release")).toBe(DEVICE);
    callInFlight = false;
    await assertTerminalWires();
  });

  test.each([5_000, NO_HEARTBEAT_RELEASE_BUDGET_MS + 1])(
    "shutdown after %d ms silence stays recoverable through teardown with the monitor stopped",
    async (silenceMs) => {
      const restoreMs = 3_500;
      await start(restoreMs);
      await monitor.stop();
      await timer.advanceTimeAsync(silenceMs, () => drainMicrotasks(20));
      const release = manager.releaseSession(SESSION, "daemon-shutdown", { allowExpired: true });
      await drainMicrotasks(100);
      await timer.advanceTimeAsync(restoreMs, () => drainMicrotasks(50));
      expect(await release).toBe(DEVICE);
      expect(await manager.getReleasedSessionReason(SESSION)).toBe("daemon-shutdown");
      expect(await persistence.getSession!(SESSION)).toMatchObject({
        status: "released",
        release_reason: "daemon-shutdown",
      });
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
      expect(announced).toEqual(["daemon-shutdown"]);
      expect(reaped).toEqual([]);

      const successor = new SessionManager(timer, persistence, {
        barrier: () => new FakeDbWriteBarrier(),
      });
      successor.stopCleanupTimer();
      const summary = await successor.rehydratePersistedSessions({
        assignDeviceToSession: async (id, _platform, target) =>
          (
            await successor.createSession(id, DEVICE, "android", {
              timeoutMs: target?.liveness?.sessionTimeoutMs,
              heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
              stableDeviceId: target?.stableDeviceId,
              recoveredLiveness: target?.liveness,
              initialOwnership: target?.initialOwnership,
            })
          ).assignedDevice,
      });
      expect(summary).toEqual({
        rehydrated: [SESSION],
        terminalized: [],
        skipped: [],
        timedOut: false,
      });
      expect(successor.getSession(SESSION)?.assignedDevice).toBe(DEVICE);
      expect(await persistence.getSession!(SESSION)).toMatchObject({ status: "active" });
    },
  );
});
