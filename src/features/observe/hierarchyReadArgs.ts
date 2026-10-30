import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { AccessibilityHierarchyRequest } from "../../utils/interfaces/DeviceService";
import type { HierarchyReadOptions } from "./interfaces/ViewHierarchy";

/** Options form of `getViewHierarchy`, replacing its positional tail. */
export type { AccessibilityHierarchyRequest };

export interface ViewHierarchyReadRequest extends HierarchyReadOptions {
  perf?: PerformanceTracker;
  /** Skip the WebSocket wait for fresh data and go straight to the sync method. */
  skipWaitForFresh?: boolean;
  /** Cached data must have updatedAt >= this value. */
  minTimestamp?: number;
  signal?: AbortSignal;
}

export interface ResolvedViewHierarchyRead {
  perf?: PerformanceTracker;
  skipWaitForFresh?: boolean;
  minTimestamp?: number;
  signal?: AbortSignal;
  readOptions?: number | HierarchyReadOptions;
}

/** Normalizes the `getViewHierarchy` request into the values the readers consume. */
export function resolveViewHierarchyReadArgs(
  request: ViewHierarchyReadRequest = {},
): ResolvedViewHierarchyRead {
  const { timeoutMs, requireFreshExtraction } = request;
  return {
    perf: request.perf,
    skipWaitForFresh: request.skipWaitForFresh,
    minTimestamp: request.minTimestamp,
    signal: request.signal,
    readOptions:
      timeoutMs === undefined && requireFreshExtraction === undefined
        ? undefined
        : { timeoutMs, requireFreshExtraction },
  };
}

export interface ResolvedAccessibilityHierarchyRead {
  perf?: PerformanceTracker;
  skipWaitForFresh?: boolean;
  minTimestamp?: number;
  disableAllFiltering?: boolean;
  signal?: AbortSignal;
  readOptions?: number | HierarchyReadOptions;
}

/** Normalizes the `getAccessibilityHierarchy` request into the values the readers consume. */
export function resolveAccessibilityHierarchyArgs(
  request: AccessibilityHierarchyRequest = {},
): ResolvedAccessibilityHierarchyRead {
  const { timeoutMs, requireFreshExtraction } = request;
  return {
    perf: request.perf,
    skipWaitForFresh: request.skipWaitForFresh,
    minTimestamp: request.minTimestamp,
    disableAllFiltering: request.disableAllFiltering,
    signal: request.signal,
    readOptions:
      timeoutMs === undefined && requireFreshExtraction === undefined
        ? undefined
        : { timeoutMs, requireFreshExtraction },
  };
}
