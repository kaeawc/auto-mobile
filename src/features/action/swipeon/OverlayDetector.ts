import {
  Element,
  SwipeDirection,
  SwipeOnOptions,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../models";
import type { ElementFinder } from "../../../utils/interfaces/ElementFinder";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import type { ElementParser } from "../../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../../utility/ElementParser";
import { SwipeInterval, OverlayCandidate, OverlayAnalyzer } from "./types";
import { boundsArea, boundsEqual, clamp } from "../../../utils/bounds";
import { isTruthyFlag, buildContainerFromElement } from "../../../utils/elementProperties";

export class OverlayDetector implements OverlayAnalyzer {
  private static readonly OVERLAY_PADDING = 8;
  private static readonly CANDIDATE_FRACTIONS = [0.5, 0.25, 0.75, 0.15, 0.85];

  constructor(
    private readonly finder: ElementFinder,
    private readonly geometry: ElementGeometry,
    private readonly elementParser: ElementParser,
  ) {}

  collectOverlayCandidates(
    viewHierarchy: ViewHierarchyResult,
    container: SwipeOnOptions["container"] | undefined,
    containerElement: Element,
  ): OverlayCandidate[] {
    const containerSelector = container ?? buildContainerFromElement(containerElement);
    if (!containerSelector) {
      return [];
    }

    const parser = new DefaultElementParser();

    const windowRootGroups = parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    const rootGroups =
      windowRootGroups.length > 0 ? windowRootGroups : [parser.extractRootNodes(viewHierarchy)];
    const totalWindows = Math.max(1, rootGroups.length);

    const overlays: OverlayCandidate[] = [];
    const seenNodes = new Set<ViewHierarchyNode>();
    const containerBounds = containerElement.bounds;

    // `containerElement` is whatever findTargetElement's own resolution
    // (ElementFinder.findElementByResourceId/findElementByText) already
    // selected for the swipe — an area-sorted pick among possibly several
    // same-selector matches. finder.findContainerNode() answers a different
    // question (the first traversal match, used elsewhere to scope nested
    // searches) and can name a different node than the one actually being
    // swiped when the selector is ambiguous. Anchoring ancestor-exemption to
    // that other node exempted the wrong element's ancestors while treating
    // the real target's ancestor as a full-cover overlay — reproducing the
    // exact "No unobstructed swipe area" fallback this file exists to avoid.
    // Resolving strictly against containerElement's own bounds (requiring a
    // unique match) anchors identity to the node actually being swiped.
    const containerNode = this.resolveSelectedContainerNode(
      rootGroups,
      parser,
      containerElement,
      containerBounds,
    );

    // The container's own ancestors are visited before the container in the
    // pre-order walk below and always geometrically contain it, so a
    // clickable/focusable parent (card, Compose root) used to be recorded as an
    // overlay covering the whole container, which left no safe swipe area and
    // forced the "No unobstructed swipe area" fallback (#6128). Ancestors are
    // never overlays — only siblings and other windows are.
    const containerAncestors = this.collectContainerAncestors(rootGroups, parser, containerNode);

    rootGroups.forEach((rootNodes, windowIndex) => {
      const windowRank = totalWindows - windowIndex;
      let nodeOrder = 0;

      for (const rootNode of rootNodes) {
        let insideContainer = false;
        let containerDepth = -1;

        parser.traverseNode(rootNode, (node: ViewHierarchyNode, depth: number) => {
          if (seenNodes.has(node)) {
            return;
          }

          seenNodes.add(node);
          const currentOrder = nodeOrder++;

          const nodeProperties = parser.extractNodeProperties(node);

          if (
            this.isContainerNode(
              node,
              nodeProperties,
              containerNode,
              containerElement,
              containerBounds,
            )
          ) {
            insideContainer = true;
            containerDepth = depth;
            return;
          }

          if (insideContainer && depth <= containerDepth) {
            insideContainer = false;
            containerDepth = -1;
          }

          if (insideContainer || containerAncestors.has(node)) {
            return;
          }

          if (!this.isClickableNode(nodeProperties)) {
            return;
          }

          const parsedNode = parser.parseNodeBounds(node);
          if (!parsedNode) {
            return;
          }

          const overlapBounds = this.intersectBounds(containerBounds, parsedNode.bounds);
          if (!overlapBounds) {
            return;
          }

          const coverage = boundsArea(overlapBounds);
          if (coverage <= 0) {
            return;
          }

          overlays.push({
            bounds: parsedNode.bounds,
            overlapBounds,
            coverage,
            zOrder: { windowRank, nodeOrder: currentOrder },
          });
        });
      }
    });

    return overlays;
  }

  computeSafeSwipeCoordinates(
    direction: SwipeDirection,
    bounds: Element["bounds"],
    overlayBounds: Element["bounds"][],
  ): { startX: number; startY: number; endX: number; endY: number; warning?: string } | null {
    const isVertical = direction === "up" || direction === "down";
    const primaryStart = isVertical ? bounds.top : bounds.left;
    const primaryEnd = isVertical ? bounds.bottom : bounds.right;
    const secondaryStart = isVertical ? bounds.left : bounds.top;
    const secondaryEnd = isVertical ? bounds.right : bounds.bottom;

    const candidates = this.buildCandidateCoordinates(secondaryStart, secondaryEnd);
    let bestCandidate: { coordinate: number; interval: SwipeInterval } | null = null;

    for (const coordinate of candidates) {
      const blocked = isVertical
        ? this.getBlockedIntervalsForX(overlayBounds, bounds, coordinate)
        : this.getBlockedIntervalsForY(overlayBounds, bounds, coordinate);

      const largestGap = this.findLargestGap(primaryStart, primaryEnd, blocked);
      if (!largestGap) {
        continue;
      }

      if (!bestCandidate || largestGap.length > bestCandidate.interval.length) {
        bestCandidate = { coordinate, interval: largestGap };
      }
    }

    if (!bestCandidate) {
      return null;
    }

    const safeBounds = isVertical
      ? {
          left: bounds.left,
          right: bounds.right,
          top: bestCandidate.interval.start,
          bottom: bestCandidate.interval.end,
        }
      : {
          left: bestCandidate.interval.start,
          right: bestCandidate.interval.end,
          top: bounds.top,
          bottom: bounds.bottom,
        };

    const swipe = this.geometry.getSwipeWithinBounds(direction, safeBounds);
    let { startX, startY, endX, endY } = swipe;

    if (isVertical) {
      startX = bestCandidate.coordinate;
      endX = bestCandidate.coordinate;
    } else {
      startY = bestCandidate.coordinate;
      endY = bestCandidate.coordinate;
    }

    startX = clamp(startX, safeBounds.left, safeBounds.right);
    endX = clamp(endX, safeBounds.left, safeBounds.right);
    startY = clamp(startY, safeBounds.top, safeBounds.bottom);
    endY = clamp(endY, safeBounds.top, safeBounds.bottom);

    const primaryLength = Math.max(1, primaryEnd - primaryStart);
    const minDistance = Math.max(50, primaryLength * 0.1);
    const warning =
      bestCandidate.interval.length < minDistance
        ? `Swipe area reduced by overlaying elements; safe ${isVertical ? "height" : "width"} is ${Math.round(bestCandidate.interval.length)}px.`
        : undefined;

    return { startX, startY, endX, endY, warning };
  }

  private getBlockedIntervalsForX(
    overlayBounds: Element["bounds"][],
    containerBounds: Element["bounds"],
    x: number,
  ): SwipeInterval[] {
    const intervals: SwipeInterval[] = [];
    for (const overlay of overlayBounds) {
      const expanded = this.expandBounds(overlay, OverlayDetector.OVERLAY_PADDING);
      if (x < expanded.left || x > expanded.right) {
        continue;
      }

      const start = Math.max(containerBounds.top, expanded.top);
      const end = Math.min(containerBounds.bottom, expanded.bottom);
      if (end > start) {
        intervals.push({ start, end, length: end - start });
      }
    }
    return intervals;
  }

  private getBlockedIntervalsForY(
    overlayBounds: Element["bounds"][],
    containerBounds: Element["bounds"],
    y: number,
  ): SwipeInterval[] {
    const intervals: SwipeInterval[] = [];
    for (const overlay of overlayBounds) {
      const expanded = this.expandBounds(overlay, OverlayDetector.OVERLAY_PADDING);
      if (y < expanded.top || y > expanded.bottom) {
        continue;
      }

      const start = Math.max(containerBounds.left, expanded.left);
      const end = Math.min(containerBounds.right, expanded.right);
      if (end > start) {
        intervals.push({ start, end, length: end - start });
      }
    }
    return intervals;
  }

  private findLargestGap(
    start: number,
    end: number,
    blockedIntervals: SwipeInterval[],
  ): SwipeInterval | null {
    const merged = this.mergeIntervals(blockedIntervals);
    let cursor = start;
    let best: SwipeInterval | null = null;

    for (const blocked of merged) {
      if (blocked.start > cursor) {
        const gap = { start: cursor, end: blocked.start, length: blocked.start - cursor };
        if (!best || gap.length > best.length) {
          best = gap;
        }
      }
      cursor = Math.max(cursor, blocked.end);
    }

    if (cursor < end) {
      const gap = { start: cursor, end, length: end - cursor };
      if (!best || gap.length > best.length) {
        best = gap;
      }
    }

    return best;
  }

  private mergeIntervals(intervals: SwipeInterval[]): SwipeInterval[] {
    const sorted = intervals
      .filter((interval) => interval.end > interval.start)
      .sort((a, b) => a.start - b.start);

    const merged: SwipeInterval[] = [];
    for (const interval of sorted) {
      const last = merged[merged.length - 1];
      if (!last || interval.start > last.end) {
        merged.push({ ...interval });
        continue;
      }
      last.end = Math.max(last.end, interval.end);
      last.length = last.end - last.start;
    }

    return merged;
  }

  private buildCandidateCoordinates(start: number, end: number): number[] {
    const size = end - start;
    if (size <= 0) {
      return [];
    }

    const candidates = OverlayDetector.CANDIDATE_FRACTIONS.map((fraction) =>
      Math.floor(start + size * fraction),
    );
    return Array.from(
      new Set(candidates.filter((candidate) => candidate >= start && candidate <= end)),
    );
  }

  private expandBounds(bounds: Element["bounds"], padding: number): Element["bounds"] {
    return {
      left: bounds.left - padding,
      top: bounds.top - padding,
      right: bounds.right + padding,
      bottom: bounds.bottom + padding,
    };
  }

  intersectBounds(a: Element["bounds"], b: Element["bounds"]): Element["bounds"] | null {
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);

    if (right <= left || bottom <= top) {
      return null;
    }

    return { left, top, right, bottom };
  }

  /**
   * Pre-order walk of the same root groups that records the ancestor chain of
   * the *specific* hierarchy node the finder resolved for the selected
   * container. Only strict object identity (`===`) anchors the walk: a
   * look-alike node elsewhere in the tree — same resource-id, text, or even
   * identical bounds — is still a distinct parsed object and can never match
   * by reference, so it can no longer donate its own clickable ancestors to
   * the skip set (the earlier resource-id/text/bounds heuristic could still
   * be fooled by such a look-alike sharing the real container's bounds).
   *
   * When the finder did not resolve a container node at all, there is no
   * identity to anchor the walk to, so this returns an empty skip set rather
   * than falling back to a selector guess. Missing a real ancestor here is
   * safe (worst case: a slightly smaller safe-swipe area); suppressing a
   * genuine overlay is not.
   */
  private collectContainerAncestors(
    rootGroups: ViewHierarchyNode[][],
    parser: DefaultElementParser,
    containerNode: ViewHierarchyNode | null,
  ): Set<ViewHierarchyNode> {
    const ancestors = new Set<ViewHierarchyNode>();
    if (!containerNode) {
      return ancestors;
    }

    // path[depth] is the node currently open at that depth of the pre-order walk.
    const path: ViewHierarchyNode[] = [];
    let found = false;

    for (const rootNodes of rootGroups) {
      for (const rootNode of rootNodes) {
        parser.traverseNode(rootNode, (node: ViewHierarchyNode, depth: number) => {
          if (found) {
            return;
          }
          path.length = depth;
          path[depth] = node;

          if (node === containerNode) {
            for (const ancestor of path.slice(0, depth)) {
              ancestors.add(ancestor);
            }
            found = true;
          }
        });
        if (found) {
          return ancestors;
        }
      }
    }

    return ancestors;
  }

  private isClickableNode(nodeProperties: Record<string, unknown>): boolean {
    return isTruthyFlag(nodeProperties.clickable) || isTruthyFlag(nodeProperties.focusable);
  }

  /**
   * Finds the single hierarchy node matching both the container selector
   * (resource-id / text / content-desc, or bounds alone when the selector
   * carries none of those) and the exact bounds of the already-selected
   * `containerElement` — i.e. the specific node findTargetElement's
   * area-sorted resolution picked, not merely "a" node sharing its selector.
   *
   * When more than one node satisfies both the selector and those exact
   * bounds, or none does, identity is ambiguous: callers (see
   * collectContainerAncestors) must treat that the same as "not found"
   * rather than guess, since guessing wrong donates a stranger's ancestors
   * to the skip set instead of the real target's.
   */
  private resolveSelectedContainerNode(
    rootGroups: ViewHierarchyNode[][],
    parser: DefaultElementParser,
    containerElement: Element,
    containerBounds: Element["bounds"],
  ): ViewHierarchyNode | null {
    let match: ViewHierarchyNode | null = null;
    let matchCount = 0;

    for (const rootNodes of rootGroups) {
      for (const rootNode of rootNodes) {
        parser.traverseNode(rootNode, (node: ViewHierarchyNode) => {
          const nodeProperties = parser.extractNodeProperties(node);
          if (
            !this.matchesContainerSelector(node, nodeProperties, containerElement, containerBounds)
          ) {
            return;
          }

          const parsedBounds = this.elementParser.parseBounds(node.bounds ?? nodeProperties.bounds);
          if (parsedBounds === null || !boundsEqual(parsedBounds, containerBounds)) {
            return;
          }

          matchCount++;
          match = node;
        });
      }
    }

    return matchCount === 1 ? match : null;
  }

  private isContainerNode(
    node: ViewHierarchyNode,
    nodeProperties: Record<string, unknown>,
    containerNode: ViewHierarchyNode | null,
    containerElement: Element,
    containerBounds: Element["bounds"],
  ): boolean {
    if (containerNode && node === containerNode) {
      return true;
    }

    return this.matchesContainerSelector(node, nodeProperties, containerElement, containerBounds);
  }

  private matchesContainerSelector(
    node: ViewHierarchyNode,
    nodeProperties: Record<string, unknown>,
    containerElement: Element,
    containerBounds: Element["bounds"],
  ): boolean {
    const resourceId = nodeProperties["resource-id"];
    if (containerElement["resource-id"] && resourceId === containerElement["resource-id"]) {
      return true;
    }

    const nodeText = nodeProperties.text;
    if (containerElement.text && nodeText === containerElement.text) {
      return true;
    }

    const nodeContentDesc = nodeProperties["content-desc"];
    if (containerElement["content-desc"] && nodeContentDesc === containerElement["content-desc"]) {
      return true;
    }

    if (
      !containerElement["resource-id"] &&
      !containerElement.text &&
      !containerElement["content-desc"]
    ) {
      const parsedBounds = this.elementParser.parseBounds(node.bounds ?? nodeProperties.bounds);
      if (parsedBounds && boundsEqual(parsedBounds, containerBounds)) {
        return true;
      }
    }

    return false;
  }
}
