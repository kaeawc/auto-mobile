import { describe, expect, test } from "bun:test";
import {
  assertOverlayInjectionSupported,
  buildOverlayAgentLaunchEnvironment,
  createOverlayAgentConnect,
  mergeDyldInsertLibraries,
  OverlayAgentInjector,
  overlayAgentKey,
  OverlayAgentRegistry,
  RetryingOverlayAgentConnector,
  SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,
  type OverlayAgentConnect,
} from "../../../../src/features/overlay/ios/overlayAgentInjection";
import { OVERLAY_AGENT_PROTOCOL_VERSION } from "../../../../src/features/overlay/ios/overlayAgentClient";
import { noOverlayAgentConnections } from "../../../../src/features/overlay/overlayAgentConnections";
import type { BootedDevice } from "../../../../src/models";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import {
  FakeOverlayAgentClient,
  FakeOverlayAgentDylibResolver,
  FakeOverlayAgentPorts,
} from "../../../fakes/FakeOverlayAgentInjection";
import {
  FakeOverlayAgentConnector,
  FakeOverlayAgentSocket,
} from "../../../fakes/FakeOverlayAgentSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

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
const BUNDLE = "com.example.app";
const DYLIB = "/cache/overlay-agent/AutoMobileOverlayAgent.dylib";

function harness(options: { hostEnv?: NodeJS.ProcessEnv; connect?: OverlayAgentConnect } = {}) {
  const ports = new FakeOverlayAgentPorts();
  const registry = new OverlayAgentRegistry(ports);
  const dylibResolver = new FakeOverlayAgentDylibResolver();
  const clients: FakeOverlayAgentClient[] = [];
  const connects: Array<{ port: number; token: string }> = [];
  const connect: OverlayAgentConnect =
    options.connect ??
    (async (port, token) => {
      connects.push({ port, token });
      const client = new FakeOverlayAgentClient();
      clients.push(client);
      return client;
    });
  const injector = new OverlayAgentInjector({
    dylibResolver,
    ports,
    registry,
    connect,
    idGenerator: new CountingIdGenerator("token"),
    hostEnv: options.hostEnv ?? {},
  });
  return { ports, registry, dylibResolver, clients, connects, injector };
}

describe("mergeDyldInsertLibraries", () => {
  test("uses the agent alone when nothing is inserted yet", () => {
    expect(mergeDyldInsertLibraries(undefined, DYLIB)).toBe(DYLIB);
    expect(mergeDyldInsertLibraries("", DYLIB)).toBe(DYLIB);
  });

  test("appends the agent to libraries the host already inserts", () => {
    expect(mergeDyldInsertLibraries("/a/libA.dylib:/b/libB.dylib", DYLIB)).toBe(
      `/a/libA.dylib:/b/libB.dylib:${DYLIB}`,
    );
  });

  test("does not insert the agent twice", () => {
    expect(mergeDyldInsertLibraries(`/a/libA.dylib:${DYLIB}`, DYLIB)).toBe(
      `/a/libA.dylib:${DYLIB}`,
    );
  });
});

describe("buildOverlayAgentLaunchEnvironment", () => {
  test("carries port, token and the agent library, keeping the host's inserted libraries", () => {
    const environment = buildOverlayAgentLaunchEnvironment(
      DYLIB,
      {
        SIMCTL_CHILD_AUTOMOBILE_OVERLAY_PORT: "8770",
        SIMCTL_CHILD_AUTOMOBILE_OVERLAY_TOKEN: "token-1",
      },
      { [SIMCTL_CHILD_DYLD_INSERT_LIBRARIES]: "/a/libA.dylib", PATH: "/usr/bin" },
    );
    expect(environment).toEqual({
      SIMCTL_CHILD_AUTOMOBILE_OVERLAY_PORT: "8770",
      SIMCTL_CHILD_AUTOMOBILE_OVERLAY_TOKEN: "token-1",
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: `/a/libA.dylib:${DYLIB}`,
    });
  });
});

describe("assertOverlayInjectionSupported", () => {
  test("accepts an app on a simulator", () => {
    expect(() => assertOverlayInjectionSupported(SIMULATOR, BUNDLE)).not.toThrow();
  });

  test("rejects physical iOS devices and points at the SDK", () => {
    expect(() => assertOverlayInjectionSupported(PHYSICAL, BUNDLE)).toThrow(
      /iOS simulators only.*AutoMobile iOS SDK/s,
    );
  });

  test("rejects Android, where overlays need no injection", () => {
    expect(() => assertOverlayInjectionSupported(ANDROID, BUNDLE)).toThrow(
      "Android overlays need no injection",
    );
  });

  test("rejects SpringBoard and Apple system apps", () => {
    expect(() => assertOverlayInjectionSupported(SIMULATOR, "com.apple.springboard")).toThrow(
      "SpringBoard and Apple system apps cannot be injected",
    );
    expect(() => assertOverlayInjectionSupported(SIMULATOR, "com.apple.Preferences")).toThrow(
      "cannot inject",
    );
  });
});

describe("OverlayAgentInjector", () => {
  test("prepare resolves the dylib, allocates a per-device+bundle port and builds the env", async () => {
    const { injector, ports, dylibResolver } = harness({
      hostEnv: { [SIMCTL_CHILD_DYLD_INSERT_LIBRARIES]: "/a/libA.dylib" },
    });

    const prepared = await injector.prepare(SIMULATOR, BUNDLE);

    expect(dylibResolver.calls).toBe(1);
    expect(ports.allocated.get(overlayAgentKey(SIMULATOR.deviceId, BUNDLE))).toBe(8770);
    expect(prepared).toMatchObject({ port: 8770, token: "token-1" });
    expect(prepared.environment).toEqual({
      SIMCTL_CHILD_AUTOMOBILE_OVERLAY_PORT: "8770",
      SIMCTL_CHILD_AUTOMOBILE_OVERLAY_TOKEN: "token-1",
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: `/a/libA.dylib:${DYLIB}`,
    });
  });

  test("prepare rejects a physical device before resolving the dylib or allocating a port", async () => {
    const { injector, ports, dylibResolver } = harness();
    await expect(injector.prepare(PHYSICAL, BUNDLE)).rejects.toThrow("iOS simulators only");
    expect(dylibResolver.calls).toBe(0);
    expect(ports.allocated.size).toBe(0);
  });

  test("a missing dylib fails before any port is allocated", async () => {
    const { injector, ports, dylibResolver } = harness();
    dylibResolver.error = new Error("no release checksum is pinned");
    await expect(injector.prepare(SIMULATOR, BUNDLE)).rejects.toThrow("no release checksum");
    expect(ports.allocated.size).toBe(0);
  });

  test("an exhausted port range surfaces as an actionable error", async () => {
    const { injector, ports } = harness();
    ports.allocateError = new Error("No available ports");
    await expect(injector.prepare(SIMULATOR, BUNDLE)).rejects.toThrow(
      `No host port is free for the overlay agent of ${BUNDLE}: No available ports`,
    );
  });

  test("attach connects with the launch's port and token and records the agent", async () => {
    const { injector, registry, connects } = harness();
    const prepared = await injector.prepare(SIMULATOR, BUNDLE);

    const record = await injector.attach(prepared, 4321);

    expect(connects).toEqual([{ port: 8770, token: "token-1" }]);
    expect(record).toMatchObject({
      deviceId: SIMULATOR.deviceId,
      bundleId: BUNDLE,
      pid: 4321,
      port: 8770,
      token: "token-1",
      dylibPath: DYLIB,
    });
    expect(registry.require(SIMULATOR.deviceId, BUNDLE)).toBe(record);
  });

  test("a failed connect releases the port and records nothing", async () => {
    const { injector, registry, ports } = harness({
      connect: async () => {
        throw new Error("handshake refused");
      },
    });
    const prepared = await injector.prepare(SIMULATOR, BUNDLE);

    await expect(injector.attach(prepared)).rejects.toThrow("handshake refused");

    expect(registry.getRecord(SIMULATOR.deviceId, BUNDLE)).toBeUndefined();
    expect(ports.allocated.size).toBe(0);
  });

  test("relaunching with overlay closes the earlier agent and keeps its port allocation", async () => {
    const { injector, registry, clients, ports } = harness();
    const first = await injector.prepare(SIMULATOR, BUNDLE);
    await injector.attach(first);

    const second = await injector.prepare(SIMULATOR, BUNDLE);

    expect(clients[0]!.closeCount).toBe(1);
    expect(registry.getRecord(SIMULATOR.deviceId, BUNDLE)).toBeUndefined();
    // The old process still holds the listener, so the relaunch must reuse the same port.
    expect(ports.released).toEqual([]);
    expect(second.port).toBe(first.port);
    expect(second.token).toBe("token-2");
  });

  test("a relaunch succeeds when the range has no spare port", async () => {
    const { injector, ports } = harness();
    const first = await injector.prepare(SIMULATOR, BUNDLE);
    await injector.attach(first);
    const allocate = ports.allocate.bind(ports);
    // Only the key's existing allocation is available; any new slot would throw.
    ports.allocate = (key) => {
      if (!ports.allocated.has(key)) {
        throw new Error("No available ports");
      }
      return allocate(key);
    };

    const second = await injector.prepare(SIMULATOR, BUNDLE);

    expect(second.port).toBe(first.port);
  });

  test("an older launch aborting does not free the port a newer launch owns", async () => {
    const { injector, ports } = harness();
    const older = await injector.prepare(SIMULATOR, BUNDLE);
    const newer = await injector.prepare(SIMULATOR, BUNDLE);

    injector.abort(older);
    expect(ports.allocated.get(overlayAgentKey(SIMULATOR.deviceId, BUNDLE))).toBe(newer.port);
    expect(ports.released).toEqual([]);

    injector.abort(newer);
    expect(ports.released).toEqual([overlayAgentKey(SIMULATOR.deviceId, BUNDLE)]);
  });
});

describe("OverlayAgentRegistry", () => {
  async function registered() {
    const h = harness();
    const first = await h.injector.attach(await h.injector.prepare(SIMULATOR, BUNDLE));
    const other = await h.injector.attach(await h.injector.prepare(SIMULATOR, "com.example.other"));
    return { ...h, first, other };
  }

  test("require explains how to get an agent when none is recorded", () => {
    const registry = new OverlayAgentRegistry(new FakeOverlayAgentPorts());
    expect(() => registry.require(SIMULATOR.deviceId, BUNDLE)).toThrow(
      "Relaunch with launchApp {overlay: true}",
    );
  });

  test("release closes the connection, drops the record and frees the port", async () => {
    const { registry, clients, ports } = await registered();

    registry.release(SIMULATOR.deviceId, BUNDLE);

    expect(clients[0]!.closeCount).toBe(1);
    expect(registry.getRecord(SIMULATOR.deviceId, BUNDLE)).toBeUndefined();
    expect(registry.getRecord(SIMULATOR.deviceId, "com.example.other")).toBeDefined();
    expect(ports.allocated.has(overlayAgentKey(SIMULATOR.deviceId, BUNDLE))).toBe(false);
  });

  test("releaseDevice ends every agent on the device", async () => {
    const { registry, clients, ports } = await registered();

    registry.releaseDevice(SIMULATOR.deviceId);

    expect(registry.size()).toBe(0);
    expect(clients.map((client) => client.closeCount)).toEqual([1, 1]);
    expect(ports.allocated.size).toBe(0);
  });

  test("an agent that disconnects (app exited) is dropped and its port freed", async () => {
    const { registry, clients, ports } = await registered();

    clients[0]!.exit();

    expect(registry.getRecord(SIMULATOR.deviceId, BUNDLE)).toBeUndefined();
    expect(ports.allocated.has(overlayAgentKey(SIMULATOR.deviceId, BUNDLE))).toBe(false);
    expect(registry.size()).toBe(1);
  });

  test("a stale connection closing does not drop the agent that replaced it", async () => {
    const ports = new FakeOverlayAgentPorts();
    const registry = new OverlayAgentRegistry(ports);
    const base = {
      deviceId: SIMULATOR.deviceId,
      bundleId: BUNDLE,
      port: 8770,
      token: "t",
      dylibPath: DYLIB,
    };
    const stale = new FakeOverlayAgentClient();
    const fresh = new FakeOverlayAgentClient();
    registry.register({ ...base, client: stale, handshake: stale.handshake });
    registry.register({ ...base, client: fresh, handshake: fresh.handshake });

    stale.exit();

    expect(stale.closeCount).toBe(1);
    expect(registry.getRecord(SIMULATOR.deviceId, BUNDLE)?.client).toBe(fresh);
    expect(ports.released).toEqual([]);
  });
});

describe("OverlayAgentRegistry as OverlayAgentConnections", () => {
  test("get(deviceId) returns the device's newest open connection", async () => {
    const { injector, registry, clients } = harness();
    expect(registry.get(SIMULATOR.deviceId)).toBeUndefined();

    await injector.attach(await injector.prepare(SIMULATOR, BUNDLE));
    await injector.attach(await injector.prepare(SIMULATOR, "com.example.other"));

    expect(registry.get(SIMULATOR.deviceId)).toBe(clients[1]);
    expect(registry.get("other-device")).toBeUndefined();
  });

  test("a relaunch with overlay swaps in the new client object", async () => {
    const { injector, registry, clients } = harness();
    await injector.attach(await injector.prepare(SIMULATOR, BUNDLE));
    await injector.attach(await injector.prepare(SIMULATOR, "com.example.other"));

    await injector.attach(await injector.prepare(SIMULATOR, BUNDLE));

    expect(clients[0]!.closeCount).toBe(1);
    expect(registry.get(SIMULATOR.deviceId)).toBe(clients[2]);
  });

  test("a closed connection falls back to the device's remaining open one, then none", async () => {
    const { injector, registry, clients } = harness();
    await injector.attach(await injector.prepare(SIMULATOR, BUNDLE));
    await injector.attach(await injector.prepare(SIMULATOR, "com.example.other"));

    clients[1]!.exit();
    expect(registry.get(SIMULATOR.deviceId)).toBe(clients[0]);

    registry.release(SIMULATOR.deviceId, BUNDLE);
    expect(registry.get(SIMULATOR.deviceId)).toBeUndefined();
  });

  test("noOverlayAgentConnections never has a connection", () => {
    expect(noOverlayAgentConnections.get(SIMULATOR.deviceId)).toBeUndefined();
  });
});

describe("RetryingOverlayAgentConnector", () => {
  test("retries refused connections with the backoff until the listener is up", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const socket = new FakeOverlayAgentSocket();
    let refusals = 2;
    const inner = {
      async connect() {
        if (refusals-- > 0) {
          throw new Error("ECONNREFUSED");
        }
        return socket;
      },
    };

    const connected = await new RetryingOverlayAgentConnector(inner, timer, 5).connect(8770);

    expect(connected).toBe(socket);
    expect(timer.getSleepHistory()).toEqual([200, 200]);
  });

  test("gives up after the configured attempts with the last error", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const inner = new FakeOverlayAgentConnector();
    inner.connectError = new Error("ECONNREFUSED");

    await expect(new RetryingOverlayAgentConnector(inner, timer, 3).connect(8770)).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(inner.ports).toEqual([8770, 8770, 8770]);
    expect(timer.getSleepHistory()).toEqual([200, 200]);
  });

  test("the production connect completes the authenticated handshake", async () => {
    const timer = new FakeTimer();
    const socket = new FakeOverlayAgentSocket();
    const connect = createOverlayAgentConnect(new FakeOverlayAgentConnector(socket), timer);

    const connecting = connect(8770, "token-1");
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(socket.frames()[0]).toMatchObject({ type: "hello", token: "token-1" });
    socket.push({
      type: "hello_result",
      agentVersion: "0.1.0",
      protocolVersion: OVERLAY_AGENT_PROTOCOL_VERSION,
      capabilities: ["show_overlay"],
    });

    expect((await connecting).handshake.agentVersion).toBe("0.1.0");
  });
});
