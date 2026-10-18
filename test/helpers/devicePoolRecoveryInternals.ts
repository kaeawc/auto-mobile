import type { Mutex } from "async-mutex";
import type {
  AndroidRecoveryRecord,
  AndroidRecoveryRecordLedger,
  AndroidRecoveryReservationKind,
} from "../../src/daemon/androidRecoveryRecordLedger";
import type {
  AdbServerResetRecoveryReservation,
  DiscoveryReconcileOptions,
  DevicePool,
  DevicePoolDependencies,
  PooledDevice,
  SessionPreservingRecoveryResult,
} from "../../src/daemon/devicePool";
import type {
  DeviceRecoveryCoordinator,
  SessionPreservingRecovery,
} from "../../src/daemon/deviceRecoveryCoordinator";
import type { BootedDevice, DeviceInfo, Platform } from "../../src/models";
import type { HostChildProcess } from "../../src/utils/HostCommandExecutor";
import type { IosLivenessSnapshot } from "../../src/daemon/idleDeviceReaper";
import type { Session } from "../../src/daemon/sessionManager";
import type { EmulatorLossIncidentLedger } from "../../src/daemon/emulatorLossIncidentLedger";

/**
 * Typed read access to the recovery state a DevicePool keeps in its private collaborators, for
 * suites that assert on or seed it. The state lives on the recovery coordinator and the two
 * ledgers, not on the pool, so this reaches those directly instead of through pool-level
 * pass-through getters (#11804). `Reflect.get` returns `any`, so no type assertion is needed.
 */
export interface DevicePoolRecoveryInternals {
  readonly recoveryCoordinator: DeviceRecoveryCoordinator;
  readonly androidRecoveryRecordLedger: AndroidRecoveryRecordLedger;
  readonly emulatorLossLedger: EmulatorLossIncidentLedger;
  readonly recoveringAndroidImages: DeviceRecoveryCoordinator["recoveringAndroidImages"];
  readonly recoveringAndroidDeviceIds: DeviceRecoveryCoordinator["recoveringAndroidDeviceIds"];
  readonly androidRecoveryHandoffOwners: DeviceRecoveryCoordinator["androidRecoveryHandoffOwners"];
  readonly sessionPreservingRecoveries: DeviceRecoveryCoordinator["sessionPreservingRecoveries"];
  readonly recoveringSessionLosses: AndroidRecoveryRecordLedger["recoveringSessionLosses"];
  readonly failedTerminalRecoveryReleases: AndroidRecoveryRecordLedger["failedTerminalRecoveryReleases"];
  readonly emulatorLossIncidentStore: EmulatorLossIncidentLedger["emulatorLossIncidentStore"];
  readonly emulatorLossRecoverySettlements: EmulatorLossIncidentLedger["emulatorLossRecoverySettlements"];
  readonly emulatorLossRecoveryResolvers: EmulatorLossIncidentLedger["emulatorLossRecoveryResolvers"];
}

export function recoveryInternals(pool: DevicePool): DevicePoolRecoveryInternals {
  const recoveryCoordinator: DeviceRecoveryCoordinator = Reflect.get(pool, "recoveryCoordinator");
  const androidRecoveryRecordLedger: AndroidRecoveryRecordLedger = Reflect.get(
    pool,
    "androidRecoveryRecordLedger",
  );
  const emulatorLossLedger: EmulatorLossIncidentLedger = Reflect.get(pool, "emulatorLossLedger");
  return {
    recoveryCoordinator,
    androidRecoveryRecordLedger,
    emulatorLossLedger,
    recoveringAndroidImages: recoveryCoordinator.recoveringAndroidImages,
    recoveringAndroidDeviceIds: recoveryCoordinator.recoveringAndroidDeviceIds,
    androidRecoveryHandoffOwners: recoveryCoordinator.androidRecoveryHandoffOwners,
    sessionPreservingRecoveries: recoveryCoordinator.sessionPreservingRecoveries,
    recoveringSessionLosses: androidRecoveryRecordLedger.recoveringSessionLosses,
    failedTerminalRecoveryReleases: androidRecoveryRecordLedger.failedTerminalRecoveryReleases,
    emulatorLossIncidentStore: emulatorLossLedger.emulatorLossIncidentStore,
    emulatorLossRecoverySettlements: emulatorLossLedger.emulatorLossRecoverySettlements,
    emulatorLossRecoveryResolvers: emulatorLossLedger.emulatorLossRecoveryResolvers,
  };
}

/**
 * Private DevicePool members suites reach into. `poolInternals` returns the pool itself, so the
 * members are real: `spyOn` intercepts them and assigning one replaces it. The view comes from
 * `Reflect.get` (which returns `any`), so no type assertion is needed or counted.
 */
export interface DevicePoolInternals {
  startedDeviceProcesses: Map<string, HostChildProcess>;
  startedDeviceProcessOutput: Map<string, unknown>;
  releasedDeviceCaptures: Map<string, { deviceId: string }>;
  trackStartedDeviceProcess(
    device: BootedDevice,
    child: HostChildProcess | null | undefined,
  ): Promise<void>;
  evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    options?: {
      attemptDeviceLossRecovery?: boolean;
      incidentId?: string;
      identityObservation?: Pick<BootedDevice, "name" | "observedAt">;
    },
  ): Promise<void>;
  assignmentMutex: Pick<Mutex, "runExclusive">;
  tryAssignDevice(
    sessionId: string,
    platform: Platform,
  ): Promise<{ success: boolean; deviceId?: string }>;
  getStartableDeviceImageCandidates(platform: Platform): Promise<DeviceInfo[]>;
  foldObservationIntoPooledEntry(
    entry: PooledDevice,
    observation: BootedDevice,
    source: "refresh",
  ): Promise<boolean>;
  idleDeviceReaper: { getIosLivenessSnapshot(): Promise<IosLivenessSnapshot> };
  selectAssignableIdleDevice(
    candidates: PooledDevice[],
    snapshots: { capturedEntries: ReadonlySet<PooledDevice>; iosLiveness: IosLivenessSnapshot },
  ): Promise<unknown>;
  pruneStaleIdleIosDevices(candidates: PooledDevice[]): Promise<number>;
  startAdditionalDevices(count: number, deadline: number, platform: Platform): Promise<number>;
  startAdditionalDeviceMatchingCriteria(
    criteria: { platform: Platform },
    excluded: Set<string>,
    deadline: number,
    rediscover: () => Promise<PooledDevice | undefined>,
  ): Promise<{ device: PooledDevice; started: boolean } | null>;
  missingDeviceLiveness: {
    resolveMissingDeviceIncident(
      pooledDevice: PooledDevice,
      recoverAndroidEmulator: boolean,
      incidentId: string | undefined,
      incidentCaptureComplete: boolean,
    ): Promise<string | undefined>;
    reconcileDiscoveredPooledDevice(
      pooledDevice: PooledDevice,
      bootedDevice: BootedDevice,
      assignmentLockHeld: boolean,
    ): Promise<boolean>;
  };
  runtimeIdentity: {
    getPendingUnresolvedEvidence(deviceId: string): { observedAt?: number } | undefined;
    reconcileObservedPooledIdentity(
      pooled: PooledDevice,
      device: Pick<
        BootedDevice,
        "deviceId" | "name" | "platform" | "observedAt" | "consoleBusyDuringProbe"
      >,
      options?: DiscoveryReconcileOptions,
    ): Promise<void>;
  };
  readonly timer: NonNullable<DevicePoolDependencies["timer"]>;
  readonly installedAppsRepository: NonNullable<DevicePoolDependencies["installedAppsRepository"]>;
  readonly deviceManager: NonNullable<DevicePoolDependencies["deviceManager"]>;
  readonly retryExecutor: NonNullable<DevicePoolDependencies["retryExecutor"]>;
  readonly criteriaMatcher: NonNullable<DevicePoolDependencies["criteriaMatcher"]>;
  readonly onDeviceReady: DevicePoolDependencies["onDeviceReady"];
  addDevice(device: BootedDevice): Promise<void>;
  setDeviceSessionTracking(deviceId: string, sessionStart: number): Promise<void>;
  releaseSessionForDisconnectedDevice(
    sessionId: string,
    deviceId: string,
    releaseReason: string,
  ): Promise<void>;
  retrySessionRelease(
    sessionId: string,
    deviceId: string,
    attempt: () => Promise<void>,
  ): Promise<void>;
  getSessionPreservingRecoveryTarget(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ): { device: PooledDevice; session: Session } | undefined;
  adbServerResetQuarantinedSessions: Set<string>;
  adbServerResetRecoveryReservations: Map<string, AdbServerResetRecoveryReservation>;
  recoveryCoordinator: DeviceRecoveryCoordinator;
  afterAndroidStartupRecoverySnapshot?: () => void;
  startAndroidRecoveryRecord(
    sessionId: string,
    details: Omit<
      Partial<AndroidRecoveryRecord>,
      "sessionId" | "generation" | "state" | "reservations"
    >,
    reservations: readonly AndroidRecoveryReservationKind[],
    replace?: boolean,
  ): AndroidRecoveryRecord;
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): Promise<void>;
  joinSessionPreservingRecovery(
    recovery: SessionPreservingRecovery,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult>;
  replacePooledDeviceForRuntimeIdentity(
    pooled: PooledDevice,
    booted: BootedDevice,
  ): Promise<boolean>;
  clearDeviceSessionCache(deviceId: string): Promise<void>;
  captureReleasedDevice(sessionId: string, deviceId: string): void;
  runCoordinatedDeviceStart(device: DeviceInfo, deadlineMs: number, op: "start"): Promise<unknown>;
}

export function poolInternals(pool: DevicePool): DevicePoolInternals {
  return Reflect.get({ pool }, "pool");
}
