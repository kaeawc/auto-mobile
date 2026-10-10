import { describe, expect, test } from "bun:test";
import {
  assertPrototypeInjectionSupported,
  buildPrototypeAgentLaunchEnvironment,
  createPrototypeAgentConnect,
  mergeDyldInsertLibraries,
  PrototypeAgentInjector,
  prototypeAgentKey,
  PrototypeAgentRegistry,
  RetryingPrototypeAgentConnector,
  SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,
  type PrototypeAgentConnect,
} from "../../../../src/features/prototype/ios/prototypeAgentInjection";
import { PROTOTYPE_AGENT_PROTOCOL_VERSION } from "../../../../src/features/prototype/ios/prototypeAgentClient";
import { noPrototypeAgentConnections } from "../../../../src/features/prototype/ios/iosPrototypeTransport";
import type { BootedDevice } from "../../../../src/models";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import {
  FakePrototypeAgentClient,
  FakePrototypeAgentDylibResolver,
  FakePrototypeAgentPorts,
} from "../../../fakes/FakePrototypeAgentInjection";
import {
  FakePrototypeAgentConnector,
  FakePrototypeAgentSocket,
} from "../../../fakes/FakePrototypeAgentSocket";
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
const DYLIB = "/cache/prototype-agent/AutoMobilePrototypeAgent.dylib";

function harness(options: { hostEnv?: NodeJS.ProcessEnv; connect?: PrototypeAgentConnect } = {}) {
  const ports = new FakePrototypeAgentPorts();
  const registry = new PrototypeAgentRegistry(ports);
  const dylibResolver = new FakePrototypeAgentDylibResolver();
  const clients: FakePrototypeAgentClient[] = [];
  const connects: Array<{ port: number; token: string }> = [];
  const connect: PrototypeAgentConnect =
    options.connect ??
    (async (port, token) => {
      connects.push({ port, token });
      const client = new FakePrototypeAgentClient();
      clients.push(client);
      return client;
    });
  const injector = new PrototypeAgentInjector({
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

describe("buildPrototypeAgentLaunchEnvironment", () => {
  test("carries port, token and the agent library, keeping the host's inserted libraries", () => {
    const environment = buildPrototypeAgentLaunchEnvironment(
      DYLIB,
      {
        SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_PORT: "8770",
        SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_TOKEN: "token-1",
      },
      { [SIMCTL_CHILD_DYLD_INSERT_LIBRARIES]: "/a/libA.dylib", PATH: "/usr/bin" },
    );
    expect(environment).toEqual({
      SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_PORT: "8770",
      SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_TOKEN: "token-1",
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: `/a/libA.dylib:${DYLIB}`,
    });
  });
});

describe("assertPrototypeInjectionSupported", () => {
  test("accepts an app on a simulator", () => {
    expect(() => assertPrototypeInjectionSupported(SIMULATOR, BUNDLE)).not.toThrow();
  });

  test("rejects physical iOS devices and points at the SDK", () => {
    expect(() => assertPrototypeInjectionSupported(PHYSICAL, BUNDLE)).toThrow(
      /iOS simulators only.*AutoMobile iOS SDK/s,
    );
  });

  test("rejects Android, where prototypes need no injection", () => {
    expect(() => assertPrototypeInjectionSupported(ANDROID, BUNDLE)).toThrow(
      "Android prototypes need no injection",
    );
  });

  test("rejects SpringBoard and Apple system apps", () => {
    expect(() => assertPrototypeInjectionSupported(SIMULATOR, "com.apple.springboard")).toThrow(
      "SpringBoard and Apple system apps cannot be injected",
    );
    expect(() => assertPrototypeInjectionSupported(SIMULATOR, "com.apple.Preferences")).toThrow(
      "cannot inject",
    );
  });
});

describe("PrototypeAgentInjector", () => {
  test("prepare resolves the dylib, allocates a per-device+bundle port and builds the env", async () => {
    const { injector, ports, dylibResolver } = harness({
      hostEnv: { [SIMCTL_CHILD_DYLD_INSERT_LIBRARIES]: "/a/libA.dylib" },
    });

    const prepared = await injector.prepare(SIMULATOR, BUNDLE);

    expect(dylibResolver.calls).toBe(1);
    expect(ports.allocated.get(prototypeAgentKey(SIMULATOR.deviceId, BUNDLE))).toBe(8770);
    expect(prepared).toMatchObject({ port: 8770, token: "token-1" });
    expect(prepared.environment).toEqual({
      SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_PORT: "8770",
      SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_TOKEN: "token-1",
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
      `No host port is free for the prototype agent of ${BUNDLE}: No available ports`,
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

  test("relaunching with prototype closes the earlier agent and keeps its port allocation", async () => {
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
    expect(ports.allocated.get(prototypeAgentKey(SIMULATOR.deviceId, BUNDLE))).toBe(newer.port);
    expect(ports.released).toEqual([]);

    injector.abort(newer);
    expect(ports.released).toEqual([prototypeAgentKey(SIMULATOR.deviceId, BUNDLE)]);
  });
});

describe("PrototypeAgentRegistry", () => {
  async function registered() {
    const h = harness();
    const first = await h.injector.attach(await h.injector.prepare(SIMULATOR, BUNDLE));
    const other = await h.injector.attach(await h.injector.prepare(SIMULATOR, "com.example.other"));
    return { ...h, first, other };
  }

  test("require explains how to get an agent when none is recorded", () => {
    const registry = new PrototypeAgentRegistry(new FakePrototypeAgentPorts());
    expect(() => registry.require(SIMULATOR.deviceId, BUNDLE)).toThrow(
      "Relaunch with launchApp {prototype: true}",
    );
  });

  test("release closes the connection, drops the record and frees the port", async () => {
    const { registry, clients, ports } = await registered();

    registry.release(SIMULATOR.deviceId, BUNDLE);

    expect(clients[0]!.closeCount).toBe(1);
    expect(registry.getRecord(SIMULATOR.deviceId, BUNDLE)).toBeUndefined();
    expect(registry.getRecord(SIMULATOR.deviceId, "com.example.other")).toBeDefined();
    expect(ports.allocated.has(prototypeAgentKey(SIMULATOR.deviceId, BUNDLE))).toBe(false);
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
    expect(ports.allocated.has(prototypeAgentKey(SIMULATOR.deviceId, BUNDLE))).toBe(false);
    expect(registry.size()).toBe(1);
  });

  test("a stale connection closing does not drop the agent that replaced it", async () => {
    const ports = new FakePrototypeAgentPorts();
    const registry = new PrototypeAgentRegistry(ports);
    const base = {
      deviceId: SIMULATOR.deviceId,
      bundleId: BUNDLE,
      port: 8770,
      token: "t",
      dylibPath: DYLIB,
    };
    const stale = new FakePrototypeAgentClient();
    const fresh = new FakePrototypeAgentClient();
    registry.register({ ...base, client: stale, handshake: stale.handshake });
    registry.register({ ...base, client: fresh, handshake: fresh.handshake });

    stale.exit();

    expect(stale.closeCount).toBe(1);
    expect(registry.getRecord(SIMULATOR.deviceId, BUNDLE)?.client).toBe(fresh);
    expect(ports.released).toEqual([]);
  });
});

describe("PrototypeAgentRegistry as PrototypeAgentConnections", () => {
  test("get(deviceId) returns the device's newest open connection", async () => {
    const { injector, registry, clients } = harness();
    expect(registry.get(SIMULATOR.deviceId)).toBeUndefined();

    await injector.attach(await injector.prepare(SIMULATOR, BUNDLE));
    await injector.attach(await injector.prepare(SIMULATOR, "com.example.other"));

    expect(registry.get(SIMULATOR.deviceId)).toBe(clients[1]);
    expect(registry.get("other-device")).toBeUndefined();
  });

  test("a relaunch with prototype swaps in the new client object", async () => {
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

  test("noPrototypeAgentConnections never has a connection", () => {
    expect(noPrototypeAgentConnections.get(SIMULATOR.deviceId)).toBeUndefined();
  });
});

describe("RetryingPrototypeAgentConnector", () => {
  test("retries refused connections with the backoff until the listener is up", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const socket = new FakePrototypeAgentSocket();
    let refusals = 2;
    const inner = {
      async connect() {
        if (refusals-- > 0) {
          throw new Error("ECONNREFUSED");
        }
        return socket;
      },
    };

    const connected = await new RetryingPrototypeAgentConnector(inner, timer, 5).connect(8770);

    expect(connected).toBe(socket);
    expect(timer.getSleepHistory()).toEqual([200, 200]);
  });

  test("gives up after the configured attempts with the last error", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const inner = new FakePrototypeAgentConnector();
    inner.connectError = new Error("ECONNREFUSED");

    await expect(
      new RetryingPrototypeAgentConnector(inner, timer, 3).connect(8770),
    ).rejects.toThrow("ECONNREFUSED");
    expect(inner.ports).toEqual([8770, 8770, 8770]);
    expect(timer.getSleepHistory()).toEqual([200, 200]);
  });

  test("the production connect completes the authenticated handshake", async () => {
    const timer = new FakeTimer();
    const socket = new FakePrototypeAgentSocket();
    const connect = createPrototypeAgentConnect(new FakePrototypeAgentConnector(socket), timer);

    const connecting = connect(8770, "token-1");
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(socket.frames()[0]).toMatchObject({ type: "hello", token: "token-1" });
    socket.push({
      type: "hello_result",
      agentVersion: "0.1.0",
      protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION,
      capabilities: ["show_prototype"],
    });

    expect((await connecting).handshake.agentVersion).toBe("0.1.0");
  });
});
