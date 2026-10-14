import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_GESTURES_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
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
  root: {
    ...plain.root,
    onTap: [{ type: "emit", name: "tap" }],
    onLongPress: [{ type: "toggle", key: "liked_7" }],
    onDoubleTap: [{ type: "emit", name: "double" }],
  },
};
describe("prototype gestures host", () => {
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
  async function callWith(device: BootedDevice, input: unknown) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }
  const agentShows = () => agent.requests.filter((request) => request.type === "show_prototype");

  function advertise() {
    client.setSupportedCommands([PROTOTYPE_GESTURES_CAPABILITY, "prototype_persistence_replay_v1"]);
    agent.handshake.capabilities.push(PROTOTYPE_GESTURES_CAPABILITY);
  }
  test.each([android, ios])(
    "$platform refuses gestures before show or asset upload",
    async (device) => {
      client.setSupportedCommands([]);
      const payload = await callWith(device, {
        action: "show",
        spec: bound,
        assets: [{ id: "unused", path: "/work/image.png" }],
      });
      expect(payload.success).toBe(false);
      expect(payload.error).toContain("prototype_gestures_v1");
      expect(payload.error).toContain("root.onLongPress");
      expect(payload.error).toContain("root.onDoubleTap");
      expect(payload.error).toContain(device.platform === "ios" ? "Relaunch" : "Update");
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(client.getPrototypeAssetHistory()).toEqual([]);
      expect(agent.requests).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([]);
      expect(reader.reads).toEqual([]);
    },
  );
  test.each([android, ios])(
    "$platform sends gesture lists unchanged to a capable device",
    async (device) => {
      advertise();
      expect((await call(device, bound)).success).toBe(true);
      if (device.platform === "android") {
        expect(client.getPrototypeHistory()).toMatchObject([{ method: "show", spec: bound }]);
      } else {
        expect(agentShows()).toMatchObject([{ body: { spec: bound } }]);
      }
    },
  );
  test.each(["onLongPress", "onDoubleTap", "both"] as const)(
    "iOS reports timing for %s only",
    async (usage) => {
      advertise();
      const root = {
        ...plain.root,
        ...(usage !== "onDoubleTap" ? { onLongPress: bound.root.onLongPress } : {}),
        ...(usage !== "onLongPress" ? { onDoubleTap: bound.root.onDoubleTap } : {}),
      };
      const payload = await call(ios, { ...plain, root });
      expect(payload.success).toBe(true);
      const detail = payload.platformNotes?.find(
        (note) => note.construct === "node.gestures",
      )?.detail;
      expect(detail?.includes("Long-press")).toBe(usage !== "onDoubleTap");
      expect(detail?.includes("double-tap")).toBe(usage !== "onLongPress");
      expect(detail?.includes("onTap fires only after")).toBe(usage !== "onLongPress");
      expect(agentShows()).toMatchObject([{ body: { spec: { root } } }]);
    },
  );
  test.each([android, ios])(
    "$platform sends onTap alone without the gesture capability",
    async (device) => {
      client.setSupportedCommands([]);
      const tapped = { ...plain, root: { ...plain.root, onTap: bound.root.onTap } };
      expect((await call(device, tapped)).success).toBe(true);
    },
  );
});
