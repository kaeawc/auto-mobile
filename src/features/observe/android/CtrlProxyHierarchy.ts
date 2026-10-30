import { DUMPSYS_MAX_BUFFER } from "../../../utils/android-cmdline-tools/dumpsysLimits";
import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import type { HierarchyReadOptions } from "../interfaces/ViewHierarchy";
import { AccessibilityHierarchyConverter } from "./AccessibilityHierarchyConverter";
import { AndroidHierarchyRequestSender } from "./AndroidHierarchyRequestSender";
import { AndroidHierarchySyncRunner } from "./AndroidHierarchySyncRunner";
import {
  AndroidHierarchyWaiter,
  type FreshDataWaitOptions,
  type PendingHierarchyReply,
} from "./AndroidHierarchyWaiter";
import { satisfiesMinTimestamp } from "./hierarchyFreshness";
/**
 * CtrlProxyHierarchy - Delegate for hierarchy retrieval and caching.
 *
 * This delegate handles getting, caching, and converting view hierarchy data
 * from the Android accessibility service.
 */

import { AndroidCtrlProxyManager } from "../../../ctrlProxy/CtrlProxyManager";
import type { ViewHierarchyResult } from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import { isAndroidPackageRunning } from "../../../utils/android-cmdline-tools/androidProcessState";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker, TimingEntry } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import {
  resolveAccessibilityHierarchyArgs,
  type AccessibilityHierarchyRequest,
} from "../hierarchyReadArgs";
import { maxObservationAgeMs } from "../observationFreshness";
import type {
  AccessibilityHierarchy,
  AccessibilityHierarchyResponse,
  AndroidPerfTiming,
  CachedHierarchy,
  HierarchyDelegateContext,
  HierarchySyncDiagnostics,
  ObserverHierarchyRequestOptions,
  HierarchySyncRequestOptions,
  LatestHierarchyOptions,
} from "./types";

/** Applies `getLatestHierarchy`'s defaults: no options means no freshness floor. */
function resolveLatestHierarchyOptions(options: LatestHierarchyOptions = {}): {
  minTimestamp: number;
  signal?: AbortSignal;
} {
  return { minTimestamp: options.minTimestamp ?? 0, signal: options.signal };
}

/** Cooldown after a WebSocket timeout before retrying fresh-data waits. Keep short: a long
 *  cooldown (e.g. 5s) makes one slow response cascade into stale data for every request. */
const WEBSOCKET_TIMEOUT_COOLDOWN_MS = 500;

/** Default wait window for a fresh WebSocket-pushed hierarchy.
 *  Aligned with the 1s cache-freshness TTL so a contended ADB pipe
 *  (concurrent screenshots, dumpsys, emulator transitions) has the same
 *  headroom that the cache considers acceptable for "fresh" data.
 *  100ms was too aggressive: under contention pushes routinely exceeded
 *  it, silently degrading results to stale cache. See issue #2285. */
const DEFAULT_FRESH_WAIT_MS = 1000;

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
  private readonly converter: AccessibilityHierarchyConverter;
  private readonly sender: AndroidHierarchyRequestSender;
  private readonly syncRunner: AndroidHierarchySyncRunner;
  private readonly pendingHierarchyRejectors = new Map<string, PendingHierarchyReply>();
  private readonly waiter: AndroidHierarchyWaiter;

  // Track the last known foreground app to detect stale cache from a different app
  private lastKnownPackageName: string | null = null;

  // Recomposition tracking state
  private recompositionTrackingConfigured: boolean = false;
  private recompositionTrackingEnabled: boolean = false;
  private readonly hierarchySyncFlights = new Set<HierarchySyncFlight>();

  constructor(context: HierarchyDelegateContext) {
    this.context = context;
    this.converter = new AccessibilityHierarchyConverter(context);
    this.sender = new AndroidHierarchyRequestSender(context);
    this.waiter = new AndroidHierarchyWaiter(context, this.sender, this.pendingHierarchyRejectors);
    this.syncRunner = new AndroidHierarchySyncRunner(context, {
      sendHierarchyRequest: (options) => this.sendHierarchyRequest(options),
      waitForFreshData: (...args) => this.waitForFreshData(...args),
      awaitSyncReply: (...args) => this.waiter.awaitSyncReply(...args),
    });
  }
  markRequestIdEchoAdvertised(): void {
    return this.waiter.markRequestIdEchoAdvertised();
  }
  rejectPendingHierarchy(requestId: string, error: string): boolean {
    return this.waiter.rejectPendingHierarchy(requestId, error);
  }
  resolvePendingHierarchy(requestId: string | null | undefined, hierarchy: CachedHierarchy): void {
    return this.waiter.resolvePendingHierarchy(requestId, hierarchy);
  }
  hasSeenCorrelatedFrames(): boolean {
    return this.waiter.hasSeenCorrelatedFrames();
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
    this.waiter.resetConnectionScopedState();
  }
  rejectAllPendingHierarchy(reason: string): void {
    return this.waiter.rejectAllPendingHierarchy(reason);
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
   * @param options.minTimestamp - If provided, cached data must have updatedAt >= this value to be considered fresh
   * @returns Promise<AccessibilityHierarchyResponse>
   */
  async getLatestHierarchy(
    waitForFresh: boolean = false,
    timeout: number = DEFAULT_FRESH_WAIT_MS,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    options?: LatestHierarchyOptions,
  ): Promise<HierarchyLookupResult> {
    const { minTimestamp, signal } = resolveLatestHierarchyOptions(options);
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
          !this.waiter.evaluateMinTimestamp(cachedHierarchy, minTimestamp, true).isFresh;
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
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
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
      const freshness = this.waiter.evaluateMinTimestamp(cachedHierarchy, minTimestamp, true);

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
      const result = await this.context.adb.executeCommand("shell dumpsys activity processes", {
        timeoutMs,
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal,
      });
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
    request?: AccessibilityHierarchyRequest,
  ): Promise<ViewHierarchyResult | null> {
    const {
      perf = new NoOpPerformanceTracker(),
      skipWaitForFresh = false,
      minTimestamp = 0,
      disableAllFiltering = false,
      signal,
      readOptions,
    } = resolveAccessibilityHierarchyArgs(request);
    const { timeoutMs, requireFreshExtraction } = this.getHierarchyReadPolicy(readOptions);
    const startTime = this.context.timer.now();
    const cachedHierarchy = this.context.getCachedHierarchy();

    perf.serial("a11yService");

    try {
      throwIfAborted(signal);
      // Check if service is available
      const available = await perf.track("checkAvailable", () =>
        AndroidCtrlProxyManager.getInstance(this.context.device, {
          create: () => this.context.adb,
        }).isAvailable(),
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
        this.getLatestHierarchy(waitForFresh, freshWaitMs, perf, skipWaitForFresh, {
          minTimestamp,
          signal,
        }),
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
        isFresh = satisfiesMinTimestamp(hierarchyData.updatedAt, minTimestamp);
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
          this.requestHierarchySync(perf, disableAllFiltering, signal, syncTimeoutMs, {
            diagnostics: syncDiagnostics,
          }),
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
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
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
    options: HierarchySyncRequestOptions = {},
  ): Promise<HierarchySyncResult> {
    return this.requestHierarchySyncWithOptions({
      perf,
      disableAllFiltering,
      signal,
      timeoutMs,
      diagnostics: options.diagnostics,
      displayId: options.displayId,
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
          this.syncRunner.runHierarchySync(
            perf,
            disableAllFiltering,
            signal ?? new AbortController().signal,
            effectiveTimeoutMs,
            {
              startTime,
              displayId,
              observerMode,
              preserveDisplayState,
              onRequestId: options.onRequestId,
              diagnostics: diagnostics ?? {},
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
          promise: this.syncRunner.runHierarchySync(
            perf,
            disableAllFiltering,
            controller.signal,
            effectiveTimeoutMs,
            {
              startTime,
              displayId,
              observerMode,
              preserveDisplayState,
              diagnostics: sharedDiagnostics,
            },
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
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
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
  convertToViewHierarchyResult(
    accessibilityHierarchy: AccessibilityHierarchy,
  ): ViewHierarchyResult {
    return this.converter.convertToViewHierarchyResult(accessibilityHierarchy);
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
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
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

  private sendHierarchyRequest(options: {
    disableAllFiltering: boolean;
    displayId?: number;
    observerMode: boolean;
    preserveDisplayState?: boolean;
    onRequestId?: (requestId: string) => void;
  }): string | null {
    return this.sender.sendHierarchyRequest(options);
  }
  private sendHierarchyIfStaleRequest(sinceTimestamp: number): string | null {
    return this.sender.sendHierarchyIfStaleRequest(sinceTimestamp);
  }
  private async waitForFreshData(
    timeout: number,
    minTimestamp: number,
    useDeviceTimestamp: boolean,
    signal?: AbortSignal,
    options: FreshDataWaitOptions = {
      allowStaleResponse: true,
    },
  ): Promise<CachedHierarchy | null> {
    return this.waiter.waitForFreshData(timeout, minTimestamp, useDeviceTimestamp, signal, options);
  }
  private sendRecompositionTrackingRequest(enabled: boolean): boolean {
    return this.sender.sendRecompositionTrackingRequest(enabled);
  }
}
