import type { GestureStartRequest } from "../observe/android/CtrlProxyGestures";
import type { A11ySwipeResult } from "../observe/android/types";
import type { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../observe/shared/SharedGestureDelegate";
import type { DragPathPlan } from "./dragPathPlan";

/** The streaming-stroke subset of the CtrlProxy client a path drag needs. */
export interface StrokeClient {
  requestGestureStart(request: GestureStartRequest): Promise<A11ySwipeResult>;
  requestGestureMove(
    gestureId: string,
    x: number,
    y: number,
    options?: { timeoutMs?: number },
  ): Promise<A11ySwipeResult>;
  requestGestureEnd(
    gestureId: string,
    x: number,
    y: number,
    options?: { timeoutMs?: number; cancel?: boolean },
  ): Promise<A11ySwipeResult>;
}

export interface DragPathStrokeResult {
  success: boolean;
  moveCount: number;
  error?: string;
  /** True when a failure may have followed a stroke that touched the screen. */
  indeterminate?: boolean;
}

export interface DragPathStrokeOptions {
  gestureId: string;
  timer: Timer;
  signal?: AbortSignal;
  displayId?: number;
  /** Throws when the display changed since the plan was resolved. */
  assertCurrent?: () => void;
}

async function sleepWhileLive(timer: Timer, ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return;
  }
  await awaitWhileRequestIsLive(timer.sleep(ms), signal);
}

/**
 * Drive one streamed stroke: down at the start, hold, timed moves, release hold, up. Once the
 * runner has accepted the down, every exit (failed move, abort, timeout, throw) lifts the
 * finger with a cancelling end so no stroke is left on the device (#11541).
 */
export async function runDragPathStroke(
  client: StrokeClient,
  plan: DragPathPlan,
  options: DragPathStrokeOptions,
): Promise<DragPathStrokeResult> {
  const { gestureId, timer, signal } = options;
  throwIfAborted(signal);
  options.assertCurrent?.();
  // The down may have landed even when its correlated reply is lost or times out, so the start
  // sits inside the cleanup scope: a throw lifts the finger, an explicit refusal does not (#12994).
  let open = true;
  let moveCount = 0;
  let last = plan.start;
  try {
    const started = await client.requestGestureStart({
      gestureId,
      x: plan.start.x,
      y: plan.start.y,
      timeoutMs: DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
      displayId: options.displayId,
    });
    if (!started.success) {
      open = false;
      return {
        success: false,
        moveCount: 0,
        error: started.error ?? "Gesture start was refused",
      };
    }
    await sleepWhileLive(timer, plan.holdMs, signal);
    const travelStart = timer.now();
    for (const step of plan.moves) {
      await sleepWhileLive(timer, travelStart + step.atMs - timer.now(), signal);
      const moved = await client.requestGestureMove(gestureId, step.x, step.y);
      moveCount++;
      if (!moved.success) {
        return {
          success: false,
          moveCount,
          error: moved.error ?? "Gesture move failed",
          indeterminate: true,
        };
      }
      last = step;
    }
    await sleepWhileLive(timer, plan.releaseHoldMs, signal);
    const ended = await client.requestGestureEnd(gestureId, last.x, last.y, { cancel: false });
    if (!ended.success) {
      return {
        success: false,
        moveCount,
        error: ended.error ?? "Gesture end failed",
        indeterminate: true,
      };
    }
    open = false;
    return { success: true, moveCount };
  } finally {
    if (open) {
      await liftFinger(client, gestureId, last);
    }
  }
}

/** Best-effort cancelling end; never throws, so it cannot mask the original failure. */
async function liftFinger(
  client: StrokeClient,
  gestureId: string,
  at: { x: number; y: number },
): Promise<void> {
  try {
    await client.requestGestureEnd(gestureId, at.x, at.y, { cancel: true });
  } catch (error) {
    logger.warn(
      `[dragPath] cancelling stroke ${gestureId} failed; the runner may still hold the finger down: ${errorMessage(error)}`,
      error,
    );
  }
}
