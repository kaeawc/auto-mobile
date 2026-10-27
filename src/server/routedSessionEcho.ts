import { defaultDaemonContext, type DaemonContext } from "../daemon/daemonContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { executionTracker } from "../daemon/executionTracker";
import { sessionDeviceBinding } from "../daemon/sessionDeviceBinding";
import { withSessionDeviceMeta, withRoutedSessionMeta } from "../daemon/routedSessionMeta";

/**
 * Echo in a daemon tool result the session its execution was admitted under and used (#10974),
 * as its base session for a derived `${base}:${label}` one. Call before the execution ends.
 */
export function withAdmittedSessionEcho<T>(
  result: T,
  executionId: string,
  daemon: DaemonContext = defaultDaemonContext,
): T {
  const routed = executionTracker.getAdmittedSessionUse(executionId);
  const sessionManager = daemon.sessionManager();
  const sessionUuid = resolveToolSelectionBaseSessionUuid(routed, sessionManager) ?? routed;
  const echoed = withRoutedSessionMeta(result, sessionUuid);
  // The binding is the device the call actually ran on: a label-routed call used its derived
  // `${base}:${label}` session, whose serial can differ from the base session's.
  const usedSession = routed ? sessionManager?.peekSession(routed) : undefined;
  const session =
    usedSession ?? (sessionUuid ? sessionManager?.peekSession(sessionUuid) : undefined);
  return session ? withSessionDeviceMeta(echoed, sessionDeviceBinding(session)) : echoed;
}
