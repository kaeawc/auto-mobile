import { DaemonState } from "./daemonState";
import type { DevicePool } from "./devicePool";
import type { SessionManager } from "./sessionManager";

/** The per-session rendered-display reads action code takes from the daemon's SessionManager. */
export type RenderedDisplaySessionReads = Pick<
  SessionManager,
  | "getSessionForDevice"
  | "getLastRenderedDisplayKey"
  | "getLastRenderedDisplayGeneration"
  | "getLastRenderedDisplayRevision"
>;

/** The device-pool reads and precondition assertions server callers take from the daemon's DevicePool. */
export type DevicePoolReads = Pick<
  DevicePool,
  | "getDevice"
  | "isShutdownReserved"
  | "isSessionOwnedByOtherConnection"
  | "resolveAutolockSessionForMcpSession"
  | "resolveOwnedDeviceSessionForMcpSession"
  | "assertSessionReadyForAutomation"
  | "assertNotPreparedForOtherRequest"
  | "assertDeviceCleanupComplete"
  | "assertAutolockAccess"
  | "isSafeForObservationServiceStart"
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
  /** The daemon's SessionManager, or undefined when the daemon is not initialized (stdio, tests). */
  sessionManager(): SessionManager | undefined;
  /** Read-only device-pool view, or undefined when the daemon is not initialized (stdio, tests). */
  devicePool(): DevicePoolReads | undefined;
}

/** Bridge onto the `DaemonState` singleton; resolves it lazily on every read. */
export const defaultDaemonContext: DaemonContext = {
  renderedDisplaySessions() {
    const daemon = DaemonState.getInstance();
    return daemon.isInitialized() ? daemon.getSessionManager() : undefined;
  },
  sessionManager() {
    const daemon = DaemonState.getInstance();
    return daemon.isInitialized() ? daemon.getSessionManager() : undefined;
  },
  devicePool() {
    const daemon = DaemonState.getInstance();
    return daemon.isInitialized() ? daemon.getDevicePool() : undefined;
  },
};
