import { IosPrototypeTransport } from "../../../../../src/features/prototype/ios/iosPrototypeTransport";
import { PrototypeAgentRequestTimeoutError } from "../../../../../src/features/prototype/ios/prototypeAgentClient";
import { FakePrototypeAgentClient } from "../../../../fakes/FakePrototypeAgentClient";
import { expect, test } from "bun:test";
import { AndroidDisposableAppAttacher } from "../../../../../src/features/prototype/disposableApp/android/AndroidDisposableAppAttacher";
import { FileDisposableAppRegistry } from "../../../../../src/features/prototype/disposableApp/DisposableAppRegistry";
import { disposableAppId } from "../../../../../src/features/prototype/disposableApp/disposableAppId";
import {
  FakeDisposableAppAdb,
  FakeDisposableAppSocket,
} from "../../../../fakes/FakeDisposableAppAttach";
import { FakePrototypeAgentConnector } from "../../../../fakes/FakePrototypeAgentSocket";
import { FakeTimer } from "../../../../fakes/FakeTimer";
import { InMemoryDisposableAppRegistryStore } from "../../../../fakes/InMemoryDisposableAppRegistryStore";

const device = { name: "fake", deviceId: "d", platform: "android" as const };
const appId = disposableAppId("android", "demo");
const token = "a".repeat(64);
async function setup() {
  const registry = new FileDisposableAppRegistry(new InMemoryDisposableAppRegistryStore());
  await registry.put("d", {
    appId,
    slug: "demo",
    platform: "android",
    label: "Demo",
    specSha256: "b".repeat(64),
    template: "base",
    signer: "host",
    installedAt: 0,
    expiresAt: null,
    specId: "panel",
    attachToken: token,
  });
  const socket = new FakeDisposableAppSocket();
  const connector = new FakePrototypeAgentConnector(socket);
  const adb = new FakeDisposableAppAdb();
  const attacher = new AndroidDisposableAppAttacher({
    registry,
    connector,
    timer: new FakeTimer(),
    adbFactory: { create: () => adb },
  });
  return { registry, socket, connector, adb, attacher };
}

test("strict port, registry token hello, replay order, dedupe and close cleanup", async () => {
  const h = await setup();
  h.socket.replay = [1, 2].map((sequence) => ({ type: "prototype_event", sequence }));
  const pending = h.attacher.attach(device, appId);
  expect(h.attacher.attach(device, appId)).toBe(pending);
  const client = await pending;
  expect(await h.attacher.attach(device, appId)).toBe(client);
  expect(h.connector.ports).toEqual([12345]);
  expect(h.socket.frames()).toEqual([
    { type: "hello", token, protocolVersion: 1, lastAcknowledgedSequence: 0 },
  ]);
  const replay: unknown[] = [];
  client.onEvent((event) => replay.push(event.sequence));
  expect(replay).toEqual([1, 2]);
  expect(h.socket.frames().slice(1)).toEqual([
    { type: "ack", sequence: 1 },
    { type: "ack", sequence: 2 },
  ]);
  h.socket.closeFromAgent();
  await Promise.resolve();
  expect(h.adb.getExecutedArgv()).toEqual([
    ["forward", "tcp:0", `localabstract:automobile-app-${appId}`],
    ["forward", "--remove", "tcp:12345"],
  ]);
  expect(await h.registry.list("d")).toHaveLength(1);
  await h.attacher.attach(device, appId);
  expect(h.connector.ports).toHaveLength(2);
  await h.attacher.release("d");
  expect(h.socket.ended).toBe(true);
});

test.each(["garbage", "123x", "0", "65536", "12\n34"])(
  "rejects invalid forward port %s",
  async (output) => {
    const h = await setup();
    h.adb.portOutput = output;
    await expect(h.attacher.attach(device, appId)).rejects.toThrow("launchApp");
    expect(h.connector.ports).toEqual([]);
  },
);

test("missing capability closes connection and removes forward", async () => {
  const h = await setup();
  h.socket.capabilities = [];
  await expect(h.attacher.attach(device, appId)).rejects.toThrow("launchApp");
  expect(h.socket.ended).toBe(true);
  expect(h.adb.getExecutedArgv().at(-1)).toEqual(["forward", "--remove", "tcp:12345"]);
});

test("refused connection has actionable guidance and no secret or cause", async () => {
  const h = await setup();
  h.connector.connectError = new Error(token);
  const error = await h.attacher.attach(device, appId).then(
    () => undefined,
    (error) => error,
  );
  expect(error.message).toContain("launchApp");
  expect(error.message).toContain(appId);
  expect(error.message).toContain("stale after a reinstall");
  expect(String(error)).not.toContain(token);
  expect(error.cause).toBeUndefined();
});

test("Android transport reuse does not misdiagnose a status timeout as iOS suspension", async () => {
  const agent = new FakePrototypeAgentClient();
  const timeout = new PrototypeAgentRequestTimeoutError("get_prototype_status", 3000);
  agent.queueReplies(timeout);
  const transport = new IosPrototypeTransport(agent, undefined, "android");
  await expect(transport.status()).rejects.toBe(timeout);
});

test("host deduplicates repeated sequences and acknowledges only after dispatch", async () => {
  const h = await setup();
  h.socket.replay = [1, 1, 2].map((sequence) => ({ type: "prototype_event", sequence }));
  const client = await h.attacher.attach(device, appId);
  const seen: unknown[] = [];
  client.onEvent((event) => {
    if (event.sequence === 3) {
      expect(h.socket.frames().at(-1)).toEqual({ type: "ack", sequence: 2 });
    }
    seen.push(event.sequence);
  });
  h.socket.push({ type: "prototype_event", sequence: 2 });
  h.socket.push({ type: "prototype_event", sequence: 3 });
  expect(seen).toEqual([1, 2, 3]);
  expect(
    h.socket
      .frames()
      .filter((frame) => frame.type === "ack")
      .map((frame) => frame.sequence),
  ).toEqual([1, 2, 2, 3]);
  await h.attacher.release("d");
});

test("a new connection starts its acknowledgement at zero after app process restart", async () => {
  const h = await setup();
  h.socket.replay = [{ type: "prototype_event", sequence: 9 }];
  await h.attacher.attach(device, appId);
  h.socket.closeFromAgent();
  const socket = new FakeDisposableAppSocket();
  socket.replay = [{ type: "prototype_event", sequence: 1 }];
  h.connector.connect = async () => socket;
  const next = await h.attacher.attach(device, appId);
  const seen: unknown[] = [];
  next.onEvent((event) => seen.push(event.sequence));
  expect(socket.frames()[0]).toMatchObject({ lastAcknowledgedSequence: 0 });
  expect(seen).toEqual([1]);
  await h.attacher.release("d");
});

test("detach before subscription leaves buffered events unacknowledged for replay", async () => {
  const h = await setup();
  h.socket.replay = [{ type: "prototype_event", sequence: 1 }];
  await h.attacher.attach(device, appId);
  expect(h.socket.frames().map((frame) => frame.type)).toEqual(["hello"]);
  h.socket.closeFromAgent();
  const socket = new FakeDisposableAppSocket();
  socket.replay = [{ type: "prototype_event", sequence: 1 }];
  h.connector.connect = async () => socket;
  const next = await h.attacher.attach(device, appId);
  const seen: unknown[] = [];
  next.onEvent((event) => seen.push(event.sequence));
  expect(seen).toEqual([1]);
  expect(socket.frames().at(-1)).toEqual({ type: "ack", sequence: 1 });
  await h.attacher.release("d");
});
