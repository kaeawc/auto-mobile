import WebSocket from "ws";
import { toActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { createTimestampedId } from "../../../utils/IdGenerator";
import { logger } from "../../../utils/logger";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import type { HierarchyDelegateContext } from "./types";

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
/** Sends correlated hierarchy and tracking requests on the current socket. */
export class AndroidHierarchyRequestSender {
  constructor(private readonly context: HierarchyDelegateContext) {}

  /**
   * Send a message via WebSocket to request hierarchy extraction.
   * @returns The correlating requestId when sent, or null when the WebSocket is unavailable or the
   *   send fails. Callers use the returned id to correlate a runner type:"error" frame back to this
   *   request's wait (issue #3032).
   */
  sendHierarchyRequest(options: {
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

    const requestId = createTimestampedId("req", this.context.timer, this.context.idGenerator);
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
  sendHierarchyIfStaleRequest(sinceTimestamp: number): string | null {
    const ws = this.context.getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("[CTRL_PROXY] Cannot send stale check request - WebSocket not connected");
      return null;
    }

    try {
      const requestId = createTimestampedId("stale", this.context.timer, this.context.idGenerator);
      const message = serializeCtrlProxyRequest(
        ctrlProxyRequests.requestHierarchyIfStale({ requestId, sinceTimestamp }),
      );
      ws.send(message);
      logger.debug(
        `[CTRL_PROXY] Sent hierarchy_if_stale request (requestId: ${requestId}, sinceTimestamp: ${sinceTimestamp})`,
      );
      return requestId;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to send stale check request: ${errorMessage(error)}`, error);
      return null;
    }
  }

  /**
   * Send recomposition tracking configuration request.
   */
  sendRecompositionTrackingRequest(enabled: boolean): boolean {
    const ws = this.context.getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("[CTRL_PROXY] Cannot send recomposition config - WebSocket not connected");
      return false;
    }

    try {
      const requestId = createTimestampedId("recomp", this.context.timer, this.context.idGenerator);
      const message = serializeCtrlProxyRequest(
        ctrlProxyRequests.setRecompositionTracking({ requestId, enabled }),
      );
      ws.send(message);
      return true;
    } catch (error) {
      logger.warn(
        `[CTRL_PROXY] Failed to send recomposition config: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
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
}
