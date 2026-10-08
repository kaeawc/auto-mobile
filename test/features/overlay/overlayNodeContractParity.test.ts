import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import contract from "../../../schemas/overlay-spec-contract.json";
import {
  OVERLAY_COLOR_ROLES,
  OVERLAY_NODE_TYPES,
  overlayNodeSchema,
  overlaySpecSchema,
} from "../../../src/features/overlay/overlaySpec";
import { validateOverlaySpec } from "../../../src/features/overlay/overlayValidation";

type ContractFields = Record<string, { rule: Record<string, unknown> }>;
const contractNodes = contract.definitions.node.variants as unknown as Record<
  string,
  { fields: ContractFields }
>;

/** The Zod node union, unwrapped from its lazy wrapper, keyed by node type. */
function zodNodeShapes(): Map<string, string[]> {
  const union = (overlayNodeSchema as unknown as z.ZodLazy<z.ZodDiscriminatedUnion<"type", []>>)
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

describe("overlay node contract parity", () => {
  test("the Zod schema and the shared contract list the same node types", () => {
    expect([...zodNodeShapes().keys()].sort()).toEqual([...OVERLAY_NODE_TYPES].sort());
    expect(Object.keys(contractNodes).sort()).toEqual([...OVERLAY_NODE_TYPES].sort());
  });

  test.each([...OVERLAY_NODE_TYPES])("%s has the same fields in Zod and the contract", (type) => {
    const contractFields = Object.keys(contractNodes[type].fields).sort();
    expect(zodNodeShapes().get(type)).toEqual(contractFields);
    expect(contractFields).toEqual(expect.arrayContaining(COMMON_NODE_FIELDS));
  });

  test.each(["switch", "checkbox", "button"])("%s accepts transition in both validators", (t) => {
    const node = t === "button" ? { type: t, label: "Go" } : { type: t, stateKey: "on" };
    const candidate = spec({ ...node, transition: "fade" }, { on: false });
    expect(validateOverlaySpec(candidate)).toMatchObject({ success: true });
    expect(overlaySpecSchema.safeParse(candidate).success).toBe(true);
  });

  test("theme colours have the same fields in Zod and the contract, one per colour role", () => {
    const colors = overlaySpecSchema.shape.theme.unwrap().innerType().shape.colors.unwrap();
    const zodFields = Object.keys(colors.innerType().shape).sort();
    const contractFields = Object.keys(contract.definitions.themeColors.fields).sort();
    expect(zodFields).toEqual(contractFields);
    expect(contractFields.filter((field) => field !== "seed" && field !== "source")).toEqual(
      [...OVERLAY_COLOR_ROLES].sort(),
    );
  });

  test("a role override takes hex only in both validators", () => {
    const themed = (colors: Record<string, string>) => ({
      ...spec({ type: "text", text: "x" }),
      theme: { colors },
    });
    for (const colors of [{ primary: "#B3261E" }, { seed: "#6750A4", surface: "#FFFFFF" }]) {
      expect(validateOverlaySpec(themed(colors))).toMatchObject({ success: true });
      expect(overlaySpecSchema.safeParse(themed(colors)).success).toBe(true);
    }
    for (const colors of [{ primary: "onSurface" }, { brand: "#6750A4" }]) {
      expect(validateOverlaySpec(themed(colors))).toMatchObject({ success: false });
      expect(overlaySpecSchema.safeParse(themed(colors)).success).toBe(false);
    }
  });
});
