import WebSocket from "ws";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { CtrlSocket } from "../shared/types";
import type { AndroidHierarchyRequestSender } from "./AndroidHierarchyRequestSender";
import { HierarchyRunnerError } from "./HierarchyRunnerError";
import type { CachedHierarchy, HierarchyDelegateContext, HierarchySyncDiagnostics } from "./types";
export interface PendingHierarchyReply {
  reject: (error: string) => void;
  disconnect: () => void;
  resolve: (hierarchy: CachedHierarchy) => void;
}
/** Owns correlated hierarchy waits and their connection-scoped freshness evidence. */
export class AndroidHierarchyWaiter {
  constructor(
    private readonly context: HierarchyDelegateContext,
    private readonly sender: Pick<AndroidHierarchyRequestSender, "sendHierarchyIfStaleRequest">,
    private readonly pendingHierarchyRejectors: Map<string, PendingHierarchyReply>,
  ) {}
  resetConnectionScopedState(): void {
    this.correlatedFramesSeen = false;
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

  private correlatedFramesSeen = false;

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

  private isDispatchSocketValid(dispatchSocket?: CtrlSocket | null): boolean {
    return (
      dispatchSocket === undefined ||
      (!!dispatchSocket &&
        dispatchSocket.readyState === WebSocket.OPEN &&
        this.context.getWebSocket() === dispatchSocket)
    );
  }

  /**
   * Wait for fresh data to arrive via WebSocket.
   */
  async waitForFreshData(
    timeout: number,
    minTimestamp: number,
    useDeviceTimestamp: boolean,
    signal?: AbortSignal,
    requestId?: string,
    options: {
      dispatchSocket?: CtrlSocket | null;
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
          const staleId = this.sender.sendHierarchyIfStaleRequest(minTimestamp);
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
   * Determine whether cached data satisfies a minTimestamp requirement.
   */
  evaluateMinTimestamp(
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
  async awaitSyncReply(
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

  private unmarkObserverRequest(isolated: boolean, requestId?: string): void {
    if (isolated && requestId) {
      this.context.unmarkObserverHierarchyRequest?.(requestId);
    }
  }
}
