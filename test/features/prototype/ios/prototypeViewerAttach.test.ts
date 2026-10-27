import { SimulatorContainerOwnershipError } from "../../../../src/utils/ios-cmdline-tools/simulatorOwnContainer";
import { cloneContainerFixture } from "../../../helpers/simulatorContainerFixture";
import {
  simulatorOwnership,
  simulatorDataContainer,
} from "../../../helpers/simulatorContainerFixture";
import { expect, test } from "bun:test";
import {
  CompositePrototypeAgentConnections,
  PrototypeViewerAttacher,
  PrototypeViewerConnections,
  createPrototypeViewerAttacher,
} from "../../../../src/features/prototype/ios/prototypeViewerAttach";
import {
  PrototypeAgentRegistry,
  type PrototypeAgentConnect,
} from "../../../../src/features/prototype/ios/prototypeAgentInjection";
import type {
  PrototypeAgentClient,
  PrototypeAgentMessage,
} from "../../../../src/features/prototype/ios/prototypeAgentClient";
import type { BootedDevice } from "../../../../src/models";
import { ActionableError } from "../../../../src/models/ActionableError";
import { FakePrototypeAgentClient } from "../../../fakes/FakePrototypeAgentClient";
import { FakePrototypeAgentPorts } from "../../../fakes/FakePrototypeAgentInjection";
import { FakePrototypeAgentConnector } from "../../../fakes/FakePrototypeAgentSocket";
import { FakeSimctl } from "../../../fakes/FakeSimctl";
import { FakeFileSystem } from "../../../fakes/FakeFileSystem";
import { FakeTimer } from "../../../fakes/FakeTimer";

const DEVICE: BootedDevice = {
  deviceId: "11111111-2222-3333-4444-555555555555",
  name: "sim",
  platform: "ios",
};
const BUNDLE = "com.example.viewer";
const TOKEN = "viewer-secret-token";
const PATH = `${simulatorDataContainer(DEVICE.deviceId)}/Library/AutoMobile/prototype-endpoint.json`;
const HANDSHAKE = {
  agentVersion: "viewer",
  protocolVersion: 1,
  capabilities: ["prototype_persistence_replay_v1", "get_prototype_status"],
};

function harness(connect?: PrototypeAgentConnect) {
  const connections = new PrototypeViewerConnections();
  const files = new FakeFileSystem();
  files.setFile(PATH, JSON.stringify({ port: 1234, token: TOKEN }));
  const simctl = new FakeSimctl();
  simctl.setContainerPath(BUNDLE, ` ${simulatorDataContainer(DEVICE.deviceId)}\n`);
  const client = new FakePrototypeAgentClient(HANDSHAKE);
  const calls: number[] = [];
  const reads: string[] = [];
  const attacher = new PrototypeViewerAttacher({
    containers: { dataContainer: async () => simulatorDataContainer(DEVICE.deviceId) },
    files: {
      readText: async (path) => {
        reads.push(path);
        return files.existsSync(path) ? files.readFile(path) : undefined;
      },
    },
    connect:
      connect ??
      (async (port, token) => {
        calls.push(port);
        expect(token).toBe(TOKEN);
        return client;
      }),
    connections,
  });
  return { attacher, connections, client, files, simctl, calls, reads };
}

test("attach registers the returned client and reads the exact endpoint path", async () => {
  const h = harness();
  const client = await h.attacher.attach(DEVICE, BUNDLE);
  expect(h.connections.get(DEVICE.deviceId)).toBe(client);
  expect(client.handshake).toEqual(HANDSHAKE);
  expect(h.reads).toEqual([PATH]);
  expect(h.calls).toEqual([1234]);
  expect((await client.request("get_prototype_status")).success).toBe(true);
  expect(h.client.requests).toHaveLength(1);
});

test("missing file explains launchApp and clean exit", async () => {
  const h = harness();
  h.files.clear();
  await expect(h.attacher.attach(DEVICE, BUNDLE)).rejects.toThrow(
    /no endpoint file.*exited cleanly.*home screen \(launchApp\)/,
  );
  expect(h.calls).toHaveLength(0);
});

test("production factory uses the argv simctl seam and rejects an empty container", async () => {
  const h = harness();
  h.simctl.setContainerPath(BUNDLE, " \n");
  const attacher = createPrototypeViewerAttacher({
    containerOwnership: simulatorOwnership,
    simctl: h.simctl,
    files: h.files,
    connections: h.connections,
    connector: new FakePrototypeAgentConnector(),
    timer: new FakeTimer(),
  });
  await expect(attacher.attach(DEVICE, BUNDLE)).rejects.toThrow(
    "No data container for the prototype viewer",
  );
  expect(h.simctl.getMethodCalls("executeCommandArgs")).toEqual([
    { args: ["get_app_container", DEVICE.deviceId, BUNDLE, "data"], timeoutMs: undefined },
  ]);
});

for (const device of [
  { ...DEVICE, platform: "android" as const },
  { ...DEVICE, deviceId: "00008110-001A2B3C4D5E6F70" },
]) {
  test(`refuses non-simulator ${device.platform} ${device.deviceId}`, async () => {
    const h = harness();
    await expect(h.attacher.attach(device, BUNDLE)).rejects.toThrow("viewers run on simulators");
    expect(h.reads).toHaveLength(0);
  });
}

test("connect failure retains cause without interpolating the secret", async () => {
  const cause = new Error(`connect failed ${TOKEN}`);
  const h = harness(async () => {
    throw cause;
  });
  try {
    await h.attacher.attach(DEVICE, BUNDLE);
    throw new Error("expected attach failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ActionableError);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("token may be stale");
    expect(error.message).toContain("one host at a time");
    expect(error.message).not.toContain(TOKEN);
  }
});

test("missing replay capability closes the client without registering", async () => {
  const client = new FakePrototypeAgentClient();
  const h = harness(async () => client);
  await expect(h.attacher.attach(DEVICE, BUNDLE)).rejects.toThrow("not a prototype viewer");
  expect(client.closed).toBe(true);
  expect(h.connections.get(DEVICE.deviceId)).toBeUndefined();
});

test("same bundle returns the live client without reading or connecting again", async () => {
  const h = harness();
  const first = await h.attacher.attach(DEVICE, BUNDLE);
  expect(await h.attacher.attach(DEVICE, BUNDLE)).toBe(first);
  expect(h.client.closed).toBe(false);
  expect(h.calls).toEqual([1234]);
  expect(h.reads).toEqual([PATH]);
});

test("different bundle closes the first before connecting; close drops only its own record", async () => {
  const raw = [new FakePrototypeAgentClient(HANDSHAKE), new FakePrototypeAgentClient(HANDSHAKE)];
  let next = 0;
  const h = harness(async () => {
    if (next === 1) {
      expect(raw[0].closed).toBe(true);
    }
    return raw[next++];
  });
  const first = await h.attacher.attach(DEVICE, BUNDLE);
  const second = await h.attacher.attach(DEVICE, "com.example.other-viewer");
  expect(raw[0].closed).toBe(true);
  expect(h.connections.get(DEVICE.deviceId)).toBe(second);
  first.close();
  expect(h.connections.get(DEVICE.deviceId)).toBe(second);
  raw[1].close();
  expect(h.connections.get(DEVICE.deviceId)).toBeUndefined();
});

test("concurrent attaches share one promise and connect", async () => {
  const h = harness();
  const first = h.attacher.attach(DEVICE, BUNDLE);
  const second = h.attacher.attach(DEVICE, BUNDLE);
  expect(second).toBe(first);
  expect(await second).toBe(await first);
  expect(h.calls).toHaveLength(1);
});

test("closed clients can be attached again", async () => {
  const raw = [new FakePrototypeAgentClient(HANDSHAKE), new FakePrototypeAgentClient(HANDSHAKE)];
  let next = 0;
  const h = harness(async () => raw[next++]);
  const first = await h.attacher.attach(DEVICE, BUNDLE);
  first.close();
  const second = await h.attacher.attach(DEVICE, BUNDLE);
  expect(second).not.toBe(first);
  expect(next).toBe(2);
});

test("release matches the bundle and releaseDevice closes the remaining viewer", async () => {
  const h = harness();
  await h.attacher.attach(DEVICE, BUNDLE);
  h.connections.release(DEVICE.deviceId, "other");
  expect(h.client.closed).toBe(false);
  h.connections.releaseDevice(DEVICE.deviceId);
  expect(h.client.closed).toBe(true);
  expect(h.connections.get(DEVICE.deviceId)).toBeUndefined();
});

test("failed in-flight attach is cleared for retry", async () => {
  let attempts = 0;
  const raw = new FakePrototypeAgentClient(HANDSHAKE);
  const h = harness(async () => {
    if (attempts++ === 0) {
      throw new Error("refused");
    }
    return raw;
  });
  await expect(h.attacher.attach(DEVICE, BUNDLE)).rejects.toThrow(ActionableError);
  expect<unknown>(await h.attacher.attach(DEVICE, BUNDLE)).toBe(h.connections.get(DEVICE.deviceId));
  expect(attempts).toBe(2);
});

test("replay before subscription arrives in order once, followed by live events", async () => {
  const h = harness();
  const client = await h.attacher.attach(DEVICE, BUNDLE);
  const events = [1, 2, 3].map((sequence) => ({ type: "prototype_event", sequence }));
  h.client.emit(events[0]);
  h.client.emit(events[1]);
  const first: PrototypeAgentMessage[] = [];
  const second: PrototypeAgentMessage[] = [];
  const unsubscribe = client.onEvent((event) => first.push(event));
  client.onEvent((event) => second.push(event));
  h.client.emit(events[2]);
  expect(first).toEqual(events);
  expect(second).toEqual([events[2]]);
  unsubscribe();
  h.client.emit(events[2]);
  expect(first).toEqual(events);
});

test("replay buffer is capped at 256 events", async () => {
  const h = harness();
  const client = await h.attacher.attach(DEVICE, BUNDLE);
  for (let sequence = 0; sequence < 258; sequence++) {
    h.client.emit({ type: "prototype_event", sequence });
  }
  const events: PrototypeAgentMessage[] = [];
  client.onEvent((event) => events.push(event));
  expect(events).toHaveLength(256);
  expect(events[0].sequence).toBe(2);
  expect(events[255].sequence).toBe(257);
});

test("production buffers replay coalesced with hello_result and partial frames", async () => {
  const h = harness();
  const connector = new FakePrototypeAgentConnector();
  const timer = new FakeTimer();
  const attacher = createPrototypeViewerAttacher({
    containerOwnership: simulatorOwnership,
    simctl: h.simctl,
    files: h.files,
    connector,
    timer,
    connections: h.connections,
  });
  const pending = attacher.attach(DEVICE, BUNDLE);
  for (let turn = 0; turn < 12 && connector.socket.written.length === 0; turn++) {
    await Promise.resolve();
  }
  expect(connector.socket.frames()[0]).toEqual({ type: "hello", token: TOKEN, protocolVersion: 1 });
  connector.socket.pushRaw(
    `${JSON.stringify({ type: "hello_result", ...HANDSHAKE })}\n{"type":"prototype_event","sequence":1}\n{"type":"prototype_event",`,
  );
  connector.socket.pushRaw('"sequence":2}\n');
  const client = await pending;
  const events: PrototypeAgentMessage[] = [];
  client.onEvent((event) => events.push(event));
  expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  connector.socket.push({ type: "prototype_event", sequence: 3 });
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  connector.socket.closeFromAgent();
  expect(h.connections.get(DEVICE.deviceId)).toBeUndefined();
  expect(timer.getPendingTimeouts()).toHaveLength(0);
});

test("composite prefers viewer and falls back to an injected registry with fakes", () => {
  const viewers = new PrototypeViewerConnections();
  const injected = new PrototypeAgentRegistry(new FakePrototypeAgentPorts());
  const composite = new CompositePrototypeAgentConnections(viewers, injected);
  expect(composite.get(DEVICE.deviceId)).toBeUndefined();
  const agent = new FakePrototypeAgentClient();
  injected.register({
    deviceId: DEVICE.deviceId,
    bundleId: "injected",
    port: 1235,
    token: TOKEN,
    dylibPath: "/agent",
    client: agent,
    handshake: agent.handshake,
  });
  expect(composite.get(DEVICE.deviceId)).toBe(agent);
  const viewer: PrototypeAgentClient = new FakePrototypeAgentClient(HANDSHAKE);
  viewers.record(DEVICE.deviceId, { bundleId: BUNDLE, client: viewer });
  expect(composite.get(DEVICE.deviceId)).toBe(viewer);
  viewer.close();
  expect(composite.get(DEVICE.deviceId)).toBe(agent);
  agent.close();
  expect(composite.get(DEVICE.deviceId)).toBeUndefined();
});

test("reentrant live pushes cannot overtake buffered replay", async () => {
  const h = harness();
  const client = await h.attacher.attach(DEVICE, BUNDLE);
  h.client.emit({ type: "prototype_event", sequence: 1 });
  h.client.emit({ type: "prototype_event", sequence: 2 });
  const sequences: unknown[] = [];
  client.onEvent((event) => {
    sequences.push(event.sequence);
    if (event.sequence === 1) {
      h.client.emit({ type: "prototype_event", sequence: 3 });
    }
  });
  expect(sequences).toEqual([1, 2, 3]);
});

test("production missing endpoint does not attempt a connection", async () => {
  const h = harness();
  h.files.clear();
  const connector = new FakePrototypeAgentConnector();
  const attacher = createPrototypeViewerAttacher({
    containerOwnership: simulatorOwnership,
    simctl: h.simctl,
    files: h.files,
    connector,
    timer: new FakeTimer(),
    connections: h.connections,
  });
  await expect(attacher.attach(DEVICE, BUNDLE)).rejects.toThrow("no endpoint file");
  expect(connector.ports).toHaveLength(0);
});

test("production handshake refusal is actionable and closes the socket", async () => {
  const h = harness();
  const connector = new FakePrototypeAgentConnector();
  const timer = new FakeTimer();
  const attacher = createPrototypeViewerAttacher({
    containerOwnership: simulatorOwnership,
    simctl: h.simctl,
    files: h.files,
    connector,
    timer,
    connections: h.connections,
  });
  const pending = attacher.attach(DEVICE, BUNDLE);
  for (let turn = 0; turn < 12 && connector.socket.written.length === 0; turn++) {
    await Promise.resolve();
  }
  expect(connector.socket.written).toHaveLength(1);
  connector.socket.closeFromAgent();
  await expect(pending).rejects.toThrow("one host at a time");
  expect(connector.socket.ended).toBe(true);
  expect(h.connections.get(DEVICE.deviceId)).toBeUndefined();
  expect(timer.getPendingTimeouts()).toHaveLength(0);
});

test("production close after hello before registration cannot leave a stale viewer", async () => {
  const h = harness();
  const connector = new FakePrototypeAgentConnector();
  const attacher = createPrototypeViewerAttacher({
    containerOwnership: simulatorOwnership,
    simctl: h.simctl,
    files: h.files,
    connector,
    timer: new FakeTimer(),
    connections: h.connections,
  });
  const pending = attacher.attach(DEVICE, BUNDLE);
  for (let turn = 0; turn < 12 && connector.socket.written.length === 0; turn++) {
    await Promise.resolve();
  }
  connector.socket.push({ type: "hello_result", ...HANDSHAKE });
  connector.socket.closeFromAgent();
  await expect(pending).rejects.toThrow(ActionableError);
  expect(h.connections.get(DEVICE.deviceId)).toBeUndefined();
});

for (const proven of [true, false]) {
  test(`prototype viewer attach clone ownership: ${proven}`, async () => {
    const clone = cloneContainerFixture(DEVICE.deviceId, proven ? BUNDLE : null);
    const h = harness();
    h.simctl.setContainerPath(BUNDLE, clone.reported);
    const reads: string[] = [];
    const connector = new FakePrototypeAgentConnector();
    const attacher = createPrototypeViewerAttacher({
      containerOwnership: clone.ownership,
      simctl: h.simctl,
      files: {
        existsSync: (path) => {
          reads.push(String(path));
          return true;
        },
        readFile: async () => JSON.stringify({ port: 1234, token: TOKEN }),
      },
      connector,
      timer: new FakeTimer(),
      connections: h.connections,
    });
    if (!proven) {
      await expect(attacher.attach(DEVICE, BUNDLE)).rejects.toBeInstanceOf(
        SimulatorContainerOwnershipError,
      );
      expect(reads).toEqual([]);
    } else {
      const pending = attacher.attach(DEVICE, BUNDLE);
      for (let turn = 0; turn < 30 && connector.socket.written.length === 0; turn++) {
        await Promise.resolve();
      }
      connector.socket.push({ type: "hello_result", ...HANDSHAKE });
      const client = await pending;
      client.close();
      expect(reads).toEqual([`${clone.own}/Library/AutoMobile/prototype-endpoint.json`]);
    }
  });
}
