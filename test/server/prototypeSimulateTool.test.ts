import { parsePrototypeFeedbackLog } from "../../src/features/prototype/prototypeFeedbackLog";
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
describe("prototype simulate and timer reports", () => {
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

  test("simulate needs id and bounded integer advanceTimeMs", () => {
    for (const input of [
      { action: "simulate", id: "proto" },
      { action: "simulate", advanceTimeMs: 1 },
      ...[0, 3600001, 1.5].map((advanceTimeMs) => ({
        action: "simulate",
        id: "proto",
        advanceTimeMs,
      })),
    ]) {
      expect(prototypeSchema.safeParse(input).success).toBe(false);
    }
    expect(
      prototypeSchema.safeParse({ action: "simulate", id: "proto", advanceTimeMs: 3600000 })
        .success,
    ).toBe(true);
    expect(
      prototypeSchema.safeParse({ action: "simulate", id: "proto", advanceTimeMs: 100 }).success,
    ).toBe(true);
    expect(prototypeSchema.safeParse({ action: "simulate" }).success).toBe(false);
    expect(
      prototypeSchema.safeParse({
        action: "show",
        spec: {
          id: "proto",
          window: { placement: { type: "fullscreen" } },
          root: { type: "text", text: "Hello" },
        },
        assets: [{ id: "image", path: "/private/tmp/image.png", advanceTimeMs: 100 }],
      }).success,
    ).toBe(false);
    expect(
      prototypeSchema.safeParse({ action: "simulate", id: "proto", advanceTimeMs: 100, all: true })
        .success,
    ).toBe(false);
  });

  test("android refuses simulate without prototype_timers_v1 and sends nothing", async () => {
    const result = await call(android, { action: "simulate", id: "proto", advanceTimeMs: 100 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("prototype_timers_v1");
    expect(result.error).toContain("simulate");
    expect(proxy.advanceClockRequests).toEqual([]);
  });

  test("ios refuses simulate on an agent without prototype_timers_v1 and sends nothing", async () => {
    const result = await call(ios, { action: "simulate", id: "proto", advanceTimeMs: 100 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("prototype_timers_v1");
    expect(result.error).toContain("launchApp prototype: true");
    expect(agent.requests).toEqual([]);
  });

  test("android sends advance_prototype_clock to a capable device and reports fired", async () => {
    proxy.setSupportedCommands(["prototype_timers_v1"]);
    proxy.setAdvanceClockResult({ success: true, fired: 2 });
    const result = await call(android, { action: "simulate", id: "proto", advanceTimeMs: 100 });
    expect(result).toMatchObject({ success: true, fired: 2 });
    expect(proxy.advanceClockRequests).toEqual([{ id: "proto", advanceTimeMs: 100 }]);
  });

  test("ios sends advance_prototype_clock to a capable agent and reports fired", async () => {
    agent.handshake.capabilities.push("prototype_timers_v1");
    agent.queueReplies({ fired: 0 });
    const result = await call(ios, { action: "simulate", id: "proto", advanceTimeMs: 100 });
    expect(result).toMatchObject({ success: true, fired: 0 });
    expect(agent.requests).toEqual([
      { type: "advance_prototype_clock", body: { id: "proto", advanceTimeMs: 100 } },
    ]);
  });

  test("advance cap failures retain the number of completed fires", async () => {
    proxy.setSupportedCommands(["prototype_timers_v1"]);
    proxy.setAdvanceClockResult({ success: false, fired: 10000, error: "10000-fire limit" });
    expect(
      await call(android, { action: "simulate", id: "proto", advanceTimeMs: 1000100 }),
    ).toMatchObject({ success: false, fired: 10000, error: "10000-fire limit" });
    agent.handshake.capabilities.push("prototype_timers_v1");
    agent.queueReplies({ success: false, fired: 10000, error: "10000-fire limit" });
    expect(
      await call(ios, { action: "simulate", id: "proto", advanceTimeMs: 1000100 }),
    ).toMatchObject({ success: false, fired: 10000, error: "10000-fire limit" });
  });

  test("inspect omits malformed timer reports on capable devices", async () => {
    proxy.setSupportedCommands(["prototype_persistence_replay_v1", "prototype_timers_v1"]);
    const reported = { id: "proto", persistent: false, state: {}, pages: {}, lastSequence: 0 };
    proxy.setInspectReply({ success: true, prototypes: [{ ...reported, timers: {} }] });
    expect((await call(android, { action: "inspect" })).prototypes?.[0]?.timers).toBeUndefined();
    agent.handshake.capabilities.push("prototype_timers_v1");
    agent.queueReplies({ status: { shown: true, ...reported, timers: null } });
    expect((await call(ios, { action: "inspect" })).prototypes?.[0]?.timers).toBeUndefined();
  });

  test("a device refusal is reported as a failure", async () => {
    proxy.setSupportedCommands(["prototype_timers_v1"]);
    proxy.setAdvanceClockResult({ success: false, error: "disk full" });
    const result = await call(android, { action: "simulate", id: "proto", advanceTimeMs: 100 });
    expect(result).toMatchObject({ success: false, error: "disk full" });
  });

  test("inspect normalizes absent timers only on a capable device and retains reported timers", async () => {
    const reported = { id: "proto", persistent: false, state: {}, pages: {}, lastSequence: 0 };
    proxy.setInspectReply({ success: true, prototypes: [reported] });
    expect((await call(android, { action: "inspect" })).prototypes?.[0]?.timers).toBeUndefined();
    proxy.setSupportedCommands(["prototype_persistence_replay_v1", "prototype_timers_v1"]);
    expect((await call(android, { action: "inspect" })).prototypes?.[0]?.timers).toEqual([]);
    const timers = [{ id: "tick", nextFireInMs: 100, runs: 2 }];
    proxy.setInspectReply({ success: true, prototypes: [{ ...reported, timers }] });
    expect((await call(android, { action: "inspect" })).prototypes?.[0]?.timers).toEqual(timers);
    expect((await call(android, { action: "status" })).prototypes?.[0]?.timers).toEqual(timers);
  });
  test("inspect returns the device's feedback log, dropping malformed entries (#14329)", async () => {
    const reported = { id: "proto", persistent: false, state: {}, pages: {}, lastSequence: 0 };
    const feedbackLog = [
      { timeMs: 10, effect: "selection", nodeId: "like" },
      { timeMs: 20, sound: "send", suppressed: true },
    ];
    proxy.setInspectReply({
      success: true,
      prototypes: [
        {
          ...reported,
          feedbackLog: [
            ...feedbackLog,
            { timeMs: 30, effect: "tick", sound: "click" },
            { timeMs: -1, effect: "tick" },
            "nonsense",
          ],
        },
      ],
    });
    expect<unknown>(
      (await call(android, { action: "inspect" })).prototypes?.[0]?.feedbackLog,
    ).toEqual(feedbackLog);
    expect<unknown>(
      (await call(android, { action: "status" })).prototypes?.[0]?.feedbackLog,
    ).toEqual(feedbackLog);
    proxy.setInspectReply({ success: true, prototypes: [{ ...reported, feedbackLog: [] }] });
    expect(
      (await call(android, { action: "inspect" })).prototypes?.[0]?.feedbackLog,
    ).toBeUndefined();
  });

  test("iOS inspect returns the agent's feedback log (#14329)", async () => {
    const status = { shown: true, id: "proto", pages: {}, state: {}, lastSequence: 0 };
    agent.queueReplies({
      status: { ...status, feedbackLog: [{ timeMs: 5, effect: "success", nodeId: "done" }] },
    });
    expect((await call(ios, { action: "inspect" })).prototypes?.[0]?.feedbackLog).toEqual([
      { timeMs: 5, effect: "success", nodeId: "done" },
    ]);
  });

  test("the feedback log keeps only the newest 64 entries (#14329)", () => {
    const entries = Array.from({ length: 70 }, (_, index) => ({ timeMs: index, effect: "tick" }));
    const parsed = parsePrototypeFeedbackLog(entries);
    expect(parsed).toHaveLength(64);
    expect(parsed?.[0]?.timeMs).toBe(6);
  });

  test("iOS inspect reports timers and normalizes absent timers", async () => {
    agent.handshake.capabilities.push("prototype_timers_v1");
    const status = { shown: true, id: "proto", pages: {}, state: {}, lastSequence: 0 };
    agent.queueReplies({ status });
    expect((await call(ios, { action: "inspect" })).prototypes?.[0]?.timers).toEqual([]);
    const timers = [{ id: "tick", nextFireInMs: 0, runs: 1 }];
    agent.queueReplies({ status: { ...status, timers } });
    expect((await call(ios, { action: "inspect" })).prototypes?.[0]?.timers).toEqual(timers);
  });
  test("show and patch surface cancelTimer unknown-id advisory", async () => {
    proxy.setSupportedCommands(["prototype_timers_v1", "prototype_patch_v1"]);
    const root = {
      type: "button",
      id: "button",
      label: "Stop",
      onTap: [{ type: "cancelTimer", id: "unknown" }],
    };
    const spec = {
      id: "proto",
      window: { placement: { type: "fullscreen" } },
      root: { type: "column", children: [root] },
    };
    const shown = await call(android, { action: "show", spec });
    expect(shown.success).toBe(true);
    expect(shown.warning).toContain('cancelTimer id "unknown"');
    const patched = await call(android, {
      action: "patch",
      id: "proto",
      ops: [{ op: "replaceNode", id: "button", node: { ...root, label: "Stop again" } }],
    });
    expect(patched).toMatchObject({ success: true });
    expect(patched.warning).toContain('cancelTimer id "unknown"');
  });
});
