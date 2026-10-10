import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
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

const SESSION_KINDS = ["owned-with-token", "awaiting-owner", "tokenless", "cli-idle"] as const;
type SessionKind = (typeof SESSION_KINDS)[number];

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
  let monitor: SessionHeartbeatMonitor | undefined;
  /** Whether `beforeEach` creates the owned, heartbeating session most cases start from. */
  let startOwned = true;
  const pool = { isSessionRecoveryInFlight: () => false, sessionExecutionsEnded: () => {} };

  /** The session in one of the states the heartbeat monitor judges differently. */
  async function createSession(kind: SessionKind): Promise<void> {
    await sessionManager.createSession(
      SESSION,
      DEVICE,
      "android",
      IDLE_MS,
      undefined,
      undefined,
      undefined,
      kind === "awaiting-owner" ? "awaiting-owner" : "owned",
    );
    if (kind === "owned-with-token") {
      await heartbeat(true);
    } else if (kind === "cli-idle") {
      expect(sessionManager.adoptCliLivenessPolicy(SESSION)).toBe(true);
    }
  }

  /** The daemon's heartbeat monitor: control calls veto a reap, which cuts what is in flight. */
  function startMonitor(): void {
    sessionManager.startRehydratedOwnerWindows();
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      sessionExecutionProbe(executionTracker, sessionManager, pool, { excludeReads: true }),
      async (sessionId, reason) => {
        await executionTracker.cancelSessionUuidExecutions(
          sessionId,
          new SessionReleasedDuringCallError(sessionId, reason),
        );
        await sessionManager.releaseSession(sessionId, reason, true);
      },
      timer,
    );
    monitor.start();
  }

  const releaseReason = () => sessionManager.getTerminalReleaseSnapshot(SESSION)?.releaseReason;
  const clocks = () => {
    const session = sessionManager.getSession(SESSION);
    return {
      ownership: session?.ownership,
      awaitingOwnerSince: session?.awaitingOwnerSince,
      lastHeartbeat: session?.lastHeartbeat,
      lastOwnerHeartbeat: session?.lastOwnerHeartbeat,
      lastUsedAt: session?.lastUsedAt,
      expiresAt: session?.expiresAt,
    };
  };

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
    executionTracker.setSessionClockOffsetProvider(() => sessionManager.sessionNow() - Date.now());
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);
    if (startOwned) {
      await createSession("owned-with-token");
    }

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

  afterEach(async () => {
    await monitor?.stop();
    monitor = undefined;
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

  // The pane is not the session's owner: admission changes nothing the heartbeat monitor reads.
  describe("input never stands in for the owner", () => {
    beforeAll(() => {
      startOwned = false;
    });
    afterAll(() => {
      startOwned = true;
    });

    /** One tap every 2 s, 1 s off the monitor's scan, until `untilMs`; the frames answered. */
    async function tapEvery2s(untilMs: number): Promise<(DaemonResponse | undefined)[]> {
      const answers: (DaemonResponse | undefined)[] = [];
      await timer.advanceTimeAsync(1_000);
      for (let at = 1_000; at <= untilMs; at += 2_000) {
        answers.push(await sendTap(`tap-${at}`));
        await timer.advanceTimeAsync(2_000);
        await settle();
      }
      return answers;
    }

    test.each(SESSION_KINDS)(
      "admitting a tap on a %s session stamps nothing; its end is tool use",
      async (kind) => {
        await createSession(kind);
        timer.advanceTime(1_000);
        const before = clocks();
        tapOnDevice = Promise.withResolvers<{ success: boolean }>();
        socket.send({
          id: "tap",
          type: "mcp_request",
          method: "input/tap",
          params: { platform: "android", deviceId: DEVICE, x: 1, y: 2, sessionUuid: SESSION },
        });
        await tapEntered.promise;
        timer.advanceTime(500);

        // Admitted and on the device: nothing on the session moved.
        expect(clocks()).toEqual(before);

        tapOnDevice.resolve({ success: true });
        await settle();
        await Promise.all([...internals.activeRequestHandlers]);
        expect(socket.responses.find((frame) => frame.id === "tap")).toMatchObject({
          success: true,
        });
        // The end restarts the idle window, as it did before admission existed; who owns the
        // session, and when its owner was last heard, are untouched.
        expect(clocks()).toEqual({
          ...before,
          lastUsedAt: 1_500,
          expiresAt: 1_500 + (sessionManager.getSession(SESSION)?.sessionTimeoutMs ?? 0),
          lastHeartbeat: 1_500,
        });
      },
    );

    test("a pane tapping a rehydrated session does not keep it past the owner-reconnect window", async () => {
      await createSession("awaiting-owner");
      startMonitor();

      const answers = await tapEvery2s(9_000);

      // Taps are admitted while the session waits; the owner never returned, so the scan at
      // 10 s (lease + grace + sweep) ends it, exactly as with no pane at all.
      expect(answers.slice(0, 4)).toEqual(
        Array(4).fill(expect.objectContaining({ success: true })),
      );
      expect(sessionManager.getSession(SESSION)).toBeNull();
      expect(releaseReason()).toBe("rehydration-owner-timeout");
      expect(sessionManager.sessionNow()).toBeLessThanOrEqual(11_000);
    });

    test("one tap at restart leaves the returning owner its whole reconnect window", async () => {
      await createSession("awaiting-owner");
      startMonitor();
      expect(await sendTap()).toMatchObject({ success: true });
      expect(clocks()).toMatchObject({ ownership: "awaiting-owner", awaitingOwnerSince: 0 });

      await timer.advanceTimeAsync(LEASE_MS + SUSPECT_GRACE_MS - 1);
      await settle();
      await heartbeat(true);
      await timer.advanceTimeAsync(2_000);

      expect(clocks()).toMatchObject({ ownership: "owned", awaitingOwnerSince: undefined });
      expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    });

    test("a pane tapping an owned session whose owner went quiet does not keep it alive", async () => {
      await createSession("owned-with-token");
      startMonitor();

      const answers = await tapEvery2s(9_000);

      // Lease 4 s, grace 4 s: admitted, admitted, suspect, suspect, then gone within 10 s.
      expect(answers).toMatchObject([
        { success: true },
        { success: true },
        SUSPECT_REFUSAL,
        SUSPECT_REFUSAL,
        terminalRefusal("heartbeat-timeout"),
      ]);
      expect(taps).toBe(2);
      expect(sessionManager.getSession(SESSION)).toBeNull();
    });

    test("a session no proxy owns is kept by tool use, input included, as before", async () => {
      await createSession("tokenless");
      startMonitor();

      const answers = await tapEvery2s(19_000);

      expect(answers).toEqual(Array(10).fill(expect.objectContaining({ success: true })));
      expect(sessionManager.getSession(SESSION)).not.toBeNull();
      // Once the taps stop, the pre-first-heartbeat grace runs out.
      await timer.advanceTimeAsync(8_000);
      await settle();
      expect(sessionManager.getSession(SESSION)).toBeNull();
      expect(releaseReason()).toBe("missing-first-heartbeat");
    });
  });
});
