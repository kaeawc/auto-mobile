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
  expect(h.socket.frames()).toEqual([{ type: "hello", token, protocolVersion: 1 }]);
  const replay: unknown[] = [];
  client.onEvent((event) => replay.push(event.sequence));
  expect(replay).toEqual([1, 2]);
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
