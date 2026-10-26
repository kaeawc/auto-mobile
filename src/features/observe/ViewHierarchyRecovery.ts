import { ViewHierarchyQueryOptions } from "../../models";
import { type Hierarchy } from "../../models/ViewHierarchyResult";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { IosRunnerLaunchQueueView } from "../../ctrlProxy/ios/IosRunnerLaunchGate";
import { RunnerLaunchQueuedError } from "../../ctrlProxy/ios/RunnerLaunchQueuedError";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
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

/**
 * Unavailable reasons a first observe reports while the runner it needs is still being launched:
 * the request budget lapses (request_timed_out), the launch is not ready yet (connection_lost,
 * runner_not_running), or an auto-setup that is itself queued reports as a failure/recovery.
 */
const LAUNCH_PENDING_SYMPTOMS: ReadonlySet<string> = new Set([
  "request_timed_out",
  "auto_setup_failed",
  "service_recovering",
  "connection_lost",
  "runner_not_running",
  "unknown",
]);

/**
 * Type an unavailable iOS hierarchy as `runner_launch_queued` when the device's runner launch is
 * waiting in, or holding a slot of, the launch gate (#15291). The session-less `readiness: none`
 * observe connects through auto-setup, whose launch waits behind the gate for 6-33 s while the
 * read budget (5 s) lapses first; without this the client sees an untyped timeout or setup failure
 * for a launch that is healthy and still starting. A hierarchy that carries content is untouched.
 */
export function typeQueuedRunnerLaunch(
  result: ViewHierarchyResult,
  deviceId: string,
  queue: IosRunnerLaunchQueueView,
): void {
  const reason = result.hierarchy.unavailableReason;
  if (reason === undefined || !LAUNCH_PENDING_SYMPTOMS.has(reason)) {
    return;
  }
  const status = queue.queueStatus(deviceId);
  if (!status && !queue.isLaunching(deviceId)) {
    return;
  }
  const detail = new RunnerLaunchQueuedError(deviceId, status).message;
  result.hierarchy.unavailableReason = "runner_launch_queued";
  result.hierarchy.iosUnavailableReason = "runner_launch_queued";
  result.hierarchy.unavailableDetail = detail;
  result.hierarchy.error = `Failed to retrieve iOS view hierarchy from CtrlProxy iOS: runner_launch_queued: ${detail}`;
  // The runner is healthy and starting: reconnect metadata must not drive recovery.
  delete result.ctrlProxyReconnect;
}
