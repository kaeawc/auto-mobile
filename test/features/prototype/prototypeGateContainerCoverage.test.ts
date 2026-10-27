import { expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_SPEC_CAPABILITY_GATES,
  prototypeRequiredCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  prototypeNodeChildren,
  prototypeSpecNodeRoots,
  walkPrototypeNodes,
} from "../../../src/features/prototype/prototypeNodeChildren";
import { prototypeChecksFields } from "../../../src/features/prototype/prototypeChecksCapability";

type Node = Record<string, unknown>;
const label = { type: "text", text: "Hello" };
const platformCall = {
  ...label,
  onTap: [{ type: "platform", call: "test.echo", args: { message: { value: "hi" } } }],
};
const hapticsCall = {
  ...label,
  onTap: [
    {
      type: "platform",
      call: "haptics.perform",
      args: { effect: { value: "click" } },
    },
  ],
};
const soundCall = {
  ...label,
  onTap: [
    {
      type: "platform",
      call: "sound.play",
      args: { sound: { value: "send" }, volume: { value: 80 } },
    },
  ],
};
const deviceRead = { ...label, visibleWhen: { platform: "/device/os", equals: "android" } };
// Minimal feature nodes mirrored from the server parity fixtures. Keeping them here avoids
// editing the server test outside this lane's permitted paths. No gate/container exceptions:
// every current gate can be activated by a node, including theme and data via inline values.
const fixtures: Record<string, Node> = {
  prototype_style_polish_v2: { ...label, style: { cornerStyle: "continuous" } },
  prototype_tooltip_v1: {
    type: "tooltip",
    text: "Tip",
    anchorTo: "target",
    openWhen: { key: "liked", equals: true },
  },
  prototype_drawer_v1: {
    type: "drawer",
    edge: "start",
    openWhen: { key: "liked", equals: true },
    child: { type: "spacer" },
  },
  prototype_strings_v1: { ...label, text: "{t:title}" },
  prototype_semantics_v1: { ...label, semantics: { heading: true } },
  prototype_format_v1: {
    type: "column",
    repeat: {
      items: [{ n: 1 }],
      as: "item",
      derive: { nText: { of: { item: "n" }, format: { number: {} } } },
    },
    children: [label],
  },
  prototype_platform_namespace_v1: { ...label, ios: { hover: "lift" } },
  prototype_theme_modes_v1: {
    ...label,
    style: { background: { light: "#FFFFFF", dark: "#000000" } },
  },
  prototype_data_model_v1: { ...label, text: "{data:/x}" },
  prototype_text_field_options_v1: { type: "textField", stateKey: "name", label: "Name" },
  prototype_text_field_actions_v1: {
    type: "textField",
    stateKey: "name",
    imeAction: "done",
    onSubmit: [{ type: "emit", name: "submit" }],
  },
  prototype_text_field_leading_icon_v1: {
    type: "textField",
    stateKey: "name",
    leadingIcon: "search",
  },
  prototype_custom_shaders_v1: { ...label, style: { shader: { asset: "effect" } } },
  prototype_flow_grid_v1: { type: "flow", children: [label] },
  prototype_pager_state_key_v1: { type: "pager", stateKey: "page", children: [label] },
  prototype_bar_scroll_v1: { type: "topAppBar", title: "Feed", onScroll: "pinned" },
  prototype_pager_options_v1: { type: "pager", axis: "horizontal", children: [label] },
  prototype_scroll_motion_v1: {
    ...label,
    scrollLinked: { source: "feed", range: [0, 160], alpha: [1, 0] },
  },
  prototype_gestures_v1: { ...label, onLongPress: [{ type: "emit", name: "long" }] },
  prototype_carousel_v1: { type: "carousel", itemWidth: 120, children: [label] },
  prototype_refresh_v1: {
    type: "scroll",
    refresh: { stateKey: "refreshing", onRefresh: [{ type: "emit", name: "refresh" }] },
    child: label,
  },
  prototype_swipe_actions_v1: {
    type: "row",
    swipeActions: { end: [{ label: "Delete", onTap: [{ type: "emit", name: "delete" }] }] },
    children: [label],
  },
  prototype_search_bar_v1: {
    type: "searchBar",
    stateKey: "query",
    activeKey: "active",
    child: label,
  },
  prototype_string_conditions_v1: { ...label, visibleWhen: { key: "name", contains: "A" } },
  prototype_loading_states_v1: { type: "box", style: { shimmer: true }, children: [label] },
  prototype_effects_v1: { ...label, style: { effects: [{ type: "noise" }] } },
  prototype_motion_v2: { ...label, animate: { durationMs: 300 } },
  prototype_shared_element_v2: { ...label, shared: { key: "hero", as: "bounds" } },
  prototype_shared_element_v1: { ...label, sharedKey: "hero" },
  prototype_stack_transitions_v1: {
    ...label,
    onTap: [{ type: "push", stack: "nav", screen: "home", transition: "slide" }],
  },
  prototype_choreography_v1: { ...label, transition: { type: "fade", delayMs: 100 } },
  prototype_lazy_list_v1: {
    type: "list",
    repeat: { items: { path: "/rows" }, as: "row", key: "id" },
    children: [label],
  },
  prototype_chart_v1: {
    type: "chart",
    variant: "line",
    series: [{ path: "/points", y: "y", label: "Points" }],
  },
  prototype_rich_text_v1: { type: "text", spans: [{ text: "Hello" }] },
  prototype_linkify_v1: {
    type: "text",
    text: "@ana",
    linkify: { kinds: ["mention"], onTap: [{ type: "emit", name: "link" }] },
  },
  prototype_timers_v1: {
    ...label,
    onTap: [
      { type: "startTimer", id: "tick", afterMs: 100, actions: [{ type: "emit", name: "tick" }] },
    ],
  },
  prototype_chat_scroll_v1: { type: "scroll", reverse: true, child: label },
  prototype_menus_v1: {
    type: "menu",
    openWhen: { key: "liked", equals: true },
    items: [{ label: "Open" }],
  },
  prototype_stack_v1: { type: "stack", start: "home", screens: { home: label } },
  prototype_emit_context_v1: {
    ...label,
    onTap: [{ type: "emit", name: "pick", context: { id: { state: "liked" } } }],
  },
  prototype_checks_v1: {
    type: "button",
    label: "Save",
    enabledWhen: { key: "liked", equals: true },
  },
  prototype_data_actions_v1: {
    ...label,
    onTap: [{ type: "setData", path: "/data/count", value: { value: 1 } }],
  },
  prototype_network_v1: {
    ...label,
    onTap: [{ type: "request", url: "http://localhost:8080/feed", into: "/data/feed" }],
  },
  prototype_network_device_v1: {
    ...label,
    onTap: [{ type: "request", url: "http://localhost:8080/feed", via: "device" }],
  },
  prototype_platform_v1: platformCall,
  prototype_platform_test_v1: platformCall,
  prototype_platform_device_v1: deviceRead,
  prototype_platform_clipboard_v1: { type: "pasteButton", into: "/data/code" },
  prototype_platform_haptics_v1: hapticsCall,
  prototype_platform_sound_v1: soundCall,
};

// One table drives the gate matrix and contract coverage, including every node-bearing variant.
const containers: {
  name: string;
  field?: string;
  prefix: string;
  wrap: (node: Node) => Node;
}[] = [
  { name: "root", prefix: "root", wrap: (root) => ({ root }) },
  ...["scroll", "dialog", "bottomSheet", "searchBar", "drawer"].map((type) => ({
    name: type,
    field: "child",
    prefix: "root.child",
    wrap: (child: Node) => ({ root: { type, child } }),
  })),
  ...["box", "row", "column", "flow", "grid", "carousel", "card", "pager", "list"].map((type) => ({
    name: type,
    field: "children",
    prefix: "root.children[0]",
    wrap: (node: Node) => ({ root: { type, children: [node] } }),
  })),
  ...["header", "footer"].map((field) => ({
    name: "list",
    field,
    prefix: `root.${field}`,
    wrap: (node: Node) => ({ root: { type: "list", [field]: node } }),
  })),
  {
    name: "stack",
    field: "screens",
    prefix: 'root.screens["home"]',
    wrap: (node) => ({ root: { type: "stack", start: "home", screens: { home: node } } }),
  },
  {
    name: "component",
    prefix: "components.Example.root",
    wrap: (node) => ({ root: label, components: { Example: { root: node } } }),
  },
];

// Gates on a root-level spec field, not a node: no container can hold them, so they get a
// dedicated test below instead of a container fixture.
const ROOT_LEVEL_GATES = [
  "prototype_storage_v1",
  "prototype_backdrop_v1",
  "prototype_design_platform_v1",
  "prototype_reduced_motion_v1",
  "prototype_window_motion_v1",
];

test("every capability gate has a container fixture or is a root-level gate", () => {
  expect([...Object.keys(fixtures), ...ROOT_LEVEL_GATES].sort()).toEqual(
    PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.capability).sort(),
  );
});

test("the backdrop gate reports the window-level backdrop", () => {
  const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find(
    (entry) => entry.capability === "prototype_backdrop_v1",
  )!;
  const spec = { window: { backdrop: { material: "thin" } }, root: label };
  expect(gate.fields(spec)).toEqual(["window.backdrop"]);
  expect(gate.fields({ window: {}, root: label })).toEqual([]);
});

test("the design gate reports only explicit root-level platform design", () => {
  const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find(
    (entry) => entry.capability === "prototype_design_platform_v1",
  )!;
  expect(gate.fields({ root: label, theme: { design: "platform" } })).toEqual(["theme.design"]);
  expect(gate.fields({ root: label, theme: { design: "material" } })).toEqual([]);
  expect(gate.fields({ root: label })).toEqual([]);
});

test("the window motion gate reports window.transition and a repeat stagger", () => {
  const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find(
    (entry) => entry.capability === "prototype_window_motion_v1",
  )!;
  expect(gate.fields({ window: { transition: "fade" }, root: label })).toEqual([
    "window.transition",
  ]);
  expect(gate.fields({ root: label })).toEqual([]);
});

test("the storage gate reports the root-level storage block", () => {
  const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find(
    (entry) => entry.capability === "prototype_storage_v1",
  )!;
  const spec = { root: label, state: { a: 1 }, storage: { version: 1, keys: ["state:a"] } };
  expect(gate.fields(spec)).toEqual(["storage"]);
  expect(gate.fields({ root: label })).toEqual([]);
});

for (const gate of PROTOTYPE_SPEC_CAPABILITY_GATES.filter(
  (entry) => !ROOT_LEVEL_GATES.includes(entry.capability),
)) {
  for (const container of containers) {
    test(`${gate.capability} covers ${container.name}`, () => {
      const spec = container.wrap(fixtures[gate.capability]!);
      const fields = gate.fields(spec);
      expect(fields.length).toBeGreaterThan(0);
      // The stack gate deliberately reports one containing root, rather than every stack node.
      // Other gates must report the nested feature, even when its wrapper uses the same feature.
      if (gate.capability !== "prototype_stack_v1") {
        expect(
          fields.some(
            (field) => field === container.prefix || field.startsWith(`${container.prefix}.`),
          ),
        ).toBe(true);
      }
      expect(
        prototypeRequiredCapabilities(spec).find((entry) => entry.capability === gate.capability)
          ?.fields,
      ).toEqual(fields);
    });
  }
}

function referencesNode(rule: unknown): boolean {
  if (!rule || typeof rule !== "object") {
    return false;
  }
  const value = rule as Record<string, unknown>;
  if (value.kind === "ref" && value.name === "node") {
    return true;
  }
  return Object.values(value).some((child) =>
    Array.isArray(child) ? child.some(referencesNode) : referencesNode(child),
  );
}

test("contract node-reference fields are covered by both the iterator and container matrix", () => {
  const node = { type: "text" };
  const actual = prototypeNodeChildren({
    type: "list",
    child: node,
    children: [node],
    screens: { home: node },
    header: node,
    footer: node,
  });
  const suffixes = actual.map(({ suffix }) => suffix);
  for (const [variant, definition] of Object.entries(contract.definitions.node.variants)) {
    for (const [field, definitionField] of Object.entries(definition.fields)) {
      if (!referencesNode(definitionField.rule)) {
        continue;
      }
      expect(
        containers.some((container) => container.name === variant && container.field === field),
      ).toBe(true);
      expect(
        suffixes.some((suffix) => suffix === `.${field}` || suffix.startsWith(`.${field}[`)),
      ).toBe(true);
    }
  }
});

test("iterator preserves document order, validator screen paths and ignores malformed children", () => {
  const node = { type: "text" };
  const children = prototypeNodeChildren({
    screens: { 'quote"\\': node, home: node, bad: null },
    child: false,
    children: [null, node, [], 7],
  });
  expect(children).toEqual([
    { value: node, suffix: `.screens[${JSON.stringify('quote"\\')}]` },
    { value: node, suffix: '.screens["home"]' },
    { value: node, suffix: ".children[1]" },
  ]);
  expect(prototypeNodeChildren({ child: [], children: {}, screens: [] })).toEqual([]);
  expect(prototypeSpecNodeRoots(null)).toEqual([]);
  const spec = {
    components: { A: { root: node }, bad: null, absent: {} },
    root: { screens: { home: { child: node } }, children: [node] },
  };
  expect(prototypeSpecNodeRoots(spec).map(({ path }) => path)).toEqual([
    "root",
    "components.A.root",
  ]);
  const paths: string[] = [];
  walkPrototypeNodes(spec, (_node, path) => paths.push(path));
  expect(paths).toEqual([
    "root",
    'root.screens["home"]',
    'root.screens["home"].child',
    "root.children[0]",
    "components.A.root",
  ]);
});

test("shared walk handles depth beyond validator limits without recursion", () => {
  let root: Node = { type: "text" };
  for (let index = 0; index < 2048; index++) {
    root = { child: root };
  }
  let count = 0;
  walkPrototypeNodes({ root }, () => count++);
  expect(count).toBe(2049);
});

test("checks cover screen and component roots while keeping opaque structures skipped", () => {
  const check = { checks: [{ required: true, message: "Required" }] };
  expect(
    prototypeChecksFields({
      root: {
        screens: { home: { ...check, payload: check, data: check, state: check, repeat: check } },
      },
      components: { A: { root: { validateOn: "change" } } },
    }),
  ).toEqual(['root.screens["home"].checks', "components.A.root.validateOn"]);
});

test("input checks on a textField do not trip any other capability gate", () => {
  const spec = {
    root: {
      type: "textField",
      stateKey: "name",
      enabledWhen: { key: "on", equals: true },
      checks: [{ required: true, message: "Required" }],
      validateOn: "blur",
    },
  };
  expect(prototypeRequiredCapabilities(spec).map((gate) => gate.capability)).toEqual([
    "prototype_checks_v1",
  ]);
});

for (const container of containers) {
  test(`prependData lazy-list gate covers ${container.name} ${container.field ?? ""}`, () => {
    const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find(
      (g) => g.capability === "prototype_lazy_list_v1",
    )!;
    const candidate = container.wrap({
      ...label,
      onTap: [{ type: "prependData", path: "/data/rows", value: { value: 1 } }],
    });
    expect(gate.fields(candidate)).toContain(`${container.prefix}.onTap[0]`);
  });
}

test("reduced motion gate reports only spec.motion", () => {
  const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find(
    (entry) => entry.capability === "prototype_reduced_motion_v1",
  )!;
  expect(gate.fields({ motion: "reduced", root: label })).toEqual(["motion"]);
  expect(gate.fields({ motion: "standard", root: { motion: "reduced" } })).toEqual([]);
});

for (const container of containers) {
  test(`window motion repeat.stagger covers ${container.name}`, () => {
    const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find(
      (entry) => entry.capability === "prototype_window_motion_v1",
    )!;
    expect(gate.fields(container.wrap({ ...label, repeat: { stagger: { ms: 20 } } }))).toEqual([
      `${container.prefix}.repeat.stagger`,
    ]);
  });
}
