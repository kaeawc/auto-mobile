/**
 * CtrlProxyHierarchy - Delegate for hierarchy retrieval and caching.
 *
 * This delegate handles getting, caching, and converting view hierarchy data
 * from the Android accessibility service.
 */

import WebSocket from "ws";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker, TimingEntry } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { throwIfAborted } from "../../../utils/toolUtils";
import { AndroidCtrlProxyManager } from "../../../utils/CtrlProxyManager";
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
} from "./types";
import { generateSecureId } from "./types";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import { applyStableViewIdRewrites, assignStableViewIds } from "./StableNodeIdentity";
import { maxObservationAgeMs } from "../observationFreshness";

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

  // Outstanding hierarchy request IDs mapped to their error-rejection hook. request_hierarchy does
  // NOT await through RequestManager (it blocks in waitForFreshData for a hierarchy_update push), so
  // a runner type:"error" frame must be fanned into this map to unblock the correct waiter fast
  // instead of hanging to timeout. See issue #3032.
  //
  // The hook is wrapped in an object and invoked via the fixed `.reject` property (mirroring
  // RequestManager's `request.reject(...)`) rather than calling the map value directly — a
  // user-controlled requestId must never drive a dynamic method-name dispatch.
  private readonly pendingHierarchyRejectors = new Map<
    string,
    { reject: (error: string) => void }
  >();

  constructor(context: HierarchyDelegateContext) {
    this.context = context;
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
  ): Promise<AccessibilityHierarchyResponse> {
    const startTime = this.context.timer.now();
    const cachedHierarchy = this.context.getCachedHierarchy();

    logger.debug(
      `[CTRL_PROXY] getLatestHierarchy: cache=${cachedHierarchy ? "exists" : "null"}, waitForFresh=${waitForFresh}, skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp}`,
    );

    try {
      // Ensure WebSocket connection is established
      const connected = await perf.track("ensureConnection", () =>
        this.context.ensureConnected(perf),
      );
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection");
        return {
          hierarchy: null,
          fresh: false,
        };
      }

      // If we have cached data and not waiting for fresh, return it immediately
      if (cachedHierarchy && !waitForFresh) {
        const cacheAge = startTime - cachedHierarchy.receivedAt;
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
            const isFresh = cacheAge < Math.min(1000, maxObservationAgeMs());
            const duration = this.context.timer.now() - startTime;
            logger.debug(
              `[CTRL_PROXY] Cache accepted in ${duration}ms: ` +
                `receivedAt=${cachedHierarchy.receivedAt}, ` +
                `updatedAt=${updatedAt}, age=${cacheAge}ms, fresh=${isFresh}`,
            );

            return {
              hierarchy: cachedHierarchy.hierarchy,
              fresh: isFresh,
              updatedAt: updatedAt,
              receivedAt: cachedHierarchy.receivedAt,
              perfTiming: cachedHierarchy.perfTiming,
              frameContext: cachedHierarchy.frameContext,
            };
          }
        } else {
          // No minTimestamp check, return cache
          const isFresh = cacheAge < Math.min(1000, maxObservationAgeMs());
          const duration = this.context.timer.now() - startTime;
          logger.debug(
            `[CTRL_PROXY] Cache hit: ${duration}ms (age: ${cacheAge}ms, fresh: ${isFresh}, updatedAt: ${updatedAt})`,
          );

          return {
            hierarchy: cachedHierarchy.hierarchy,
            fresh: isFresh,
            updatedAt: updatedAt,
            receivedAt: cachedHierarchy.receivedAt,
            perfTiming: cachedHierarchy.perfTiming,
            frameContext: cachedHierarchy.frameContext,
          };
        }
      }

      // Wait for fresh data if requested (unless skipped or recently timed out)
      const cacheRejected =
        minTimestamp > 0 &&
        cachedHierarchy &&
        !this.evaluateMinTimestamp(cachedHierarchy, minTimestamp, true).isFresh;
      const shouldWait =
        (waitForFresh || cacheRejected) &&
        (!skipWaitForFresh || cacheRejected) &&
        !this.shouldSkipWebSocketWait();
      if (shouldWait) {
        throwIfAborted(signal);
        const waitMinTimestamp = minTimestamp > 0 ? minTimestamp : startTime;
        const useDeviceTimestamp = minTimestamp > 0;
        logger.debug(
          `[CTRL_PROXY] Waiting up to ${timeout}ms for fresh hierarchy data (must be newer than ${waitMinTimestamp})`,
        );

        const freshData = await perf.track("waitForFresh", () =>
          this.waitForFreshData(timeout, waitMinTimestamp, useDeviceTimestamp, signal),
        );
        const duration = this.context.timer.now() - startTime;

        if (freshData) {
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
        } else {
          // Record timeout so we skip WebSocket wait for a while
          this.context.setLastWebSocketTimeout(this.context.timer.now());
          logger.warn(
            `[CTRL_PROXY] Timeout waiting for fresh data after ${duration}ms, will skip WebSocket wait for ${WEBSOCKET_TIMEOUT_COOLDOWN_MS}ms`,
          );

          // Return cached data if available
          const currentCache = this.context.getCachedHierarchy();
          if (currentCache) {
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
        }
      } else if (skipWaitForFresh || this.shouldSkipWebSocketWait()) {
        logger.debug(
          `[CTRL_PROXY] Skipping WebSocket wait (skipWaitForFresh=${skipWaitForFresh}, recentTimeout=${this.shouldSkipWebSocketWait()})`,
        );
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

  /**
   * Get view hierarchy from accessibility service.
   * This is the main entry point for getting hierarchy data from the accessibility service.
   *
   * @param timeoutMs - Optional overall budget for this read. It bounds BOTH the
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
    timeoutMs?: number,
  ): Promise<ViewHierarchyResult | null> {
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
      const waitForFresh =
        !skipWaitForFresh && (cachedHierarchy === null || !cachedHierarchy.fresh);
      // `timeoutMs` is the caller's overall budget, not a per-step allowance, so
      // the wait gets what is LEFT of it. Starting from the original value would
      // let a slow availability check or reconnect be followed by another full
      // fresh wait, blowing the deadline this parameter exists to protect.
      const freshWaitMs =
        timeoutMs === undefined
          ? DEFAULT_FRESH_WAIT_MS
          : Math.max(
              0,
              Math.min(DEFAULT_FRESH_WAIT_MS, timeoutMs - (this.context.timer.now() - startTime)),
            );
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

      // If no hierarchy from WebSocket or data is stale, sync to get fresh data
      const needsSync = !hierarchyData || !isFresh;
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
          hierarchyData = syncResult.hierarchy;
          if (syncResult.perfTiming) {
            androidPerfTiming = syncResult.perfTiming;
          }
          frameContext = syncResult.frameContext;
          isFresh = true;
          receivedAt = this.context.timer.now();
          if (hierarchyData.packageName) {
            this.lastKnownPackageName = hierarchyData.packageName;
          }
          logger.debug("[CTRL_PROXY] Successfully retrieved hierarchy via sync ADB method");
        } else if (!hierarchyData) {
          // Surface the runner's structured error text when the sync failed on a correlated runner
          // error frame, so the fallback is attributable rather than an anonymous timeout (#3062).
          const runnerErrorSuffix = syncDiagnostics.runnerError
            ? ` (runner error: ${syncDiagnostics.runnerError})`
            : "";
          logger.warn(
            `[CTRL_PROXY] Both WebSocket and sync methods failed, will use fallback${runnerErrorSuffix}`,
          );
          perf.end();
          return null;
        }
      }

      // Convert to expected format
      const convertedHierarchy = await perf.track("convert", () =>
        Promise.resolve(this.convertToViewHierarchyResult(hierarchyData!)),
      );

      // Add the device timestamp to the result
      if (hierarchyData!.updatedAt) {
        convertedHierarchy.updatedAt = hierarchyData!.updatedAt;
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
  ): Promise<{
    hierarchy: AccessibilityHierarchy;
    perfTiming?: AndroidPerfTiming[];
    frameContext?: string;
  } | null> {
    const startTime = this.context.timer.now();
    const effectiveTimeoutMs = Math.max(0, timeoutMs);

    try {
      logger.debug("[CTRL_PROXY] Requesting hierarchy sync via WebSocket");

      // Ensure WebSocket connection is established
      await this.context.ensureConnected(perf);

      // Try WebSocket request first (faster path). Returns the correlating requestId when sent so a
      // runner type:"error" frame for this hierarchy request can reject the wait fast (issue #3032).
      const hierarchyRequestId = await perf.track("sendWsRequest", async () => {
        return this.sendHierarchyRequest(disableAllFiltering);
      });

      // Fall back to ADB broadcast if WebSocket failed. The broadcast mints its own `sync_` uuid and
      // passes it to the runner via `--es uuid`; we thread that SAME uuid into the wait below so a
      // runner type:"error" frame echoing it fails fast, mirroring the `req_`/`stale_` WebSocket
      // paths (issue #3089). Kept null when the WebSocket send succeeded (that path correlates on
      // its own `req_` id).
      let broadcastRequestId: string | null = null;
      if (hierarchyRequestId === null) {
        logger.debug("[CTRL_PROXY] Falling back to ADB broadcast");
        const uuid = `sync_${this.context.timer.now()}_${generateSecureId()}`;
        broadcastRequestId = uuid;
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
      // the WebSocket is still readable (a transient send failure / flap) — when the socket is fully
      // down the daemon receives neither the push nor the error frame and still degrades to timeout,
      // so this closes the flapping subset of the hang class, not the socket-down subset. A fast fail
      // still returns null, so the caller keeps its stale-cache fallback (see
      // getAccessibilityHierarchy) — nothing is discarded here.
      const correlationRequestId = hierarchyRequestId ?? broadcastRequestId ?? undefined;
      const freshData = await perf.track("waitForPush", () =>
        this.waitForFreshData(effectiveTimeoutMs, startTime, false, signal, correlationRequestId),
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

      logger.warn("[CTRL_PROXY] Timeout waiting for WebSocket push after request");
      return null;
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      // A correlated runner type:"error" frame (issue #3032 / #3061) rejects the wait with a typed
      // HierarchyRunnerError. Surface its text on the caller-provided diagnostics so the caller can
      // tell this deterministic handler failure apart from a plain timeout `null` (issue #3062).
      if (error instanceof HierarchyRunnerError && diagnostics) {
        diagnostics.runnerError = error.runnerError;
      }
      logger.warn(`[CTRL_PROXY] Sync hierarchy request failed after ${duration}ms: ${error}`);
      return null;
    }
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
          hierarchy: {
            error: errorMessage,
          },
          packageName: resolvedPackageName,
          windows: accessibilityHierarchy.windows,
          contentHiddenRegions: accessibilityHierarchy.contentHiddenRegions,
          intentChooserDetected: accessibilityHierarchy.intentChooserDetected,
          notificationPermissionDetected: accessibilityHierarchy.notificationPermissionDetected,
          ctrlProxyIncomplete: accessibilityHierarchy.ctrlProxyIncomplete,
          truncationReasons: accessibilityHierarchy.truncationReasons,
          sources: ["control-proxy"],
          screenWidth: accessibilityHierarchy.screenWidth,
          screenHeight: accessibilityHierarchy.screenHeight,
          rotation: accessibilityHierarchy.rotation,
          systemInsets: accessibilityHierarchy.systemInsets,
          insets: accessibilityHierarchy.insets,
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
        hierarchy: convertedHierarchy,
        packageName: resolvedPackageName,
        windows: accessibilityHierarchy.windows,
        contentHiddenRegions: accessibilityHierarchy.contentHiddenRegions,
        intentChooserDetected: accessibilityHierarchy.intentChooserDetected,
        notificationPermissionDetected: accessibilityHierarchy.notificationPermissionDetected,
        "accessibility-focused-element": accessibilityFocusedElement,
        ctrlProxyIncomplete: accessibilityHierarchy.ctrlProxyIncomplete,
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
  ): Promise<void> {
    if (this.recompositionTrackingConfigured && this.recompositionTrackingEnabled === enabled) {
      return;
    }

    const connected = await perf.track("ensureConnection", () =>
      this.context.ensureConnected(perf),
    );
    if (!connected) {
      logger.debug("[CTRL_PROXY] Skipping recomposition tracking config; WebSocket not connected");
      return;
    }

    const sent = this.sendRecompositionTrackingRequest(enabled);
    if (sent) {
      this.recompositionTrackingConfigured = true;
      this.recompositionTrackingEnabled = enabled;
      logger.info(`[CTRL_PROXY] Recomposition tracking ${enabled ? "enabled" : "disabled"}`);
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
   * Wait for fresh data to arrive via WebSocket.
   */
  private async waitForFreshData(
    timeout: number,
    minTimestamp: number,
    useDeviceTimestamp: boolean,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<CachedHierarchy | null> {
    const startTime = this.context.timer.now();
    const checkInterval = 50;
    const screenCheckInterval = 1000;
    const staleCheckDelay = 2000;
    let lastScreenCheck = startTime;
    let screenCheckInProgress = false;
    let staleCheckSent = false;

    return new Promise<CachedHierarchy | null>((resolve, reject) => {
      let settled = false;
      let intervalId: NodeJS.Timeout | null = null;
      // The request_hierarchy_if_stale nudge (below) is minted mid-wait, so its id is not known
      // until the interval fires. Track it here so cleanup can unregister it too (issue #3061).
      let staleRequestId: string | null = null;

      const cleanup = (): void => {
        if (intervalId !== null) {
          this.context.timer.clearInterval(intervalId);
        }
        if (requestId) {
          this.pendingHierarchyRejectors.delete(requestId);
        }
        if (staleRequestId) {
          this.pendingHierarchyRejectors.delete(staleRequestId);
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
      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      // Register a fast-fail rejector for a hierarchy requestId so a runner type:"error" frame
      // (fanned in via AndroidCtrlProxyClient.rejectPendingHierarchy) rejects THIS wait instead of
      // hanging to the timeout below. The hook is wrapped in a fixed `.reject` property so a
      // runner-controlled id can never drive a dynamic method-name dispatch
      // (CodeQL js/unvalidated-dynamic-method-call). Shared by the primary request_hierarchy path
      // (issue #3032) and the request_hierarchy_if_stale nudge (issue #3061).
      const registerRejector = (id: string, label: string): void => {
        this.pendingHierarchyRejectors.set(id, {
          reject: (error: string) => {
            logger.warn(`[CTRL_PROXY] ${label} ${id} failed via runner error: ${error}`);
            // Reject with a typed carrier so requestHierarchySync's catch can tell a runner-reported
            // handler failure apart from other thrown causes and surface it via diagnostics (#3062).
            settleReject(new HierarchyRunnerError(error));
          },
        });
      };

      // Route a runner type:"error" frame (delivered via AndroidCtrlProxyClient) for this hierarchy
      // request into a fast rejection instead of hanging to the timeout below (issue #3032).
      if (requestId) {
        registerRejector(requestId, "Hierarchy request");
      }

      intervalId = this.context.timer.setInterval(() => {
        if (signal?.aborted) {
          settleResolve(null);
          return;
        }
        const elapsed = this.context.timer.now() - startTime;

        // Check if we received fresh data
        const cachedHierarchy = this.context.getCachedHierarchy();
        if (cachedHierarchy) {
          const freshness = this.evaluateMinTimestamp(
            cachedHierarchy,
            minTimestamp,
            useDeviceTimestamp,
          );

          if (freshness.isFresh) {
            logger.debug(
              `[CTRL_PROXY] Fresh data received: receivedAt=${cachedHierarchy.receivedAt}, updatedAt=${cachedHierarchy.hierarchy.updatedAt}, minTimestamp=${minTimestamp}, elapsed=${elapsed}ms`,
            );
            settleResolve(cachedHierarchy);
            return;
          }
        }

        // Send "nudge" after staleCheckDelay
        if (!staleCheckSent && elapsed >= staleCheckDelay) {
          staleCheckSent = true;
          logger.debug(
            `[CTRL_PROXY] No push received after ${staleCheckDelay}ms, sending stale check request (sinceTimestamp: ${minTimestamp})`,
          );
          const staleId = this.sendHierarchyIfStaleRequest(minTimestamp);
          // Correlate a runner type:"error" frame for this stale nudge into THIS wait, mirroring the
          // primary request_hierarchy path (issue #3032). A decode/handler failure on
          // request_hierarchy_if_stale should fail the enclosing wait fast rather than hang to the
          // timeout below (issue #3061).
          //
          // Gate on `requestId`: only correlate the stale nudge when the enclosing wait carries a
          // correlation id at all. Two callers pass one and want a fast fail: the primary WebSocket
          // request_hierarchy path (issue #3032) and, since issue #3089, the sync ADB-broadcast
          // fallback (which now threads its `sync_` uuid). A fast fail there returns null, and
          // requestHierarchySync's caller keeps its stale cache regardless, so nothing is discarded.
          // getLatestHierarchy is the lone path that passes NO requestId — its timeout is meant to
          // gracefully degrade to the stale cache, and a rejected stale nudge there WOULD discard it
          // and return null, so it is deliberately left uncorrelated.
          if (staleId && requestId) {
            staleRequestId = staleId;
            registerRejector(staleId, "Hierarchy stale nudge");
          }
        }

        // Check screen state periodically
        const now = this.context.timer.now();
        if (!screenCheckInProgress && now - lastScreenCheck >= screenCheckInterval) {
          screenCheckInProgress = true;
          lastScreenCheck = now;

          this.context.adb
            .isScreenOn(signal)
            .then((isOn) => {
              screenCheckInProgress = false;
              if (!isOn) {
                logger.warn(
                  "[CTRL_PROXY] Screen is off - failing fast instead of waiting for timeout",
                );
                settleResolve(null);
              }
            })
            .catch(() => {
              screenCheckInProgress = false;
            });
        }

        // Check if timeout exceeded
        if (elapsed >= timeout) {
          const cached = this.context.getCachedHierarchy();
          if (cached) {
            logger.debug(
              `[CTRL_PROXY] waitForFreshData TIMEOUT after ${elapsed}ms: cached receivedAt=${cached.receivedAt}, updatedAt=${cached.hierarchy.updatedAt}, minTimestamp=${minTimestamp}, useDeviceTimestamp=${useDeviceTimestamp}`,
            );
          } else {
            logger.debug(
              `[CTRL_PROXY] waitForFreshData TIMEOUT after ${elapsed}ms: no cached data, minTimestamp=${minTimestamp}`,
            );
          }
          settleResolve(null);
        }
      }, checkInterval);
    });
  }

  /**
   * Send a message via WebSocket to request hierarchy extraction.
   * @returns The correlating requestId when sent, or null when the WebSocket is unavailable or the
   *   send fails. Callers use the returned id to correlate a runner type:"error" frame back to this
   *   request's wait (issue #3032).
   */
  private sendHierarchyRequest(disableAllFiltering: boolean = false): string | null {
    const ws = this.context.getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("[CTRL_PROXY] Cannot send request - WebSocket not connected");
      return null;
    }

    try {
      const requestId = `req_${this.context.timer.now()}_${generateSecureId()}`;
      const message = serializeCtrlProxyRequest(
        ctrlProxyRequests.requestHierarchy({ requestId, disableAllFiltering }),
      );
      ws.send(message);
      logger.debug(
        `[CTRL_PROXY] Sent hierarchy request via WebSocket (requestId: ${requestId}, disableAllFiltering: ${disableAllFiltering})`,
      );
      return requestId;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to send WebSocket request: ${error}`);
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
    if (node["container-title"]) {
      converted["container-title"] = node["container-title"];
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
    if (node.clickable && node.clickable !== "false") {
      converted.clickable = node.clickable;
    }
    if (node.enabled && node.enabled !== "false") {
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

    // Convert child nodes recursively
    if (node.node) {
      converted.node = this.convertAccessibilityNode(node.node);
    }

    return converted;
  }
}
