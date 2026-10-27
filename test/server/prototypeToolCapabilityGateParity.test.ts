import { readToolResponse } from "../helpers/toolResponse";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOTYPE_SPEC_CAPABILITY_GATES } from "../../src/features/prototype/prototypeCapabilityGates";
import type { BootedDevice } from "../../src/models";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakePrototypeAssetCache } from "../fakes/FakePrototypeAssetCache";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import {
  FakePrototypeAgentClient,
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
} from "../fakes/FakePrototypeAgentClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const label = { type: "text", id: "label", text: "Hello" };
const base = {
  id: "parity",
  window: { placement: { type: "fullscreen" } },
  state: { page: 0, liked: false, name: "Ada", query: "", active: false },
  root: { type: "column", children: [label] },
};
const chart = {
  type: "chart",
  id: "label",
  variant: "line",
  series: [{ path: "/points", y: "y", label: "Points" }],
};
const chartData = { points: [{ y: 1 }, { y: 2 }] };
// `with` lists capabilities a fixture needs besides the one under test: a device-run request also
// needs the network capability, so the device gate is exercised with that one already advertised.
const fixtures: Record<string, { minimalSpec: unknown; ops: unknown[]; with?: string[] }> = {
  prototype_routes_v1: {
    ...fixture({
      type: "stack",
      id: "label",
      start: "home",
      screens: { home: label },
      routes: { home: {} },
    }),
    with: ["prototype_stack_v1"],
  },
  prototype_design_platform_v1: {
    minimalSpec: { ...base, theme: { design: "platform" } },
    ops: [],
  },
  prototype_icon_effects_v1: fixture({
    type: "icon",
    id: "label",
    name: "home",
    effect: { type: "bounce" },
  }),
  prototype_style_polish_v2: fixture({ ...label, style: { cornerStyle: "continuous" } }),
  prototype_tooltip_v1: fixture({
    type: "column",
    id: "label",
    children: [
      { type: "spacer", id: "target" },
      {
        type: "tooltip",
        text: "Tip",
        anchorTo: "target",
        openWhen: { key: "liked", equals: true },
      },
    ],
  }),
  prototype_drawer_v1: fixture({
    ...{
      type: "drawer",
      edge: "start",
      openWhen: { key: "liked", equals: true },
      child: { type: "spacer" },
    },
    id: "label",
  }),
  prototype_strings_v1: {
    minimalSpec: { ...base, strings: { default: { title: "Title" } } },
    ops: [],
  },
  prototype_semantics_v1: fixture({ ...label, semantics: { heading: true } }),
  prototype_format_v1: fixture({
    type: "column",
    id: "label",
    repeat: {
      items: [{ n: 1 }],
      as: "item",
      derive: { nText: { of: { item: "n" }, format: { number: {} } } },
    },
    children: [{ type: "text", text: "{item.nText}" }],
  }),
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
  prototype_text_field_actions_v1: fixture({
    type: "textField",
    id: "label",
    stateKey: "name",
    trailingIcon: { icon: "close", label: "Clear" },
  }),
  prototype_text_field_leading_icon_v1: fixture({
    type: "textField",
    id: "label",
    stateKey: "name",
    leadingIcon: "search",
  }),
  prototype_custom_shaders_v1: fixture({ ...label, style: { shader: { asset: "effect" } } }),
  prototype_flow_grid_v1: fixture({ type: "flow", id: "label", children: [label] }),
  prototype_bar_scroll_v1: fixture({
    type: "topAppBar",
    id: "label",
    title: "Feed",
    onScroll: "pinned",
  }),
  prototype_pager_options_v1: {
    ...fixture({
      type: "pager",
      id: "label",
      axis: "horizontal",
      pageSize: "fill",
      children: [{ type: "spacer" }],
    }),
  },
  prototype_scroll_motion_v1: fixture({
    type: "scroll",
    id: "label",
    child: {
      type: "text",
      text: "Hero",
      scrollLinked: { source: "label", range: [0, 160], alpha: [1, 0] },
    },
  }),
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
  prototype_swipe_actions_v1: fixture({
    type: "row",
    id: "label",
    swipeActions: { end: [{ label: "Delete", onTap: [{ type: "emit", name: "delete" }] }] },
    children: [{ type: "spacer" }],
  }),
  prototype_search_bar_v1: fixture({
    type: "searchBar",
    id: "label",
    stateKey: "query",
    activeKey: "active",
    child: label,
  }),
  prototype_string_conditions_v1: fixture({
    ...label,
    visibleWhen: { key: "name", contains: "A" },
  }),
  prototype_loading_states_v1: fixture({
    type: "box",
    id: "label",
    style: { shimmer: true },
    children: [{ type: "spacer" }],
  }),
  prototype_motion_v3: {
    ...fixture({ ...label, animate: {}, style: { cornerRadius: 8 } }),
    with: ["prototype_motion_v2"],
  },
  prototype_window_motion_v1: fixture({
    type: "column",
    id: "label",
    repeat: { items: [{ label: "A" }], as: "item", stagger: 50 },
    children: [{ type: "text", text: "A" }],
  }),
  prototype_motion_v2: fixture({ ...label, animate: { durationMs: 300 } }),
  prototype_effects_v1: fixture({ ...label, style: { effects: [{ type: "noise" }] } }),
  prototype_reduced_motion_v1: { minimalSpec: { ...base, motion: "reduced" }, ops: [] },
  prototype_shared_element_v2: fixture({
    type: "box",
    id: "label",
    children: [
      {
        ...label,
        id: "first",
        shared: { key: "hero", as: "element" },
        visibleWhen: { key: "liked", equals: true },
      },
      {
        ...label,
        id: "second",
        shared: { key: "hero", as: "element" },
        visibleWhen: { key: "liked", equals: false },
      },
    ],
  }),
  prototype_shared_element_v1: fixture({
    type: "box",
    id: "label",
    children: [
      { ...label, id: "first", sharedKey: "hero", visibleWhen: { key: "liked", equals: true } },
      { ...label, id: "second", sharedKey: "hero", visibleWhen: { key: "liked", equals: false } },
    ],
  }),
  prototype_stack_patterns_v1: {
    ...fixture({
      type: "stack",
      id: "label",
      start: "home",
      transition: "sharedAxisY",
      screens: { home: { type: "spacer" } },
    }),
    with: ["prototype_stack_v1", "prototype_stack_transitions_v1"],
  },
  prototype_stack_transitions_v1: {
    ...fixture({
      type: "stack",
      id: "label",
      start: "home",
      transition: "slide",
      screens: { home: { type: "spacer" } },
    }),
    with: ["prototype_stack_v1"],
  },
  prototype_choreography_v1: fixture({ ...label, transition: { type: "fade", delayMs: 100 } }),
  // A chart reads a /data array, so the spec carries data and the data capability is advertised.
  prototype_lazy_list_v1: {
    minimalSpec: {
      ...fixture({
        type: "list",
        id: "label",
        repeat: { items: { path: "/rows" }, as: "row", key: "id" },
        children: [{ type: "text", text: "{row.id}" }],
      }).minimalSpec,
      data: { rows: [{ id: 1 }] },
    },
    ops: [
      { op: "add", path: "/data", value: { rows: [{ id: 1 }] } },
      ...fixture({
        type: "list",
        id: "label",
        repeat: { items: { path: "/rows" }, as: "row", key: "id" },
        children: [{ type: "text", text: "{row.id}" }],
      }).ops,
    ],
    with: ["prototype_data_model_v1"],
  },
  prototype_chart_v1: {
    minimalSpec: { ...fixture(chart).minimalSpec, data: chartData },
    ops: [{ op: "add", path: "/data", value: chartData }, ...fixture(chart).ops],
    with: ["prototype_data_model_v1"],
  },
  prototype_rich_text_v1: fixture({ type: "text", id: "label", spans: [{ text: "Hello" }] }),
  prototype_linkify_v1: fixture({
    type: "text",
    id: "label",
    text: "@ana",
    linkify: { kinds: ["mention"], onTap: [{ type: "emit", name: "link" }] },
  }),
  prototype_pager_state_key_v1: fixture({
    type: "pager",
    id: "label",
    stateKey: "page",
    children: [{ type: "spacer" }],
  }),
  prototype_timers_v1: fixture({
    ...label,
    onTap: [
      { type: "startTimer", id: "tick", afterMs: 100, actions: [{ type: "emit", name: "tick" }] },
    ],
  }),
  prototype_chat_scroll_v1: fixture({
    type: "scroll",
    id: "label",
    reverse: true,
    child: { type: "spacer" },
  }),
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
  prototype_data_actions_v1: fixture({
    ...label,
    onTap: [{ type: "setData", path: "/data/count", value: { value: 1 } }],
  }),
  // A root-level block: a patch cannot introduce it, so only the show half applies (empty ops).
  prototype_storage_v1: {
    minimalSpec: { ...base, storage: { version: 1, keys: ["state:liked"] } },
    ops: [],
  },
  // A window-level field: a patch cannot change the window, so only the show half applies.
  prototype_backdrop_v1: {
    minimalSpec: { ...base, window: { ...base.window, backdrop: { material: "thin" } } },
    ops: [],
  },
  prototype_network_v1: fixture({
    ...label,
    onTap: [{ type: "request", url: "http://localhost:8080/feed", into: "/data/feed" }],
  }),
  prototype_network_upload_v1: {
    ...fixture({
      ...label,
      onTap: [
        {
          type: "request",
          method: "POST",
          url: "https://example.com/upload",
          body: { form: { q: { value: "hello" } } },
        },
      ],
    }),
    with: ["prototype_network_v1"],
  },
  prototype_network_device_v1: {
    ...fixture({
      ...label,
      onTap: [{ type: "request", url: "http://localhost:8080/feed", via: "device" }],
    }),
    with: ["prototype_network_v1"],
  },
  // `requires` is a root-level block a patch cannot introduce, and every module use must be
  // declared there (#14294), so only the show half applies. A permission-only block needs just the
  // vocabulary capability; a declared module also needs its own, with the vocabulary advertised.
  prototype_platform_realtime_v1: {
    ...fixture({
      ...label,
      onTap: [
        {
          type: "upsertData",
          path: "/data/rows",
          key: "/id",
          value: { value: { id: 1 } },
          maxItems: 20,
        },
      ],
    }),
    with: ["prototype_data_actions_v1"],
  },
  prototype_platform_realtime_device_v1: {
    minimalSpec: {
      ...base,
      requires: { platform: ["realtime"] },
      channels: { feed: { kind: "sse", url: "https://example.com/events", via: "device" } },
    },
    ops: [],
    with: ["prototype_platform_v1", "prototype_platform_realtime_v1"],
  },
  prototype_platform_v1: {
    minimalSpec: {
      ...base,
      requires: { permissions: [{ name: "camera", purpose: "Scan a code" }] },
    },
    ops: [],
  },
  prototype_platform_clipboard_v1: {
    minimalSpec: {
      ...base,
      requires: { platform: ["clipboard"] },
      root: { type: "pasteButton", into: "/data/paste" },
    },
    ops: [],
    with: ["prototype_platform_v1"],
  },
  prototype_platform_device_v1: {
    minimalSpec: {
      ...base,
      requires: { platform: ["device"] },
      root: {
        ...base.root,
        children: [{ ...label, text: "{platform:/device/os}" }],
      },
    },
    ops: [],
    with: ["prototype_platform_v1"],
  },
  prototype_platform_haptics_v1: {
    minimalSpec: {
      ...base,
      requires: { platform: ["haptics"] },
      root: {
        ...base.root,
        children: [
          {
            ...label,
            onTap: [
              { type: "platform", call: "haptics.perform", args: { effect: { value: "tick" } } },
            ],
          },
        ],
      },
    },
    ops: [],
    with: ["prototype_platform_v1"],
  },
  prototype_platform_sound_v1: {
    minimalSpec: {
      ...base,
      requires: { platform: ["sound"] },
      root: {
        ...base.root,
        children: [
          {
            ...label,
            onTap: [{ type: "platform", call: "sound.play", args: { sound: { value: "click" } } }],
          },
        ],
      },
    },
    ops: [],
    with: ["prototype_platform_v1"],
  },
  prototype_platform_namespace_v1: fixture({
    ...label,
    ios: { hover: "lift" },
    android: { indication: "none" },
  }),
  prototype_platform_media_items_v1: {
    ...fixture({
      type: "image",
      id: "label",
      asset: { data: "/photo" },
      contentDescription: "Photo",
    }),
    with: ["prototype_data_model_v1"],
  },
  prototype_platform_test_v1: {
    minimalSpec: {
      ...base,
      requires: { platform: ["test"] },
      root: {
        ...base.root,
        children: [
          {
            ...label,
            onTap: [{ type: "platform", call: "test.echo", args: { message: { value: "hi" } } }],
          },
        ],
      },
    },
    ops: [],
    with: ["prototype_platform_v1"],
  },
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
const parityFixtures: [string, { minimalSpec: unknown; ops: unknown[]; with?: string[] }][] = [
  ...Object.entries(fixtures),
  [
    "prototype_lazy_list_v1",
    {
      ...fixture({
        ...label,
        onTap: [{ type: "prependData", path: "/data/rows", value: { value: { id: 2 } } }],
      }),
      with: ["prototype_data_model_v1", "prototype_data_actions_v1"],
    },
  ],
];
const cases = parityFixtures.flatMap(([capability, value]) =>
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
let env: NodeJS.ProcessEnv;
function setup() {
  env = {};
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
    env,
    shaderAssetCache: new FakePrototypeAssetCache(),
    assetFileReader: {
      stat: async () => ({ isFile: () => true, size: 23 }),
      readFile: async () => Buffer.from("uniform float strength;"),
    },
    clientFactory: () => proxy,
    agentConnections: { get: () => agent },
    store,
    timer,
    clock: timer,
    cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    // A via "device" request to localhost makes show run `adb reverse`; keep it off the real adb.
    adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
  });
}
async function call(device: BootedDevice, input: Record<string, unknown>) {
  const result = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
  return prototypeOutputSchema.parse(readToolResponse(result).structuredContent);
}
const show = (device: BootedDevice, spec: unknown) => call(device, { action: "show", spec });
const patch = (device: BootedDevice, ops: unknown, extra = {}) =>
  call(device, { action: "patch", id: base.id, ops, ...extra });
const requests = (device: BootedDevice) =>
  device.platform === "android" ? proxy.patchRequests : agent.patchRequests;
function advertise(...capabilities: string[]) {
  proxy.setSupportedCommands(["prototype_patch_v1", ...capabilities]);
  agent.handshake.capabilities.push(...capabilities);
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
  async ({ capability, minimalSpec, ops, device, with: others }) => {
    advertise(...(others ?? []));
    const refusedShow = await show(device, minimalSpec);
    expect(refusedShow.success).toBe(false);
    expect(refusedShow.error).toContain(
      capability === "prototype_custom_shaders_v1" && device.platform === "ios"
        ? "Android only"
        : capability,
    );
    expect(proxy.getPrototypeHistory()).toEqual([]);
    expect(agent.requests).toEqual([]);
    expect((await show(device, base)).success).toBe(true);
    if (ops.length === 0) {
      return;
    }
    const before = store.shownSpecs.read(device.deviceId, base.id);
    const sent = agent.requests.length;
    const refusedPatch = await patch(device, ops);
    expect(refusedPatch.success).toBe(false);
    expect(refusedPatch.error).toContain(
      capability === "prototype_custom_shaders_v1" && device.platform === "ios"
        ? "Android only"
        : capability,
    );
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
  async ({ capability, minimalSpec, ops, device, with: others }) => {
    advertise(capability, ...(others ?? []));
    if (capability === "prototype_custom_shaders_v1") {
      const refused = await show(device, minimalSpec);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain(
        device.platform === "ios" ? "Android only" : "AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1",
      );
      return;
    }
    expect((await show(device, minimalSpec)).success).toBe(true);
    expect(
      (
        await patch(device, [{ op: "replace", path: "/state/liked", value: true }], {
          baseRevision: 1,
        })
      ).success,
    ).toBe(true);
    expect((await show(device, base)).success).toBe(true);
    if (ops.length > 0) {
      expect((await patch(device, ops)).success).toBe(true);
    }
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
let capabilitySource: string;
beforeAll(() => {
  const server = new URL("../../src/server/", import.meta.url);
  const files = [
    "prototypeTools.ts",
    ...new Bun.Glob("prototypeTools/**/*.ts").scanSync({ cwd: fileURLToPath(server) }),
  ];
  expect(files.length).toBeGreaterThan(1);
  capabilitySource = files.map((file) => readFileSync(new URL(file, server), "utf8")).join("\n");
});
test("prototypeTools routes spec feature detection through the registry", () => {
  const source = capabilitySource;
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

test.each(["android", "ios"] as const)(
  "%s rechecks strings capability on a state-only patch of an existing string spec",
  async (platform) => {
    const device: BootedDevice = { platform, deviceId: `parity-${platform}`, name: "Fake" };
    advertise("prototype_strings_v1");
    expect((await show(device, fixtures.prototype_strings_v1!.minimalSpec)).success).toBe(true);
    advertise();
    const index = agent.handshake.capabilities.indexOf("prototype_strings_v1");
    agent.handshake.capabilities.splice(index, 1);
    const result = await patch(device, [{ op: "replace", path: "/state/liked", value: true }], {
      baseRevision: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("prototype_strings_v1");
    expect(requests(device)).toEqual([]);
  },
);

test("shader opt-in refusal also covers host-only screenMap and save specs", async () => {
  const spec = fixtures.prototype_custom_shaders_v1.minimalSpec;
  const device: BootedDevice = { platform: "android", deviceId: "parity-android", name: "Fake" };
  for (const action of ["screenMap", "save"]) {
    const refused = await call(device, {
      action,
      spec,
      ...(action === "save" ? { label: "Effect" } : {}),
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1");
  }
  expect(proxy.getPrototypeHistory()).toEqual([]);
});

test("Android shader gate accepts env-on show, assets and patch with capability advertised", async () => {
  env.AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS = "1";
  advertise("prototype_custom_shaders_v1");
  const device: BootedDevice = { platform: "android", deviceId: "parity-android", name: "Fake" };
  const { minimalSpec, ops } = fixtures.prototype_custom_shaders_v1;
  expect(
    (
      await call(device, {
        action: "show",
        spec: minimalSpec,
        assets: [{ id: "effect", path: "/effect.agsl" }],
      })
    ).success,
  ).toBe(true);
  expect(proxy.getPrototypeHistory()).toHaveLength(1);
  expect(
    await patch(device, [{ op: "replace", path: "/state/liked", value: true }], {
      baseRevision: 1,
    }),
  ).toMatchObject({ success: true });
  expect((await show(device, base)).success).toBe(true);
  expect((await patch(device, ops)).success).toBe(true);
});

test("iOS shader refusal wins with env-on and capability advertised, including patches", async () => {
  env.AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS = "1";
  advertise("prototype_custom_shaders_v1");
  const device: BootedDevice = { platform: "ios", deviceId: "parity-ios", name: "Fake" };
  const { minimalSpec, ops } = fixtures.prototype_custom_shaders_v1;
  for (const action of ["show", "save", "screenMap"]) {
    const refused = await call(device, {
      action,
      spec: minimalSpec,
      ...(action === "save" ? { label: "Effect" } : {}),
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("Android only");
  }
  expect((await show(device, base)).success).toBe(true);
  const refused = await patch(device, ops);
  expect(refused.success).toBe(false);
  expect(refused.error).toContain("Android only");
  expect(agent.patchRequests).toEqual([]);
});

test("Android shader capability is required even with host opt-in enabled", async () => {
  env.AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS = "1";
  const device: BootedDevice = { platform: "android", deviceId: "parity-android", name: "Fake" };
  const refused = await show(device, fixtures.prototype_custom_shaders_v1.minimalSpec);
  expect(refused.success).toBe(false);
  expect(refused.error).toContain("does not advertise prototype_custom_shaders_v1");
  expect(proxy.getPrototypeHistory()).toEqual([]);
});

test("Android shader asset repair retains the injected opt-in environment", async () => {
  env.AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS = "1";
  advertise("prototype_custom_shaders_v1");
  proxy.queuePrototypeResults({ success: true, missingAssets: ["effect"] }, { success: true });
  const device: BootedDevice = { platform: "android", deviceId: "parity-android", name: "Fake" };
  const accepted = await call(device, {
    action: "show",
    spec: fixtures.prototype_custom_shaders_v1.minimalSpec,
    assets: [{ id: "effect", path: "/effect.agsl" }],
  });
  expect(accepted.success).toBe(true);
  expect(proxy.getPrototypeAssetHistory()).toHaveLength(2);
  expect(proxy.getPrototypeHistory()).toHaveLength(2);
});

test.each(["android", "ios"] as const)(
  "%s refuses every authored window transition without window motion capability",
  async (platform) => {
    const device: BootedDevice = { platform, deviceId: `window-${platform}`, name: "Fake" };
    for (const transition of ["auto", "none", "fade", "slide", "scale"]) {
      const result = await show(device, { ...base, window: { ...base.window, transition } });
      expect(result.success).toBe(false);
      expect(result.error).toContain("prototype_window_motion_v1");
    }
    expect(proxy.getPrototypeHistory()).toEqual([]);
    expect(agent.requests).toEqual([]);
    advertise("prototype_window_motion_v1");
    expect(
      (await show(device, { ...base, window: { ...base.window, transition: "scale" } })).success,
    ).toBe(true);
  },
);
