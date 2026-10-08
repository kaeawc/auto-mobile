import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import contract from "../../../schemas/overlay-spec-contract.json";
import {
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
});
