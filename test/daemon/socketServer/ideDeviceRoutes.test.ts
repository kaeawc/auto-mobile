import { describe, expect, test } from "bun:test";
import {
  ideDeviceRoutes,
  type IdeDeviceRouteDeps,
  type KeyValueMutationClient,
} from "../../../src/daemon/socketServer/ideDeviceRoutes";
import type { IdeMutationCall } from "../../../src/daemon/socketServer/ideMutationCall";
import type { DaemonRequest } from "../../../src/daemon/types";
import type { BootedDevice } from "../../../src/models";

/** #11815: the device-touching ide/* routes, with only their dependencies injected. */

function device(deviceId: string, platform: "android" | "ios"): BootedDevice {
  return { name: deviceId, platform, deviceId } as BootedDevice;
}

function fixture(overrides: Partial<IdeDeviceRouteDeps> = {}) {
  const calls: string[] = [];
  const devices = [device("emu-1", "android"), device("sim-1", "ios")];
  const client: KeyValueMutationClient = {
    setPreference: async (pkg, file, key, value, type, options) => {
      calls.push(`set:${pkg}:${file}:${key}:${value}:${type}`);
      (options as { onDispatch?: () => void }).onDispatch?.();
      return { resolvedStore: "shared", effectiveValueDiffers: true };
    },
    removePreference: async (pkg, file, key, options) => {
      calls.push(`remove:${pkg}:${file}:${key}`);
      (options as { onDispatch?: () => void }).onDispatch?.();
    },
    clearPreferenceStore: async (pkg, file, options) => {
      calls.push(`clear:${pkg}:${file}`);
      (options as { onDispatch?: () => void }).onDispatch?.();
    },
  };
  const deps: IdeDeviceRouteDeps = {
    resolveIdeActionDevices: async (platform, serial) => {
      calls.push(`resolve:${platform}:${serial}`);
      return { devices: devices.filter((d) => d.platform === platform), deviceId: serial };
    },
    reconcileDiscoveryObservation: async (_devices, source) => {
      calls.push(`reconcile:${source}`);
    },
    assertDeviceActionable: (deviceId, purpose) => calls.push(`actionable:${deviceId}:${purpose}`),
    isShutdownReserved: async () => false,
    assertIdeMutationOwnership: async (_request, target, action, force) => {
      calls.push(`ownership:${target.deviceId}:${action}:${force}`);
    },
    assertSocketToolEnabled: async (deviceId, toolName) => {
      calls.push(`toolEnabled:${deviceId}:${toolName}`);
    },
    keyValueClient: (platform, target) => {
      calls.push(`client:${platform}:${target.deviceId}`);
      return client;
    },
    createAdb: () => {
      throw new Error("no adb expected");
    },
    androidCtrlProxy: (target) => ({
      resumeAfterDeviceStart: () => calls.push(`android-resume:${target.deviceId}`),
      ensureCompatibleVersion: async () => {
        calls.push("android-ensure");
        return { status: "upgraded" } as never;
      },
    }),
    iosCtrlProxy: (target) => ({
      resumeAfterDeviceStart: () => calls.push(`ios-resume:${target.deviceId}`),
      forceRestart: async () => {
        calls.push("ios-restart");
      },
    }),
    ...overrides,
  };
  const routes = ideDeviceRoutes(deps);
  const ideMutation: IdeMutationCall = {
    socketSessionId: "socket",
    track: () => {},
    admit: () => {},
    dispatching: () => calls.push("dispatching"),
  };
  const call = (method: string, params?: unknown) => {
    const handler = routes.get(method);
    if (!handler) {
      throw new Error(`no route ${method}`);
    }
    const request: DaemonRequest = { id: "1", type: "mcp_request", method, params };
    return handler(request, "socket", ideMutation);
  };
  return { calls, call, routes };
}

const KV = { deviceId: "sim-1", platform: "ios", appId: "app", fileName: "f", key: "k" };

describe("ide device routes", () => {
  test("the module serves exactly these four methods", () => {
    expect([...fixture().routes.keys()].sort()).toEqual([
      "ide/clearKeyValueFile",
      "ide/removeKeyValue",
      "ide/setKeyValue",
      "ide/updateService",
    ]);
  });

  test("ide/updateService on Android gates ownership, then dispatches and ensures the service", async () => {
    const { calls, call } = fixture();
    const result = await call("ide/updateService", {
      deviceId: "emu-1",
      platform: "android",
      force: true,
    });
    expect(calls).toEqual([
      "resolve:android:emu-1",
      "reconcile:socket:ide/updateService",
      "actionable:emu-1:to update the accessibility service",
      "ownership:emu-1:ide/updateService:true",
      "dispatching",
      "android-resume:emu-1",
      "android-ensure",
    ]);
    expect(result).toEqual({
      success: true,
      message: "Accessibility service upgraded",
      status: { status: "upgraded" },
    });
  });

  test("ide/updateService reports a failed Android ensure as unsuccessful", async () => {
    const { call } = fixture({
      androidCtrlProxy: () => ({
        resumeAfterDeviceStart: () => {},
        ensureCompatibleVersion: async () => ({ status: "failed", error: "boom" }) as never,
      }),
    });
    const result = (await call("ide/updateService", {
      deviceId: "emu-1",
      platform: "android",
    })) as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toBe("Accessibility service failed: boom");
  });

  test("ide/updateService on iOS restarts CtrlProxy after the ownership gate", async () => {
    const { calls, call } = fixture();
    const result = await call("ide/updateService", { deviceId: "sim-1", platform: "ios" });
    expect(calls.slice(-4)).toEqual([
      "ownership:sim-1:ide/updateService:false",
      "dispatching",
      "ios-resume:sim-1",
      "ios-restart",
    ]);
    expect(result).toEqual({ success: true, message: "CtrlProxy iOS restarted" });
  });

  test("ide/updateService refuses an unknown device before the ownership gate", async () => {
    const { calls, call } = fixture();
    await expect(call("ide/updateService", { deviceId: "ghost", platform: "ios" })).rejects.toThrow(
      "Device not found: ghost",
    );
    expect(calls.some((entry) => entry.startsWith("ownership"))).toBe(false);
  });

  test("ide/updateService refuses a device that is shutting down", async () => {
    const { calls, call } = fixture({ isShutdownReserved: async () => true });
    await expect(call("ide/updateService", { deviceId: "sim-1", platform: "ios" })).rejects.toThrow(
      "Device 'sim-1' is shutting down.",
    );
    expect(calls.some((entry) => entry.startsWith("ownership"))).toBe(false);
  });

  test("ide/setKeyValue checks tool enablement, then ownership, then writes and reports the resolution", async () => {
    const { calls, call } = fixture();
    const result = await call("ide/setKeyValue", { ...KV, type: "STRING", value: "v" });
    expect(calls).toEqual([
      "toolEnabled:sim-1:setKeyValue",
      "resolve:ios:sim-1",
      "reconcile:socket:ide/keyValueMutation",
      "actionable:sim-1:to mutate stored values",
      "ownership:sim-1:ide/setKeyValue:false",
      "client:ios:sim-1",
      "set:app:f:k:v:STRING",
      "dispatching",
    ]);
    expect(result).toMatchObject({
      success: true,
      resolvedStore: "shared",
      effectiveValueDiffers: true,
    });
  });

  test("ide/setKeyValue with a null value removes the key", async () => {
    const { calls, call } = fixture();
    await call("ide/setKeyValue", { ...KV, type: "STRING", value: null });
    expect(calls).toContain("remove:app:f:k");
    expect(calls.some((entry) => entry.startsWith("set:"))).toBe(false);
  });

  test("ide/setKeyValue rejects a platform-incompatible type before writing", async () => {
    const { calls, call } = fixture();
    await expect(call("ide/setKeyValue", { ...KV, type: "UNKNOWN", value: "v" })).rejects.toThrow(
      "UNKNOWN type is read-only",
    );
    expect(calls.some((entry) => entry.startsWith("set:"))).toBe(false);
  });

  test("ide/setKeyValue rejects an invalid platform before resolving devices", async () => {
    const { calls, call } = fixture();
    await expect(
      call("ide/setKeyValue", { ...KV, platform: "web", type: "STRING", value: "v" }),
    ).rejects.toThrow("Invalid platform: web. Must be 'android' or 'ios'.");
    expect(calls.some((entry) => entry.startsWith("resolve:"))).toBe(false);
  });

  test("a disabled tool stops a key-value route before any device lookup", async () => {
    const { calls, call } = fixture({
      assertSocketToolEnabled: async () => {
        throw new Error("tool disabled");
      },
    });
    await expect(call("ide/removeKeyValue", KV)).rejects.toThrow("tool disabled");
    expect(calls).toEqual([]);
  });

  test("ide/removeKeyValue removes the key through the client", async () => {
    const { calls, call } = fixture();
    expect(await call("ide/removeKeyValue", KV)).toEqual({ success: true });
    expect(calls).toContain("ownership:sim-1:ide/removeKeyValue:false");
    expect(calls).toContain("remove:app:f:k");
  });

  test("ide/clearKeyValueFile clears the store through the client", async () => {
    const { calls, call } = fixture();
    expect(await call("ide/clearKeyValueFile", KV)).toEqual({ success: true });
    expect(calls).toContain("ownership:sim-1:ide/clearKeyValueFile:false");
    expect(calls).toContain("clear:app:f");
  });

  test("an Android key-value route defaults the platform and uses the Android client", async () => {
    const { calls, call } = fixture();
    await call("ide/clearKeyValueFile", { deviceId: "emu-1", appId: "app", fileName: "f" });
    expect(calls).toContain("client:android:emu-1");
    expect(calls).toContain("clear:app:f");
  });
});
