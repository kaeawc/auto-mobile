import { ViewHierarchyQueryOptions } from "../../models";
import { type Hierarchy } from "../../models/ViewHierarchyResult";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { CtrlProxyHierarchyResponse } from "./ios/types";

export function iosHierarchyUnavailable(result: CtrlProxyHierarchyResponse | null): Hierarchy {
  const reason = result?.unavailableReason ?? "unknown";
  const detail = result?.unavailableDetail;
  return {
    error: `Failed to retrieve iOS view hierarchy from CtrlProxy iOS: ${reason}${detail ? `: ${detail}` : ""}`,
    iosUnavailableReason: reason,
    unavailableReason: reason,
    unavailableDetail: detail,
  };
}

export interface RecoveryReadContext {
  queryOptions?: ViewHierarchyQueryOptions;
  perf: PerformanceTracker;
  skipWaitForFresh: boolean;
  minTimestamp: number;
  signal?: AbortSignal;
  deadline?: number;
  requireFreshExtraction?: boolean;
}
