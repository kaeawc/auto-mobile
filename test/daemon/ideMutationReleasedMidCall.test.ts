import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { hasActiveSessionExecution } from "../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { executionTracker } from "../../src/server/executionTracker";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { androidDevice, createFakeDaemonState } from "./helpers/inputSocketHarness";

/**
 * "A session is never released under an in-flight CONTROL call" (#11486). A mutating `ide/*` frame
 * on a held device is a control call on the holder's session, so the socket server tracks it as an
 * execution: the idle sweep sees work in flight and keeps the session (and the device) while the
 * write is still running, exactly as it does for `input/tap`. A release that lands anyway cancels
 * the tracked call, which answers the typed terminal refusal.
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
  let deviceCallSignal: AbortSignal | undefined;
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

  const setUp = async () => {
    deviceCallStarted = false;
    deviceCallSignal = undefined;
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
      deviceCallSignal = getAbortSignal();
      await blocked;
      // Device work honours the ambient signal, as the real transports do.
      deviceCallSignal?.throwIfAborted();
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
          requestTapCoordinates: (
            ...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>
          ) => {
            args[6]?.();
            return deviceCall();
          },
          setPreference: async (...args: Parameters<AndroidCtrlProxyClient["setPreference"]>) => {
            if (typeof args[5] === "object") {
              args[5].onDispatch?.();
            }
            await deviceCall();
          },
        }) as unknown as AndroidCtrlProxyClient,
    );
    spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation(
      () =>
        ({
          ensureCompatibleVersion: async () => {
            await deviceCall();
            return { status: "compatible" };
          },
        }) as unknown as AndroidCtrlProxyManager,
    );
    const fakePool = createFakeDaemonState().getDevicePool();
    const server = createTestUnixSocketServer(
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
  };

  const tearDown = async () => {
    finishDeviceCall();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    socket.destroy();
    sessionManager.stopCleanupTimer();
  };

  beforeEach(setUp);
  afterEach(tearDown);

  // beforeAll is outside the per-test budget: one full tap scenario pays the server, socket and
  // first-call cold start the first timed test would otherwise carry.
  beforeAll(async () => {
    await setUp();
    try {
      await runPastIdleDeadlineWith("input/tap", {
        platform: "android",
        deviceId: DEVICE,
        x: 1,
        y: 2,
        sessionUuid: SESSION,
      });
    } finally {
      await tearDown();
    }
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

    expect(releases).toEqual([]);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);
    expect(executionTracker.hasActiveSessionUuidExecutions(SESSION)).toBe(true);

    finishDeviceCall();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);

    expect(socket.responses.find((frame) => frame.id === "frame")).toMatchObject({ success: true });
    // The route ended its execution: nothing keeps the session past the write.
    expect(executionTracker.hasActiveSessionUuidExecutions(SESSION)).toBe(false);
  });

  test("a forced ide/updateService in flight keeps the holder's session", async () => {
    await runPastIdleDeadlineWith("ide/updateService", {
      platform: "android",
      deviceId: DEVICE,
      force: true,
    });

    expect(releases).toEqual([]);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);
  });

  test("a release of the holder neither cuts a forced ide/updateService nor names the holder to it", async () => {
    socket.send({
      id: "frame",
      type: "mcp_request",
      method: "ide/updateService",
      params: { platform: "android", deviceId: DEVICE, force: true },
    });
    await settle();
    expect(deviceCallStarted).toBe(true);

    const release = new SessionReleasedDuringCallError(SESSION, "owner-disconnected");
    await executionTracker.cancelSessionUuidExecutions(SESSION, release);
    expect(deviceCallSignal?.aborted).toBe(false);

    finishDeviceCall();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);

    expect(socket.responses.find((frame) => frame.id === "frame")).toMatchObject({ success: true });
    expect(executionTracker.hasActiveSessionUuidExecutions(SESSION)).toBe(false);
  });

  test("a release that cuts an ide/setKeyValue aborts its device work and answers session_ownership_lost", async () => {
    socket.send({
      id: "frame",
      type: "mcp_request",
      method: "ide/setKeyValue",
      params: {
        platform: "android",
        deviceId: DEVICE,
        appId: "com.example",
        fileName: "prefs",
        key: "k",
        value: "v",
        type: "STRING",
        sessionUuid: SESSION,
      },
    });
    await settle();
    expect(deviceCallStarted).toBe(true);
    expect(deviceCallSignal?.aborted).toBe(false);

    const release = new SessionReleasedDuringCallError(SESSION, "owner-disconnected");
    expect(await executionTracker.cancelSessionUuidExecutions(SESSION, release)).toBe(1);
    expect(deviceCallSignal?.aborted).toBe(true);

    finishDeviceCall();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);

    expect(socket.responses.find((frame) => frame.id === "frame")).toMatchObject({
      success: false,
      error: release.message,
      code: "session_ownership_lost",
      retryable: false,
      nextAction: "acquire_new_session",
      details: { sessionUuid: SESSION, reason: "owner-disconnected" },
    });
  });
});
