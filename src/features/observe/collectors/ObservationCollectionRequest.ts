import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ViewHierarchyResult } from "../../../models";
import type { HierarchyReadOptions } from "../interfaces/ViewHierarchy";

/** Typed input to the observe capture stage (`RealObserveScreen.collectAllData`); every field is optional. */
export interface ObservationCollectionRequest {
  queryOptions?: ViewHierarchyQueryOptions;
  perf?: PerformanceTracker;
  skipWaitForFresh?: boolean;
  minTimestamp?: number;
  signal?: AbortSignal;
  skipBackStack?: boolean;
  readOnly?: boolean;
  capturedHierarchy?: ViewHierarchyResult;
  readOptions?: number | HierarchyReadOptions;
  displayId?: number;
}
