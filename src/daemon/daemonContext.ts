import { DaemonState } from "./daemonState";
import type { DevicePool } from "./devicePool";
import type { SessionManager } from "./sessionManager";
import type { DeviceSessionRegistry } from "./deviceSessionRegistry";
import type { BrokerConnectionScopes } from "./sessionBroker/connectionScope";
import type { ObserverSessionStore } from "./observerSessionRegistry";

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
  | "isSessionOwnedByConnection"
  | "waitForEmulatorLossIncident"
  | "resolveAutolockSessionForMcpSession"
  | "resolveOwnedDeviceSessionForMcpSession"
  | "assertSessionReadyForAutomation"
  | "assertNotPreparedForOtherRequest"
  | "assertDeviceCleanupComplete"
  | "assertAutolockAccess"
  | "isSafeForObservationServiceStart"
  | "restartReservationForStart"
  | "hasRestartHandoffReservation"
  | "restartStopConfirmedPooledIdentity"
  | "restartReservationForStop"
  | "isRestartReservationOwnedByOtherConnection"
  | "hasUnconfirmedRestartStopReservation"
  | "restartStopConnectionHasLiveSession"
  | "bindingOwnershipGate"
  | "getAllDevices"
  | "mapAndroidDiscovery"
  | "resolveAndroidCanonicalId"
  | "normalizeAndroidDiscovery"
  | "isAndroidTransportAssignable"
  | "androidTransportMayAliasDevice"
  | "androidBindingHold"
  | "assertNotAssignedToBinding"
  | "bindingRefusalFor"
  | "bindingStableIds"
  | "bindingSnapshotRetainedAfterFailedRead"
  | "assertNotClaimedByForeignDaemon"
  | "hasStartedDeviceProcess"
  | "getRecoveringAndroidTargets"
  | "matchesRuntimeIdentity"
  | "hasReusableSerial"
  | "isPooledIdentityUnresolved"
  | "getAndroidTransportAliases"
  | "getAndroidTransportAvdName"
  | "describesPooledRuntime"
  | "getDeviceHealthMarker"
  | "genericAvailability"
  | "poolBucket"
>;

/** The only device-pool mutations server callers take from the daemon's DevicePool (#11806). */
export type DevicePoolWrites = Pick<
  DevicePool,
  | "releaseDevice"
  | "releaseUndeliveredAcquisition"
  | "clearAndroidRebootBudgetForDeletedAvd"
  | "clearIntentionalShutdown"
  | "notifyDeviceReady"
  | "markIntentionalShutdown"
  | "reserveDeviceForShutdown"
  | "retireDeviceForShutdown"
  | "settlePooledRuntimeIdentity"
  | "attachAutolockSessionToMcpSession"
  | "attachExplicitSessionUuidCall"
  | "beginMcpBind"
  | "reserveRestartRecoveryReadiness"
  | "reserveDeviceForReadiness"
  | "reconcileDiscoveryObservation"
>;

/**
 * Narrow view of daemon state for callers that only consume it (#11806).
 * Grow it when a second consumer needs more; do not mirror DaemonState wholesale.
 * Callers take a `DaemonContext` by injection and default to {@link defaultDaemonContext},
 * the bridge onto the `DaemonState` singleton until the daemon composes one itself.
 */
export interface DaemonContext {
  /** Rendered-display session reads, or undefined when the daemon is not initialized (stdio, tests). */
  renderedDisplaySessions(): RenderedDisplaySessionReads | undefined;
  /** The daemon's SessionManager, or undefined when the daemon is not initialized (stdio, tests). */
  sessionManager(): SessionManager | undefined;
  /** The SessionManager, throwing "DaemonState not initialized" when the daemon is not initialized. */
  requireSessionManager(): SessionManager;
  /** The whole device pool, throwing "DaemonState not initialized" when the daemon is not initialized. */
  requireFullDevicePool(): DevicePool;
  /** The device-pool mutations, throwing "DaemonState not initialized" when the daemon is not initialized. */
  requireDevicePoolWrites(): DevicePoolWrites;
  /** Whether the daemon is initialized (stdio and tests are not). */
  isInitialized(): boolean;
  /**
   * The whole device pool for callers that hand it on to session creation, or undefined when the
   * daemon is not initialized. Prefer {@link DaemonContext.devicePool} or `devicePoolWrites`; narrow
   * this when `getOrCreateSession` takes a narrower pool.
   */
  fullDevicePool(): DevicePool | undefined;
  /** Read-only device-pool view, or undefined when the daemon is not initialized (stdio, tests). */
  devicePool(): DevicePoolReads | undefined;
  /** The device-pool mutations callers need, or undefined when the daemon is not initialized. */
  devicePoolWrites(): DevicePoolWrites | undefined;
  /** Socket sessions bound to broker bindings, or undefined when the daemon is not initialized. */
  brokerConnectionScopes(): Pick<BrokerConnectionScopes, "get" | "forGrantedSession"> | undefined;
  /** The observer-session store, or undefined when the daemon is not initialized or has none. */
  observerSessionRegistry(): ObserverSessionStore | undefined;
  /** Device-session identity lookups, or undefined when the daemon is not initialized. */
  deviceSessionRegistry(): Pick<DeviceSessionRegistry, "getByDeviceId"> | undefined;
}

/** The singleton, initialized or not; the one place this module resolves it. */
function currentDaemon(): DaemonState {
  return DaemonState.getInstance();
}

/** The singleton once the daemon is initialized, else undefined (stdio, tests); resolved on every read. */
function initializedDaemon(): DaemonState | undefined {
  const daemon = currentDaemon();
  return daemon.isInitialized() ? daemon : undefined;
}

/** Bridge onto the `DaemonState` singleton; resolves it lazily on every read. */
export const defaultDaemonContext: DaemonContext = {
  renderedDisplaySessions: () => initializedDaemon()?.getSessionManager(),
  sessionManager: () => initializedDaemon()?.getSessionManager(),
  requireSessionManager: () => currentDaemon().getSessionManager(),
  requireFullDevicePool: () => currentDaemon().getDevicePool(),
  requireDevicePoolWrites: () => currentDaemon().getDevicePool(),
  isInitialized: () => currentDaemon().isInitialized(),
  fullDevicePool: () => initializedDaemon()?.getDevicePool(),
  devicePool: () => initializedDaemon()?.getDevicePool(),
  devicePoolWrites: () => initializedDaemon()?.getDevicePool(),
  brokerConnectionScopes: () => initializedDaemon()?.getBrokerConnectionScopes(),
  observerSessionRegistry: () => initializedDaemon()?.getObserverSessionRegistry(),
  deviceSessionRegistry: () => initializedDaemon()?.getDeviceSessionRegistry(),
};
