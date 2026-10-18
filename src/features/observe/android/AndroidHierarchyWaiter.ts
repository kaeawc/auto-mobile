/**
 * CtrlProxyHierarchy - Delegate for hierarchy retrieval and caching.
 *
 * This delegate handles getting, caching, and converting view hierarchy data
 * from the Android accessibility service.
 */

import WebSocket from "ws";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import type { HierarchyDelegateContext, CachedHierarchy, HierarchySyncDiagnostics } from "./types";
import { HierarchyRunnerError } from "./HierarchyRunnerError";

type HierarchyWaiterContext = Pick<
  HierarchyDelegateContext,
  "getWebSocket" | "timer" | "getCachedHierarchy" | "adb"
>;

export interface HierarchyWaiterDependencies {
  readonly pendingRejectors: Map<string, PendingHierarchyRejector>;
  isDispatchSocketValid(dispatchSocket?: WebSocket | null): boolean;
  matchesFresh(
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
  ): boolean;
  sendStaleCheck(sinceTimestamp: number): string | null;
}

/** Settle hooks registered per outstanding hierarchy request (see CtrlProxyHierarchy). */
export interface PendingHierarchyRejector {
  reject: (error: string) => void;
  disconnect: () => void;
  resolve: (hierarchy: CachedHierarchy) => void;
}

/** Waits for a hierarchy_update push, nudging with a stale check and probing the screen state. */
export class AndroidHierarchyWaiter {
  constructor(
    private readonly context: HierarchyWaiterContext,
    private readonly deps: HierarchyWaiterDependencies,
  ) {}

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
    if (!this.deps.isDispatchSocketValid(dispatchSocket)) {
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
      this.deps.matchesFresh(hierarchy, minTimestamp, useDeviceTimestamp, {
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
            this.deps.pendingRejectors.delete(id);
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
        this.deps.pendingRejectors.set(id, {
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
          const staleId = this.deps.sendStaleCheck(minTimestamp);
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
}
