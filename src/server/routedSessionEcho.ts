import { DaemonState } from "../daemon/daemonState";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { executionTracker } from "./executionTracker";
import { withRoutedSessionMeta } from "./routedSessionMeta";

/**
 * Echo in a daemon tool result the session its execution was admitted under and used (#10974),
 * as its base session for a derived `${base}:${label}` one. Call before the execution ends.
 */
export function withAdmittedSessionEcho<T>(result: T, executionId: string): T {
  const routed = executionTracker.getAdmittedSessionUse(executionId);
  const sessionManager = DaemonState.getInstance().isInitialized()
    ? DaemonState.getInstance().getSessionManager()
    : undefined;
  return withRoutedSessionMeta(
    result,
    resolveToolSelectionBaseSessionUuid(routed, sessionManager) ?? routed,
  );
}
