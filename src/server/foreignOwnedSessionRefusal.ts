import { DaemonState } from "../daemon/daemonState";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";
import { isDeviceSessionAcquisitionTool } from "./deviceSessionResult";

const FOREIGN_SESSION_REMEDY =
  "Acquire a device on this connection (getAndroid, getApple or startDevice), or wait for the owner to release the session.";

/** What the owner rule reads off a registered tool. */
export interface OwnerRuleTool {
  name: string;
  requiresDevice?: boolean;
  isDeviceReadOnlyCall?: (args: any) => boolean;
}

/**
 * Whether the owner rule judges this call: a control call runs on the session it names, so it is
 * refused there while another connected client owns that session. The one predicate for the MCP
 * ingress and for nested internal calls (#11555), for device-aware and plain tools alike (#11542).
 * A read only watches and an acquisition names no session to run on; `setActiveDevice` refuses in
 * its own handler, and editing another session's tool profile is intended
 * (docs/using/device-ownership.md).
 */
export function isControlCallOnNamedSession(tool: OwnerRuleTool, args: unknown): boolean {
  if (isDeviceSessionAcquisitionTool(tool.name) || tool.isDeviceReadOnlyCall?.(args) === true) {
    return false;
  }
  return (
    tool.requiresDevice === true ||
    (tool.name !== "setActiveDevice" && tool.name !== SET_TOOL_ENABLED_TOOL_NAME)
  );
}

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
