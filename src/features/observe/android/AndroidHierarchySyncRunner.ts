import WebSocket from "ws";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { createTimestampedId } from "../../../utils/IdGenerator";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import type { AndroidHierarchyRequestSender } from "./AndroidHierarchyRequestSender";
import type { AndroidHierarchyWaiter } from "./AndroidHierarchyWaiter";
import { HierarchyRunnerError } from "./HierarchyRunnerError";
import type {
  AccessibilityHierarchy,
  AndroidPerfTiming,
  HierarchyDelegateContext,
  HierarchySyncDiagnostics,
} from "./types";
type HierarchySyncResult = {
  hierarchy: AccessibilityHierarchy;
  perfTiming?: AndroidPerfTiming[];
  frameContext?: string;
} | null;
interface HierarchySyncHooks {
  sendHierarchyRequest: AndroidHierarchyRequestSender["sendHierarchyRequest"];
  waitForFreshData: AndroidHierarchyWaiter["waitForFreshData"];
  awaitSyncReply: AndroidHierarchyWaiter["awaitSyncReply"];
}
/** Coordinates one fresh extraction across connection, dispatch, fallback and reply. */
export class AndroidHierarchySyncRunner {
  constructor(
    private readonly context: HierarchyDelegateContext,
    private readonly hooks: HierarchySyncHooks,
  ) {}

  async runHierarchySync(
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
        return this.hooks.sendHierarchyRequest({
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
        const uuid = createTimestampedId("sync", this.context.timer, this.context.idGenerator);
        broadcastRequestId = uuid;
        request.onRequestId?.(uuid);
        await perf.track("sendBroadcast", async () => {
          await this.context.adb.executeCommand(
            `shell "am broadcast -a dev.jasonpearson.automobile.EXTRACT_HIERARCHY --es uuid ${uuid} --ez disableAllFiltering ${disableAllFiltering}"`,
            { signal },
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
      const freshData = await this.hooks.awaitSyncReply(
        () =>
          perf.track("waitForPush", () =>
            this.hooks.waitForFreshData(
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
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
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
}
