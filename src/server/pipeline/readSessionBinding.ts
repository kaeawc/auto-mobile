import { defaultDaemonContext } from "../../daemon/daemonContext";
import { ReadSessionNotBoundError } from "../../daemon/ReadSessionNotBoundError";

/** What the read-binding rule reads from the daemon (#13540). */
export interface ReadSessionBindingView {
  /**
   * Whether a still-connected client other than `mcpSessionId` owns the session (a derived
   * `base:label` session counts as its base): the same ownership question control calls ask.
   */
  isSessionOwnedByOtherConnection(sessionUuid: string, mcpSessionId: string): boolean;
  /** The connection declared the session's owner token. */
  connectionPresentsSessionOwnerToken(sessionUuid: string, mcpSessionId: string): boolean;
  /** The sessions a broker binding granted this connection, if it is a broker connection. */
  brokerGrantedSessions(mcpSessionId: string): ReadonlySet<string> | undefined;
}

/**
 * #13540 (owner decision 2026-11-07): a `sessionUuid` is not a bearer capability. Reads follow
 * the same ownership rule as control calls (#11344): a read-only call that names a session another
 * connected client owns is refused with the non-retryable `read_session_not_bound`, unless this
 * connection was granted the session by a broker binding or presents the session's owner token.
 * The owning connection itself, and a session no connected client owns (its owner disconnected,
 * such as a finished one-shot `--cli` call), are not refused. An id that names no live device
 * session (an IDE observer session, #10968) is owned by no connection, so the read runs
 * sessionless. A call with no connection identity (direct mode, or an internal plan step admitted
 * under its enclosing call) is not judged.
 */
export function readSessionBindingRefusal(
  view: ReadSessionBindingView,
  input: { toolName: string; sessionUuid: string | undefined; mcpSessionId: string | undefined },
): ReadSessionNotBoundError | undefined {
  const { sessionUuid, mcpSessionId } = input;
  if (
    !sessionUuid ||
    !mcpSessionId ||
    !view.isSessionOwnedByOtherConnection(sessionUuid, mcpSessionId)
  ) {
    return undefined;
  }
  const base = sessionUuid.split(":", 1)[0] ?? sessionUuid;
  const granted = view.brokerGrantedSessions(mcpSessionId);
  const holds =
    granted?.has(sessionUuid) === true ||
    granted?.has(base) === true ||
    view.connectionPresentsSessionOwnerToken(sessionUuid, mcpSessionId);
  return holds ? undefined : new ReadSessionNotBoundError(input.toolName, sessionUuid);
}

/** The daemon's view for {@link readSessionBindingRefusal}; undefined outside a daemon. */
export function daemonReadSessionBindingView(): ReadSessionBindingView | undefined {
  const pool = defaultDaemonContext.devicePool();
  if (!pool) {
    return undefined;
  }
  return {
    isSessionOwnedByOtherConnection: (sessionUuid, mcpSessionId) =>
      pool.isSessionOwnedByOtherConnection(sessionUuid, mcpSessionId),
    connectionPresentsSessionOwnerToken: (sessionUuid, mcpSessionId) =>
      pool.connectionPresentsSessionOwnerToken(sessionUuid, mcpSessionId),
    brokerGrantedSessions: (mcpSessionId) =>
      defaultDaemonContext.brokerConnectionScopes()?.get(mcpSessionId)?.sessionUuids,
  };
}

/**
 * Throws {@link ReadSessionNotBoundError} for a read naming a session another connected client
 * owns (#13540). Control calls (`readOnly: false`) keep their own owner and broker-grant refusals.
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
