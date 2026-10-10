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
import { hasActiveSessionExecution } from "../../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { executionTracker } from "../../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidDevice, createFakeDaemonState } from "../helpers/inputSocketHarness";

/**
 * Hunt: "a session is never released under an in-flight CONTROL call". A mutating `ide/*` frame
 * from the holder is a control call on the holder's session, but the socket server never tracks it
 * as an execution, so the idle sweep sees no work in flight and releases the session (and frees
 * the device for the next acquirer) while the write is still running against the device. The same
 * shape with `input/tap` is the contrast: it is tracked, and the session is kept.
 *
 * Real SessionManager, heartbeat handler, execution tracker and socket server; the veto is wired
 * exactly as daemon.ts wires it. Only the device client is a fake.
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

const SESSION = "ide-mid-call-session";
const OWNER_TOKEN = "harness-a";
const DEVICE = androidDevice.deviceId;
const IDLE_MS = 60_000;

describe("idle release while the holder's device call is in flight", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let internals: Internals;
  let deviceCallStarted: boolean;
  let finishDeviceCall: () => void;
  let releases: string[];

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

  /** The owner keeps heartbeating; only the idle window runs out, with the frame in flight. */
  async function runPastIdleDeadlineWith(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    for (let elapsed = 0; elapsed < IDLE_MS - 1_000; elapsed += 1_000) {
      timer.advanceTime(1_000);
      await heartbeat();
    }
    socket.send({ id: "frame", type: "mcp_request", method, params });
    await settle();
    expect(deviceCallStarted).toBe(true);

    timer.advanceTime(1_500);
    sessionManager.cleanupExpiredSessions();
    await sessionManager.waitForSessionRelease(SESSION);
  }

  beforeEach(async () => {
    deviceCallStarted = false;
    releases = [];
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    // As daemon.ts wires the idle veto.
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(
        executionTracker,
        sessionManager,
        { isSessionRecoveryInFlight: () => false },
        sessionId,
        query,
      ),
    );
    sessionManager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releases.push(reason);
    });
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);
    await heartbeat(true);

    const blocked = new Promise<void>((resolve) => {
      finishDeviceCall = resolve;
    });
    const deviceCall = async () => {
      deviceCallStarted = true;
      await blocked;
      return { success: true };
    };
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: async () => [androidDevice],
      getBootedDevicesDetailed: async () => ({
        devices: [androidDevice],
        succeededPlatforms: new Set(["android", "ios"]),
      }),
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestTapCoordinates: deviceCall,
          setPreference: async () => {
            await deviceCall();
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
      null,
      { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    socket = new FakeSocket();
    internals.handleConnection(socket as unknown as Socket);
  });

  afterEach(async () => {
    finishDeviceCall();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    socket.destroy();
    sessionManager.stopCleanupTimer();
  });

  test("contrast: an input/tap in flight keeps the session", async () => {
    await runPastIdleDeadlineWith("input/tap", {
      platform: "android",
      deviceId: DEVICE,
      x: 1,
      y: 2,
      sessionUuid: SESSION,
    });

    expect(releases).toEqual([]);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);
  });

  test("an ide/setKeyValue in flight keeps the session", async () => {
    await runPastIdleDeadlineWith("ide/setKeyValue", {
      platform: "android",
      deviceId: DEVICE,
      appId: "com.example",
      fileName: "prefs",
      key: "k",
      value: "v",
      type: "STRING",
      sessionUuid: SESSION,
    });

    // The write is still running on the device, yet the session is released under it.
    expect(releases).toEqual([]);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);
  });
});
