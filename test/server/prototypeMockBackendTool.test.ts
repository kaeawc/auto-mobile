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
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { MAX_MOCK_DOCUMENT_BYTES } from "../../src/features/prototype/prototypeMockSchema";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { toolStructured } from "../helpers/toolResponse";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = { deviceId: "test-device", platform: "android", name: "Test" };
let dispose: () => void, restore: () => void, client: FakeCtrlProxy;
let files: FakePrototypeAssetFileReader;

beforeEach(() => {
  restore = preserveToolRegistry();
  const timer = new FakeTimer();
  files = new FakePrototypeAssetFileReader();
  client = new FakeCtrlProxy(timer);
  client.setSupportedCommands(["prototype_persistence_replay_v1"]);
  dispose = registerPrototypeTools({
    clientFactory: () => client,
    adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
    lastRenderedObservation: () => undefined,
    assetFileReader: files,
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

const window = { placement: { type: "fullscreen" as const } };
const shownSpec = { id: "p", window, root: { type: "text" as const, text: "hi" } };

async function requestBody(url: string): Promise<unknown> {
  const sent: unknown[] = [];
  await client
    .getPrototypeRequestHost()!
    .handleRequest(
      { type: "prototype_request", requestId: "r", prototypeId: "p", method: "GET", url },
      (response) => {
        sent.push(response);
      },
    );
  return sent[0];
}

test("show with mock defines the backends before the spec is sent, replacing earlier ones", async () => {
  await call({
    action: "defineBackend",
    backendId: "shop",
    backend: { routes: [{ method: "GET", path: "/v", body: 1 }] },
  });
  const shown = await call({
    action: "show",
    spec: shownSpec,
    mock: {
      shop: { routes: [{ method: "GET", path: "/v", body: 2 }] },
      news: { collections: { posts: [{ id: 1 }] } },
    },
  });
  expect(shown.success).toBe(true);
  expect(await requestBody("https://shop.mock.automobile.invalid/v")).toMatchObject({
    ok: true,
    body: 2,
  });
  expect(await requestBody("https://news.mock.automobile.invalid/posts")).toMatchObject({
    ok: true,
    body: [{ id: 1 }],
  });
});

test("show with mockPath reads the document from the file", async () => {
  files.addFile(
    "/mocks/shop.json",
    Buffer.from(JSON.stringify({ shop: { collections: { items: [{ id: "a" }] } } })),
  );
  const shown = await call({ action: "show", spec: shownSpec, mockPath: "/mocks/shop.json" });
  expect(shown.success).toBe(true);
  expect(files.reads).toEqual(["/mocks/shop.json"]);
  expect(await requestBody("https://shop.mock.automobile.invalid/items/a")).toMatchObject({
    ok: true,
    body: { id: "a" },
  });
});

test.each<[string, () => void, Record<string, unknown>, RegExp]>([
  [
    "a relative path",
    () => {},
    { mockPath: "mocks.json" },
    /mockPath mocks.json: path must be absolute/,
  ],
  [
    "a missing file",
    () => {},
    { mockPath: "/mocks/none.json" },
    /mockPath \/mocks\/none.json: cannot read file/,
  ],
  [
    "invalid JSON",
    () => files.addFile("/m.json", Buffer.from("{nope")),
    { mockPath: "/m.json" },
    /mockPath \/m.json: invalid JSON/,
  ],
  [
    "an array document",
    () => files.addFile("/m.json", Buffer.from("[]")),
    { mockPath: "/m.json" },
    /expected an object of \{backendId: definition\}/,
  ],
  [
    "a null document",
    () => files.addFile("/m.json", Buffer.from("null")),
    { mockPath: "/m.json" },
    /expected an object/,
  ],
  [
    "an oversize file",
    () => files.addFile("/m.json", Buffer.alloc(MAX_MOCK_DOCUMENT_BYTES + 1, 32)),
    { mockPath: "/m.json" },
    /the limit is 2097152/,
  ],
  [
    "an invalid definition",
    () => {},
    { mock: { shop: { collections: { items: [{ id: 1 }, { id: 1 }] } } } },
    /shop\.collections\.items/,
  ],
  [
    "an invalid backend id",
    () => {},
    { mock: { "Bad Id": {} } },
    /Mock backend id "Bad Id" must match/,
  ],
])(
  "show with %s fails without sending the spec or defining anything",
  async (_name, arrange, extra, message) => {
    arrange();
    await call({ action: "defineBackend", backendId: "keep", backend: {} });
    const shown = await call({ action: "show", spec: shownSpec, ...extra });
    expect(shown.success).toBe(false);
    expect(shown.error).toMatch(message);
    expect((await call({ action: "status" })).prototypes ?? []).toEqual([]);
    expect((await call({ action: "backendLog", backendId: "keep" })).success).toBe(true);
  },
);

test("a show with several mocks defines all or none", async () => {
  await call({
    action: "defineBackend",
    backendId: "shop",
    backend: { routes: [{ method: "GET", path: "/v", body: 1 }] },
  });
  const shown = await call({
    action: "show",
    spec: shownSpec,
    mock: { shop: { routes: [{ method: "GET", path: "/v", body: 2 }] }, broken: { seed: -1 } },
  });
  expect(shown.success).toBe(false);
  expect(shown.error).toMatch(/broken\.seed/);
  expect(await call({ action: "backendLog", backendId: "broken" })).toMatchObject({
    success: false,
  });
  // Still the old definition.
  await call({ action: "show", spec: shownSpec });
  expect(await requestBody("https://shop.mock.automobile.invalid/v")).toMatchObject({ body: 1 });
});

test("schema rejects mock with mockPath, and mock on actions other than show", () => {
  const both = prototypeSchema.safeParse({
    action: "show",
    spec: shownSpec,
    mock: {},
    mockPath: "/a.json",
  });
  expect(both.success).toBe(false);
  expect(JSON.stringify(both.error?.issues)).toMatch(/either mock or mockPath/);
  for (const action of ["patch", "dismiss", "status", "defineBackend"]) {
    const parsed = prototypeSchema.safeParse({
      action,
      id: "p",
      ops: [{ op: "add" }],
      backendId: "a",
      backend: {},
      mock: {},
    });
    expect(parsed.success).toBe(false);
  }
  expect(prototypeSchema.safeParse({ action: "show", spec: shownSpec, mock: {} }).success).toBe(
    true,
  );
  expect(
    prototypeSchema.safeParse({ action: "show", spec: shownSpec, mockPath: "/a.json" }).success,
  ).toBe(true);
});
