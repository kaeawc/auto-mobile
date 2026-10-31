import { describe, expect, test } from "bun:test";
import type {
  AppearanceConfig,
  AppearanceConfigInput,
  AppearanceMode,
  BootedDevice,
} from "../../src/models";
import { parseAppearanceConfig } from "../../src/features/appearance/AppearanceConfig";
import {
  AppearanceSyncScheduler,
  type AppearanceSyncTarget,
} from "../../src/daemon/AppearanceSyncScheduler";
import {
  AppearanceSocketServer,
  type AppearanceSocketServerDependencies,
} from "../../src/daemon/appearanceSocketServer";
import { appearanceSocketResponseSchema } from "../helpers/wireMessageSchemas";
import {
  ObserverAdmittingStreamAuthenticator,
  SessionScopedStreamAuthenticator,
  type StreamAuthSessionManager,
} from "../../src/daemon/streamSocketAuth";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeListeningNetServer, FakeSocket } from "../fakes/FakeNetServer";

/**
 * #10976: appearance and sync config is per session. A session's choice reaches only the devices
 * that session holds, and an observer's config applies to nothing until it holds a device.
 */

const DEFAULTS: AppearanceConfig = {
  syncWithHost: true,
  defaultMode: "auto",
  applyOnConnect: true,
};

/** In-memory per-session config store with the manager's fall-back-to-defaults behavior. */
class FakeConfigStore {
  readonly rows = new Map<string, AppearanceConfig>();

  get = async (sessionKey?: string): Promise<AppearanceConfig> =>
    this.rows.get(sessionKey ?? "") ?? DEFAULTS;

  update = async (
    update: AppearanceConfigInput | null,
    sessionKey?: string,
  ): Promise<AppearanceConfig> => {
    const next = parseAppearanceConfig({ ...(await this.get(sessionKey)), ...update });
    this.rows.set(sessionKey ?? "", next);
    return next;
  };
}

function target(deviceId: string, sessionKey?: string): AppearanceSyncTarget {
  return { deviceId, name: deviceId, platform: "android", sessionKey };
}

describe("AppearanceSyncScheduler with per-session config", () => {
  function scheduler(store: FakeConfigStore, targets: () => AppearanceSyncTarget[]) {
    const applied: string[] = [];
    const instance = new AppearanceSyncScheduler(new FakeTimer(), {
      isEnabled: () => true,
      getConfig: store.get,
      resolveMode: async (config) =>
        config?.syncWithHost ? "dark" : config?.defaultMode === "dark" ? "dark" : "light",
      getTargets: targets,
      apply: async (device: BootedDevice, mode: AppearanceMode) => {
        applied.push(`${device.deviceId}:${mode}`);
      },
    });
    return { instance, applied };
  }

  test("a session that turned sync off keeps its device while another session's device follows the host", async () => {
    const store = new FakeConfigStore();
    await store.update({ syncWithHost: false, defaultMode: "light" }, "agent-a");
    const { instance, applied } = scheduler(store, () => [
      target("emulator-5554", "agent-a"),
      target("emulator-5556", "agent-b"),
    ]);

    await instance.trigger();

    expect(applied).toEqual(["emulator-5556:dark"]);
    await instance.stop();
  });

  test("an observer's config applies to nothing until it holds a device", async () => {
    const store = new FakeConfigStore();
    await store.update({ syncWithHost: true }, "observer");
    let targets: AppearanceSyncTarget[] = [];
    const { instance, applied } = scheduler(store, () => targets);

    await instance.trigger();
    expect(applied).toEqual([]);

    targets = [target("emulator-5554", "observer")];
    await instance.trigger();
    expect(applied).toEqual(["emulator-5554:dark"]);
    await instance.stop();
  });

  test("syncDevice reads the config of the session that acquired the device", async () => {
    const store = new FakeConfigStore();
    await store.update({ syncWithHost: false, applyOnConnect: false }, "agent-a");
    const { instance, applied } = scheduler(store, () => [
      target("emulator-5554", "agent-a"),
      target("emulator-5556", "agent-b"),
    ]);

    await instance.syncDevice(target("emulator-5554", "agent-a"));
    await instance.syncDevice(target("emulator-5556", "agent-b"));

    expect(applied).toEqual(["emulator-5556:dark"]);
    await instance.stop();
  });

  test("a claim applies the holder's explicit mode although it does not follow the host (#11363)", async () => {
    const store = new FakeConfigStore();
    await store.update({ syncWithHost: false, defaultMode: "dark" }, "observer");
    const { instance, applied } = scheduler(store, () => [target("emulator-5554", "observer")]);

    await instance.syncDevice(target("emulator-5554", "observer"));
    // The host-sync tick leaves an explicit choice alone.
    await instance.trigger();

    expect(applied).toEqual(["emulator-5554:dark"]);
    await instance.stop();
  });

  test("a claim leaves the device alone when the holder neither follows the host nor applies on connect", async () => {
    const store = new FakeConfigStore();
    await store.update(
      { syncWithHost: false, defaultMode: "dark", applyOnConnect: false },
      "observer",
    );
    const { instance, applied } = scheduler(store, () => [target("emulator-5554", "observer")]);

    await instance.syncDevice(target("emulator-5554", "observer"));

    expect(applied).toEqual([]);
    await instance.stop();
  });
});

describe("AppearanceSocketServer with per-session config", () => {
  const owners = new Map([
    ["emulator-5554", "agent-a"],
    ["emulator-5556", "agent-b"],
  ]);
  const manager: StreamAuthSessionManager = {
    getSession: (uuid) => (["agent-a", "agent-b"].includes(uuid) ? {} : null),
    getSessionForDevice: (deviceId) => owners.get(deviceId) ?? null,
    getDeviceLabels: () => undefined,
  };
  const pooled = [...owners.keys()].map(
    (deviceId) => ({ deviceId, name: deviceId, platform: "android" }) as BootedDevice,
  );

  class Harness extends AppearanceSocketServer {
    markListening(): void {
      this.server = new FakeListeningNetServer();
    }

    async send(socket: FakeSocket, request: Record<string, unknown>) {
      await this.processLine(socket, JSON.stringify(request));
      await this.pendingBySocket.get(socket);
      return socket.getWrittenMessages(appearanceSocketResponseSchema).at(-1)!;
    }
  }

  function harness(
    authenticator = new SessionScopedStreamAuthenticator(() => manager, "appearance"),
  ) {
    const store = new FakeConfigStore();
    const applied: string[] = [];
    const keys: Array<string | undefined> = [];
    const dependencies: AppearanceSocketServerDependencies = {
      getConfig: store.get,
      updateConfig: async (update, sessionKey) => {
        keys.push(sessionKey);
        return store.update(update, sessionKey);
      },
      resolveMode: async () => "dark",
      applyToDevice: async (device, mode) => {
        applied.push(`${device.deviceId}:${mode}`);
      },
      triggerSync: async () => {},
      isSyncEnabled: () => true,
    };
    const server = new Harness("/fake/appearance.sock", new FakeTimer(), authenticator, {
      deviceSource: {
        getPooledDevices: () => pooled,
        getSessionDevice: () => undefined,
        getSessionForDevice: (deviceId) => owners.get(deviceId) ?? null,
      },
      dependencies,
    });
    server.markListening();
    return { server, store, applied, keys };
  }

  test("A's choice is stored under A, applied to A's device only, and invisible to B", async () => {
    const { server, store, applied } = harness();

    const response = await server.send(new FakeSocket(), {
      id: "1",
      command: "set_appearance",
      sessionUuid: "agent-a",
      params: { mode: "dark" },
    });

    expect(response.success).toBe(true);
    expect(applied).toEqual(["emulator-5554:dark"]);
    expect([...store.rows.keys()]).toEqual(["agent-a"]);
    const forB = await server.send(new FakeSocket(), {
      id: "2",
      command: "get_appearance_config",
      sessionUuid: "agent-b",
    });
    expect(forB.result?.config).toEqual(DEFAULTS);
  });

  test("an observer can store a config and nothing is applied", async () => {
    const authenticator = new ObserverAdmittingStreamAuthenticator({
      resolveSessionManager: () => manager,
      operation: "appearance",
      resolveObserverRegistry: () => ({
        resolveObserverScope: (uuid: string) =>
          uuid === "observer" ? { kind: "unowned-devices-only" } : { kind: "denied" },
      }),
    });
    const { server, store, applied } = harness(authenticator);

    const response = await server.send(new FakeSocket(), {
      id: "1",
      command: "set_appearance_sync",
      sessionUuid: "observer",
      params: { enabled: false },
    });

    expect(response.success).toBe(true);
    expect(response.result?.appliedMode).toBeUndefined();
    expect(applied).toEqual([]);
    expect(store.rows.get("observer")?.syncWithHost).toBe(false);
  });

  test("the production server admits observer sessions on its authenticator", () => {
    class Probe extends AppearanceSocketServer {
      get admittingAuthenticator(): unknown {
        return this.authenticator;
      }
    }
    const authenticator = new Probe("/fake/appearance.sock").admittingAuthenticator;
    expect(authenticator).toBeInstanceOf(ObserverAdmittingStreamAuthenticator);
  });
});
