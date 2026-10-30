import { InMemoryDeviceTable } from "../deviceTable";
import { type DeviceRehydrationReservation } from "../deviceReservations";
import { OwnerConnectionIntervals } from "../connectedOwnerStallExcuse";
import { AndroidTransportAliases } from "../../utils/androidSerial";
import { type ForeignDeviceOwnership } from "../foreignDeviceOwnership";
import { type DeviceHealthMarkers } from "../deviceHealthMarkers";
import type { AmbientExecutionIdReader } from "../../utils/interfaces/AmbientExecutionIdReader";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import { SessionManager, type Session } from "../sessionManager";
import { BootedDevice } from "../../models";
import { Mutex } from "async-mutex";
import { PlatformDeviceManager } from "../../devices/deviceUtils";
import { Timer } from "../../utils/SystemTimer";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import { TTLCache } from "../../utils/cache/Cache";
import { type IdGenerator } from "../../utils/IdGenerator";
import type { InstalledAppsStore } from "../../db/installedAppsRepository";
import { type RetryExecutor } from "../../utils/retry/RetryExecutor";
import { DevicePoolRefresh, type DevicePoolRefreshResult } from "../devicePoolRefresh";
import { type DeviceRecoveryPolicy } from "../poolConfig";
import { DeviceSessionRepository } from "../../db/deviceSessionRepository";
import { AndroidDeviceReboot } from "../../devices/androidDeviceReboot";
import { DeviceCriteriaMatcher } from "../DeviceCriteriaMatcher";
import { type EmulatorConsoleBusyRegistry } from "../../utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import { EmulatorLossIncidentLedger } from "../emulatorLossIncidentLedger";
import { AdbResetSessionRecovery } from "../adbResetSessionRecovery";
import { IdleDeviceReaper } from "../idleDeviceReaper";
import { DeviceRecoveryCoordinator } from "../deviceRecoveryCoordinator";
import { SessionPreservingRecoveryRunner } from "../sessionPreservingRecovery";
import { DeviceAutolockManager } from "../deviceAutolockManager";
import { type BindingExclusion } from "../sessionBroker/provisioning/exclusion";
import { AdbServerResetQuarantine } from "../adbServerResetQuarantine";
import { EmulatorProcessLifecycle } from "../emulatorProcessLifecycle";
import { type EmulatorProcessOutputTail } from "../EmulatorProcessOutputTail";
import { MissingDeviceLiveness } from "../missingDeviceLiveness";
import { DeviceRuntimeIdentity } from "../deviceRuntimeIdentity";
import { DeviceShutdownReservations } from "../deviceShutdownReservations";
import { DeviceDisconnectHandler } from "../deviceDisconnectHandler";
import { AndroidRebootCoordinator } from "../androidRebootCoordinator";
import { AndroidRecoveryRecordLedger } from "../androidRecoveryRecordLedger";
import { type VirtualDeviceLifecycleCoordinator } from "../../devices/virtualDeviceLifecycleCoordinator";
import { OwnerDisconnectRelease } from "../ownerDisconnectRelease";
import type { PooledDevice } from "../devicePoolTypes";
import {
  McpSessionRecoveryLease,
  DeviceDisconnectSessionReleaser,
  DeviceReadyListener,
  DeviceRemovedListener,
  DeviceStateChangedListener,
  DeviceSessionExecutionCanceller,
  AdbServerResetRecoveryReservation,
  AndroidStartupLeaseRequest,
  DevicePoolDependencies,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";

/** Shared mutable state. Collaborators receive Pick views of only the fields they use. */
export class DevicePoolState {
  /** Device-entry table; the field keeps its pre-extraction name (test internals read it). */
  devices = new InMemoryDeviceTable();
  deviceSessionStarts: Map<string, number> = new Map();
  sessionManager!: SessionManager;
  assignmentMutex = new Mutex();
  multiDeviceAllocations!: ReturnType<DevicePoolOperations["createMultiDeviceAllocationQueue"]>;
  foreignClaims!: ReturnType<DevicePoolOperations["createForeignClaims"]>;
  connectionOwnership!: ReturnType<DevicePoolOperations["createConnectionOwnership"]>;
  deviceAutoStart!: ReturnType<DevicePoolOperations["createDeviceAutoStart"]>;
  deviceReservations!: ReturnType<DevicePoolOperations["createDeviceReservations"]>;
  deviceReplacement!: ReturnType<DevicePoolOperations["createDeviceReplacement"]>;
  explicitDeviceBind!: ReturnType<DevicePoolOperations["createExplicitDeviceBind"]>;
  deviceAllocation!: ReturnType<DevicePoolOperations["createDeviceAllocation"]>;
  timer!: Timer;
  idGenerator!: IdGenerator;
  lastUsedAtMarker = 0;
  lastReleasedDeviceId: string | null = null;
  /**
   * Every daemon-MCP connection that acquired a result-minted device session.
   *
   * This is deliberately separate from the autolock routing maps below:
   * ordinary acquisitions do not opt into implicit autolock routing, but they
   * still own their exact device session and must not let another connection
   * adopt it through an idempotent getAndroid/getApple/startDevice call.
   */
  mcpSessionAcquiredDeviceSessions = new Map<string, Set<string>>();
  mcpSessionLivenessOwnerTokens = new Map<string, string>();
  /** Releases a session after its owning connection closes and no owner remains (#10503). */
  ownerDisconnectRelease!: OwnerDisconnectRelease;
  mcpSessionRecoveryDevices: Map<string, McpSessionRecoveryLease> = new Map();
  /**
   * MCP connections with a bind in flight, and whether each closed while it was (#11146). A bind
   * records its caller as the session's owner after awaiting session creation; a connection that
   * closed meanwhile already had its bindings released, so recording it then would leave a dead
   * owner that suppresses the owner-disconnect release forever.
   */
  mcpBindsInFlight = new Map<
    string,
    {
      pending: number;
      closed: boolean;
      toolCalls: number;
    }
  >();
  // #11999: only socket tool-call claims can have an answer still awaiting delivery.
  mcpSessionUndeliveredMints = new Map<string, Set<string>>();
  refreshMissingDeviceMisses!: Map<string, number>;
  androidTransportAliases!: AndroidTransportAliases;
  androidAliasObservation = 0;
  androidAliasAppliedObservation = 0;
  androidAliasRetirement = 0;
  androidAliasAppliedDevices: BootedDevice[] = [];
  daemonSessionId!: string;
  installedAppsRepository!: InstalledAppsStore;
  deviceManager!: PlatformDeviceManager;
  retryExecutor!: RetryExecutor;
  deviceSessionRepository!: Pick<DeviceSessionRepository, "markAutolockSession">;
  criteriaMatcher!: DeviceCriteriaMatcher;
  releaseSessionForDisconnectedDevice!: DeviceDisconnectSessionReleaser;
  onDeviceReady!: DeviceReadyListener | undefined;
  onDeviceProcessStarted!: ((deviceId: string) => void | Promise<void>) | undefined;
  onDeviceIncarnationAssigned!: DevicePoolDependencies["onDeviceIncarnationAssigned"];
  onDeviceRemoved!: DeviceRemovedListener | undefined;
  onDeviceStateChanged!: DeviceStateChangedListener | undefined;
  onDeviceFramesInvalidated!: ((deviceId: string) => void) | undefined;
  cancelDeviceSessionExecutions!: DeviceSessionExecutionCanceller;
  ambientExecutionIdReader!: AmbientExecutionIdReader | undefined;
  androidDeviceReboot!: AndroidDeviceReboot;
  recoveryPolicy!: DeviceRecoveryPolicy;
  deviceSessionContinuityEnabled!: boolean;
  recoveryCoordinator!: DeviceRecoveryCoordinator;
  sessionPreservingRecovery!: SessionPreservingRecoveryRunner;
  adbResetSessionRecovery!: AdbResetSessionRecovery;
  adbServerResetQuarantine!: AdbServerResetQuarantine;
  afterAndroidStartupRecoverySnapshot?: () => void;
  /**
   * A reset cohort is reserved before its first member is restarted. This keeps
   * a concurrent named getAndroid call from booting a later cohort member while
   * its detached AVD/session relationship is still being restored.
   */
  adbServerResetRecoveryReservations: Map<string, AdbServerResetRecoveryReservation> = new Map();
  /** Child-process handles retained after reset cohort pool entries are detached. */
  adbServerResetTrackedProcesses: WeakMap<PooledDevice, ChildProcess> = new WeakMap();
  /**
   * A named Android start holds this lease from reset-reservation preflight
   * through session binding so a reset cohort cannot detach that AVD mid-start.
   */
  androidStartupLeases: Map<symbol, AndroidStartupLeaseRequest> = new Map();
  /** Sessions whose old serial may be reused before their reset cohort settles. */
  adbServerResetQuarantinedSessions: Set<string> = new Set();
  emulatorProcessLifecycle!: EmulatorProcessLifecycle;
  missingDeviceLiveness!: MissingDeviceLiveness;
  refreshCoordinator!: DevicePoolRefresh;
  allocationRefresh = new SingleFlight<"allocation", DevicePoolRefreshResult>();
  recoveryRetryRefresh!: TTLCache<"allocation", DevicePoolRefreshResult>;
  runtimeIdentity!: DeviceRuntimeIdentity;
  shutdownReservationCoordinator!: DeviceShutdownReservations;
  startedDeviceProcesses: Map<string, ChildProcess> = new Map();
  startedDeviceProcessOutput: Map<string, EmulatorProcessOutputTail> = new Map();
  emulatorLossLedger!: EmulatorLossIncidentLedger;
  androidRecoveryRecordLedger!: AndroidRecoveryRecordLedger;
  idleDeviceReaper!: IdleDeviceReaper;
  autolockManager!: DeviceAutolockManager;
  disconnectHandler!: DeviceDisconnectHandler;
  androidRebootCoordinator!: AndroidRebootCoordinator;
  /** A late kill settled; only a later fresh observation can lift its fence. */
  settledLateShutdowns = new Map<
    string,
    {
      incarnation: number;
      refreshGeneration: number;
    }
  >();
  /** Exact session incarnation last assigned to each pooled-device incarnation. */
  pooledSessionIdentities: WeakMap<PooledDevice, Session> = new WeakMap();
  /**
   * Serials the user intentionally stopped, mapped to the pooled-device
   * incarnation that was present at mark time (or {@link INCARNATION_ANY} when
   * only a recovery was in flight). Consuming this on a disconnect is gated on
   * incarnation so a stale disconnect for a prior incarnation cannot remove a
   * same-serial replacement, nor can a later crash of a replacement consume a
   * marker that belonged to a device that is already gone.
   */
  intentionalShutdowns: Map<string, number> = new Map();
  /** Releases waiting for late session teardown, bound to one pooled incarnation. */
  deferredDeviceReleases: Map<
    string,
    {
      device: PooledDevice;
      sessionId: string;
      assignmentCount: number;
      cleanup: Promise<void>;
    }
  > = new Map();
  /**
   * Explicit session-release callbacks run before terminal persistence awaits.
   * Capture ownership there so the later caller-ordered pool release cannot
   * snapshot and free a same-UUID replacement assignment.
   */
  releasedDeviceCaptures: Map<
    string,
    {
      device: PooledDevice;
      deviceId: string;
      assignmentCount: number;
    }
  > = new Map();
  // Max consecutive errors before marking device as failed
  MAX_DEVICE_ERRORS = 5;
  // Device wait configuration for parallel test execution
  DEVICE_WAIT_TIMEOUT_MS = 60000; // 60 seconds max wait

  DEVICE_WAIT_INTERVAL_MS = 1000; // Check every 1 second

  RECOVERY_RESPONSE_MARGIN_MS = 1000;
  // Match the daemon's 5s disconnect-monitor cadence: client retries must not
  // turn the three-miss eviction threshold into a tight-loop reboot trigger.
  RECOVERY_RETRY_REFRESH_INTERVAL_MS = 5000;
  lifecycleCoordinator!: VirtualDeviceLifecycleCoordinator;
  consoleBusyRegistry!: EmulatorConsoleBusyRegistry;
  deviceHealthMarkers!: DeviceHealthMarkers;
  foreignDeviceOwnership!: ForeignDeviceOwnership | undefined;
  iosForeignDeviceOwnership!: ForeignDeviceOwnership | undefined;
  watchForeignDeviceOwnership!: ForeignDeviceOwnership | undefined;
  managedExecutionOwnership!: DevicePoolDependencies["managedExecutionOwnership"];
  bindingExclusion!: BindingExclusion | undefined;
  /** Devices held for the persisted rows restart recovery is working through (#11294). */
  rehydrationReservations = new Map<string, DeviceRehydrationReservation>();
  intentionallyCancelledRecoverySessions = new WeakSet<Session>();
  mcpSessionOwnerCallsInFlight = new Map<string, Map<string, number>>();
  ownerConnectionIntervals = new OwnerConnectionIntervals();
  /** Last forced re-read per device and session, so a hammering caller costs one read per window. */
  managedRereadAtMs = new Map<string, number>();
}
