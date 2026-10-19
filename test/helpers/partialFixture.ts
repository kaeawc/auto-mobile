/**
 * Build the array form captures emit in single-node slots (`hierarchy.node` as an array).
 *
 * The static model types `hierarchy.node` as one node, so these legacy captures cannot be
 * spelled without a cast; the two callers exercise the array-root paths of the output
 * sanitizer. Replaced by a typed model once `Hierarchy.node` admits the array form.
 */
export function partialFixtureArray<T extends object>(items: readonly object[]): T {
  return Object.assign([], items) as T;
}
