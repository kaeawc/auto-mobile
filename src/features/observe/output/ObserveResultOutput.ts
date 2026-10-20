/** Observe output sanitization and diffs; implementations are grouped by responsibility. */
export {
  GFXINFO_DUMP_MARKER,
  sanitizeObserveResult,
  projectSanitizedObserveSkeleton,
} from "./resultOutput/sanitize";
export type {
  SanitizeObserveConfig,
  CompactBounds,
  ObserveResultCloner,
} from "./resultOutput/sanitize";
export { DIFF_SCALAR_FIELDS, DIFF_ELEMENT_FIELDS } from "./resultOutput/diffTypes";
export type {
  ObserveDiffSelector,
  ObserveDiffNode,
  ObserveDiffNodeChange,
  ObserveDiff,
  DiffObserveConfig,
} from "./resultOutput/diffTypes";
export { DIFF_IGNORED_ATTRS } from "./resultOutput/diffComparison";
export { isSameObservationScreen, diffObserveResult } from "./resultOutput/diff";
