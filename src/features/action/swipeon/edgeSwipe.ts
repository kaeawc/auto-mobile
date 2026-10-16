import type { Element, SwipeDirection, SwipeEdge, SwipeOnOptions } from "../../../models";

/** Default distance in px (points on iOS) the touch starts inside the edge. */
export const EDGE_INSET_DEFAULT = 4;
export const EDGE_INSET_MAX = 50;
/** Default position along the edge (0 = start of the edge, 1 = end). */
export const EDGE_AT_DEFAULT = 0.5;
/** Fraction of the perpendicular extent an edge swipe travels inward. */
export const EDGE_SWIPE_TRAVEL_FRACTION = 0.7;

/** The finger direction that moves away from each edge. */
export const EDGE_INWARD_DIRECTION: Record<SwipeEdge, SwipeDirection> = {
  left: "right",
  right: "left",
  top: "down",
  bottom: "up",
};

type EdgeOptions = Pick<
  SwipeOnOptions,
  "fromEdge" | "edgeInset" | "at" | "container" | "lookFor" | "autoTarget" | "direction"
>;

function validateEdgeRanges(options: Pick<SwipeOnOptions, "edgeInset" | "at">): string | null {
  const { edgeInset, at } = options;
  if (
    edgeInset !== undefined &&
    (!Number.isInteger(edgeInset) || edgeInset < 0 || edgeInset > EDGE_INSET_MAX)
  ) {
    return `edgeInset must be an integer from 0 to ${EDGE_INSET_MAX}`;
  }
  if (at !== undefined && !(Number.isFinite(at) && at >= 0 && at <= 1)) {
    return "at must be a finite number from 0 to 1";
  }
  return null;
}

/** Reject unsafe edge options before anything is dispatched. */
export function validateEdgeSwipeOptions(options: EdgeOptions): string | null {
  if (options.fromEdge === undefined) {
    return options.edgeInset !== undefined || options.at !== undefined
      ? "edgeInset/at require fromEdge"
      : null;
  }
  if (options.container || options.lookFor || options.autoTarget === true) {
    return "fromEdge swipes the screen or panel edge; it cannot be combined with container, lookFor, or autoTarget=true";
  }
  const rangeError = validateEdgeRanges(options);
  if (rangeError) {
    return rangeError;
  }
  const inward = EDGE_INWARD_DIRECTION[options.fromEdge];
  if (options.direction !== inward) {
    return `fromEdge "${options.fromEdge}" swipes inward, so the finger direction must be "${inward}"`;
  }
  return null;
}

/** Start point at the edge plus an inward end point, inside `bounds`. */
export function edgeSwipeCoordinates(input: {
  edge: SwipeEdge;
  bounds: Element["bounds"];
  inset?: number;
  at?: number;
}): { x1: number; y1: number; x2: number; y2: number } {
  const { edge, bounds } = input;
  const inset = input.inset ?? EDGE_INSET_DEFAULT;
  const at = input.at ?? EDGE_AT_DEFAULT;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
  const alongX = clamp(Math.round(bounds.left + at * width), bounds.left, bounds.right - 1);
  const alongY = clamp(Math.round(bounds.top + at * height), bounds.top, bounds.bottom - 1);
  const travelX = Math.round(width * EDGE_SWIPE_TRAVEL_FRACTION);
  const travelY = Math.round(height * EDGE_SWIPE_TRAVEL_FRACTION);
  switch (edge) {
    case "left":
      return { x1: bounds.left + inset, y1: alongY, x2: bounds.left + inset + travelX, y2: alongY };
    case "right":
      return {
        x1: bounds.right - 1 - inset,
        y1: alongY,
        x2: bounds.right - 1 - inset - travelX,
        y2: alongY,
      };
    case "top":
      return { x1: alongX, y1: bounds.top + inset, x2: alongX, y2: bounds.top + inset + travelY };
    case "bottom":
      return {
        x1: alongX,
        y1: bounds.bottom - 1 - inset,
        x2: alongX,
        y2: bounds.bottom - 1 - inset - travelY,
      };
  }
}
