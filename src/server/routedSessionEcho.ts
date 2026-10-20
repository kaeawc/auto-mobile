import { defaultDaemonContext, type DaemonContext } from "../daemon/daemonContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { executionTracker } from "../daemon/executionTracker";
import { withRoutedSessionMeta } from "../daemon/routedSessionMeta";

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
  return withRoutedSessionMeta(
    result,
    resolveToolSelectionBaseSessionUuid(routed, sessionManager) ?? routed,
  );
}
