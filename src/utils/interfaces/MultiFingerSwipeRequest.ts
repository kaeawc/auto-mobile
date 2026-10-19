import type { PerformanceTracker } from "../PerformanceTracker";

/** Options form of the iOS `requestMultiFingerSwipe`, replacing its 12 positional arguments. */
export interface MultiFingerSwipeRequest {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  fingerCount: number;
  /** Gesture duration in milliseconds (default 300). */
  duration?: number;
  /** Request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  perf?: PerformanceTracker;
  fingerSpacing?: number;
  signal?: AbortSignal;
  onDispatch?: () => void;
  /** Synchronous display/stale fence run immediately before the socket write. */
  beforeSend?: () => void;
}
