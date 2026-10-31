import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DeviceAssignedToBindingError } from "../../src/daemon/sessionBroker/provisioning/refusal";
import {
  computeBindingScopeKey,
  type ManagedDeviceEntry,
} from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { FeatureFlagKey } from "../../src/features/featureFlags/FeatureFlagDefinitions";
import type { FeatureFlagAdmin } from "../../src/features/featureFlags/FeatureFlagService";
import { BrokerConnectionScopes } from "../../src/daemon/sessionBroker/connectionScope";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { createAndroidTestClient } from "../helpers/androidCtrlProxyClientSpies";
import { createFakeDaemonState, createFakeDeviceManager } from "./helpers/inputSocketHarness";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { NonThrowingFakeSocket as FakeSocket } from "../fakes/FakeNetServer";

/**
 * A socket bound to broker bindings is confined to its slot devices and slot sessions for control
 * and lifecycle (#11178, `brokerConnectionScope.ts`: "a control call on any other device, a call
 * naming any other session ... are refused with `device_outside_broker_grant`"). Every direct
 * control and lifecycle frame applies that confinement (#11596): `input/*`, the device-mutating
 * `ide/*` routes (`force` or not), `ide/setSessionToolEnabled`, `daemon/registerSession`,
 * `daemon/releaseSession`,
 * `daemon/refreshDevices`, `ide/setFeatureFlag` and `daemon/relinquishDeviceLease`. Reads stay open, and an ordinary
 * (unbound) connection is never confined: anyone may release a session from one.
 *
 * Real socket server, real SessionManager and BrokerConnectionScopes on a FakeTimer; only the
 * device clients and mutation services are fakes.
 */

const SLOT_SESSION = "slot-exec";
const GENERIC_SESSION = "generic-harness";
const SCOPE_IDENTITY = {
  managedHostScope: "host-a",
  runnerNamespace: "runner-a",
  runnerIncarnation: "incarnation-a",
};
const SCOPE_KEY = computeBindingScopeKey(SCOPE_IDENTITY);
const slotDevice: BootedDevice = { deviceId: "emulator-5554", name: "Slot", platform: "android" };
const freeDevice: BootedDevice = { deviceId: "emulator-5556", name: "Free", platform: "android" };
const heldDevice: BootedDevice = { deviceId: "emulator-5558", name: "Held", platform: "android" };

const OUTSIDE_SLOTS = { success: false, code: "device_outside_broker_grant" };

describe("direct frames from a managed connection outside its slots", () => {
  let sessionManager: SessionManager;
  let scopes: BrokerConnectionScopes;
  let server: UnixSocketServerHarness;
  let managed: FakeSocket;
  let generic: FakeSocket;
  let writes: string[];
  let taps: number;
  let toolSelections: string[];
  let canonicalIds: Map<string, string>;
  let unidentifiableIds: Set<string>;
  let discovered: BootedDevice[];
  let bindingHeld: boolean;
  let poolRefreshes: string[];
  let flagWrites: Array<{ key: string; enabled: boolean }>;
  const flags: Awaited<ReturnType<FeatureFlagAdmin["listFlags"]>> = [
    { key: "debug", label: "Debug", description: "Debug", enabled: false },
  ];
  const slotEntry: ManagedDeviceEntry = {
    platform: "android",
    stableDeviceId: slotDevice.deviceId,
    holder: "session_broker",
    scopeKey: SCOPE_KEY,
    bindingIndex: 0,
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
    await Promise.all([...server.state.activeRequestHandlers]);
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
    poolRefreshes = [];
    flagWrites = [];
    canonicalIds = new Map();
    unidentifiableIds = new Set();
    bindingHeld = true;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SLOT_SESSION, slotDevice.deviceId, "android", {
      timeoutMs: 60_000,
    });
    await sessionManager.createSession(GENERIC_SESSION, heldDevice.deviceId, "android", {
      timeoutMs: 60_000,
    });
    scopes = new BrokerConnectionScopes();

    discovered = [slotDevice, freeDevice, heldDevice];
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager(discovered));
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      createAndroidTestClient(slotDevice, {
        getScreenScaleMetadata: () => null,
        requestTapCoordinates: async (...args) => {
          args[0].onDispatch?.();
          taps++;
          return { success: true, totalTimeMs: 0 };
        },
        setPreference: async (...args) => {
          if (typeof args[3] === "object") {
            args[3].onDispatch?.();
          }
          writes.push("setPreference");
          return undefined;
        },
        removePreference: async (...args) => {
          if (typeof args[3] === "object") {
            args[3].onDispatch?.();
          }
          writes.push("removePreference");
          return undefined;
        },
        clearPreferenceStore: async (...args) => {
          if (typeof args[2] === "object") {
            args[2].onDispatch?.();
          }
          writes.push("clearPreferenceStore");
          return undefined;
        },
      }),
    );
    const ctrlProxyManager = AndroidCtrlProxyManager.createForTestingWithDeps(
      slotDevice,
      new FakeAdbExecutor(),
      { timer: new FakeTimer() },
    );
    spyOn(ctrlProxyManager, "ensureCompatibleVersion").mockImplementation(async () => {
      writes.push("ensureCompatibleVersion");
      return { status: "compatible" };
    });
    spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue(ctrlProxyManager);
    const fakePool = {
      ...createFakeDaemonState().getDevicePool(),
      refreshDevices: async () => {
        poolRefreshes.push("refreshDevices");
        return 0;
      },
      refreshDevicesWithOutcome: async () => {
        poolRefreshes.push("refreshDevicesWithOutcome");
        return { addedCount: 0 };
      },
      resolveAndroidCanonicalId: (deviceId: string) => canonicalIds.get(deviceId) ?? deviceId,
      isAndroidTransportAssignable: (device: BootedDevice) =>
        !unidentifiableIds.has(device.deviceId),
      androidBindingHold: async (heldDeviceIds: readonly string[]) =>
        bindingHeld && !heldDeviceIds.includes(slotDevice.deviceId)
          ? { entry: slotEntry }
          : undefined,
      assertNotAssignedToBinding: async (input: {
        action: string;
        deviceId: string;
        requesterSessionUuid?: string;
      }) => {
        if (
          bindingHeld &&
          input.deviceId === slotDevice.deviceId &&
          input.requesterSessionUuid !== SLOT_SESSION
        ) {
          throw new DeviceAssignedToBindingError(input.action, input.deviceId, slotEntry);
        }
      },
    };
    server = createHarnessServer(
      "unused",
      {
        isInitialized: () => true,
        getSessionManager: () => sessionManager,
        getDevicePool: () => fakePool,
        getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
        getBrokerConnectionScopes: () => scopes,
      },
      new FakeTimer(),
      {
        setFlag: async (key: FeatureFlagKey, enabled: boolean) => {
          flagWrites.push({ key, enabled });
          return { key, label: key, description: key, enabled };
        },
        listFlags: async () => flags,
      } satisfies FeatureFlagAdmin,
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
    server.allowRequests();
    managed = new FakeSocket();
    server.connect(managed);
    // What broker acquisition does for the socket that asked (`bindBrokerConnection`).
    const [socketSessionId] = server.sessionIds;
    scopes.bind(socketSessionId!, { scopeKey: SCOPE_KEY, sessionUuids: [SLOT_SESSION] });
    // An ordinary connection on the same daemon: never bound, never confined.
    generic = new FakeSocket();
    server.connect(generic);
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

  test("control: input/tap on a device outside the bindings is refused", async () => {
    const response = await send("tap", "input/tap", {
      platform: "android",
      deviceId: freeDevice.deviceId,
      x: 1,
      y: 2,
    });

    expect(taps).toBe(0);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("remaining confinement: refreshDevices refuses before pool refresh", async () => {
    const response = await send("refresh", "daemon/refreshDevices", {});
    expect(response).toMatchObject(OUTSIDE_SLOTS);
    expect(poolRefreshes).toEqual([]);
  });

  test("remaining confinement: setFeatureFlag refuses before flag mutation", async () => {
    const response = await send("flag", "ide/setFeatureFlag", { key: "debug", enabled: true });
    expect(response).toMatchObject({
      ...OUTSIDE_SLOTS,
      type: "mcp_response",
      id: "flag",
      retryable: false,
      details: { action: "ide/setFeatureFlag", reason: "host", scopeKey: SCOPE_KEY },
    });
    expect(response?.error).toContain("ide/setFeatureFlag refused");
    expect(flagWrites).toEqual([]);
  });

  test("listFeatureFlags stays open on the managed connection", async () => {
    const response = await send("flags", "ide/listFeatureFlags", {});
    expect(response).toMatchObject({ success: true, result: { flags } });
    expect(flagWrites).toEqual([]);
  });

  test("control: ide/setKeyValue on the connection's own binding device is written", async () => {
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

  test("ide/setKeyValue on a device outside the bindings is refused before anything is written", async () => {
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

  test("ide/clearKeyValueFile on a device outside the bindings is refused", async () => {
    const response = await send("clear", "ide/clearKeyValueFile", {
      platform: "android",
      deviceId: freeDevice.deviceId,
      appId: "com.example",
      fileName: "prefs",
    });

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("ide/updateService on a device outside the bindings never reaches the service manager", async () => {
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

  test("ide/removeKeyValue on a device outside the bindings is refused", async () => {
    const response = await send("remove", "ide/removeKeyValue", keyValue(freeDevice.deviceId));

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("ide/setKeyValue on the binding device for a session outside the bindings is refused", async () => {
    const response = await send(
      "kv-session",
      "ide/setKeyValue",
      keyValue(slotDevice.deviceId, { value: "v", type: "STRING", sessionUuid: GENERIC_SESSION }),
    );

    expect(writes).toEqual([]);
    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("ide/setSessionToolEnabled changes only the connection's own binding sessions", async () => {
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
    expect(foreign).toMatchObject({
      retryable: false,
      details: {
        action: "ide/setSessionToolEnabled",
        reason: "session",
        scopeKey: SCOPE_KEY,
        sessionUuid: GENERIC_SESSION,
      },
    });
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

  test("daemon/releaseSession of the connection's own binding session releases it", async () => {
    const response = await send("release-own", "daemon/releaseSession", {
      sessionId: SLOT_SESSION,
    });

    expect(response).toMatchObject({ success: true });
    expect(sessionManager.getSession(SLOT_SESSION)).toBeNull();
    expect(sessionManager.getSession(GENERIC_SESSION)).not.toBeNull();
  });

  test("daemon/relinquishDeviceLease on a device outside the bindings is refused", async () => {
    const response = await send("lease", "daemon/relinquishDeviceLease", {
      deviceId: heldDevice.deviceId,
    });

    expect(response).toMatchObject(OUTSIDE_SLOTS);
  });

  test("daemon/relinquishDeviceLease compares the binding device by its pooled canonical id", async () => {
    canonicalIds.set("192.168.1.20:5555", heldDevice.deviceId);
    canonicalIds.set("192.168.1.30:5555", slotDevice.deviceId);

    const foreign = await send("lease-alias-foreign", "daemon/relinquishDeviceLease", {
      deviceId: "192.168.1.20:5555",
    });
    const own = await send("lease-alias-own", "daemon/relinquishDeviceLease", {
      deviceId: "192.168.1.30:5555",
    });

    expect(foreign).toMatchObject(OUTSIDE_SLOTS);
    expect(own?.code).not.toBe("device_outside_broker_grant");
  });

  test("reads from the managed connection outside its bindings still answer", async () => {
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
  test("outside callers cannot drive an unidentified transport while an idle Android binding is held", async () => {
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
      code: "device_assigned_to_binding",
      retryable: false,
    });
    expect(written).toMatchObject({ success: false, code: "device_assigned_to_binding" });
    expect(taps).toBe(0);
    expect(writes).toEqual([]);
  });

  test("a binding's managed connection drives its canonical device", async () => {
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
    bindingHeld = false;
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
