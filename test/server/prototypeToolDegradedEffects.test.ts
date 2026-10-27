import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolStructured } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "effects-android", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "effects-sim", platform: "ios", name: "Fake" };
const spec = {
  id: "panel",
  state: { title: "Old" },
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
};
const degradedEffects = [
  { path: "root.style.effects[0]", type: "blur", reason: "api" as const },
  { path: "root.style.effects[1]", type: "wave", reason: "budget" as const },
];

describe("prototype degradation warnings", () => {
  let client: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(["prototype_patch_v1"]);
    agent = new FakePrototypeAgentClient({
      agentVersion: "test",
      protocolVersion: 1,
      capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES, "prototype_patch_v1"],
    });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: () => agent },
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
  function expectWarning(output: { warning?: string }) {
    expect(output.warning).toContain("blur at root.style.effects[0] (api:");
    expect(output.warning).toContain("wave at root.style.effects[1] (budget:");
  }
  for (const device of [android, ios]) {
    test(`${device.platform} show reports effects and preserves other warnings`, async () => {
      client.setPrototypeResult({ success: true, degradedEffects, missingAssets: ["logo"] });
      agent.queueReplies({ degradedEffects, missingAssets: ["logo"] });
      const output = await call(device, { action: "show", spec });
      expect(output.success).toBe(true);
      expect(output.degradedEffects).toEqual(degradedEffects);
      expectWarning(output);
      expect(output.warning).toContain("logo");
    });
    test(`${device.platform} empty effects add no warning`, async () => {
      client.setPrototypeResult({ success: true, degradedEffects: [] });
      agent.queueReplies({ degradedEffects: [] });
      const output = await call(device, { action: "show", spec });
      expect(output.warning).toBeUndefined();
      expect(output.degradedEffects).toBeUndefined();
    });
    test(`${device.platform} inspect filters malformed entries and clears old reports`, async () => {
      client.setSupportedCommands(["prototype_persistence_replay_v1"]);
      const entry = { id: "panel", state: {}, pages: {}, lastSequence: 1 };
      const mixed = [
        ...degradedEffects,
        null,
        { path: "x", type: "blur", reason: "other" },
        { type: "wave" },
      ];
      const androidEntry = { ...entry, persistent: false, degradedEffects: mixed };
      client.setInspectReply({ success: true, prototypes: [androidEntry] });
      agent.queueReplies({ status: { ...entry, shown: true, degradedEffects: mixed } });
      const output = await call(device, { action: "inspect" });
      expect(output.success).toBe(true);
      expect(output.prototypes?.[0]?.degradedEffects).toEqual(degradedEffects);
      expectWarning(output.prototypes![0]);
      client.setInspectReply({ success: true, prototypes: [{ ...entry, persistent: false }] });
      agent.queueReplies({ status: { ...entry, shown: true } });
      const cleared = await call(device, { action: "inspect" });
      expect(cleared.prototypes?.[0]?.warning).toBeUndefined();
      expect(cleared.prototypes?.[0]?.degradedEffects).toBeUndefined();
    });
    test(`${device.platform} patch reports degradations from its result`, async () => {
      await call(device, { action: "show", spec });
      client.setPatchResult({ success: true, degradedEffects });
      agent.queueReplies({ degradedEffects });
      const output = await call(device, {
        action: "patch",
        id: "panel",
        baseRevision: 0,
        ops: [{ op: "replace", path: "/state/title", value: "New" }],
      });
      expect(output.error).toBeUndefined();
      expect(output.success).toBe(true);
      expectWarning(output);
      expect(output.degradedEffects).toEqual(degradedEffects);
    });
  }
  for (const device of [android, ios]) {
    test(`${device.platform} show ignores malformed effect entries individually`, async () => {
      const mixed = [...degradedEffects, { path: "x", type: "blur", reason: "unknown" }];
      client.setPrototypeResult({ success: true, degradedEffects: mixed });
      agent.queueReplies({ degradedEffects: [...mixed, null] });
      const output = await call(device, { action: "show", spec });
      expect(output.degradedEffects).toEqual(degradedEffects);
      expectWarning(output);
    });
    test(`${device.platform} refused show adds no degradation warning`, async () => {
      client.setPrototypeResult({ success: false, error: "refused", degradedEffects });
      agent.queueReplies({ success: false, error: "refused", degradedEffects });
      const output = await call(device, { action: "show", spec });
      expect(output.success).toBe(false);
      expect(output.warning).toBeUndefined();
      expect(output.degradedEffects).toBeUndefined();
    });
  }
});
