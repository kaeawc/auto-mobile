import { toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_DATA_MODEL_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import type { BootedDevice } from "../../src/models";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
} from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../fakes/FakePrototypeAgentClient";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

import {
  prototypeDataModelFields,
  prototypeDataModelUnsupportedMessage,
} from "../../src/features/prototype/prototypeData";
import { ActionableError } from "../../src/models/ActionableError";
import { event } from "../helpers/prototypeTestEvent";
const android: BootedDevice = { deviceId: "fake-data", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "sim-data", platform: "ios", name: "Sim" };
const plain = {
  id: "orders",
  window: { placement: { type: "fullscreen" as const } },
  state: { liked_7: false },
  root: { type: "text" as const, text: "Hello" },
};
const bound = {
  ...plain,
  data: { orders: [{ id: 7, title: "Latte", details: { size: "large" } }], cartCount: 1 },
  root: {
    type: "column",
    repeat: { items: { path: "/orders" }, as: "item", key: "id" },
    children: [
      {
        type: "text",
        text: "{item.title} {data:/cartCount}",
        visibleWhen: { data: "/cartCount", gt: 0 },
      },
    ],
  },
};
const usages = [
  bound,
  { ...plain, root: { ...plain.root, text: "{data:/missing}" } },
  { ...plain, root: { ...plain.root, visibleWhen: { data: "/missing", equals: 1 } } },
  {
    ...plain,
    root: { type: "column", repeat: { items: [{ id: 7 }], as: "item", key: "id" }, children: [] },
  },
];
describe("prototype data model host", () => {
  let client: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;

  let adb: FakeAdbExecutor;
  let reader: FakePrototypeAssetFileReader;

  function register(agentCapabilities: readonly string[]) {
    const timer = new FakeTimer();
    adb = new FakeAdbExecutor();
    reader = new FakePrototypeAssetFileReader();
    client = new FakeCtrlProxy(timer);
    agent = new FakePrototypeAgentClient({
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [...agentCapabilities],
    });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: (deviceId) => (deviceId === ios.deviceId ? agent : undefined) },
      adbFactory: new FakeAdbClientFactory(adb),
      assetFileReader: reader,
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  }
  beforeAll(async () => {
    // Initialise lazy schemas and tool handler machinery once with disposable fakes.
    expect(prototypeSchema.safeParse({ action: "show", spec: bound }).success).toBe(true);
    const restoreWarmup = preserveToolRegistry();
    register(FAKE_PROTOTYPE_AGENT_CAPABILITIES);
    client.setSupportedCommands([]);
    try {
      await call(android, plain);
      await call(ios, plain);
      await call(android, bound);
      await call(ios, bound);
    } finally {
      unsubscribe();
      restoreWarmup();
    }
  });
  beforeEach(() => {
    restore = preserveToolRegistry();
    register(FAKE_PROTOTYPE_AGENT_CAPABILITIES);
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(device: BootedDevice, spec: unknown) {
    return callWith(device, { action: "show", spec });
  }
  async function callWith(device: BootedDevice, input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return prototypeOutputSchema.parse(toolStructured(response));
  }
  const agentShows = () => agent.requests.filter((request) => request.type === "show_prototype");

  function advertise() {
    client.setSupportedCommands([
      PROTOTYPE_DATA_MODEL_CAPABILITY,
      "prototype_persistence_replay_v1",
    ]);
    agent.handshake.capabilities.push(PROTOTYPE_DATA_MODEL_CAPABILITY);
  }
  test.each([android, ios])(
    "$platform refuses every data use before uploads or show",
    async (device) => {
      client.setSupportedCommands([]);
      for (const spec of usages) {
        const before = await callWith(device, { action: "status" });
        const payload = await callWith(device, {
          action: "show",
          spec,
          assets: [{ id: "unused", path: "/work/image.png" }],
        });
        const platform = device.platform === "ios" ? "ios" : "android";
        expect(payload).toMatchObject({
          success: false,
          error: new ActionableError(
            prototypeDataModelUnsupportedMessage(prototypeDataModelFields(spec), platform),
          ).message,
        });
        expect(await callWith(device, { action: "status" })).toEqual(before);
      }
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(client.getPrototypeAssetHistory()).toEqual([]);
      expect(agent.requests).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );
  test.each([android, ios])("$platform plain spec does not need the capability", async (device) => {
    client.setSupportedCommands([]);
    expect((await call(device, plain)).success).toBe(true);
  });
  test.each([android, ios])(
    "$platform sends data unchanged, reports it with state, and clears it on dismiss",
    async (device) => {
      advertise();
      expect((await call(device, bound)).success).toBe(true);
      if (device.platform === "android") {
        expect(client.getPrototypeHistory()).toMatchObject([{ method: "show", spec: bound }]);
        client.emitPrototypeEvent({ ...event(1), id: "orders", state: bound.state });
      } else {
        expect(agentShows()).toMatchObject([{ body: { spec: bound } }]);
        agent.emit({ ...event(1), id: "orders", state: bound.state });
      }
      expect((await callWith(device, { action: "status" })).prototypes).toMatchObject([
        { data: bound.data, state: bound.state },
      ]);
      expect((await callWith(device, { action: "dismiss", id: "orders" })).success).toBe(true);
      expect((await callWith(device, { action: "status" })).prototypes).toEqual([]);
    },
  );
  test.each([android, ios])(
    "$platform inspect data is adopted and replaced by a plain show",
    async (device) => {
      advertise();
      const entry = {
        id: "orders",
        persistent: false,
        state: { liked_7: true },
        data: bound.data,
        pages: {},
        lastSequence: 3,
      };
      if (device.platform === "android") {
        client.setInspectReply({ success: true, prototypes: [entry] });
      } else {
        agent.queueReplies({ status: { shown: true, ...entry } });
      }
      expect((await callWith(device, { action: "inspect" })).prototypes).toMatchObject([
        entry.data && { data: entry.data, state: entry.state, adopted: true },
      ]);
      expect((await callWith(device, { action: "status" })).prototypes).toMatchObject([
        { data: entry.data, state: entry.state },
      ]);
      expect((await call(device, plain)).success).toBe(true);
      expect((await callWith(device, { action: "status" })).prototypes?.[0]).not.toHaveProperty(
        "data",
      );
    },
  );
});
