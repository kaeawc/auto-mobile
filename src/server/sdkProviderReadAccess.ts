import { DaemonState } from "../daemon/daemonState";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";

/**
 * True when the current reader is not the holder of a device another session holds (#11350). Such
 * a reader must not start the app's process through the SDK content provider. A read on a free
 * device, the holder's own read (a derived `${base}:${label}` session counts as its base), and a
 * call with no initialized daemon all keep today's behaviour.
 */
export function isNonOwnerReaderOfHeldDevice(deviceId: string): boolean {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return false;
  }
  const sessionManager = daemonState.getSessionManager();
  const owner = sessionManager.getSessionForDevice(deviceId) ?? undefined;
  if (!owner) {
    return false;
  }
  const requester = getToolSelectionContext()?.routingSessionUuid;
  if (!requester) {
    return true;
  }
  const base = (uuid: string) => resolveToolSelectionBaseSessionUuid(uuid, sessionManager) ?? uuid;
  return base(requester) !== base(owner);
}
