import type { Element, ObserveResult, ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementBounds } from "../../models";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { getHierarchySnapshot } from "../observe/HierarchyCapture";
import type { OwnPrototypeCoverRule } from "../observe/ApplicationWindowCover";
import { boundsEqual } from "../../utils/bounds";
import type { SearchableEntry } from "../utility/SearchableNode";

/** Tap-target helpers shared by TapOnElement and its tap-point planner (#11833). */

export type TapFocusFailure = "not-found" | "no-visible-tap-area" | "navigation-bar";

export function pointInTapBounds(point: { x: number; y: number }, bounds: ElementBounds): boolean {
  return (
    point.x >= bounds.left &&
    point.x < bounds.right &&
    point.y >= bounds.top &&
    point.y < bounds.bottom
  );
}

export function hasTapArea(bounds: ElementBounds | undefined): bounds is ElementBounds {
  return !!bounds && bounds.left < bounds.right && bounds.top < bounds.bottom;
}

export interface TapPointContext {
  chromeElements?: readonly Element[];
  options: TapOnElementOptions;
  screenSize?: ObserveResult["screenSize"];
}

/** Prefer the exact parsed node when geometry and public IDs collide across windows. */
export function findTapTargetNode(
  nodes: readonly SearchableEntry[],
  element: Element,
): SearchableEntry | undefined {
  const source = getHierarchyNodeSource(element);
  return (
    (source && nodes.find((node) => node.source === source)) ??
    nodes.find(
      (node) =>
        node.element &&
        node.bounds &&
        boundsEqual(node.bounds, element.bounds) &&
        node.nativeId === element["resource-id"] &&
        node.nodeKey === element["view-id"],
    )
  );
}

/**
 * The tree `element` was selected from, so the IME guard can recover its ancestry by
 * source identity. Unscoped iOS selection reads the registered capture's projected
 * tree; a `layer`-scoped selection projects an unregistered tree that keeps the
 * original capture's nodes (`scopeHierarchyToLayer`), so fall back to the original.
 */
export function selectionHierarchyFor(
  element: Element,
  hierarchy: ViewHierarchyResult,
  platform: "android" | "ios",
): ViewHierarchyResult {
  const snapshot = platform === "ios" ? getHierarchySnapshot(hierarchy) : undefined;
  const source = getHierarchyNodeSource(element);
  return snapshot && (!source || snapshot.nodes.some((node) => node.source === source))
    ? snapshot.hierarchy
    : hierarchy;
}

/** With no `layer`, a tap must avoid AutoMobile's own prototype windows as well (#10691). */
export function tapOwnPrototypeCoverRule(
  layer: TapOnElementOptions["layer"],
): OwnPrototypeCoverRule {
  return layer === undefined ? "touch" : "none";
}

export class TapTargetUnavailableError extends ActionableError {
  constructor(
    message: string,
    readonly reason: TapFocusFailure,
  ) {
    super(message);
  }
}
