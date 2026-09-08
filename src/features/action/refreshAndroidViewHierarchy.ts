import type { ViewHierarchyResult } from "../../models";
import type { AndroidCtrlProxyClient } from "../observe/android";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  supplementAndroidHierarchy,
  type AndroidHierarchyFallbackDeps,
} from "./AndroidHierarchyFallback";

/** Refresh CtrlProxy, supplement incomplete captures within the same caller budget. */
export async function refreshAndroidViewHierarchy(
  accessibilityService: AndroidCtrlProxyClient,
  timeoutMs: number,
  signal?: AbortSignal,
  fallback?: AndroidHierarchyFallbackDeps,
): Promise<ViewHierarchyResult | null> {
  const timer = fallback?.timer ?? defaultTimer;
  const deadline = timer.now() + timeoutMs;
  const syncResult = await accessibilityService.requestHierarchySync(
    new NoOpPerformanceTracker(),
    serverConfig.isRawElementSearchEnabled(),
    signal,
    timeoutMs,
  );

  const rawHierarchy = syncResult
    ? accessibilityService.convertToViewHierarchyResult(syncResult.hierarchy)
    : null;

  if (!rawHierarchy) {
    return null;
  }

  if (rawHierarchy.ctrlProxyIncomplete && fallback) {
    return supplementAndroidHierarchy(rawHierarchy, fallback, deadline, signal);
  }

  return rawHierarchy;
}
