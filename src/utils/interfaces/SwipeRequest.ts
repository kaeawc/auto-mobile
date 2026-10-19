import type { PerformanceTracker } from "../PerformanceTracker";

/**
 * One single-finger swipe request. Shared by the Android and iOS CtrlProxy clients and their
 * delegates so the dispatch hooks (`onDispatch`, `beforeSend`, `signal`) are named, not positional.
 */
export interface SwipeRequest {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration?: number;
  timeoutMs?: number;
  perf?: PerformanceTracker;
  /** Frame context (Android, iOS) or the iOS swipe options. */
  contextOptions?: string | SwipeRequestOptions;
  /** Fires as the gesture is handed to the device, after the pre-send checks. */
  onDispatch?: () => void;
  signal?: AbortSignal;
  displayId?: number;
  /** Synchronous display/stale fence run immediately before the socket write. */
  beforeSend?: () => void;
}

/** Optional iOS swipe context; a legacy frame-context string remains accepted. */
export interface SwipeRequestOptions {
  frameContext?: string;
  lockScreen?: boolean;
}
