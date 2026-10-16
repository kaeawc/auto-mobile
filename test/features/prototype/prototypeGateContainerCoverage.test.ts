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
// Minimal feature nodes mirrored from the server parity fixtures. Keeping them here avoids
// editing the server test outside this lane's permitted paths. No gate/container exceptions:
// every current gate can be activated by a node, including theme and data via inline values.
const fixtures: Record<string, Node> = {
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
  prototype_flow_grid_v1: { type: "flow", children: [label] },
  prototype_pager_options_v1: { type: "pager", axis: "horizontal", children: [label] },
  prototype_gestures_v1: { ...label, onLongPress: [{ type: "emit", name: "long" }] },
  prototype_carousel_v1: { type: "carousel", itemWidth: 120, children: [label] },
  prototype_refresh_v1: {
    type: "scroll",
    refresh: { stateKey: "refreshing", onRefresh: [{ type: "emit", name: "refresh" }] },
    child: label,
  },
  prototype_search_bar_v1: {
    type: "searchBar",
    stateKey: "query",
    activeKey: "active",
    child: label,
  },
  prototype_rich_text_v1: { type: "text", spans: [{ text: "Hello" }] },
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
};

// One table drives the gate matrix and contract coverage, including every node-bearing variant.
const containers: {
  name: string;
  field?: string;
  prefix: string;
  wrap: (node: Node) => Node;
}[] = [
  { name: "root", prefix: "root", wrap: (root) => ({ root }) },
  ...["scroll", "dialog", "bottomSheet", "searchBar"].map((type) => ({
    name: type,
    field: "child",
    prefix: "root.child",
    wrap: (child: Node) => ({ root: { type, child } }),
  })),
  ...["box", "row", "column", "flow", "grid", "carousel", "card", "pager"].map((type) => ({
    name: type,
    field: "children",
    prefix: "root.children[0]",
    wrap: (node: Node) => ({ root: { type, children: [node] } }),
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
const ROOT_LEVEL_GATES = ["prototype_storage_v1"];

test("every capability gate has a container fixture or is a root-level gate", () => {
  expect([...Object.keys(fixtures), ...ROOT_LEVEL_GATES].sort()).toEqual(
    PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.capability).sort(),
  );
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
  const actual = prototypeNodeChildren({ child: node, children: [node], screens: { home: node } });
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
