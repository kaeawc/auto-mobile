import { DaemonState } from "../daemon/daemonState";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";

const FOREIGN_SESSION_REMEDY =
  "Acquire a device on this connection (getAndroid, getApple or startDevice), or wait for the owner to release the session.";

/**
 * #11344: a control call naming a session that another connected client owns is refused with the
 * typed `device_owned_by_other_session`, with autolock on or off. Ownership is cooperative: no
 * token is needed, but a session is never driven or taken over by merely naming its UUID. A
 * caller with no connection identity is left to the device-holder check.
 */
export function refuseControlOnForeignOwnedSession(
  toolName: string,
  sessionUuid: string | undefined,
  mcpSessionId: string | undefined,
): void {
  const daemonState = DaemonState.getInstance();
  if (!sessionUuid || !mcpSessionId || !daemonState.isInitialized()) {
    return;
  }
  if (!daemonState.getDevicePool().isSessionOwnedByOtherConnection(sessionUuid, mcpSessionId)) {
    return;
  }
  const deviceId = daemonState.getSessionManager().getSession(sessionUuid)?.assignedDevice;
  throw new InputDeviceOwnedError(
    toolName,
    deviceId ?? "unknown",
    sessionUuid,
    FOREIGN_SESSION_REMEDY,
    `${toolName} refused: session ${sessionUuid} is owned by another connected client. ` +
      FOREIGN_SESSION_REMEDY,
  );
}
