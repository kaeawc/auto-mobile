import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  registerPrototypeTools,
  prototypeSchema,
  prototypeOutputSchema,
} from "../../src/server/prototypeTools";
import { PROTOTYPE_READ_ACTIONS } from "../../src/server/prototypeTools/schemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { toolStructured } from "../helpers/toolResponse";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = { deviceId: "test-device", platform: "android", name: "Test" };
let dispose: () => void, restore: () => void, client: FakeCtrlProxy;

beforeEach(() => {
  restore = preserveToolRegistry();
  const timer = new FakeTimer();
  client = new FakeCtrlProxy(timer);
  client.setSupportedCommands(["prototype_persistence_replay_v1"]);
  dispose = registerPrototypeTools({
    clientFactory: () => client,
    adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
    lastRenderedObservation: () => undefined,
    clock: timer,
    timer,
    idGenerator: new CountingIdGenerator(),
  });
});
afterEach(() => {
  dispose();
  restore();
});

async function call(args: Record<string, unknown>) {
  return prototypeOutputSchema.parse(
    toolStructured(await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, args)),
  );
}

const shop = {
  collections: {
    items: [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ],
    tags: [],
  },
  routes: [{ method: "GET", path: "/ping", body: "pong" }],
  faults: [{ path: "/items", status: 500, every: 3 }],
};

test("defineBackend reports the origin and what the backend holds, and redefining replaces it", async () => {
  const first = await call({ action: "defineBackend", backendId: "shop", backend: shop });
  expect(first).toMatchObject({
    success: true,
    backend: {
      id: "shop",
      origin: "https://shop.mock.automobile.invalid",
      collections: { items: 2, tags: 0 },
      routes: 1,
      faults: 1,
    },
  });
  const second = await call({ action: "defineBackend", backendId: "shop", backend: {} });
  expect(second.backend).toMatchObject({ collections: {}, routes: 0, faults: 0 });
});

test("an invalid definition is a failed result naming the path, and keeps the old backend", async () => {
  await call({ action: "defineBackend", backendId: "shop", backend: shop });
  const bad = await call({
    action: "defineBackend",
    backendId: "shop",
    backend: { collections: { items: [{ id: 1 }, { id: 1 }] } },
  });
  expect(bad.success).toBe(false);
  expect(bad.error).toMatch(/collections\.items/);
  const log = await call({ action: "backendLog", backendId: "shop" });
  expect(log).toMatchObject({ success: true, backendLog: [] });
});

test("clearBackend removes the backend, once", async () => {
  await call({ action: "defineBackend", backendId: "shop", backend: {} });
  expect((await call({ action: "clearBackend", backendId: "shop" })).backend?.cleared).toBe(true);
  expect((await call({ action: "clearBackend", backendId: "shop" })).backend?.cleared).toBe(false);
});

test("backendLog for an unknown backend says so", async () => {
  const log = await call({ action: "backendLog", backendId: "nobody" });
  expect(log).toMatchObject({ success: false, error: 'No mock backend "nobody" is defined.' });
});

test("a host request to the mock origin reaches the backend defined through the tool", async () => {
  await call({ action: "defineBackend", backendId: "shop", backend: shop });
  // Showing anything attaches the request host the device's frames go through.
  const shown = await call({
    action: "show",
    spec: {
      id: "p",
      window: { placement: { type: "fullscreen" } },
      root: { type: "text", text: "hi" },
    },
  });
  expect(shown.success).toBe(true);
  const sent: unknown[] = [];
  await client.getPrototypeRequestHost()!.handleRequest(
    {
      type: "prototype_request",
      requestId: "r1",
      prototypeId: "p",
      method: "GET",
      url: "https://shop.mock.automobile.invalid/items?name=b",
    },
    (response) => {
      sent.push(response);
    },
  );
  expect(sent).toEqual([
    expect.objectContaining({
      type: "prototype_response",
      requestId: "r1",
      ok: true,
      status: 200,
      body: [{ id: 2, name: "b" }],
    }),
  ]);
  const log = await call({ action: "backendLog", backendId: "shop" });
  expect(log.backendLog).toEqual([
    { seq: 1, method: "GET", path: "/items", query: { name: "b" }, status: 200 },
  ]);
  expect((await call({ action: "backendLog", backendId: "shop", since: 1 })).backendLog).toEqual(
    [],
  );
  await call({ action: "clearBackend", backendId: "shop" });
  sent.length = 0;
  await client.getPrototypeRequestHost()!.handleRequest(
    {
      type: "prototype_request",
      requestId: "r2",
      prototypeId: "p",
      method: "GET",
      url: "https://shop.mock.automobile.invalid/items",
    },
    (response) => {
      sent.push(response);
    },
  );
  expect(sent).toEqual([
    expect.objectContaining({
      ok: false,
      error: { code: "network", message: 'No mock backend "shop" is defined.' },
    }),
  ]);
});

test("the three actions are device-read-only and need no device request", () => {
  for (const action of ["defineBackend", "clearBackend", "backendLog"]) {
    expect(PROTOTYPE_READ_ACTIONS).toContain(action);
  }
});

test.each<[string, Record<string, unknown>, RegExp]>([
  [
    "defineBackend without backendId",
    { action: "defineBackend", backend: {} },
    /requires backendId/,
  ],
  [
    "defineBackend without backend",
    { action: "defineBackend", backendId: "a" },
    /requires backend/,
  ],
  ["clearBackend without backendId", { action: "clearBackend" }, /requires backendId/],
  ["backendLog without backendId", { action: "backendLog" }, /requires backendId/],
  ["an invalid backendId", { action: "clearBackend", backendId: "Bad_Id" }, /backendId must match/],
  ["a negative since", { action: "backendLog", backendId: "a", since: -1 }, /since/],
  [
    "a field the action does not take",
    { action: "clearBackend", backendId: "a", backend: {} },
    /clearBackend allows backendId/,
  ],
  ["backend on another action", { action: "status", backendId: "a" }, /status allows/],
])("schema rejects %s", (_name, args, message) => {
  const parsed = prototypeSchema.safeParse(args);
  expect(parsed.success).toBe(false);
  expect(JSON.stringify(parsed.error?.issues)).toMatch(message);
});

test("schema accepts the three actions with their fields", () => {
  for (const args of [
    { action: "defineBackend", backendId: "a", backend: { seed: 1 } },
    { action: "clearBackend", backendId: "a" },
    { action: "backendLog", backendId: "a", since: 3 },
  ]) {
    expect(prototypeSchema.safeParse(args).success).toBe(true);
  }
});
