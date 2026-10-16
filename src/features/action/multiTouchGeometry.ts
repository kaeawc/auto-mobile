import type { MultiTouchAction, MultiTouchOptions } from "../../models/MultiTouchOptions";
import type { SwipeDirection } from "../../models/SwipeOnOptions";
import { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "./gestureTransportTimeout";
import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../observe/shared/SharedGestureDelegate";

export const MULTI_TOUCH_MIN_FINGERS = 2;
export const MULTI_TOUCH_MAX_FINGERS = 5;
export const MULTI_TOUCH_DEFAULT_FINGERS = 2;

// The gesture request is bounded by the fixed 5000 ms transport timeout minus dispatch headroom.
export const MULTI_TOUCH_DURATION_MAX_MS =
  DEFAULT_GESTURE_REQUEST_TIMEOUT_MS - LONG_PRESS_TIMEOUT_HEADROOM_MS;
export const MULTI_TOUCH_TAP_DURATION_MS = 50;
export const MULTI_TOUCH_LONG_PRESS_MIN_MS = 500;
export const MULTI_TOUCH_LONG_PRESS_DEFAULT_MS = 1000;
export const MULTI_TOUCH_SWIPE_DURATION_DEFAULT_MS = 300;
export const MULTI_TOUCH_SPACING_MIN_PX = 10;
export const MULTI_TOUCH_SPACING_MAX_PX = 400;
/** Default travel as a fraction of the extent along the travel axis. */
export const MULTI_TOUCH_SWIPE_TRAVEL_FRACTION = 0.3;
/** A swipe squeezed below this many px by the screen edge is refused rather than sent. */
export const MULTI_TOUCH_MIN_TRAVEL_PX = 20;

export interface MultiTouchBounds {
  width: number;
  height: number;
}

export interface MultiTouchPlan {
  fingers: number;
  fingerSpacing: number;
  durationMs: number;
  /** Every finger's down point, left to right. */
  points: Array<{ x: number; y: number }>;
  /** The first finger's up point; the others share its offset from their down points. */
  end: { x: number; y: number };
  warning?: string;
}

export type MultiTouchPlanResult = MultiTouchPlan | { error: string };

export function defaultMultiTouchDuration(action: MultiTouchAction): number {
  switch (action) {
    case "tap":
      return MULTI_TOUCH_TAP_DURATION_MS;
    case "longPress":
      return MULTI_TOUCH_LONG_PRESS_DEFAULT_MS;
    default:
      return MULTI_TOUCH_SWIPE_DURATION_DEFAULT_MS;
  }
}

/** Default gap: 10% of the width, kept inside 40-160 px. */
export function defaultFingerSpacing(bounds: MultiTouchBounds): number {
  return Math.round(Math.min(160, Math.max(40, bounds.width * 0.1)));
}

/** Option checks that need no screen; shared by the schema and the action. */
export function validateMultiTouchOptions(
  options: Pick<
    MultiTouchOptions,
    "action" | "fingers" | "direction" | "distance" | "fingerSpacing" | "durationMs"
  >,
): string | null {
  const fingers = options.fingers ?? MULTI_TOUCH_DEFAULT_FINGERS;
  if (
    !Number.isInteger(fingers) ||
    fingers < MULTI_TOUCH_MIN_FINGERS ||
    fingers > MULTI_TOUCH_MAX_FINGERS
  ) {
    return `fingers must be an integer from ${MULTI_TOUCH_MIN_FINGERS} to ${MULTI_TOUCH_MAX_FINGERS}; use tapAt or swipeOn for one finger`;
  }
  if (options.action === "swipe" && options.direction === undefined) {
    return "direction is required for action swipe";
  }
  if (
    options.action !== "swipe" &&
    (options.direction !== undefined || options.distance !== undefined)
  ) {
    return "direction and distance are only valid with action swipe";
  }
  return validateMultiTouchNumbers(options);
}

function validateDurationMs(
  options: Pick<MultiTouchOptions, "action" | "durationMs">,
): string | null {
  const { durationMs } = options;
  if (durationMs === undefined) {
    return null;
  }
  if (options.action === "tap") {
    return "durationMs is not valid with action tap; use longPress to hold";
  }
  const min = options.action === "longPress" ? MULTI_TOUCH_LONG_PRESS_MIN_MS : 1;
  return Number.isInteger(durationMs) &&
    durationMs >= min &&
    durationMs <= MULTI_TOUCH_DURATION_MAX_MS
    ? null
    : `durationMs must be an integer from ${min} to ${MULTI_TOUCH_DURATION_MAX_MS} ms for ${options.action}`;
}

function validateMultiTouchNumbers(
  options: Pick<MultiTouchOptions, "action" | "distance" | "fingerSpacing" | "durationMs">,
): string | null {
  const { distance, fingerSpacing } = options;
  const durationError = validateDurationMs(options);
  if (durationError) {
    return durationError;
  }
  if (distance !== undefined && !(Number.isFinite(distance) && distance > 0)) {
    return "distance must be a positive finite number of px";
  }
  const spacingInRange =
    fingerSpacing === undefined ||
    (Number.isFinite(fingerSpacing) &&
      fingerSpacing >= MULTI_TOUCH_SPACING_MIN_PX &&
      fingerSpacing <= MULTI_TOUCH_SPACING_MAX_PX);
  return spacingInRange
    ? null
    : `fingerSpacing must be ${MULTI_TOUCH_SPACING_MIN_PX}-${MULTI_TOUCH_SPACING_MAX_PX} px`;
}

/**
 * Lays the fingers out in one horizontal row centered on `center`, shifting the whole row to stay
 * inside `bounds`, and for a swipe clamps the travel to the room left in the swipe direction so
 * every finger stays on screen. Native px in, native px out.
 */
export function planMultiTouch(
  options: Pick<
    MultiTouchOptions,
    "action" | "fingers" | "direction" | "distance" | "fingerSpacing" | "durationMs"
  >,
  center: { x: number; y: number },
  bounds: MultiTouchBounds,
): MultiTouchPlanResult {
  const invalid = validateMultiTouchOptions(options);
  if (invalid) {
    return { error: invalid };
  }
  const fingers = options.fingers ?? MULTI_TOUCH_DEFAULT_FINGERS;
  const fingerSpacing = Math.round(options.fingerSpacing ?? defaultFingerSpacing(bounds));
  const rowWidth = (fingers - 1) * fingerSpacing;
  if (rowWidth > bounds.width - 1) {
    return {
      error: `${fingers} fingers at ${fingerSpacing} px spacing need ${rowWidth} px but the screen is ${bounds.width} px wide; reduce fingers or fingerSpacing`,
    };
  }
  const maxX = bounds.width - 1;
  const maxY = bounds.height - 1;
  const firstX = Math.min(maxX - rowWidth, Math.max(0, Math.round(center.x - rowWidth / 2)));
  const y = Math.min(maxY, Math.max(0, Math.round(center.y)));
  const points = Array.from({ length: fingers }, (_, index) => ({
    x: firstX + index * fingerSpacing,
    y,
  }));
  const durationMs = options.durationMs ?? defaultMultiTouchDuration(options.action);
  const base = { fingers, fingerSpacing, durationMs, points };
  if (options.action !== "swipe") {
    return { ...base, end: { ...points[0] } };
  }
  return planSwipeTravel(options, base, { maxX, maxY });
}

function travelRoom(
  direction: SwipeDirection,
  points: MultiTouchPlan["points"],
  limits: { maxX: number; maxY: number },
): number {
  const first = points[0];
  const last = points[points.length - 1];
  switch (direction) {
    case "right":
      return limits.maxX - last.x;
    case "left":
      return first.x;
    case "down":
      return limits.maxY - first.y;
    default:
      return first.y;
  }
}

function planSwipeTravel(
  options: Pick<MultiTouchOptions, "direction" | "distance">,
  base: Omit<MultiTouchPlan, "end">,
  limits: { maxX: number; maxY: number },
): MultiTouchPlanResult {
  const direction = options.direction as SwipeDirection;
  const horizontal = direction === "left" || direction === "right";
  const room = travelRoom(direction, base.points, limits);
  const requested = Math.round(
    options.distance ??
      (horizontal ? limits.maxX : limits.maxY) * MULTI_TOUCH_SWIPE_TRAVEL_FRACTION,
  );
  const travel = Math.min(requested, room);
  if (travel < MULTI_TOUCH_MIN_TRAVEL_PX) {
    return {
      error: `Only ${Math.max(0, room)} px remain ${direction}ward of the fingers; start the swipe farther from that edge`,
    };
  }
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const first = base.points[0];
  return {
    ...base,
    end: horizontal
      ? { x: first.x + sign * travel, y: first.y }
      : { x: first.x, y: first.y + sign * travel },
    warning:
      travel < requested
        ? `Swipe distance clamped from ${requested} to ${travel} px to keep every finger on screen`
        : undefined,
  };
}
