import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { ProgressCallback } from "../action/BaseVisualChange";
import type { ExplorationMode, ExplorationStrategy, ExploreOptions } from "./ExploreTypes";
export interface ExplorationLoopContext {
  options: ExploreOptions;
  maxInteractions: number;
  timeoutMs: number;
  startTime: number;
  strategy: ExplorationStrategy;
  mode: ExplorationMode;
  resetInterval: number;
  initialNodeCount: number;
  perf: PerformanceTracker;
  progress?: ProgressCallback;
  signal?: AbortSignal;
}
