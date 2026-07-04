import type { ObserveResult } from "../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../models/ViewHierarchyResult";

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
   * Gate for elements-drop. Maps to the `observeResultDropElements` output-
   * reduction flag (`--observe-result-drop-elements`); the wiring layer (#2758)
   * supplies it from `ServerConfig.isObserveResultDropElementsEnabled()`. When
   * true the flattened `elements` block is omitted from the output copy.
   */
  dropElements: boolean;
  /**
   * Per-node trim toggle. Default on (issue: "default on"); pass `false` to
   * emit the untrimmed hierarchy.
   */
  trimNodes?: boolean;
  /**
   * Gate for compact-form output. Maps to the `observeResultCompact` output-
   * reduction flag (`--observe-result-compact`); the wiring layer supplies it
   * from `ServerConfig.isObserveResultCompactEnabled()` (issues #2951, #2978).
   * When true, EVERY `bounds` object in the served payload is flattened from
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
}

/** Positional order of a compacted bounds tuple: `[left, top, right, bottom]`. */
export type CompactBounds = [number, number, number, number];

/**
 * Return an output-only copy of `obs` shrunk for serialization. Applies, in
 * order: perf-audit strip (always), per-node trim (default on), bounds compaction
 * (gated by `cfg.compact`), and elements-drop (gated by `cfg.dropElements`). The
 * input is never mutated.
 */
export function sanitizeObserveResult(obs: ObserveResult, cfg: SanitizeObserveConfig): ObserveResult {
  // Deep-clone boundary: mutate only the copy that goes to the wire. The
  // JSON round-trip matches the repo's hierarchy-cloning convention
  // (ViewHierarchy.ts) and the wire's own JSON semantics (undefined/functions
  // dropped), so it can never throw on a value structuredClone would reject.
  const out = JSON.parse(JSON.stringify(obs)) as ObserveResult;

  stripPerformanceAudit(out);

  if (cfg.trimNodes !== false) {
    for (const root of toNodeArray(out.viewHierarchy?.hierarchy?.node)) {
      trimHierarchyNodes(root);
    }
  }

  if (cfg.compact) {
    compactObserveBounds(out);
  }

  if (cfg.dropElements) {
    delete out.elements;
  }

  return out;
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
}

/**
 * Normalize a hierarchy `node` slot to an array. The `node` field is typed as a
 * single `ViewHierarchyNode` at the `Hierarchy` root but a `ViewHierarchyNode[]`
 * on child nodes, and real captures put an array in both places — this collapses
 * that runtime shape variance into one traversal path.
 */
function toNodeArray(
  node: ViewHierarchyNode | ViewHierarchyNode[] | undefined
): ViewHierarchyNode[] {
  if (!node) {
    return [];
  }
  return Array.isArray(node) ? node : [node];
}

/**
 * Recursively trim each node in-place (on the already-cloned tree): drop
 * `view-id` when it duplicates `resource-id`, omit default-false booleans, and
 * omit empty-string fields. Lossless for decision-making.
 */
function trimHierarchyNodes(node: ViewHierarchyNode | undefined): void {
  if (!node) {
    return;
  }

  const attrs = node as unknown as Record<string, unknown>;

  // Drop view-id when it is identical to resource-id (redundant duplicate).
  if (attrs["view-id"] !== undefined && attrs["view-id"] === attrs["resource-id"]) {
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

  for (const child of toNodeArray(node.node)) {
    trimHierarchyNodes(child);
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
 * are never mis-compacted. A non-object `bounds` (already a tuple, or a string)
 * is left untouched, so the transform is idempotent.
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
    if (key === "bounds" && v && typeof v === "object" && !Array.isArray(v)) {
      obj[key] = compactBounds(v as { left?: number; top?: number; right?: number; bottom?: number });
      continue;
    }
    compactObserveBounds(v);
  }
}
