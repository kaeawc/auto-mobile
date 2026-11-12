import type { Element, ObserveResult, SwipeDirection } from "../../../models";
import { boundsEqual, intersectBounds } from "../../../utils/bounds";
import { SearchableHierarchy, type SearchableEntry } from "../../utility/SearchableNode";
import { HOLD_DURATION_MIN_MS } from "../DragAndDrop";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { throwIfAborted } from "../../../utils/toolUtils";

export const LOOK_FOR_HOLD_MS = HOLD_DURATION_MIN_MS;
export const LOOK_FOR_MAX_BACK_SCROLLS = 3;
/** Require four non-duplicated identities in each page: a 75% step retains about one of four rows.
 * Sparse or ambiguous pages cannot provide meaningful zero-overlap evidence. */
export const LOOK_FOR_MIN_DISTINCT_KEYS = 4;
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

/** Keyed descendants of the observed container, in hierarchy order. */
function containerItems(
  observation: ObserveResult,
  container: Element,
): Array<{ key: string; bounds: SearchableEntry["bounds"]; value?: string }> {
  if (!observation.viewHierarchy) {
    return [];
  }
  const nodes = searchable.project(observation.viewHierarchy);
  const root = nodes.find(
    (node) =>
      node.element &&
      node.element["resource-id"] === container["resource-id"] &&
      boundsEqual(node.element.bounds, container.bounds),
  );
  const descendants = new Set<number>();
  const items: Array<{ key: string; bounds: SearchableEntry["bounds"]; value?: string }> = [];
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
    if (key) {
      items.push({ key, bounds: node.bounds, value: node.textSources.value });
    }
  }
  return items;
}

/** Bounds-independent child identities, scoped through the existing hierarchy projection. */
export function visibleScrollKeys(
  observation: ObserveResult,
  container: Element,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { key } of containerItems(observation, container)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Keep repeated identities: shared presence still establishes overlap.
  return counts;
}

/**
 * The container's visible items with their positions; `""` when it has none.
 * Equal signatures mean the list did not scroll, even when chrome outside the
 * container (a clock, an edge indicator) changed the whole-screen fingerprint.
 * Editable values count: a virtualized form can reuse ids, placeholders and
 * bounds while scrolling different values.
 */
export function containerContentSignature(observation: ObserveResult, container: Element): string {
  const items = containerItems(observation, container);
  return items.length === 0
    ? ""
    : JSON.stringify(items.map(({ key, bounds, value }) => [key, bounds, value ?? null]));
}

export interface ContainerContent {
  container: Element;
  signature: string;
}

/**
 * Items left in place mean the list did not move, even when chrome outside the
 * container changed the whole-screen fingerprint at a list edge (#18034).
 */
export function itemsStayed(previous: ContainerContent, observation: ObserveResult): boolean {
  return (
    previous.signature !== "" &&
    containerContentSignature(observation, previous.container) === previous.signature
  );
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

/** Exclude identities duplicated in either page only when assessing evidence density. */
function hasEnoughDistinctKeys(
  previous: Map<string, number>,
  current: Map<string, number>,
): boolean {
  const distinctCount = (page: Map<string, number>, other: Map<string, number>) =>
    [...page].filter(([key, count]) => count === 1 && (other.get(key) ?? 0) <= 1).length;
  return (
    distinctCount(previous, current) >= LOOK_FOR_MIN_DISTINCT_KEYS &&
    distinctCount(current, previous) >= LOOK_FOR_MIN_DISTINCT_KEYS
  );
}

export async function recoverLookForOverlap(options: {
  previousKeys: Map<string, number>;
  observation: ObserveResult;
  keys: (observation: ObserveResult) => Promise<Map<string, number>>;
  backScroll: (observation: ObserveResult) => Promise<ObserveResult>;
  hasTarget?: (observation: ObserveResult) => Promise<boolean>;
  timer: Timer;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ObserveResult> {
  let observation = options.observation;
  const currentKeys = await options.keys(observation);
  if (!hasEnoughDistinctKeys(options.previousKeys, currentKeys)) {
    return observation;
  }
  for (let attempts = 0; ; attempts++) {
    throwIfAborted(options.signal);
    // Every recovered page is searched before deciding to discard it or move again.
    if (attempts > 0 && (await options.hasTarget?.(observation))) {
      return observation;
    }
    const keys = attempts === 0 ? currentKeys : await options.keys(observation);
    if ([...keys.keys()].some((key) => options.previousKeys.has(key))) {
      return observation;
    }
    if (!hasEnoughDistinctKeys(options.previousKeys, keys)) {
      // Sparse recovered pages cannot prove overshoot; the bounded forward search remains safe.
      logger.debug("[SwipeOn] Recovery overlap evidence is sparse; continuing forward");
      return observation;
    }
    if (attempts >= LOOK_FOR_MAX_BACK_SCROLLS || options.timer.now() >= options.deadline) {
      // Overlap is heuristic; ordinary forward search remains bounded by the search deadline.
      logger.debug(
        `[SwipeOn] Overlap not restored after ${attempts} back-scrolls; continuing forward`,
      );
      return observation;
    }
    logger.debug(
      `[SwipeOn] Zero visible child overlap; back-scroll ${attempts + 1}/${LOOK_FOR_MAX_BACK_SCROLLS}`,
    );
    observation = await options.backScroll(observation);
  }
}
