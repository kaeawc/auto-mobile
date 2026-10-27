import { describe, expect, test } from "bun:test";
import {
  AppearanceSocketServer,
  type AppearanceDeviceSource,
  type AppearanceSocketServerDependencies,
} from "../../src/daemon/appearanceSocketServer";
import type { AppearanceSocketRequest } from "../../src/daemon/wire/appearanceSocketTypes";
import type { AppearanceConfig, BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

class TestableServer extends AppearanceSocketServer {
  dispatch(request: AppearanceSocketRequest) {
    return this.handleRequest(request);
  }
}

const CALLER_DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "pixel",
  platform: "android",
};

/**
 * The stream authenticator accepts a padded session UUID by trimming it, so the device lookups
 * must use the same trimmed UUID or the caller's device is silently skipped (#14379).
 */
describe("appearance socket session lookup", () => {
  test.each([" caller ", "caller"])(
    "set_appearance applies to the device of session %j",
    async (sessionUuid) => {
      const applied: string[] = [];
      let config: AppearanceConfig = {
        defaultMode: "light",
        syncWithHost: false,
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
        isSyncEnabled: () => false,
      };
      const deviceSource: AppearanceDeviceSource = {
        getPooledDevices: () => [],
        getSessionDevice: (uuid) => (uuid === "caller" ? CALLER_DEVICE : undefined),
        getSessionForDevice: (deviceId, uuid) =>
          deviceId === CALLER_DEVICE.deviceId && uuid === "caller" ? "caller" : null,
      };
      const server = new TestableServer(
        "/fake/appearance.sock",
        new FakeTimer(),
        {
          authorize: () => {},
          isAuthenticationEnforced: () => true,
          resolveSessionIdentity: (uuid) => uuid?.trim() || undefined,
        },
        deviceSource,
        dependencies,
      );

      const response = await server.dispatch({
        id: "trim",
        command: "set_appearance",
        mode: "dark",
        sessionUuid,
      });

      expect(response).toMatchObject({ success: true });
      expect(applied).toEqual([CALLER_DEVICE.deviceId]);
    },
  );
});
