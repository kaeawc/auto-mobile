import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import type { DaemonResponse } from "../../src/daemon/types";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { InMemoryControlSocket, RawFrameClient } from "../helpers/inMemoryDaemonWire";
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
import { createAndroidTestClient } from "../helpers/androidCtrlProxyClientSpies";
import { StubMcpClient } from "./helpers/fakeMcpClient";
import { spyOnIosClientFactory } from "../helpers/iosCtrlProxyClientSpies";

/**
 * One handset reachable over USB and wireless debugging is ONE pooled device (#10201): the pool
 * folds both `adb devices` rows into a canonical id and a session holds that id. A direct frame
 * may name the handset by either id, so `input/*` and `ide/*` resolve the frame's `deviceId` and
 * discovery rows to the pool's canonical id before any holder, broker-binding or admission decision
 * (#11596). Matching the raw discovery row instead found no holder for the other transport id,
 * and a sessionless `input/tap` or `ide/setKeyValue` reached the handset a session held.
 *
 * Real DevicePool (with its transport-alias fold), real SessionManager and socket server on a
 * FakeTimer; only adb and the device client are fakes.
 */

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
  let wire: InMemoryControlSocket;
  let client: RawFrameClient;
  let manager: FakeDeviceUtils;
  let adb: FakeAdbExecutor;
  /** The serials the fake device client was built for and driven on. */
  let driven: string[];
  let reads: string[];

  async function send(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<DaemonResponse | undefined> {
    return { id, type: "mcp_response", ...(await client.request(method, params)) };
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
  async function start(pooledRows: BootedDevice[], hold = true): Promise<void> {
    client?.close();
    wire?.kill();
    sessionManager?.stopCleanupTimer();
    timer?.reset();
    DaemonState.getInstance().reset();
    driven = [];
    reads = [];
    timer = new FakeTimer();
    manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", pooledRows);
    adb = new FakeAdbExecutor();
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
    expect(pool.getAllDevices().map((device) => device.id)).toEqual(pooledRows.length ? [usb] : []);
    if (hold) {
      expect(await pool.assignDeviceToSession(HOLDER, "android")).toBe(usb);
      await sessionManager.createSession(HOLDER, usb, "android", { timeoutMs: 60_000 });
      expect(sessionManager.getSessionForDevice(usb)).toBe(HOLDER);
    }

    // The direct frames discover through the process device manager: the raw `adb devices` rows.
    PlatformDeviceManagerFactory.setInstance(manager);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation((device) =>
      createAndroidTestClient(device, {
        getScreenScaleMetadata: () => null,
        requestTapCoordinates: async (...args) => {
          args[0].onDispatch?.();
          driven.push(`tap:${device.deviceId}`);
          return { success: true, totalTimeMs: 0 };
        },
        setPreference: async (...args) => {
          if (typeof args[3] === "object") {
            args[3].onDispatch?.();
          }
          driven.push(`setPreference:${device.deviceId}`);
        },
      }),
    );
    spyOnIosClientFactory((device) => ({
      getScreenScaleMetadata: () => ({ nativeScale: 1, pixelWidth: 100, pixelHeight: 100 }),
      requestTapCoordinates: async (
        ...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>
      ) => {
        args[0].onDispatch?.();
        driven.push(`ios-tap:${device.deviceId}`);
        return { success: true };
      },
      setPreference: async (...args: Parameters<IOSCtrlProxyClient["setPreference"]>) => {
        if (typeof args[3] === "object") {
          args[3].onDispatch?.();
        }
        driven.push(`ios-setPreference:${device.deviceId}`);
      },
    }));
    spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation((device) => {
      const proxyManager = AndroidCtrlProxyManager.createForTestingWithDeps(
        device,
        new FakeAdbExecutor(),
      );
      spyOn(proxyManager, "ensureCompatibleVersion").mockImplementation(async () => {
        driven.push(`updateService:${device.deviceId}`);
        return { status: "compatible" };
      });
      return proxyManager;
    });
    DaemonState.getInstance().initialize(sessionManager, pool);
    wire = InMemoryControlSocket.attach({
      timer,
      connectionIds: new FakeIdGenerator(),
      loopback: async () =>
        new StubMcpClient({
          readResource: async ({ uri }) => {
            reads.push(uri);
            return { contents: [{ uri, mimeType: "image/png", blob: "fake-screenshot" }] };
          },
        }),
      startupOptions: {
        sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} },
      },
    });
    client = new RawFrameClient("direct", () => wire.connect("direct-connection"));
  }

  async function arrangeHarness(): Promise<void> {
    await start([booted(usb), booted(wireless)]);
    expect(pool.getAndroidTransportAliases(usb)).toEqual([wireless]);
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  afterEach(() => {
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
    spyOn(IOSCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    client.close();
    wire.kill();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
    timer.reset();
  });

  arranged(
    "control: a sessionless input/tap naming the canonical id is refused for the holder",
    async () => {
      const response = await tap("canonical", usb);

      expect(driven).toEqual([]);
      expect(response).toMatchObject(HELD_BY_OTHER);
    },
  );

  arranged("control: the holder's own input/tap on the canonical id is sent", async () => {
    const response = await tap("holder", usb, { sessionUuid: HOLDER });

    expect(response).toMatchObject({ success: true });
    expect(driven).toEqual([`tap:${usb}`]);
  });

  arranged(
    "a sessionless input/tap naming the wireless alias never reaches the held handset",
    async () => {
      const response = await tap("alias", wireless);

      expect(driven).toEqual([]);
      expect(response).toMatchObject(HELD_BY_OTHER);
    },
  );

  arranged(
    "another session's input/tap naming the wireless alias is refused for the holder",
    async () => {
      const response = await tap("alias-foreign", wireless, { sessionUuid: "someone-else" });

      expect(driven).toEqual([]);
      expect(response).toMatchObject(HELD_BY_OTHER);
    },
  );

  arranged(
    "a sessionless ide/setKeyValue naming the wireless alias writes nothing to the held handset",
    async () => {
      const response = await setKeyValue("alias-kv", wireless);

      expect(driven).toEqual([]);
      expect(response).toMatchObject(HELD_BY_OTHER);
    },
  );

  arranged(
    "a sessionless ide/updateService naming the wireless alias never reaches the service manager",
    async () => {
      const response = await send("alias-svc", "ide/updateService", {
        platform: "android",
        deviceId: wireless,
      });

      expect(driven).toEqual([]);
      expect(response).toMatchObject(HELD_BY_OTHER);
    },
  );

  arranged(
    "the holder's input/tap naming the wireless alias is sent to the pooled device",
    async () => {
      const response = await tap("holder-alias", wireless, { sessionUuid: HOLDER });

      expect(response).toMatchObject({ success: true, result: { deviceId: usb } });
      expect(driven).toEqual([`tap:${usb}`]);
    },
  );

  arranged(
    "the holder's ide/setKeyValue naming the wireless alias is written to the pooled device",
    async () => {
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
    },
  );

  arranged(
    "a wireless id the pool has not seen yet is folded before the holder check",
    async () => {
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
    },
  );

  const UNPROVEN = { success: false, error: expect.stringContaining("no proven identity") };
  const identityProbes = () =>
    adb.getExecutedCommands().filter((command) => command.includes("ro.serialno")).length;

  arranged(
    "expired but unreleased USB ownership refuses wireless input and IDE mutation",
    async () => {
      await start([booted(usb)]);
      adb.setCommandError("getprop ro.serialno", new Error("device offline"));
      manager.setBootedDevices("android", [booted(usb), booted(wireless)]);
      sessionManager.stopCleanupTimer();
      const holder = sessionManager.getSession(HOLDER)!;
      timer.advanceTime(holder.expiresAt - timer.now() + 1);
      expect(sessionManager.getAllSessions()).toEqual([]);
      expect(sessionManager.getSessionForDevice(usb)).toBe(HOLDER);
      expect(sessionManager.getHeldDeviceSessions()).toEqual([
        {
          deviceId: usb,
          sessionId: HOLDER,
          platform: "android",
          stableDeviceId: holder.stableDeviceId,
        },
      ]);

      expect(await tap("expired-usb", usb)).toMatchObject(HELD_BY_OTHER);
      expect(await tap("expired-wireless", wireless)).toMatchObject(HELD_BY_OTHER);
      expect(await setKeyValue("expired-wireless-kv", wireless)).toMatchObject(HELD_BY_OTHER);
      expect(sessionManager.getSessionForDevice(usb)).toBe(HOLDER);
      expect(driven).toEqual([]);
    },
  );

  arranged(
    "the held-device snapshot retains a releasing holder until its reverse-map entry is removed",
    async () => {
      await start([booted(usb)]);
      adb.setCommandError("getprop ro.serialno", new Error("device offline"));
      manager.setBootedDevices("android", [booted(usb), booted(wireless)]);
      const holder = sessionManager.getSession(HOLDER)!;
      const setup = Promise.withResolvers<void>();
      const trackedSetup = sessionManager.trackSessionSetup(holder, () => setup.promise);
      const release = sessionManager.releaseSession(HOLDER, "explicit-release");
      try {
        expect(sessionManager.getReleasingSession(HOLDER)).toBe(holder);
        expect(sessionManager.getSessionForDevice(usb)).toBe(HOLDER);
        expect(sessionManager.getHeldDeviceSessions()).toEqual([
          {
            deviceId: usb,
            sessionId: HOLDER,
            platform: "android",
            stableDeviceId: holder.stableDeviceId,
          },
        ]);
        expect(await tap("releasing-wireless", wireless)).toMatchObject(HELD_BY_OTHER);
        expect(await setKeyValue("releasing-wireless-kv", wireless)).toMatchObject(HELD_BY_OTHER);
        expect(driven).toEqual([]);
      } finally {
        setup.resolve();
        await trackedSetup;
        await release;
      }
      expect(sessionManager.getSessionForDevice(usb)).toBeNull();
      expect(sessionManager.getHeldDeviceSessions()).toEqual([]);
    },
  );

  arranged(
    "a probe-proven remote emulator dispatches while a physical USB phone is held",
    async () => {
      await start([booted(usb)]);
      const remote = "10.0.0.7:5555";
      adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1", ""));
      adb.setCommandResponse("getprop ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
      manager.setBootedDevices("android", [booted(remote)]);

      expect(await tap("remote-emulator", remote)).toMatchObject({ success: true });
      expect(pool.isAndroidTransportAssignable(booted(remote))).toBe(false);
      expect(sessionManager.getSessionForDevice(usb)).toBe(HOLDER);
      expect(driven).toEqual([`tap:${remote}`]);
    },
  );

  arranged(
    "a first-seen wireless id whose identity probe fails is refused, not treated as unowned",
    async () => {
      await start([booted(usb)]);
      adb.setCommandError("getprop ro.serialno", new Error("device offline"));
      manager.setBootedDevices("android", [booted(usb), booted(wireless)]);

      const before = sessionManager.getSession(HOLDER)!;
      const idle = { lastUsedAt: before.lastUsedAt, expiresAt: before.expiresAt };
      timer.advanceTime(1000);
      const tapped = await tap("unproven-tap", wireless);
      const written = await setKeyValue("unproven-kv", wireless);
      const service = await send("unproven-svc", "ide/updateService", {
        platform: "android",
        deviceId: wireless,
        force: true,
      });

      expect(tapped).toMatchObject({
        ...HELD_BY_OTHER,
        details: { deviceId: wireless },
        retryable: false,
      });
      expect(written).toMatchObject(HELD_BY_OTHER);
      expect(service).toMatchObject(HELD_BY_OTHER);
      expect(sessionManager.getSession(HOLDER)).toMatchObject(idle);
      expect(driven).toEqual([]);
    },
  );

  arranged(
    "a wireless id that answers with the held serial while USB is not listed is refused",
    async () => {
      // Only the wireless row is discovered: the probe names the pooled serial, but nothing proves
      // the two rows are one handset, so the pool leaves the row unproven rather than aliasing it.
      await start([booted(usb)]);
      manager.setBootedDevices("android", [booted(wireless)]);

      const sessionless = await tap("lone-wireless", wireless);
      const unnamed = await send("lone-wireless-unnamed", "input/tap", {
        platform: "android",
        x: 1,
        y: 2,
      });

      expect(sessionless).toMatchObject(HELD_BY_OTHER);
      expect(unnamed).toMatchObject(HELD_BY_OTHER);
      expect(driven).toEqual([]);
    },
  );

  arranged(
    "the holder's frames on the pooled id never probe an unprovable wireless row",
    async () => {
      await start([booted(usb)]);
      adb.setCommandError("getprop ro.serialno", new Error("device offline"));
      manager.setBootedDevices("android", [booted(usb), booted(wireless)]);
      const before = identityProbes();

      for (const id of ["one", "two", "three"]) {
        expect(await tap(id, usb, { sessionUuid: HOLDER })).toMatchObject({ success: true });
      }

      expect(identityProbes()).toBe(before);
      expect(driven).toEqual([`tap:${usb}`, `tap:${usb}`, `tap:${usb}`]);
    },
  );

  arranged(
    "a wireless id first seen on an ide/setKeyValue frame is folded before the holder check",
    async () => {
      await start([booted(usb)]);
      manager.setBootedDevices("android", [booted(usb), booted(wireless)]);

      const response = await setKeyValue("first-sighting-kv", wireless);

      expect(driven).toEqual([]);
      expect(response).toMatchObject(HELD_BY_OTHER);
    },
  );
  arranged("unidentifiable input and IDE control dispatch when nothing is held", async () => {
    await start([], false);
    adb.setCommandResponse("getprop ro.serialno", createExecResult("unknown", ""));
    manager.setBootedDevices("android", [booted(wireless)]);
    expect(await tap("free-tap", wireless)).toMatchObject({ success: true });
    expect(await setKeyValue("free-kv", wireless)).toMatchObject({ success: true });
    expect(driven).toEqual([`tap:${wireless}`, `setPreference:${wireless}`]);
  });

  arranged("a loopback adb port cannot alias a held different emulator", async () => {
    await start([], false);
    await sessionManager.createSession(HOLDER, "emulator-5556", "android", { timeoutMs: 60_000 });
    adb.setCommandError("getprop ro.serialno", new Error("unreadable"));
    const target = "localhost:5555";
    manager.setBootedDevices("android", [booted(target)]);
    expect(await tap("different-console-tap", target)).toMatchObject({ success: true });
    expect(await setKeyValue("different-console-kv", target)).toMatchObject({ success: true });
    expect(driven).toEqual([`tap:${target}`, `setPreference:${target}`]);
  });

  arranged(
    "the holder's unresolved alias keeps the untyped error and does not restart idle",
    async () => {
      await start([booted(usb)]);
      adb.setCommandError("getprop ro.serialno", new Error("unreadable"));
      manager.setBootedDevices("android", [booted(usb), booted(wireless)]);
      const before = sessionManager.getSession(HOLDER)!;
      const idle = { lastUsedAt: before.lastUsedAt, expiresAt: before.expiresAt };
      timer.advanceTime(1000);
      const tapped = await tap("holder-unresolved", wireless, { sessionUuid: HOLDER });
      const written = await send("holder-unresolved-kv", "ide/setKeyValue", {
        platform: "android",
        deviceId: wireless,
        appId: "com.example",
        fileName: "prefs",
        key: "k",
        value: "v",
        type: "STRING",
        sessionUuid: HOLDER,
      });
      expect(tapped).toMatchObject(UNPROVEN);
      expect(written).toMatchObject(UNPROVEN);
      expect(tapped?.code).toBeUndefined();
      expect(written?.code).toBeUndefined();
      expect(sessionManager.getSession(HOLDER)).toMatchObject(idle);
      expect(driven).toEqual([]);
    },
  );

  arranged("an iOS id shaped like wireless stays unaffected while Android is held", async () => {
    manager.setBootedDevices("ios", [{ deviceId: wireless, name: "iPhone", platform: "ios" }]);
    expect(
      await send("ios-shaped-tap", "input/tap", {
        platform: "ios",
        deviceId: wireless,
        x: 1,
        y: 2,
      }),
    ).toMatchObject({ success: true });
    expect(
      await send("ios-shaped-kv", "ide/setKeyValue", {
        platform: "ios",
        deviceId: wireless,
        appId: "com.example",
        fileName: "prefs",
        key: "k",
        value: "v",
        type: "STRING",
      }),
    ).toMatchObject({ success: true });
    expect(driven).toEqual([`ios-tap:${wireless}`, `ios-setPreference:${wireless}`]);
  });

  arranged(
    "a screenshot read of an unidentifiable transport never reaches the control identity check",
    async () => {
      await start([booted(usb)]);
      adb.setCommandError("getprop ro.serialno", new Error("unreadable"));
      manager.setBootedDevices("android", [booted(wireless)]);
      const gate = spyOn(pool, "isAndroidTransportAssignable").mockImplementation(() => {
        throw new Error("Reads must never check control identity");
      });
      try {
        const uri = `automobile:observation/${encodeURIComponent(wireless)}/latest/screenshot`;
        expect(await send("read-unresolved", "resources/read", { uri })).toMatchObject({
          success: true,
        });
        expect(reads).toEqual([uri]);
        expect(gate).not.toHaveBeenCalled();
        expect(driven).toEqual([]);
      } finally {
        gate.mockRestore();
      }
    },
  );
});
