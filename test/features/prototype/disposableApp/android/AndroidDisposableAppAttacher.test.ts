import { IosPrototypeTransport } from "../../../../../src/features/prototype/ios/iosPrototypeTransport";
import { PrototypeAgentRequestTimeoutError } from "../../../../../src/features/prototype/ios/prototypeAgentClient";
import { FakePrototypeAgentClient } from "../../../../fakes/FakePrototypeAgentClient";
import { PrototypeEventCoordinator } from "../../../../../src/features/prototype/PrototypeEventCoordinator";
import { InMemoryPrototypeStatusStore } from "../../../../../src/features/prototype/PrototypeStatusStore";
import { prototypeEventSource } from "../../../../../src/features/prototype/PrototypeTransport";
import { event } from "../../../../helpers/prototypeTestEvent";
import { settleByFakeEvents } from "../../../../helpers/fakeTimerStepping";
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
  const timer = new FakeTimer();
  const attacher = new AndroidDisposableAppAttacher({
    registry,
    connector,
    timer,
    adbFactory: { create: () => adb },
  });
  return { registry, socket, connector, adb, attacher, timer };
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

test("reconnect hello resumes the delivered epoch and resets after a process change", async () => {
  const h = await setup();
  h.socket.appInstanceId = "first-process";
  h.socket.replay = [{ type: "prototype_event", sequence: 9 }];
  const first = await h.attacher.attach(device, appId);
  first.onEvent(() => {});
  h.socket.closeFromAgent();

  const second = new FakeDisposableAppSocket();
  second.appInstanceId = "first-process";
  second.replay = [9, 10].map((sequence) => ({ type: "prototype_event", sequence }));
  h.connector.connect = async () => second;
  const resumed = await h.attacher.attach(device, appId);
  expect(second.frames()[0]).toMatchObject({
    appInstanceId: "first-process",
    lastAcknowledgedSequence: 9,
  });
  const seen: unknown[] = [];
  resumed.onEvent((event) => seen.push(event.sequence));
  expect(seen).toEqual([10]);
  second.closeFromAgent();

  const third = new FakeDisposableAppSocket();
  third.appInstanceId = "new-process";
  third.replay = [{ type: "prototype_event", sequence: 1 }];
  h.connector.connect = async () => third;
  const restarted = await h.attacher.attach(device, appId);
  expect(third.frames()[0]).toMatchObject({
    appInstanceId: "first-process",
    lastAcknowledgedSequence: 10,
  });
  restarted.onEvent((event) => seen.push(event.sequence));
  expect(seen).toEqual([10, 1]);
  await h.attacher.release("d");

  const fourth = new FakeDisposableAppSocket();
  fourth.appInstanceId = "new-process";
  h.connector.connect = async () => fourth;
  await h.attacher.attach(device, appId);
  expect(fourth.frames()[0]).toEqual({
    type: "hello",
    token,
    protocolVersion: 1,
    lastAcknowledgedSequence: 0,
  });
  await h.attacher.release("d");
});

test("resume cursors are isolated by both installed app and device", async () => {
  const h = await setup();
  h.socket.appInstanceId = "process";
  h.socket.replay = [{ type: "prototype_event", sequence: 9 }];
  const first = await h.attacher.attach(device, appId);
  first.onEvent(() => {});
  h.socket.closeFromAgent();
  const record = (await h.registry.list(device.deviceId))[0]!;
  const otherAppId = disposableAppId("android", "other");
  await h.registry.put(device.deviceId, { ...record, appId: otherAppId, slug: "other" });
  await h.registry.put("other-device", record);
  for (const [nextDevice, nextAppId] of [
    [device, otherAppId],
    [{ ...device, deviceId: "other-device" }, appId],
  ] as const) {
    const socket = new FakeDisposableAppSocket();
    socket.appInstanceId = "process";
    socket.replay = [{ type: "prototype_event", sequence: 1 }];
    h.connector.connect = async () => socket;
    const client = await h.attacher.attach(nextDevice, nextAppId);
    expect(socket.frames()[0]).toEqual({
      type: "hello",
      token,
      protocolVersion: 1,
      lastAcknowledgedSequence: 0,
    });
    const seen: unknown[] = [];
    client.onEvent((event) => seen.push(event.sequence));
    expect(seen).toEqual([1]);
    await h.attacher.release(nextDevice.deviceId);
  }
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

test("an empty await timeout retains later interactions until a consumer subscribes again", async () => {
  const h = await setup();
  const client = await h.attacher.attach(device, appId);
  const source = prototypeEventSource(new IosPrototypeTransport(client, undefined, "android"));
  const coordinator = new PrototypeEventCoordinator(h.timer, new InMemoryPrototypeStatusStore());
  const scope = { deviceId: device.deviceId };
  const wait = () => coordinator.awaitEvent(scope, "panel", source, { timeoutMs: 10 });
  try {
    expect(
      await settleByFakeEvents(h.timer, wait(), { description: "empty event wait" }),
    ).toMatchObject({ timedOut: true });
    h.socket.push({ ...event(1) });
    expect(h.socket.frames().filter((frame) => frame.type === "ack")).toEqual([]);
    expect(
      await settleByFakeEvents(h.timer, wait(), { description: "buffered interaction" }),
    ).toMatchObject({ event: { sequence: 1 } });
    expect(h.socket.frames().filter((frame) => frame.type === "ack")).toEqual([
      { type: "ack", sequence: 1 },
    ]);
    coordinator.dispose();
    h.socket.push({ ...event(2) });
    expect(h.socket.frames().filter((frame) => frame.type === "ack")).toEqual([
      { type: "ack", sequence: 1 },
    ]);
  } finally {
    coordinator.dispose();
    await h.attacher.release(device.deviceId);
  }
});

test("idle buffer overflow reconnects without cumulatively acknowledging dropped events", async () => {
  const h = await setup();
  const client = await h.attacher.attach(device, appId);
  const seen: unknown[] = [];
  const unsubscribe = client.onEvent((message) => seen.push(message.sequence));
  h.socket.push({ ...event(1) });
  unsubscribe();
  for (let sequence = 2; sequence <= 258; sequence++) {
    h.socket.push({ ...event(sequence) });
  }
  expect(h.socket.ended).toBe(true);
  expect(h.socket.frames().filter((frame) => frame.type === "ack")).toEqual([
    { type: "ack", sequence: 1 },
  ]);
  const replay = new FakeDisposableAppSocket();
  replay.replay = [2, 3].map((sequence) => ({ ...event(sequence) }));
  h.connector.connect = async () => replay;
  const next = await h.attacher.attach(device, appId);
  expect(replay.frames()[0]).toMatchObject({ lastAcknowledgedSequence: 1 });
  next.onEvent((message) => seen.push(message.sequence));
  expect(seen).toEqual([1, 2, 3]);
  await h.attacher.release(device.deviceId);
});

test("oversized handshake replay is refused without acknowledging a locally truncated replay", async () => {
  const h = await setup();
  h.socket.replay = Array.from({ length: 257 }, (_, index) => ({ ...event(index + 1) }));
  await expect(h.attacher.attach(device, appId)).rejects.toThrow("launchApp");
  expect(h.socket.ended).toBe(true);
  expect(h.socket.frames().filter((frame) => frame.type === "ack")).toEqual([]);
});

test("disposal waits for a pending attachment, releases it once and refuses later attaches", async () => {
  const h = await setup();
  const connected = Promise.withResolvers<FakeDisposableAppSocket>();
  h.connector.connect = () => connected.promise;
  const attaching = h.attacher.attach(device, appId);
  const disposal = h.attacher.dispose();
  expect(h.attacher.dispose()).toBe(disposal);
  connected.resolve(h.socket);
  await attaching;
  await disposal;
  expect(h.socket.ended).toBe(true);
  expect(h.adb.getExecutedArgv()).toEqual([
    ["forward", "tcp:0", `localabstract:automobile-app-${appId}`],
    ["forward", "--remove", "tcp:12345"],
  ]);
  await expect(h.attacher.attach(device, appId)).rejects.toThrow("disposed");
});

test("forgetting an uninstalled app prunes its cursor after the socket has closed", async () => {
  const h = await setup();
  h.socket.appInstanceId = "process";
  h.socket.replay = [{ type: "prototype_event", sequence: 9 }];
  const client = await h.attacher.attach(device, appId);
  client.onEvent(() => {});
  h.socket.closeFromAgent();
  await h.attacher.forget(device.deviceId, appId);
  const socket = new FakeDisposableAppSocket();
  h.connector.connect = async () => socket;
  await h.attacher.attach(device, appId);
  expect(socket.frames()[0]).toEqual({
    type: "hello",
    token,
    protocolVersion: 1,
    lastAcknowledgedSequence: 0,
  });
  await h.attacher.release(device.deviceId);
});

test("showing identity survives handshake and refreshes on the same socket without resetting delivery", async () => {
  const h = await setup();
  h.socket.appInstanceId = "process";
  h.socket.showingId = "first-show";
  h.socket.replay = [{ ...event(9) }];
  const client = await h.attacher.attach(device, appId);
  const transport = new IosPrototypeTransport(client, undefined, "android");
  const source = prototypeEventSource(transport);
  expect(source.instanceId).toBe("process");
  expect(source.showingId).toBe("first-show");
  const seen: unknown[] = [];
  client.onEvent((message) => seen.push(message.sequence));
  const pending = transport.status();
  const request = h.socket.frames().at(-1)!;
  h.socket.push({
    type: "prototype_result",
    requestId: request.requestId,
    success: true,
    status: { showingId: "second-show" },
  });
  await pending;
  expect(source.showingId).toBe("second-show");
  h.socket.push({ ...event(9) });
  h.socket.push({ ...event(10) });
  expect(seen).toEqual([9, 10]);
  expect(h.socket.frames().at(-1)).toMatchObject({
    type: "ack",
    sequence: 10,
    appInstanceId: "process",
  });
  await h.attacher.release(device.deviceId);
});

test("per-app forget closes only that attachment and preserves another app's cursor", async () => {
  const h = await setup();
  const record = (await h.registry.list(device.deviceId))[0]!;
  const otherAppId = disposableAppId("android", "other");
  await h.registry.put(device.deviceId, { ...record, appId: otherAppId, slug: "other" });
  h.socket.appInstanceId = "first";
  h.socket.replay = [{ ...event(9) }];
  (await h.attacher.attach(device, appId)).onEvent(() => {});
  const other = new FakeDisposableAppSocket();
  other.appInstanceId = "other";
  other.replay = [{ ...event(4) }];
  h.connector.connect = async () => other;
  (await h.attacher.attach(device, otherAppId)).onEvent(() => {});
  await h.attacher.forget(device.deviceId, appId);
  expect(h.socket.ended).toBe(true);
  expect(other.ended).toBe(false);
  other.closeFromAgent();
  const reconnect = new FakeDisposableAppSocket();
  reconnect.appInstanceId = "other";
  h.connector.connect = async () => reconnect;
  await h.attacher.attach(device, otherAppId);
  expect(reconnect.frames()[0]).toMatchObject({
    appInstanceId: "other",
    lastAcknowledgedSequence: 4,
  });
  await h.attacher.release(device.deviceId);
});

test("device release forgets all app cursors with closed sockets and preserves other devices", async () => {
  const h = await setup();
  const record = (await h.registry.list(device.deviceId))[0]!;
  const otherAppId = disposableAppId("android", "other");
  const otherDevice = { ...device, deviceId: "other-device" };
  await h.registry.put(device.deviceId, { ...record, appId: otherAppId, slug: "other" });
  await h.registry.put(otherDevice.deviceId, record);
  const attachments = [
    [device, appId],
    [device, otherAppId],
    [otherDevice, appId],
  ] as const;
  for (const [target, targetAppId] of attachments) {
    const socket = new FakeDisposableAppSocket();
    socket.appInstanceId = "process";
    socket.replay = [{ ...event(9) }];
    h.connector.connect = async () => socket;
    (await h.attacher.attach(target, targetAppId)).onEvent(() => {});
    socket.closeFromAgent();
  }
  await h.attacher.release(device.deviceId);
  for (const [target, targetAppId] of attachments) {
    const socket = new FakeDisposableAppSocket();
    h.connector.connect = async () => socket;
    await h.attacher.attach(target, targetAppId);
    expect(socket.frames()[0]).toEqual({
      type: "hello",
      token,
      protocolVersion: 1,
      ...(target === otherDevice ? { appInstanceId: "process" } : {}),
      lastAcknowledgedSequence: target === otherDevice ? 9 : 0,
    });
  }
  await h.attacher.dispose();
});

test("disposal clears retained cursors even when all sockets already closed", async () => {
  const h = await setup();
  h.socket.appInstanceId = "process";
  h.socket.replay = [{ ...event(9) }];
  (await h.attacher.attach(device, appId)).onEvent(() => {});
  h.socket.closeFromAgent();
  // Disposed attachers cannot reconnect, so inspect the retained cache to verify memory cleanup.
  expect(h.attacher["resumeStates"].size).toBe(1);
  await h.attacher.dispose();
  expect(h.attacher["resumeStates"].size).toBe(0);
});
