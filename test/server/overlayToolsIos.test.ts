import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerOverlayTools, overlayOutputSchema } from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import type { OverlayAgentConnections } from "../../src/features/overlay/ios/iosOverlayTransport";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeOverlayAgentClient } from "../fakes/FakeOverlayAgentClient";
import { FakeOverlayAssetFileReader } from "../fakes/FakeOverlayAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { event } from "../helpers/overlayTestEvent";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

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

/** Stands in for the launchApp {overlay: true} registry (#10567). */
class FakeOverlayAgentConnections implements OverlayAgentConnections {
  readonly agents = new Map<string, FakeOverlayAgentClient>();
  get(deviceId: string): FakeOverlayAgentClient | undefined {
    return this.agents.get(deviceId);
  }
}

describe("prototype tool on an iOS simulator", () => {
  let ctrlProxy: FakeCtrlProxy;
  let agent: FakeOverlayAgentClient;
  let connections: FakeOverlayAgentConnections;
  let timer: FakeTimer;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    timer = new FakeTimer();
    ctrlProxy = new FakeCtrlProxy(timer);
    agent = new FakeOverlayAgentClient();
    connections = new FakeOverlayAgentConnections();
    connections.agents.set(simulator.deviceId, agent);
    unsubscribe = registerOverlayTools({
      clientFactory: () => ctrlProxy,
      agentConnections: connections,
      clock: timer,
      timer,
      assetFileReader: new FakeOverlayAssetFileReader().addFile("/img/logo.png", png),
    });
  });
  afterEach(() => {
    expect(ctrlProxy.getOverlayHistory()).toEqual([]);
    expect(ctrlProxy.getOverlayAssetHistory()).toEqual([]);
    unsubscribe();
    restore();
  });

  async function call(input: unknown, target = simulator) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(target, input);
    return { response, payload: overlayOutputSchema.parse(response.structuredContent) };
  }
  const types = () => agent.requests.map((request) => request.type);

  test("show uploads assets, then sends show_overlay, and status reports it host-locally", async () => {
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
    expect(types()).toEqual(["put_overlay_asset", "show_overlay"]);
    expect(agent.requests[1].body).toEqual({ spec });

    const status = await call({ action: "status" });
    expect(status.payload.overlays?.map((entry) => entry.id)).toEqual(["panel"]);
    expect(types()).toHaveLength(2);
  });

  test("a supplied asset the agent reports missing is re-sent once with the overlay", async () => {
    agent.queueReplies({ success: true }, { success: true, missingAssets: ["logo"] });
    const { payload } = await call({
      action: "show",
      spec,
      assets: [{ id: "logo", path: "/img/logo.png" }],
    });
    expect(types()).toEqual([
      "put_overlay_asset",
      "show_overlay",
      "put_overlay_asset",
      "show_overlay",
    ]);
    expect(payload.success).toBe(true);
    expect(payload.missingAssets).toBeUndefined();
  });

  test("a same-id show is the update path; dismiss sends dismiss_overlay", async () => {
    await call({ action: "show", spec });
    await call({ action: "show", spec: { ...spec, state: { title: "Two" } } });
    const { payload } = await call({ action: "dismiss", id: "panel" });
    expect(payload.lastResult).toMatchObject({ id: "panel", lastAction: "dismiss", success: true });
    expect(types()).toEqual(["show_overlay", "show_overlay", "dismiss_overlay"]);
    expect(agent.requests[2].body).toEqual({ id: "panel" });
  });

  test("agent overlay_event pushes reach awaitEvent through the shared coordinator", async () => {
    await call({ action: "show", spec });
    agent.emit({ ...event(1, "panel", "emit", "save") });
    const { payload } = await call({ action: "awaitEvent", id: "panel" });
    expect({ type: "overlay_event", ...payload.event }).toEqual(event(1, "panel", "emit", "save"));
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an agent request failure is an overlay failure, not a thrown error", async () => {
    agent.queueReplies(new Error("Overlay agent closed the connection; the app may have exited."));
    const { response, payload } = await call({ action: "show", spec });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("app may have exited");
  });

  test("a relaunched app's new connection takes over the event subscription", async () => {
    await call({ action: "show", spec });
    expect(agent.listenerCount()).toBe(1);
    const relaunched = new FakeOverlayAgentClient();
    connections.agents.set(simulator.deviceId, relaunched);
    await call({ action: "show", spec });
    expect(agent.listenerCount()).toBe(0);
    expect(relaunched.listenerCount()).toBe(1);
    expect(relaunched.requests.map((request) => request.type)).toEqual(["show_overlay"]);
  });

  test.each([
    [{ action: "update", id: "panel", state: { title: "x" } }, "same id"],
    [
      { action: "showVariants", id: "panel", variants: [{ image: { asset: "logo" } }] },
      "showVariants is Android only",
    ],
    [{ action: "show", spec, display: "inner" }, "display is Android only"],
  ])("%o is refused before any agent request", async (input, message) => {
    const { response, payload } = await call(input);
    expect(response.isError).toBe(true);
    expect(payload.error).toContain(message);
    expect(agent.requests).toEqual([]);
  });

  test("a simulator with no agent connection gets launchApp overlay guidance", async () => {
    connections.agents.clear();
    const { response, payload } = await call({ action: "show", spec });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("launchApp with overlay: true");
    expect(payload.error).toContain(simulator.deviceId);
  });
});
