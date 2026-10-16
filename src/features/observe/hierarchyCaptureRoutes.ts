import type { ViewHierarchyResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage as describeError } from "../../utils/describeUnknownError";
import { AndroidDisplayReadError } from "./ObservationDisplay";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "./DeviceHierarchyCapture";
import { DisplaySelectionError } from "./DisplaySelection";
import { displayTransitions, type DisplayCaptureStart } from "./DisplayTransition";
import { ObserverPendingRequestTimeoutError } from "./DeviceServiceClient";
import type { HierarchyCapture, HierarchyCaptureRequest } from "./HierarchyCapture";
import {
  classifySelectedDisplayReadFailure,
  readSelectedDisplayWithRetry,
  SelectedDisplayReadError,
  type SelectedDisplayReadPolicy,
} from "./SelectedDisplayRead";
import { StaleDisplayError, staleDisplayError } from "./StaleDisplayError";
import { StrictSettledScreenshotCaptureError } from "./SettledScreenshotCapture";

/** How one observation routes its hierarchy capture, and which capture failures must surface. */

export async function captureSelectedDisplayHierarchy(
  deps: {
    selectedDisplayRead: SelectedDisplayReadPolicy;
    timer: Timer;
    hierarchyCapture: HierarchyCapture;
    deviceId: string;
  },
  options: {
    request: HierarchyCaptureRequest;
    panelKey: string | undefined;
    captureStart: DisplayCaptureStart;
  },
): Promise<ViewHierarchyResult> {
  const { request, panelKey, captureStart } = options;
  const captured = await readSelectedDisplayWithRetry({
    ...deps.selectedDisplayRead,
    timer: deps.timer,
    budgetMs: request.timeoutMs ?? DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    read: (attempt) =>
      deps.hierarchyCapture.capture(
        attempt.number === 1 ? request : { ...request, timeoutMs: attempt.timeoutMs },
      ),
    classify: (error) => classifySelectedDisplayReadFailure(error, { signal: request.signal }),
    assertFenceCurrent: () => {
      const deviceId = deps.deviceId;
      if (displayTransitions.revision(deviceId) !== captureStart.revision) {
        throw staleDisplayError(
          captureStart.identityRevision,
          displayTransitions.identityRevision(deviceId),
          displayTransitions.currentObservedPanel(deviceId)?.key,
        );
      }
    },
    wrap: (error, info) => {
      const message = `Unable to read selected display "${panelKey}": ${String(error)}`;
      return info.exhausted
        ? new SelectedDisplayReadError(message, {
            cause: error,
            kind: info.kind,
            attempts: info.attempts,
          })
        : new DisplaySelectionError(message, { cause: error });
    },
  });
  return captured.hierarchy;
}

export function shouldPropagateCaptureError(
  platform: string,
  error: unknown,
  context: {
    display: string | undefined;
    signal: AbortSignal | undefined;
  },
): boolean {
  if (
    error instanceof StrictSettledScreenshotCaptureError ||
    error instanceof DisplaySelectionError
  ) {
    return true;
  }
  const explicitAndroidDisplay =
    platform === "android" && context.display !== undefined && context.display !== "active";
  if (!explicitAndroidDisplay) {
    return false;
  }
  return (
    error instanceof AndroidDisplayReadError ||
    error instanceof StaleDisplayError ||
    (context.signal?.aborted === true && error === context.signal.reason)
  );
}

export async function captureObserverHierarchy(
  hierarchyCapture: HierarchyCapture,
  request: HierarchyCaptureRequest,
): Promise<ViewHierarchyResult> {
  try {
    return (await hierarchyCapture.capture(request)).hierarchy;
  } catch (error) {
    if (request.signal?.aborted) {
      throw error;
    }
    const detail = describeError(error);
    logger.warn(`[ObserveScreen] Observer hierarchy unavailable: ${detail}`, error);
    return {
      hierarchy: {
        error: "Hierarchy service unavailable",
        unavailableReason:
          error instanceof ObserverPendingRequestTimeoutError
            ? "request_timed_out"
            : "connection_lost",
        unavailableDetail: detail,
      },
      fresh: false,
    };
  }
}
