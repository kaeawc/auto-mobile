import { isDeepStrictEqual } from "node:util";
import { markImportedPrototypeContent } from "../../importedPrototypeContent";
import { parseObserveResultJson } from "../observeResultWire";
import type { Element } from "../../../../models/Element";
import type { ObserveResult, SkeletonElement } from "../../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../models/ViewHierarchyResult";
import { projectSkeleton } from "../SkeletonProjection";
import { DefaultObserveElementCollector } from "../../ObserveElementCollector";
import { getSearchableEntries } from "../elementProvenance";
import {
  attachRawViewHierarchy,
  resolveViewHierarchyForSearch,
} from "../../../utility/viewHierarchySearch";
import { markOccludedRowsOnFullProjection } from "../FullProjectionOcclusion";
import { capLayoutWarnings } from "../../audits/SafeAreaAuditor";
import {
  captureFidelityTruncationReasons,
  collectWindowTruncations,
  normalizeHierarchyOptionalFields,
} from "../../truncationReasons";
import { toNodeArray, isIosObservation } from "./hierarchy";

/**
 * Output-only shrinking of a single `ObserveResult` for serialization
 * (issue #2757). Part of the MCP output-context reduction effort.
 *
 * Guiding principle — OUTPUT-ONLY: every transform here operates on a deep
 * copy destined for the wire and never touches the caller's in-memory
 * `ObserveResult`. Internal consumers (`BaseVisualChange`,
 * `summarizeFailureObservation`, action selection, predictions) read the
 * original object and must be unaffected, so this is a pure function.
 *
 * Distinct concern from `ViewHierarchy.cleanNodeProperties`: that is an
 * allow-list normalizer applied during capture (it *drops* any attribute not
 * on its list, e.g. `className`). This is a lossless deny-list shrink of the
 * already-materialized output tree — it only removes redundant/default fields
 * and must preserve everything else the result carries. The two share the
 * empty-string / default-boolean / `enabled`-default-true rules on purpose so
 * their trimmed output agrees; they are not interchangeable.
 */

/** Marker that separates the human-readable perf summary from the raw dump. */
export const GFXINFO_DUMP_MARKER = "--- GFXINFO DUMP ---";

/**
 * View-hierarchy boolean attributes whose default is `false`. When absent, a
 * consumer reads them as `false` by convention, so omitting an explicit
 * `"false"` / `false` value is lossless for decision-making. Restricting the
 * drop to this known set (rather than any falsy value) avoids nuking a legit
 * text field that happens to hold the string `"false"`.
 *
 * `enabled` is deliberately absent: its default is *true*, so it is handled
 * separately (dropped when true, kept when `"false"`) — the same rule the
 * repo's canonical node cleaner uses (`ViewHierarchy.cleanNodeProperties`).
 */
const DEFAULT_FALSE_BOOLEAN_ATTRS: ReadonlySet<string> = new Set([
  "clickable",
  "long-clickable",
  "focusable",
  "focused",
  "scrollable",
  "checkable",
  "checked",
  "selected",
  "password",
]);

export interface SanitizeObserveConfig {
  /**
   * Gate for elements-drop. The wiring layer (#2758) supplies it from the
   * inverse of `ServerConfig.isObserveResultIncludeElementsEnabled()`: the
   * flattened `elements` block is dropped by default and only retained when the
   * `--observe-result-include-elements` opt-in is set. When true the `elements`
   * block is omitted from the output copy.
   */
  dropElements: boolean;
  /**
   * Per-node trim toggle. Default on (issue: "default on"); pass `false` to
   * emit the untrimmed hierarchy.
   */
  trimNodes?: boolean;
  /**
   * Gate for compact-form output. The wiring layer supplies this as `true`
   * unconditionally — bounds compaction is a permanent default (issues #2951,
   * #2978). When true, EVERY `bounds` object in the served payload is flattened from
   * `{left, top, right, bottom}` to the positional tuple `[left, top, right,
   * bottom]` — view-hierarchy nodes, the `elements` arrays, window/root/region
   * bounds, and the focused/awaited element fields. The four key strings repeat
   * on every occurrence, so dropping them is the largest remaining redundancy
   * after `trimNodes`. The order is fixed and documented so the tuple
   * round-trips losslessly. The one exception is `rawViewHierarchy`, which is
   * left untouched (raw stays raw). Flattening only fields literally named
   * `bounds` means insets (`systemInsets`, a `{top,bottom,left,right}` object)
   * and other shapes are never mis-compacted.
   */
  compact?: boolean;
  /**
   * Output projection (issue #4388). Default `"skeleton"` replaces `viewHierarchy` +
   * `elements` with the flat, actionable-only `skeleton` (a projection of the
   * already-computed `elements`); its bounds are always the compact tuple form
   * regardless of `compact`. The wiring layer (`finalizeToolResponse`) supplies
   * it as `"skeleton"` by default (a per-call `project: "full"` or `raw: true`
   * opts out), and only for the headline `observe` payload — embedded action
   * observations stay `"full"` so `--actions-diff-observe` can still diff a tree.
   */
  project?: "full" | "skeleton";
  /**
   * Cap `layoutWarnings` at `MAX_LAYOUT_WARNINGS` (issue #5074). Default on, so
   * every served/baseline/action payload is bounded. The observe **served** path
   * passes `false` to keep the full set for the scope transforms, then caps the
   * scoped result itself — scope-then-cap, so an in-scope warning is never lost
   * to a cap taken against the full tree.
   */
  capLayoutWarnings?: boolean;
}

/** Positional order of a compacted bounds tuple: `[left, top, right, bottom]`. */
export type CompactBounds = [number, number, number, number];

export type ObserveResultCloner = (obs: ObserveResult) => ObserveResult;

function cloneObserveResult(obs: ObserveResult): ObserveResult {
  // Match the wire's JSON semantics, including omitted undefined/functions.
  return parseObserveResultJson(JSON.stringify(obs));
}

/** Normalize hierarchy optionals and strip internal panel evidence from served captures. */
function sanitizeHierarchyMetadata(out: ObserveResult): void {
  if (out.viewHierarchy !== undefined && out.viewHierarchy !== null) {
    out.viewHierarchy = normalizeHierarchyOptionalFields(out.viewHierarchy);
    delete out.viewHierarchy.panelFingerprint;
  }
  // Android raw captures serialize the same top-level wire metadata into a JSON string.
  const raw = out.rawViewHierarchy;
  const rawJson = raw?.json;
  if (raw && rawJson?.includes('"panelFingerprint"')) {
    const hierarchy: unknown = JSON.parse(rawJson);
    if (hierarchy && typeof hierarchy === "object" && "panelFingerprint" in hierarchy) {
      delete hierarchy.panelFingerprint;
      raw.json = JSON.stringify(hierarchy, null, 2);
    }
  }
}

/**
 * Return an output-only copy of `obs` shrunk for serialization. Applies, in
 * order: perf-audit strip (always), top-level debug-perf telemetry reduction
 * (always), per-node trim (default on), bounds compaction (gated by
 * `cfg.compact`), and elements-drop (gated by `cfg.dropElements`). The input is
 * never mutated.
 */
export function sanitizeObserveResult(
  obs: ObserveResult,
  cfg: SanitizeObserveConfig,
  clone: ObserveResultCloner = cloneObserveResult,
): ObserveResult {
  // Deep-clone boundary: mutate only the copy that goes to the wire. The
  // JSON round-trip matches the repo's hierarchy-cloning convention
  // (ViewHierarchy.ts) and the wire's own JSON semantics (undefined/functions
  // dropped), so it can never throw on a value structuredClone would reject.
  const out = clone(obs);
  markImportedPrototypeContent(out, obs);
  sanitizeHierarchyMetadata(out);

  stripPerformanceAudit(out);
  reduceTopLevelDebugPerfTelemetry(out);
  reduceAdvisoryOutput(out, cfg.project);

  // Full projection (#10715): carry the skeleton's `occluded` signal for rows an application
  // window or AutoMobile prototype fully covers. Runs before the trim so the clone still mirrors
  // `obs`'s tree node for node.
  if (cfg.project !== "skeleton") {
    markOccludedRowsForFullProjection(out, obs);
  }

  if (cfg.trimNodes !== false) {
    const roots = toNodeArray(out.viewHierarchy?.hierarchy?.node);
    const referencedOccluderViewIds = collectOccludedByViewIds(roots);
    for (const root of roots) {
      trimHierarchyNodes(root, referencedOccluderViewIds);
    }
  }

  // Skeleton projection (issue #4388): runs before `compact`/`dropElements` so it
  // reads object-shaped element bounds. It emits its own compact tuple bounds and
  // removes the tree + elements, so the later steps become no-ops on those fields.
  // It projects from the pre-clone `obs`, not `out`: the collector's ancestry
  // provenance (issue #5881) is a non-enumerable Symbol property that the line-119
  // JSON round-trip strips, so reading `out.elements` would silently lose it and
  // revert hoisting/suppression to the pre-#5881 geometry fallback.
  if (cfg.project === "skeleton") {
    projectSkeletonOnto(out, obs);
  }

  if (cfg.compact) {
    compactObserveBounds(out);
  }

  if (cfg.dropElements) {
    delete out.elements;
  }

  // Bound the advisory list (issue #5074). Default on; the observe served path
  // opts out (cfg.capLayoutWarnings === false) so it can scope first, then cap.
  if (cfg.capLayoutWarnings !== false && out.layoutWarnings) {
    out.layoutWarnings = capLayoutWarnings(out.layoutWarnings);
  }

  return out;
}

/** Derive the skeleton from an already-sanitized full tree without cloning it. */
export function projectSanitizedObserveSkeleton(
  sanitized: ObserveResult,
  source: ObserveResult,
): ObserveResult {
  const out = { ...sanitized };
  delete out.layoutWarnings;
  delete out.performanceAudit;
  // The original still carries non-enumerable ancestry provenance on elements.
  projectSkeletonOnto(out, source);
  return out;
}

/**
 * Replace the full tree with the actionable-only skeleton (issue #4388): set
 * `out.skeleton` (and the sibling `out.context`, issue #6221 item 1) from the
 * collector's `elements`, then drop `viewHierarchy` and `elements` from the
 * emitted copy. A hierarchy-less observation (capture failure) yields an empty
 * skeleton and no `context` — still a valid, if empty, projection.
 *
 * Only CAPTURE-FIDELITY `viewHierarchy.truncationReasons` are lifted to the
 * payload top level (issue #6601, refined by #6933): a host-output
 * `max_children[...]` cap (`isHostOutputTruncationReason`) trims only the
 * rendered `viewHierarchy` payload, while `DefaultObserveElementCollector` —
 * the source of the skeleton's elements — follows the uncapped raw hierarchy
 * whenever `--raw-element-search` is enabled (`resolveViewHierarchyForSearch`).
 * Lifting a host-output-only reason here would falsely tell a client that a
 * complete skeleton is a subset of what the device emitted.
 *
 * `source` is the pre-clone `obs`: its elements still carry the non-enumerable
 * ancestry provenance (issue #5881) that the `sanitizeObserveResult` JSON clone
 * strips from `out`. The projection reads but never mutates them, so the "input
 * is never mutated" contract holds; only `out` (the clone) is edited.
 */
function projectSkeletonOnto(out: ObserveResult, source: ObserveResult): void {
  const projectionSource = skeletonSourceForProjection(source);
  const elements = projectionSource.elements;
  const { skeleton, context, keyboard } = elements
    ? projectSkeleton(
        elements,
        source.screenSize,
        isIosObservation(source) ? undefined : projectionSource.viewHierarchy,
        { ios: isIosObservation(source), iosHierarchy: projectionSource.viewHierarchy },
      )
    : { skeleton: [] as SkeletonElement[], context: [] as SkeletonElement[], keyboard: undefined };
  out.skeleton = skeleton;
  if (keyboard) {
    out.keyboard = keyboard;
  } else {
    delete out.keyboard;
  }
  if (context.length > 0) {
    out.context = context;
  } else {
    delete out.context;
  }
  // Lift the hierarchy's truncation provenance before the tree that carries it
  // is dropped (issue #6601). The skeleton is projected from elements that were
  // already capped (host child cap, or a device-side `max_nodes`/`max_depth`/`max_children`
  // stop), so without this the default projection reports a short list with no
  // hint that rows are missing — exactly the silent false negative
  // `truncationReasons` exists to prevent. `layoutWarnings` / `performanceAudit`
  // are deliberately advisory and dropped here; this is not advisory, it is the
  // completeness contract of the rows the skeleton does list.
  const truncationReasons = captureFidelityTruncationReasons(out.viewHierarchy?.truncationReasons);
  if (truncationReasons.length > 0) {
    out.truncationReasons = truncationReasons;
  }
  const windowTruncations = collectWindowTruncations(out.viewHierarchy?.windows);
  if (windowTruncations) {
    out.windowTruncations = windowTruncations;
  } else {
    delete out.windowTruncations;
  }
  delete out.viewHierarchy;
  delete out.elements;
}

function markOccludedRowsForFullProjection(out: ObserveResult, obs: ObserveResult): void {
  if (
    obs.elements &&
    obs.viewHierarchy?.hierarchy &&
    obs.viewHierarchy.windows?.length &&
    !isIosObservation(obs)
  ) {
    const source = skeletonSourceForProjection(obs);
    markOccludedRowsOnFullProjection(out, source, source.elements);
  }
}

interface SkeletonProjectionValidation {
  inputs?: string;
  collected?: ObserveResult["elements"];
  hierarchy?: ObserveResult["viewHierarchy"];
}

const skeletonValidationByElements = new WeakMap<object, SkeletonProjectionValidation>();

/** Share lazy validation across cache clones without changing their enumerable wire data. */
export function inheritSkeletonProjectionValidation(
  source: ObserveResult,
  copy: ObserveResult,
): void {
  if (!source.elements || !copy.elements) {
    return;
  }
  const validation = skeletonValidationByElements.get(source.elements) ?? {};
  skeletonValidationByElements.set(source.elements, validation);
  skeletonValidationByElements.set(copy.elements, validation);
}

function sourceWithSkeletonValidation(
  source: ObserveResult,
  validation: SkeletonProjectionValidation,
): ObserveResult {
  return validation.collected
    ? { ...source, elements: validation.collected, viewHierarchy: validation.hierarchy }
    : source;
}

/** Own node identities while retaining the collector's active raw-search evidence. */
function cloneSkeletonHierarchy(
  hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  searchHierarchy: ObserveResult["viewHierarchy"],
): NonNullable<ObserveResult["viewHierarchy"]> {
  try {
    const [copy, searchCopy] = structuredClone([hierarchy, searchHierarchy] as const);
    if (searchCopy && searchCopy !== copy) {
      attachRawViewHierarchy(copy, searchCopy);
    }
    return copy;
  } catch (error) {
    // Non-wire callers can carry non-cloneable values. Preserve legacy collection
    // and error behavior for them, without retaining caller-owned nodes in the memo.
    if (error instanceof DOMException && error.name === "DataCloneError") {
      return hierarchy;
    }
    throw error;
  }
}

function skeletonSourceForProjection(source: ObserveResult): ObserveResult {
  // Cache structuredClone and full-output JSON cloning discard the collector's
  // provenance. Restore it only when recollection reproduces the supplied
  // categories and descriptors: elements remain authoritative for output.
  const elements = source.elements;
  if (!elements || getSearchableEntries(elements) || !source.viewHierarchy) {
    return source;
  }
  const platform = isIosObservation(source) ? "ios" : "android";
  const searchHierarchy = resolveViewHierarchyForSearch(source.viewHierarchy);
  // Cache returns are independently mutable. Check the inputs, including raw-search
  // evidence when present, before reusing a validation from this entry or a sibling clone.
  const inputs = JSON.stringify([
    elements,
    source.viewHierarchy,
    searchHierarchy === source.viewHierarchy ? undefined : searchHierarchy,
    platform,
  ]);
  const validation = skeletonValidationByElements.get(elements);
  if (validation?.inputs === inputs) {
    return sourceWithSkeletonValidation(source, validation);
  }
  // Collected entries retain node identities. Own their hierarchy as well so a
  // later cache clone (or a caller mutating an earlier return) cannot detach them.
  const hierarchy = cloneSkeletonHierarchy(source.viewHierarchy, searchHierarchy);
  const collected = new DefaultObserveElementCollector().collect(hierarchy, platform);
  const validated = isDeepStrictEqual(
    skeletonElementShape(elements),
    skeletonElementShape(collected),
  )
    ? collected
    : undefined;
  if (hierarchy !== source.viewHierarchy) {
    const next = validation ?? {};
    next.inputs = inputs;
    next.collected = validated;
    next.hierarchy = validated ? hierarchy : undefined;
    skeletonValidationByElements.set(elements, next);
  }
  return sourceWithSkeletonValidation(source, { collected: validated, hierarchy });
}

/** Normalize only the existing lossless wire transforms before comparing collections. */
function skeletonElementShape(elements: ObserveResult["elements"]): ObserveResult["elements"] {
  if (!elements) {
    return undefined;
  }
  const shape = JSON.parse(JSON.stringify(elements)) as NonNullable<ObserveResult["elements"]>;
  const referencedViewIds = new Set<string>();
  for (const category of [shape.clickable, shape.scrollable, shape.text]) {
    for (const element of category) {
      trimHierarchyNodeAttributes(element, referencedViewIds);
    }
  }
  compactObserveBounds(shape);
  return shape;
}

/**
 * Reduce top-level debug-perf telemetry that is useful while measuring capture
 * internals but mostly duplicates richer summaries. `perfTiming` is raw capture
 * timing, so it is dropped. `gfxMetrics` also carries action UI-stability
 * fields, so only frame timing fields with non-null replacements in
 * `performanceAudit.metrics` are removed.
 */
function reduceTopLevelDebugPerfTelemetry(out: ObserveResult): void {
  // NOTE: `out.perfSnapshot` (the opt-in windowed rollup) is deliberately NOT
  // stripped here — it is a compact, user-facing summary meant to reach the
  // client. Do not fold it into this debug-perf pruning.
  delete out.perfTiming;

  const auditMetrics = out.performanceAudit?.metrics;
  if (!auditMetrics || !out.gfxMetrics) {
    return;
  }

  const gfxMetrics = out.gfxMetrics as Partial<NonNullable<ObserveResult["gfxMetrics"]>>;

  const frameFields = [
    ["p50Ms", "percentile50thMs"],
    ["p90Ms", "percentile90thMs"],
    ["p95Ms", "percentile95thMs"],
    ["p99Ms", "percentile99thMs"],
    ["missedVsyncCount", "missedVsyncCount"],
    ["slowUiThreadCount", "slowUiThreadCount"],
    ["frameDeadlineMissedCount", "frameDeadlineMissedCount"],
  ] as const;
  for (const [auditField, gfxField] of frameFields) {
    if (auditMetrics[auditField] !== null && auditMetrics[auditField] !== undefined) {
      delete gfxMetrics[gfxField];
    }
  }
}

/**
 * Null the heavy raw dumps and truncate diagnostics to the summary lines above
 * the GFXINFO dump. Computed metrics (`p50–p99`, `jankCount`,
 * `cpuUsagePercent`, `threadCount`, `touchLatencyMs`, `anrDetected`) and
 * `violations[]` are left intact. No-op when no audit is present.
 */
function stripPerformanceAudit(out: ObserveResult): void {
  const audit = out.performanceAudit;
  if (!audit) {
    return;
  }

  if (audit.metrics) {
    audit.metrics.gfxinfoRaw = null;
    audit.metrics.cpuStatsRaw = null;
  }

  if (typeof audit.diagnostics === "string") {
    const markerIndex = audit.diagnostics.indexOf(GFXINFO_DUMP_MARKER);
    if (markerIndex !== -1) {
      audit.diagnostics = audit.diagnostics.slice(0, markerIndex).trimEnd();
    }
  }

  if (audit.violations !== undefined) {
    const { diagnostics, ...auditWithoutDiagnostics } = audit;
    void diagnostics;
    out.performanceAudit = auditWithoutDiagnostics as NonNullable<
      ObserveResult["performanceAudit"]
    >;
  }
}

/**
 * Remove advisory data from the actionable skeleton projection. These fields
 * remain available through the full projection, while the skeleton keeps the
 * response focused on UI-driving information.
 */
function reduceAdvisoryOutput(
  out: ObserveResult,
  project?: SanitizeObserveConfig["project"],
): void {
  if (project === "skeleton") {
    delete out.layoutWarnings;
    delete out.performanceAudit;
  }

  if (out.backStack?.tasks) {
    out.backStack.tasks = out.backStack.tasks.filter((task) => task.numActivities !== 0);
  }
}

/**
 * Recursively trim each node in-place (on the already-cloned tree): drop
 * `view-id` when it duplicates `resource-id`, omit default-false booleans, and
 * omit empty-string fields. Lossless for decision-making.
 */
function collectOccludedByViewIds(nodes: ViewHierarchyNode[]): Set<string> {
  const referencedViewIds = new Set<string>();
  const visit = (node: ViewHierarchyNode | undefined): void => {
    if (!node) {
      return;
    }
    const occludedByViewId = node.occludedByViewId;
    if (typeof occludedByViewId === "string" && occludedByViewId !== "") {
      referencedViewIds.add(occludedByViewId);
    }
    for (const child of toNodeArray(node.node)) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return referencedViewIds;
}

function trimHierarchyNodes(
  node: ViewHierarchyNode | undefined,
  referencedOccluderViewIds: ReadonlySet<string>,
): void {
  if (!node) {
    return;
  }

  trimHierarchyNodeAttributes(node, referencedOccluderViewIds);

  for (const child of toNodeArray(node.node)) {
    trimHierarchyNodes(child, referencedOccluderViewIds);
  }
}

function trimHierarchyNodeAttributes(
  node: ViewHierarchyNode | Element,
  referencedOccluderViewIds: ReadonlySet<string>,
): void {
  const attrs: Record<string, unknown> = node;

  // Drop view-id when it is identical to resource-id (redundant duplicate).
  if (
    typeof attrs["view-id"] === "string" &&
    attrs["view-id"] === attrs["resource-id"] &&
    !referencedOccluderViewIds.has(attrs["view-id"])
  ) {
    delete attrs["view-id"];
  }

  for (const [key, value] of Object.entries(attrs)) {
    // Omit empty-string fields.
    if (value === "") {
      delete attrs[key];
      continue;
    }
    // Omit `enabled` when true: it defaults to true, so absence reads as
    // enabled by convention. A disabled control keeps its explicit
    // `enabled: "false"`. Mirrors ViewHierarchy.cleanNodeProperties.
    if (key === "enabled" && (value === true || value === "true")) {
      delete attrs[key];
      continue;
    }
    // Omit default-false booleans (string "false" or boolean false).
    if ((value === "false" || value === false) && DEFAULT_FALSE_BOOLEAN_ATTRS.has(key)) {
      delete attrs[key];
    }
  }
}

/** Flatten a single `{left, top, right, bottom}` bounds object to its tuple. */
function compactBounds(bounds: {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}): CompactBounds {
  return [bounds.left, bounds.top, bounds.right, bounds.bottom] as CompactBounds;
}

/**
 * Compact every `bounds` object in the served observe payload to the positional
 * tuple `[left, top, right, bottom]` (on the already-cloned tree). A single walk
 * covers all bounds sites — hierarchy nodes, the `elements` arrays, window/root/
 * region bounds, and focused/awaited elements — so the wire never carries a
 * mix of object- and tuple-shaped bounds (#2978).
 *
 * `rawViewHierarchy` is deliberately skipped so `raw: true` still returns the
 * unshaped hierarchy. Only fields literally named `bounds` are flattened, so
 * insets (`systemInsets`, a `{top,bottom,left,right}` object) and other shapes
 * are never mis-compacted. A `bounds` list is flattened element-by-element; an
 * already-compact tuple or non-object value is left untouched, so the transform
 * is idempotent.
 */
function compactObserveBounds(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      compactObserveBounds(item);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    if (key === "rawViewHierarchy") {
      // Raw stays raw: a `raw: true` consumer wants the unshaped hierarchy.
      continue;
    }
    if (key === "bounds" && Array.isArray(v)) {
      obj[key] = v.map((bounds) =>
        bounds && typeof bounds === "object" && !Array.isArray(bounds)
          ? compactBounds(
              bounds as { left?: number; top?: number; right?: number; bottom?: number },
            )
          : bounds,
      );
      continue;
    }
    if (key === "bounds" && v && typeof v === "object") {
      obj[key] = compactBounds(
        v as { left?: number; top?: number; right?: number; bottom?: number },
      );
      continue;
    }
    compactObserveBounds(v);
  }
}
