import { defaultDaemonContext } from "../../daemon/daemonContext";
import { ReadSessionNotBoundError } from "../../daemon/ReadSessionNotBoundError";

/** What the read-binding rule reads from the daemon (#13540). */
export interface ReadSessionBindingView {
  /** Whether `sessionUuid` names a live device session holding a device. */
  isLiveDeviceSession(sessionUuid: string): boolean;
  /** The connection acquired or restored the session (or its base), or holds its autolock route. */
  isSessionOwnedByConnection(sessionUuid: string, mcpSessionId: string): boolean;
  /** The connection declared the session's owner token. */
  connectionPresentsSessionOwnerToken(sessionUuid: string, mcpSessionId: string): boolean;
  /** The connection bound the session to its device through `setActiveDevice`. */
  hasSetActiveDeviceBinding(sessionUuid: string, mcpSessionId: string): boolean;
  /** The sessions a broker binding granted this connection, if it is a broker connection. */
  brokerGrantedSessions(mcpSessionId: string): ReadonlySet<string> | undefined;
}

/**
 * #13540 (owner decision 2026-11-07): a `sessionUuid` is not a bearer capability. A read-only call
 * from a connection that names a live device session must come from a connection that holds the
 * session binding (it acquired or restored the session, holds its autolock route, bound it with
 * `setActiveDevice`, or a broker binding granted it) or that presents the session's owner token. Otherwise it is refused with the
 * non-retryable `read_session_not_bound`. An id that names no live device session (an IDE observer
 * session, #10968) is not judged here: the read runs sessionless. A call with no connection
 * identity (direct mode, or an internal plan step admitted under its enclosing call) is not judged.
 */
export function readSessionBindingRefusal(
  view: ReadSessionBindingView,
  input: { toolName: string; sessionUuid: string | undefined; mcpSessionId: string | undefined },
): ReadSessionNotBoundError | undefined {
  const { sessionUuid, mcpSessionId } = input;
  if (!sessionUuid || !mcpSessionId || !view.isLiveDeviceSession(sessionUuid)) {
    return undefined;
  }
  const base = sessionUuid.split(":", 1)[0] ?? sessionUuid;
  const granted = view.brokerGrantedSessions(mcpSessionId);
  const holds =
    view.isSessionOwnedByConnection(sessionUuid, mcpSessionId) ||
    view.hasSetActiveDeviceBinding(sessionUuid, mcpSessionId) ||
    granted?.has(sessionUuid) === true ||
    granted?.has(base) === true ||
    view.connectionPresentsSessionOwnerToken(sessionUuid, mcpSessionId);
  return holds ? undefined : new ReadSessionNotBoundError(input.toolName, sessionUuid);
}

/** The daemon's view for {@link readSessionBindingRefusal}; undefined outside a daemon. */
export function daemonReadSessionBindingView(): ReadSessionBindingView | undefined {
  const pool = defaultDaemonContext.devicePool();
  const sessions = defaultDaemonContext.sessionManager();
  if (!pool || !sessions) {
    return undefined;
  }
  return {
    isLiveDeviceSession: (sessionUuid) => !!sessions.findSession(sessionUuid)?.assignedDevice,
    isSessionOwnedByConnection: (sessionUuid, mcpSessionId) =>
      pool.isSessionOwnedByConnection(sessionUuid, mcpSessionId),
    connectionPresentsSessionOwnerToken: (sessionUuid, mcpSessionId) =>
      pool.connectionPresentsSessionOwnerToken(sessionUuid, mcpSessionId),
    hasSetActiveDeviceBinding: (sessionUuid, mcpSessionId) =>
      pool.hasMcpSessionReadBinding(sessionUuid, mcpSessionId),
    brokerGrantedSessions: (mcpSessionId) =>
      defaultDaemonContext.brokerConnectionScopes()?.get(mcpSessionId)?.sessionUuids,
  };
}

/**
 * Throws {@link ReadSessionNotBoundError} for an unbound read naming a live session (#13540).
 * Control calls (`readOnly: false`) keep their own owner and broker-grant refusals.
 */
export function assertReadCallerHoldsSessionBinding(input: {
  toolName: string;
  readOnly: boolean;
  sessionUuid: string | undefined;
  mcpSessionId: string | undefined;
}): void {
  const view =
    input.readOnly && input.sessionUuid && input.mcpSessionId
      ? daemonReadSessionBindingView()
      : undefined;
  const refusal = view ? readSessionBindingRefusal(view, input) : undefined;
  if (refusal) {
    throw refusal;
  }
}
