/**
 * Shared interface for platform CtrlProxy clients (Android, iOS).
 *
 * Captures the methods whose signatures are identical across platforms:
 * connection lifecycle, cache management, and hierarchy retrieval.
 *
 * Platform-specific gesture, text, and action methods live on the
 * platform-specific interfaces (AndroidCtrlProxy, IOSCtrlProxy) which
 * extend this one. Those methods diverge in their result types, so they
 * cannot be unified without sacrificing type safety at call sites.
 */

import type { ViewHierarchyResult } from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";

export interface CtrlProxyClient {
  getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    disableAllFiltering?: boolean
  ): Promise<ViewHierarchyResult | null>;

  ensureConnected(perf?: PerformanceTracker): Promise<boolean>;
  isConnected(): boolean;
  waitForConnection(maxAttempts?: number, delayMs?: number): Promise<boolean>;
  verifyServiceReady(maxAttempts?: number, delayMs?: number, timeoutMs?: number): Promise<boolean>;
  invalidateCache(): void;
  close(): Promise<void>;
}
