import { expect, test } from "bun:test";
import { AndroidDisposableAppAttacher } from "../../src/features/prototype/disposableApp/android/AndroidDisposableAppAttacher";
import { FileDisposableAppRegistry } from "../../src/features/prototype/disposableApp/DisposableAppRegistry";
import { createPrototypeToolRuntime } from "../../src/server/prototypeTools/runtime";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDisposableAppAdb, FakeDisposableAppSocket } from "../fakes/FakeDisposableAppAttach";
import { FakePrototypeAgentConnector } from "../fakes/FakePrototypeAgentSocket";
import { FakePrototypeEventLifecycle } from "../fakes/FakePrototypeEventLifecycle";
import { FakeTimer } from "../fakes/FakeTimer";
import { InMemoryDisposableAppRegistryStore } from "../fakes/InMemoryDisposableAppRegistryStore";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { event } from "../helpers/prototypeTestEvent";
import { toolStructured } from "../helpers/toolResponse";

const device = { name: "fake", deviceId: "attach-host", platform: "android" as const };
async function setup() {
  const registry = new FileDisposableAppRegistry(new InMemoryDisposableAppRegistryStore());
  await registry.put(device.deviceId, {
    appId: "dev.jasonpearson.automobile.app.demo",
    specId: "panel",
    slug: "demo",
    platform: "android",
    label: "Demo",
    specSha256: "a".repeat(64),
    template: "base",
    signer: "host",
    installedAt: 0,
    expiresAt: null,
    attachToken: "b".repeat(64),
  });
  const socket = new FakeDisposableAppSocket();
  socket.appInstanceId = "first-process";
  const connector = new FakePrototypeAgentConnector(socket);
  const adb = new FakeDisposableAppAdb();
  const attacher = new AndroidDisposableAppAttacher({
    registry,
    connector,
    adbFactory: { create: () => adb },
    timer: new FakeTimer(),
  });
  return { registry, socket, connector, adb, attacher };
}

test("two MCP registrations share one host attachment and its reconnect cursor", async () => {
  const h = await setup();
  h.socket.replay = [{ ...event(9) }];
  const first = createPrototypeToolRuntime({
    clientFactory: () => new FakeCtrlProxy(new FakeTimer()),
    disposableAppRegistry: h.registry,
    disposableAppAttacher: h.attacher,
  });
  const secondAttacher = await setup();
  secondAttacher.connector.connectError = new Error("AppAttachAgent already has a live connection");
  let second: ReturnType<typeof createPrototypeToolRuntime> | undefined;
  try {
    expect(
      toolStructured(await first.handler(device, { action: "awaitEvent", id: "panel" })),
    ).toMatchObject({ success: true, event: { sequence: 9 } });
    second = createPrototypeToolRuntime({
      clientFactory: () => new FakeCtrlProxy(new FakeTimer()),
      disposableAppRegistry: h.registry,
      disposableAppAttacher: secondAttacher.attacher,
    });
    first.dispose();
    expect(h.socket.ended).toBe(false);
    h.socket.push({ ...event(10) });
    expect(
      toolStructured(await second.handler(device, { action: "awaitEvent", id: "panel" })),
    ).toMatchObject({ success: true, event: { sequence: 10 } });
    expect(h.connector.ports).toEqual([12345]);
    expect(secondAttacher.connector.ports).toEqual([]);
    h.socket.closeFromAgent();
    const resumed = new FakeDisposableAppSocket();
    resumed.appInstanceId = "first-process";
    resumed.replay = [{ ...event(10) }, { ...event(11) }];
    h.connector.connect = async () => resumed;
    expect(
      toolStructured(await second.handler(device, { action: "awaitEvent", id: "panel" })),
    ).toMatchObject({ event: { sequence: 11 } });
    expect(resumed.frames()[0]).toMatchObject({
      appInstanceId: "first-process",
      lastAcknowledgedSequence: 10,
    });
  } finally {
    second?.dispose();
    first.dispose();
    await h.attacher.release(device.deviceId);
    await secondAttacher.attacher.release(device.deviceId);
  }
});

test("host disposal closes its app socket and removes the adb forward", async () => {
  const h = await setup();
  h.socket.replay = [{ ...event(1) }];
  const runtime = createPrototypeToolRuntime({
    disposableAppRegistry: h.registry,
    disposableAppAttacher: h.attacher,
  });
  try {
    await runtime.handler(device, { action: "awaitEvent", id: "panel" });
    runtime.dispose();
    await drainUntil(() => h.socket.ended, { description: "host attachment disposal" });
    expect(h.adb.getExecutedArgv().at(-1)).toEqual(["forward", "--remove", "tcp:12345"]);
  } finally {
    runtime.dispose();
    await h.attacher.release(device.deviceId);
  }
});

test.each(["removeDevice", "unbindDevice", "releaseSession"] as const)(
  "host %s releases app attachments",
  async (cleanup) => {
    const h = await setup();
    const lifecycle = new FakePrototypeEventLifecycle();
    h.socket.replay = [{ ...event(1) }];
    const runtime = createPrototypeToolRuntime({
      lifecycle,
      disposableAppRegistry: h.registry,
      disposableAppAttacher: h.attacher,
    });
    try {
      await runtime.handler(device, { action: "awaitEvent", id: "panel" });
      if (cleanup === "releaseSession") {
        lifecycle.releaseSession("one", device.deviceId);
      } else {
        lifecycle[cleanup](device.deviceId);
      }
      await drainUntil(() => h.socket.ended, { description: "device attachment cleanup" });
      expect(h.adb.getExecutedArgv().at(-1)).toEqual(["forward", "--remove", "tcp:12345"]);
    } finally {
      runtime.dispose();
      await h.attacher.release(device.deviceId);
    }
  },
);
