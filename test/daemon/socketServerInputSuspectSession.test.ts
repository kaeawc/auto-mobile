import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import {
  hasActiveSessionExecution,
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
 * #11417: direct `input/*` on a held device is a control call on the holder's session, so it goes
 * through the admission every MCP control call goes through. Real SessionManager and heartbeat
 * handler on a FakeTimer; the socket server, its `runTrackedDeviceInput` funnel and the execution
 * tracker are the real ones, wired to the session manager as `daemon.ts` wires them; only the
 * device client is a fake.
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
}

const SESSION = "suspect-input-session";
const OWNER_TOKEN = "harness-a";
const DEVICE = androidDevice.deviceId;
const LEASE_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;
const IDLE_MS = 60_000;

const SUSPECT_REFUSAL = {
  success: false,
  code: "daemon_session_suspect",
  retryable: true,
  details: { sessionUuid: SESSION },
};

function terminalRefusal(reason: string) {
  return {
    success: false,
    code: "session_ownership_lost",
    retryable: false,
    nextAction: "acquire_new_session",
    details: { sessionUuid: SESSION, reason },
  };
}

describe("input/* is a control call on the holder's session (#11417)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let internals: Internals;
  let taps: number;
  /** Device-side gesture frames, in the order the fake device received them. */
  let strokes: string[];
  /** When set, a tap parks on the device until it settles. */
  let tapOnDevice: PromiseWithResolvers<{ success: boolean }> | undefined;
  let tapEntered: PromiseWithResolvers<void>;
  let unsubscribeActivity: () => void;

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

  async function heartbeat(claim = false): Promise<void> {
    const response = await handleDaemonRequest(
      {
        id: "hb",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: SESSION,
          livenessOwnerToken: OWNER_TOKEN,
          ...(claim ? { claimLivenessOwnership: true } : {}),
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

  async function send(
    id: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<DaemonResponse | undefined> {
    socket.send({
      id,
      type: "mcp_request",
      method,
      params: {
        platform: "android",
        deviceId: DEVICE,
        x: 1,
        y: 2,
        sessionUuid: SESSION,
        ...params,
      },
    });
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  const sendTap = (id = "tap") => send(id, "input/tap");
  const sendGesture = (kind: "Start" | "Move" | "End") =>
    send(`gesture-${kind}`, `input/gesture${kind}`, { gestureId: "drag-1" });

  beforeEach(async () => {
    taps = 0;
    strokes = [];
    tapOnDevice = undefined;
    tapEntered = Promise.withResolvers<void>();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    // The tracker judges on the session clock and reports in-flight calls, as in `daemon.ts`.
    const pool = { isSessionRecoveryInFlight: () => false, sessionExecutionsEnded: () => {} };
    executionTracker.setSessionClockOffsetProvider(() => sessionManager.sessionNow() - Date.now());
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);
    await heartbeat(true);

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
          requestTapCoordinates: async () => {
            taps++;
            tapEntered.resolve();
            return (await tapOnDevice?.promise) ?? { success: true };
          },
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
  });

  afterEach(() => {
    unsubscribeActivity();
    executionTracker.setSessionClockOffsetProvider(() => 0);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    socket.destroy();
    sessionManager.stopCleanupTimer();
  });

  test("a tap inside the suspect window is refused, retryable, and restores nothing", async () => {
    timer.advanceTime(LEASE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    const before = { ...sessionManager.getSession(SESSION) };

    const response = await sendTap();

    expect(taps).toBe(0);
    expect(response).toMatchObject(SUSPECT_REFUSAL);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    expect(sessionManager.getSession(SESSION)).toMatchObject({
      lastUsedAt: before.lastUsedAt,
      expiresAt: before.expiresAt,
      lastHeartbeat: before.lastHeartbeat,
    });
  });

  test("a tap after the lease and grace lapsed, before the scan, releases the session and is terminal", async () => {
    timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");

    const response = await sendTap();

    // The input's own execution is not "a call in flight": the refusal is terminal, not suspect.
    expect(taps).toBe(0);
    expect(response).toMatchObject(terminalRefusal("heartbeat-timeout"));
    expect(sessionManager.getSession(SESSION)).toBeNull();
    expect(sessionManager.getSessionForDevice(DEVICE)).toBeNull();
  });

  test("a tap on a session past its idle deadline is refused terminally", async () => {
    // The owner keeps heartbeating (a live proxy with an idle agent): only the idle window ran out.
    for (let elapsed = 0; elapsed < IDLE_MS; elapsed += 1_000) {
      timer.advanceTime(1_000);
      await heartbeat();
    }
    timer.advanceTime(1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");

    const response = await sendTap();

    expect(taps).toBe(0);
    expect(response).toMatchObject(terminalRefusal("lazy-expiry"));
  });

  test("an admitted tap restarts the idle window but never renews the owner lease", async () => {
    timer.advanceTime(LEASE_MS - 1);
    const idleDeadline = sessionManager.getSession(SESSION)?.expiresAt ?? 0;

    expect(await sendTap()).toMatchObject({ success: true });

    expect(taps).toBe(1);
    expect(sessionManager.getSession(SESSION)?.expiresAt).toBe(idleDeadline + LEASE_MS - 1);
    // The pane's tap is not the owner's heartbeat: the lease still runs out on schedule.
    timer.advanceTime(2);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    expect(await sendTap("tap-2")).toMatchObject(SUSPECT_REFUSAL);
    expect(taps).toBe(1);
  });

  test("a tap still on the device keeps the session; a second tap after the lapse is refused", async () => {
    tapOnDevice = Promise.withResolvers<{ success: boolean }>();
    socket.send({
      id: "tap",
      type: "mcp_request",
      method: "input/tap",
      params: { platform: "android", deviceId: DEVICE, x: 1, y: 2, sessionUuid: SESSION },
    });
    await tapEntered.promise;
    timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);

    // A second pane: a connection answers its own frames in order.
    const second = new FakeSocket();
    internals.handleConnection(second as unknown as Socket);
    second.send({
      id: "tap-2",
      type: "mcp_request",
      method: "input/tap",
      params: { platform: "android", deviceId: DEVICE, x: 1, y: 2, sessionUuid: SESSION },
    });
    await settle();
    const refused = second.responses.find((frame) => frame.id === "tap-2");
    const heldDuringCall = sessionManager.getSession(SESSION);
    tapOnDevice.resolve({ success: true });
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    second.destroy();

    // Never released under an in-flight control call: the newcomer gets the retryable refusal.
    expect(refused).toMatchObject(SUSPECT_REFUSAL);
    expect(heldDuringCall).not.toBeNull();
    expect(socket.responses.find((frame) => frame.id === "tap")).toMatchObject({ success: true });
    expect(taps).toBe(1);
  });

  test("a new gesture is refused on a suspect session and opens no stroke", async () => {
    timer.advanceTime(LEASE_MS + 1);

    expect(await sendGesture("Start")).toMatchObject(SUSPECT_REFUSAL);

    expect(strokes).toEqual([]);
  });

  test("a gestureMove refused in the suspect window lifts the admitted stroke", async () => {
    expect(await sendGesture("Start")).toMatchObject({ success: true });
    timer.advanceTime(LEASE_MS + 1);

    expect(await sendGesture("Move")).toMatchObject(SUSPECT_REFUSAL);

    // The move never reached the device; the pointer the start put down was lifted in place.
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("a gestureEnd after the lease lapsed is terminal and lifts the stroke without a drop", async () => {
    expect(await sendGesture("Start")).toMatchObject({ success: true });
    expect(await sendGesture("Move")).toMatchObject({ success: true });
    timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);

    expect(await sendGesture("End")).toMatchObject(terminalRefusal("heartbeat-timeout"));

    expect(strokes).toEqual(["start", "move", "cancel"]);
    expect(sessionManager.getSession(SESSION)).toBeNull();
  });
});
