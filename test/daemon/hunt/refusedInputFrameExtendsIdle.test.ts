import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { executionTracker } from "../../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
} from "../helpers/inputSocketHarness";

/**
 * Hunt: a control frame counts as use of the holder's session only when it actually runs
 * (#10698, #10824; the MCP twin of this is #11558 item 2). `runTrackedDeviceInput` marks the
 * execution session-admitted right after the session admission, BEFORE the frame parks on the
 * device key and before its own pre-dispatch refusals, such as a stale `frameContext`
 * (`requireCurrentFrameContext`). Such a frame is refused with nothing sent to
 * the device, yet its end is reported as admitted tool use and restarts the 2-minute idle window.
 * A pane that keeps sending input for a frame it no longer has holds the device indefinitely.
 *
 * Real SessionManager, execution tracker and socket server on a FakeTimer, wired as `daemon.ts`
 * wires them; only the device client is a fake.
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

const SESSION = "idle-input-session";
const OWNER_TOKEN = "harness-a";
const DEVICE = androidDevice.deviceId;
const IDLE_MS = 120_000;

describe("a holder's input/* frame refused before it reaches the device", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let internals: Internals;
  let sent: string[];
  let unsubscribeActivity: () => void;
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

  async function send(
    id: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<DaemonResponse | undefined> {
    socket.send({
      id,
      type: "mcp_request",
      method,
      params: { platform: "android", deviceId: DEVICE, sessionUuid: SESSION, ...params },
    });
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  const idleClock = () => {
    const session = sessionManager.getSession(SESSION);
    return { lastUsedAt: session?.lastUsedAt, expiresAt: session?.expiresAt };
  };

  beforeEach(async () => {
    sent = [];
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    // The tracker judges on the session clock and reports call ends, as in `daemon.ts`.
    executionTracker.setSessionClockOffsetProvider(() => sessionManager.sessionNow() - Date.now());
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);
    await heartbeat(true);

    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestTapCoordinates: async () => {
            sent.push("tap");
            return { success: true };
          },
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

  test("control: a tap that runs restarts the idle window", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("ran", "input/tap", { x: 1, y: 2 });

    expect(response).toMatchObject({ success: true });
    expect(sent).toEqual(["tap"]);
    expect(idleClock().lastUsedAt).toBe(before.lastUsedAt! + 1_000);
  });

  test("control: a foreign session's tap is refused and leaves the idle window alone", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("foreign", "input/tap", { x: 1, y: 2, sessionUuid: "someone" });

    expect(response).toMatchObject({ success: false, code: "device_owned_by_other_session" });
    expect(idleClock()).toEqual(before);
  });

  test("a tap refused for a stale frameContext does not restart the idle window", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("stale", "input/tap", { x: 1, y: 2, frameContext: "frame-1" });

    expect(sent).toEqual([]);
    expect(response?.success).toBe(false);
    expect(response?.error).toContain("frameContext is stale or unavailable");
    expect(idleClock()).toEqual(before);
  });

  test("a key refused for a stale frameContext does not restart the idle window", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("stale-key", "input/key", {
      key: "enter",
      frameContext: "frame-1",
    });

    expect(response?.success).toBe(false);
    expect(response?.error).toContain("frameContext is stale or unavailable");
    expect(idleClock()).toEqual(before);
  });

  test("a client repeating a refused frame does not hold the device past the idle window", async () => {
    const releaseAt = idleClock().expiresAt!;
    // The owner stays alive (heartbeats); the only "use" is a frame that is refused every time.
    for (let elapsed = 0; elapsed < IDLE_MS; elapsed += 2_000) {
      timer.advanceTime(2_000);
      await heartbeat();
      const response = await send(`stale-${elapsed}`, "input/tap", {
        x: 1,
        y: 2,
        frameContext: "frame-1",
      });
      expect(response?.success).toBe(false);
    }

    expect(sent).toEqual([]);
    expect(idleClock().expiresAt).toBe(releaseAt);
  });
});
