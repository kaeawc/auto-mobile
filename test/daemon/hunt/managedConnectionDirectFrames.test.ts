import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { DaemonStateAccess } from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { ManagedConnectionScopes } from "../../../src/daemon/managedSlots/managedConnectionScope";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createFakeDaemonState } from "../helpers/inputSocketHarness";

/**
 * Hunt: a socket bound to managed slots is confined to its slot devices and slot sessions for
 * control and lifecycle (#11178, `managedConnectionScope.ts`: "a control call on any other device,
 * a call naming any other session ... are refused with `device_outside_managed_slots`"). The
 * dispatcher applies that confinement to `input/*` (`assertManagedConnectionInputTarget`) and to
 * `daemon/registerSession`, and the MCP tool path applies it to `setKeyValue` and friends
 * (`assertManagedSlotControlAccess`). The sibling direct frames skip it:
 *
 * - `ide/setKeyValue` / `ide/removeKeyValue` / `ide/clearKeyValueFile` / `ide/updateService` run
 *   `assertIdeMutationOwnership`, which checks the device's holder and the generic slot exclusion
 *   but never the connection's binding, so a managed socket writes to, or reinstalls the service
 *   of, a device outside its slots.
 * - `daemon/releaseSession` is dispatched without the requesting socket (`handleReleaseSession`
 *   receives no `DaemonRequestContext`), so a managed socket ends any other connection's session.
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
  let writes: string[];
  let taps: number;

  async function send(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<DaemonResponse | undefined> {
    managed.send({ id, type: "mcp_request", method, params });
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...internals.activeRequestHandlers]);
    return managed.responses.find((frame) => frame.id === id);
  }

  beforeEach(async () => {
    writes = [];
    taps = 0;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SLOT_SESSION, slotDevice.deviceId, "android", 60_000);
    await sessionManager.createSession(GENERIC_SESSION, heldDevice.deviceId, "android", 60_000);
    scopes = new ManagedConnectionScopes();

    const devices = [slotDevice, freeDevice, heldDevice];
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: async () => devices,
      getBootedDevicesDetailed: async () => ({
        devices,
        succeededPlatforms: new Set(["android", "ios"]),
      }),
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestTapCoordinates: async () => {
            taps++;
            return { success: true };
          },
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
      { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    managed = new FakeSocket();
    internals.handleConnection(managed as unknown as Socket);
    // What `daemon/acquireManagedSlots` does for the socket that asked (`bindManagedConnection`).
    const [socketSessionId] = [...internals.sessions.keys()];
    scopes.bind(socketSessionId!, { scopeKey: "scope-a", sessionUuids: [SLOT_SESSION] });
  });

  afterEach(() => {
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    managed.destroy();
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

  test("daemon/releaseSession naming another connection's session is refused and releases nothing", async () => {
    const response = await send("release", "daemon/releaseSession", {
      sessionId: GENERIC_SESSION,
    });

    expect(sessionManager.getSession(GENERIC_SESSION)).not.toBeNull();
    expect(sessionManager.getSessionForDevice(heldDevice.deviceId)).toBe(GENERIC_SESSION);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });
});
