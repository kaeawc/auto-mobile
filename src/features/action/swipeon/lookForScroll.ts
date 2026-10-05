import type { Element, ObserveResult, SwipeDirection } from "../../../models";
import { ActionableError } from "../../../models";
import { boundsEqual, intersectBounds } from "../../../utils/bounds";
import { SearchableHierarchy, type SearchableEntry } from "../../utility/SearchableNode";
import { HOLD_DURATION_MIN_MS } from "../DragAndDrop";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { throwIfAborted } from "../../../utils/toolUtils";

export const LOOK_FOR_HOLD_MS = HOLD_DURATION_MIN_MS;
export const LOOK_FOR_MAX_BACK_SCROLLS = 3;
const searchable = new SearchableHierarchy();
type Coordinates = { startX: number; startY: number; endX: number; endY: number };

/** Keep 25% of the viewport for the next search; preserve the overlay-safe segment. */
export function capLookForTravel(coordinates: Coordinates, bounds: Element["bounds"]): Coordinates {
  const dx = coordinates.endX - coordinates.startX;
  const dy = coordinates.endY - coordinates.startY;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const viewport = horizontal ? bounds.right - bounds.left : bounds.bottom - bounds.top;
  const distance = Math.hypot(dx, dy);
  const scale = distance > 0 ? Math.min(1, Math.floor(viewport * 0.75) / distance) : 1;
  return {
    ...coordinates,
    endX: Math.round(coordinates.startX + dx * scale),
    endY: Math.round(coordinates.startY + dy * scale),
  };
}

export function oppositeDirection(direction: SwipeDirection): SwipeDirection {
  const opposite: Record<SwipeDirection, SwipeDirection> = {
    up: "down",
    down: "up",
    left: "right",
    right: "left",
  };
  return opposite[direction];
}

/** Bounds-independent child identities, scoped through the existing hierarchy projection. */
export function visibleScrollKeys(observation: ObserveResult, container: Element): Set<string> {
  if (!observation.viewHierarchy) {
    return new Set();
  }
  const nodes = searchable.project(observation.viewHierarchy);
  const root = nodes.find(
    (node) =>
      node.element &&
      node.element["resource-id"] === container["resource-id"] &&
      boundsEqual(node.element.bounds, container.bounds),
  );
  const descendants = new Set<number>();
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node === root) {
      descendants.add(node.index);
      continue;
    }
    if (!root || node.parentIndex === undefined || !descendants.has(node.parentIndex)) {
      continue;
    }
    descendants.add(node.index);
    const key = scrollItemKey(node, container.bounds);
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Recycled row ids without labels cannot identify an item; duplicates are ambiguous.
  return new Set([...counts].filter(([, count]) => count === 1).map(([key]) => key));
}

function scrollItemKey(node: SearchableEntry, viewport: Element["bounds"]): string | undefined {
  if (!node.bounds || node.categories.scrollable || !intersectBounds(node.bounds, viewport)) {
    return;
  }
  if (
    [node.properties.visible, node.properties["visible-to-user"]].some(
      (value) => value === false || value === "false",
    )
  ) {
    return;
  }
  const {
    text,
    "content-desc": description,
    "ios-accessibility-label": iosLabel,
  } = node.textSources;
  if (!text && !description && !iosLabel && !node.nativeId) {
    return;
  }
  return JSON.stringify([node.nativeId, text, description, iosLabel]);
}

export async function recoverLookForOverlap(options: {
  previousKeys: Set<string>;
  observation: ObserveResult;
  keys: (observation: ObserveResult) => Promise<Set<string>>;
  backScroll: (observation: ObserveResult) => Promise<ObserveResult>;
  timer: Timer;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ObserveResult> {
  let observation = options.observation;
  if (options.previousKeys.size === 0) {
    return observation;
  }
  for (let attempts = 0; ; attempts++) {
    throwIfAborted(options.signal);
    const keys = await options.keys(observation);
    if ([...keys].some((key) => options.previousKeys.has(key))) {
      return observation;
    }
    if (attempts >= LOOK_FOR_MAX_BACK_SCROLLS || options.timer.now() >= options.deadline) {
      throw new ActionableError(
        `Scroll overshoot: could not restore visible content overlap after ${attempts} back-scrolls. Retry with a smaller container.`,
      );
    }
    logger.warn(
      `[SwipeOn] Zero visible child overlap; back-scroll ${attempts + 1}/${LOOK_FOR_MAX_BACK_SCROLLS}`,
    );
    observation = await options.backScroll(observation);
  }
}
