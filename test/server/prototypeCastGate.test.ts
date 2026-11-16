import { toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../src/features/prototype/prototypeCapabilityGates";
import type { BootedDevice } from "../../src/models";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

// The cast module gate (#14239) through the registered tool: a device without
// prototype_platform_cast_v1 refuses show, patch and replaceNode, and names the capability.
const CAST = "prototype_platform_cast_v1";
const castButton = { type: "castButton", id: "cast", player: "main", contentDescription: "Cast" };
const stop = {
  type: "button",
  id: "stop",
  label: "Stop",
  onTap: [{ type: "platform", call: "cast.stop", args: {} }],
};
const spec = {
  id: "cast-gate",
  window: { placement: { type: "fullscreen" } },
  requires: { platform: ["media", "cast"] },
  state: { liked: false },
  media: { players: { main: { kind: "video", source: { sample: "countdown" } } } },
  root: {
    type: "column",
    children: [castButton, stop, { type: "text", id: "status", text: "{platform:/cast/state}" }],
  },
};
const needed = ["prototype_patch_v1", ...requiredPrototypeCapabilities(spec)];
const withoutCast = needed.filter((name) => name !== CAST);

const devices: BootedDevice[] = [
  { deviceId: "emulator-5554", platform: "android", name: "Pixel" },
  { deviceId: "sim-1", platform: "ios", name: "iPhone" },
];

describe.each(devices)("cast module gate on $platform (#14239)", (device) => {
  let proxy: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;

  function advertise(capabilities: string[]): void {
    proxy.setSupportedCommands(capabilities);
    agent.handshake.capabilities.splice(0, agent.handshake.capabilities.length, ...capabilities);
  }
  function setup(): void {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    proxy = new FakeCtrlProxy(timer);
    agent = new FakePrototypeAgentClient({
      agentVersion: "test",
      protocolVersion: 1,
      capabilities: [],
    });
    advertise(needed);
    unsubscribe = registerPrototypeTools({
      clientFactory: () => proxy,
      agentConnections: { get: () => agent },
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
    });
  }
  async function call(input: Record<string, unknown>) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(toolStructured(response));
  }
  const patchRequests = () =>
    device.platform === "android" ? proxy.patchRequests : agent.patchRequests;
  const shown = () =>
    device.platform === "android"
      ? proxy.getPrototypeHistory().length
      : agent.requests.filter((request) => request.type === "show_prototype").length;

  beforeAll(async () => {
    // Warm the registered show/patch schema path before measuring the scenarios.
    setup();
    try {
      await call({ action: "show", spec });
      await call({
        action: "patch",
        id: spec.id,
        ops: [{ op: "replaceNode", id: "cast", node: castButton }],
      });
    } finally {
      unsubscribe();
      restore();
    }
  });
  beforeEach(setup);
  afterEach(() => {
    unsubscribe();
    restore();
  });

  test("show is refused before anything is sent, naming the capability", async () => {
    advertise(withoutCast);
    const refused = await call({ action: "show", spec });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(CAST);
    expect(refused.error).toContain("the cast platform module");
    expect(shown()).toBe(0);
  });

  test("show and replaceNode succeed with the capability advertised", async () => {
    expect((await call({ action: "show", spec })).success).toBe(true);
    expect(shown()).toBe(1);
    const ops = [
      { op: "replaceNode", id: "cast", node: { ...castButton, protocols: ["airplay"] } },
    ];
    expect((await call({ action: "patch", id: spec.id, ops })).success).toBe(true);
    expect(patchRequests()).toEqual([{ id: spec.id, ops }]);
  });

  test.each([
    [
      "a castButton",
      { op: "replaceNode", id: "cast", node: { ...castButton, contentDescription: "TV" } },
    ],
    ["a cast call", { op: "replaceNode", id: "stop", node: { ...stop, label: "End" } }],
    ["a state-only", { op: "replace", path: "/state/liked", value: true }],
  ])("%s patch is refused once the device stops advertising the capability", async (_name, op) => {
    expect((await call({ action: "show", spec })).success).toBe(true);
    advertise(withoutCast);
    const refused = await call({ action: "patch", id: spec.id, ops: [op], baseRevision: 1 });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(CAST);
    expect(patchRequests()).toEqual([]);
  });
});
