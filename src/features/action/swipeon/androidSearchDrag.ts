import type { AndroidCtrlProxyClient } from "../../observe/android";
import { StaleDisplayError, withStaleDisplay } from "../../../models/StaleDisplayError";
import { DispatchedObservationError } from "../../../models/DispatchedObservationError";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { SwipeResult } from "../../../models";
import { throwIfAborted } from "../../../utils/toolUtils";
import { LOOK_FOR_HOLD_MS } from "./lookForScroll";

/** Owned by one lookFor execution, including recovery steps; never shared across searches. */
export interface AndroidSearchDragState {
  deviceInfo?: ReturnType<AndroidCtrlProxyClient["requestDeviceInfo"]>;
  pagingStep?: boolean;
}

function searchDeviceInfo(
  client: Pick<AndroidCtrlProxyClient, "requestDeviceInfo">,
  state?: AndroidSearchDragState,
): ReturnType<AndroidCtrlProxyClient["requestDeviceInfo"]> {
  const request = state?.deviceInfo ?? client.requestDeviceInfo();
  if (state) {
    state.deviceInfo = request;
  }
  return request;
}

function mustRethrowSearchDragError(error: unknown, dispatched: boolean): boolean {
  return (
    error instanceof DispatchedObservationError ||
    (error instanceof StaleDisplayError && !dispatched)
  );
}

/**
 * Reuse CtrlProxy's continued drag strokes: travel, then a stationary final stroke.
 * The final stroke emits UP at 100ms; a continued stationary stroke alone completes
 * at its last emitted event and would not hold. Zero movement during the last 100ms
 * gives 0 px/s release velocity, below the ~50 dp/s Android fling threshold at any
 * density. The emulator's 42px/16dp list padding implies density 2.625:
 * ~50dp/s is ~131px/s, versus the reported 1609px/300ms = ~5363px/s.
 */
export async function executeAndroidSearchDrag(options: {
  client: Pick<AndroidCtrlProxyClient, "requestDrag" | "requestDeviceInfo">;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number;
  signal?: AbortSignal;
  displayId?: number;
  beforeSend?: () => void;
  fallback: () => Promise<SwipeResult>;
  onFallback?: () => void;
  searchDragState?: AndroidSearchDragState;
  onIndeterminate?: (cause: unknown) => never;
}): Promise<SwipeResult> {
  const { client, x1, y1, x2, y2, duration, signal, displayId, beforeSend } = options;
  const fallback = () => {
    throwIfAborted(signal);
    beforeSend?.();
    options.onFallback?.();
    return options.fallback();
  };
  const indeterminate = (cause: unknown): SwipeResult => {
    options.onIndeterminate?.(cause);
    const error = new DispatchedObservationError(cause);
    return withStaleDisplay(
      {
        success: false,
        outcomeIndeterminate: true,
        x1,
        y1,
        x2,
        y2,
        duration,
        error: error.message,
      },
      error,
    );
  };
  let dispatched = false;
  try {
    throwIfAborted(signal);
    const info = await searchDeviceInfo(client, options.searchDragState);
    throwIfAborted(signal);
    beforeSend?.();
    if (!info.success || info.sdkInt === undefined || info.sdkInt < 26) {
      return fallback();
    }
    const result = await client.requestDrag(
      x1,
      y1,
      x2,
      y2,
      0,
      duration,
      LOOK_FOR_HOLD_MS,
      5000,
      undefined,
      signal,
      displayId,
      beforeSend,
      () => {
        dispatched = true;
      },
    );
    throwIfAborted(signal);
    if (!result.success) {
      if (!dispatched) {
        return fallback();
      }
      logger.warn(`[SwipeOn] Search drag outcome indeterminate: ${result.error}`);
      return indeterminate(result.error ?? "unknown error");
    }
    return { ...result, x1, y1, x2, y2, duration };
  } catch (error) {
    if (mustRethrowSearchDragError(error, dispatched)) {
      throw error;
    }
    throwIfAborted(signal);
    if (dispatched) {
      logger.warn(`[SwipeOn] Search drag outcome indeterminate: ${errorMessage(error)}`, error);
      return indeterminate(error);
    }
    // Optional CtrlProxy capability/connection failures are safe to retry via ADB before dispatch.
    logger.debug(`[SwipeOn] Precise search drag unavailable: ${errorMessage(error)}`, error);
    return fallback();
  }
}
