import type { ObserveResult } from "../../../src/models/ObserveResult";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";

/**
 * Reads one attribute off the root node of an observation's hierarchy. Test fixtures
 * tag nodes with ad-hoc flat attributes (`marker`, `text`), which the model reads
 * through `nodeAttributes`.
 */
export function rootNodeField(observation: ObserveResult | undefined, field: string): unknown {
  const node = observation?.viewHierarchy?.hierarchy?.node;
  return node === undefined ? undefined : nodeAttributes(node)[field];
}
