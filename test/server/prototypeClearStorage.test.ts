import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toolStructured } from "../helpers/toolResponse";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
} from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const ios: BootedDevice = { deviceId: "SIM-1", platform: "ios", name: "iPhone" };
const stored = {
  version: 2,
  keys: [
    { key: "state:darkMode", bytes: 19 },
    { key: "data:/cart", bytes: 40 },
  ],
  totalBytes: 59,
};
const reported = {
  id: "proto",
  persistent: true,
  state: { darkMode: true },
  pages: {},
  lastSequence: 3,
  storage: stored,
};

describe("prototype clearStorage and the inspect storage report (#12522)", () => {
  let proxy: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    proxy = new FakeCtrlProxy(timer);
    proxy.setSupportedCommands(["prototype_persistence_replay_v1"]);
    agent = new FakePrototypeAgentClient({
      agentVersion: "test",
      protocolVersion: 1,
      capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES],
    });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => proxy,
      agentConnections: { get: () => agent },
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(device: BootedDevice, input: Record<string, unknown>) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(toolStructured(response));
  }

  test("clearStorage needs an id and no other mutation fields", () => {
    expect(prototypeSchema.safeParse({ action: "clearStorage", id: "proto" }).success).toBe(true);
    expect(prototypeSchema.safeParse({ action: "clearStorage" }).success).toBe(false);
    expect(
      prototypeSchema.safeParse({ action: "clearStorage", id: "proto", all: true }).success,
    ).toBe(false);
  });

  test("android refuses clearStorage without prototype_storage_v1 and sends nothing", async () => {
    const result = await call(android, { action: "clearStorage", id: "proto" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("prototype_storage_v1");
    expect(result.error).toContain("clearStorage");
    expect(proxy.clearStorageRequests).toEqual([]);
  });

  test("ios refuses clearStorage on an agent without prototype_storage_v1 and sends nothing", async () => {
    const result = await call(ios, { action: "clearStorage", id: "proto" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("prototype_storage_v1");
    expect(result.error).toContain("launchApp prototype: true");
    expect(agent.requests).toEqual([]);
  });

  test("android sends clear_prototype_storage to a capable device and reports cleared", async () => {
    proxy.setSupportedCommands(["prototype_storage_v1"]);
    proxy.setClearStorageResult({ success: true, cleared: 2 });
    const result = await call(android, { action: "clearStorage", id: "proto" });
    expect(result).toMatchObject({ success: true, cleared: 2 });
    expect(proxy.clearStorageRequests).toEqual(["proto"]);
  });

  test("ios sends clear_prototype_storage to a capable agent and reports cleared", async () => {
    agent.handshake.capabilities.push("prototype_storage_v1");
    agent.queueReplies({ cleared: 0 });
    const result = await call(ios, { action: "clearStorage", id: "proto" });
    expect(result).toMatchObject({ success: true, cleared: 0 });
    expect(agent.requests).toEqual([{ type: "clear_prototype_storage", body: { id: "proto" } }]);
  });

  test("a device refusal is reported as a failure", async () => {
    proxy.setSupportedCommands(["prototype_storage_v1"]);
    proxy.setClearStorageResult({ success: false, error: "disk full" });
    const result = await call(android, { action: "clearStorage", id: "proto" });
    expect(result).toMatchObject({ success: false, error: "disk full" });
  });

  test("inspect passes the device's storage report through, then clearStorage drops it", async () => {
    proxy.setSupportedCommands(["prototype_persistence_replay_v1", "prototype_storage_v1"]);
    proxy.setInspectReply({ success: true, prototypes: [reported] });
    const inspected = await call(android, { action: "inspect" });
    expect(inspected.prototypes?.[0]?.storage).toEqual(stored);
    expect((await call(android, { action: "status" })).prototypes?.[0]?.storage).toEqual(stored);

    await call(android, { action: "clearStorage", id: "proto" });
    expect((await call(android, { action: "status" })).prototypes?.[0]?.storage).toBeUndefined();
  });

  test("the iOS agent's flat storage report is passed through inspect", async () => {
    agent.queueReplies({
      status: {
        shown: true,
        id: "proto",
        pages: {},
        state: { darkMode: true },
        lastSequence: 1,
        storage: stored,
      },
    });
    const inspected = await call(ios, { action: "inspect" });
    expect(inspected.prototypes?.[0]).toMatchObject({ id: "proto", storage: stored });
  });

  test("a device that reports no storage, or a malformed one, yields none", async () => {
    proxy.setInspectReply({ success: true, prototypes: [{ ...reported, storage: undefined }] });
    expect((await call(android, { action: "inspect" })).prototypes?.[0]?.storage).toBeUndefined();

    proxy.setInspectReply({
      success: true,
      prototypes: [{ ...reported, storage: { version: 0, keys: "state:a", totalBytes: -1 } }],
    });
    expect((await call(android, { action: "inspect" })).prototypes?.[0]?.storage).toBeUndefined();
  });
});
