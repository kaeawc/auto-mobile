import type { SwipeResult } from "../../../models";
import type { FencedGestureOptions } from "../ExecuteGesture";

// Honest reporting for routes that cannot realise a requested swipe stroke duration (#12987).

/** Runner clamp in `GesturePerformer.swipeVelocity` (ios/control-proxy), in points per second. */
export const IOS_COORDINATE_SWIPE_VELOCITY_MIN_PT_S = 100;
export const IOS_COORDINATE_SWIPE_VELOCITY_MAX_PT_S = 10_000;

/** The unpinned synthesized-event route floors the stroke at 50ms instead of clamping velocity. */
export const IOS_SYNTHESIZED_SWIPE_MIN_MS = 50;

export interface ClampedSwipeDuration {
  effectiveDurationMs: number;
  warning: string;
}

/**
 * The stroke duration the iOS XCUICoordinate route really runs: the runner turns distance and
 * duration into a velocity clamped to 100-10000 pt/s. Undefined when the clamp does not change the
 * duration (within rounding) or the request has no usable distance.
 */
export function clampedIosCoordinateSwipeDuration(
  distancePt: number,
  durationMs: number,
): ClampedSwipeDuration | undefined {
  if (!Number.isFinite(distancePt) || !Number.isFinite(durationMs)) {
    return undefined;
  }
  if (distancePt <= 0 || durationMs <= 0) {
    return undefined;
  }
  const requestedVelocity = distancePt / (durationMs / 1000);
  const velocity = Math.min(
    Math.max(requestedVelocity, IOS_COORDINATE_SWIPE_VELOCITY_MIN_PT_S),
    IOS_COORDINATE_SWIPE_VELOCITY_MAX_PT_S,
  );
  const effectiveDurationMs = Math.round((distancePt / velocity) * 1000);
  if (Math.abs(effectiveDurationMs - durationMs) <= 1) {
    return undefined;
  }
  return {
    effectiveDurationMs,
    warning:
      `durationMs ${durationMs} was clamped on the iOS XCUICoordinate swipe route: velocity is ` +
      `limited to ${IOS_COORDINATE_SWIPE_VELOCITY_MIN_PT_S}-${IOS_COORDINATE_SWIPE_VELOCITY_MAX_PT_S} pt/s, ` +
      `so this ${Math.round(distancePt)} pt swipe ran for about ${effectiveDurationMs} ms ` +
      `(effectiveDurationMs). The unpinned synthesized route honours the duration down to ` +
      `${IOS_SYNTHESIZED_SWIPE_MIN_MS} ms.`,
  };
}

export const TALKBACK_SEMANTIC_SCROLL_DURATION_WARNING =
  "durationMs was ignored: the TalkBack semantic scroll route (ACTION_SCROLL on the container) " +
  "performs a discrete scroll with no timed stroke, so the reported duration is a nominal value. " +
  "Use a container without a stable selector, or turn TalkBack off, to get a timed swipe.";

/** A successful TalkBack semantic scroll: `duration` is nominal, and flagged when it was requested. */
export function semanticScrollSuccess(
  coords: Pick<SwipeResult, "x1" | "y1" | "x2" | "y2">,
  gestureOptions: Pick<FencedGestureOptions, "duration" | "durationExplicit"> | undefined,
): SwipeResult {
  return {
    success: true,
    ...coords,
    duration: gestureOptions?.duration || 300,
    durationIgnored: true,
    ...(gestureOptions?.durationExplicit
      ? { warnings: [TALKBACK_SEMANTIC_SCROLL_DURATION_WARNING] }
      : {}),
  };
}

/** `true` only when the caller passed durationMs; undefined keeps speed-preset options unchanged. */
export function explicitDuration(options: { durationMs?: number }): true | undefined {
  return options.durationMs === undefined ? undefined : true;
}

/** Adds the straight-line velocity of a successful swipe so the fling can be reproduced (#12538). */
export function withVelocity<T extends SwipeResult>(
  result: T,
  from: { x: number; y: number },
  to: { x: number; y: number },
  duration: number,
): T {
  if (duration <= 0) {
    return result;
  }
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return { ...result, velocityPxPerSecond: Math.round((distance / duration) * 1000) };
}

/**
 * swipeOn's velocity (#12968): distance over the duration the route really dispatched
 * (`effectiveDurationMs` when the iOS runner clamped it). Omitted when the route ignored the
 * duration (TalkBack semantic scroll), for a boomerang (`duration` is both legs plus the pause)
 * and for a `lookFor` search (many swipes), where no single fling exists to reproduce.
 */
export function withSwipeOnVelocity<
  T extends Pick<SwipeResult, "success" | "x1" | "y1" | "x2" | "y2" | "duration"> & {
    durationIgnored?: boolean;
    effectiveDurationMs?: number;
  },
>(result: T, options: { boomerang?: unknown; lookFor?: unknown }): T {
  if (!result.success || result.durationIgnored || options.boomerang || options.lookFor) {
    return result;
  }
  const coordinates = [result.x1, result.y1, result.x2, result.y2];
  if (!coordinates.every(Number.isFinite)) {
    return result;
  }
  return withVelocity(
    result,
    { x: result.x1, y: result.y1 },
    { x: result.x2, y: result.y2 },
    result.effectiveDurationMs ?? result.duration,
  );
}
