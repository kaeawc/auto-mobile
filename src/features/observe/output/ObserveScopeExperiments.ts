import type { ObserveResult } from "../../../models/ObserveResult";
import type { LayoutWarnings } from "../../../models/ObservationInsets";
import type { ElementBounds } from "../../../models/ElementBounds";
import type {
  FocusAnchor,
  NormalizedRegion,
  ObserveScopeInput,
  ObserveScopeKind,
  ObserveScopeMetadata,
} from "../../../models/ObserveScope";

export type {
  FocusAnchor,
  NormalizedRegion,
  ObserveScopeInput,
  ObserveScopeKind,
  ObserveScopeMetadata,
} from "../../../models/ObserveScope";

/**
 * Progressive-disclosure scoping experiments for `observe` output (issue #4344).
 *
 * Inspired by the Anthropic multimodal "crop tool" cookbook. That tool hands the
 * model a large, detail-dense artifact (a high-resolution image) plus a way to
 * *zoom into a region on demand* instead of front-loading every pixel. The lesson
 * transfers to AutoMobile with one substitution: the dense artifact an agent
 * actually consumes is the **view hierarchy**, not a screenshot. Today `observe`
 * front-loads the whole (reduced) tree; these transforms let a caller opt into a
 * scoped view of it.
 *
 * Three independent transforms — the "spatial axis" complementing the existing
 * "temporal axis" (`--actions-diff-observe`). The agent picks where to zoom on
 * each screen, so the parameters ride in the `observe` tool's `scope` input
 * ({@link ObserveScopeInput}), NOT the environment. Scoping is always available:
 * {@link buildObserveScopeConfig} applies a dimension whenever the call requests
 * it (the per-dimension server gates that once dark-launched this are now always
 * on, so the intersection reduces to "call-requested"):
 *
 *  1. FOCUS  (`scope.focus`)  — scope to a subtree: an anchor object
 *     (`resource-id` / text) when given, else `true` for the foreground app,
 *     dropping system chrome (status/nav bars, IME, other pkgs).
 *  2. OVERVIEW (`scope.overview`) — collapse to a container skeleton: keep
 *     structural/addressable nodes, drop anonymous leaves, annotate the count of
 *     omitted descendants so nothing is *silently* dropped.
 *  3. REGION (`scope.region`) — crop to a normalized (0..1) box (the crop
 *     cookbook's signature ergonomic); `true` uses the inset content rectangle.
 *
 * GUIDING PRINCIPLE — OUTPUT-ONLY, like `sanitizeObserveResult`: every function
 * here returns a deep copy and never mutates the caller's `ObserveResult`.
 * `applyObserveScopeExperiments` composes them (focus -> region -> overview) and
 * records what it did in `observeScope` so the reduction is measurable on the
 * wire. Applied to the `observe` tool payload only; the diff pipeline owns
 * post-action observations and must keep diffing against the full sanitized tree.
 */

export interface ObserveScopeConfig {
  /** FOCUS on. */
  focus: boolean;
  /** Requested dimensions withheld because their server experiment flags are off. */
  gatedOff?: ObserveScopeKind[];
  /** Optional FOCUS anchor; when absent, FOCUS scopes to the foreground app. */
  focusAnchor?: FocusAnchor;
  /** OVERVIEW on. */
  overview: boolean;
  /** REGION on. */
  region: boolean;
  /** Optional REGION box; when absent, REGION uses the inset content rectangle. */
  regionBox?: NormalizedRegion;
}

/** Structural attributes OVERVIEW keeps on a retained node; all else is dropped. */
const OVERVIEW_KEPT_ATTRS: ReadonlySet<string> = new Set([
  "resource-id",
  "class",
  "className",
  "content-desc",
  "bounds",
  "scrollable",
  "clickable",
]);

type NodeRecord = Record<string, unknown>;

/** Deep clone matching the repo's hierarchy-cloning convention (JSON round-trip). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Normalize a `node` slot to an attribute-bag array. The runtime node carries
 * flattened attributes but `ViewHierarchyNode` has no string index signature, so
 * we read through `unknown` and assert to `NodeRecord` (a single assertion, not a
 * `as unknown as` double-cast). Handles the single-vs-array shape variance the
 * root and child slots exhibit.
 */
function toRecordArray(node: unknown): NodeRecord[] {
  if (Array.isArray(node)) {
    return node as NodeRecord[];
  }
  if (node && typeof node === "object") {
    return [node as NodeRecord];
  }
  return [];
}

/** Children of a node as an array (children live under `.node`). */
function childrenOf(node: NodeRecord): NodeRecord[] {
  return toRecordArray(node.node);
}

/** Read an attribute, preferring the flattened key and falling back to the raw `$` bag. */
function attr(node: NodeRecord, key: string): unknown {
  if (node[key] !== undefined) {
    return node[key];
  }
  const raw = node.$;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return (raw as NodeRecord)[key];
  }
  return undefined;
}

function stringAttr(node: NodeRecord, key: string): string {
  const value = attr(node, key);
  return typeof value === "string" ? value : "";
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Read a node's bounds tolerant of both shapes the wire can carry: the
 * `{left,top,right,bottom}` object and the `--observe-result-compact` positional
 * tuple `[left, top, right, bottom]`. Returns null when unreadable.
 */
export function readBounds(value: unknown): ElementBounds | null {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number")) {
    return { left: value[0], top: value[1], right: value[2], bottom: value[3] };
  }
  if (value && typeof value === "object") {
    const b = value as NodeRecord;
    if (
      typeof b.left === "number" &&
      typeof b.top === "number" &&
      typeof b.right === "number" &&
      typeof b.bottom === "number"
    ) {
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
  }
  return null;
}

/** Half-open rectangle overlap: touching edges do not count as intersecting. */
function intersects(a: ElementBounds, b: ElementBounds): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

function countNodes(nodes: NodeRecord[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countNodes(childrenOf(node));
  }
  return total;
}

function rootNodes(obs: ObserveResult): NodeRecord[] {
  return toRecordArray(obs.viewHierarchy?.hierarchy?.node);
}

function setRootNodes(obs: ObserveResult, nodes: NodeRecord[]): void {
  const hierarchy = obs.viewHierarchy?.hierarchy;
  if (hierarchy) {
    // The `node` slot is typed as a single node but holds an array at runtime
    // (see `ObserveResultOutput.toNodeArray`); write through a widened view.
    (hierarchy as { node?: unknown }).node = nodes;
  }
}

/** Replace a node's child array in place, deleting the key when empty. */
function withChildren(node: NodeRecord, children: NodeRecord[]): NodeRecord {
  const copy: NodeRecord = { ...node };
  if (children.length > 0) {
    copy.node = children;
  } else {
    delete copy.node;
  }
  return copy;
}

/* ------------------------------------------------------------------------ *
 * FOCUS
 * ------------------------------------------------------------------------ */

/** Depth-first search for the first node matching a semantic anchor. */
function findAnchor(nodes: NodeRecord[], anchor: FocusAnchor): NodeRecord | null {
  for (const node of nodes) {
    if (anchor.resourceId !== undefined && stringAttr(node, "resource-id") === anchor.resourceId) {
      return node;
    }
    if (
      anchor.text !== undefined &&
      anchor.text !== "" &&
      stringAttr(node, "text").includes(anchor.text)
    ) {
      return node;
    }
    const found = findAnchor(childrenOf(node), anchor);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * The package prefix of a resource-id — `com.pkg:id/name` -> `com.pkg`, `""` when
 * absent or unqualified. This is the app-vs-chrome signal that SURVIVES capture:
 * per-node `package` is dropped by `ViewHierarchy.cleanNodeProperties`, but the
 * resource-id (and its package qualifier) is on the allow-list, and Android
 * system chrome carries ids like `com.android.systemui:id/...`.
 */
function resourceIdPackage(rid: string): string {
  const colon = rid.indexOf(":");
  return colon > 0 ? rid.slice(0, colon) : "";
}

/**
 * A resource-id package prefix names FOREIGN system chrome only when it is a
 * REAL dotted Android package other than the foreground app. The dot test is
 * load-bearing and prevents two catastrophic false positives:
 *
 *  - The `android:` framework namespace (`android:id/content` — the setContentView
 *    host present in EVERY app window — plus AlertDialog `android:id/button1`,
 *    ActionBar, and list framework ids) belongs to APP content, not chrome.
 *    Prefix `android` has no dot, so it is neutral and kept; without this guard
 *    FOCUS would empty the app subtree in the common dialog / content-view case.
 *  - iOS accessibility identifiers (`row:0`, `section:2:cell:1`) split on their
 *    colon to an undotted prefix, so iOS is a natural no-op — a dotted-package
 *    prefix is an Android shape iOS does not produce.
 *
 * Real chrome (`com.android.systemui:id/...`, the dotted IME package) and other
 * apps' windows keep their dotted prefixes and are correctly dropped.
 */
function isForeignPackage(pkg: string, fgPackage: string): boolean {
  return pkg.includes(".") && pkg !== fgPackage;
}

/**
 * Drop subtrees rooted at an identifiable foreign-package node — status bar, nav
 * bar, IME. A node with no dotted-package resource-id (a generic container, an
 * `android:`-framework host, or an app/Compose/iOS leaf) is neutral and kept, so
 * real app content is never dropped merely for its id namespace.
 */
function pruneForeignChrome(node: NodeRecord, fgPackage: string): NodeRecord | null {
  if (isForeignPackage(resourceIdPackage(stringAttr(node, "resource-id")), fgPackage)) {
    return null;
  }
  const keptChildren = childrenOf(node)
    .map((child) => pruneForeignChrome(child, fgPackage))
    .filter((child): child is NodeRecord => child !== null);
  return withChildren(node, keptChildren);
}

function foregroundPackage(obs: ObserveResult): string {
  return obs.viewHierarchy?.packageName || obs.activeWindow?.appId || "";
}

/** Whether an `Element`-shaped record belongs to a foreign (chrome) package. */
function isForeignElement(item: { "resource-id"?: unknown }, fgPackage: string): boolean {
  const rid = typeof item["resource-id"] === "string" ? item["resource-id"] : "";
  return isForeignPackage(resourceIdPackage(rid), fgPackage);
}

/**
 * Drop categorized elements whose resource-id names a non-foreground package.
 * Only the three id-bearing categories are filtered — `media` (MediaView) carries
 * no resource-id, so it has no package identity to be foreign by and is left as-is.
 */
function filterElementsByForeignPackage(obs: ObserveResult, fgPackage: string): void {
  const elements = obs.elements;
  if (!elements) {
    return;
  }
  const keep = (item: { "resource-id"?: unknown }): boolean => !isForeignElement(item, fgPackage);
  elements.clickable = (elements.clickable ?? []).filter(keep);
  elements.scrollable = (elements.scrollable ?? []).filter(keep);
  elements.text = (elements.text ?? []).filter(keep);
}

/**
 * FOCUS transform. With an anchor, keep only the matched node's subtree. Without
 * one (`scope.focus: true`), drop identifiable non-foreground chrome. Returns the
 * (possibly unchanged) result plus how it resolved, for `observeScope`.
 */
export function scopeToFocus(
  input: ObserveResult,
  anchor?: FocusAnchor,
): { result: ObserveResult; focus: NonNullable<ObserveScopeMetadata["focus"]> } {
  const obs = clone(input);
  const roots = rootNodes(obs);

  if (anchor && (anchor.resourceId !== undefined || anchor.text !== undefined)) {
    const matched = findAnchor(roots, anchor);
    if (matched) {
      setRootNodes(obs, [matched]);
    }
    return { result: obs, focus: { by: "anchor", matched: matched !== null } };
  }

  const pkg = foregroundPackage(obs);
  if (pkg === "") {
    return { result: obs, focus: { by: "foreground-app", matched: false } };
  }
  const before = countNodes(roots);
  const kept = roots
    .map((root) => pruneForeignChrome(root, pkg))
    .filter((root): root is NodeRecord => root !== null);
  setRootNodes(obs, kept);
  filterElementsByForeignPackage(obs, pkg);
  // `matched` reports whether any foreign chrome was actually pruned. When the
  // tree is already just the app (or iOS carries no qualified ids) nothing drops
  // and it stays false — an honest "no reduction" signal.
  const matched = countNodes(kept) !== before;
  return { result: obs, focus: { by: "foreground-app", matched, packageName: pkg } };
}

/* ------------------------------------------------------------------------ *
 * REGION
 * ------------------------------------------------------------------------ */

/** The inset-adjusted content rectangle in pixels (screen minus system insets). */
function contentRectPx(obs: ObserveResult): ElementBounds | null {
  const size = obs.screenSize;
  if (!size || typeof size.width !== "number" || typeof size.height !== "number") {
    return null;
  }
  const insets = obs.systemInsets ?? { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    left: insets.left ?? 0,
    top: insets.top ?? 0,
    right: size.width - (insets.right ?? 0),
    bottom: size.height - (insets.bottom ?? 0),
  };
}

/** Convert a normalized box to pixels using screen dimensions. */
function regionToPx(obs: ObserveResult, box: NormalizedRegion): ElementBounds | null {
  const size = obs.screenSize;
  if (!size || typeof size.width !== "number" || typeof size.height !== "number") {
    return null;
  }
  return {
    left: box.x1 * size.width,
    top: box.y1 * size.height,
    right: box.x2 * size.width,
    bottom: box.y2 * size.height,
  };
}

/**
 * Prune a node to the crop rectangle: keep it when its own bounds intersect the
 * rect, or any descendant is kept, or it has no readable bounds (structural
 * containers are never geometrically excluded). Off-rect leaves drop.
 */
function pruneToRect(node: NodeRecord, rect: ElementBounds): NodeRecord | null {
  const keptChildren = childrenOf(node)
    .map((child) => pruneToRect(child, rect))
    .filter((child): child is NodeRecord => child !== null);
  if (keptChildren.length > 0) {
    return withChildren(node, keptChildren);
  }
  const bounds = readBounds(attr(node, "bounds"));
  if (bounds === null) {
    // No readable bounds: never geometrically excluded — a container/leaf we
    // cannot place is kept rather than silently dropped.
    return withChildren(node, []);
  }
  return intersects(bounds, rect) ? withChildren(node, []) : null;
}

function filterElementsByRect(obs: ObserveResult, rect: ElementBounds): void {
  const elements = obs.elements;
  if (!elements) {
    return;
  }
  const keep = <T extends { bounds?: unknown }>(item: T): boolean => {
    const bounds = readBounds(item.bounds);
    return bounds === null || intersects(bounds, rect);
  };
  // Guard each category: the ObserveResult type makes them non-optional arrays,
  // but this runs at the wire chokepoint where a malformed payload must not throw.
  elements.clickable = (elements.clickable ?? []).filter(keep);
  elements.scrollable = (elements.scrollable ?? []).filter(keep);
  elements.text = (elements.text ?? []).filter(keep);
  elements.media = (elements.media ?? []).filter(keep);
}

/**
 * REGION transform. Crops the hierarchy and the categorized `elements` to the
 * pixel rectangle, and returns it for `observeScope`. When `box` is omitted the
 * inset-adjusted content rectangle is used.
 */
export function scopeToRegion(
  input: ObserveResult,
  box?: NormalizedRegion,
): { result: ObserveResult; rectPx: ElementBounds | null } {
  const obs = clone(input);
  const rect = box ? regionToPx(obs, box) : contentRectPx(obs);
  if (rect === null) {
    return { result: obs, rectPx: null };
  }
  const kept = rootNodes(obs)
    .map((root) => pruneToRect(root, rect))
    .filter((root): root is NodeRecord => root !== null);
  setRootNodes(obs, kept);
  filterElementsByRect(obs, rect);
  return { result: obs, rectPx: rect };
}

/* ------------------------------------------------------------------------ *
 * OVERVIEW
 * ------------------------------------------------------------------------ */

/**
 * A node is structural — kept in the skeleton — when it has kept children,
 * scrolls, or is addressable. "Addressable" is any of the identity/interaction
 * attributes an agent targets: `resource-id`, `content-desc`, or `clickable`.
 * Consulting `clickable`/`content-desc` (both in `OVERVIEW_KEPT_ATTRS`) is what
 * keeps id-less-but-tappable controls — common on Compose and iOS, where the
 * accessibility label, not a resource-id, is the identity — instead of collapsing
 * them into an `omittedDescendants` count.
 */
function isStructural(node: NodeRecord, hasKeptChildren: boolean): boolean {
  return (
    hasKeptChildren ||
    isTruthyFlag(attr(node, "scrollable")) ||
    isTruthyFlag(attr(node, "clickable")) ||
    stringAttr(node, "resource-id") !== "" ||
    stringAttr(node, "content-desc") !== ""
  );
}

/** Keep only the structural-attribute allowlist on an overview node. */
function trimToStructuralAttrs(node: NodeRecord): NodeRecord {
  const out: NodeRecord = {};
  for (const key of Object.keys(node)) {
    if (key === "node") {
      continue;
    }
    if (OVERVIEW_KEPT_ATTRS.has(key)) {
      out[key] = node[key];
    }
  }
  return out;
}

/**
 * Collapse a subtree to its structural skeleton. Returns the retained node (or
 * null when this node is an anonymous leaf) and `dropped` — the count of original
 * nodes in this subtree NOT represented in the output. A dropped node has no kept
 * descendants (`isStructural` forces any node with kept children to be kept), so
 * dropping one drops its whole subtree. `dropped` below a kept node is surfaced as
 * `omittedDescendants` so nothing vanishes silently.
 */
function toOverviewNode(node: NodeRecord): { node: NodeRecord | null; dropped: number } {
  const results = childrenOf(node).map(toOverviewNode);
  const keptChildren = results.map((r) => r.node).filter((n): n is NodeRecord => n !== null);
  const droppedBelow = results.reduce((sum, r) => sum + r.dropped, 0);

  if (!isStructural(node, keptChildren.length > 0)) {
    return { node: null, dropped: 1 + droppedBelow };
  }

  const trimmed = trimToStructuralAttrs(node);
  if (keptChildren.length > 0) {
    trimmed.node = keptChildren;
  }
  if (droppedBelow > 0) {
    trimmed.omittedDescendants = droppedBelow;
  }
  return { node: trimmed, dropped: droppedBelow };
}

/**
 * OVERVIEW transform. Drops `elements` (leaf-level detail the skeleton replaces)
 * and collapses the hierarchy to structural/addressable nodes.
 *
 * `omittedDescendants` annotates each SURVIVING node with the count of nodes
 * dropped beneath it. A root subtree that collapses entirely (all-anonymous) has
 * no surviving node to annotate; that omission is still surfaced globally by
 * `observeScope.nodesBefore` vs `nodesAfter`, so nothing vanishes unaccounted for.
 * A consumer must NOT sum `omittedDescendants` across nodes — an ancestor's count
 * already subsumes its descendants'.
 */
export function toOverview(input: ObserveResult): ObserveResult {
  const obs = clone(input);
  const kept = rootNodes(obs)
    .map(toOverviewNode)
    .map((r) => r.node)
    .filter((n): n is NodeRecord => n !== null);
  setRootNodes(obs, kept);
  delete obs.elements;
  return obs;
}

/* ------------------------------------------------------------------------ *
 * Compose + resolve
 * ------------------------------------------------------------------------ */

/** Mutable accumulator threaded through the scope stages. */
interface ScopeRun {
  current: ObserveResult;
  applied: ObserveScopeKind[];
  regionPx?: ElementBounds;
  focus?: ObserveScopeMetadata["focus"];
}

/** Total categorized elements across all four buckets. */
function elementsCount(obs: ObserveResult): number {
  const e = obs.elements;
  if (!e) {
    return 0;
  }
  return (
    (e.clickable?.length ?? 0) +
    (e.scrollable?.length ?? 0) +
    (e.text?.length ?? 0) +
    (e.media?.length ?? 0)
  );
}

/**
 * True when a stage materially scoped the payload — a change in either the node
 * count OR the categorized element count. FOCUS and REGION both prune `elements`,
 * so a crop that removed only off-scope elements (no hierarchy nodes) still counts
 * as applied; without the element check `applied[]` would under-report it.
 */
function scopeChanged(before: ObserveResult, after: ObserveResult): boolean {
  return (
    countNodes(rootNodes(before)) !== countNodes(rootNodes(after)) ||
    elementsCount(before) !== elementsCount(after)
  );
}

function runFocusStage(run: ScopeRun, cfg: ObserveScopeConfig): void {
  const { result, focus } = scopeToFocus(run.current, cfg.focusAnchor);
  run.focus = focus;
  if (scopeChanged(run.current, result)) {
    run.applied.push("focus");
  }
  run.current = result;
}

function runRegionStage(run: ScopeRun, cfg: ObserveScopeConfig): void {
  const { result, rectPx } = scopeToRegion(run.current, cfg.regionBox);
  if (rectPx) {
    run.regionPx = rectPx;
  }
  if (scopeChanged(run.current, result)) {
    run.applied.push("region");
  }
  run.current = result;
}

function runOverviewStage(run: ScopeRun): void {
  // OVERVIEW always materially transforms (trims attributes, drops `elements`)
  // even when the node count is unchanged, so it is unconditionally recorded.
  run.current = toOverview(run.current);
  run.applied.push("overview");
}

function buildScopeMetadata(
  run: ScopeRun,
  nodesBefore: number,
  gatedOff: ObserveScopeKind[],
): ObserveScopeMetadata {
  const metadata: ObserveScopeMetadata = {
    applied: run.applied,
    nodesBefore,
    nodesAfter: countNodes(rootNodes(run.current)),
  };
  if (gatedOff.length > 0) {
    metadata.gatedOff = gatedOff;
  }
  if (run.regionPx) {
    metadata.regionPx = run.regionPx;
  }
  if (run.focus) {
    metadata.focus = run.focus;
  }
  return metadata;
}

/**
 * Apply the enabled scope transforms in order (focus -> region -> overview) and
 * annotate `observeScope`. Pure: the input is never mutated. Requested
 * dimensions gated off by server flags are recorded without changing the tree.
 * When no transform is enabled and nothing was gated off, returns the input
 * unchanged (no clone, no metadata).
 */
export function applyObserveScopeExperiments(
  input: ObserveResult,
  cfg: ObserveScopeConfig,
): ObserveResult {
  const gatedOff = cfg.gatedOff ?? [];
  if (!cfg.focus && !cfg.region && !cfg.overview && gatedOff.length === 0) {
    return input;
  }

  const nodesBefore = countNodes(rootNodes(input));
  const run: ScopeRun = { current: input, applied: [] };

  if (cfg.focus) {
    runFocusStage(run, cfg);
  }
  if (cfg.region) {
    runRegionStage(run, cfg);
  }

  // Co-scope layoutWarnings against the FOCUS/REGION-pruned tree, captured BEFORE
  // OVERVIEW (issue #5074). Those two transforms are lossless — kept nodes retain
  // every attribute (including the iOS `$` bag that holds bounds/identity) — so
  // matching is exact. OVERVIEW instead strips attributes and collapses leaves
  // into kept ancestors (a structural summary, not a spatial removal), so reading
  // identity from the post-OVERVIEW tree both drops iOS warnings wholesale (the
  // `$` bag is gone) and cannot tell a collapsed child from its surviving parent.
  // A warning for a leaf OVERVIEW summarizes is retained: its location is still
  // shown, occupied by the kept ancestor whose `omittedDescendants` flags the
  // collapse.
  const survivors = collectSurvivorBoundsIdentity(rootNodes(run.current));
  const prunedBeforeOverview = countNodes(rootNodes(run.current)) < nodesBefore;

  if (cfg.overview) {
    runOverviewStage(run);
  }

  // Every stage returns a fresh clone, so `run.current` is never the input here;
  // guard the theoretically-unreachable no-op case anyway.
  const out = run.current === input ? clone(input) : run.current;
  scopeLayoutWarnings(out, survivors, prunedBeforeOverview);
  out.observeScope = buildScopeMetadata({ ...run, current: out }, nodesBefore, gatedOff);
  return out;
}

/**
 * Co-scope `layoutWarnings` with the pruned hierarchy (issue #5074). The audit
 * runs on the full tree in `ObserveScreen`, before these transforms drop nodes,
 * so a scoped response could otherwise list a warning for an element no longer
 * in the returned `viewHierarchy`.
 *
 * `survivors` is the identity index of the FOCUS/REGION-pruned tree, captured by
 * the caller before OVERVIEW (see `applyObserveScopeExperiments`). A warning
 * survives when a surviving node at its element's bounds is plausibly the *same*
 * element — same identity, no conflicting identifier — with a wildcard when
 * either side is genuinely identity-less (a bare bounds match).
 *
 * When scoping removes warnings, the list becomes `scope: "scoped"`. A
 * `truncated` list also becomes `scoped` once the hierarchy was pruned, since a
 * capped-away warning may belong to a pruned node — so `total` (the pre-cap count
 * of the *un-scoped* population) no longer describes what is shown and is dropped.
 */
function scopeLayoutWarnings(out: ObserveResult, survivors: SurvivorIndex, pruned: boolean): void {
  const layoutWarnings = out.layoutWarnings;
  if (!layoutWarnings || layoutWarnings.warnings.length === 0) {
    return;
  }
  const kept = layoutWarnings.warnings.filter((warning) => warningSurvives(warning, survivors));
  const dropped = kept.length !== layoutWarnings.warnings.length;
  // A `truncated` total counted the un-scoped population; once pruning hides
  // nodes it may over-count what is reachable, so it is no longer trustworthy.
  const staleTotal = pruned && layoutWarnings.scope === "truncated";
  if (!dropped && !staleTotal) {
    return;
  }
  out.layoutWarnings = { scope: "scoped", warnings: kept };
}

/** A surviving node's identity fields (empty string = absent). */
interface NodeIdentity {
  viewId: string;
  resourceId: string;
  contentDesc: string;
  text: string;
}
/** Per-rectangle survival index: the identity of every surviving node at each bounds. */
type SurvivorIndex = Map<string, NodeIdentity[]>;

function collectSurvivorBoundsIdentity(nodes: NodeRecord[]): SurvivorIndex {
  const index: SurvivorIndex = new Map();
  const walk = (list: NodeRecord[]): void => {
    for (const node of list) {
      indexSurvivor(node, index);
      walk(childrenOf(node));
    }
  };
  walk(nodes);
  return index;
}

/** Record one surviving node's bounds → identity in the index. */
function indexSurvivor(node: NodeRecord, index: SurvivorIndex): void {
  const bounds = readBounds(attr(node, "bounds"));
  if (bounds === null) {
    return;
  }
  const key = boundsKey(bounds);
  const list = index.get(key) ?? [];
  list.push({
    viewId: stringAttr(node, "view-id"),
    resourceId: stringAttr(node, "resource-id"),
    contentDesc: stringAttr(node, "content-desc"),
    text: stringAttr(node, "text"),
  });
  index.set(key, list);
}

function warningSurvives(
  warning: LayoutWarnings["warnings"][number],
  survivors: SurvivorIndex,
): boolean {
  const bounds = readBounds(warning.element?.bounds);
  if (bounds === null) {
    return false;
  }
  const candidates = survivors.get(boundsKey(bounds));
  if (candidates === undefined) {
    return false; // no node survives at this rectangle
  }
  return candidates.some((node) => nodeMatchesWarning(node, warning.element ?? {}));
}

type WarningElement = { viewId?: string; resourceId?: string; contentDesc?: string; text?: string };

/** Two populated values that disagree. */
function conflicts(a: string | undefined, b: string): boolean {
  return !!a && !!b && a !== b;
}

/** Two values that are populated and equal. */
function shares(a: string | undefined, b: string): boolean {
  return !!a && a === b;
}

function hasAnyIdentity(id: WarningElement | NodeIdentity): boolean {
  return !!(id.viewId || id.resourceId || id.contentDesc || id.text);
}

/**
 * Whether a surviving node plausibly IS the warning's element.
 * - Reject when ANY identity field (`resource-id`/`view-id`/`content-desc`/`text`)
 *   is populated on both sides but differs — two distinct nodes at one rectangle
 *   (issue #5074). Since co-scoping runs against the lossless FOCUS/REGION tree,
 *   every populated field is a reliable discriminator.
 * - Wildcard-keep when either side carries no identity: a genuinely-visible
 *   element sits here (a bare bounds match), and dropping its warning would be a
 *   false negative.
 * - Otherwise require at least one shared populated field.
 */
function nodeMatchesWarning(node: NodeIdentity, element: WarningElement): boolean {
  if (
    conflicts(element.resourceId, node.resourceId) ||
    conflicts(element.viewId, node.viewId) ||
    conflicts(element.contentDesc, node.contentDesc) ||
    conflicts(element.text, node.text)
  ) {
    return false;
  }
  if (!hasAnyIdentity(element) || !hasAnyIdentity(node)) {
    return true;
  }
  return (
    shares(element.resourceId, node.resourceId) ||
    shares(element.viewId, node.viewId) ||
    shares(element.contentDesc, node.contentDesc) ||
    shares(element.text, node.text)
  );
}

/** Canonical bounds identity, shape-independent (object and tuple map to the same key). */
function boundsKey(bounds: ElementBounds): string {
  return `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;
}

/** The server experiment gates; each honors its `scope` dimension only when on. */
export interface ObserveScopeFlags {
  focus: boolean;
  overview: boolean;
  region: boolean;
}

/** A dimension is requested when the call set it to `true` or an object (not `false`/absent). */
function isDimensionRequested(dim: boolean | object | undefined): boolean {
  return dim !== undefined && dim !== false;
}

function gatedOffDimensions(
  flags: ObserveScopeFlags,
  scope: ObserveScopeInput | undefined,
): ObserveScopeKind[] {
  const gatedOff: ObserveScopeKind[] = [];
  if (!flags.focus && isDimensionRequested(scope?.focus)) {
    gatedOff.push("focus");
  }
  if (!flags.region && isDimensionRequested(scope?.region)) {
    gatedOff.push("region");
  }
  if (!flags.overview && scope?.overview === true) {
    gatedOff.push("overview");
  }
  return gatedOff;
}

/** The anchor object of a `focus` request, or undefined for the `true` (foreground) form. */
function focusAnchorOf(focus: ObserveScopeInput["focus"]): FocusAnchor | undefined {
  return typeof focus === "object" ? focus : undefined;
}

/** The box of a `region` request, or undefined for the `true` (content-rect) form. */
function regionBoxOf(region: ObserveScopeInput["region"]): NormalizedRegion | undefined {
  return typeof region === "object" ? region : undefined;
}

/**
 * Build an {@link ObserveScopeConfig} by intersecting the per-call `scope` request
 * (from the `observe` tool input — where the agent picks where to zoom on THIS
 * screen) with the server experiment flags. A dimension is applied only when both
 * the call asked for it AND its flag is enabled, so the flag stays the dark-launch
 * gate while the parameters travel in the tool call, not the environment.
 */
export function buildObserveScopeConfig(
  flags: ObserveScopeFlags,
  scope: ObserveScopeInput | undefined,
): ObserveScopeConfig {
  return {
    focus: flags.focus && isDimensionRequested(scope?.focus),
    focusAnchor: focusAnchorOf(scope?.focus),
    overview: flags.overview && scope?.overview === true,
    region: flags.region && isDimensionRequested(scope?.region),
    regionBox: regionBoxOf(scope?.region),
    gatedOff: gatedOffDimensions(flags, scope),
  };
}
