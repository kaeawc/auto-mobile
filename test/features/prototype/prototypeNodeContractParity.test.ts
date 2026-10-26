import {
  PROTOTYPE_ACTION_TYPES,
  actionSchema,
} from "../../../src/features/prototype/prototypeSpec";
import { PROTOTYPE_EVENT_KINDS } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_COLOR_ROLES,
  PROTOTYPE_NODE_TYPES,
  prototypeNodeSchema,
  prototypeSpecSchema,
} from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

type ContractFields = Record<string, { rule: Record<string, unknown> }>;
const contractNodes: Record<string, { fields: ContractFields }> =
  contract.definitions.node.variants;

/** Narrow a Zod schema to a class through its public `instanceof` support, or fail loudly. */
function expectSchema<T extends z.ZodTypeAny>(
  schema: unknown,
  type: abstract new (...args: never[]) => T,
  what: string,
): T {
  if (!(schema instanceof type)) {
    throw new Error(`expected ${what} to be a ${type.name}`);
  }
  return schema;
}

/** The Zod node union's object options, unwrapped from the refinement and lazy wrappers. */
function zodNodeOptions(): z.AnyZodObject[] {
  const refined = expectSchema(prototypeNodeSchema, z.ZodEffects, "the node schema");
  const lazy = expectSchema(refined.innerType(), z.ZodLazy, "the refined node schema");
  const union = expectSchema(lazy.schema, z.ZodDiscriminatedUnion, "the lazy node schema");
  return [...union.options].map((option) => expectSchema(option, z.ZodObject, "a node variant"));
}

/** The Zod node union keyed by node type. */
function zodNodeShapes(): Map<string, string[]> {
  const shapes = new Map<string, string[]>();
  for (const option of zodNodeOptions()) {
    const type = expectSchema(option.shape.type, z.ZodEnum, "a node type tag").options[0];
    shapes.set(type, Object.keys(option.shape).sort());
  }
  return shapes;
}

// Every node carries these; a node type added without one is the #10557 crossing again.
const COMMON_NODE_FIELDS = [
  "semantics",
  "span",
  "id",
  "testTag",
  "contentDescription",
  "onTap",
  "style",
  "styleWhen",
  "visibleWhen",
  "transition",
  "animate",
  "anchor",
  "safeAreaPadding",
];

const GESTURE_NODE_TYPES = ["box", "row", "column", "text", "image", "icon", "card"];
const GESTURE_NODE_FIELDS = ["onLongPress", "onDoubleTap"];

function spec(root: Record<string, unknown>, state: Record<string, unknown> = {}) {
  return { id: "panel", window: { placement: { type: "fullscreen" }, opacity: 1 }, state, root };
}

describe("prototype node contract parity", () => {
  test("searchBar exposes its exact wire fields in both contracts", () => {
    const candidate = spec(
      {
        type: "searchBar",
        stateKey: "query",
        activeKey: "active",
        child: { type: "text", text: "Result" },
      },
      { query: "", active: true },
    );
    expect(validatePrototypeSpec(candidate).success).toBe(true);
    expect(prototypeSpecSchema.safeParse(candidate).success).toBe(true);
    expect(contractNodes.searchBar).toBeDefined();
  });
  test("the Zod schema and the shared contract list the same node types", () => {
    expect([...zodNodeShapes().keys()].sort()).toEqual([...PROTOTYPE_NODE_TYPES].sort());
    expect(Object.keys(contractNodes).sort()).toEqual([...PROTOTYPE_NODE_TYPES].sort());
  });

  test.each([...PROTOTYPE_NODE_TYPES])("%s has the same fields in Zod and the contract", (type) => {
    const contractFields = Object.keys(contractNodes[type].fields).sort();
    expect(zodNodeShapes().get(type)).toEqual(contractFields);
    expect(contractFields).toEqual(expect.arrayContaining(COMMON_NODE_FIELDS));
    for (const field of GESTURE_NODE_FIELDS) {
      const supported = GESTURE_NODE_TYPES.includes(type);
      expect(contractFields.includes(field)).toBe(supported);
      expect(zodNodeShapes().get(type)?.includes(field)).toBe(supported);
    }
  });

  test("style has the same fields in Zod and the contract", () => {
    const box = zodNodeOptions()[0];
    const style = expectSchema(
      expectSchema(box.shape.style, z.ZodOptional, "the style field").unwrap(),
      z.ZodObject,
      "the style schema",
    );
    const contractStyle: ContractFields = contract.definitions.style.fields;
    expect(Object.keys(style.shape).sort()).toEqual(Object.keys(contractStyle).sort());
  });

  test("per-corner radii and text polish pass both validators and reject the same inputs", () => {
    const accepted = spec({
      type: "text",
      text: "t",
      style: {
        cornerRadius: { topStart: 12, bottomEnd: 0 },
        shadowColor: "primary",
        offset: { x: 1, y: -1 },
        lineHeight: 20,
        letterSpacing: -0.5,
        textDecoration: "lineThrough",
        fontStyle: "italic",
        overflow: "ellipsis",
      },
    });
    expect(validatePrototypeSpec(accepted)).toMatchObject({ success: true });
    expect(prototypeSpecSchema.safeParse(accepted).success).toBe(true);
    for (const cornerRadius of [{ top: 1 }, { topEnd: -1 }, { topEnd: "large" }]) {
      const rejected = spec({ type: "text", text: "t", style: { cornerRadius } });
      expect(validatePrototypeSpec(rejected)).toMatchObject({ success: false });
      expect(prototypeSpecSchema.safeParse(rejected).success).toBe(false);
    }
  });

  test("pressScale accepts 0.5-1 and rejects the same out-of-range values in both validators", () => {
    for (const [pressScale, ok] of [
      [0.5, true],
      [0.9, true],
      [1, true],
      [0.49, false],
      [1.01, false],
    ] as const) {
      const candidate = spec({ type: "text", text: "t", style: { pressScale } });
      expect(validatePrototypeSpec(candidate).success).toBe(ok);
      expect(prototypeSpecSchema.safeParse(candidate).success).toBe(ok);
    }
  });

  test.each(["switch", "checkbox", "button"])("%s accepts transition in both validators", (t) => {
    const node = t === "button" ? { type: t, label: "Go" } : { type: t, stateKey: "on" };
    const candidate = spec({ ...node, transition: "fade" }, { on: false });
    expect(validatePrototypeSpec(candidate)).toMatchObject({ success: true });
    expect(prototypeSpecSchema.safeParse(candidate).success).toBe(true);
  });

  test("theme colours have the same fields in Zod and the contract, one per colour role", () => {
    const colors = prototypeSpecSchema.shape.theme.unwrap().innerType().shape.colors.unwrap();
    const zodFields = Object.keys(colors.innerType().shape).sort();
    const contractFields = Object.keys(contract.definitions.themeColors.fields).sort();
    expect(zodFields).toEqual(contractFields);
    const nonRoles = ["seed", "source", "light", "dark"];
    expect(contractFields.filter((field) => !nonRoles.includes(field))).toEqual(
      [...PROTOTYPE_COLOR_ROLES].sort(),
    );
    expect(contract.definitions.colorRole.values).toEqual([...PROTOTYPE_COLOR_ROLES]);
    // A per-mode map overrides exactly the roles the flat overrides do.
    expect(Object.keys(contract.definitions.themeModeColors.fields)).toEqual([
      ...PROTOTYPE_COLOR_ROLES,
    ]);
  });

  test("a role override takes hex only in both validators", () => {
    const themed = (colors: Record<string, string>) => ({
      ...spec({ type: "text", text: "x" }),
      theme: { colors },
    });
    for (const colors of Array.of<Record<string, string>>(
      { primary: "#B3261E" },
      { seed: "#6750A4", surface: "#FFFFFF" },
    )) {
      expect(validatePrototypeSpec(themed(colors))).toMatchObject({ success: true });
      expect(prototypeSpecSchema.safeParse(themed(colors)).success).toBe(true);
    }
    for (const colors of Array.of<Record<string, string>>(
      { primary: "onSurface" },
      { brand: "#6750A4" },
    )) {
      expect(validatePrototypeSpec(themed(colors))).toMatchObject({ success: false });
      expect(prototypeSpecSchema.safeParse(themed(colors)).success).toBe(false);
    }
  });
});

test("spec, repeat, and condition field sets stay in step with the data contract", () => {
  expect(Object.keys(prototypeSpecSchema.shape).sort()).toEqual(
    Object.keys(contract.definitions.spec.fields).sort(),
  );
  const valid = {
    id: "orders",
    window: { placement: { type: "fullscreen" }, opacity: 1 },
    data: { orders: [{ id: 7 }] },
    root: {
      type: "column",
      repeat: { items: { path: "/orders" }, as: "item", key: "id" },
      children: [{ type: "text", text: "x", visibleWhen: { data: "/orders/0/id", equals: 7 } }],
    },
  };
  expect(prototypeSpecSchema.safeParse(valid).success).toBe(true);
  expect(validatePrototypeSpec(valid).success).toBe(true);
  for (const condition of [
    { data: "/n", key: "n", equals: 1 },
    { data: "/n" },
    { data: "/n", equals: 1, gt: 0 },
  ]) {
    const candidate = { ...valid, root: { type: "text", text: "x", visibleWhen: condition } };
    expect(prototypeSpecSchema.safeParse(candidate).success).toBe(false);
    expect(validatePrototypeSpec(candidate).success).toBe(false);
  }
});

test.each(["menu", "select"])("%s participates in common node contract parity", (type) => {
  expect(PROTOTYPE_NODE_TYPES).toContain(type);
  expect(Object.keys(contractNodes[type].fields)).toEqual(
    expect.arrayContaining(COMMON_NODE_FIELDS),
  );
});

test("stack actions and events agree with the shared contract", () => {
  expect(Object.keys(contract.definitions.action.variants).sort()).toEqual(
    [...PROTOTYPE_ACTION_TYPES].sort(),
  );
  expect(actionSchema.options.map((option) => option.shape.type.options[0]).sort()).toEqual(
    [...PROTOTYPE_ACTION_TYPES].sort(),
  );
  expect([...contract.eventKinds].sort()).toEqual([...PROTOTYPE_EVENT_KINDS].sort());
});

test("emit context Zod and record contract agree on binding forms and entry limits", () => {
  const candidate = (context: unknown) =>
    spec({ type: "text", text: "x", onTap: [{ type: "emit", name: "pick", context }] });
  for (const context of [
    { a: { state: "count" } },
    { a: { data: "/row" } },
    { a: { value: [true, null] } },
    {},
    Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`e${i}`, { value: i }])),
  ]) {
    expect(prototypeSpecSchema.safeParse(candidate(context)).success).toBe(true);
    expect(validatePrototypeSpec(candidate(context)).success).toBe(true);
  }
  for (const context of [
    { "": { value: 1 } },
    { a: { index: false } },
    { a: { state: "x", value: 1 } },
    { a: { unknown: 1 } },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`e${i}`, { value: i }])),
  ]) {
    expect(prototypeSpecSchema.safeParse(candidate(context)).success).toBe(false);
    expect(validatePrototypeSpec(candidate(context)).success).toBe(false);
  }
});
