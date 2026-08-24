/**
 * Shared interface for platform CtrlProxy clients (Android, iOS).
 *
 * Extends DeviceService for the connection lifecycle and generic
 * gesture/text/screenshot surface, and adds the hierarchy + cache +
 * service-readiness methods that are CtrlProxy-specific but identical
 * across platforms.
 *
 * Platform-specific gesture, text, and action methods live on the
 * platform-specific interfaces (AndroidCtrlProxy, IOSCtrlProxy) which
 * extend this one and narrow the gesture/text return types to their
 * platform-specific result shapes.
 */

import type { ViewHierarchyResult } from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DeviceService } from "../DeviceService";

export interface CtrlProxyClient extends DeviceService {
  getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    disableAllFiltering?: boolean,
  ): Promise<ViewHierarchyResult | null>;

  verifyServiceReady(maxAttempts?: number, delayMs?: number, timeoutMs?: number): Promise<boolean>;
  invalidateCache(): void;
  hasCachedHierarchy(): boolean;
}
