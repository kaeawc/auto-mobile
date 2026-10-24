import type { ViewHierarchyResult, ElementBounds } from "../../../models";
import type { ObservationEdgeInsets } from "../../../models/ObservationInsets";
import type { ScreenSize } from "../../../models/ScreenSize";
import { screenSizeForOffscreenCheck } from "../../utility/ElementGeometry";
import { SearchableHierarchy, type SearchableEntry } from "../../utility/SearchableNode";
import { isIosKeyboardClass } from "../../observe/ios/IosScreenIdentity";
import { projectIosChromeFrames, visibleChromeNode } from "./iosChromeFrames";

const controls = new Set([
  "UIButton",
  "UITextField",
  "UISearchBar",
  "UISearchTextField",
  "XCUIElementTypeButton",
  "XCUIElementTypeTextField",
  "XCUIElementTypeSearchField",
]);

function excludedAncestry(
  node: SearchableEntry,
  nodes: readonly SearchableEntry[],
  bottomBarNodes: ReadonlySet<SearchableEntry>,
): boolean {
  for (
    let current: SearchableEntry | undefined = node;
    current;
    current = current.parentIndex === undefined ? undefined : nodes[current.parentIndex]
  ) {
    if (
      // Existing bar controls are already accounted for by chrome insets.
      bottomBarNodes.has(current) ||
      current.inputMethod ||
      isIosKeyboardClass(current.className) ||
      /Keyboard|InputSet/.test(current.className ?? "")
    ) {
      return true;
    }
    if (current !== node && current.categories.scrollable) {
      return true;
    }
  }
  return false;
}

function bottomBandBounds(
  bounds: ElementBounds | undefined,
  screen: ScreenSize,
): bounds is ElementBounds {
  return (
    !!bounds &&
    Object.values(bounds).every(Number.isFinite) &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top &&
    bounds.right > 0 &&
    bounds.left < screen.width &&
    bounds.top >= screen.height * 0.8 &&
    bounds.bottom <= screen.height
  );
}

/** A row qualifies only when at least three controls share a horizontal line. */
function floatingRowInset(bounds: readonly ElementBounds[], screen: ScreenSize): number {
  let inset = 0;
  for (const anchor of bounds) {
    const row = bounds.filter(
      (control) => control.top <= anchor.top && control.bottom >= anchor.top,
    );
    if (row.length >= 3) {
      inset = Math.max(inset, screen.height - Math.min(...row.map((control) => control.top)));
    }
  }
  return inset;
}

/** Reserve swipe space above iOS 26 Safari's capsule controls (#15135), without changing tap clipping. */
export function deriveIosFloatingBarInsets(
  hierarchy: ViewHierarchyResult | undefined,
  options: { observationScreenSize?: ScreenSize } = {},
): ObservationEdgeInsets {
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!hierarchy) {
    return insets;
  }
  const screen = screenSizeForOffscreenCheck(hierarchy, { platform: "ios", ...options });
  if (!screen) {
    return insets;
  }
  const nodes = new SearchableHierarchy().project(hierarchy);
  const bottomBars = projectIosChromeFrames(nodes, screen).filter(
    (frame) => frame.region === "bottom toolbar or tab bar",
  );
  const bottomBarNodes = new Set(bottomBars.map((bar) => bar.node));
  const candidates: ElementBounds[] = [];
  for (const node of nodes) {
    const bounds = node.bounds;
    if (
      controls.has(node.className ?? "") &&
      visibleChromeNode(node) &&
      bottomBandBounds(bounds, screen) &&
      !excludedAncestry(node, nodes, bottomBarNodes) &&
      !bottomBars.some((bar) => bounds.bottom <= bar.bounds.top + 1)
    ) {
      candidates.push(bounds);
    }
  }
  insets.bottom = floatingRowInset(candidates, screen);
  return insets;
}
