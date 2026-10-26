import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { keySchema, pointerSchema } from "./prototypeActionValues";

/** List-only fields; the caller supplies the shared action and refresh schemas. */
export function prototypeLazyListShape<A extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  action: A,
  refresh: R,
) {
  return {
    type: z.enum(["list"]),
    axis: z.enum(["vertical", "horizontal"]).default("vertical"),
    repeat: z
      .object({ items: z.object({ path: pointerSchema }).strict(), as: keySchema, key: keySchema })
      .strict(),
    spacing: z.number().finite().min(0).optional(),
    contentPadding: z.number().finite().min(0).optional(),
    onEndReached: z.array(action).min(1).max(32).optional(),
    endThreshold: z.number().finite().int().min(1).max(50).optional(),
    refresh: refresh.optional(),
    maxItems: z
      .number()
      .finite()
      .int()
      .min(1)
      .max(contract.limits.MAX_PROTOTYPE_LIST_ITEMS)
      .optional(),
  };
}

/** Recursive node slots, supplied lazily by the main node union. */
export function prototypeLazyListChildren<N extends z.ZodTypeAny>(node: N) {
  return { children: z.array(node).length(1), header: node.optional(), footer: node.optional() };
}

export interface PrototypeLazyListSlots<Node> {
  children: Node[];
  header?: Node;
  footer?: Node;
}
