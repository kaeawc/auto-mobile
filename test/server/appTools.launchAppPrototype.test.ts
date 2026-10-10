import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerAppTools,
  resetLaunchAppToolDependencies,
  resetTerminateAppToolDependencies,
  setLaunchAppToolDependencies,
  setTerminateAppToolDependencies,
} from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import type { BootedDevice, LaunchAppResult, ObserveResult } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import {
  PrototypeAgentInjector,
  prototypeAgentKey,
  PrototypeAgentRegistry,
  type PrototypeAgentConnect,
} from "../../src/features/prototype/ios/prototypeAgentInjection";
import {
  FakePrototypeAgentClient,
  FakePrototypeAgentDylibResolver,
  FakePrototypeAgentPorts,
} from "../fakes/FakePrototypeAgentInjection";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";

const SIMULATOR: BootedDevice = {
  deviceId: "11111111-2222-3333-4444-555555555555",
  name: "iPhone 17",
  platform: "ios",
};
const PHYSICAL: BootedDevice = {
  deviceId: "00008110-001A2B3C4D5E6F70",
  name: "iPhone",
  platform: "ios",
};
const ANDROID: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const APP = "com.example.app";

interface LaunchCall {
  coldBoot: boolean;
  launchEnvironment?: Record<string, string>;
}

type ToolResponse = { isError?: true; content: Array<{ type: string; text: string }> };

function setup(options: { launchResult?: LaunchAppResult; connect?: PrototypeAgentConnect } = {}) {
  const ports = new FakePrototypeAgentPorts();
  const registry = new PrototypeAgentRegistry(ports);
  const dylibResolver = new FakePrototypeAgentDylibResolver();
  const clients: FakePrototypeAgentClient[] = [];
  const launches: LaunchCall[] = [];
  let injectorsCreated = 0;
  const observation = {
    activeWindow: { appId: APP, activityName: "Main", layoutSeqSum: 1 },
  } as ObserveResult;
  setLaunchAppToolDependencies({
    createLaunchApp: () => ({
      execute: async (
        appId,
        _clear,
        coldBoot,
        _activity,
        _user,
        _skip,
        _signal,
        _args,
        launchEnvironment,
      ) => {
        launches.push({ coldBoot: coldBoot ?? false, launchEnvironment });
        return (
          options.launchResult ?? { success: true, packageName: appId, pid: 4321, observation }
        );
      },
    }),
    prototypeAgentRegistry: registry,
    createPrototypeAgentInjector: (sharedRegistry) => {
      injectorsCreated++;
      return new PrototypeAgentInjector({
        dylibResolver,
        ports,
        registry: sharedRegistry,
        connect:
          options.connect ??
          (async () => {
            const client = new FakePrototypeAgentClient();
            clients.push(client);
            return client;
          }),
        idGenerator: new CountingIdGenerator("token"),
        hostEnv: {},
      });
    },
  });
  return {
    ports,
    registry,
    dylibResolver,
    clients,
    launches,
    injectorsCreated: () => injectorsCreated,
  };
}

const launch = (device: BootedDevice, args: Record<string, unknown>) =>
  ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(device, {
    appId: APP,
    ...args,
  }) as Promise<ToolResponse>;

describe("launchApp prototype:true (#10567)", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    SessionReleaseBroadcaster.clearForTesting();
    resetLaunchAppToolDependencies();
    resetTerminateAppToolDependencies();
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    SessionReleaseBroadcaster.clearForTesting();
    resetLaunchAppToolDependencies();
    resetTerminateAppToolDependencies();
  });

  test("a normal launch injects nothing and never resolves the agent", async () => {
    const h = setup();

    await launch(SIMULATOR, {});

    expect(h.launches).toEqual([{ coldBoot: false, launchEnvironment: undefined }]);
    expect(h.injectorsCreated()).toBe(0);
    expect(h.dylibResolver.calls).toBe(0);
    expect(h.registry.size()).toBe(0);
  });

  test("relaunches with the agent environment, connects and records the agent", async () => {
    const h = setup();

    const response = await launch(SIMULATOR, { prototype: true });

    expect(h.launches).toEqual([
      {
        coldBoot: true,
        launchEnvironment: {
          SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_PORT: "8770",
          SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_TOKEN: "token-1",
          SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: h.dylibResolver.resolved.path,
        },
      },
    ]);
    expect(h.registry.require(SIMULATOR.deviceId, APP)).toMatchObject({
      pid: 4321,
      port: 8770,
      token: "token-1",
    });
    expect(response.isError).toBeUndefined();
    const payload = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(payload.prototypeAgent).toEqual({
      port: 8770,
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["show_prototype", "dismiss_prototype"],
    });
    expect(String(payload.message)).toContain("prototype agent 0.1.0 connected");
    // The auth token never leaves the daemon.
    expect(response.content[0]!.text).not.toContain("token-1");
  });

  test.each([
    ["a physical iOS device", PHYSICAL, "AutoMobile iOS SDK"],
    ["Android", ANDROID, "Android prototypes need no injection"],
  ])("rejects %s before launching anything", async (_name, device, message) => {
    const h = setup();

    await expect(launch(device, { prototype: true })).rejects.toThrow(message);

    expect(h.launches).toEqual([]);
    expect(h.ports.allocated.size).toBe(0);
  });

  test("rejects system apps before launching anything", async () => {
    const h = setup();

    await expect(
      ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(SIMULATOR, {
        appId: "com.apple.springboard",
        prototype: true,
      }),
    ).rejects.toThrow("SpringBoard and Apple system apps cannot be injected");
    expect(h.launches).toEqual([]);
  });

  test("a failed launch frees the port and records nothing", async () => {
    const h = setup({
      launchResult: { success: false, packageName: APP, error: "App is not installed" },
    });

    await expect(launch(SIMULATOR, { prototype: true })).rejects.toThrow("App is not installed");

    expect(h.ports.allocated.size).toBe(0);
    expect(h.registry.size()).toBe(0);
  });

  test("a failed handshake frees the port and records nothing", async () => {
    const h = setup({
      connect: async () => {
        throw new Error("closed the connection during the handshake");
      },
    });

    await expect(launch(SIMULATOR, { prototype: true })).rejects.toThrow("during the handshake");

    expect(h.ports.allocated.size).toBe(0);
    expect(h.registry.size()).toBe(0);
  });

  test("terminateApp drops the record, closes the connection and frees the port", async () => {
    const h = setup();
    setTerminateAppToolDependencies({
      createTerminateApp: () => ({
        execute: async () => ({ success: true, packageName: APP, wasRunning: true }),
      }),
    });
    await launch(SIMULATOR, { prototype: true });

    await ToolRegistry.getTool("terminateApp")!.deviceAwareHandler!(SIMULATOR, { appId: APP });

    expect(h.registry.getRecord(SIMULATOR.deviceId, APP)).toBeUndefined();
    expect(h.clients[0]!.closeCount).toBe(1);
    expect(h.ports.released).toEqual([prototypeAgentKey(SIMULATOR.deviceId, APP)]);
  });

  test("a failed terminateApp keeps the agent record and connection", async () => {
    const h = setup();
    setTerminateAppToolDependencies({
      createTerminateApp: () => ({
        execute: async () => ({ success: false, error: "devicectl failed" }),
      }),
    });
    await launch(SIMULATOR, { prototype: true });

    await expect(
      ToolRegistry.getTool("terminateApp")!.deviceAwareHandler!(SIMULATOR, { appId: APP }),
    ).rejects.toThrow("devicectl failed");

    expect(h.registry.getRecord(SIMULATOR.deviceId, APP)).toBeDefined();
    expect(h.clients[0]!.closeCount).toBe(0);
    expect(h.ports.released).toEqual([]);
  });

  test("releasing the session ends the agents on its device", async () => {
    const h = setup();
    await launch(SIMULATOR, { prototype: true });

    SessionReleaseBroadcaster.emit("session-1", "explicit-release", {
      deviceId: SIMULATOR.deviceId,
    } as SessionReleaseSnapshot);

    expect(h.registry.size()).toBe(0);
    expect(h.clients[0]!.closeCount).toBe(1);
  });

  test("an upgrade-only re-announcement leaves the device's next owner's agents alone (#11206)", async () => {
    const h = setup();
    await launch(SIMULATOR, { prototype: true });

    SessionReleaseBroadcaster.emit(
      "earlier-owner",
      "explicit-release",
      { deviceId: SIMULATOR.deviceId } as SessionReleaseSnapshot,
      { upgradeOnly: true },
    );

    expect(h.registry.size()).toBe(1);
    expect(h.clients[0]!.closeCount).toBe(0);
  });
});
