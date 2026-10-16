import { ActionableError } from "../../models/ActionableError";
import type { DragPathOptions } from "../../models/DragPathOptions";
import type { ObserveResult } from "../../models/ObserveResult";
import type { BootedDevice } from "../../models";
import { resolveTapAtCoordinates } from "./TapAtCoordinate";
import { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "./gestureTransportTimeout";

export const DRAG_PATH_MIN_POINTS = 2;
export const DRAG_PATH_MAX_POINTS = 100;
/** Time spent travelling a segment when a point gives no `durationMs`. */
export const DRAG_PATH_DEFAULT_SEGMENT_MS = 200;
export const DRAG_PATH_SEGMENT_MIN_MS = 1;
export const DRAG_PATH_SEGMENT_MAX_MS = 5000;
export const DRAG_PATH_HOLD_MAX_MS = 3000;
/** Hard ceiling on finger-down time so a call always fits a request budget. */
export const DRAG_PATH_MAX_TOTAL_MS = 20_000;
/** A move frame is sent at most this far apart, so the runner tracks a smooth path. */
export const DRAG_PATH_MOVE_INTERVAL_MS = 50;

export interface DragPathStep {
  /** Offset in ms from the end of the initial hold, when this move should be sent. */
  atMs: number;
  x: number;
  y: number;
}

export interface DragPathPlan {
  start: { x: number; y: number };
  holdMs: number;
  moves: DragPathStep[];
  releaseHoldMs: number;
  /** Finger-down time: hold + travel + release hold. */
  totalMs: number;
  /** Native vertices of the polyline. */
  vertices: Array<{ x: number; y: number }>;
}

/** Resolve every requested point to a native in-bounds point, or report the first failure. */
export function resolveDragPathPoints(
  options: DragPathOptions,
  observation: ObserveResult,
  platform: BootedDevice["platform"],
): { points: Array<{ x: number; y: number }> } | { error: string } {
  const points: Array<{ x: number; y: number }> = [];
  for (const [index, point] of options.points.entries()) {
    const resolved = resolveTapAtCoordinates(
      { x: point.x, y: point.y, coordinateSpace: options.coordinateSpace },
      observation,
      platform,
      "dragPath",
    );
    if ("error" in resolved) {
      return { error: `points[${index}]: ${resolved.error}` };
    }
    points.push({ x: resolved.x, y: resolved.y });
  }
  return { points };
}

/**
 * Turn native vertices into timed move frames. Each segment is split into frames at most
 * {@link DRAG_PATH_MOVE_INTERVAL_MS} apart, linearly interpolated, ending exactly on the vertex.
 */
export function planDragPath(
  vertices: Array<{ x: number; y: number }>,
  options: Pick<DragPathOptions, "points" | "holdMs" | "releaseHoldMs">,
): DragPathPlan {
  if (vertices.length < DRAG_PATH_MIN_POINTS) {
    throw new ActionableError(`dragPath needs at least ${DRAG_PATH_MIN_POINTS} points`);
  }
  const holdMs = options.holdMs ?? 0;
  const releaseHoldMs = options.releaseHoldMs ?? 0;
  const moves: DragPathStep[] = [];
  let elapsed = 0;
  for (let i = 1; i < vertices.length; i++) {
    const from = vertices[i - 1];
    const to = vertices[i];
    const duration = options.points[i]?.durationMs ?? DRAG_PATH_DEFAULT_SEGMENT_MS;
    const frames = Math.max(1, Math.ceil(duration / DRAG_PATH_MOVE_INTERVAL_MS));
    for (let frame = 1; frame <= frames; frame++) {
      const fraction = frame / frames;
      moves.push({
        atMs: elapsed + Math.round(duration * fraction),
        x: frame === frames ? to.x : Math.round(from.x + (to.x - from.x) * fraction),
        y: frame === frames ? to.y : Math.round(from.y + (to.y - from.y) * fraction),
      });
    }
    elapsed += duration;
  }
  return {
    start: vertices[0],
    holdMs,
    moves,
    releaseHoldMs,
    totalMs: holdMs + elapsed + releaseHoldMs,
    vertices,
  };
}

/** Reject a path before any input when it cannot finish inside the remaining request budget. */
export function assertDragPathFitsRequestBudget(
  totalMs: number,
  remainingRequestBudgetMs: number | undefined,
): void {
  if (totalMs > DRAG_PATH_MAX_TOTAL_MS) {
    throw new ActionableError(
      `dragPath total duration ${totalMs} ms exceeds the ${DRAG_PATH_MAX_TOTAL_MS} ms limit; shorten the segments or holds. No input was sent.`,
    );
  }
  if (remainingRequestBudgetMs === undefined) {
    return;
  }
  const neededMs = totalMs + LONG_PRESS_TIMEOUT_HEADROOM_MS;
  if (neededMs > remainingRequestBudgetMs) {
    throw new ActionableError(
      `dragPath duration ${totalMs} ms does not fit the remaining request budget (${remainingRequestBudgetMs} ms; needs ${neededMs} ms including dispatch headroom); no input was sent. Increase the request timeout or shorten the path.`,
    );
  }
}
