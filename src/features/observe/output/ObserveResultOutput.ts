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

/* --------------------------------------------------------------------------
 * Observation diff (issue #2761 — `--actions-diff-observe`)
 *
 * With the flag on, a non-observe action emits only the *diff* of its
 * post-action observation against the previous one, instead of the full
 * embedded observation. Both sides are the already-sanitized ObserveResult
 * (the finalize hook stores the sanitized observation as the baseline), so the
 * diff compares like-for-like node shapes.
 * ------------------------------------------------------------------------ */

/**
 * A single node in an observation diff. `attributes` are the node's own
 * (non-child) attributes — for `added`/`removed` the full attribute set, so the
 * consumer can reconstruct the node without the baseline.
 */
export interface ObserveDiffNode {
  /** Synthetic identity key: `resource-id \0 bounds \0 text \0 sibling-index`. */
  key: string;
  attributes: Record<string, unknown>;
}

/** A node matched by key whose non-key attributes changed. */
export interface ObserveDiffNodeChange {
  key: string;
  /** Per-attribute `{ from, to }`; a missing side is `undefined`. */
  changes: Record<string, { from?: unknown; to?: unknown }>;
}

/**
 * Compact diff of one observation against a baseline. `isDiff` is a discriminant
 * so a consumer can tell a diff apart from a full `ObserveResult` (which has no
 * such marker). Empty `added`/`removed`/`changed` and absent `fields` means the
 * screen is unchanged.
 */
export interface ObserveDiff {
  isDiff: true;
  added: ObserveDiffNode[];
  removed: ObserveDiffNode[];
  changed: ObserveDiffNodeChange[];
  /** Changed top-level scalar fields (`rotation`, `wakefulness`, …). */
  fields?: Record<string, { from?: unknown; to?: unknown }>;
}

export interface DiffObserveConfig {
  /**
   * Top-level scalar ObserveResult fields to diff. Defaults to
   * `DIFF_SCALAR_FIELDS`. `updatedAt` is deliberately excluded from the default
   * — it changes on every capture and would be pure noise.
   */
  scalarFields?: readonly string[];
}

/**
 * Top-level scalar ObserveResult fields worth diffing. Intentionally excludes
 * `updatedAt` (churns every capture) and object/array fields (`viewHierarchy`
 * is covered by the node diff; `elements` mirrors the hierarchy).
 */
export const DIFF_SCALAR_FIELDS: readonly string[] = [
  "rotation",
  "wakefulness",
  "userId",
  "intentChooserDetected",
  "notificationPermissionDetected",
  "awaitTimeout",
  "error",
];

/** A flattened node used for keyed positional diffing. */
interface FlatObserveNode {
  /**
   * Globally-positional match key: the chain of every ancestor's local key plus
   * this node's own (depth-joined). Two nodes in *different* subtrees that share
   * a local key — same resource-id/bounds/text/sibling index, common for
   * repeated list cells — get distinct path keys, so they never collide and
   * mis-pair. Used for matching, never emitted.
   */
  pathKey: string;
  /** This node's own local key (resource-id + bounds + text + sibling index), for display. */
  key: string;
  attributes: Record<string, unknown>;
}

/**
 * Canonical string for a bounds value, tolerant of both the object shape
 * (`{left, top, right, bottom}`) and the compacted tuple (`[l, t, r, b]`), so a
 * compacted stream diffs identically to an object-shaped one.
 */
function boundsKey(bounds: unknown): string {
  if (Array.isArray(bounds)) {
    return bounds.join(",");
  }
  if (bounds && typeof bounds === "object") {
    const b = bounds as { left?: number; top?: number; right?: number; bottom?: number };
    return [b.left, b.top, b.right, b.bottom].join(",");
  }
  return "";
}

/**
 * A node's *local* identity key: `resource-id + bounds + text + sibling index`,
 * NUL-joined so the parts can never run together. Nodes carry no stable id, so
 * this coarse key pins geometry + text + local position; state-only changes
 * (e.g. `checked`) keep the same key and surface as `changed`. On its own it is
 * not globally unique — `FlatObserveNode.pathKey` prefixes the ancestor chain to
 * disambiguate identical cells living in different subtrees.
 */
function nodeKey(node: Record<string, unknown>, siblingIndex: number): string {
  const resourceId = node["resource-id"] ?? "";
  const text = node["text"] ?? "";
  return [resourceId, boundsKey(node["bounds"]), text, siblingIndex].join(" ");
}

/**
 * Depth separator joining ancestor local keys into a positional `pathKey`. A
 * distinct control char (U+0001) from the intra-key NUL (U+0000) so the two
 * levels of joining can never be confused.
 */
const PATH_KEY_SEP = "";

/** A node's own attributes, excluding the `node` child array (diffed separately). */
function nodeAttributes(node: Record<string, unknown>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "node") {
      continue;
    }
    attrs[key] = value;
  }
  return attrs;
}

/**
 * Pre-order flatten of an observation's hierarchy into positionally-keyed nodes.
 * Each node's `pathKey` is its ancestor chain of local keys plus its own, so the
 * key is globally unique by position and identical cells in sibling subtrees do
 * not collide.
 */
function flattenForDiff(obs: ObserveResult): FlatObserveNode[] {
  const out: FlatObserveNode[] = [];
  const walk = (node: ViewHierarchyNode | undefined, siblingIndex: number, parentPath: string): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const rec = node as unknown as Record<string, unknown>;
    const localKey = nodeKey(rec, siblingIndex);
    const pathKey = parentPath === "" ? localKey : `${parentPath}${PATH_KEY_SEP}${localKey}`;
    out.push({ pathKey, key: localKey, attributes: nodeAttributes(rec) });
    toNodeArray(node.node).forEach((child, index) => walk(child, index, pathKey));
  };
  toNodeArray(obs.viewHierarchy?.hierarchy?.node).forEach((root, index) => walk(root, index, ""));
  return out;
}

/**
 * JSON with object keys sorted recursively, so two structurally-equal objects
 * built with different key insertion order compare equal (avoids phantom
 * `changed` entries from a differently-ordered attribute object).
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/** Structural equality via key-order-insensitive JSON (attributes are plain data). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  return stableStringify(a) === stableStringify(b);
}

/** Per-attribute diff of two attribute maps (union of keys). */
function diffAttributes(
  from: Record<string, unknown>,
  to: Record<string, unknown>
): Record<string, { from?: unknown; to?: unknown }> {
  const changes: Record<string, { from?: unknown; to?: unknown }> = {};
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    // `bounds` is compared through `boundsKey` so an object-shaped baseline and a
    // compacted tuple next (identical geometry) are not a spurious change.
    const equal = key === "bounds"
      ? boundsKey(from[key]) === boundsKey(to[key])
      : valuesEqual(from[key], to[key]);
    if (!equal) {
      changes[key] = { from: from[key], to: to[key] };
    }
  }
  return changes;
}

/** Group flattened nodes by their positional `pathKey`, preserving encounter order. */
function groupByKey(nodes: FlatObserveNode[]): Map<string, FlatObserveNode[]> {
  const map = new Map<string, FlatObserveNode[]>();
  for (const node of nodes) {
    const bucket = map.get(node.pathKey);
    if (bucket) {
      bucket.push(node);
    } else {
      map.set(node.pathKey, [node]);
    }
  }
  return map;
}

/**
 * Whether two observations describe the same screen. Cross-screen diffs are
 * meaningless (issue #2761), so the finalize hook falls back to a full emit when
 * this is false. Compares the active window app/activity and the hierarchy
 * package name.
 */
export function isSameObservationScreen(baseline: ObserveResult, next: ObserveResult): boolean {
  if ((baseline.activeWindow?.appId ?? "") !== (next.activeWindow?.appId ?? "")) {
    return false;
  }
  if ((baseline.activeWindow?.activityName ?? "") !== (next.activeWindow?.activityName ?? "")) {
    return false;
  }
  if ((baseline.viewHierarchy?.packageName ?? "") !== (next.viewHierarchy?.packageName ?? "")) {
    return false;
  }
  return true;
}

/**
 * Diff `next` against `baseline` into a compact {added, removed, changed, fields}
 * shape. Pure — neither input is mutated. Node identity is the positional
 * `pathKey` (ancestor chain + local `nodeKey`), so a node keeps its identity
 * across state-only changes but a same-key cell in a different subtree never
 * collides. Any residual same-path duplicates (truly identical siblings) are
 * paired positionally in encounter order — a best-effort heuristic, since with
 * no stable ids interchangeable rows cannot be told apart. The emitted `key` is
 * the node's readable local key. Callers gate on `isSameObservationScreen` first.
 */
export function diffObserveResult(
  baseline: ObserveResult,
  next: ObserveResult,
  cfg?: DiffObserveConfig
): ObserveDiff {
  const baseByKey = groupByKey(flattenForDiff(baseline));
  const nextByKey = groupByKey(flattenForDiff(next));

  const added: ObserveDiffNode[] = [];
  const removed: ObserveDiffNode[] = [];
  const changed: ObserveDiffNodeChange[] = [];

  for (const pathKey of new Set([...baseByKey.keys(), ...nextByKey.keys()])) {
    const baseNodes = baseByKey.get(pathKey) ?? [];
    const nextNodes = nextByKey.get(pathKey) ?? [];
    const paired = Math.min(baseNodes.length, nextNodes.length);
    for (let i = 0; i < paired; i++) {
      const attrChanges = diffAttributes(baseNodes[i].attributes, nextNodes[i].attributes);
      if (Object.keys(attrChanges).length > 0) {
        changed.push({ key: nextNodes[i].key, changes: attrChanges });
      }
    }
    for (let i = paired; i < nextNodes.length; i++) {
      added.push({ key: nextNodes[i].key, attributes: nextNodes[i].attributes });
    }
    for (let i = paired; i < baseNodes.length; i++) {
      removed.push({ key: baseNodes[i].key, attributes: baseNodes[i].attributes });
    }
  }

  const diff: ObserveDiff = { isDiff: true, added, removed, changed };

  const scalarFields = cfg?.scalarFields ?? DIFF_SCALAR_FIELDS;
  const fields: Record<string, { from?: unknown; to?: unknown }> = {};
  const baseRecord = baseline as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const field of scalarFields) {
    if (!valuesEqual(baseRecord[field], nextRecord[field])) {
      fields[field] = { from: baseRecord[field], to: nextRecord[field] };
    }
  }
  if (Object.keys(fields).length > 0) {
    diff.fields = fields;
  }

  return diff;
}
