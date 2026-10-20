import type { PerformanceTracker } from "../PerformanceTracker";

/** Coordinate tap input; platform defaults are applied by each delegate/facade. */
export interface TapCoordinatesRequest {
  x: number;
  y: number;
  duration?: number;
  timeoutMs?: number;
  perf?: PerformanceTracker;
  frameContext?: string;
  signal?: AbortSignal;
  onDispatch?: () => void;
  displayId?: number;
  beforeSend?: () => void;
}
