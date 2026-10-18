import type { DaemonOptions } from "./types";
import type { DaemonStartHost } from "./daemonStartHost";
import type { DaemonHttpIngressTestHooks } from "./daemonHttpIngress";
import type { HealthFailureKind } from "./daemonHealthCheck";
import type { DeviceSessionRegistry } from "./deviceSessionRegistry";
import type { DeviceSessionRoutingTargets } from "./daemon";
import type { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import type { NavigationGraphPushTarget, StorageSubscriptionRequest } from "./daemonStreamRouting";
import type { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import type { ObservationStreamHealth } from "./ObservationStreamHealth";
import type { ObserverSessionRegistry } from "./observerSessionRegistry";
import type { DevicePool, PooledDevice } from "./devicePool";
import type { Session, SessionManager } from "./sessionManager";
import type { SingleFlightInterval } from "./SingleFlightInterval";
import type { AppearanceSyncTarget } from "./AppearanceSyncScheduler";
import type { DaemonExitRecordFileSystem } from "./daemonExitRecord";
import type { BindingJournalOwner } from "./sessionBroker/registry/bindingRegistry";
import type { SqliteBindingRegistry } from "./sessionBroker/registry/sqliteBindingRegistry";

/**
 * The Daemon internals unit tests drive, as one typed view (`daemon.testHooks`) instead of casts
 * into private state. Production code never reads it.
 */
export interface DaemonTestHooks {
  readonly daemonSessionId: string;
  readonly options: DaemonOptions;
  readonly port: number;
  readonly httpIngress: DaemonHttpIngressTestHooks;
  /** Replace the session manager the HTTP ingress and handlers read. */
  setSessionManager(manager: SessionManager): void;
  /** Replace the exit-record file system (the host disk the daemon writes its exit record to). */
  setExitRecordFileSystem(exitRecordFileSystem: DaemonExitRecordFileSystem): void;
  /** Replace the host binding registry the daemon opens lazily. */
  setBindingRegistry(registry: Promise<SqliteBindingRegistry>): void;
  getAppearanceSyncTargets(): AppearanceSyncTarget[];
  bindingJournalOwner(): BindingJournalOwner;
  /** Replace the device pool the disconnect handling reads. */
  setDevicePool(pool: DevicePool): void;
  recordAndTryRecoverCapturedDisconnect(
    deviceId: string,
    pooledDevice: PooledDevice | null,
    assignmentCount: number,
    sessionId: string | null | undefined,
    session: Session | null,
    forceGeneration: number | undefined,
  ): Promise<{ incidentId: string | undefined; handled: boolean }>;
  hasDeferredSessionRecoverySweep(sweep: Promise<void>): boolean;
  setObserverSessionRegistry(registry: ObserverSessionRegistry): void;
  setObservationStreamHealth(health: ObservationStreamHealth): void;
  setSessionBrokerConfigPath(path: string | undefined): void;
  setStartHost(host: DaemonStartHost): void;
  processStartHost(): DaemonStartHost;
  startThroughSocketBind(): Promise<void>;
  startAfterSocketBind(): Promise<void>;
  startUntilReady(): Promise<void>;
  /** Replace the named start-sequence steps with doubles. */
  setStartSteps(
    steps: Partial<{
      startThroughSocketBind: () => Promise<void>;
      startAfterSocketBind: () => Promise<void>;
      stopAfterFailedStartup: () => Promise<void>;
    }>,
  ): void;
  stopAfterFailedStartup(): Promise<void>;
  closeManagedExecutionRelease(): Promise<void>;
  quiesceProvisioningIngress(): Promise<void>;
  interruptProvisioningForShutdown(drainTimeoutMs: number): Promise<void>;
  resolveStartupCompletion(): void;
  rejectStartupCompletion(reason: unknown): void;
  startHealthCheckTimer(): void;
  stopHealthCheckTimer(): Promise<void>;
  healthCheck(): SingleFlightInterval | null;
  lastDatabaseHealthFailure(): string | undefined;
  attemptRecovery(failureKind?: HealthFailureKind): Promise<void>;
  /** Replace recovery, as a double that records the failure kind instead of restarting anything. */
  setAttemptRecovery(recover: (failureKind?: HealthFailureKind) => Promise<void>): void;
  readonly deviceSessionRegistry: DeviceSessionRegistry;
  readonly deviceDataStreamServer: ReturnType<typeof getDeviceDataStreamServer>;
  setDeviceSessionRoutingTargets(resolve: () => DeviceSessionRoutingTargets): void;
  setupDeviceSessionRouting(): void;
  setupDeviceDataStreamCallback(): void;
  setupNavigationGraphStreamListener(server: NavigationGraphPushTarget | null): void;
  /** Replace the stream-listener wiring with a double. */
  setNavigationGraphStreamListener(
    listen: (server: NavigationGraphPushTarget | null) => void,
  ): void;
  /** Replace the navigation bridge's attach with a double. */
  setNavigationGraphBridgeAttach(attach: (manager: NavigationGraphManager) => void): void;
  applyStorageSubscriptionRequest(request: StorageSubscriptionRequest): Promise<void>;
}
