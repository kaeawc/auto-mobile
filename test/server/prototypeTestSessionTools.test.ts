import {
  FakePrototypeAgentClient,
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
} from "../fakes/FakePrototypeAgentClient";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  registerPrototypeTools,
  prototypeSchema,
  prototypeOutputSchema,
} from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PROTOTYPE_READ_ACTIONS } from "../../src/server/prototypeTools/schemas";
import { prototypeDeadTapsUnsupportedMessage } from "../../src/features/prototype/prototypeDeadTaps";
import { validatePrototypeSpec } from "../../src/features/prototype/prototypeValidation";
import { PROTOTYPE_DEAD_TAP_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakePrototypeTestSessionStore } from "../fakes/FakePrototypeTestSessionStore";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { toolStructured } from "../helpers/toolResponse";
import { event } from "../helpers/prototypeTestEvent";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = { deviceId: "test-device", platform: "android", name: "Test" };
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const }, deadTaps: true },
  root: { type: "text" as const, text: "Welcome" },
};
let client: FakeCtrlProxy, timer: FakeTimer, dispose: () => void, restore: () => void;
beforeEach(() => {
  restore = preserveToolRegistry();
  timer = new FakeTimer();
  client = new FakeCtrlProxy(timer);
  client.setSupportedCommands([PROTOTYPE_DEAD_TAP_CAPABILITY]);
  dispose = registerPrototypeTools({
    clientFactory: () => client,
    timer,
    testSessionStore: new FakePrototypeTestSessionStore(),
    idGenerator: new CountingIdGenerator(),
  });
});
afterEach(() => {
  dispose();
  restore();
});
async function call(args: Record<string, unknown>, target = device) {
  return prototypeOutputSchema.parse(
    toolStructured(await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(target, args)),
  );
}
test("begin -> accepted event pushes -> end JSON + markdown; status unchanged; reports are read-only", async () => {
  expect((await call({ action: "show", spec })).success).toBe(true);
  const before = await call({ action: "status" });
  const begin = await call({
    action: "testSessionBegin",
    id: "panel",
    cohort: "new",
    goal: "checkout/done",
  });
  expect(begin.testSession?.deadTaps).toBe("enabled");
  expect(begin.testSession?.status).toBe("active");
  expect(await call({ action: "status" })).toEqual(before);
  client.emitPrototypeEvent({
    ...event(1),
    name: "prototype_dead_tap",
    payload: { stack: null, screen: null, x: 20.1, y: 30 },
  });
  client.emitPrototypeEvent(event(1));
  const end = await call({ action: "testSessionEnd", id: "panel" });
  expect(end.testSession?.eventCount).toBe(1);
  expect(end.testSession?.status).toBe("ended");
  expect(end.report).toMatchObject({ cohort: "new", completed: false, eventCount: 1 });
  expect(end.markdown).toContain("No screenshot overlay");
  expect(
    (await call({ action: "testSessionReport", testSessionId: begin.testSession?.id })).report,
  ).toEqual(end.report);
  expect((await call({ action: "testSessionReport", id: "panel" })).report).toEqual(end.report);
});
test("all three actions bypass target resolution even without an iOS agent", async () => {
  const ios: BootedDevice = { ...device, platform: "ios" };
  expect((await call({ action: "testSessionBegin", id: "panel" }, ios)).warning).toContain(
    "window.deadTaps: true",
  );
  expect((await call({ action: "testSessionReport", id: "panel" }, ios)).success).toBe(true);
  expect((await call({ action: "testSessionEnd", id: "panel" }, ios)).success).toBe(true);
  expect(client.getPrototypeHistory()).toHaveLength(0);
});
test("refuses unsupported dead taps before show; message identifies platform and remedy", async () => {
  client.setSupportedCommands([]);
  const refused = await call({ action: "show", spec });
  expect(refused.success).toBe(false);
  expect(refused.error).toContain(prototypeDeadTapsUnsupportedMessage("android"));
  expect(client.getPrototypeHistory()).toHaveLength(0);
  expect(prototypeDeadTapsUnsupportedMessage("ios")).toContain("launchApp prototype: true");
  expect(prototypeDeadTapsUnsupportedMessage("ios")).toContain("Nothing was shown");
});
test.each([false, true])("iOS dead-tap capability supported=%s", async (supported) => {
  dispose();
  const agent = new FakePrototypeAgentClient({
    agentVersion: "test",
    protocolVersion: 1,
    capabilities: [
      ...FAKE_PROTOTYPE_AGENT_CAPABILITIES,
      ...(supported ? [PROTOTYPE_DEAD_TAP_CAPABILITY] : []),
    ],
  });
  dispose = registerPrototypeTools({
    agentConnections: { get: () => agent },
    timer,
    testSessionStore: new FakePrototypeTestSessionStore(),
  });
  const result = await call({ action: "show", spec }, { ...device, platform: "ios" });
  expect(result.success).toBe(supported);
  if (supported) {
    expect(agent.requests.map((request) => request.type)).toContain("show_prototype");
  } else {
    expect(result.error).toContain(prototypeDeadTapsUnsupportedMessage("ios"));
    expect(agent.requests).toHaveLength(0);
  }
});
test("schema bounds, action field restrictions, required ids and read actions", () => {
  for (const action of ["testSessionBegin", "testSessionEnd", "testSessionReport"]) {
    expect(PROTOTYPE_READ_ACTIONS).toContain(action);
    expect(prototypeSchema.safeParse({ action, id: "panel" }).success).toBe(true);
    expect(prototypeSchema.safeParse({ action }).success).toBe(false);
    expect(prototypeSchema.safeParse({ action, id: "panel", state: {} }).success).toBe(false);
  }
  for (const [field, max] of [
    ["goal", 200],
    ["cohort", 64],
  ] as const) {
    for (const length of [0, max + 1]) {
      expect(
        prototypeSchema.safeParse({
          action: "testSessionBegin",
          id: "panel",
          [field]: "x".repeat(length),
        }).success,
      ).toBe(false);
    }
    expect(
      prototypeSchema.safeParse({
        action: "testSessionBegin",
        id: "panel",
        [field]: "x".repeat(max),
      }).success,
    ).toBe(true);
    expect(
      prototypeSchema.safeParse({ action: "testSessionEnd", id: "panel", [field]: "x" }).success,
    ).toBe(false);
    expect(prototypeSchema.safeParse({ action: "status", [field]: "x" }).success).toBe(false);
  }
  expect(
    prototypeSchema.safeParse({ action: "testSessionReport", testSessionId: "test" }).success,
  ).toBe(true);
  for (const value of ["", "x".repeat(65)]) {
    expect(
      prototypeSchema.safeParse({ action: "testSessionReport", testSessionId: value }).success,
    ).toBe(false);
  }
  expect(
    prototypeSchema.safeParse({ action: "testSessionBegin", id: "panel", testSessionId: "test" })
      .success,
  ).toBe(false);
});
test("authored emits cannot impersonate reserved runtime dead taps", () => {
  const authored = (name: string) => ({
    ...spec,
    root: { type: "button", label: "Tap", onTap: [{ type: "emit", name }] },
  });
  expect(validatePrototypeSpec(authored("submit")).success).toBe(true);
  const reserved = validatePrototypeSpec(authored("prototype_dead_tap"));
  expect(reserved.success).toBe(false);
  if (!reserved.success) {
    expect(reserved.error.message).toContain("reserved");
  }
});
