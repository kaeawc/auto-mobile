import { DUMPSYS_MAX_BUFFER } from "../../../utils/android-cmdline-tools/dumpsysLimits";
import type { HierarchyReadOptions } from "../interfaces/ViewHierarchy";
import { linkWindowRoots } from "../linkWindowRoots";
/**
 * CtrlProxyHierarchy - Delegate for hierarchy retrieval and caching.
 *
 * This delegate handles getting, caching, and converting view hierarchy data
 * from the Android accessibility service.
 */

import WebSocket from "ws";
import { logger } from "../../../utils/logger";
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import type { PerformanceTracker, TimingEntry } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import { AndroidCtrlProxyManager } from "../../../ctrlProxy/CtrlProxyManager";
import type { ViewHierarchyResult } from "../../../models";
import { screenScaleMetadataSpread } from "../../../models/ScreenScaleMetadata";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type {
  HierarchyDelegateContext,
  AccessibilityHierarchy,
  AccessibilityHierarchyResponse,
  AccessibilityNode,
  CachedHierarchy,
  AndroidPerfTiming,
  HierarchySyncDiagnostics,
  ObserverHierarchyRequestOptions,
} from "./types";
import { generateSecureId } from "./types";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import { applyStableViewIdRewrites, assignStableViewIds } from "./StableNodeIdentity";
import { maxObservationAgeMs } from "../observationFreshness";
import { isAndroidPackageRunning } from "../../../utils/android-cmdline-tools/androidProcessState";

/** Cooldown after a WebSocket timeout before retrying fresh-data waits.
 *  Keep short: a long cooldown (e.g. 5s) turns a single slow response into
 *  a cascade where every hierarchy request returns stale data. */
const WEBSOCKET_TIMEOUT_COOLDOWN_MS = 500;

/** Default wait window for a fresh WebSocket-pushed hierarchy.
 *  Aligned with the 1s cache-freshness TTL so a contended ADB pipe
 *  (concurrent screenshots, dumpsys, emulator transitions) has the same
 *  headroom that the cache considers acceptable for "fresh" data.
 *  100ms was too aggressive: under contention pushes routinely exceeded
 *  it, silently degrading results to stale cache. See issue #2285. */
const DEFAULT_FRESH_WAIT_MS = 1000;

/**
 * Rejection carrier for a correlated runner `type:"error"` frame (issue #3062).
 *
 * `waitForFreshData` rejects with this (instead of a bare `Error`) when a runner error frame
 * unblocks the wait, so `requestHierarchySync`'s catch can distinguish a runner-reported handler
 * failure from any other thrown cause (abort, connection failure) and surface only the former to
 * the caller via the `HierarchySyncDiagnostics` out-parameter. Module-private: it is an internal
 * control-flow signal, not part of any public contract.
 */
class HierarchyRunnerError extends Error {
  constructor(readonly runnerError: string) {
    super(runnerError);
    this.name = "HierarchyRunnerError";
  }
}

/**
 * Whether the reply to a sync request answers its caller only and must not replace the
 * client's shared default-display state (cached hierarchy, screen geometry, device
 * stream). Observer reads always do; an owner read does when it targets a non-default
 * logical display. A request with no `displayId`, or `displayId: 0`, keeps owning the
 * shared cache (#10106).
 */
function isolatedHierarchyRequest(request: { observerMode: boolean; displayId?: number }): boolean {
  return request.observerMode || (request.displayId !== undefined && request.displayId !== 0);
}

type HierarchyLookupResult = AccessibilityHierarchyResponse & {
  /** Internal cache-serving policy; never exposed as verification freshness. */
  withinCacheServeWindow?: boolean;
};

type HierarchySyncResult = {
  hierarchy: AccessibilityHierarchy;
  perfTiming?: AndroidPerfTiming[];
  frameContext?: string;
} | null;

interface HierarchySyncFlight {
  observerMode: boolean;
  preserveDisplayState: boolean;
  disableAllFiltering: boolean;
  displayId?: number;
  minReceivedAt: number;
  timeoutMs: number;
  controller: AbortController;
  waiters: number;
  diagnostics: HierarchySyncDiagnostics;
  promise: Promise<HierarchySyncResult>;
}

/**
 * Delegate class for handling hierarchy retrieval and caching.
 *
 * NOT using TTLCache: Uses push updates from Android accessibility service,
 * minTimestamp validation, and "fresh" boolean state rather than simple TTL.
 */
export class CtrlProxyHierarchy {
  private readonly context: HierarchyDelegateContext;

  // Track the last known foreground app to detect stale cache from a different app
  private lastKnownPackageName: string | null = null;

  // Recomposition tracking state
  private recompositionTrackingConfigured: boolean = false;
  private recompositionTrackingEnabled: boolean = false;

  // Outstanding hierarchy request IDs mapped to their settle hooks. request_hierarchy does
  // NOT await through RequestManager (it blocks in waitForFreshData for a hierarchy_update push), so
  // a runner type:"error" frame must be fanned into this map to unblock the correct waiter fast
  // instead of hanging to timeout. See issue #3032.
  //
  // The hook is wrapped in an object and invoked via the fixed `.reject` property (mirroring
  // RequestManager's `request.reject(...)`) rather than calling the map value directly — a
  // user-controlled requestId must never drive a dynamic method-name dispatch.
  private readonly pendingHierarchyRejectors = new Map<
    string,
    {
      reject: (error: string) => void;
      disconnect: () => void;
      resolve: (hierarchy: CachedHierarchy) => void;
    }
  >();
  private readonly hierarchySyncFlights = new Set<HierarchySyncFlight>();
  private correlatedFramesSeen = false;

  constructor(context: HierarchyDelegateContext) {
    this.context = context;
  }

  /** The echo advertisement is connection-scoped evidence equivalent to a correlated frame. */
  markRequestIdEchoAdvertised(): void {
    this.correlatedFramesSeen = true;
  }

  /**
   * Reject an in-flight hierarchy wait whose requestId matches a runner type:"error" frame,
   * surfacing the runner's error text so the caller fails fast instead of hanging to the
   * waitForFreshData timeout (issue #3032).
   *
   * Returns false (safe no-op) when the id is not an outstanding hierarchy request — e.g. a
   * null/unknown requestId the runner could not correlate — preserving existing behavior.
   */
  rejectPendingHierarchy(requestId: string, error: string): boolean {
    const rejector = this.pendingHierarchyRejectors.get(requestId);
    if (!rejector) {
      return false;
    }
    rejector.reject(error);
    return true;
  }

  /** Deliver a correlated hierarchy before a later push overwrites the shared cache. */
  resolvePendingHierarchy(requestId: string | null | undefined, hierarchy: CachedHierarchy): void {
    if (requestId) {
      this.correlatedFramesSeen = true;
      this.pendingHierarchyRejectors.get(requestId)?.resolve(hierarchy);
    }
  }

  /** Connection-scoped evidence used by legacy idless-response consumers. */
  hasSeenCorrelatedFrames(): boolean {
    return this.correlatedFramesSeen;
  }

  private matchesHierarchyRequest(
    hierarchy: CachedHierarchy,
    requestId?: string,
    staleRequestId?: string | null,
    allowStaleResponse = true,
    observerMode = false,
  ): boolean {
    if (observerMode && requestId) {
      return hierarchy.requestId === requestId;
    }
    return (
      !requestId ||
      (!hierarchy.requestId && !this.correlatedFramesSeen) ||
      hierarchy.requestId === requestId ||
      (allowStaleResponse && !!staleRequestId && hierarchy.requestId === staleRequestId)
    );
  }

  /**
   * A legacy APK does not echo request ids, so a reply can be some other display's push. When the
   * frame names its display and it is not the requested one, it must not answer the request. A
   * frame that carries no `displayId` cannot be checked and is accepted.
   */
  private matchesRequestedDisplay(hierarchy: CachedHierarchy, displayId?: number): boolean {
    const replyDisplayId = hierarchy.hierarchy.displayId;
    return displayId === undefined || replyDisplayId === undefined || replyDisplayId === displayId;
  }

  private matchesFreshHierarchy(
    hierarchy: CachedHierarchy,
    minTimestamp: number,
    useDeviceTimestamp: boolean,
    request: {
      requestId?: string;
      staleRequestId?: string | null;
      allowStaleResponse: boolean;
      observerMode?: boolean;
      displayId?: number;
    },
  ): boolean {
    return (
      this.matchesRequestedDisplay(hierarchy, request.displayId) &&
      this.evaluateMinTimestamp(hierarchy, minTimestamp, useDeviceTimestamp).isFresh &&
      this.matchesHierarchyRequest(
        hierarchy,
        request.requestId,
        request.staleRequestId,
        request.allowStaleResponse,
        request.observerMode,
      )
    );
  }

  private isDispatchSocketValid(dispatchSocket?: WebSocket | null): boolean {
    return (
      dispatchSocket === undefined ||
      (!!dispatchSocket &&
        dispatchSocket.readyState === WebSocket.OPEN &&
        this.context.getWebSocket() === dispatchSocket)
    );
  }

  private markIsolatedRequest(
    requestId: string,
    request: { observerMode: boolean; preserveDisplayState: boolean; displayId?: number },
  ): void {
    this.context.markObserverHierarchyRequest?.(requestId, {
      // An owner read of a non-default display always answers its caller only (#10106).
      isolateResponse:
        !request.observerMode || request.preserveDisplayState || request.displayId !== undefined,
    });
  }

  private unmarkObserverRequest(isolated: boolean, requestId?: string): void {
    if (isolated && requestId) {
      this.context.unmarkObserverHierarchyRequest?.(requestId);
    }
  }

  /**
   * Clear connection-scoped device state on a WebSocket close (issue #7540).
   *
   * The recomposition-tracking latch describes what the runner's accessibility
   * service instance holds, not what the host client holds. A restart of that
   * service (crash rebind, APK reinstall, or any other event that closes this
   * socket) comes back with `RecompositionStore.enabled == false` regardless of
   * what was configured before. Only `recompositionTrackingConfigured` is reset
   * here — `recompositionTrackingEnabled` is deliberately left as the last
   * requested value, so the next `setRecompositionTrackingEnabled(true)` call
   * (every non-read-only observe makes one, via `HierarchyCollector.collect`)
   * re-sends the frame on the new connection instead of comparing against a
   * value the caller never changed and skipping it.
   */
  resetConnectionScopedState(): void {
    this.recompositionTrackingConfigured = false;
    this.correlatedFramesSeen = false;
  }

  /** Reject every correlated hierarchy wait when its WebSocket connection closes. */
  rejectAllPendingHierarchy(reason: string): void {
    // Each disconnect removes its entries during waitForFreshData cleanup. A socket close is
    // transient, so it must not be surfaced as a runner-reported error in diagnostics.
    const pending = [...this.pendingHierarchyRejectors.values()];
    for (const rejector of pending) {
      rejector.disconnect();
    }
    if (pending.length > 0) {
      logger.debug(
        `[CTRL_PROXY] ${pending.length} hierarchy waits settled on disconnect: ${reason}`,
      );
    }
  }

  /**
   * Check if there is cached hierarchy data
   */
  hasCachedHierarchy(): boolean {
    return this.context.getCachedHierarchy() !== null;
  }

  /**
   * Invalidate the cached hierarchy data.
   * This forces the next getHierarchy call to wait for fresh data.
   * Should be called after any action that modifies the UI (like setText, swipe, tap).
   */
  invalidateCache(): void {
    const cached = this.context.getCachedHierarchy();
    if (cached) {
      logger.debug("[CTRL_PROXY] Invalidating cached hierarchy");
      this.context.setCachedHierarchy(null);
    }
  }

  /**
   * Get the latest hierarchy from cache or wait for fresh data
   * @param waitForFresh - If true, wait up to timeout for fresh data
   * @param timeout - Maximum time to wait for fresh data in milliseconds
   * @param perf - Performance tracker for timing
   * @param skipWaitForFresh - If true, skip waiting for fresh data entirely (go straight to sync)
   * @param minTimestamp - If provided, cached data must have updatedAt >= this value to be considered fresh
   * @returns Promise<AccessibilityHierarchyResponse>
   */
  async getLatestHierarchy(
    waitForFresh: boolean = false,
    timeout: number = DEFAULT_FRESH_WAIT_MS,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    signal?: AbortSignal,
  ): Promise<HierarchyLookupResult> {
    const startTime = this.context.timer.now();
    let cachedHierarchy = this.context.getCachedHierarchy();

    this.logLatestHierarchyRequest({
      cachedHierarchy,
      waitForFresh,
      skipWaitForFresh,
      minTimestamp,
    });

    try {
      // Ensure WebSocket connection is established. `ensureConnected` takes no
      // signal and its handshake is allowed 5000ms, so awaiting it bare would
      // leave every caller-owned bound tighter than that (the #6866
      // embedded-observation settle gate advertises 1s) enforcing nothing until
      // the handshake resolved on its own — this read's own `throwIfAborted`
      // checkpoints all sit BELOW it. Let the signal end the wait instead; the
      // catch below degrades it to the same no-hierarchy answer as every other
      // failure here (#6890 review).
      const connected = await perf.track("ensureConnection", () =>
        awaitWhileRequestIsLive(this.context.ensureConnected(perf), signal),
      );
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection");
        return {
          hierarchy: null,
          fresh: false,
        };
      }

      const livenessTimeoutMs = Math.max(0, timeout - (this.context.timer.now() - startTime));
      const cachedPackageRunning =
        cachedHierarchy &&
        (await this.isCachedPackageRunning(cachedHierarchy, livenessTimeoutMs, signal));
      throwIfAborted(signal);
      const reconcileCache = (): void => {
        const currentCachedHierarchy = this.context.getCachedHierarchy();
        if (currentCachedHierarchy !== cachedHierarchy) {
          cachedHierarchy = currentCachedHierarchy;
        } else if (cachedHierarchy && !cachedPackageRunning) {
          logger.warn(
            `[CTRL_PROXY] Invalidating cached hierarchy for non-running package ${cachedHierarchy.hierarchy.packageName}`,
          );
          this.invalidateCache();
          cachedHierarchy = null;
        }
      };
      reconcileCache();

      const readCache = (): HierarchyLookupResult | null => {
        // If we have cached data and not waiting for fresh, return it immediately
        if (cachedHierarchy && !waitForFresh) {
          const cacheResponse = this.getCachedHierarchyResponse(
            cachedHierarchy,
            minTimestamp,
            startTime,
          );
          if (cacheResponse) {
            return cacheResponse;
          }
        }
        return null;
      };
      const cacheResponse = readCache();
      if (cacheResponse) {
        return cacheResponse;
      }

      // Wait for fresh data if requested (unless skipped or recently timed out).
      // A rejected cache (too old for `minTimestamp`) needs a newer tree. The
      // sync fallback below re-extracts one on the runner (a fresh `updatedAt`)
      // just as a push would; note the sync result is reported fresh without a
      // `minTimestamp` re-check, as it always was. It therefore
      // does NOT override `skipWaitForFresh`: a caller that skips the wait with
      // a minTimestamp (the attribution recapture) goes straight to sync instead
      // of burning the full wait on a static screen that pushes nothing (#6099).
      const shouldWaitForHierarchy = (): boolean => {
        const cacheRejected =
          minTimestamp > 0 &&
          cachedHierarchy &&
          !this.evaluateMinTimestamp(cachedHierarchy, minTimestamp, true).isFresh;
        const shouldWait =
          (waitForFresh || cacheRejected) && !skipWaitForFresh && !this.shouldSkipWebSocketWait();
        return !!shouldWait;
      };
      const shouldWait = shouldWaitForHierarchy();
      if (shouldWait) {
        throwIfAborted(signal);
        const { waitMinTimestamp, useDeviceTimestamp, remainingWaitMs } =
          this.prepareFreshHierarchyWait(minTimestamp, timeout, startTime);

        const freshData = await perf.track("waitForFresh", () =>
          this.waitForFreshData(remainingWaitMs, waitMinTimestamp, useDeviceTimestamp, signal),
        );
        const duration = this.context.timer.now() - startTime;

        const waitedResponse = this.getWaitedHierarchyResponse(freshData, duration);
        if (waitedResponse) {
          return waitedResponse;
        }
      } else {
        this.logSkippedHierarchyWait(skipWaitForFresh);
      }

      // No cached data available
      logger.debug("[CTRL_PROXY] No cached hierarchy data available");
      return {
        hierarchy: null,
        fresh: false,
      };
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Failed to get hierarchy after ${duration}ms: ${error}`);
      return {
        hierarchy: null,
        fresh: false,
      };
    }
  }

  private prepareFreshHierarchyWait(
    minTimestamp: number,
    timeout: number,
    startTime: number,
  ): {
    waitMinTimestamp: number;
    useDeviceTimestamp: boolean;
    remainingWaitMs: number;
  } {
    const waitMinTimestamp = minTimestamp > 0 ? minTimestamp : startTime;
    const useDeviceTimestamp = minTimestamp > 0;
    const remainingWaitMs = Math.max(0, timeout - (this.context.timer.now() - startTime));
    logger.debug(
      `[CTRL_PROXY] Waiting up to ${remainingWaitMs}ms for fresh hierarchy data (must be newer than ${waitMinTimestamp})`,
    );
    return { waitMinTimestamp, useDeviceTimestamp, remainingWaitMs };
  }

  private logLatestHierarchyRequest(options: {
    cachedHierarchy: CachedHierarchy | null;
    waitForFresh: boolean;
    skipWaitForFresh: boolean;
    minTimestamp: number;
  }): void {
    const { cachedHierarchy, waitForFresh, skipWaitForFresh, minTimestamp } = options;
    logger.debug(
      `[CTRL_PROXY] getLatestHierarchy: cache=${cachedHierarchy ? "exists" : "null"}, waitForFresh=${waitForFresh}, skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp}`,
    );
  }

  private logSkippedHierarchyWait(skipWaitForFresh: boolean): void {
    if (skipWaitForFresh || this.shouldSkipWebSocketWait()) {
      logger.debug(
        `[CTRL_PROXY] Skipping WebSocket wait (skipWaitForFresh=${skipWaitForFresh}, recentTimeout=${this.shouldSkipWebSocketWait()})`,
      );
    }
  }

  private getWaitedHierarchyResponse(
    freshData: CachedHierarchy | null,
    duration: number,
  ): HierarchyLookupResult | null {
    if (freshData) {
      return this.getFreshHierarchyResponse(freshData, duration);
    }
    return this.getTimedOutHierarchyResponse(duration);
  }

  private getTimedOutHierarchyResponse(duration: number): HierarchyLookupResult | null {
    // Record timeout so we skip WebSocket wait for a while
    this.context.setLastWebSocketTimeout(this.context.timer.now());
    logger.warn(
      `[CTRL_PROXY] Timeout waiting for fresh data after ${duration}ms, will skip WebSocket wait for ${WEBSOCKET_TIMEOUT_COOLDOWN_MS}ms`,
    );

    // Return cached data if available
    const currentCache = this.context.getCachedHierarchy();
    if (currentCache) {
      return this.getStaleHierarchyResponse(currentCache);
    }
    return null;
  }

  private getStaleHierarchyResponse(currentCache: CachedHierarchy): HierarchyLookupResult {
    // Update tracking from cache — it may have been refreshed by a WebSocket push
    if (currentCache.hierarchy.packageName) {
      if (
        this.lastKnownPackageName &&
        currentCache.hierarchy.packageName !== this.lastKnownPackageName
      ) {
        logger.warn(
          `[CTRL_PROXY] Stale cache packageName differs: cached=${currentCache.hierarchy.packageName}, lastKnown=${this.lastKnownPackageName}`,
        );
      }
      this.lastKnownPackageName = currentCache.hierarchy.packageName;
    }
    currentCache.fresh = false;
    logger.debug(
      `[CTRL_PROXY] Returning stale cached data (updatedAt: ${currentCache.hierarchy.updatedAt}), marked cache as stale`,
    );
    return {
      hierarchy: currentCache.hierarchy,
      fresh: false,
      updatedAt: currentCache.hierarchy.updatedAt,
      receivedAt: currentCache.receivedAt,
      perfTiming: currentCache.perfTiming,
      frameContext: currentCache.frameContext,
    };
  }

  private getFreshHierarchyResponse(
    freshData: CachedHierarchy,
    duration: number,
  ): HierarchyLookupResult {
    if (freshData.hierarchy.packageName) {
      this.lastKnownPackageName = freshData.hierarchy.packageName;
    }
    logger.debug(
      `[CTRL_PROXY] Received fresh hierarchy in ${duration}ms (updatedAt: ${freshData.hierarchy.updatedAt})`,
    );
    return {
      hierarchy: freshData.hierarchy,
      fresh: true,
      updatedAt: freshData.hierarchy.updatedAt,
      receivedAt: freshData.receivedAt,
      perfTiming: freshData.perfTiming,
      frameContext: freshData.frameContext,
    };
  }

  private getCachedHierarchyResponse(
    cachedHierarchy: CachedHierarchy,
    minTimestamp: number,
    startTime: number,
  ): HierarchyLookupResult | null {
    const cacheAge = this.context.timer.now() - cachedHierarchy.receivedAt;
    const updatedAt = cachedHierarchy.hierarchy.updatedAt;

    // If minTimestamp is set, check if cached data is too old
    if (minTimestamp > 0) {
      const freshness = this.evaluateMinTimestamp(cachedHierarchy, minTimestamp, true);

      if (!freshness.isFresh) {
        const staleReference = freshness.usesUpdatedAt
          ? freshness.updatedAt
          : cachedHierarchy.receivedAt;
        logger.debug(
          `[CTRL_PROXY] Cache rejected: ${freshness.usesUpdatedAt ? "updatedAt" : "receivedAt"} ${staleReference} < ${minTimestamp}`,
        );
        // Fall through to wait for fresh data or sync
      } else {
        const withinCacheServeWindow = cacheAge < Math.min(1000, maxObservationAgeMs());
        const duration = this.context.timer.now() - startTime;
        logger.debug(
          `[CTRL_PROXY] Cache accepted in ${duration}ms: ` +
            `receivedAt=${cachedHierarchy.receivedAt}, ` +
            `updatedAt=${updatedAt}, age=${cacheAge}ms, withinServeWindow=${withinCacheServeWindow}`,
        );

        return {
          hierarchy: cachedHierarchy.hierarchy,
          fresh: false,
          withinCacheServeWindow,
          updatedAt: updatedAt,
          receivedAt: cachedHierarchy.receivedAt,
          perfTiming: cachedHierarchy.perfTiming,
          frameContext: cachedHierarchy.frameContext,
        };
      }
    } else {
      // No minTimestamp check, return cache
      const withinCacheServeWindow = cacheAge < Math.min(1000, maxObservationAgeMs());
      const duration = this.context.timer.now() - startTime;
      logger.debug(
        `[CTRL_PROXY] Cache hit: ${duration}ms (age: ${cacheAge}ms, withinServeWindow: ${withinCacheServeWindow}, updatedAt: ${updatedAt})`,
      );

      return {
        hierarchy: cachedHierarchy.hierarchy,
        fresh: false,
        withinCacheServeWindow,
        updatedAt: updatedAt,
        receivedAt: cachedHierarchy.receivedAt,
        perfTiming: cachedHierarchy.perfTiming,
        frameContext: cachedHierarchy.frameContext,
      };
    }
    return null;
  }

  /**
   * A cached hierarchy whose package no longer has a process cannot be
   * recovered by waiting for a WebSocket push. Drop it before any cache-hit or
   * stale-fallback path so the next request resolves the device window again.
   */
  private async isCachedPackageRunning(
    cachedHierarchy: CachedHierarchy,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const packageName = cachedHierarchy.hierarchy.packageName;
    if (!packageName || !/^[A-Za-z0-9._]+$/.test(packageName)) {
      return true;
    }

    try {
      const result = await this.context.adb.executeCommand(
        "shell dumpsys activity processes",
        timeoutMs,
        DUMPSYS_MAX_BUFFER,
        true,
        signal,
      );
      return isAndroidPackageRunning(result.stdout, packageName, cachedHierarchy.hierarchy.userId);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Liveness is best-effort; an ADB error must not destroy otherwise usable
      // cache state when process presence could not be determined.
      logger.debug(
        `[CTRL_PROXY] Could not verify cached package ${packageName} is running: ${error}`,
      );
      return true;
    }
  }

  /**
   * Get view hierarchy from accessibility service.
   * This is the main entry point for getting hierarchy data from the accessibility service.
   *
   * @param readOptions - Optional read policy or overall budget. The budget bounds BOTH the
   *   WebSocket fresh-data wait and the ADB sync fallback, so a caller working
   *   against its own deadline (e.g. the keyboard state confirmation poll) cannot
   *   be blocked past that deadline by the 10s `requestHierarchySync` default.
   */
  async getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    disableAllFiltering: boolean = false,
    signal?: AbortSignal,
    readOptions?: number | HierarchyReadOptions,
  ): Promise<ViewHierarchyResult | null> {
    const { timeoutMs, requireFreshExtraction } = this.getHierarchyReadPolicy(readOptions);
    const startTime = this.context.timer.now();
    const cachedHierarchy = this.context.getCachedHierarchy();

    perf.serial("a11yService");

    try {
      throwIfAborted(signal);
      // Check if service is available
      const available = await perf.track("checkAvailable", () =>
        AndroidCtrlProxyManager.getInstance(this.context.device, this.context.adb).isAvailable(),
      );
      if (!available) {
        logger.debug("[CTRL_PROXY] Service not available, will use fallback");
        perf.end();
        return null;
      }

      // Get hierarchy from WebSocket service
      const waitForFresh = this.shouldWaitForFreshCache(skipWaitForFresh, cachedHierarchy);
      // `timeoutMs` is the caller's overall budget, not a per-step allowance, so
      // the wait gets what is LEFT of it. Starting from the original value would
      // let a slow availability check or reconnect be followed by another full
      // fresh wait, blowing the deadline this parameter exists to protect.
      const freshWaitMs = this.getFreshHierarchyWaitBudget(timeoutMs, startTime);
      const response = await perf.track("getHierarchy", () =>
        this.getLatestHierarchy(
          waitForFresh,
          freshWaitMs,
          perf,
          skipWaitForFresh,
          minTimestamp,
          signal,
        ),
      );

      let hierarchyData = response.hierarchy;
      let isFresh = response.fresh;
      let androidPerfTiming = response.perfTiming;
      let frameContext = response.frameContext;
      // Host-clock-domain receipt time, so observation age is not computed by
      // subtracting the device-authored `updatedAt` from host `now` across a
      // skewed emulator clock (issue #5377). Cache hits carry their original
      // receipt time; a fresh sync below re-stamps it to the current host clock.
      let receivedAt = response.receivedAt;

      const applySyncResult = (syncResult: NonNullable<HierarchySyncResult>): void => {
        hierarchyData = syncResult.hierarchy;
        if (syncResult.perfTiming) {
          androidPerfTiming = syncResult.perfTiming;
        }
        frameContext = syncResult.frameContext;
        // The sync wait correlates on host receipt time, so a late push of a
        // tree captured BEFORE `minTimestamp` can land in its window. Honor the
        // caller's device-timestamp floor here rather than reporting such a
        // tree fresh (#6099).
        isFresh = this.satisfiesMinTimestamp(hierarchyData.updatedAt, minTimestamp);
        receivedAt = this.context.timer.now();
        if (hierarchyData.packageName) {
          this.lastKnownPackageName = hierarchyData.packageName;
        }
        logger.debug("[CTRL_PROXY] Successfully retrieved hierarchy via sync ADB method");
      };

      // The embedded gate needs independent evidence for each floor-bearing poll (#9579).
      // Other callers retain cache service even when they skip the push wait.
      const needsSync = this.needsHierarchySync(
        hierarchyData,
        isFresh,
        response,
        requireFreshExtraction,
        minTimestamp,
      );
      if (needsSync) {
        logger.debug(
          `[CTRL_PROXY] WebSocket returned ${hierarchyData ? "stale" : "no"} data (fresh=${isFresh}), syncing for fresh data`,
        );

        const syncDiagnostics: HierarchySyncDiagnostics = {};
        // Spend only what is left of the caller's budget on the sync fallback; the
        // default is 10s, which would blow a short deadline on its own.
        const syncTimeoutMs =
          timeoutMs === undefined
            ? undefined
            : Math.max(0, timeoutMs - (this.context.timer.now() - startTime));
        const syncResult = await perf.track("syncRequest", () =>
          this.requestHierarchySync(
            perf,
            disableAllFiltering,
            signal,
            syncTimeoutMs,
            syncDiagnostics,
          ),
        );

        if (syncResult) {
          applySyncResult(syncResult);
        } else if (!hierarchyData) {
          this.reportHierarchySyncFailure(syncDiagnostics, perf);
          return null;
        }
      }

      // Convert to expected format
      const convertedHierarchy = await perf.track("convert", () =>
        Promise.resolve(this.convertToViewHierarchyResult(hierarchyData!)),
      );

      this.applyHierarchyResultMetadata(convertedHierarchy, {
        hierarchyData: hierarchyData!,
        receivedAt,
        frameContext,
        isFresh,
        androidPerfTiming,
        perf,
      });

      perf.end();

      const duration = this.context.timer.now() - startTime;
      logger.debug(
        `[CTRL_PROXY] Successfully retrieved and converted hierarchy in ${duration}ms (fresh: ${isFresh}, updatedAt: ${hierarchyData!.updatedAt})`,
      );

      return convertedHierarchy;
    } catch (error) {
      perf.end();
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] getAccessibilityHierarchy failed after ${duration}ms: ${error}`);
      return null;
    }
  }

  private shouldWaitForFreshCache(
    skipWaitForFresh: boolean,
    cachedHierarchy: CachedHierarchy | null,
  ): boolean {
    return !skipWaitForFresh && (cachedHierarchy === null || !cachedHierarchy.fresh);
  }

  private reportHierarchySyncFailure(
    syncDiagnostics: HierarchySyncDiagnostics,
    perf: PerformanceTracker,
  ): void {
    // Surface the runner's structured error text when the sync failed on a correlated runner
    // error frame, so the fallback is attributable rather than an anonymous timeout (#3062).
    const runnerErrorSuffix = syncDiagnostics.runnerError
      ? ` (runner error: ${syncDiagnostics.runnerError})`
      : "";
    logger.warn(
      `[CTRL_PROXY] Both WebSocket and sync methods failed, will use fallback${runnerErrorSuffix}`,
    );
    perf.end();
  }

  private getFreshHierarchyWaitBudget(timeoutMs: number | undefined, startTime: number): number {
    return timeoutMs === undefined
      ? DEFAULT_FRESH_WAIT_MS
      : Math.max(
          0,
          Math.min(DEFAULT_FRESH_WAIT_MS, timeoutMs - (this.context.timer.now() - startTime)),
        );
  }

  private getHierarchyReadPolicy(readOptions?: number | HierarchyReadOptions): {
    timeoutMs?: number;
    requireFreshExtraction: boolean;
  } {
    const timeoutMs = typeof readOptions === "number" ? readOptions : readOptions?.timeoutMs;
    const requireFreshExtraction =
      typeof readOptions === "object" && readOptions.requireFreshExtraction === true;
    return { timeoutMs, requireFreshExtraction };
  }

  private needsHierarchySync(
    hierarchyData: AccessibilityHierarchy | null,
    isFresh: boolean,
    response: HierarchyLookupResult,
    requireFreshExtraction: boolean,
    minTimestamp: number,
  ): boolean {
    return (
      !hierarchyData ||
      (!isFresh && !response.withinCacheServeWindow) ||
      (!isFresh && requireFreshExtraction && minTimestamp > 0)
    );
  }

  private applyHierarchyResultMetadata(
    convertedHierarchy: ViewHierarchyResult,
    options: {
      hierarchyData: AccessibilityHierarchy;
      receivedAt?: number;
      frameContext?: string;
      isFresh: boolean;
      androidPerfTiming?: AndroidPerfTiming[];
      perf: PerformanceTracker;
    },
  ): void {
    const { hierarchyData, receivedAt, frameContext, isFresh, androidPerfTiming, perf } = options;
    // Add the device timestamp to the result
    if (hierarchyData.updatedAt) {
      convertedHierarchy.updatedAt = hierarchyData.updatedAt;
    }
    // Carry the host-domain receipt time so ObserveScreen can measure age
    // without crossing clock domains (issue #5377).
    if (receivedAt !== undefined) {
      convertedHierarchy.receivedAt = receivedAt;
    }
    if (frameContext !== undefined) {
      convertedHierarchy.frameContext = frameContext;
    }
    // Preserve the Android delegate's cache/sync verdict. Without it,
    // ObserveScreen compares the device-authored updatedAt against host time,
    // so clock skew can turn a freshly verified hierarchy into a false stale.
    convertedHierarchy.fresh = isFresh;

    // Merge Android-side performance timing
    if (androidPerfTiming && androidPerfTiming.length > 0) {
      perf.addExternalTiming("androidPerf", androidPerfTiming as TimingEntry[]);
    }
  }

  /**
   * Request hierarchy synchronously via WebSocket message.
   * Triggers extraction on device which pushes result via WebSocket.
   * Falls back to ADB broadcast if WebSocket send fails.
   */
  async requestHierarchySync(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    disableAllFiltering: boolean = false,
    signal?: AbortSignal,
    timeoutMs: number = 10000,
    diagnostics?: HierarchySyncDiagnostics,
    displayId?: number,
  ): Promise<HierarchySyncResult> {
    return this.requestHierarchySyncWithOptions({
      perf,
      disableAllFiltering,
      signal,
      timeoutMs,
      diagnostics,
      displayId,
      observerMode: false,
    });
  }

  requestHierarchySyncForObserver(
    perf: PerformanceTracker,
    disableAllFiltering: boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    display?: number | ObserverHierarchyRequestOptions,
  ): Promise<HierarchySyncResult> {
    return this.requestHierarchySyncWithOptions({
      perf,
      disableAllFiltering,
      signal,
      timeoutMs,
      ...(typeof display === "number" ? { displayId: display } : display),
      observerMode: true,
    });
  }

  async requestHierarchySyncWithOptions(options: {
    perf: PerformanceTracker;
    disableAllFiltering: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
    diagnostics?: HierarchySyncDiagnostics;
    displayId?: number;
    observerMode: boolean;
    /** Synchronous registration before WS send or ADB broadcast; called again on fallback. */
    onRequestId?: (requestId: string) => void;
    preserveDisplayState?: boolean;
  }): Promise<HierarchySyncResult> {
    const { perf, disableAllFiltering, signal, timeoutMs, diagnostics, displayId, observerMode } =
      options;
    const preserveDisplayState = options.preserveDisplayState === true;
    const startTime = this.context.timer.now();
    const effectiveTimeoutMs = Math.max(0, timeoutMs);

    try {
      throwIfAborted(signal);
      if (options.onRequestId) {
        // Suppression belongs to one caller and one wire response. Isolate these requests from
        // shared flights in BOTH directions so an ordinary caller cannot lose its stream push.
        return await awaitWhileRequestIsLive(
          this.runHierarchySync(
            perf,
            disableAllFiltering,
            signal ?? new AbortController().signal,
            effectiveTimeoutMs,
            diagnostics ?? {},
            {
              startTime,
              displayId,
              observerMode,
              preserveDisplayState,
              onRequestId: options.onRequestId,
            },
          ),
          signal,
        );
      }
      // The wait accepts cache entries received at or after its dispatch floor. A flight with
      // an earlier floor could return data too old for this caller, so it cannot be joined.
      // Keep timeout budgets equal so joining does not shorten or extend either caller's wait.
      let flight = [...this.hierarchySyncFlights].find(
        (candidate) =>
          candidate.disableAllFiltering === disableAllFiltering &&
          candidate.observerMode === observerMode &&
          candidate.preserveDisplayState === preserveDisplayState &&
          candidate.displayId === displayId &&
          candidate.minReceivedAt >= startTime &&
          candidate.timeoutMs === effectiveTimeoutMs,
      );
      if (!flight) {
        const controller = new AbortController();
        const sharedDiagnostics: HierarchySyncDiagnostics = {};
        flight = {
          disableAllFiltering,
          observerMode,
          preserveDisplayState,
          displayId,
          minReceivedAt: startTime,
          timeoutMs: effectiveTimeoutMs,
          controller,
          waiters: 0,
          diagnostics: sharedDiagnostics,
          promise: this.runHierarchySync(
            perf,
            disableAllFiltering,
            controller.signal,
            effectiveTimeoutMs,
            sharedDiagnostics,
            { startTime, displayId, observerMode, preserveDisplayState },
          ),
        };
        const createdFlight = flight;
        flight.promise = flight.promise.finally(() => {
          this.hierarchySyncFlights.delete(createdFlight);
        });
        this.hierarchySyncFlights.add(flight);
      }

      flight.waiters += 1;
      try {
        const result = await awaitWhileRequestIsLive(flight.promise, signal);
        this.copyFlightDiagnostics(flight.diagnostics, diagnostics);
        return result;
      } finally {
        flight.waiters -= 1;
        if (flight.waiters === 0) {
          // Only the final detached caller stops work; one abort cannot cancel another caller.
          this.hierarchySyncFlights.delete(flight);
          flight.controller.abort();
        }
      }
    } catch (error) {
      if (diagnostics) {
        diagnostics.failureReason = errorMessage(signal?.aborted ? signal.reason : error);
      }
      logger.warn(`[CTRL_PROXY] Sync hierarchy caller stopped: ${errorMessage(error)}`, error);
      return null;
    }
  }

  private copyFlightDiagnostics(
    source: HierarchySyncDiagnostics,
    target: HierarchySyncDiagnostics | undefined,
  ): void {
    if (source.runnerError && target) {
      target.runnerError = source.runnerError;
    }
    if (source.failureReason && target) {
      target.failureReason = source.failureReason;
    }
  }

  private async runHierarchySync(
    perf: PerformanceTracker,
    disableAllFiltering: boolean,
    signal: AbortSignal,
    effectiveTimeoutMs: number,
    diagnostics: HierarchySyncDiagnostics,
    request: {
      startTime: number;
      displayId?: number;
      observerMode: boolean;
      onRequestId?: (requestId: string) => void;
      preserveDisplayState: boolean;
    },
  ): Promise<HierarchySyncResult> {
    const { startTime, displayId, observerMode, preserveDisplayState } = request;
    try {
      logger.debug("[CTRL_PROXY] Requesting hierarchy sync via WebSocket");

      // Ensure WebSocket connection is established. Signal-fenced for the same
      // reason as `getLatestHierarchy` above: an uninterruptible 5000ms
      // handshake must not outlive the caller's deadline, and a sync
      // extraction must never be dispatched after it expired (#6890 review).
      const connected = await this.connectForHierarchySync(perf, signal, observerMode);
      throwIfAborted(signal);
      if (!connected) {
        diagnostics.failureReason = "Failed to establish CtrlProxy WebSocket connection";
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection");
        return null;
      }

      // Try WebSocket request first (faster path). Returns the correlating requestId when sent so a
      // runner type:"error" frame for this hierarchy request can reject the wait fast (issue #3032).
      const dispatchSocket = this.context.getWebSocket();
      const hierarchyRequestId = await perf.track("sendWsRequest", async () => {
        return this.sendHierarchyRequest({
          disableAllFiltering,
          displayId,
          observerMode,
          preserveDisplayState,
          onRequestId: request.onRequestId,
        });
      });

      // Fall back to ADB broadcast if WebSocket failed. The broadcast mints its own `sync_` uuid and
      // passes it to the runner via `--es uuid`; we thread that SAME uuid into the wait below so a
      // runner type:"error" frame echoing it fails fast, mirroring the `req_`/`stale_` WebSocket
      // paths (issue #3089). Kept null when the WebSocket send succeeded (that path correlates on
      // its own `req_` id).
      let broadcastRequestId: string | null = null;
      if (hierarchyRequestId === null) {
        if (observerMode) {
          throw new ActionableError(
            "Observer hierarchy read requires a connected CtrlProxy socket",
          );
        }
        if (displayId !== undefined) {
          throw new Error(
            `Unable to request hierarchy for Android display ${displayId}: CtrlProxy WebSocket is unavailable`,
          );
        }
        logger.debug("[CTRL_PROXY] Falling back to ADB broadcast");
        const uuid = `sync_${this.context.timer.now()}_${generateSecureId()}`;
        broadcastRequestId = uuid;
        request.onRequestId?.(uuid);
        await perf.track("sendBroadcast", async () => {
          await this.context.adb.executeCommand(
            `shell "am broadcast -a dev.jasonpearson.automobile.EXTRACT_HIERARCHY --es uuid ${uuid} --ez disableAllFiltering ${disableAllFiltering}"`,
            undefined,
            undefined,
            undefined,
            signal,
          );
        });
      }

      // Wait for WebSocket push, correlated with whichever request id we actually sent: the `req_`
      // id when the WebSocket send succeeded (issue #3032), or the ADB-broadcast `sync_` uuid when we
      // fell back (issue #3089). A runner type:"error" frame carrying that id unblocks the wait fast
      // instead of hanging to timeout. Note the broadcast fallback only reaches this correlation when
      // the WebSocket is still readable (a transient send failure / flap) — a fully disconnected
      // socket returned above before the fallback. A correlated runner error still returns null,
      // so the caller keeps its stale-cache fallback (see
      // getAccessibilityHierarchy) — nothing is discarded here.
      const correlationRequestId = hierarchyRequestId ?? broadcastRequestId ?? undefined;
      const freshData = await this.awaitSyncReply(
        () =>
          perf.track("waitForPush", () =>
            this.waitForFreshData(
              effectiveTimeoutMs,
              startTime,
              false,
              signal,
              correlationRequestId,
              {
                dispatchSocket,
                // A stale nudge has a separate id and stream push; it cannot finish a suppressed
                // caller and release the primary response's token before that response arrives.
                allowStaleResponse:
                  !request.onRequestId &&
                  !observerMode &&
                  !disableAllFiltering &&
                  displayId === undefined,
                observerMode,
                displayId,
                diagnostics,
              },
            ),
          ),
        correlationRequestId,
        observerMode,
      );

      if (freshData) {
        const duration = this.context.timer.now() - startTime;
        logger.debug(
          `[CTRL_PROXY] Sync complete: ${duration}ms (updatedAt: ${freshData.hierarchy.updatedAt})`,
        );
        return {
          hierarchy: freshData.hierarchy,
          perfTiming: freshData.perfTiming,
          frameContext: freshData.frameContext,
        };
      }

      diagnostics.failureReason ??= "Hierarchy service did not answer the sync request";
      logger.warn(`[CTRL_PROXY] Sync hierarchy read failed: ${diagnostics.failureReason}`);
      return null;
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      // A correlated runner type:"error" frame (issue #3032 / #3061) rejects the wait with a typed
      // HierarchyRunnerError. Surface its text on the caller-provided diagnostics so the caller can
      // tell this deterministic handler failure apart from a plain timeout `null` (issue #3062).
      if (error instanceof HierarchyRunnerError) {
        diagnostics.runnerError = error.runnerError;
        diagnostics.failureReason = `runner error: ${error.runnerError}`;
      } else {
        diagnostics.failureReason = errorMessage(error);
      }
      logger.warn(
        `[CTRL_PROXY] Sync hierarchy request failed after ${duration}ms: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }

  private async connectForHierarchySync(
    perf: PerformanceTracker,
    signal: AbortSignal,
    observerMode: boolean,
  ): Promise<boolean> {
    if (observerMode) {
      return this.context.getWebSocket()?.readyState === WebSocket.OPEN;
    }
    return await awaitWhileRequestIsLive(this.context.ensureConnected(perf), signal);
  }

  /**
   * Convert accessibility service hierarchy format to ViewHierarchyResult format.
   */
  convertToViewHierarchyResult(
    accessibilityHierarchy: AccessibilityHierarchy,
  ): ViewHierarchyResult {
    const startTime = this.context.timer.now();

    try {
      logger.debug(
        "[CTRL_PROXY] Converting accessibility service format to ViewHierarchyResult format",
      );

      const hierarchyToConvert: AccessibilityNode | undefined = accessibilityHierarchy.hierarchy;
      const resolvedPackageName = accessibilityHierarchy.packageName;

      if (!hierarchyToConvert) {
        const errorMessage =
          accessibilityHierarchy.error ||
          "Accessibility hierarchy missing from accessibility service";
        return {
          captureSequence: accessibilityHierarchy.captureSequence,
          displayId: accessibilityHierarchy.displayId,
          panelUniqueId: accessibilityHierarchy.panelUniqueId,
          hierarchy: {
            error: errorMessage,
          },
          packageName: resolvedPackageName,
          windows: accessibilityHierarchy.windows,
          contentHiddenRegions: accessibilityHierarchy.contentHiddenRegions,
          intentChooserDetected: accessibilityHierarchy.intentChooserDetected,
          notificationPermissionDetected: accessibilityHierarchy.notificationPermissionDetected,
          ctrlProxyIncomplete: accessibilityHierarchy.ctrlProxyIncomplete,
          ctrlProxyIncompleteReason: accessibilityHierarchy.ctrlProxyIncompleteReason,
          truncationReasons: accessibilityHierarchy.truncationReasons,
          sources: ["control-proxy"],
          screenWidth: accessibilityHierarchy.screenWidth,
          screenHeight: accessibilityHierarchy.screenHeight,
          rotation: accessibilityHierarchy.rotation,
          systemInsets: accessibilityHierarchy.systemInsets,
          insets: accessibilityHierarchy.insets,
          // The API level decides whether a rootless incomplete capture can be Android 14+
          // data-sensitive withholding (issue #6151), so keep it on this branch too.
          sdkInt: accessibilityHierarchy.sdkInt,
          // Carry the #4548 scale metadata through the rootless / UIAutomator-fallback branch too,
          // so #4549 can consume it regardless of which route produced the hierarchy. Same
          // all-or-nothing validator as the main return and client retention.
          ...screenScaleMetadataSpread(accessibilityHierarchy),
        } as ViewHierarchyResult;
      }

      // Convert the accessibility node format
      const convertedHierarchy = this.convertAccessibilityNode(hierarchyToConvert);

      // Capture-layer stable node identity (issue #3228): rewrite the runner's
      // positional (path-derived UUID) view-ids into content-derived stable ids
      // so id-less rows keep their identity across a scroll and the diff
      // layer's content-identity re-pair can collapse scroll churn.
      const hierarchyViewIdRewrites = assignStableViewIds(convertedHierarchy);

      // Convert accessibility-focused element if present
      const accessibilityFocusedElement = accessibilityHierarchy["accessibility-focused-element"]
        ? this.convertAccessibilityNode(accessibilityHierarchy["accessibility-focused-element"])
        : undefined;
      // Reuse the hierarchy rewrite map first so mirror links point at the exact
      // ids emitted in the hierarchy, including occluders outside the mirror.
      applyStableViewIdRewrites(accessibilityFocusedElement, hierarchyViewIdRewrites);
      // Fallback for mirrors that contain generated ids absent from the hierarchy
      // map; resource-id-backed and already-rewritten ids are left untouched.
      assignStableViewIds(accessibilityFocusedElement);

      const result: ViewHierarchyResult = {
        captureSequence: accessibilityHierarchy.captureSequence,
        displayId: accessibilityHierarchy.displayId,
        panelUniqueId: accessibilityHierarchy.panelUniqueId,
        hierarchy: convertedHierarchy,
        packageName: resolvedPackageName,
        windows: linkWindowRoots(convertedHierarchy, accessibilityHierarchy.windows),
        contentHiddenRegions: accessibilityHierarchy.contentHiddenRegions,
        intentChooserDetected: accessibilityHierarchy.intentChooserDetected,
        notificationPermissionDetected: accessibilityHierarchy.notificationPermissionDetected,
        "accessibility-focused-element": accessibilityFocusedElement,
        ctrlProxyIncomplete: accessibilityHierarchy.ctrlProxyIncomplete,
        ctrlProxyIncompleteReason: accessibilityHierarchy.ctrlProxyIncompleteReason,
        sources: ["control-proxy"],
        screenWidth: accessibilityHierarchy.screenWidth,
        screenHeight: accessibilityHierarchy.screenHeight,
        rotation: accessibilityHierarchy.rotation,
        systemInsets: accessibilityHierarchy.systemInsets,
        insets: accessibilityHierarchy.insets,
        wakefulness: accessibilityHierarchy.wakefulness,
        foregroundActivity: accessibilityHierarchy.foregroundActivity,
        density: accessibilityHierarchy.density,
        sdkInt: accessibilityHierarchy.sdkInt,
        deviceModel: accessibilityHierarchy.deviceModel,
        isEmulator: accessibilityHierarchy.isEmulator,
        truncationReasons: accessibilityHierarchy.truncationReasons,
        // Additive scale metadata (#4548), retained for #4549. All-or-nothing via the shared
        // validator (same rule as client retention): the three keys are spread only when the whole
        // tuple is complete-finite-positive, and omitted entirely otherwise — so a partial or
        // legacy payload (the runner serializes absent optionals as JSON null) stays byte-identical.
        ...screenScaleMetadataSpread(accessibilityHierarchy),
      };

      const duration = this.context.timer.now() - startTime;
      logger.debug(`[CTRL_PROXY] Format conversion completed in ${duration}ms`);

      return result;
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Format conversion failed after ${duration}ms: ${error}`);

      return {
        hierarchy: {
          error: "Failed to convert accessibility service hierarchy format",
        },
      } as ViewHierarchyResult;
    }
  }

  /**
   * Configure recomposition tracking on the accessibility service.
   */
  async setRecompositionTrackingEnabled(
    enabled: boolean,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.recompositionTrackingConfigured && this.recompositionTrackingEnabled === enabled) {
      return;
    }

    try {
      throwIfAborted(signal);
      const connected = await perf.track("ensureConnection", () =>
        awaitWhileRequestIsLive(this.context.ensureConnected(perf), signal),
      );
      throwIfAborted(signal);
      if (!connected) {
        logger.debug(
          "[CTRL_PROXY] Skipping recomposition tracking config; WebSocket not connected",
        );
        return;
      }

      const sent = this.sendRecompositionTrackingRequest(enabled);
      if (sent) {
        this.recompositionTrackingConfigured = true;
        this.recompositionTrackingEnabled = enabled;
        logger.info(`[CTRL_PROXY] Recomposition tracking ${enabled ? "enabled" : "disabled"}`);
      }
    } catch (error) {
      // Safe to swallow for #6932: the hierarchy read still proceeds without tracking this poll.
      logger.debug(`[CTRL_PROXY] Recomposition tracking config skipped: ${error}`);
    }
  }

  /**
   * Check if we should skip WebSocket wait due to recent timeout.
   */
  private shouldSkipWebSocketWait(): boolean {
    const lastTimeout = this.context.getLastWebSocketTimeout();
    if (lastTimeout === 0) {
      return false;
    }
    const timeSinceTimeout = this.context.timer.now() - lastTimeout;
    return timeSinceTimeout < WEBSOCKET_TIMEOUT_COOLDOWN_MS;
  }

  /**
   * Whether a device-stamped tree satisfies a caller's `minTimestamp` floor. A
   * caller with no floor, or a tree with no numeric stamp, is satisfied.
   */
  private satisfiesMinTimestamp(updatedAt: unknown, minTimestamp: number): boolean {
    if (minTimestamp <= 0 || typeof updatedAt !== "number" || Number.isNaN(updatedAt)) {
      return true;
    }
    if (updatedAt >= minTimestamp) {
      return true;
    }
    logger.warn(
      `[CTRL_PROXY] Sync returned a tree older than minTimestamp (updatedAt=${updatedAt}, minTimestamp=${minTimestamp}); reporting it stale`,
    );
    return false;
  }

  /**
   * Determine whether cached data satisfies a minTimestamp requirement.
   */
  private evaluateMinTimestamp(
    cachedHierarchy: CachedHierarchy,
    minTimestamp: number,
    useDeviceTimestamp: boolean,
  ): {
    isFresh: boolean;
    updatedAt?: number;
    updatedAfter: boolean;
    receivedAfter: boolean;
    usesUpdatedAt: boolean;
  } {
    const updatedAt = cachedHierarchy.hierarchy.updatedAt;
    const hasUpdatedAt = typeof updatedAt === "number" && !Number.isNaN(updatedAt);
    const shouldUseUpdatedAt = useDeviceTimestamp && hasUpdatedAt;
    const updatedAfter = shouldUseUpdatedAt ? updatedAt >= minTimestamp : false;
    const receivedAfter = !shouldUseUpdatedAt ? cachedHierarchy.receivedAt >= minTimestamp : false;
    return {
      isFresh: shouldUseUpdatedAt ? updatedAfter : receivedAfter,
      updatedAt,
      updatedAfter,
      receivedAfter,
      usesUpdatedAt: shouldUseUpdatedAt,
    };
  }

  /**
   * Run a sync reply wait and release its isolation marker when no reply can follow. An observer
   * request always releases. An owner read of another display keeps its marker through a timeout
   * or abort so the late reply is still recognised as isolated and dropped; only a runner error
   * frame (which answers the request) releases it. `handleHierarchyUpdate` consumes the marker
   * with the reply, a socket close clears it, and the client caps how many it retains.
   */
  private async awaitSyncReply(
    wait: () => Promise<CachedHierarchy | null>,
    requestId: string | undefined,
    observerMode: boolean,
  ): Promise<CachedHierarchy | null> {
    let releaseMarker = observerMode;
    try {
      return await wait();
    } catch (error) {
      releaseMarker ||= error instanceof HierarchyRunnerError;
      throw error;
    } finally {
      if (releaseMarker) {
        this.unmarkObserverRequest(true, requestId);
      }
    }
  }

  /**
   * Wait for fresh data to arrive via WebSocket.
   */
  private async waitForFreshData(
    timeout: number,
    minTimestamp: number,
    useDeviceTimestamp: boolean,
    signal?: AbortSignal,
    requestId?: string,
    options: {
      dispatchSocket?: WebSocket | null;
      allowStaleResponse: boolean;
      observerMode?: boolean;
      displayId?: number;
      diagnostics?: HierarchySyncDiagnostics;
    } = {
      allowStaleResponse: true,
    },
  ): Promise<CachedHierarchy | null> {
    const { dispatchSocket, allowStaleResponse, observerMode, displayId } = options;
    const diagnostics = options.diagnostics ?? {};
    const combinedSignal = combineWithAmbientAbort(signal);
    // Reject dispatch on a socket that closed or was replaced during ADB fallback.
    if (!this.isDispatchSocketValid(dispatchSocket)) {
      diagnostics.failureReason = "CtrlProxy WebSocket closed or changed before hierarchy wait";
      return null;
    }
    const waitSocket = dispatchSocket === undefined ? this.context.getWebSocket() : dispatchSocket;
    const startTime = this.context.timer.now();
    const checkInterval = 50;
    const screenCheckInterval = 1000;
    const staleCheckDelay = 2000;
    let lastScreenCheck = startTime;
    let screenCheckInProgress = false;
    let staleCheckSent = false;
    const isMatchingFresh = (hierarchy: CachedHierarchy, staleRequestId: string | null): boolean =>
      this.matchesFreshHierarchy(hierarchy, minTimestamp, useDeviceTimestamp, {
        requestId,
        staleRequestId,
        allowStaleResponse,
        observerMode,
        displayId,
      });

    return new Promise<CachedHierarchy | null>((resolve, reject) => {
      let settled = false;
      let intervalId: NodeJS.Timeout | null = null;
      // The nudge ID is minted mid-wait and must be unregistered on cleanup.
      let staleRequestId: string | null = null;

      const cleanup = (): void => {
        if (intervalId !== null) {
          this.context.timer.clearInterval(intervalId);
        }
        for (const id of [requestId, staleRequestId]) {
          if (id) {
            this.pendingHierarchyRejectors.delete(id);
          }
        }
      };
      const settleResolve = (value: CachedHierarchy | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleNoData = (reason: string): void => {
        if (!settled) {
          diagnostics.failureReason = reason;
          settleResolve(null);
        }
      };
      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const registerRejector = (id: string, label: string): void => {
        this.pendingHierarchyRejectors.set(id, {
          reject: (error: string) => {
            logger.warn(`[CTRL_PROXY] ${label} ${id} failed via runner error: ${error}`);
            // Preserve runner errors for requestHierarchySync diagnostics.
            settleReject(new HierarchyRunnerError(error));
          },
          disconnect: () =>
            settleNoData("CtrlProxy WebSocket disconnected while waiting for hierarchy response"),
          resolve: resolveMatchingHierarchy,
        });
      };

      const resolveMatchingHierarchy = (hierarchy: CachedHierarchy): void => {
        if (combinedSignal?.aborted || this.context.getWebSocket() !== waitSocket) {
          return;
        }
        if (isMatchingFresh(hierarchy, staleRequestId)) {
          settleResolve(hierarchy);
        }
      };

      if (requestId) {
        registerRejector(requestId, "Hierarchy request");
      }

      const sendStaleCheck = (elapsed: number): void => {
        if (!observerMode && !staleCheckSent && elapsed >= staleCheckDelay) {
          staleCheckSent = true;
          logger.debug(
            `[CTRL_PROXY] No push received after ${staleCheckDelay}ms, sending stale check request (sinceTimestamp: ${minTimestamp})`,
          );
          const staleId = this.sendHierarchyIfStaleRequest(minTimestamp);
          // Only correlated sync waits fail fast on nudge errors; getLatestHierarchy keeps its
          // stale-cache fallback because it has no primary request ID.
          if (staleId && requestId) {
            staleRequestId = staleId;
            registerRejector(staleId, "Hierarchy stale nudge");
          }
        }
      };

      intervalId = this.context.timer.setInterval(() => {
        if (combinedSignal?.aborted) {
          settleNoData(errorMessage(combinedSignal.reason));
          return;
        }
        if (this.context.getWebSocket() !== waitSocket) {
          settleNoData("CtrlProxy WebSocket changed while waiting for hierarchy response");
          return;
        }
        const elapsed = this.context.timer.now() - startTime;

        const cachedHierarchy = this.context.getCachedHierarchy();
        if (cachedHierarchy && isMatchingFresh(cachedHierarchy, staleRequestId)) {
          logger.debug(
            `[CTRL_PROXY] Fresh data received: receivedAt=${cachedHierarchy.receivedAt}, updatedAt=${cachedHierarchy.hierarchy.updatedAt}, minTimestamp=${minTimestamp}, elapsed=${elapsed}ms`,
          );
          settleResolve(cachedHierarchy);
          return;
        }

        sendStaleCheck(elapsed);

        // Check screen state periodically
        const now = this.context.timer.now();
        if (!screenCheckInProgress && now - lastScreenCheck >= screenCheckInterval) {
          screenCheckInProgress = true;
          lastScreenCheck = now;

          void this.checkScreenDuringHierarchyWait({
            signal: combinedSignal,
            onComplete: () => {
              screenCheckInProgress = false;
            },
            onScreenOff: () => settleNoData("Screen is off while waiting for hierarchy response"),
          });
        }

        // Check if timeout exceeded
        if (elapsed >= timeout) {
          this.logHierarchyWaitTimeout(elapsed, minTimestamp, useDeviceTimestamp);
          settleNoData(`Timed out waiting for hierarchy response after ${elapsed}ms`);
        }
      }, checkInterval);
    });
  }

  private logHierarchyWaitTimeout(
    elapsed: number,
    minTimestamp: number,
    useDeviceTimestamp: boolean,
  ): void {
    const cached = this.context.getCachedHierarchy();
    logger.debug(
      cached
        ? `[CTRL_PROXY] waitForFreshData TIMEOUT after ${elapsed}ms: cached receivedAt=${cached.receivedAt}, updatedAt=${cached.hierarchy.updatedAt}, minTimestamp=${minTimestamp}, useDeviceTimestamp=${useDeviceTimestamp}`
        : `[CTRL_PROXY] waitForFreshData TIMEOUT after ${elapsed}ms: no cached data, minTimestamp=${minTimestamp}`,
    );
  }

  private async checkScreenDuringHierarchyWait(options: {
    signal?: AbortSignal;
    onComplete: () => void;
    onScreenOff: () => void;
  }): Promise<void> {
    try {
      const isOn = await this.context.adb.isScreenOn(options.signal);
      if (!isOn && !options.signal?.aborted) {
        logger.warn("[CTRL_PROXY] Screen is off - failing fast instead of waiting for timeout");
        options.onScreenOff();
      }
    } catch (error) {
      // Screen state is an optional early-exit probe; the bounded hierarchy wait remains authoritative.
      logger.warn(
        `[CTRL_PROXY] Could not check screen state during hierarchy wait: ${errorMessage(error)}`,
        error,
      );
    } finally {
      options.onComplete();
    }
  }

  /**
   * Send a message via WebSocket to request hierarchy extraction.
   * @returns The correlating requestId when sent, or null when the WebSocket is unavailable or the
   *   send fails. Callers use the returned id to correlate a runner type:"error" frame back to this
   *   request's wait (issue #3032).
   */
  private sendHierarchyRequest(options: {
    disableAllFiltering: boolean;
    displayId?: number;
    observerMode: boolean;
    preserveDisplayState?: boolean;
    onRequestId?: (requestId: string) => void;
  }): string | null {
    const {
      disableAllFiltering,
      displayId,
      observerMode,
      preserveDisplayState = false,
      onRequestId,
    } = options;
    const ws = this.context.getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("[CTRL_PROXY] Cannot send request - WebSocket not connected");
      return null;
    }

    const requestId = `req_${this.context.timer.now()}_${generateSecureId()}`;
    const isolated = isolatedHierarchyRequest({ observerMode, displayId });
    try {
      onRequestId?.(requestId);
      if (isolated) {
        this.markIsolatedRequest(requestId, { observerMode, preserveDisplayState, displayId });
      }
      const message = serializeCtrlProxyRequest(
        ctrlProxyRequests.requestHierarchy({ requestId, disableAllFiltering, displayId }),
      );
      ws.send(message);
      logger.debug(
        `[CTRL_PROXY] Sent hierarchy request via WebSocket (requestId: ${requestId}, disableAllFiltering: ${disableAllFiltering})`,
      );
      return requestId;
    } catch (error) {
      if (isolated) {
        // A failed send cannot produce a correlated frame.
        this.context.unmarkObserverHierarchyRequest?.(requestId);
      }
      if (displayId !== undefined) {
        throw toActionableError(
          error,
          `Unable to request hierarchy for Android display ${displayId}`,
        );
      }
      logger.warn(`[CTRL_PROXY] Failed to send WebSocket request: ${errorMessage(error)}`, error);
      return null;
    }
  }

  /**
   * Send a message via WebSocket to request hierarchy extraction IF stale.
   * @returns The correlating `stale_` requestId when sent, or null when the WebSocket is
   *   unavailable or the send fails. Callers use the returned id to correlate a runner
   *   type:"error" frame back to the enclosing hierarchy wait (issue #3061), mirroring
   *   sendHierarchyRequest's contract for the primary path (issue #3032).
   */
  private sendHierarchyIfStaleRequest(sinceTimestamp: number): string | null {
    const ws = this.context.getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("[CTRL_PROXY] Cannot send stale check request - WebSocket not connected");
      return null;
    }

    try {
      const requestId = `stale_${this.context.timer.now()}_${generateSecureId()}`;
      const message = serializeCtrlProxyRequest(
        ctrlProxyRequests.requestHierarchyIfStale({ requestId, sinceTimestamp }),
      );
      ws.send(message);
      logger.debug(
        `[CTRL_PROXY] Sent hierarchy_if_stale request (requestId: ${requestId}, sinceTimestamp: ${sinceTimestamp})`,
      );
      return requestId;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to send stale check request: ${error}`);
      return null;
    }
  }

  /**
   * Send recomposition tracking configuration request.
   */
  private sendRecompositionTrackingRequest(enabled: boolean): boolean {
    const ws = this.context.getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("[CTRL_PROXY] Cannot send recomposition config - WebSocket not connected");
      return false;
    }

    try {
      const requestId = `recomp_${this.context.timer.now()}_${generateSecureId()}`;
      const message = serializeCtrlProxyRequest(
        ctrlProxyRequests.setRecompositionTracking({ requestId, enabled }),
      );
      ws.send(message);
      return true;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to send recomposition config: ${error}`);
      return false;
    }
  }

  private copyNodeIdentity(node: AccessibilityNode, converted: any): void {
    if (Number.isInteger(node.windowId)) {
      converted.windowId = node.windowId;
    }

    if (node.actions) {
      converted.actions = node.actions;
    }

    // Copy over all properties
    if (node.text) {
      converted.text = node.text;
    }
    if (node["content-desc"]) {
      converted["content-desc"] = node["content-desc"];
    }
    if (node["resource-id"]) {
      converted["resource-id"] = node["resource-id"];
    }
    if (node["test-tag"]) {
      converted["test-tag"] = node["test-tag"];
    }
    if (node["unique-id"]) {
      converted["unique-id"] = node["unique-id"];
    }
    if (typeof node["collection-row-index"] === "number") {
      converted["collection-row-index"] = node["collection-row-index"];
    }
    if (typeof node["collection-column-index"] === "number") {
      converted["collection-column-index"] = node["collection-column-index"];
    }
    if (typeof node["visible-to-user"] === "boolean") {
      converted["visible-to-user"] = node["visible-to-user"];
    }
  }

  private copyNodeDescriptions(node: AccessibilityNode, converted: any): void {
    if (node["container-title"]) {
      converted["container-title"] = node["container-title"];
    }
    for (const key of [
      "hint-text",
      "state-description",
      "error-message",
      "tooltip-text",
      "pane-title",
      "live-region",
      "collection-info",
      "collection-item-info",
      "range-info",
    ] as const) {
      if (node[key]) {
        converted[key] = node[key];
      }
    }
    if (node["view-id"]) {
      converted["view-id"] = node["view-id"];
    }
    if (node.className) {
      converted.class = node.className;
      converted.className = node.className;
    }
    if (node.packageName) {
      converted.packageName = node.packageName;
    }
  }

  private copyNodeFocusState(node: AccessibilityNode, converted: any): void {
    if (node.clickable && node.clickable !== "false") {
      converted.clickable = node.clickable;
    }
    // Absence (including a wire null) means enabled; preserve explicit disabled state.
    if (node.enabled !== undefined && node.enabled !== null) {
      converted.enabled = node.enabled;
    }
    if (node.focusable && node.focusable !== "false") {
      converted.focusable = node.focusable;
    }
    if (node.focused && node.focused !== "false") {
      converted.focused = node.focused;
    }
    if (node.scrollable && node.scrollable !== "false") {
      converted.scrollable = node.scrollable;
    }
  }

  private copyNodeSelectionState(node: AccessibilityNode, converted: any): void {
    if (node.password && node.password !== "false") {
      converted.password = node.password;
    }
    if (node.checkable && node.checkable !== "false") {
      converted.checkable = node.checkable;
    }
    if (node.checked && node.checked !== "false") {
      converted.checked = node.checked;
    }
    if (node.selected && node.selected !== "false") {
      converted.selected = node.selected;
    }
    if (node["long-clickable"] && node["long-clickable"] !== "false") {
      converted["long-clickable"] = node["long-clickable"];
    }
  }

  private copyNodePresentation(node: AccessibilityNode, converted: any): void {
    if (node["semantic-links"] && node["semantic-links"].length > 0) {
      converted["semantic-links"] = node["semantic-links"];
    }

    if (node.occlusionState) {
      converted.occlusionState = node.occlusionState;
    }
    if (node.occludedBy) {
      converted.occludedBy = node.occludedBy;
    }
    if (node.occludedByViewId) {
      converted.occludedByViewId = node.occludedByViewId;
    }
    if (node.extras) {
      converted.extras = node.extras;
    }
    if (node.recomposition) {
      converted.recomposition = node.recomposition;
    }

    if (node.bounds) {
      converted.bounds = node.bounds;
    }
  }

  /**
   * Convert individual accessibility node to the expected format.
   */
  private convertAccessibilityNode(node: AccessibilityNode | AccessibilityNode[]): any {
    // Handle array of nodes
    if (Array.isArray(node)) {
      const convertedArray = node.map((child) => this.convertAccessibilityNode(child));
      return convertedArray.length === 1 ? convertedArray[0] : convertedArray;
    }

    const converted: any = {};
    this.copyNodeIdentity(node, converted);
    this.copyNodeDescriptions(node, converted);
    this.copyNodeFocusState(node, converted);
    this.copyNodeSelectionState(node, converted);
    this.copyNodePresentation(node, converted);
    // Convert child nodes recursively
    if (node.node) {
      converted.node = this.convertAccessibilityNode(node.node);
    }

    return converted;
  }
}
