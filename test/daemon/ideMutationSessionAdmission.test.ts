import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { androidDevice, createFakeDaemonState } from "./helpers/inputSocketHarness";

/**
 * A mutating `ide/*` frame on a held device is a control call on the holder's session, like
 * `input/*` (#11417) and an MCP control tool call (#11486). `assertIdeMutationOwnership` runs the
 * session admission (`admitIssuedSessionForAutomation`) after comparing the frame's `sessionUuid`
 * with the device's holder, so a suspect, lapsed or idle-expired session writes nothing to the
 * device. Real SessionManager and heartbeat handler on a FakeTimer; the socket server is the real
 * one; only the device client is a fake.
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

const SESSION = "ide-mutation-session";
const OWNER_TOKEN = "harness-a";
const DEVICE = androidDevice.deviceId;
const LEASE_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;

describe("mutating ide/* frames against a session that may not take a control call", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let internals: Internals;
  let writes: string[];

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
    method: string,
    params: Record<string, unknown>,
  ): Promise<DaemonResponse | undefined> {
    socket.send({ id: "frame", type: "mcp_request", method, params });
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === "frame");
  }

  const setKeyValue = () =>
    send("ide/setKeyValue", {
      platform: "android",
      deviceId: DEVICE,
      appId: "com.example",
      fileName: "prefs",
      key: "k",
      value: "v",
      type: "STRING",
      sessionUuid: SESSION,
    });

  async function setUp(): Promise<void> {
    writes = [];
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, DEVICE, "android", { timeoutMs: 60_000 });
    await heartbeat(true);

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
          setPreference: async (...args: Parameters<AndroidCtrlProxyClient["setPreference"]>) => {
            if (typeof args[5] === "object") {
              args[5].onDispatch?.();
            }
            writes.push("setPreference");
          },
          removePreference: async (
            ...args: Parameters<AndroidCtrlProxyClient["removePreference"]>
          ) => {
            if (typeof args[3] === "object") {
              args[3].onDispatch?.();
            }
            writes.push("removePreference");
          },
          clearPreferenceStore: async (
            ...args: Parameters<AndroidCtrlProxyClient["clearPreferenceStore"]>
          ) => {
            if (typeof args[2] === "object") {
              args[2].onDispatch?.();
            }
            writes.push("clearPreferenceStore");
          },
        }) as unknown as AndroidCtrlProxyClient,
    );
    spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation(
      () =>
        ({
          ensureCompatibleVersion: async () => {
            writes.push("ensureCompatibleVersion");
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
      // The storage tools are enabled, so the frame reaches the ownership gate.
      { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    socket = new FakeSocket();
    internals.handleConnection(socket as unknown as Socket);
  }

  function tearDown(): void {
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    socket.destroy();
    sessionManager.stopCleanupTimer();
  }

  // CI's per-test time excludes only beforeAll: pay the first pass through the ide/* request
  // path (JIT, lazy module state) here, once, rather than inside the first timed test.
  beforeAll(async () => {
    await setUp();
    try {
      await setKeyValue();
      timer.advanceTime(LEASE_MS + 1);
      await setKeyValue();
    } finally {
      tearDown();
    }
  });

  beforeEach(setUp);
  afterEach(tearDown);

  test("control: a live holder's ide/setKeyValue is written", async () => {
    const response = await setKeyValue();

    expect(response).toMatchObject({ success: true });
    expect(writes).toEqual(["setPreference"]);
  });

  test("ide/setKeyValue inside the suspect window is refused daemon_session_suspect", async () => {
    timer.advanceTime(LEASE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");

    const response = await setKeyValue();

    // input/tap and an MCP setKeyValue tool call are refused here (SessionSuspectError).
    expect(writes).toEqual([]);
    expect(response).toMatchObject({ success: false, code: "daemon_session_suspect" });
  });

  test("ide/removeKeyValue after lease and grace lapsed is answered session_ownership_lost", async () => {
    timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");

    const response = await send("ide/removeKeyValue", {
      platform: "android",
      deviceId: DEVICE,
      appId: "com.example",
      fileName: "prefs",
      key: "k",
      sessionUuid: SESSION,
    });

    // A control call on a lapsed session releases it and answers the terminal refusal (#11285).
    expect(writes).toEqual([]);
    expect(response).toMatchObject({ success: false, code: "session_ownership_lost" });
  });

  test("ide/clearKeyValueFile on a session past its idle deadline is refused", async () => {
    // The owner keeps heartbeating (a live proxy with an idle agent): only the idle window ran out.
    for (let elapsed = 0; elapsed < 59_000; elapsed += 1_000) {
      timer.advanceTime(1_000);
      await heartbeat();
    }
    timer.advanceTime(1_500);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);

    const response = await send("ide/clearKeyValueFile", {
      platform: "android",
      deviceId: DEVICE,
      appId: "com.example",
      fileName: "prefs",
      sessionUuid: SESSION,
    });

    expect(writes).toEqual([]);
    expect(response).toMatchObject({ success: false, code: "session_ownership_lost" });
  });

  test("ide/updateService from a suspect holder never reaches the service manager", async () => {
    timer.advanceTime(LEASE_MS + 1);

    const response = await send("ide/updateService", {
      platform: "android",
      deviceId: DEVICE,
      sessionUuid: SESSION,
    });

    expect(writes).toEqual([]);
    expect(response).toMatchObject({ success: false, code: "daemon_session_suspect" });
  });

  test("a forced ide/updateService overrides the holder and is not judged against its session", async () => {
    timer.advanceTime(LEASE_MS + 1);

    const response = await send("ide/updateService", {
      platform: "android",
      deviceId: DEVICE,
      force: true,
    });

    expect(response).toMatchObject({ success: true });
    expect(writes).toEqual(["ensureCompatibleVersion"]);
    // Non-owner control changes nothing on the holder's session.
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
  });
});
