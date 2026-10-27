import type { Element } from "../../../../models/Element";
import type { ObserveResult } from "../../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../models/ViewHierarchyResult";
import { projectSkeletonElement } from "../SkeletonProjection";
import { SearchableHierarchy, type SearchableEntry } from "../../../utility/SearchableNode";
import { GENERATED_VIEW_ID_PATTERN } from "../../android/StableNodeIdentity";
import { boundsKey, flattenForDiff, isIosObservation, groupByKey } from "./hierarchy";
import {
  type ObserveDiffSelector,
  type ObserveDiffNode,
  type ObserveDiffNodeChange,
  type ObserveDiff,
  type DiffObserveConfig,
  type FlatObserveNode,
  type DiffRepairNode,
} from "./diffTypes";
import {
  diffElementId,
  diffLabel,
  deriveDiffSelector,
  distinctSelectorCandidates,
  computeSelectorOccurrenceIndexes,
  selectorGroupKey,
} from "./diffSelectors";
import { diffAttributes, appendFieldChanges } from "./diffComparison";

/**
 * A node's *stable content* identity key (issue #3053): `resource-id / view-id /
 * content-desc / text`, NUL-joined. Deliberately excludes `bounds` and sibling
 * index (the fields a scroll/insert perturbs) so a node keeps this key when it
 * only moves. Returns `null` when the node carries no stable identity at all (all
 * four empty) — an empty key is not identity and must never be used to re-pair.
 *
 * For id-less/text-less Android nodes the `view-id` slot is the capture layer's
 * content-derived stable id (`assignStableViewIds`, issue #3228) — stable across
 * a scroll and text-suffixed when descendant labels distinguish structural
 * duplicates (otherwise ordinal-suffixed) — which is what
 * lets this key re-pair rows the other three fields cannot describe.
 */
function contentIdentityKey(attrs: Record<string, unknown>): string | null {
  const resourceId = String(attrs["resource-id"] ?? "");
  const viewId = String(attrs["view-id"] ?? "");
  const contentDesc = String(attrs["content-desc"] ?? "");
  const text = String(attrs["text"] ?? "");
  if (resourceId === "" && viewId === "" && contentDesc === "" && text === "") {
    return null;
  }
  // NUL-joined: `text`/`content-desc` can contain spaces, so a space separator
  // could let a value straddle a field boundary and collide; NUL cannot appear
  // in these attribute strings.
  return [resourceId, viewId, contentDesc, text].join("\0");
}

/** Attributes whose flip a client reads as "this control was toggled". */
const DIFF_STATE_ATTRS: readonly string[] = ["checked", "selected", "state-description"];

/**
 * A control that carries no label of its own (no text, no content-desc) is
 * identified only by a resource id that sibling rows share (`switchWidget`), so
 * a leftover pair keyed by it may be two different controls — the previous
 * screen's Airplane switch and the new screen's Wi-Fi switch. Reporting that
 * pair as one switch whose state flipped asserts a toggle that never happened
 * (#11638); leave it as removed + added instead.
 */
function isUnlabelledStateFlip(
  attributes: Record<string, unknown>,
  attrChanges: Record<string, unknown>,
): boolean {
  const labelled =
    String(attributes["text"] ?? "") !== "" || String(attributes["content-desc"] ?? "") !== "";
  return !labelled && DIFF_STATE_ATTRS.some((attr) => attr in attrChanges);
}

/** Index leftover diff nodes by their content-identity key, dropping keyless nodes. */
function indexByContentKey(nodes: ObserveDiffNode[]): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    const key = contentIdentityKey(node.attributes);
    if (key === null) {
      return;
    }
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      byKey.set(key, [index]);
    }
  });
  return byKey;
}

/**
 * Re-pair leftover remove+add nodes that share a stable content key (issue #3053).
 * A leftover *removed* and *added* node are collapsed into one `changed` entry when
 * their content key is unique among the leftovers on BOTH sides — exactly one
 * candidate each side, so distinct content can never false-merge. This turns a
 * scroll/insert (position shifted, identity intact) into a small bounds delta
 * instead of remove+add churn. Purely additive: only nodes positional matching
 * already left unpaired are considered. `changed` is appended in place; the pruned
 * `added`/`removed` are returned. A re-paired pair with identical attributes emits
 * no `changed` entry (a pure sibling-index move with no visible change).
 */
function repairByContentIdentity(
  added: DiffRepairNode[],
  removed: DiffRepairNode[],
  changed: ObserveDiffNodeChange[],
  selectorForNode: (node: DiffRepairNode) => ObserveDiffSelector | undefined,
): { added: DiffRepairNode[]; removed: DiffRepairNode[] } {
  const addedByKey = indexByContentKey(added);
  const removedByKey = indexByContentKey(removed);
  const consumedAdded = new Set<number>();
  const consumedRemoved = new Set<number>();

  for (const [key, addedIndices] of addedByKey) {
    const removedIndices = removedByKey.get(key);
    // Require a unique candidate on both sides; ambiguous (duplicate) content
    // keys stay as positional remove+add so interchangeable cells never mis-pair.
    if (!removedIndices || addedIndices.length !== 1 || removedIndices.length !== 1) {
      continue;
    }
    const addedNode = added[addedIndices[0]];
    const removedNode = removed[removedIndices[0]];
    const attrChanges = diffAttributes(removedNode.attributes, addedNode.attributes);
    if (isUnlabelledStateFlip(addedNode.attributes, attrChanges)) {
      continue;
    }
    consumedAdded.add(addedIndices[0]);
    consumedRemoved.add(removedIndices[0]);
    if (Object.keys(attrChanges).length > 0) {
      // `key` is the post-move (added-side) key; `fromKey` carries the pre-move
      // (removed-side) key so a consumer can locate the node in the baseline
      // (#3088 limitation 2, #3107). Emitted only on re-paired entries.
      recordChange(
        changed,
        {
          key: addedNode.key,
          fromKey: removedNode.key,
          selector: selectorForNode(addedNode),
          changes: attrChanges,
        },
        addedNode.attributes,
      );
    }
  }

  if (consumedAdded.size === 0 && consumedRemoved.size === 0) {
    return { added, removed };
  }
  return {
    added: added.filter((_, index) => !consumedAdded.has(index)),
    removed: removed.filter((_, index) => !consumedRemoved.has(index)),
  };
}

function stringAttr(attrs: Record<string, unknown>, key: string): string {
  const value = attrs[key];
  return typeof value === "string" ? value : "";
}

function iosStableId(attrs: Record<string, unknown>): string {
  const resourceId = stringAttr(attrs, "resource-id");
  if (resourceId !== "") {
    return resourceId;
  }
  const accessibilityIdentifier = stringAttr(attrs, "accessibilityIdentifier");
  if (accessibilityIdentifier !== "") {
    return accessibilityIdentifier;
  }
  const viewId = stringAttr(attrs, "view-id");
  if (viewId !== "" && !GENERATED_VIEW_ID_PATTERN.test(viewId)) {
    return viewId;
  }
  return "";
}

function quantizedBoundsKey(bounds: unknown): string {
  const parts = boundsKey(bounds)
    .split(",")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return "";
  }
  return parts.map((part) => Math.round(part / 8)).join(",");
}

function isIosEditableClass(className: string): boolean {
  return (
    className === "XCUIElementTypeTextField" ||
    className === "XCUIElementTypeSecureTextField" ||
    className === "XCUIElementTypeTextView" ||
    className === "XCUIElementTypeSearchField" ||
    className === "UITextField" ||
    className === "UISecureTextField" ||
    className === "UITextView" ||
    className === "UISearchBar"
  );
}

function isIosListCellClass(className: string): boolean {
  return (
    className === "XCUIElementTypeCell" ||
    className === "UITableViewCell" ||
    className === "UICollectionViewCell" ||
    className === "XCUIElementTypeTable" ||
    className === "XCUIElementTypeCollectionView" ||
    className === "UITableView" ||
    className === "UICollectionView"
  );
}

function hasIosListCellAncestor(node: DiffRepairNode): boolean {
  return node.ancestorClasses.some((className) => isIosListCellClass(className));
}

/**
 * Conservative iOS identity for in-place editable controls (#3318). UIKit /
 * SwiftUI wrappers commonly churn text/value/focus while preserving an
 * accessibility identifier and screen region; pairing those as `changed` makes
 * text entry readable. Reused table/collection cell identifiers deliberately
 * opt out because a lone reused id can describe a different logical row.
 */
function iosStableIdentityKey(node: DiffRepairNode): string | null {
  const className =
    stringAttr(node.attributes, "className") || stringAttr(node.attributes, "class");
  if (hasIosListCellAncestor(node)) {
    return null;
  }
  if (isIosListCellClass(className) || !isIosEditableClass(className)) {
    return null;
  }
  const stableId = iosStableId(node.attributes);
  if (stableId === "") {
    return null;
  }
  const boundsRegion = quantizedBoundsKey(node.attributes.bounds);
  if (boundsRegion === "") {
    return null;
  }
  return [stableId, className, boundsRegion].join("\0");
}

function indexByIosStableKey(nodes: DiffRepairNode[]): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    const key = iosStableIdentityKey(node);
    if (key === null) {
      return;
    }
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      byKey.set(key, [index]);
    }
  });
  return byKey;
}

function repairByIosStableIdentity(
  added: DiffRepairNode[],
  removed: DiffRepairNode[],
  changed: ObserveDiffNodeChange[],
  selectorForNode: (node: DiffRepairNode) => ObserveDiffSelector | undefined,
): { added: DiffRepairNode[]; removed: DiffRepairNode[] } {
  const addedByKey = indexByIosStableKey(added);
  const removedByKey = indexByIosStableKey(removed);
  const consumedAdded = new Set<number>();
  const consumedRemoved = new Set<number>();

  for (const [key, addedIndices] of addedByKey) {
    const removedIndices = removedByKey.get(key);
    if (!removedIndices || addedIndices.length !== 1 || removedIndices.length !== 1) {
      continue;
    }
    const addedNode = added[addedIndices[0]];
    const removedNode = removed[removedIndices[0]];
    consumedAdded.add(addedIndices[0]);
    consumedRemoved.add(removedIndices[0]);
    const attrChanges = diffAttributes(removedNode.attributes, addedNode.attributes);
    if (Object.keys(attrChanges).length > 0) {
      recordChange(
        changed,
        {
          key: addedNode.key,
          fromKey: removedNode.key,
          selector: selectorForNode(addedNode),
          changes: attrChanges,
        },
        addedNode.attributes,
      );
    }
  }

  if (consumedAdded.size === 0 && consumedRemoved.size === 0) {
    return { added, removed };
  }
  return {
    added: added.filter((_, index) => !consumedAdded.has(index)),
    removed: removed.filter((_, index) => !consumedRemoved.has(index)),
  };
}

/**
 * `added`/`removed` entries deliberately do NOT carry a `selector` field: they
 * already carry the node's FULL `attributes` (including `resource-id` /
 * `view-id` / `text` / `content-desc`), so the real selector is already there —
 * a synthesized `selector` would be pure duplication of bytes already on the
 * wire (it would materially erode the diff-format's whole reason to exist: see
 * the ~60%-of-full byte budget asserted in
 * `test/features/observe/output/stableIdentityScrollDiff.test.ts`). Only
 * `changed` entries lack full attributes (they carry only the delta), which is
 * where {@link deriveDiffSelector} actually earns its bytes — see its use in
 * {@link diffObserveResult}.
 */
function toObserveDiffNode(
  node: DiffRepairNode,
  projectAddedRemoved: boolean,
): ObserveDiffNode | undefined {
  if (!projectAddedRemoved) {
    return { key: node.key, attributes: node.attributes };
  }
  const skeleton = projectSkeletonElement(node.attributes as Element);
  if (!skeleton || skeleton.affordances.length === 0) {
    return undefined;
  }
  return { key: node.key, attributes: { ...skeleton } };
}

/**
 * Whether two observations describe the same screen. Cross-screen diffs are
 * meaningless (issue #2761), so the finalize hook falls back to a full emit when
 * this is false. When both sides carry non-low-confidence `screenIdentity`,
 * require identity equality. A low-confidence identity is deliberately
 * conservative and forces a full emit. Missing identities preserve the
 * historical app/activity/package fallback.
 */
export function isSameObservationScreen(baseline: ObserveResult, next: ObserveResult): boolean {
  const baselineIdentity = baseline.screenIdentity;
  const nextIdentity = next.screenIdentity;

  if (baselineIdentity?.confidence === "low" || nextIdentity?.confidence === "low") {
    return false;
  }

  if (baselineIdentity && nextIdentity) {
    return (
      baselineIdentity.platform === nextIdentity.platform &&
      baselineIdentity.source === nextIdentity.source &&
      baselineIdentity.key === nextIdentity.key
    );
  }
  return hasSameLegacyObservationScreen(baseline, next);
}

function hasSameLegacyObservationScreen(baseline: ObserveResult, next: ObserveResult): boolean {
  const windowFields = ["appId", "activityName"] as const;
  const sameWindow = windowFields.every(
    (field) => (baseline.activeWindow?.[field] ?? "") === (next.activeWindow?.[field] ?? ""),
  );
  if (!sameWindow) {
    return false;
  }
  return (baseline.viewHierarchy?.packageName ?? "") === (next.viewHierarchy?.packageName ?? "");
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
  cfg?: DiffObserveConfig,
): ObserveDiff {
  const nextFlatNodes = flattenForDiff(next, cfg?.collapseKeyboard, cfg?.skipStatusBar);
  const baseByKey = groupByKey(flattenForDiff(baseline, cfg?.collapseKeyboard, cfg?.skipStatusBar));
  const nextByKey = groupByKey(nextFlatNodes);
  let projected: readonly SearchableEntry[] | undefined;
  let candidates: readonly SearchableEntry[] | undefined;
  let replayByPathKey: ReturnType<typeof computeSelectorOccurrenceIndexes> | undefined;
  const selectorForNode = (node: Pick<FlatObserveNode, "attributes" | "pathKey">) => {
    const selector = deriveDiffSelector(node.attributes);
    if (!selector || !next.viewHierarchy) {
      return selector;
    }
    projected ??= new SearchableHierarchy().project(next.viewHierarchy);
    candidates ??= distinctSelectorCandidates(projected);
    // A unique selector cannot need an index or ambiguity metadata. Check the
    // captured matches first so it never requests the full skeleton projection.
    const sources = new Set<ViewHierarchyNode>();
    for (const candidate of candidates) {
      const matches =
        selector.elementId !== undefined
          ? diffElementId(candidate.properties) === selector.elementId
          : selectorGroupKey(undefined, diffLabel(candidate.properties)) ===
            selectorGroupKey(undefined, selector.label);
      if (matches) {
        sources.add(candidate.source);
      }
    }
    if (sources.size < 2) {
      return selector;
    }
    replayByPathKey ??= computeSelectorOccurrenceIndexes(nextFlatNodes, next, projected);
    return deriveDiffSelector(node.attributes, replayByPathKey.get(node.pathKey));
  };

  const added: DiffRepairNode[] = [];
  const removed: DiffRepairNode[] = [];
  const changed: ObserveDiffNodeChange[] = [];

  collectPositionalNodeDiffs({
    baseByKey,
    nextByKey,
    selectorForNode,
    added,
    removed,
    changed,
  });

  // Content-hash node identity (issue #3053, default on): re-pair leftover
  // remove+add nodes that share a unique stable content key into a `changed`
  // delta, collapsing scroll/insert churn. Positional matching above already
  // disambiguated cross-subtree collisions, so this only touches true leftovers.
  let finalAdded = added;
  let finalRemoved = removed;
  if (cfg?.contentIdentity !== false) {
    const repaired = repairByContentIdentity(added, removed, changed, selectorForNode);
    finalAdded = repaired.added;
    finalRemoved = repaired.removed;
    if (isIosObservation(baseline) && isIosObservation(next)) {
      const iosRepaired = repairByIosStableIdentity(
        finalAdded,
        finalRemoved,
        changed,
        selectorForNode,
      );
      finalAdded = iosRepaired.added;
      finalRemoved = iosRepaired.removed;
    }
  }

  const diff: ObserveDiff = {
    isDiff: true,
    // Placeholder — `elements` is already dropped from `next` by the time it
    // reaches this function (issue #6221 item 4.1), so the caller
    // (`finalizeToolResponse`) overwrites this with the actionable-only
    // skeleton it independently re-projects from the pre-drop payload.
    skeleton: [],
    added: finalAdded
      .map((node) => toObserveDiffNode(node, cfg?.projectAddedRemoved === true))
      .filter((node): node is ObserveDiffNode => node !== undefined),
    removed: finalRemoved
      .map((node) => toObserveDiffNode(node, cfg?.projectAddedRemoved === true))
      .filter((node): node is ObserveDiffNode => node !== undefined),
    changed:
      cfg?.projectAddedRemoved === true
        ? changed.filter((c) => !isNonActionableRelayout(c))
        : changed,
  };
  appendDisplayChange(diff, baseline, next);

  appendFieldChanges(diff, baseline, next, cfg);

  // A diff can retain imported text from the previous screen in removed/from fields.
  preserveImportedPrototypeContent(diff, baseline, next);

  return diff;
}

function preserveImportedPrototypeContent(
  diff: ObserveDiff,
  baseline: ObserveResult,
  next: ObserveResult,
): void {
  const imported = next.importedPrototypeContent ?? baseline.importedPrototypeContent;
  if (imported) {
    diff.importedPrototypeContent = { ...imported };
  }
}

/**
 * Next-side attributes of each emitted `changed` entry, so the skeleton
 * projection can tell an actionable change from a container relayout without
 * widening the wire shape (`changed` entries carry only the delta).
 */
const changeTargets = new WeakMap<ObserveDiffNodeChange, Record<string, unknown>>();

function recordChange(
  changed: ObserveDiffNodeChange[],
  entry: ObserveDiffNodeChange,
  nextAttributes: Record<string, unknown>,
): void {
  changeTargets.set(entry, nextAttributes);
  changed.push(entry);
}

/**
 * Whether a skeleton-projected diff should omit this change: a bounds-only move
 * of a node with no affordance is a relayout the client cannot act on (#11637),
 * the same node class `toObserveDiffNode` already drops from added/removed.
 */
function isNonActionableRelayout(entry: ObserveDiffNodeChange): boolean {
  const attributes = changeTargets.get(entry);
  if (!attributes) {
    return false;
  }
  const changedKeys = Object.keys(entry.changes);
  if (changedKeys.length !== 1 || changedKeys[0] !== "bounds") {
    return false;
  }
  const skeleton = projectSkeletonElement(attributes as Element);
  return !skeleton || skeleton.affordances.length === 0;
}

function collectPositionalNodeDiffs({
  baseByKey,
  nextByKey,
  selectorForNode,
  added,
  removed,
  changed,
}: {
  baseByKey: Map<string, FlatObserveNode[]>;
  nextByKey: Map<string, FlatObserveNode[]>;
  selectorForNode: (node: FlatObserveNode) => ObserveDiffSelector | undefined;
  added: DiffRepairNode[];
  removed: DiffRepairNode[];
  changed: ObserveDiffNodeChange[];
}): void {
  for (const pathKey of new Set([...baseByKey.keys(), ...nextByKey.keys()])) {
    const baseNodes = baseByKey.get(pathKey) ?? [];
    const nextNodes = nextByKey.get(pathKey) ?? [];
    const paired = Math.min(baseNodes.length, nextNodes.length);
    for (let i = 0; i < paired; i++) {
      const attrChanges = diffAttributes(baseNodes[i].attributes, nextNodes[i].attributes);
      if (Object.keys(attrChanges).length > 0) {
        recordChange(
          changed,
          {
            key: nextNodes[i].key,
            selector: selectorForNode(nextNodes[i]),
            changes: attrChanges,
          },
          nextNodes[i].attributes,
        );
      }
    }
    for (let i = paired; i < nextNodes.length; i++) {
      added.push({
        pathKey: nextNodes[i].pathKey,
        key: nextNodes[i].key,
        attributes: nextNodes[i].attributes,
        ancestorClasses: nextNodes[i].ancestorClasses,
      });
    }
    for (let i = paired; i < baseNodes.length; i++) {
      removed.push({
        pathKey: baseNodes[i].pathKey,
        key: baseNodes[i].key,
        attributes: baseNodes[i].attributes,
        ancestorClasses: baseNodes[i].ancestorClasses,
      });
    }
  }
}

function appendDisplayChange(
  diff: ObserveDiff,
  baseline: ObserveResult,
  next: ObserveResult,
): void {
  if (
    baseline.display &&
    next.display &&
    !(baseline.display.key === "0" && baseline.display.role === "unknown") &&
    !(next.display.key === "0" && next.display.role === "unknown") &&
    (baseline.display.key !== next.display.key ||
      baseline.display.role !== next.display.role ||
      baseline.display.posture !== next.display.posture)
  ) {
    const { key: fromKey, role: fromRole, posture: fromPosture } = baseline.display;
    const { key: toKey, role: toRole, posture: toPosture } = next.display;
    diff.displayChanged = {
      from: { key: fromKey, role: fromRole, posture: fromPosture },
      to: { key: toKey, role: toRole, posture: toPosture },
    };
  }
}
