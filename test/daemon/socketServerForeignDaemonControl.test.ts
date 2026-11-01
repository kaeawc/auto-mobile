import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
} from "../../src/models/deviceAcquisitionRefusals";
import type { DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { spyOnAndroidClientInstance } from "../helpers/androidCtrlProxyClientSpies";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
  createFakeSession,
} from "./helpers/inputSocketHarness";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { NonThrowingFakeSocket as FakeSocket } from "../fakes/FakeNetServer";

/**
 * #11349: `input/*` and mutating `ide/*` frames are control. On a device no session of this daemon
 * holds, they are refused with the typed `device_owned_by_other_daemon` while another daemon
 * claims it, before anything reaches the device.
 */

const FOREIGN_PID = 4242;
const LOCAL_SESSION = "local-session";

let internals: UnixSocketServerHarness;
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
  internals = createHarnessServer(
    "unused",
    state,
    new FakeTimer(),
    null,
    // The storage tool is enabled, so the frame reaches the ownership gate.
    { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
  );
  internals.allowRequests();
}

function connect(): FakeSocket {
  const socket = new FakeSocket();
  sockets.push(socket);
  internals.connect(socket);
  return socket;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all([...internals.state.activeRequestHandlers]);
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
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
  spyOnAndroidClientInstance(androidDevice, {
    getScreenScaleMetadata: () => null,
    requestTapCoordinates: async (...args) => {
      args[0].onDispatch?.();
      deviceCalls.push("tap");
      return { success: true, totalTimeMs: 0 };
    },
    setPreference: async (...args) => {
      if (typeof args[3] === "object") {
        args[3].onDispatch?.();
      }
      deviceCalls.push("setPreference");
    },
  });
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
