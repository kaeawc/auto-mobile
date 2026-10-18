import type { ViewHierarchyResult } from "../../src/models";

/**
 * A capture built from fixture data whose legacy or malformed shape the model types
 * forbid (array bounds, single-node trees). `JSON.parse` yields an untyped base and
 * the copy is shallow, so shared node identity survives.
 */
export function untypedCapture(shape: object): ViewHierarchyResult {
  return Object.assign(JSON.parse("{}"), shape);
}
