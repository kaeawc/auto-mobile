import { afterEach, beforeEach, expect, test } from "bun:test";
import { createPrototypeToolRuntime } from "../../src/server/prototypeTools/runtime";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { FileDisposableAppRegistry } from "../../src/features/prototype/disposableApp/DisposableAppRegistry";
import { BufferedViewerClient } from "../../src/features/prototype/ios/BufferedViewerClient";
import { ActionableError } from "../../src/models/ActionableError";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentClient";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { InMemoryDisposableAppRegistryStore } from "../fakes/InMemoryDisposableAppRegistryStore";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { toolStructured } from "../helpers/toolResponse";
import { event } from "../helpers/prototypeTestEvent";

const device = { name: "fake", deviceId: "attach-routing", platform: "android" as const };
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "text" as const, text: "Hello" },
};
let dispose: () => void;
let handler: ReturnType<typeof createPrototypeToolRuntime>["handler"];
let agent: FakePrototypeAgentClient;
let ctrl: FakeCtrlProxy;
let ctrlCalls: number;
let attachCalls: number;
let attachError: Error | undefined;
let buffered: BufferedViewerClient;
let store: InMemoryPrototypeStatusStore;
beforeEach(async () => {
  const timer = new FakeTimer();
  ctrl = new FakeCtrlProxy(timer);
  ctrlCalls = 0;
  attachCalls = 0;
  attachError = undefined;
  agent = new FakePrototypeAgentClient({
    agentVersion: "app",
    protocolVersion: 1,
    capabilities: [
      "patch_prototype",
      "get_prototype_status",
      "prototype_patch_v1",
      "prototype_inspect_v1",
      "prototype_persistence_replay_v1",
    ],
  });
  buffered = new BufferedViewerClient(agent);
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
  });
  store = new InMemoryPrototypeStatusStore();
  const runtime = createPrototypeToolRuntime({
    timer,
    store,
    clientFactory: () => {
      ctrlCalls++;
      return ctrl;
    },
    disposableAppRegistry: registry,
    disposableAppAttacher: {
      attach: async () => {
        attachCalls++;
        if (attachError) {
          throw attachError;
        }
        return buffered;
      },
    },
    cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
  });
  handler = runtime.handler;
  dispose = runtime.dispose;
});
afterEach(() => dispose());
const call = async (args: Record<string, unknown>) => toolStructured(await handler(device, args));

test("matching patch uses the app transport without constructing CtrlProxy", async () => {
  await call({
    action: "patch",
    id: "panel",
    ops: [{ op: "replaceNode", id: "title", node: { type: "text", id: "title", text: "Updated" } }],
  });
  expect(agent.patchRequests).toHaveLength(1);
  expect(ctrlCalls).toBe(0);
});

test("nonmatching id uses CtrlProxy and matching show also uses CtrlProxy", async () => {
  await call({ action: "inspect", id: "other" });
  await call({ action: "show", spec });
  expect(ctrlCalls).toBe(2);
  expect(attachCalls).toBe(0);
});

test("matching app that is not running returns guidance without CtrlProxy", async () => {
  attachError = new ActionableError(
    "Call launchApp with the app id; token may be stale after a reinstall.",
  );
  expect(
    await call({
      action: "patch",
      id: "panel",
      ops: [{ op: "replaceNode", id: "title", node: { type: "text", id: "title", text: "New" } }],
    }),
  ).toMatchObject({ success: false, error: expect.stringContaining("launchApp") });
  expect(ctrlCalls).toBe(0);
});

test("matching status reads the live app and awaitEvent consumes replay in order", async () => {
  agent.queueReplies({
    status: { shown: true, id: "panel", state: {}, pages: {}, lastSequence: 0, spec, revision: 0 },
  });
  expect(await call({ action: "status", id: "panel" })).toMatchObject({ success: true });
  agent.emit({ ...event(1) });
  agent.emit({ ...event(2) });
  expect(await call({ action: "awaitEvent", id: "panel", afterSequence: 0 })).toMatchObject({
    success: true,
    event: { sequence: 1 },
  });
  expect(await call({ action: "awaitEvent", id: "panel", afterSequence: 1 })).toMatchObject({
    success: true,
    event: { sequence: 2 },
  });
  expect(ctrlCalls).toBe(0);
});

test("awaitEvent receives events buffered before the first host subscription", async () => {
  agent.emit({ ...event(1) });
  agent.emit({ ...event(2) });
  expect(await call({ action: "awaitEvent", id: "panel", afterSequence: 0 })).toMatchObject({
    success: true,
    event: { sequence: 1 },
  });
  expect(await call({ action: "awaitEvent", id: "panel", afterSequence: 1 })).toMatchObject({
    success: true,
    event: { sequence: 2 },
  });
  expect(ctrlCalls).toBe(0);
});

test("a disposable patch preserves the separately shown overlay spec", async () => {
  const overlay = { ...spec, id: "overlay" };
  const ticket = store.shownSpecs.beginShow(device.deviceId, overlay.id);
  store.shownSpecs.endShow(device.deviceId, ticket, { id: overlay.id, spec: overlay });
  await call({
    action: "patch",
    id: "panel",
    ops: [{ op: "replaceNode", id: "title", node: { type: "text", id: "title", text: "New" } }],
  });
  expect(store.shownSpecs.read(device.deviceId, overlay.id)).toMatchObject({
    kind: "known",
    spec: overlay,
  });
  expect(agent.patchRequests).toHaveLength(1);
  expect(ctrlCalls).toBe(0);
});
