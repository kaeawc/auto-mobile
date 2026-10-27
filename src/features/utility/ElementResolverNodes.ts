import type { ResolutionAction } from "../../models/ResolutionAction";
import {
  STABLE_VIEW_ID_PREFIX,
  STABLE_VIEW_ID_HASH_LENGTH,
  isSdkInjectedNode,
} from "../observe/android/StableNodeIdentity";
import type { ResolverSelector } from "../../models/elementSelectorSchemas";
import type { SearchableEntry } from "./SearchableNode";
import { boundsArea, boundsEqual, intersectBounds } from "../../utils/bounds";
import type { ElementBounds } from "../../models/ElementBounds";
import { isEditableElementProperties } from "./elementProperties";
import type { Element } from "../../models/Element";
import { hasVisibleScreenPart } from "./ElementGeometry";
import { normalize } from "./ElementResolverMatching";
import type {
  ElementReference,
  ElementResolution,
  ResolutionIntent,
  ResolverSnapshot,
} from "./ElementResolverTypes";

const ordinalNodeKey = new RegExp(
  `^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}}-\\d+$`,
);

export function usesClickablePromotion(action: ResolutionAction): boolean {
  return action === "tap" || action === "long-press" || action === "highlight";
}

export function isMissingContainerError(error: string | undefined): boolean {
  return /^Container level \d+ not found:/.test(error ?? "");
}

function centerWithinViewport(
  bounds: ElementBounds,
  viewport: { width: number; height: number },
): boolean {
  return hasVisibleScreenPart(bounds, viewport);
}

export function hasVisibleBounds(
  node: SearchableEntry,
  intent: Pick<ResolutionIntent, "viewport">,
): boolean {
  return !!node.bounds && (!intent.viewport || centerWithinViewport(node.bounds, intent.viewport));
}

/** Choose the nearest actionable node, preserving the matched node separately. */
export function promoteClickableAncestor(
  node: SearchableEntry,
  nodes: readonly SearchableEntry[],
  intent: Pick<ResolutionIntent, "action" | "requireResourceId" | "viewport">,
  scope?: SearchableEntry,
): SearchableEntry | null {
  const action = intent.action === "long-press" ? "long-press" : "tap";
  let candidate: SearchableEntry | undefined = node;
  while (candidate) {
    if (
      hasVisibleBounds(candidate, intent) &&
      (!intent.requireResourceId || candidate.nativeId) &&
      hasActionAffordance(candidate, { action })
    ) {
      return candidate;
    }
    if (candidate === scope) {
      break;
    }
    candidate = candidate.parentIndex === undefined ? undefined : nodes[candidate.parentIndex];
  }
  return null;
}

export function semanticActionsForIntent(intent: ResolutionIntent): SearchableEntry["affordances"] {
  if (intent.action === "scroll") {
    return ["scroll"];
  }
  if (intent.action === "inspect") {
    return ["tap", "toggle"];
  }
  if (intent.action === "long-press") {
    return ["long-press"];
  }
  return intent.action === "input" || intent.action === "focus-input"
    ? ["input"]
    : ["tap", "scroll"];
}

/** Native editable fields and iOS accessibility text-field roles can own focus labels. */
export function isFocusEditableElement(element: Element): boolean {
  return isEditableElementProperties(element) || element.role === "textfield";
}

function containsBounds(container: ElementBounds, contained: ElementBounds): boolean {
  return (
    container.left <= contained.left &&
    container.top <= contained.top &&
    container.right >= contained.right &&
    container.bottom >= contained.bottom
  );
}

function hasActionAffordance(
  node: SearchableEntry,
  intent: Pick<ResolutionIntent, "action">,
): boolean {
  if (intent.action === "focus-input") {
    return isFocusEditableElement(node.properties);
  }
  if (intent.action === "long-press") {
    return node.affordances.some(
      (action) => action === "long-press" || action === "tap" || action === "toggle",
    );
  }
  return node.affordances.some(
    (action) => action === intent.action || (intent.action === "tap" && action === "toggle"),
  );
}

export function eligible(node: SearchableEntry, intent: ResolutionIntent): boolean {
  if (intent.requireResourceId && !node.nativeId) {
    return false;
  }
  if (intent.action === "inspect" && !intent.requireBounds) {
    return true;
  }
  if (!hasVisibleBounds(node, intent)) {
    return false;
  }
  if (intent.action === "inspect") {
    return true;
  }
  if (
    intent.action === "highlight" ||
    intent.action === "drag" ||
    intent.action === "accessibility-focus"
  ) {
    return true;
  }
  if (intent.action === "focus") {
    return node.focusable || node.affordances.includes("input");
  }
  return hasActionAffordance(node, intent);
}

export function promotableFocusAncestor(
  label: SearchableEntry,
  ancestor: SearchableEntry,
  intent: ResolutionIntent,
): boolean {
  return (
    !!label.bounds &&
    !!ancestor.bounds &&
    containsBounds(ancestor.bounds, label.bounds) &&
    eligible(ancestor, intent)
  );
}

/**
 * A node drawn wholly outside its nearest sized ancestor, or under an ancestor that
 * is, is parked out of sight — e.g. the iOS 26 `_UIFloatingTabBarItemView` copy UIKit
 * nests inside a compact tab bar button's image view, far from the button. Each node
 * is compared with its own nearest sized ancestor only, and window roots and scroll
 * containers never park a child: content merely scrolled past a viewport stays a
 * candidate exactly as before.
 */
function parkedOutOfSight(node: SearchableEntry, nodes: readonly SearchableEntry[]): boolean {
  const sized = (entry: SearchableEntry | undefined) =>
    entry?.bounds && boundsArea(entry.bounds) > 0 ? entry.bounds : undefined;
  const parentOf = (entry: SearchableEntry) =>
    entry.parentIndex === undefined ? undefined : nodes[entry.parentIndex];
  let current: SearchableEntry | undefined = node;
  while (current) {
    let ancestor = parentOf(current);
    while (ancestor && !sized(ancestor)) {
      ancestor = parentOf(ancestor);
    }
    const own = sized(current);
    const outer = sized(ancestor);
    if (
      own &&
      outer &&
      ancestor?.parentIndex !== undefined &&
      !ancestor.affordances.includes("scroll") &&
      !intersectBounds(own, outer)
    ) {
      return true;
    }
    current = ancestor;
  }
  return false;
}

/**
 * Prefer matches that can be seen: when some matches are parked out of sight and
 * others are not, drop the parked ones so a visible duplicate (the tab button that
 * carries the same label) wins. With no visible match, keep them all so the caller
 * still reports the matched element's missing tap area. Applied with and without
 * `index` so skeleton replay indexes and indexed selection count the same set.
 */
export function preferVisibleMatches(
  matches: ElementResolution["matches"],
  nodes: readonly SearchableEntry[],
): ElementResolution["matches"] {
  const visible = matches.filter(({ node }) => !parkedOutOfSight(node, nodes));
  return visible.length > 0 && visible.length < matches.length ? visible : matches;
}

/** Whether the selector names an element by identifier alone, with no text to match. */
export function isIdOnlySelector(selector: ResolverSelector): boolean {
  return (
    (selector.elementId !== undefined || selector.testTag !== undefined) &&
    selector.text === undefined &&
    selector.contentDescription === undefined
  );
}

/**
 * An iOS capture merges the in-app SDK snapshot into the XCUITest tree; SDK nodes no
 * XCUITest node matched are injected beside it. That snapshot can lag the screen (it
 * still held the pre-keyboard layout right after a focus tap, #10266), so a container
 * with an identifier shows up again as an SDK node at its old position. When XCUITest
 * captured a node with that identifier, the SDK copies are duplicates of it; drop them
 * so they cannot make the container ambiguous.
 */
export function preferCapturedContainerMatches<T extends { node: SearchableEntry }>(
  matches: T[],
): T[] {
  const captured = matches.filter(({ node }) => !isSdkInjectedNode(node.source));
  return captured.length > 0 && captured.length < matches.length ? captured : matches;
}

export function isWithin(
  node: SearchableEntry,
  ancestor: SearchableEntry,
  nodes: readonly SearchableEntry[],
): boolean {
  let parent = node.parentIndex;
  while (parent !== undefined) {
    if (parent === ancestor.index) {
      return true;
    }
    parent = nodes[parent]?.parentIndex;
  }
  return false;
}

export function containerSource(
  selector: ResolverSelector,
  resolution: ElementResolution,
): SearchableEntry | undefined {
  const sources = resolution.matches.find(({ node }) => node === resolution.chosen)?.sourceNodes;
  const query = selector.text ?? selector.contentDescription;
  if (query === undefined) {
    return sources?.[0];
  }
  const wanted = normalize(query, selector.caseSensitive);
  return (
    sources?.find((node) => {
      const values =
        selector.contentDescription === undefined
          ? Object.values(node.textSources)
          : [node.textSources["content-desc"]];
      return values.some((value) => {
        const actual = normalize(value ?? "", selector.caseSensitive);
        return resolution.matchMode === "contains" ? actual.includes(wanted) : actual === wanted;
      });
    }) ?? sources?.[0]
  );
}

function sameReferenceProof(node: SearchableEntry, ref: ElementReference): boolean {
  if (ref.bounds === undefined && ref.label === undefined) {
    return false;
  }
  const sameBounds =
    node.bounds && ref.bounds ? boundsEqual(node.bounds, ref.bounds) : node.bounds === ref.bounds;
  return sameBounds && node.label === ref.label && node.nativeId === ref.nativeId;
}

export function resolveReference(
  result: ElementResolution,
  snapshot: ResolverSnapshot,
  intent: ResolutionIntent,
): ElementResolution {
  const ref = intent.ref!;
  const matches = result.candidates.filter((node) => node.nodeKey === ref.nodeKey);
  const node = matches.length === 1 ? matches[0] : undefined;
  // A positional -k id is unsafe under reorder even when reference proof
  // succeeds: another peer can move into its ordinal. A ~text suffix follows
  // the same proof as a bare stable id, though its text can still change.
  const uniqueNativeId =
    node?.nativeId &&
    new Set(
      snapshot.nodes
        .filter((entry) => entry.nativeId === node.nativeId)
        .map((entry) => entry.source),
    ).size === 1;
  const valid =
    node &&
    (snapshot.id === ref.snapshotId ||
      ((!ordinalNodeKey.test(ref.nodeKey) || uniqueNativeId) && sameReferenceProof(node, ref)));
  if (!valid) {
    return { ...result, error: `Stale reference ${ref.nodeKey}; observe again before acting.` };
  }
  return {
    ...result,
    chosen: eligible(node, intent) ? node : null,
    indexInMatches: result.candidates.indexOf(node),
  };
}
