/** Observe output sanitization and diffs; implementations are grouped by responsibility. */
export {
  GFXINFO_DUMP_MARKER,
  sanitizeObserveResult,
  projectSanitizedObserveSkeleton,
  inheritSkeletonProjectionValidation,
} from "./resultOutput/sanitize";
export type { SanitizeObserveConfig, ObserveResultCloner } from "./resultOutput/sanitize";
export { DIFF_SCALAR_FIELDS, DIFF_ELEMENT_FIELDS } from "./resultOutput/diffTypes";
export type { ObserveDiffNode, ObserveDiff } from "./resultOutput/diffTypes";
export { DIFF_IGNORED_ATTRS } from "./resultOutput/diffComparison";
export { isSameObservationScreen, diffObserveResult } from "./resultOutput/diff";
