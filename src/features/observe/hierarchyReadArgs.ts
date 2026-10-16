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

/**
 * A performance tracker always has `track`/`serial`; the options objects never do, which is
 * how the options form is told apart from the deprecated positional `perf` argument.
 */
function isRequestObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !("track" in value) && !("serial" in value);
}

export interface ResolvedViewHierarchyRead {
  perf?: PerformanceTracker;
  skipWaitForFresh?: boolean;
  minTimestamp?: number;
  signal?: AbortSignal;
  readOptions?: number | HierarchyReadOptions;
}

/** Normalizes the options form and the deprecated positional form of `getViewHierarchy`. */
export function resolveViewHierarchyReadArgs(
  perfOrRequest?: PerformanceTracker | ViewHierarchyReadRequest,
  skipWaitForFresh?: boolean,
  minTimestamp?: number,
  signal?: AbortSignal,
  readOptions?: number | HierarchyReadOptions,
): ResolvedViewHierarchyRead {
  if (!isRequestObject(perfOrRequest)) {
    return {
      perf: perfOrRequest as PerformanceTracker | undefined,
      skipWaitForFresh,
      minTimestamp,
      signal,
      readOptions,
    };
  }
  const request = perfOrRequest as ViewHierarchyReadRequest;
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

/** Normalizes the options form and the deprecated positional form of `getAccessibilityHierarchy`. */
export function resolveAccessibilityHierarchyArgs(
  perfOrRequest?: PerformanceTracker | AccessibilityHierarchyRequest,
  skipWaitForFresh?: boolean,
  minTimestamp?: number,
  disableAllFiltering?: boolean,
  signal?: AbortSignal,
  readOptions?: number | HierarchyReadOptions,
): ResolvedAccessibilityHierarchyRead {
  if (!isRequestObject(perfOrRequest)) {
    return {
      perf: perfOrRequest as PerformanceTracker | undefined,
      skipWaitForFresh,
      minTimestamp,
      disableAllFiltering,
      signal,
      readOptions,
    };
  }
  const request = perfOrRequest as AccessibilityHierarchyRequest;
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
