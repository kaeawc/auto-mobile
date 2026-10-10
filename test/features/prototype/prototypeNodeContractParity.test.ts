import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_COLOR_ROLES,
  PROTOTYPE_NODE_TYPES,
  prototypeNodeSchema,
  prototypeSpecSchema,
} from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

type ContractFields = Record<string, { rule: Record<string, unknown> }>;
const contractNodes = contract.definitions.node.variants as unknown as Record<
  string,
  { fields: ContractFields }
>;

/** The Zod node union, unwrapped from its lazy wrapper, keyed by node type. */
function zodNodeShapes(): Map<string, string[]> {
  const union = (prototypeNodeSchema as unknown as z.ZodLazy<z.ZodDiscriminatedUnion<"type", []>>)
    .schema;
  const shapes = new Map<string, string[]>();
  for (const option of union.options as z.AnyZodObject[]) {
    const type = (option.shape.type as z.ZodEnum<[string]>).options[0];
    shapes.set(type, Object.keys(option.shape).sort());
  }
  return shapes;
}

// Every node carries these; a node type added without one is the #10557 crossing again.
const COMMON_NODE_FIELDS = [
  "id",
  "testTag",
  "contentDescription",
  "onTap",
  "style",
  "styleWhen",
  "visibleWhen",
  "transition",
  "anchor",
  "safeAreaPadding",
];

function spec(root: Record<string, unknown>, state: Record<string, unknown> = {}) {
  return { id: "panel", window: { placement: { type: "fullscreen" } }, state, root };
}

describe("prototype node contract parity", () => {
  test("the Zod schema and the shared contract list the same node types", () => {
    expect([...zodNodeShapes().keys()].sort()).toEqual([...PROTOTYPE_NODE_TYPES].sort());
    expect(Object.keys(contractNodes).sort()).toEqual([...PROTOTYPE_NODE_TYPES].sort());
  });

  test.each([...PROTOTYPE_NODE_TYPES])("%s has the same fields in Zod and the contract", (type) => {
    const contractFields = Object.keys(contractNodes[type].fields).sort();
    expect(zodNodeShapes().get(type)).toEqual(contractFields);
    expect(contractFields).toEqual(expect.arrayContaining(COMMON_NODE_FIELDS));
  });

  test("style has the same fields in Zod and the contract", () => {
    const union = (prototypeNodeSchema as unknown as z.ZodLazy<z.ZodDiscriminatedUnion<"type", []>>)
      .schema;
    const box = (union.options as z.AnyZodObject[])[0];
    const style = (box.shape.style as z.ZodOptional<z.AnyZodObject>).unwrap();
    const contractStyle = contract.definitions.style.fields as unknown as ContractFields;
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
    expect(contractFields.filter((field) => field !== "seed" && field !== "source")).toEqual(
      [...PROTOTYPE_COLOR_ROLES].sort(),
    );
  });

  test("a role override takes hex only in both validators", () => {
    const themed = (colors: Record<string, string>) => ({
      ...spec({ type: "text", text: "x" }),
      theme: { colors },
    });
    for (const colors of [{ primary: "#B3261E" }, { seed: "#6750A4", surface: "#FFFFFF" }]) {
      expect(validatePrototypeSpec(themed(colors))).toMatchObject({ success: true });
      expect(prototypeSpecSchema.safeParse(themed(colors)).success).toBe(true);
    }
    for (const colors of [{ primary: "onSurface" }, { brand: "#6750A4" }]) {
      expect(validatePrototypeSpec(themed(colors))).toMatchObject({ success: false });
      expect(prototypeSpecSchema.safeParse(themed(colors)).success).toBe(false);
    }
  });
});
