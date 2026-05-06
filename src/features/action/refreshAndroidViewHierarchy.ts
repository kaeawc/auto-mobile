import type { ViewHierarchyResult } from "../../models";
import type { CtrlProxyClient } from "../observe/android";
import type { ViewHierarchy } from "../observe/ViewHierarchy";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { logger } from "../../utils/logger";

function countHierarchyNodes(node: Record<string, unknown>): number {
  let count = 1;
  const children = node.children as Record<string, unknown>[] | undefined;
  if (children) {
    for (const child of children) {
      count += countHierarchyNodes(child);
    }
  }
  return count;
}

/**
 * Shared Android view hierarchy refresh: sync from accessibility service,
 * check for incomplete hierarchy, and merge with uiautomator fallback.
 *
 * Returns the raw (unfiltered) hierarchy — callers are responsible for
 * any post-processing (filtering, attachRawViewHierarchy, etc.).
 */
export async function refreshAndroidViewHierarchy(
  accessibilityService: CtrlProxyClient,
  viewHierarchy: ViewHierarchy,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ViewHierarchyResult | null> {
  const syncResult = await accessibilityService.requestHierarchySync(
    new NoOpPerformanceTracker(),
    serverConfig.isRawElementSearchEnabled(),
    signal,
    timeoutMs
  );

  let rawHierarchy = syncResult
    ? accessibilityService.convertToViewHierarchyResult(syncResult.hierarchy)
    : null;

  if (!rawHierarchy) {
    return null;
  }

  if (rawHierarchy.ctrlProxyIncomplete) {
    const nodeCount = rawHierarchy.hierarchy ? countHierarchyNodes(rawHierarchy.hierarchy) : 0;
    logger.info(
      `[refreshAndroidViewHierarchy] Incomplete hierarchy: pkg=${rawHierarchy.packageName}, ` +
      `nodes=${nodeCount}, fetching uiautomator fallback`
    );
    try {
      const uiautomatorHierarchy = await viewHierarchy.getUiAutomatorHierarchy(
        signal,
        !serverConfig.isRawElementSearchEnabled()
      );
      const fallbackNodeCount = uiautomatorHierarchy?.hierarchy
        ? countHierarchyNodes(uiautomatorHierarchy.hierarchy)
        : 0;
      logger.info(
        `[refreshAndroidViewHierarchy] UIAutomator fallback: pkg=${uiautomatorHierarchy?.packageName}, nodes=${fallbackNodeCount}`
      );
      rawHierarchy = viewHierarchy.mergeHierarchies(rawHierarchy, uiautomatorHierarchy);
    } catch (fallbackErr) {
      logger.warn(`[refreshAndroidViewHierarchy] Failed to get uiautomator fallback: ${fallbackErr}`);
    }
  }

  return rawHierarchy;
}
