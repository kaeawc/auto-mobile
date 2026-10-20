import type { ObserveResult } from "../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../models/ViewHierarchyResult";

/**
 * A hierarchy `node` slot as captures put it on the wire: one node, or an array of sibling roots
 * (legacy captures emit the array form in the `Hierarchy` root slot the model types as one node).
 */
export type WireHierarchyNodeSlot = ViewHierarchyNode | ViewHierarchyNode[];

type ModelViewHierarchy = NonNullable<ObserveResult["viewHierarchy"]>;

/** An `ObserveResult` as it arrives on the wire, where the hierarchy root slot may be an array. */
export type WireObserveResult = Omit<ObserveResult, "viewHierarchy"> & {
  viewHierarchy?: Omit<ModelViewHierarchy, "hierarchy"> & {
    hierarchy: Omit<ModelViewHierarchy["hierarchy"], "node"> & { node?: WireHierarchyNodeSlot };
  };
};

/**
 * The wire-to-model boundary: serialized observation JSON becomes the model type. The sanitizer's
 * deep clone and tests that feed wire-shaped captures both cross it here.
 */
export function parseObserveResultJson(json: string): ObserveResult {
  return JSON.parse(json) as ObserveResult;
}

/** Cross the wire-to-model boundary for an in-memory wire capture. */
export function observeResultFromWire(wire: WireObserveResult): ObserveResult {
  return parseObserveResultJson(JSON.stringify(wire));
}
