import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AppearanceSocketServer,
  defaultAppearanceDeviceSource,
  type AppearanceDeviceSource,
  type AppearanceSocketServerDependencies,
} from "../../src/daemon/appearanceSocketServer";
import type { AppearanceSocketRequest } from "../../src/daemon/wire/appearanceSocketTypes";
import type { AppearanceConfig, BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "../../src/utils/directSessionDeviceRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

class TestableServer extends AppearanceSocketServer {
  dispatch(request: AppearanceSocketRequest) {
    return this.handleRequest(request);
  }
}

const pooled: BootedDevice = { deviceId: "P", name: "Pooled", platform: "android" };
const sessionDevice: BootedDevice = { deviceId: "S", name: "Session", platform: "ios" };
const oldCurrent: BootedDevice = { deviceId: "A", name: "Unrelated", platform: "android" };

function harness(auth: boolean, source?: AppearanceDeviceSource) {
  const applied: string[] = [];
  const storedKeys: Array<string | undefined> = [];
  let config: AppearanceConfig = {
    syncWithHost: false,
    defaultMode: "light",
    applyOnConnect: true,
  };
  const dependencies: AppearanceSocketServerDependencies = {
    getConfig: async () => config,
    updateConfig: async (update, sessionKey) => {
      storedKeys.push(sessionKey);
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
  return { server, applied, storedKeys };
}

describe("appearance socket session device targets", () => {
  beforeEach(() => {
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
  });

  afterEach(() => {
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
  });

  test("production direct-session lookups trim padded session IDs", () => {
    registerDirectSessionDevice("requester", sessionDevice);
    expect(defaultAppearanceDeviceSource.getSessionDevice(" requester ")).toEqual(sessionDevice);
    expect(
      defaultAppearanceDeviceSource.getSessionForDevice(sessionDevice.deviceId, " requester "),
    ).toBe("requester");
  });

  for (const auth of [false, true]) {
    test(`production daemon lookup targets pooled assignments and ignores direct registrations (auth ${auth})`, async () => {
      const timer = new FakeTimer();
      const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      manager.stopCleanupTimer();
      const pool = new DevicePool(
        createDevicePoolDependencies(manager, "appearance-session", {
          timer,
          deviceManager: new FakeDeviceUtils(),
        }),
      );
      await pool.initializeWithDevices([pooled, sessionDevice]);
      await manager.createSession("other", pooled.deviceId, pooled.platform);
      await manager.createSession("caller", sessionDevice.deviceId, sessionDevice.platform);
      DaemonState.getInstance().initialize(manager, pool);
      expect(defaultAppearanceDeviceSource.getSessionDevice(" caller ")).toEqual(sessionDevice);
      expect(
        defaultAppearanceDeviceSource.getSessionForDevice(sessionDevice.deviceId, " caller "),
      ).toBe("caller");
      registerDirectSessionDevice("caller", oldCurrent);
      const { server, applied } = harness(auth);
      const result = await server.dispatch({
        id: "daemon",
        command: "set_appearance",
        mode: "dark",
        sessionUuid: "caller",
      });
      expect(result.success).toBe(true);
      expect(applied).toEqual(auth ? ["S"] : ["P", "S"]);
    });
  }

  for (const command of ["set_appearance", "set_appearance_sync"] as const) {
    for (const sessionUuid of ["caller", undefined]) {
      test(`${command} auth-off targets pooled devices plus only the caller's direct device (${sessionUuid})`, async () => {
        registerDirectSessionDevice("caller", sessionDevice);
        registerDirectSessionDevice("other", oldCurrent);
        const source = {
          getPooledDevices: () => [pooled],
          getCurrentDevice: () => oldCurrent,
          getSessionDevice: (uuid: string | undefined) =>
            uuid ? resolveDirectSessionDevice(uuid)?.device : undefined,
          getSessionForDevice: () => {
            throw new Error("auth-off must not look up ownership");
          },
        };
        const { server, applied, storedKeys } = harness(false, source);
        const result = await server.dispatch({
          id: "auth-off",
          command,
          mode: "dark",
          enabled: true,
          sessionUuid,
        });
        expect(result.success).toBe(true);
        expect(applied).toEqual(sessionUuid ? ["P", "S"] : ["P"]);
        expect(storedKeys).toEqual([undefined]);
      });
    }

    test(`${command} uses the production direct lookup and ownership with auth on`, async () => {
      registerDirectSessionDevice("caller", sessionDevice);
      registerDirectSessionDevice("other", oldCurrent);
      const { server, applied, storedKeys } = harness(true);
      const result = await server.dispatch({
        id: "own-direct",
        command,
        mode: "dark",
        enabled: true,
        sessionUuid: "caller",
      });
      expect(result.success).toBe(true);
      expect(applied).toEqual(["S"]);
      expect(storedKeys).toEqual(["caller"]);
    });

    test(`${command} stores config without applying for an unregistered direct caller`, async () => {
      registerDirectSessionDevice("other", oldCurrent);
      const { server, applied, storedKeys } = harness(true);
      const result = await server.dispatch({
        id: "unregistered",
        command,
        mode: "dark",
        enabled: true,
        sessionUuid: "caller",
      });
      expect(result.success).toBe(true);
      expect(applied).toEqual([]);
      expect(storedKeys).toEqual(["caller"]);
    });

    for (const sessionUuid of ["caller", undefined]) {
      test(`${command} production auth-off direct lookup with session ${sessionUuid}`, async () => {
        registerDirectSessionDevice("caller", sessionDevice);
        registerDirectSessionDevice("other", oldCurrent);
        const { server, applied, storedKeys } = harness(false);
        const result = await server.dispatch({
          id: "direct-auth-off",
          command,
          mode: "dark",
          enabled: true,
          sessionUuid,
        });
        expect(result.success).toBe(true);
        expect(applied).toEqual(sessionUuid ? ["S"] : []);
        expect(storedKeys).toEqual([undefined]);
      });
    }
  }
});
