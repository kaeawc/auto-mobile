import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../../src/daemon/livenessOwnerLease";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
} from "../helpers/inputSocketHarness";

/**
 * Hunt: the direct `input/*` path skips the session-admission gates every MCP control call goes
 * through (`assertSessionNotSuspect`, `refuseControlCallOnLapsedOwnerLease`). Real SessionManager
 * and heartbeat handler on a FakeTimer; the socket server, its `runTrackedDeviceInput` funnel and
 * the execution tracker are the real ones; only the device client is a fake.
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

describe("input/* against a session whose owner lease ran out", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let internals: Internals;
  let taps: number;

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

  async function sendTap(): Promise<DaemonResponse | undefined> {
    socket.send({
      id: "tap",
      type: "mcp_request",
      method: "input/tap",
      params: { platform: "android", deviceId: DEVICE, x: 1, y: 2, sessionUuid: SESSION },
    });
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === "tap");
  }

  beforeEach(async () => {
    taps = 0;
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, DEVICE, "android", 60_000);
    const claim = await handleDaemonRequest(
      {
        id: "claim",
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
    expect(claim.success).toBe(true);

    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestTapCoordinates: async () => {
            taps++;
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
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    socket.destroy();
    sessionManager.stopCleanupTimer();
  });

  test("a tap inside the suspect window is refused like an MCP control call", async () => {
    timer.advanceTime(LEASE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");

    const response = await sendTap();

    // MCP: getOrCreateSession(SESSION) rejects with SessionSuspectError here.
    expect(taps).toBe(0);
    expect(response?.success).toBe(false);
  });

  test("a tap after the lease and grace lapsed, before the scan, is answered session_ownership_lost", async () => {
    timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");

    const response = await sendTap();

    // MCP: refuseControlCallOnLapsedOwnerLease releases the session and answers the terminal
    // refusal (#11285). The input path drives the dead owner's device instead.
    expect(taps).toBe(0);
    expect(response).toMatchObject({ success: false, code: "session_ownership_lost" });
  });
  test("a tap on a session past its idle deadline is refused, not admitted", async () => {
    // The owner keeps heartbeating (a live proxy with an idle agent): only the idle window ran out.
    for (let elapsed = 0; elapsed < 60_000 + 1_000; elapsed += 1_000) {
      timer.advanceTime(1_000);
      await handleDaemonRequest(
        {
          id: "hb",
          type: "daemon_request",
          method: "daemon/heartbeat",
          params: { sessionId: SESSION, livenessOwnerToken: OWNER_TOKEN },
        },
        stateFor(),
      );
    }
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");

    const response = await sendTap();

    // MCP: getSessionForNewExecution expires the session and answers the terminal refusal.
    expect(taps).toBe(0);
    expect(response).toMatchObject({ success: false });
  });
});
