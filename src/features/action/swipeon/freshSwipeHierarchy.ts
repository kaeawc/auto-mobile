import { AsyncLocalStorage } from "node:async_hooks";
import type { ObserveResult } from "../../../models";
import type { Timer } from "../../../utils/SystemTimer";
import { getRequestContext } from "../../../utils/AbortContext";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { throwIfAborted } from "../../../utils/toolUtils";
import { StaleDisplayError } from "../../../models/StaleDisplayError";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "../../observe/DeviceHierarchyCapture";
import { hasWrongWindowEvidence } from "../../observe/observationFreshness";
import {
  wasHierarchyReadDuringCall,
  withObservationReadScope,
} from "../../observe/observationReadScope";

const swipeReadScope = new AsyncLocalStorage<boolean>();

/** Direct searches own a scope; searches dispatched by SwipeOn retain its reads. */
export function withSwipeObservationReadScope<T>(block: () => T): T {
  return swipeReadScope.getStore()
    ? block()
    : swipeReadScope.run(true, () => withObservationReadScope(block));
}

function swipeHierarchyReadTimeoutMs(timer: Timer): number {
  const deadline = getRequestContext()?.getDeadlineMs?.();
  return Math.max(
    0,
    Math.min(
      DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
      deadline === undefined ? DEFAULT_HIERARCHY_READ_TIMEOUT_MS : deadline - timer.now(),
    ),
  );
}

/** Never resolve swipe geometry or a visible search hit from an earlier call's tree. */
export async function freshSwipeHierarchy(
  observation: ObserveResult,
  read: (timeoutMs: number) => Promise<ObserveResult>,
  timer: Timer,
  signal?: AbortSignal,
): Promise<ObserveResult> {
  throwIfAborted(signal);
  if (
    !observation.viewHierarchy ||
    observation.viewHierarchy.hierarchy.error ||
    wasHierarchyReadDuringCall(observation.viewHierarchy)
  ) {
    return observation;
  }
  const timeoutMs = swipeHierarchyReadTimeoutMs(timer);
  if (timeoutMs > 0) {
    try {
      const fresh = await read(timeoutMs);
      throwIfAborted(signal);
      return hasWrongWindowEvidence(fresh) ? { ...fresh, viewHierarchy: undefined } : fresh;
    } catch (error) {
      throwIfAborted(signal);
      if (
        error instanceof StaleDisplayError ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      logger.warn(`[SwipeOn] Fresh hierarchy unavailable: ${errorMessage(error)}`, error);
    }
  }
  // Preserve screen-swipe fallback metadata, but never reuse stale element bounds.
  return { ...observation, viewHierarchy: undefined };
}
