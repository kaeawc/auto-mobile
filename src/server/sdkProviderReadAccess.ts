import { DaemonState } from "../daemon/daemonState";
import { isSameHolderSession } from "../daemon/inputDeviceOwnership";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";

/** Who a resource read came from: the connection's bound session and its ownership proof. */
export interface SdkReadRequester {
  sessionUuid?: string;
  ownsSession?: (sessionUuid: string) => boolean;
}

/**
 * True when the current reader is not the holder of a device another session holds (#11350). Such
 * a reader must not start the app's process through the SDK content provider. A read on a free
 * device, the holder's own read (a derived `${base}:${label}` session counts as its base), and a
 * call with no initialized daemon all keep today's behaviour.
 *
 * A tool call names its session in the tool-selection context; a `resources/read` carries no such
 * context, so its connection's identity is passed as `requester`.
 */
export function isNonOwnerReaderOfHeldDevice(
  deviceId: string,
  requester?: SdkReadRequester,
): boolean {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return false;
  }
  const sessionManager = daemonState.getSessionManager();
  const owner = sessionManager.getSessionForDevice(deviceId) ?? undefined;
  if (!owner) {
    return false;
  }
  if (requester?.ownsSession?.(owner) === true) {
    return false;
  }
  const requesterSessionUuid =
    getToolSelectionContext()?.routingSessionUuid ?? requester?.sessionUuid;
  return !isSameHolderSession(owner, requesterSessionUuid, sessionManager);
}
