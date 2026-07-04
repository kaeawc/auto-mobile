import type { ObserveResult } from "../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../models/ViewHierarchyResult";
import { encodeToonTable, type ToonScalar } from "../../../utils/toon";
import { compactStringifyToolResponse } from "../../../utils/toolUtils";

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
}

/**
 * Return an output-only copy of `obs` shrunk for serialization. Applies, in
 * order: perf-audit strip (always), per-node trim (default on), and
 * elements-drop (gated by `cfg.dropElements`). The input is never mutated.
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

/**
 * Order the `elements` sub-arrays are emitted as TOON blocks. Fixed so the
 * compact output is deterministic regardless of key order on the source object.
 */
const ELEMENT_ARRAY_NAMES = ["clickable", "scrollable", "text", "media"] as const;

/**
 * One-line, self-describing legend prepended to every compact observe payload so
 * the model can parse the hybrid JSON+TOON format without out-of-band docs.
 */
export const OBSERVE_COMPACT_LEGEND =
  "# observe-compact (--observe-result-compact): line 2 = compact JSON of the result " +
  "(viewHierarchy tree inline) with `elements` moved below as TOON. Each block: " +
  "`name[count]{columns}:` header then one 2-space-indented CSV row per element; " +
  "bounds flattened to bounds.left/top/right/bottom, nested node/objects kept as JSON " +
  "cells; a cell is quoted when it holds a comma, double-quote, or newline (\"\" = a " +
  "literal quote), and an empty cell means the field is absent.";

/**
 * True when `value` is a plain object whose own values are all scalar — the
 * shape (`bounds`) that flattens cleanly to dotted columns. Nested objects
 * (`node` subtrees) return false so they are preserved as a single JSON cell.
 */
function isFlatScalarObject(value: unknown): value is Record<string, ToonScalar> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(
    v => v === null || (typeof v !== "object" && typeof v !== "function")
  );
}

/**
 * Project one element to a flat TOON record. Scalars pass through; a flat-scalar
 * object (`bounds`) is expanded to `key.subkey` columns; anything else (arrays,
 * nested `node` subtrees) is preserved losslessly as a compact-JSON cell. The
 * accessibility `extras` bag is dropped to match the production formatter.
 */
function flattenElementRecord(element: Record<string, unknown>): Record<string, ToonScalar> {
  const row: Record<string, ToonScalar> = {};
  for (const [key, value] of Object.entries(element)) {
    if (key === "extras" || value === undefined || value === null) {
      continue;
    }
    if (isFlatScalarObject(value)) {
      for (const [subKey, subValue] of Object.entries(value)) {
        row[`${key}.${subKey}`] = subValue as ToonScalar;
      }
    } else if (typeof value === "object") {
      // A nested `node` subtree (or other array/object) is kept losslessly as a
      // compact-JSON cell. Route through the shared formatter — not raw
      // JSON.stringify — so the accessibility `extras` bag is stripped here too,
      // matching the JSON tree and the production formatter.
      row[key] = compactStringifyToolResponse(value);
    } else {
      row[key] = value as ToonScalar;
    }
  }
  return row;
}

/**
 * Encode an observe payload in the experimental compact/TOON text form
 * (issue #2760), gated by `--observe-result-compact` at the call site.
 *
 * Output-only and PURE: the input payload is never mutated. `observePath` locates
 * the `ObserveResult` — `""` when the payload itself is the result (the `observe`
 * tool), or a key (e.g. `"observation"`) when it is nested under an action
 * result. The result:
 *  1. legend line,
 *  2. compact JSON of the payload with the located result's `elements` detached
 *     (the ragged `viewHierarchy` tree stays inline — least TOON benefit, highest
 *     escaping risk),
 *  3. one TOON block per `elements.*` array (uniform tabular data — TOON's win).
 *
 * `structuredContent` is intentionally NOT produced here; the caller keeps that
 * representation as valid JSON so the two never have to agree on format.
 */
export function encodeObserveCompact(
  payload: Record<string, unknown>,
  observePath: string
): string {
  const observe = (observePath === "" ? payload : payload[observePath]) as
    | (ObserveResult & Record<string, unknown>)
    | undefined;

  // Detach `elements` without mutating the input: shallow-copy the result object
  // (and, for the nested case, its container) omitting the `elements` key.
  const elements = observe?.elements;
  let treeContainer: unknown;
  if (observePath === "") {
    const rest = { ...(payload as Record<string, unknown>) };
    delete rest.elements;
    treeContainer = rest;
  } else if (observe) {
    const restObserve = { ...(observe as Record<string, unknown>) };
    delete restObserve.elements;
    treeContainer = { ...payload, [observePath]: restObserve };
  } else {
    treeContainer = payload;
  }

  const blocks: string[] = [OBSERVE_COMPACT_LEGEND, compactStringifyToolResponse(treeContainer)];

  if (elements) {
    for (const name of ELEMENT_ARRAY_NAMES) {
      const arr = (elements as Record<string, unknown>)[name];
      const records = Array.isArray(arr)
        ? arr.map(el => flattenElementRecord(el as Record<string, unknown>))
        : [];
      blocks.push(encodeToonTable(name, records));
    }
  }

  return blocks.join("\n");
}
