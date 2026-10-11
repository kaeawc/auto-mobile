import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { DaemonStateAccess } from "../../../src/daemon/daemonRequestHandlers";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { withAndroidTransportId } from "../../../src/utils/androidSerial";
import { createExecResult } from "../../../src/utils/execResult";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

/**
 * Hunt: one handset reachable over USB and wireless debugging is ONE pooled device (#10201): the
 * pool folds both `adb devices` rows into a canonical id and a session holds that id. The MCP and
 * resource paths map discovery through the fold before they pick a target
 * (`resourceDeviceResolver.ts`, `mapAndroidDiscovery`). The direct frames do not:
 * `discoverInputTargetDevices` and `listBootedDevicesForIdeAction` match the frame's `deviceId`
 * against the RAW discovery rows, and every gate after that (`getSessionForDevice`, the holder
 * check, session admission, the per-device key, the in-flight tracker) is keyed on that raw id.
 *
 * So a frame that names the held handset by its other transport id finds no holder: a sessionless
 * `input/tap` or `ide/setKeyValue` is admitted as input on an unowned device and reaches the
 * handset the session holds.
 *
 * Real DevicePool (with its transport-alias fold), real SessionManager and socket server on a
 * FakeTimer; only adb and the device client are fakes.
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

const HOLDER = "holder-session";
const usb = "R5CT1234ABC";
const wireless = "adb-R5CT1234ABC-AbCdEf._adb-tls-connect._tcp";
const booted = (deviceId: string): BootedDevice =>
  withAndroidTransportId({ deviceId, name: deviceId, platform: "android" }, deviceId);

const HELD_BY_OTHER = { success: false, code: "device_owned_by_other_session" };

describe("a direct frame naming a held handset by its other transport id", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let socket: FakeSocket;
  let internals: Internals;
  /** The serials the fake device client was built for and driven on. */
  let driven: string[];

  async function send(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<DaemonResponse | undefined> {
    socket.send({ id, type: "mcp_request", method, params });
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  const tap = (id: string, deviceId: string, extra: Record<string, unknown> = {}) =>
    send(id, "input/tap", { platform: "android", deviceId, x: 1, y: 2, ...extra });

  const setKeyValue = (id: string, deviceId: string) =>
    send(id, "ide/setKeyValue", {
      platform: "android",
      deviceId,
      appId: "com.example",
      fileName: "prefs",
      key: "k",
      value: "v",
      type: "STRING",
    });

  beforeEach(async () => {
    driven = [];
    timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [booted(usb), booted(wireless)]);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("getprop ro.serialno", createExecResult(usb, ""));
    adb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
    adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("0", ""));
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "alias-frame-daemon", {
        timer,
        deviceManager: manager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        androidAdbFactory: new FakeAdbClientFactory(adb),
      }),
    );
    await pool.refreshDevices();
    // One handset, two transports: pooled once, under the USB serial.
    expect(pool.getAllDevices().map((device) => device.id)).toEqual([usb]);
    expect(pool.getAndroidTransportAliases(usb)).toEqual([wireless]);
    expect(await pool.assignDeviceToSession(HOLDER, "android")).toBe(usb);
    await sessionManager.createSession(HOLDER, usb, "android", 60_000);
    expect(sessionManager.getSessionForDevice(usb)).toBe(HOLDER);

    // The direct frames discover through the process device manager: the raw `adb devices` rows.
    PlatformDeviceManagerFactory.setInstance(manager);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      (device) =>
        ({
          getScreenScaleMetadata: () => null,
          requestTapCoordinates: async () => {
            driven.push(`tap:${device.deviceId}`);
            return { success: true };
          },
          setPreference: async () => {
            driven.push(`setPreference:${device.deviceId}`);
          },
        }) as unknown as AndroidCtrlProxyClient,
    );
    const server = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      {
        isInitialized: () => true,
        getSessionManager: () => sessionManager,
        getDevicePool: () => pool,
      } as unknown as DaemonStateAccess,
      timer,
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
    timer.reset();
  });

  test("control: a sessionless input/tap naming the canonical id is refused for the holder", async () => {
    const response = await tap("canonical", usb);

    expect(driven).toEqual([]);
    expect(response).toMatchObject(HELD_BY_OTHER);
  });

  test("control: the holder's own input/tap on the canonical id is sent", async () => {
    const response = await tap("holder", usb, { sessionUuid: HOLDER });

    expect(response).toMatchObject({ success: true });
    expect(driven).toEqual([`tap:${usb}`]);
  });

  test("a sessionless input/tap naming the wireless alias never reaches the held handset", async () => {
    const response = await tap("alias", wireless);

    expect(driven).toEqual([]);
    expect(response).toMatchObject({ success: false });
  });

  test("a sessionless ide/setKeyValue naming the wireless alias writes nothing to the held handset", async () => {
    const response = await setKeyValue("alias-kv", wireless);

    expect(driven).toEqual([]);
    expect(response).toMatchObject({ success: false });
  });
});
