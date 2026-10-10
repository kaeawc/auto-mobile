import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import {
  hasActiveSessionExecution,
  sessionExecutionProbe,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { executionTracker } from "../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
} from "./helpers/inputSocketHarness";

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

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.responses.push(JSON.parse(data) as DaemonResponse);
    callback?.();
    return true;
  }
  end(): this {
    return this.destroy();
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }
  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  liftStrokesHeldBy(releasedSessionId: string): Promise<void>;
}

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
  let internals: Internals;
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
    await Promise.all([...internals.activeRequestHandlers]);
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

  beforeEach(async () => {
    strokes = [];
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    executionTracker.setSessionClockOffsetProvider(() => sessionManager.sessionNow() - Date.now());
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);
    await claimingHeartbeat();

    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const stroke =
      (kind: string) => async (_id: string, _x: number, _y: number, last?: unknown) => {
        strokes.push(kind === "end" && last === true ? "cancel" : kind);
        return { success: true };
      };
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestGestureStart: stroke("start"),
          requestGestureMove: stroke("move"),
          requestGestureEnd: stroke("end"),
        }) as unknown as AndroidCtrlProxyClient,
    );
    const fakePool = createFakeDaemonState().getDevicePool();
    const server = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      {
        isInitialized: () => true,
        getSessionManager: () => sessionManager,
        getDevicePool: () => fakePool,
      } as unknown as DaemonStateAccess,
      new FakeTimer(),
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    socket = new FakeSocket();
    internals.handleConnection(socket as unknown as Socket);

    // The daemon's heartbeat monitor, wired as in `socketServerInputSuspectSession.test.ts`.
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      sessionExecutionProbe(executionTracker, sessionManager, pool, { excludeReads: true }),
      async (sessionId, reason) => {
        sessionManager.cancelExecutionsCutByRelease(sessionId, reason);
        await sessionManager.releaseSession(sessionId, reason, true);
      },
      timer,
    );
    monitor.start();
  });

  afterEach(async () => {
    await monitor?.stop();
    monitor = undefined;
    // Closing the socket lifts whatever stroke it still owns; let that reach the fake device
    // before the device client is restored.
    socket.destroy();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    unsubscribeActivity();
    executionTracker.setSessionClockOffsetProvider(() => 0);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    sessionManager.stopCleanupTimer();
  });

  test("releasing the holder lifts its open stroke before the device has a new owner", async () => {
    // The server's session-release subscription, which `start()` wires to the broadcaster.
    sessionManager.onSessionRelease((sessionId) => void internals.liftStrokesHeldBy(sessionId));

    await reapHolderWithStrokeOpen();
    await settle();

    expect(strokes).toEqual(["start", "cancel"]);

    // The pane's next frame is refused by the new owner's gate and lifts nothing a second time.
    await sessionManager.createSession(NEXT_SESSION, DEVICE, "android", IDLE_MS);
    expect(await sendGesture("Move")).toMatchObject({
      success: false,
      code: "device_owned_by_other_session",
    });
    socket.destroy();
    await settle();
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("a gestureMove refused because the reaped holder's device has a new owner lifts the stroke", async () => {
    await reapHolderWithStrokeOpen();
    await sessionManager.createSession(NEXT_SESSION, DEVICE, "android", IDLE_MS);

    const response = await sendGesture("Move");

    // The pane's frame is refused: the device belongs to another session now.
    expect(response).toMatchObject({ success: false, code: "device_owned_by_other_session" });
    // The move never reached the device, and the pointer the start put down must not be left
    // down on the new owner's device.
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("a gestureEnd refused the same way does not leave the pointer down either", async () => {
    await reapHolderWithStrokeOpen();
    await sessionManager.createSession(NEXT_SESSION, DEVICE, "android", IDLE_MS);

    const response = await sendGesture("End");

    expect(response).toMatchObject({ success: false, code: "device_owned_by_other_session" });
    expect(strokes).toEqual(["start", "cancel"]);
  });
});
