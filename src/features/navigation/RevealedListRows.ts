/**
 * Rows explore's D-pad list advances revealed (#17246), so the walk to a card revealed in a
 * horizontal rail is recorded along the rail and replays from the rail's initial viewport.
 */

import type { Element, ObserveResult } from "../../models";
import type { ElementBounds } from "../../models/ElementBounds";
import { boundsEqual } from "../../utils/bounds";
import type { FocusNavigateDirection } from "../action/FocusNavigate";
import {
  centreInside,
  rowIdentity,
  type FocusListAdvanceDirection,
} from "../action/FocusListAdvance";
import { findFocusedElement } from "../observe/HierarchyFocus";

/** Rows a D-pad advance revealed in one list, by their {@link rowIdentity}. */
interface RevealedRows {
  container: ElementBounds;
  direction: FocusListAdvanceDirection;
  rows: Set<string>;
}

function centreX(bounds: ElementBounds): number {
  return (bounds.left + bounds.right) / 2;
}

/**
 * The rows explore's D-pad list advances revealed during one exploration, by list, so the walk to
 * a card revealed in a horizontal rail is recorded along the rail (#17246).
 */
export class RevealedListRows {
  private readonly lists: RevealedRows[] = [];

  clear(): void {
    this.lists.length = 0;
  }

  remember(
    container: ElementBounds,
    direction: FocusListAdvanceDirection,
    rows: readonly string[],
  ): void {
    const same = this.lists.find(
      (entry) => entry.direction === direction && boundsEqual(entry.container, container),
    );
    if (same) {
      same.rows = new Set([...same.rows, ...rows]);
      return;
    }
    this.lists.push({ container, direction, rows: new Set(rows) });
  }

  /**
   * The direction to record on the walk to `element`: the rail's advance direction when an advance
   * revealed it in a horizontal rail, so navigateTo replays the walk along the rail from the rail's
   * initial viewport, where the card is not on screen and the default absent-target scan would
   * press down. Undefined for a row of a vertical list (that scan already presses down), and when
   * focus is not in the rail on the near side of the card, where pressing along the rail would not
   * reach it on this walk.
   */
  railDirectionFor(
    element: Element,
    observation: ObserveResult,
  ): FocusNavigateDirection | undefined {
    const identity = rowIdentity(element);
    const rail = this.lists.find(
      (entry) =>
        entry.direction !== "down" &&
        identity !== null &&
        entry.rows.has(identity) &&
        centreInside(element.bounds, entry.container),
    );
    if (!rail) {
      return undefined;
    }
    const focused =
      observation.focusedElement ??
      (observation.viewHierarchy ? findFocusedElement(observation.viewHierarchy) : null);
    if (!focused || !centreInside(focused.bounds, rail.container)) {
      return undefined;
    }
    return centreX(element.bounds) >= centreX(focused.bounds) ? rail.direction : undefined;
  }
}
