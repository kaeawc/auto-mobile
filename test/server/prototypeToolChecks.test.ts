import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_CHECKS_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
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
  prototypeChecksFields,
  prototypeChecksUnsupportedMessage,
} from "../../src/features/prototype/prototypeChecksCapability";
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
  state: { value: "" },
  root: {
    type: "textField",
    id: "field",
    stateKey: "value",
    checks: [{ required: true, message: "Required" }],
  },
};
const usages = [
  bound,
  {
    ...plain,
    root: { type: "button", label: "Save", enabledWhen: { key: "liked_7", equals: true } },
  },
  { ...plain, root: { type: "switch", stateKey: "liked_7", validateOn: "blur" } },
];
describe("prototype checks host", () => {
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

  function advertise() {
    client.setSupportedCommands([
      PROTOTYPE_CHECKS_CAPABILITY,
      "prototype_patch_v1",
      "prototype_persistence_replay_v1",
    ]);
    agent.handshake.capabilities.push(PROTOTYPE_CHECKS_CAPABILITY);
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
            prototypeChecksUnsupportedMessage(prototypeChecksFields(spec), platform),
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
    "$platform advertises checks and forwards events losslessly",
    async (device) => {
      advertise();
      expect((await call(device, bound)).success).toBe(true);
      const change = {
        ...event(1),
        id: "orders",
        kind: "change" as const,
        validity: { value: false },
      };
      const failed = {
        ...event(2),
        id: "orders",
        kind: "validation_failed" as const,
        keys: ["value"],
      };
      if (device.platform === "android") {
        client.emitPrototypeEvent(change);
        client.emitPrototypeEvent(failed);
      } else {
        agent.emit(change);
        agent.emit(failed);
      }
      expect(
        (await callWith(device, { action: "awaitEvent", id: "orders", kind: "change" })).event,
      ).toMatchObject({ validity: { value: false } });
      expect(
        (await callWith(device, { action: "awaitEvent", id: "orders", kind: "validation_failed" }))
          .event,
      ).toMatchObject({ keys: ["value"] });
    },
  );
  test.each([android, ios])(
    "$platform refuses checks introduced by replaceNode, preserving tracking",
    async (device) => {
      client.setSupportedCommands(["prototype_patch_v1"]);
      agent.handshake.capabilities.push("prototype_patch_v1");
      const initial = {
        ...bound,
        root: { type: "column", children: [{ type: "textField", id: "field", stateKey: "value" }] },
      };
      expect((await call(device, initial)).success).toBe(true);
      const before = await callWith(device, { action: "status" });
      const ops = [{ op: "replaceNode", id: "field", node: bound.root }];
      const refused = await callWith(device, { action: "patch", id: "orders", ops });
      expect(refused.success).toBe(false);
      expect(refused.error).toContain(PROTOTYPE_CHECKS_CAPABILITY);
      expect(client.patchRequests).toEqual([]);
      expect(agent.patchRequests).toEqual([]);
      expect(await callWith(device, { action: "status" })).toEqual(before);
      advertise();
      expect((await callWith(device, { action: "patch", id: "orders", ops })).success).toBe(true);
    },
  );
});
