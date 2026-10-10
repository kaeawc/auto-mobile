import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeSession,
} from "./helpers/inputSocketHarness";

/**
 * #11349: `input/*` and mutating `ide/*` frames are control. On a device no session of this daemon
 * holds, they are refused with the typed `device_owned_by_other_daemon` while another daemon
 * claims it, before anything reaches the device.
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

const FOREIGN_PID = 4242;
const LOCAL_SESSION = "local-session";

let internals: Internals;
let sockets: FakeSocket[];
/** Device ids another daemon claims, as the pool's foreign-ownership view reports them. */
let foreignClaimed: Set<string>;
let claimChecks: string[];
let deviceCalls: string[];

function useServer(localSessionHoldsDevice = false): void {
  const sessions = localSessionHoldsDevice
    ? new Map([
        [LOCAL_SESSION, createFakeSession(LOCAL_SESSION, androidDevice.deviceId, "android")],
      ])
    : new Map();
  const base = createFakeDaemonState(sessions);
  const state = {
    ...base,
    getDevicePool: () => ({
      ...base.getDevicePool(),
      // The pool's contract: skipped for a device a local session holds.
      assertNotClaimedByForeignDaemon: async (deviceId: string, platform: "android" | "ios") => {
        claimChecks.push(`${platform}:${deviceId}`);
        if (!localSessionHoldsDevice && foreignClaimed.has(deviceId)) {
          throw new DeviceOwnedByOtherDaemonError(deviceId, FOREIGN_PID);
        }
      },
    }),
  };
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    state,
    new FakeTimer(),
    null,
    // The storage tool is enabled, so the frame reaches the ownership gate.
    { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
  );
  internals = server as unknown as Internals;
  internals.acceptingRequests = true;
}

function connect(): FakeSocket {
  const socket = new FakeSocket();
  sockets.push(socket);
  internals.handleConnection(socket as unknown as Socket);
  return socket;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all([...internals.activeRequestHandlers]);
}

async function answer(method: string, params: Record<string, unknown>): Promise<DaemonResponse> {
  const socket = connect();
  socket.send({ id: "frame", type: "mcp_request", method, params });
  await drain();
  const response = socket.responses.find((frame) => frame.id === "frame");
  expect(response).toBeDefined();
  return response!;
}

const tapParams = (extra: Record<string, unknown> = {}) => ({
  platform: "android",
  deviceId: androidDevice.deviceId,
  x: 1,
  y: 2,
  ...extra,
});

const setKeyValueParams = {
  platform: "android",
  deviceId: androidDevice.deviceId,
  appId: "com.example",
  fileName: "prefs",
  key: "k",
  value: "v",
  type: "STRING",
};

beforeEach(() => {
  sockets = [];
  foreignClaimed = new Set();
  claimChecks = [];
  deviceCalls = [];
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
        requestTapCoordinates: async () => {
          deviceCalls.push("tap");
          return { success: true };
        },
        setPreference: async () => {
          deviceCalls.push("setPreference");
          return { success: true };
        },
      }) as unknown as AndroidCtrlProxyClient,
  );
});

afterEach(() => {
  spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
  PlatformDeviceManagerFactory.reset();
  for (const socket of sockets) {
    socket.destroy();
  }
});

describe("socket control on a device another daemon claims (#11349)", () => {
  test("a sessionless input/tap is refused with the typed code and never reaches the device", async () => {
    foreignClaimed.add(androidDevice.deviceId);
    useServer();

    const response = await answer("input/tap", tapParams());

    expect(response).toMatchObject({
      success: false,
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      retryable: true,
    });
    expect(response.error).toContain(`PID ${FOREIGN_PID}`);
    expect(deviceCalls).toEqual([]);
  });

  test("ide/setKeyValue is refused with the typed code and never reaches the device", async () => {
    foreignClaimed.add(androidDevice.deviceId);
    useServer();

    const response = await answer("ide/setKeyValue", setKeyValueParams);

    expect(response).toMatchObject({
      success: false,
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      retryable: true,
    });
    expect(deviceCalls).toEqual([]);
  });

  test("a sessionless input/tap on a device nobody claims still runs, after the claim check", async () => {
    useServer();

    const response = await answer("input/tap", tapParams());

    expect(response).toMatchObject({ success: true });
    expect(claimChecks).toEqual([`android:${androidDevice.deviceId}`]);
    expect(deviceCalls).toEqual(["tap"]);
  });

  test("the local holder's input/tap runs on its own device", async () => {
    foreignClaimed.add(androidDevice.deviceId);
    useServer(true);

    const response = await answer("input/tap", tapParams({ sessionUuid: LOCAL_SESSION }));

    expect(response).toMatchObject({ success: true });
    expect(deviceCalls).toEqual(["tap"]);
  });
});
