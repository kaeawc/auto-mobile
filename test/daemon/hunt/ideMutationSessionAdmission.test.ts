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
import { androidDevice, createFakeDaemonState } from "../helpers/inputSocketHarness";

/**
 * Hunt: a mutating `ide/*` frame on a held device is a control call on the holder's session, like
 * `input/*` (#11417) and an MCP control tool call. `assertIdeMutationOwnership` only compares the
 * frame's `sessionUuid` with the device's holder; it never runs the session admission
 * (`admitIssuedSessionForAutomation`), so a suspect, lapsed or idle-expired session still writes
 * to the device. Real SessionManager and heartbeat handler on a FakeTimer; the socket server is
 * the real one; only the device client is a fake.
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

  beforeEach(async () => {
    writes = [];
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, DEVICE, "android", 60_000);
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
          setPreference: async () => {
            writes.push("setPreference");
          },
          removePreference: async () => {
            writes.push("removePreference");
          },
          clearPreferenceStore: async () => {
            writes.push("clearPreferenceStore");
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
      // The storage tools are enabled, so the frame reaches the ownership gate.
      { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
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
});
