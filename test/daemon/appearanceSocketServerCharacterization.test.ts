import { describe, expect, test } from "bun:test";
import {
  AppearanceSocketServer,
  type AppearanceSocketServerDependencies,
} from "../../src/daemon/appearanceSocketServer";
import type { AppearanceSocketRequest } from "../../src/daemon/appearanceSocketTypes";
import type { AppearanceConfig } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

class TestableServer extends AppearanceSocketServer {
  dispatch(request: AppearanceSocketRequest) {
    return this.handleRequest(request);
  }
}

function setup(failure?: "update" | "sync") {
  const calls: string[] = [];
  let config: AppearanceConfig = {
    defaultMode: "light",
    syncWithHost: false,
    applyOnConnect: true,
  };
  const dependencies: AppearanceSocketServerDependencies = {
    getConfig: async () => config,
    updateConfig: async (update) => {
      calls.push("update");
      if (failure === "update") {
        throw new Error("update failed");
      }
      config = { ...config, ...update } as AppearanceConfig;
      return config;
    },
    resolveMode: async () => {
      calls.push("resolve");
      return "dark";
    },
    applyToDevice: async () => {
      calls.push("apply");
    },
    triggerSync: async () => {
      calls.push("sync");
      if (failure === "sync") {
        throw new Error("sync failed");
      }
    },
    isSyncEnabled: () => true,
  };
  const server = new TestableServer(
    "/fake/appearance.sock",
    new FakeTimer(),
    {
      authorize: () => {
        calls.push("authorize");
      },
      isAuthenticationEnforced: () => false,
    },
    {
      getPooledDevices: () => [{ deviceId: "device", name: "device", platform: "android" }],
      getCurrentDevice: () => undefined,
      getSessionForDevice: () => null,
    },
    dependencies,
  );
  return { server, calls };
}

describe("appearance mutation ordering characterization", () => {
  for (const command of ["set_appearance", "set_appearance_sync"] as const) {
    test(`${command} authorizes, persists, applies, then triggers sync`, async () => {
      const { server, calls } = setup();
      const response = await server.dispatch({
        id: "ordered",
        command,
        mode: "auto",
        enabled: true,
      });
      expect(calls).toEqual(["authorize", "update", "resolve", "apply", "sync"]);
      expect(response).toMatchObject({
        id: "ordered",
        success: true,
        result: { appliedMode: "dark" },
      });
    });

    for (const failure of ["update", "sync"] as const) {
      test(`${command} propagates ${failure} failure in order`, async () => {
        const { server, calls } = setup(failure);
        await expect(server.dispatch({ command, mode: "auto", enabled: true })).rejects.toThrow(
          `${failure} failed`,
        );
        expect(calls).toEqual(
          failure === "update"
            ? ["authorize", "update"]
            : ["authorize", "update", "resolve", "apply", "sync"],
        );
      });
    }
  }
});
