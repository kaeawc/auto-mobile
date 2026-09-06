import type { ViewHierarchyResult } from "../../models";
import type { AndroidCtrlProxyClient } from "../observe/android";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { logger } from "../../utils/logger";

/**
 * Shared Android view hierarchy refresh: sync from the accessibility service
 * and surface whether CtrlProxy reported the capture as incomplete.
 *
 * A uiautomator-dump fallback for the incomplete case was attempted here via
 * `ViewHierarchy.getUiAutomatorHierarchy`/`mergeHierarchies`, but neither method
 * was ever implemented (issue #6252) — the call always threw and was silently
 * swallowed, so the "fallback" was dead code that never ran. Removed rather
 * than reimplemented: building a real uiautomator-dump-and-merge pipeline is a
 * separate feature, not a typecheck-baseline sweep fix. Callers already treat
 * `ctrlProxyIncomplete` as a signal (see `ObserveScreen.ts`), so the incomplete
 * hierarchy is still returned as-is for them to act on.
 *
 * Returns the raw (unfiltered) hierarchy — callers are responsible for
 * any post-processing (filtering, attachRawViewHierarchy, etc.).
 */
export async function refreshAndroidViewHierarchy(
  accessibilityService: AndroidCtrlProxyClient,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ViewHierarchyResult | null> {
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

  if (rawHierarchy.ctrlProxyIncomplete) {
    logger.debug(
      "[refreshAndroidViewHierarchy] Accessibility service returned incomplete hierarchy; no uiautomator fallback is implemented, returning as-is",
    );
  }

  return rawHierarchy;
}
