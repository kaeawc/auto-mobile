import { defaultDaemonContext } from "../daemon/daemonContext";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import type { SessionAccess } from "../daemon/sessionManager";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";
import { isDeviceSessionAcquisitionTool } from "../daemon/deviceSessionResult";

const FOREIGN_SESSION_REMEDY =
  "Acquire a device on this connection (getAndroid, getApple or startDevice), or wait for the owner to release the session.";
/** `force` overrides the device-holder check, never the naming of another client's session. */
const FORCED_CALL_REMEDY =
  "force: true does not override this: to force the call on a device another session holds, leave sessionUuid out.";

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
 * Whether a still-connected client other than `mcpSessionId` owns the live session `sessionUuid`.
 * The one ownership question behind the refusal below and behind what counts as use of a named
 * session. False for a caller with no connection identity, which cannot be told apart from the
 * owner, for a session no connected client owns, and outside a daemon.
 */
export function isSessionOwnedByAnotherConnection(
  sessionUuid: string | undefined,
  mcpSessionId: string | undefined,
): boolean {
  return (
    !!sessionUuid &&
    !!mcpSessionId &&
    !!defaultDaemonContext.devicePool()?.isSessionOwnedByOtherConnection(sessionUuid, mcpSessionId)
  );
}

/**
 * How a plain tool call uses the session it names (#11555). A read only watches it. A call from a
 * connection that does not own it while its owner is connected is not the owner's use of it:
 * admitted as `non-owner-control`, it passes the refusals an owner's call passes and stamps
 * nothing. Only the owner's own control call, or one on a session no connected client owns, is
 * use (`acquire`, the default).
 */
export function namedSessionAccess(
  readOnly: boolean,
  ownedByAnotherConnection: boolean,
): { access: SessionAccess } | undefined {
  if (readOnly) {
    return { access: "read-only" };
  }
  return ownedByAnotherConnection ? { access: "non-owner-control" } : undefined;
}

/**
 * #11344: a control call naming a session that another connected client owns is refused with the
 * typed `device_owned_by_other_session`, with autolock on or off. Ownership is cooperative: no
 * token is needed, but a session is never driven or taken over by merely naming its UUID. A
 * caller with no connection identity is left to the device-holder check. `args` are the refused
 * call's own: one carrying `force: true` is told how a forced stop is made (#11555).
 */
export function refuseControlOnForeignOwnedSession(
  toolName: string,
  sessionUuid: string | undefined,
  mcpSessionId: string | undefined,
  args?: unknown,
): void {
  if (!sessionUuid || !isSessionOwnedByAnotherConnection(sessionUuid, mcpSessionId)) {
    return;
  }
  const deviceId = defaultDaemonContext.sessionManager()?.findSession(sessionUuid)?.assignedDevice;
  const forced = typeof args === "object" && args !== null && Reflect.get(args, "force") === true;
  const remedy = forced
    ? `${FOREIGN_SESSION_REMEDY} ${FORCED_CALL_REMEDY}`
    : FOREIGN_SESSION_REMEDY;
  throw new InputDeviceOwnedError(
    toolName,
    deviceId ?? "unknown",
    sessionUuid,
    remedy,
    `${toolName} refused: session ${sessionUuid} is owned by another connected client. ${remedy}`,
  );
}
