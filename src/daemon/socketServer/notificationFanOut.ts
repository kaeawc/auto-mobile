import {
  SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
  type SessionDeviceRebound,
} from "../sessionDeviceReboundBroadcast";
import {
  type DaemonNotification,
  type DaemonRequest,
  type DaemonResponse,
  PROGRESS_NOTIFICATION_METHOD,
  RESOURCE_SUBSCRIBE_METHOD,
} from "../types";
import {
  LIST_CHANGED_NOTIFICATION_METHODS,
  RESOURCE_UPDATED_NOTIFICATION_METHOD,
  type ListChangedKind,
  type ResourceUpdateTargets,
} from "../listChangedBroadcast";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../sessionReleaseBroadcast";
import { idleReleaseField } from "../releaseReasons";

/**
 * Push-notification fan-out for the control socket (#11815): which sockets receive a
 * list-changed / resource-updated / session-released / progress frame, and the resource
 * subscribe bookkeeping. The server keeps the subscriber state and the socket map; this module
 * owns the frame shapes and the per-subscriber delivery rules so they are testable with fakes.
 */

/** The server's socket map as the fan-out sees it. Writes are best-effort and never throw. */
export interface NotificationTransport {
  /** Whether the socket session still has a socket registered. */
  hasSocket(sessionId: string): boolean;
  write(sessionId: string, frame: DaemonNotification, onFlushed?: () => void): void;
}

/** Pushes a list-changed frame to every subscribed socket session (issue #3223). */
export function broadcastListChanged(
  subscribers: Iterable<string>,
  transport: NotificationTransport,
  kind: ListChangedKind,
): void {
  const notification: DaemonNotification = {
    type: "daemon_notification",
    method: LIST_CHANGED_NOTIFICATION_METHODS[kind],
  };
  for (const sessionId of subscribers) {
    if (transport.hasSocket(sessionId)) {
      transport.write(sessionId, notification);
    }
  }
}

/** Pushes one resource-updated frame per URI the broadcaster resolves for each live subscriber. */
export function broadcastResourceUpdated(
  subscriptions: ReadonlyMap<string, Set<string>>,
  transport: NotificationTransport,
  resolveTargets: ResourceUpdateTargets,
): void {
  for (const [sessionId, uris] of subscriptions) {
    if (!transport.hasSocket(sessionId)) {
      continue;
    }
    for (const uri of resolveTargets(uris)) {
      transport.write(sessionId, {
        type: "daemon_notification",
        method: RESOURCE_UPDATED_NOTIFICATION_METHOD,
        uri,
      });
    }
  }
}

/** Applies a resources/subscribe or resources/unsubscribe frame to one socket's URI set. */
export function applyResourceSubscription(
  subscriptions: Map<string, Set<string>>,
  sessionId: string,
  request: DaemonRequest,
): DaemonResponse {
  const uri = request.params?.uri;
  if (typeof uri !== "string" || uri.length === 0) {
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: "Resource subscription requires params.uri",
    };
  }
  if (request.method === RESOURCE_SUBSCRIBE_METHOD) {
    const uris = subscriptions.get(sessionId) ?? new Set<string>();
    uris.add(uri);
    subscriptions.set(sessionId, uris);
  } else {
    const uris = subscriptions.get(sessionId);
    uris?.delete(uri);
    if (uris?.size === 0) {
      subscriptions.delete(sessionId);
    }
  }
  return { id: request.id, type: "mcp_response", success: true, result: {} };
}

export interface SessionReleasedFields {
  readonly releasedSessionId: string;
  readonly reason?: string;
  readonly release?: DaemonNotification["release"];
  readonly recordingIds?: string[];
}

/**
 * Pushes a session-released frame (issue #4610) to every subscribed socket session. Each write's
 * flush is tracked in `pendingWrites` so shutdown can drain them. `releasedSessionId` is the daemon
 * session key that was just released; the subscribers' ids are socket-client ids.
 */
export function broadcastSessionReleased(
  subscribers: Iterable<string>,
  transport: NotificationTransport,
  pendingWrites: Set<Promise<void>>,
  released: SessionReleasedFields,
): void {
  const { releasedSessionId, reason, release, recordingIds } = released;
  const notification: DaemonNotification = {
    type: "daemon_notification",
    method: SESSION_RELEASED_NOTIFICATION_METHOD,
    sessionId: releasedSessionId,
    ...(reason !== undefined ? { reason } : {}),
    ...idleReleaseField(reason),
    ...(release !== undefined ? { release } : {}),
    ...(recordingIds && recordingIds.length > 0 ? { recordingIds } : {}),
  };
  for (const sessionId of subscribers) {
    if (!transport.hasSocket(sessionId)) {
      continue;
    }
    const pending = Promise.withResolvers<void>();
    pendingWrites.add(pending.promise);
    transport.write(sessionId, notification, () => {
      pendingWrites.delete(pending.promise);
      pending.resolve();
    });
  }
}

export interface ProgressTick {
  readonly requestId: string;
  readonly progressToken: string | number;
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

/**
 * Pushes one `notifications/progress` tick to the single socket session that requested it (issue
 * #6205). Deliberately not gated on the general-notification subscription: a `progressToken` on the
 * session's own in-flight request is itself the opt-in (#6222 review, P2). Only a torn-down socket
 * is skipped.
 */
export function pushProgressNotification(
  transport: NotificationTransport,
  sessionId: string,
  tick: ProgressTick,
): void {
  const { requestId, progressToken, progress, total, message } = tick;
  if (!transport.hasSocket(sessionId)) {
    return;
  }
  transport.write(sessionId, {
    type: "daemon_notification",
    method: PROGRESS_NOTIFICATION_METHOD,
    requestId,
    progressToken,
    progress,
    ...(total !== undefined ? { total } : {}),
    ...(message !== undefined ? { message } : {}),
  });
}

/** Rebind pushes use the same subscriber and shutdown-drain rules as session releases. */
export function broadcastSessionDeviceRebound(
  subscribers: Iterable<string>,
  transport: NotificationTransport,
  pendingWrites: Set<Promise<void>>,
  event: SessionDeviceRebound,
): void {
  const notification: DaemonNotification = {
    type: "daemon_notification",
    method: SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
    ...event,
  };
  for (const sessionId of subscribers) {
    if (!transport.hasSocket(sessionId)) {
      continue;
    }
    const pending = Promise.withResolvers<void>();
    pendingWrites.add(pending.promise);
    transport.write(sessionId, notification, () => {
      pendingWrites.delete(pending.promise);
      pending.resolve();
    });
  }
}
