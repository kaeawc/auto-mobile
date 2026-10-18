import { DaemonState } from "./daemonState";
import type { SessionManager } from "./sessionManager";

/** The per-session rendered-display reads action code takes from the daemon's SessionManager. */
export type RenderedDisplaySessionReads = Pick<
  SessionManager,
  | "getSessionForDevice"
  | "getLastRenderedDisplayKey"
  | "getLastRenderedDisplayGeneration"
  | "getLastRenderedDisplayRevision"
>;

/**
 * Narrow, read-only view of daemon state for callers that only consume it (#11806).
 * Grow it when a second consumer needs more; do not mirror DaemonState wholesale.
 * Callers take a `DaemonContext` by injection and default to {@link defaultDaemonContext},
 * the bridge onto the `DaemonState` singleton until the daemon composes one itself.
 */
export interface DaemonContext {
  /** Rendered-display session reads, or undefined when the daemon is not initialized (stdio, tests). */
  renderedDisplaySessions(): RenderedDisplaySessionReads | undefined;
}

/** Bridge onto the `DaemonState` singleton; resolves it lazily on every read. */
export const defaultDaemonContext: DaemonContext = {
  renderedDisplaySessions() {
    const daemon = DaemonState.getInstance();
    return daemon.isInitialized() ? daemon.getSessionManager() : undefined;
  },
};
