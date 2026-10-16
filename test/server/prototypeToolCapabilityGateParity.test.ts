import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROTOTYPE_SPEC_CAPABILITY_GATES } from "../../src/features/prototype/prototypeCapabilityGates";
import type { BootedDevice } from "../../src/models";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import {
  FakePrototypeAgentClient,
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
} from "../fakes/FakePrototypeAgentClient";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const label = { type: "text", id: "label", text: "Hello" };
const base = {
  id: "parity",
  window: { placement: { type: "fullscreen" } },
  state: { liked: false, name: "Ada", query: "", active: false },
  root: { type: "column", children: [label] },
};
const fixtures: Record<string, { minimalSpec: unknown; ops: unknown[] }> = {
  prototype_theme_modes_v1: fixture({
    ...label,
    style: { background: { light: "#FFFFFF", dark: "#000000" } },
  }),
  prototype_data_model_v1: fixture({ ...label, text: "{data:/x}" }),
  prototype_text_field_options_v1: fixture({
    type: "textField",
    id: "label",
    stateKey: "name",
    label: "Liked",
  }),
  prototype_flow_grid_v1: fixture({ type: "flow", id: "label", children: [label] }),
  prototype_pager_options_v1: {
    ...fixture({
      type: "pager",
      id: "label",
      axis: "horizontal",
      pageSize: "fill",
      children: [{ type: "spacer" }],
    }),
  },
  prototype_gestures_v1: fixture({
    ...label,
    onLongPress: [{ type: "emit", name: "long" }],
    onDoubleTap: [{ type: "emit", name: "double" }],
  }),
  prototype_carousel_v1: fixture({
    type: "carousel",
    id: "label",
    itemWidth: 120,
    children: [{ type: "spacer" }],
  }),
  prototype_refresh_v1: fixture({
    type: "scroll",
    id: "label",
    refresh: { stateKey: "liked", onRefresh: [{ type: "emit", name: "refresh" }] },
    child: label,
  }),
  prototype_search_bar_v1: fixture({
    type: "searchBar",
    id: "label",
    stateKey: "query",
    activeKey: "active",
    child: label,
  }),
  prototype_rich_text_v1: fixture({ type: "text", id: "label", spans: [{ text: "Hello" }] }),
  prototype_menus_v1: fixture({
    type: "menu",
    id: "label",
    openWhen: { key: "liked", equals: true },
    items: [{ label: "Open" }],
  }),
  prototype_stack_v1: fixture({
    id: "label",
    type: "stack",
    start: "home",
    screens: { home: { type: "text", text: "Home" } },
  }),
  prototype_emit_context_v1: fixture({
    ...label,
    onTap: [{ type: "emit", name: "pick", context: { id: { state: "liked" } } }],
  }),
  prototype_checks_v1: fixture({
    type: "button",
    id: "label",
    label: "Save",
    enabledWhen: { key: "liked", equals: true },
  }),
};
function fixture(root: { type: string; id: string } & Record<string, unknown>) {
  return {
    minimalSpec: {
      ...base,
      state: base.state,
      root: { ...base.root, children: [root] },
    },
    ops: [{ op: "replaceNode", id: "label", node: root }],
  };
}
const cases = Object.entries(fixtures).flatMap(([capability, value]) =>
  (["android", "ios"] as const).map((platform) => ({
    capability,
    ...value,
    device: { platform, deviceId: `parity-${platform}`, name: "Fake" },
  })),
);
let proxy: FakeCtrlProxy;
let agent: FakePrototypeAgentClient;
let store: InMemoryPrototypeStatusStore;
let restore: () => void;
let unsubscribe: () => void;
function setup() {
  const timer = new FakeTimer();
  proxy = new FakeCtrlProxy(timer);
  proxy.setSupportedCommands(["prototype_patch_v1"]);
  agent = new FakePrototypeAgentClient({
    agentVersion: "test",
    protocolVersion: 1,
    capabilities: [
      ...FAKE_PROTOTYPE_AGENT_CAPABILITIES.filter(
        (capability) => capability !== "prototype_text_field_options_v1",
      ),
      "prototype_patch_v1",
    ],
  });
  store = new InMemoryPrototypeStatusStore(timer);
  unsubscribe = registerPrototypeTools({
    clientFactory: () => proxy,
    agentConnections: { get: () => agent },
    store,
    timer,
    clock: timer,
    cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
  });
}
async function call(device: BootedDevice, input: unknown) {
  const result = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
  return prototypeOutputSchema.parse(result.structuredContent);
}
const show = (device: BootedDevice, spec: unknown) => call(device, { action: "show", spec });
const patch = (device: BootedDevice, ops: unknown, extra = {}) =>
  call(device, { action: "patch", id: base.id, ops, ...extra });
const requests = (device: BootedDevice) =>
  device.platform === "android" ? proxy.patchRequests : agent.patchRequests;
function advertise(capability: string) {
  proxy.setSupportedCommands(["prototype_patch_v1", capability]);
  agent.handshake.capabilities.push(capability);
}
beforeAll(async () => {
  const undo = preserveToolRegistry();
  setup();
  try {
    for (const { device, minimalSpec } of cases) {
      await show(device, minimalSpec);
      await show(device, base);
      await patch(device, [{ op: "replaceNode", id: "label", node: label }]);
    }
  } finally {
    unsubscribe();
    undo();
  }
});
beforeEach(() => {
  restore = preserveToolRegistry();
  setup();
});
afterEach(() => {
  unsubscribe();
  restore();
});

test("every registered gate has exactly one parity fixture", () => {
  expect(Object.keys(fixtures).sort()).toEqual(
    PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.capability).sort(),
  );
});
test.each(cases)(
  "$device.platform refuses $capability identically on show and patch",
  async ({ capability, minimalSpec, ops, device }) => {
    const refusedShow = await show(device, minimalSpec);
    expect(refusedShow.success).toBe(false);
    expect(refusedShow.error).toContain(capability);
    expect(proxy.getPrototypeHistory()).toEqual([]);
    expect(agent.requests).toEqual([]);
    expect((await show(device, base)).success).toBe(true);
    const before = store.shownSpecs.read(device.deviceId, base.id);
    const sent = agent.requests.length;
    const refusedPatch = await patch(device, ops);
    expect(refusedPatch.success).toBe(false);
    expect(refusedPatch.error).toContain(capability);
    expect(refusedPatch.error).toBe(refusedShow.error);
    expect(requests(device)).toEqual([]);
    expect(proxy.getPrototypeHistory()).toHaveLength(device.platform === "android" ? 1 : 0);
    expect(agent.requests).toHaveLength(sent);
    expect(store.shownSpecs.read(device.deviceId, base.id)).toEqual(before);
    expect(
      (
        await patch(device, [
          { op: "replaceNode", id: "label", node: { ...label, text: "Updated" } },
        ])
      ).success,
    ).toBe(true);
  },
);
test.each(cases)(
  "$device.platform accepts $capability and state-only patches with it advertised",
  async ({ capability, minimalSpec, ops, device }) => {
    advertise(capability);
    expect((await show(device, minimalSpec)).success).toBe(true);
    expect(
      (
        await patch(device, [{ op: "replace", path: "/state/liked", value: true }], {
          baseRevision: 1,
        })
      ).success,
    ).toBe(true);
    expect((await show(device, base)).success).toBe(true);
    expect((await patch(device, ops)).success).toBe(true);
  },
);
test.each(["android", "ios"] as const)(
  "%s refuses repeat and /data introduction without data capability",
  async (platform) => {
    const device: BootedDevice = { platform, deviceId: `parity-${platform}`, name: "Fake" };
    const repeated = {
      type: "column",
      id: "label",
      repeat: { items: { path: "/x" }, as: "item", key: "id" },
      children: [],
    };
    for (const [spec, ops] of [
      [
        { ...base, data: { x: [] }, root: { ...base.root, children: [repeated] } },
        [
          { op: "add", path: "/data", value: { x: [] } },
          { op: "replaceNode", id: "label", node: repeated },
        ],
      ],
      [{ ...base, data: { x: [] } }, [{ op: "add", path: "/data", value: { x: [] } }]],
    ] as const) {
      const refusal = await show(device, spec);
      expect(refusal.success).toBe(false);
      expect(refusal.error).toContain("prototype_data_model_v1");
      expect((await show(device, base)).success).toBe(true);
      expect(await patch(device, ops)).toEqual({ success: false, error: refusal.error });
      expect(requests(device)).toEqual([]);
    }
  },
);
test("prototypeTools routes spec feature detection through the registry", () => {
  const source = readFileSync(
    new URL("../../src/server/prototypeTools.ts", import.meta.url),
    "utf8",
  );
  expect(source.includes("prototypeThemeModeFields")).toBe(false);
  expect(source.includes("prototypeDataModelFields")).toBe(false);
});

test.each(["android", "ios"] as const)(
  "%s plain patch needs no spec capabilities",
  async (platform) => {
    const device: BootedDevice = { platform, deviceId: `parity-${platform}`, name: "Fake" };
    expect((await show(device, base)).success).toBe(true);
    expect(
      (
        await patch(device, [
          { op: "replaceNode", id: "label", node: { ...label, text: "Updated" } },
        ])
      ).success,
    ).toBe(true);
    expect(requests(device)).toHaveLength(1);
  },
);
