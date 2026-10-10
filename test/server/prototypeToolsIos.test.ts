import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerPrototypeTools, prototypeOutputSchema } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import type { PrototypeAgentConnections } from "../../src/features/prototype/ios/iosPrototypeTransport";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentClient";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { event } from "../helpers/prototypeTestEvent";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";

const simulator: BootedDevice = { deviceId: "SIM-UDID", platform: "ios", name: "iPhone" };
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4),
]);
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "image" as const, asset: "logo" },
};

/** Stands in for the launchApp {prototype: true} registry (#10567). */
class FakePrototypeAgentConnections implements PrototypeAgentConnections {
  readonly agents = new Map<string, FakePrototypeAgentClient>();
  get(deviceId: string): FakePrototypeAgentClient | undefined {
    return this.agents.get(deviceId);
  }
}

describe("prototype tool on an iOS simulator", () => {
  let ctrlProxy: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let connections: FakePrototypeAgentConnections;
  let timer: FakeTimer;
  let restore: () => void;
  let unsubscribe: () => void;
  let invalidator: FakeDeviceWindowCacheInvalidator;
  beforeEach(() => {
    invalidator = new FakeDeviceWindowCacheInvalidator();
    restore = preserveToolRegistry();
    timer = new FakeTimer();
    ctrlProxy = new FakeCtrlProxy(timer);
    agent = new FakePrototypeAgentClient();
    connections = new FakePrototypeAgentConnections();
    connections.agents.set(simulator.deviceId, agent);
    unsubscribe = registerPrototypeTools({
      clientFactory: () => ctrlProxy,
      agentConnections: connections,
      clock: timer,
      timer,
      assetFileReader: new FakePrototypeAssetFileReader().addFile("/img/logo.png", png),
      cacheInvalidator: invalidator,
    });
  });
  afterEach(() => {
    expect(ctrlProxy.getPrototypeHistory()).toEqual([]);
    expect(ctrlProxy.getPrototypeAssetHistory()).toEqual([]);
    unsubscribe();
    restore();
  });

  async function call(input: unknown, target = simulator) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(target, input);
    return { response, payload: prototypeOutputSchema.parse(response.structuredContent) };
  }
  const types = () => agent.requests.map((request) => request.type);

  test("show uploads assets, then sends show_prototype, and status reports it host-locally", async () => {
    const { payload } = await call({
      action: "show",
      spec,
      assets: [{ id: "logo", path: "/img/logo.png" }],
    });
    expect(payload).toEqual({
      success: true,
      lastResult: { id: "panel", lastAction: "show", success: true, timestamp: 0 },
      uploadedAssets: [{ id: "logo", mimeType: "image/png", bytes: png.length }],
    });
    expect(types()).toEqual(["put_prototype_asset", "show_prototype"]);
    expect(agent.requests[1].body).toEqual({ spec });

    const status = await call({ action: "status" });
    expect(status.payload.prototypes?.map((entry) => entry.id)).toEqual(["panel"]);
    expect(types()).toHaveLength(2);
  });

  test("a supplied asset the agent reports missing is re-sent once with the prototype", async () => {
    agent.queueReplies({ success: true }, { success: true, missingAssets: ["logo"] });
    const { payload } = await call({
      action: "show",
      spec,
      assets: [{ id: "logo", path: "/img/logo.png" }],
    });
    expect(types()).toEqual([
      "put_prototype_asset",
      "show_prototype",
      "put_prototype_asset",
      "show_prototype",
    ]);
    expect(payload.success).toBe(true);
    expect(payload.missingAssets).toBeUndefined();
  });

  test("a same-id show is the update path; dismiss sends dismiss_prototype", async () => {
    await call({ action: "show", spec });
    await call({ action: "show", spec: { ...spec, state: { title: "Two" } } });
    const { payload } = await call({ action: "dismiss", id: "panel" });
    expect(payload.lastResult).toMatchObject({ id: "panel", lastAction: "dismiss", success: true });
    expect(types()).toEqual(["show_prototype", "show_prototype", "dismiss_prototype"]);
    expect(agent.requests[2].body).toEqual({ id: "panel" });
  });

  test("a landed show and dismiss retire the simulator's cached observation", async () => {
    await call({ action: "show", spec });
    expect(invalidator.calls).toEqual([simulator]);
    await call({ action: "dismiss", id: "panel" });
    expect(invalidator.calls).toEqual([simulator, simulator]);
  });

  test("agent prototype_event pushes reach awaitEvent through the shared coordinator", async () => {
    await call({ action: "show", spec });
    agent.emit({ ...event(1, "panel", "emit", "save") });
    const { payload } = await call({ action: "awaitEvent", id: "panel" });
    expect({ type: "prototype_event", ...payload.event }).toEqual(
      event(1, "panel", "emit", "save"),
    );
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an agent request failure is a prototype failure, not a thrown error", async () => {
    agent.queueReplies(
      new Error("Prototype agent closed the connection; the app may have exited."),
    );
    const { response, payload } = await call({ action: "show", spec });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("app may have exited");
  });

  test("a relaunched app's new connection takes over the event subscription", async () => {
    await call({ action: "show", spec });
    expect(agent.listenerCount()).toBe(1);
    const relaunched = new FakePrototypeAgentClient();
    connections.agents.set(simulator.deviceId, relaunched);
    await call({ action: "show", spec });
    expect(agent.listenerCount()).toBe(0);
    expect(relaunched.listenerCount()).toBe(1);
    expect(relaunched.requests.map((request) => request.type)).toEqual(["show_prototype"]);
  });

  test.each([[{ action: "show", spec, display: "inner" }, "display is Android only"]])(
    "%o is refused before any agent request",
    async (input, message) => {
      const { response, payload } = await call(input);
      expect(response.isError).toBe(true);
      expect(payload.error).toContain(message);
      expect(agent.requests).toEqual([]);
    },
  );

  describe("inspect", () => {
    const agentStatus = (overrides: Record<string, unknown> = {}) => ({
      status: {
        shown: true,
        id: "panel",
        pages: { pager: 1 },
        state: { name: "typed" },
        lastSequence: 4,
        visible: true,
        assets: [],
        ...overrides,
      },
    });

    test("maps the agent's status to the Android inspect shape without suspended or dropped events", async () => {
      agent.queueReplies(agentStatus());
      const { response, payload } = await call({ action: "inspect" });
      expect(response.isError).toBeFalsy();
      expect(agent.requests.map((request) => request.type)).toEqual(["get_prototype_status"]);
      expect(payload.success).toBe(true);
      expect(payload.prototypes).toMatchObject([
        {
          id: "panel",
          persistent: false,
          adopted: true,
          state: { name: "typed" },
          pages: { pager: 1 },
          lastSequence: 4,
        },
      ]);
      expect(payload).not.toHaveProperty("deviceDroppedEvents");
      expect(payload.prototypes?.[0]).not.toHaveProperty("suspended");
    });

    test("adopts a prototype shown before a session release so status and awaitEvent see it", async () => {
      agent.queueReplies(agentStatus());
      await call({ action: "inspect" });
      const status = await call({ action: "status" });
      expect(status.payload.prototypes?.map((entry) => entry.id)).toEqual(["panel"]);
      expect(agent.requests.map((request) => request.type)).toEqual(["get_prototype_status"]);
    });

    test("an agent showing nothing drops the prototype the host still lists", async () => {
      await call({ action: "show", spec: { ...spec, root: { type: "text", text: "x" } } });
      expect((await call({ action: "status" })).payload.prototypes).toHaveLength(1);
      agent.queueReplies(agentStatus({ shown: false, id: null, pages: {}, state: {} }));
      const { payload } = await call({ action: "inspect" });
      expect(payload.success).toBe(true);
      expect(payload.prototypes).toEqual([]);
    });

    test("an agent without prototype_inspect_v1 is refused with a relaunch hint and nothing is sent", async () => {
      connections.agents.set(
        simulator.deviceId,
        new FakePrototypeAgentClient({
          agentVersion: "0.0.9",
          protocolVersion: 1,
          capabilities: ["show_prototype", "get_prototype_status"],
        }),
      );
      const { response, payload } = await call({ action: "inspect" });
      expect(response.isError).toBe(true);
      expect(payload.error).toContain("prototype_inspect_v1");
      expect(payload.error).toContain("launchApp prototype: true");
      expect(connections.agents.get(simulator.deviceId)).toBeDefined();
      expect(
        (connections.agents.get(simulator.deviceId) as FakePrototypeAgentClient).requests,
      ).toEqual([]);
    });

    test("a failed status request or malformed status is reported, not adopted", async () => {
      agent.queueReplies({ success: false, error: "boom" });
      expect((await call({ action: "inspect" })).payload).toMatchObject({
        success: false,
        error: "boom",
      });
      agent.queueReplies({ status: { shown: true } });
      expect((await call({ action: "inspect" })).payload.error).toContain("malformed");
    });
  });

  test('window.layer "app" is accepted and ignored on iOS, with no warning', async () => {
    const layered = { ...spec, window: { ...spec.window, layer: "app" as const } };
    const { response, payload } = await call({
      action: "show",
      spec: layered,
      assets: [{ id: "logo", path: "/img/logo.png" }],
    });
    expect(response.isError).toBeFalsy();
    expect(payload.success).toBe(true);
    expect(payload.warning).toBeUndefined();
    expect(types()).toEqual(["put_prototype_asset", "show_prototype"]);
  });

  test('window.persistence "device" is still refused on iOS before any agent request', async () => {
    const persistent = { ...spec, window: { ...spec.window, persistence: "device" as const } };
    const { response, payload } = await call({ action: "show", spec: persistent });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain('window.persistence "device" is Android only');
    expect(agent.requests).toEqual([]);
  });

  test("reset is forwarded to the agent only when true", async () => {
    await call({ action: "show", spec });
    await call({ action: "show", spec, reset: false });
    await call({ action: "show", spec, reset: true });
    expect(agent.requests.map((request) => request.body.reset)).toEqual([
      undefined,
      undefined,
      true,
    ]);
  });

  test("a simulator with no agent connection gets launchApp prototype guidance", async () => {
    connections.agents.clear();
    const { response, payload } = await call({ action: "show", spec });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("launchApp with prototype: true");
    expect(payload.error).toContain(simulator.deviceId);
  });
});
