import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AppearanceSocketServer,
  createDirectModeAppearanceDeviceSource,
  defaultAppearanceDeviceSource,
  type AppearanceDeviceSource,
  type AppearanceSocketServerDependencies,
} from "../../src/daemon/appearanceSocketServer";
import type { AppearanceSocketRequest } from "../../src/daemon/wire/appearanceSocketTypes";
import type { AppearanceConfig, BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
} from "../../src/utils/directSessionDeviceRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

class TestableServer extends AppearanceSocketServer {
  dispatch(request: AppearanceSocketRequest) {
    return this.handleRequest(request);
  }
}

const pinned: BootedDevice = { deviceId: "emulator-5556", name: "Pinned", platform: "android" };
const held: BootedDevice = { deviceId: "emulator-5558", name: "Held", platform: "android" };

function harness(auth: boolean, source: AppearanceDeviceSource) {
  const applied: string[] = [];
  let config: AppearanceConfig = {
    syncWithHost: false,
    defaultMode: "light",
    applyOnConnect: true,
  };
  const dependencies: AppearanceSocketServerDependencies = {
    getConfig: async () => config,
    updateConfig: async (update) => {
      config = { ...config, ...update } as AppearanceConfig;
      return config;
    },
    resolveMode: async () => "dark",
    applyToDevice: async (device) => {
      applied.push(device.deviceId);
    },
    triggerSync: async () => {},
    isSyncEnabled: () => true,
  };
  const server = new TestableServer(
    "/fake/appearance.sock",
    new FakeTimer(),
    { authorize: () => {}, isAuthenticationEnforced: () => auth },
    source,
    dependencies,
  );
  return { server, applied };
}

/**
 * Direct (`--no-proxy`) mode with stream auth off has no pool and no session on a sessionless
 * request, so the devices this process itself readied are the only targets left (#14375).
 */
describe("appearance socket in direct mode", () => {
  beforeEach(() => {
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
  });
  afterEach(() => {
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
  });

  for (const command of ["set_appearance", "set_appearance_sync"] as const) {
    test(`${command} without a session applies to the process's pinned and held devices`, async () => {
      registerDirectSessionDevice("held-session", held);
      const source = createDirectModeAppearanceDeviceSource(() => [pinned]);
      const { server, applied } = harness(false, source);
      const result = await server.dispatch({ id: "1", command, mode: "dark", enabled: true });
      expect(result.success).toBe(true);
      expect(result.result?.warning).toBeUndefined();
      expect(applied).toEqual(["emulator-5556", "emulator-5558"]);
    });

    test(`${command} without a session and without any device says nothing was targeted`, async () => {
      const source = createDirectModeAppearanceDeviceSource(() => []);
      const { server, applied } = harness(false, source);
      const result = await server.dispatch({ id: "2", command, mode: "dark", enabled: true });
      expect(result.success).toBe(true);
      expect(applied).toEqual([]);
      expect(result.result?.warning).toContain("No device was targeted");
    });
  }

  test("a request naming a session still targets only that session's device", async () => {
    registerDirectSessionDevice("caller", held);
    registerDirectSessionDevice("other", { ...held, deviceId: "emulator-5560" });
    const source = createDirectModeAppearanceDeviceSource(() => [pinned]);
    const { server, applied } = harness(false, source);
    await server.dispatch({
      id: "3",
      command: "set_appearance",
      mode: "dark",
      sessionUuid: "caller",
    });
    expect(applied).toEqual(["emulator-5558"]);
  });

  test("the daemon's default source is untouched: no pool, no process devices", () => {
    registerDirectSessionDevice("held-session", held);
    expect(defaultAppearanceDeviceSource.getPooledDevices()).toEqual([]);
  });
});
