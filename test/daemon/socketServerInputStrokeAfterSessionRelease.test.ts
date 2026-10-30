import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { releasePlanSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  hasActiveSessionExecution,
  sessionExecutionProbe,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import type { DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { executionTracker } from "../../src/daemon/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
} from "./helpers/inputSocketHarness";
import { spyOnAndroidClientInstance } from "../helpers/androidCtrlProxyClientSpies";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { NonThrowingFakeSocket as FakeSocket } from "../fakes/FakeNetServer";

/**
 * The stroke lift of #11439 meets a release that lands BETWEEN gesture frames (#11429's heartbeat
 * reap, or any other terminal release), #11448.
 *
 * Each gesture frame is its own control call, so a release with the pointer down and no frame in
 * flight cuts no call. The runner parks a continued stroke with no ceiling, so unless the daemon
 * lifts it the pointer stays down on a device that is free for, or already held by, another
 * session. Two paths lift it: the release itself lifts every stroke admitted under the released
 * session, and a later `gestureMove` / `gestureEnd` refused by the holder gate
 * (`device_owned_by_other_session`, which runs before session admission) lifts the stroke its
 * socket owns once the device has changed hands. Same harness as
 * `socketServerInputSuspectSession.test.ts`: real SessionManager, heartbeat monitor, socket
 * server and execution tracker on a FakeTimer; only the device client is a fake.
 */

const SESSION = "stroke-holder-session";
const NEXT_SESSION = "next-owner-session";
const OWNER_TOKEN = "harness-a";
const DEVICE = androidDevice.deviceId;
const LEASE_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;
const IDLE_MS = 60_000;

describe("an open input stroke vs. a release of its holder session", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let server: UnixSocketServerHarness;
  /** Device-side gesture frames, in the order the fake device received them. */
  let strokes: string[];
  let unsubscribeActivity: () => void;
  let monitor: SessionHeartbeatMonitor | undefined;
  const pool = { isSessionRecoveryInFlight: () => false, sessionExecutionsEnded: () => {} };

  function stateFor(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
        releaseDevice: async () => {},
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
  }

  async function claimingHeartbeat(): Promise<void> {
    const response = await handleDaemonRequest(
      {
        id: "hb",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: SESSION,
          livenessOwnerToken: OWNER_TOKEN,
          claimLivenessOwnership: true,
        },
      },
      stateFor(),
    );
    expect(response.success).toBe(true);
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async function sendGesture(kind: "Start" | "Move" | "End"): Promise<DaemonResponse | undefined> {
    const id = `gesture-${kind}`;
    socket.send({
      id,
      type: "mcp_request",
      method: `input/gesture${kind}`,
      params: {
        platform: "android",
        deviceId: DEVICE,
        x: 1,
        y: 2,
        sessionUuid: SESSION,
        gestureId: "drag-1",
      },
    });
    await settle();
    await Promise.all([...server.state.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  /** The owner goes quiet with the pointer down; the monitor's scan reaps the session. */
  async function reapHolderWithStrokeOpen(): Promise<void> {
    expect(await sendGesture("Start")).toMatchObject({ success: true });
    expect(strokes).toEqual(["start"]);
    await timer.advanceTimeAsync(LEASE_MS + SUSPECT_GRACE_MS + 2_000);
    await settle();
    expect(sessionManager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe(
      "heartbeat-timeout",
    );
    expect(sessionManager.getSessionForDevice(DEVICE)).toBeNull();
  }

  async function setUp(): Promise<void> {
    strokes = [];
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    executionTracker.setSessionClockOffsetProvider(
      (wallNowMs = Date.now()) => sessionManager.sessionNow() - wallNowMs,
    );
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);
    await sessionManager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
    await claimingHeartbeat();

    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const stroke = async (kind: string) => {
      strokes.push(kind);
      return { success: true, totalTimeMs: 0 };
    };
    spyOnAndroidClientInstance(androidDevice, {
      getScreenScaleMetadata: () => null,
      requestGestureStart: () => stroke("start"),
      requestGestureMove: () => stroke("move"),
      requestGestureEnd: (_id, _x, _y, { cancel } = {}) =>
        stroke(cancel === true ? "cancel" : "end"),
    });
    const serverState: DaemonStateAccess = {
      ...createFakeDaemonState(),
      getSessionManager: () => sessionManager,
    };
    server = createHarnessServer("unused", serverState, new FakeTimer());
    server.allowRequests();
    socket = new FakeSocket();
    server.connect(socket);

    // The daemon's heartbeat monitor, wired as in `socketServerInputSuspectSession.test.ts`.
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      sessionExecutionProbe(executionTracker, sessionManager, pool, { excludeReads: true }),
      async (sessionId, reason) => {
        sessionManager.cancelExecutionsCutByRelease(sessionId, reason);
        await sessionManager.releaseSession(sessionId, reason, { allowExpired: true });
      },
      timer,
    );
    monitor.start();
  }

  async function tearDown(): Promise<void> {
    await monitor?.stop();
    monitor = undefined;
    // Closing the socket lifts whatever stroke it still owns; let that reach the fake device
    // before the device client is restored.
    socket.destroy();
    await settle();
    await Promise.all([...server.state.activeRequestHandlers]);
    unsubscribeActivity();
    executionTracker.setSessionClockOffsetProvider(() => 0);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    sessionManager.stopCleanupTimer();
  }

  // CI's per-test time excludes only beforeAll: the first run through the daemon request path
  // (JIT, lazy module state) is paid here once, with the same reap-then-refuse sequence the
  // tests drive, instead of inside the first timed test.
  beforeAll(async () => {
    await setUp();
    try {
      sessionManager.onSessionRelease((sessionId) => void server.liftStrokesHeldBy(sessionId));
      await reapHolderWithStrokeOpen();
      await sessionManager.createSession(NEXT_SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
      await sendGesture("Move");
    } finally {
      await tearDown();
    }
  });

  beforeEach(setUp);
  afterEach(tearDown);

  test("releasing the holder lifts its open stroke before the device has a new owner", async () => {
    // The server's session-release subscription, which `start()` wires to the broadcaster.
    sessionManager.onSessionRelease((sessionId) => void server.liftStrokesHeldBy(sessionId));

    await reapHolderWithStrokeOpen();
    await settle();

    expect(strokes).toEqual(["start", "cancel"]);

    // The pane's next frame is refused by the new owner's gate and lifts nothing a second time.
    await sessionManager.createSession(NEXT_SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
    expect(await sendGesture("Move")).toMatchObject({
      success: false,
      code: "device_owned_by_other_session",
    });
    socket.destroy();
    await settle();
    expect(strokes).toEqual(["start", "cancel"]);
  });

  // #11490: a plan's auto-release goes through the same release notification, so the stroke of
  // #11470 is lifted exactly once, and a frame still in flight is cut before the device is freed.
  test("a plan auto-release cuts an in-flight gesture frame and lifts the open stroke once", async () => {
    sessionManager.onSessionRelease((sessionId) => void server.liftStrokesHeldBy(sessionId));
    expect(await sendGesture("Start")).toMatchObject({ success: true });
    const frame = executionTracker.startExecution("input/gestureMove", undefined, SESSION);
    executionTracker.bindDeviceExecution(frame.id, DEVICE);
    const frameAbortedWhenFreed: boolean[] = [];

    try {
      await releasePlanSessionAndDevice(
        sessionManager,
        {
          releaseDevice: async () => {
            frameAbortedWhenFreed.push(frame.abortController.signal.aborted);
          },
        },
        { sessionId: SESSION, deviceId: DEVICE },
      );
      await settle();
    } finally {
      executionTracker.endExecution(frame.id);
    }

    expect(frameAbortedWhenFreed).toEqual([true]);
    expect(strokes).toEqual(["start", "cancel"]);
    // Not terminal: the UUID is issued again by name and a new stroke starts under it.
    expect(sessionManager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
    await sessionManager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
    await claimingHeartbeat();
    expect(await sendGesture("Start")).toMatchObject({ success: true });
    socket.destroy();
    await settle();
    expect(strokes).toEqual(["start", "cancel", "start", "cancel"]);
  });

  test("a gestureMove refused because the reaped holder's device has a new owner lifts the stroke", async () => {
    await reapHolderWithStrokeOpen();
    await sessionManager.createSession(NEXT_SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });

    const response = await sendGesture("Move");

    // The pane's frame is refused: the device belongs to another session now.
    expect(response).toMatchObject({ success: false, code: "device_owned_by_other_session" });
    // The move never reached the device, and the pointer the start put down must not be left
    // down on the new owner's device.
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("a gestureEnd refused the same way does not leave the pointer down either", async () => {
    await reapHolderWithStrokeOpen();
    await sessionManager.createSession(NEXT_SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });

    const response = await sendGesture("End");

    expect(response).toMatchObject({ success: false, code: "device_owned_by_other_session" });
    expect(strokes).toEqual(["start", "cancel"]);
  });
});
