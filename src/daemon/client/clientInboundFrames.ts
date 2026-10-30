import type { Timer } from "../../utils/SystemTimer";
import type { ProgressExtendableDeadline } from "../mcpRequestTimeout";
import type { McpTimeoutError } from "../wire/McpTimeoutError";
import type { DaemonDisconnectError } from "../DaemonDisconnectError";
import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";
import { daemonResponseError } from "./clientResponseDecoding";
import {
  DaemonNotification,
  daemonNotificationSchema,
  DaemonResponse,
  daemonResponseSchema,
  PROGRESS_NOTIFICATION_METHOD,
  REQUEST_BUDGET_NOTIFICATION_METHOD,
} from "../types";
interface ClientInboundFramesContext {
  handleResponse: (response: DaemonResponse) => void;
  inboundClosed: boolean;
  extendPendingRequestOnProgress: (requestId: string, progressToken: string | number) => void;
  adoptPendingRequestBudget: (requestId: string, timeoutMs: number) => void;
  notificationHandlers: Set<(notification: DaemonNotification) => void>;
  pendingRequests: Map<string, PendingDaemonRequest>;
  timer: Timer;
  cancelledRequestIds: Set<string>;
}

export function handleInboundLine(context: ClientInboundFramesContext, line: string): void {
  if (!line.trim() || context.inboundClosed) {
    return;
  }
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    logger.error(`Error parsing daemon response: ${error}`);
    return;
  }
  const notification = daemonNotificationSchema.safeParse(frame);
  if (notification.success) {
    handleNotification(context, notification.data);
    return;
  }
  const response = daemonResponseSchema.safeParse(frame);
  if (response.success) {
    context.handleResponse(response.data);
    return;
  }
  logger.warn("Dropped daemon frame: invalid response or notification envelope");
}

/**
 * Dispatch a daemon-pushed notification frame (issue #3223) to registered
 * handlers. Best-effort: a throwing handler is logged and never tears down
 * the socket or blocks sibling handlers.
 */
export function handleNotification(
  context: Pick<
    ClientInboundFramesContext,
    "extendPendingRequestOnProgress" | "adoptPendingRequestBudget" | "notificationHandlers"
  >,
  notification: DaemonNotification,
): void {
  if (
    notification.method === REQUEST_BUDGET_NOTIFICATION_METHOD &&
    notification.requestId !== undefined &&
    typeof notification.timeoutMs === "number"
  ) {
    context.adoptPendingRequestBudget(notification.requestId, notification.timeoutMs);
    // Internal plumbing for this client's own timer; not for notification handlers.
    return;
  }
  if (
    notification.method === PROGRESS_NOTIFICATION_METHOD &&
    notification.progressToken !== undefined
  ) {
    // Extend THIS client's own pending-request timer -- independent of,
    // and in addition to, whatever the daemon does with its own internal
    // deadline. Without this, the daemon can correctly keep working past
    // the original timeout while this client's fixed local timer still
    // fires and rejects the call out from under it (issue #6222 review,
    // P1). Bounded by ProgressExtendableDeadline's own ceiling, so a
    // request that stops progressing is still killed.
    if (notification.requestId !== undefined) {
      context.extendPendingRequestOnProgress(notification.requestId, notification.progressToken);
    }
  }
  for (const handler of context.notificationHandlers) {
    try {
      handler(notification);
    } catch (error) {
      logger.warn(`Daemon notification handler failed for ${notification.method}: ${error}`);
    }
  }
}

/** Handle a response from daemon */
export function handleResponse(
  context: Pick<ClientInboundFramesContext, "pendingRequests" | "timer" | "cancelledRequestIds">,
  response: DaemonResponse,
): void {
  if (response.id === null) {
    if (context.pendingRequests.size !== 1) {
      logger.warn(
        `Received uncorrelatable daemon response with ${context.pendingRequests.size} pending requests; dropping response`,
      );
      return;
    }
    const error = new ActionableError(response.error ?? "Daemon could not parse a socket request");
    const pending = context.pendingRequests.values().next().value;
    if (!pending) {
      return;
    }
    context.timer.clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    pending.reject(error);
    context.pendingRequests.clear();
    return;
  }
  const pending = context.pendingRequests.get(response.id);
  if (!pending && context.cancelledRequestIds.delete(response.id)) {
    logger.debug(`Dropped daemon response for cancelled request ID: ${response.id}`);
    return;
  }
  if (!pending) {
    logger.warn(`Received response for unknown request ID: ${response.id}`);
    return;
  }

  context.timer.clearTimeout(pending.timeout);
  pending.removeAbortListener?.();
  context.pendingRequests.delete(response.id);

  if (response.success) {
    pending.resolve(response);
  } else {
    pending.reject(daemonResponseError(response));
  }
}

export interface PendingDaemonRequest {
  resolve: (value: DaemonResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  toolName: string;
  /**
   * Present only for a `tools/call` that asked for progress relay
   * (`progressToken !== undefined`). Lets a matching
   * `notifications/progress` frame reset THIS pending request's own
   * timer below, bounded by `deadline`'s ceiling -- without this, the
   * daemon-side deadline can be correctly extended while this client's
   * own independent timer still fires at the original fixed timeout
   * (issue #6222 review, P1). A request with no progressToken never has
   * these set and its timer is never touched, matching today's behavior
   * exactly. Budget announcements can still reschedule their fixed backstop (#13797).
   */
  progressToken?: string | number;
  deadline?: ProgressExtendableDeadline;
  requestTimeoutMs?: number;
  removeAbortListener?: () => void;
  /** Per-request context retained if the shared socket closes. */
  disconnectCause: McpTimeoutError | DaemonDisconnectError;
}
