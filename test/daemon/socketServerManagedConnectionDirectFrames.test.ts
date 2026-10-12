import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DeviceAssignedToManagedSlotError } from "../../src/daemon/managedSlots/managedSlotRefusal";
import type { ManagedDeviceEntry } from "../../src/daemon/managedSlots/slotRegistry";
import { ManagedConnectionScopes } from "../../src/daemon/managedSlots/managedConnectionScope";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";

/**
 * A socket bound to managed slots is confined to its slot devices and slot sessions for control
 * and lifecycle (#11178, `managedConnectionScope.ts`: "a control call on any other device, a call
 * naming any other session ... are refused with `device_outside_managed_slots`"). Every direct
 * control and lifecycle frame applies that confinement (#11596): `input/*`, the device-mutating
 * `ide/*` routes (`force` or not), `ide/setSessionToolEnabled`, `daemon/registerSession`,
 * `daemon/releaseSession` and `daemon/relinquishDeviceLease`. Reads stay open, and an ordinary
 * (unbound) connection is never confined: anyone may release a session from one.
 *
 * Real socket server, real SessionManager and ManagedConnectionScopes on a FakeTimer; only the
 * device clients are fakes.
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
  sessions: Map<string, unknown>;
}

const SLOT_SESSION = "slot-exec";
const GENERIC_SESSION = "generic-harness";
const slotDevice: BootedDevice = { deviceId: "emulator-5554", name: "Slot", platform: "android" };
const freeDevice: BootedDevice = { deviceId: "emulator-5556", name: "Free", platform: "android" };
const heldDevice: BootedDevice = { deviceId: "emulator-5558", name: "Held", platform: "android" };

const OUTSIDE_SLOTS = { success: false, code: "device_outside_managed_slots" };

describe("direct frames from a managed connection outside its slots", () => {
  let sessionManager: SessionManager;
  let scopes: ManagedConnectionScopes;
  let internals: Internals;
  let managed: FakeSocket;
  let generic: FakeSocket;
  let writes: string[];
  let taps: number;
  let toolSelections: string[];
  let canonicalIds: Map<string, string>;
  let unidentifiableIds: Set<string>;
  let discovered: BootedDevice[];
  let managedSlotHeld: boolean;
  const slotEntry: ManagedDeviceEntry = {
    platform: "android",
    stableDeviceId: slotDevice.deviceId,
    holder: "slot",
    scopeKey: "scope-a",
    slotIndex: 0,
    scopeState: "valid",
    execSessionUuid: SLOT_SESSION,
  };
  let configurable: { mockRestore(): void } | undefined;

  async function sendOn(
    socket: FakeSocket,
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<DaemonResponse | undefined> {
    socket.send({ id, type: "mcp_request", method, params });
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  const send = (id: string, method: string, params: Record<string, unknown>) =>
    sendOn(managed, id, method, params);

  const keyValue = (deviceId: string, extra: Record<string, unknown> = {}) => ({
    platform: "android",
    deviceId,
    appId: "com.example",
    fileName: "prefs",
    key: "k",
    ...extra,
  });

  beforeEach(async () => {
    writes = [];
    taps = 0;
    toolSelections = [];
    canonicalIds = new Map();
    unidentifiableIds = new Set();
    managedSlotHeld = true;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SLOT_SESSION, slotDevice.deviceId, "android", 60_000);
    await sessionManager.createSession(GENERIC_SESSION, heldDevice.deviceId, "android", 60_000);
    scopes = new ManagedConnectionScopes();

    discovered = [slotDevice, freeDevice, heldDevice];
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: async () => discovered,
      getBootedDevicesDetailed: async () => ({
        devices: discovered,
        succeededPlatforms: new Set(["android", "ios"]),
      }),
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestTapCoordinates: async (
            ...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>
          ) => {
            args[6]?.();
            taps++;
            return { success: true };
          },
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
    const fakePool = {
      ...createFakeDaemonState().getDevicePool(),
      resolveAndroidCanonicalId: (deviceId: string) => canonicalIds.get(deviceId) ?? deviceId,
      isAndroidTransportAssignable: (device: BootedDevice) =>
        !unidentifiableIds.has(device.deviceId),
      androidManagedSlotHold: async (heldDeviceIds: readonly string[]) =>
        managedSlotHeld && !heldDeviceIds.includes(slotDevice.deviceId)
          ? { entry: slotEntry }
          : undefined,
      assertNotAssignedToManagedSlot: async (input: {
        action: string;
        deviceId: string;
        requesterSessionUuid?: string;
      }) => {
        if (
          managedSlotHeld &&
          input.deviceId === slotDevice.deviceId &&
          input.requesterSessionUuid !== SLOT_SESSION
        ) {
          throw new DeviceAssignedToManagedSlotError(input.action, input.deviceId, slotEntry);
        }
      },
    };
    const server = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      {
        isInitialized: () => true,
        getSessionManager: () => sessionManager,
        getDevicePool: () => fakePool,
        getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
        getManagedConnectionScopes: () => scopes,
      } as unknown as DaemonStateAccess,
      new FakeTimer(),
      null,
      // The storage tools are enabled, so the frames reach the ownership gate.
      {
        sessionToolSelectionService: {
          isEnabled: async () => true,
          setEnabled: async (sessionUuid: string, toolName: string, enabled: boolean) => {
            toolSelections.push(`${sessionUuid}:${toolName}:${enabled}`);
          },
        },
      },
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    managed = new FakeSocket();
    internals.handleConnection(managed as unknown as Socket);
    // What `daemon/acquireManagedSlots` does for the socket that asked (`bindManagedConnection`).
    const [socketSessionId] = [...internals.sessions.keys()];
    scopes.bind(socketSessionId!, { scopeKey: "scope-a", sessionUuids: [SLOT_SESSION] });
    // An ordinary connection on the same daemon: never bound, never confined.
    generic = new FakeSocket();
    internals.handleConnection(generic as unknown as Socket);
  });

  afterEach(() => {
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    configurable?.mockRestore();
    configurable = undefined;
    managed.destroy();
    generic.destroy();
    sessionManager.stopCleanupTimer();
  });

  test("control: input/tap on a device outside the slots is refused", async () => {
    const response = await send("tap", "input/tap", {
      platform: "android",
      deviceId: freeDevice.deviceId,
      x: 1,
      y: 2,
    });

    expect(taps).toBe(0);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("control: ide/setKeyValue on the connection's own slot device is written", async () => {
    const response = await send("own", "ide/setKeyValue", {
      platform: "android",
      deviceId: slotDevice.deviceId,
      appId: "com.example",
      fileName: "prefs",
      key: "k",
      value: "v",
      type: "STRING",
      sessionUuid: SLOT_SESSION,
    });

    expect(response).toMatchObject({ success: true });
    expect(writes).toEqual(["setPreference"]);
  });

  test("ide/setKeyValue on a device outside the slots is refused before anything is written", async () => {
    const response = await send("kv", "ide/setKeyValue", {
      platform: "android",
      deviceId: freeDevice.deviceId,
      appId: "com.example",
      fileName: "prefs",
      key: "k",
      value: "v",
      type: "STRING",
    });

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("ide/clearKeyValueFile on a device outside the slots is refused", async () => {
    const response = await send("clear", "ide/clearKeyValueFile", {
      platform: "android",
      deviceId: freeDevice.deviceId,
      appId: "com.example",
      fileName: "prefs",
    });

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("ide/updateService on a device outside the slots never reaches the service manager", async () => {
    const response = await send("svc", "ide/updateService", {
      platform: "android",
      deviceId: freeDevice.deviceId,
    });

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("a forced ide/updateService does not lift the confinement on another session's device", async () => {
    const response = await send("svc-force", "ide/updateService", {
      platform: "android",
      deviceId: heldDevice.deviceId,
      force: true,
    });

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("ide/removeKeyValue on a device outside the slots is refused", async () => {
    const response = await send("remove", "ide/removeKeyValue", keyValue(freeDevice.deviceId));

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("ide/setKeyValue on the slot device for a session outside the slots is refused", async () => {
    const response = await send(
      "kv-session",
      "ide/setKeyValue",
      keyValue(slotDevice.deviceId, { value: "v", type: "STRING", sessionUuid: GENERIC_SESSION }),
    );

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("ide/setSessionToolEnabled changes only the connection's own slot sessions", async () => {
    // The process registry is empty here; the route only needs the tool to be configurable.
    configurable = spyOn(ToolRegistry, "isUserConfigurableTool").mockReturnValue(true);
    const foreign = await send("tool-foreign", "ide/setSessionToolEnabled", {
      sessionUuid: GENERIC_SESSION,
      toolName: "setKeyValue",
      enabled: false,
    });
    const own = await send("tool-own", "ide/setSessionToolEnabled", {
      sessionUuid: SLOT_SESSION,
      toolName: "setKeyValue",
      enabled: false,
    });

    expect(foreign).toMatchObject(OUTSIDE_SLOTS);
    expect(toolSelections).toEqual([`${SLOT_SESSION}:setKeyValue:false`]);
    expect(own).toMatchObject({ success: true });
  });

  test("daemon/releaseSession naming another connection's session is refused and releases nothing", async () => {
    const response = await send("release", "daemon/releaseSession", {
      sessionId: GENERIC_SESSION,
    });

    expect(sessionManager.getSession(GENERIC_SESSION)).not.toBeNull();
    expect(sessionManager.getSessionForDevice(heldDevice.deviceId)).toBe(GENERIC_SESSION);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("daemon/releaseSession naming a session nobody holds is still outside the slots", async () => {
    const response = await send("release-unknown", "daemon/releaseSession", {
      sessionId: "never-registered",
    });

    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("daemon/releaseSession of the connection's own slot session releases it", async () => {
    const response = await send("release-own", "daemon/releaseSession", {
      sessionId: SLOT_SESSION,
    });

    expect(response).toMatchObject({ success: true });
    expect(sessionManager.getSession(SLOT_SESSION)).toBeNull();
    expect(sessionManager.getSession(GENERIC_SESSION)).not.toBeNull();
  });

  test("daemon/relinquishDeviceLease on a device outside the slots is refused", async () => {
    const response = await send("lease", "daemon/relinquishDeviceLease", {
      deviceId: heldDevice.deviceId,
    });

    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("daemon/relinquishDeviceLease compares the slot device by its pooled canonical id", async () => {
    canonicalIds.set("192.168.1.20:5555", heldDevice.deviceId);
    canonicalIds.set("192.168.1.30:5555", slotDevice.deviceId);

    const foreign = await send("lease-alias-foreign", "daemon/relinquishDeviceLease", {
      deviceId: "192.168.1.20:5555",
    });
    const own = await send("lease-alias-own", "daemon/relinquishDeviceLease", {
      deviceId: "192.168.1.30:5555",
    });

    expect(foreign).toMatchObject(OUTSIDE_SLOTS);
    expect(own?.code).not.toBe("device_outside_managed_slots");
  });

  test("reads from the managed connection outside its slots still answer", async () => {
    const info = await send("info", "daemon/sessionInfo", { sessionId: GENERIC_SESSION });
    const sessions = await send("sessions", "daemon/activeSessions", {});
    const ping = await send("ping", "ide/ping", {});

    expect(info).toMatchObject({ success: true });
    expect(sessions).toMatchObject({ success: true });
    expect(ping).toMatchObject({ success: true });
  });

  test("an ordinary connection is not confined: it mutates a free device and releases any session", async () => {
    const written = await sendOn(
      generic,
      "generic-kv",
      "ide/setKeyValue",
      keyValue(freeDevice.deviceId, { value: "v", type: "STRING" }),
    );
    const released = await sendOn(generic, "generic-release", "daemon/releaseSession", {
      sessionId: GENERIC_SESSION,
    });

    expect(written).toMatchObject({ success: true });
    expect(writes).toEqual(["setPreference"]);
    expect(released).toMatchObject({ success: true });
    expect(sessionManager.getSession(GENERIC_SESSION)).toBeNull();
  });
  test("outside callers cannot drive an unidentified transport while an idle Android slot is held", async () => {
    await sessionManager.releaseSession(SLOT_SESSION);
    await sessionManager.releaseSession(GENERIC_SESSION);
    const target = "192.168.1.20:5555";
    unidentifiableIds.add(target);
    discovered.push({ deviceId: target, name: target, platform: "android" });
    const tapped = await sendOn(generic, "slot-unknown-tap", "input/tap", {
      platform: "android",
      deviceId: target,
      x: 1,
      y: 2,
    });
    const written = await sendOn(
      generic,
      "slot-unknown-kv",
      "ide/setKeyValue",
      keyValue(target, { value: "v", type: "STRING" }),
    );
    expect(tapped).toMatchObject({
      success: false,
      code: "device_assigned_to_managed_slot",
      retryable: false,
    });
    expect(written).toMatchObject({ success: false, code: "device_assigned_to_managed_slot" });
    expect(taps).toBe(0);
    expect(writes).toEqual([]);
  });

  test("a slot's managed connection drives its canonical device", async () => {
    const tapped = await send("slot-canonical-tap", "input/tap", {
      platform: "android",
      deviceId: slotDevice.deviceId,
      x: 1,
      y: 2,
      sessionUuid: SLOT_SESSION,
    });
    expect(tapped).toMatchObject({ success: true });
    expect(taps).toBe(1);
  });

  test("an unidentified frame with nothing held still passes identity before managed confinement", async () => {
    await sessionManager.releaseSession(SLOT_SESSION);
    await sessionManager.releaseSession(GENERIC_SESSION);
    managedSlotHeld = false;
    const target = "192.168.1.20:5555";
    unidentifiableIds.add(target);
    discovered.push({ deviceId: target, name: target, platform: "android" });
    const tapped = await send("confined-unknown-tap", "input/tap", {
      platform: "android",
      deviceId: target,
      x: 1,
      y: 2,
    });
    const written = await send(
      "confined-unknown-kv",
      "ide/setKeyValue",
      keyValue(target, { value: "v", type: "STRING" }),
    );
    expect(tapped).toMatchObject(OUTSIDE_SLOTS);
    expect(written).toMatchObject(OUTSIDE_SLOTS);
    expect(taps).toBe(0);
    expect(writes).toEqual([]);
  });
});
