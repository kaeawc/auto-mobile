import { toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_SEARCH_BAR_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import { prototypeSpecSchema } from "../../src/features/prototype/prototypeSpec";
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
  prototypeSearchBarFields,
  prototypeSearchBarUnsupportedMessage,
} from "../../src/features/prototype/prototypeSearchBar";
import { ActionableError } from "../../src/models/ActionableError";
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
  state: { query: "", active: true },
  root: {
    type: "searchBar",
    id: "search",
    stateKey: "query",
    activeKey: "active",
    child: { type: "text", text: "Result" },
  },
};
const usages = [bound, { ...bound, root: { type: "column", children: [bound.root] } }];
describe("prototype search bar host", () => {
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
      for (const device of [android, ios]) {
        client.setSupportedCommands(["prototype_patch_v1"]);
        agent.handshake.capabilities.push("prototype_patch_v1");
        await call(device, {
          ...plain,
          state: bound.state,
          root: { type: "column", children: [{ type: "text", id: "search", text: "Initial" }] },
        });
        const patch = {
          action: "patch",
          id: plain.id,
          ops: [{ op: "replaceNode", id: "search", node: bound.root }],
        };
        await callWith(device, patch);
        advertise();
        await callWith(device, patch);
      }
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
      PROTOTYPE_SEARCH_BAR_CAPABILITY,
      "prototype_persistence_replay_v1",
      "prototype_patch_v1",
    ]);
    agent.handshake.capabilities.push(PROTOTYPE_SEARCH_BAR_CAPABILITY);
  }
  test.each([android, ios])(
    "$platform refuses every search bar before uploads or show",
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
            prototypeSearchBarUnsupportedMessage(
              prototypeSearchBarFields(prototypeSpecSchema.parse(spec)),
              platform,
            ),
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
  test.each([android, ios])("$platform allows searchBar with capability", async (device) => {
    advertise();
    expect((await call(device, bound)).success).toBe(true);
    if (device.platform === "android") {
      expect(client.getPrototypeHistory()).toMatchObject([{ method: "show", spec: bound }]);
    } else {
      expect(agentShows()).toMatchObject([{ body: { spec: bound } }]);
    }
  });
  test.each([android, ios])(
    "$platform gates a patch producing searchBar before any request",
    async (device) => {
      client.setSupportedCommands(["prototype_patch_v1"]);
      agent.handshake.capabilities.push("prototype_patch_v1");
      const initial = {
        ...plain,
        state: bound.state,
        root: { type: "column", children: [{ type: "text", id: "search", text: "Initial" }] },
      };
      expect((await call(device, initial)).success).toBe(true);
      const before = { android: client.getPrototypeHistory().length, ios: agent.requests.length };
      const input = {
        action: "patch",
        id: plain.id,
        ops: [{ op: "replaceNode", id: "search", node: bound.root }],
      };
      const refused = await callWith(device, input);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain("prototype_search_bar_v1");
      expect(client.getPrototypeHistory()).toHaveLength(before.android);
      expect(agent.requests).toHaveLength(before.ios);
      advertise();
      expect((await callWith(device, input)).success).toBe(true);
    },
  );
});
