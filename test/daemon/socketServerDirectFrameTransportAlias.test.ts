import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { withAndroidTransportId } from "../../src/utils/androidSerial";
import { createExecResult } from "../../src/utils/execResult";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

/**
 * One handset reachable over USB and wireless debugging is ONE pooled device (#10201): the pool
 * folds both `adb devices` rows into a canonical id and a session holds that id. A direct frame
 * may name the handset by either id, so `input/*` and `ide/*` resolve the frame's `deviceId` and
 * discovery rows to the pool's canonical id before any holder, managed-slot or admission decision
 * (#11596). Matching the raw discovery row instead found no holder for the other transport id,
 * and a sessionless `input/tap` or `ide/setKeyValue` reached the handset a session held.
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
  let manager: FakeDeviceUtils;
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

  /** `pooledRows` is what the pool's refresh saw; later discovery may report more. */
  async function start(pooledRows: BootedDevice[]): Promise<void> {
    driven = [];
    timer = new FakeTimer();
    manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", pooledRows);
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
    // One handset, however many transports: pooled once, under the USB serial.
    expect(pool.getAllDevices().map((device) => device.id)).toEqual([usb]);
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
    spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation(
      (device) =>
        ({
          ensureCompatibleVersion: async () => {
            driven.push(`updateService:${device.deviceId}`);
            return { status: "compatible" };
          },
        }) as unknown as AndroidCtrlProxyManager,
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
  }

  beforeEach(async () => {
    await start([booted(usb), booted(wireless)]);
    expect(pool.getAndroidTransportAliases(usb)).toEqual([wireless]);
  });

  afterEach(() => {
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
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
    expect(response).toMatchObject(HELD_BY_OTHER);
  });

  test("another session's input/tap naming the wireless alias is refused for the holder", async () => {
    const response = await tap("alias-foreign", wireless, { sessionUuid: "someone-else" });

    expect(driven).toEqual([]);
    expect(response).toMatchObject(HELD_BY_OTHER);
  });

  test("a sessionless ide/setKeyValue naming the wireless alias writes nothing to the held handset", async () => {
    const response = await setKeyValue("alias-kv", wireless);

    expect(driven).toEqual([]);
    expect(response).toMatchObject(HELD_BY_OTHER);
  });

  test("a sessionless ide/updateService naming the wireless alias never reaches the service manager", async () => {
    const response = await send("alias-svc", "ide/updateService", {
      platform: "android",
      deviceId: wireless,
    });

    expect(driven).toEqual([]);
    expect(response).toMatchObject(HELD_BY_OTHER);
  });

  test("the holder's input/tap naming the wireless alias is sent to the pooled device", async () => {
    const response = await tap("holder-alias", wireless, { sessionUuid: HOLDER });

    expect(response).toMatchObject({ success: true, result: { deviceId: usb } });
    expect(driven).toEqual([`tap:${usb}`]);
  });

  test("the holder's ide/setKeyValue naming the wireless alias is written to the pooled device", async () => {
    const response = await send("holder-alias-kv", "ide/setKeyValue", {
      platform: "android",
      deviceId: wireless,
      appId: "com.example",
      fileName: "prefs",
      key: "k",
      value: "v",
      type: "STRING",
      sessionUuid: HOLDER,
    });

    expect(response).toMatchObject({ success: true });
    expect(driven).toEqual([`setPreference:${usb}`]);
  });

  test("a wireless id the pool has not seen yet is folded before the holder check", async () => {
    // The pool refreshed while only USB was attached; wireless debugging connected afterwards.
    await start([booted(usb)]);
    expect(pool.getAndroidTransportAliases(usb)).toEqual([]);
    manager.setBootedDevices("android", [booted(usb), booted(wireless)]);

    const sessionless = await tap("first-sighting", wireless);
    const holder = await tap("first-sighting-holder", wireless, { sessionUuid: HOLDER });

    expect(sessionless).toMatchObject(HELD_BY_OTHER);
    expect(holder).toMatchObject({ success: true, result: { deviceId: usb } });
    expect(driven).toEqual([`tap:${usb}`]);
    expect(pool.getAndroidTransportAliases(usb)).toEqual([wireless]);
  });

  test("a wireless id first seen on an ide/setKeyValue frame is folded before the holder check", async () => {
    await start([booted(usb)]);
    manager.setBootedDevices("android", [booted(usb), booted(wireless)]);

    const response = await setKeyValue("first-sighting-kv", wireless);

    expect(driven).toEqual([]);
    expect(response).toMatchObject(HELD_BY_OTHER);
  });
});
