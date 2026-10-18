import type { ObserveResult } from "../../../src/models/ObserveResult";

/**
 * Reads one field off the root node of an observation's hierarchy. Test fixtures
 * tag nodes with ad-hoc fields (`marker`, `text`) outside the node model, so the
 * read goes through Reflect instead of a cast.
 */
export function rootNodeField(observation: ObserveResult, field: string): unknown {
  const node = observation.viewHierarchy?.hierarchy?.node;
  return node === undefined ? undefined : Reflect.get(node, field);
}
