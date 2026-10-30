import { DevicePoolError } from "../DevicePoolError";
import type { SessionReleaseReason } from "../releaseReasons";
import type { Environment } from "../poolConfig";
import { AndroidTransportAliases } from "../../utils/androidSerial";
import {
  androidTransportIdentityAdbFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { type ForeignDeviceOwnership } from "../foreignDeviceOwnership";
import type { DeviceClaimMirror } from "../deviceClaims";
import { InMemoryDeviceHealthMarkers, type DeviceHealthMarkers } from "../deviceHealthMarkers";
import { type BackoffPolicy } from "../../utils/Backoff";
import type { AmbientExecutionIdReader } from "../../utils/interfaces/AmbientExecutionIdReader";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import { truncateBodyText } from "../../utils/truncateBodyText";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  SessionManager,
  type Session,
  type SessionReleaseOptions,
} from "../sessionManager";
import { ActionableError, BootedDevice, DeviceInfo, Platform } from "../../models";
import { PlatformDeviceManager, type BootedDeviceDiscovery } from "../../devices/deviceUtils";
import { Timer } from "../../utils/SystemTimer";
import { type IdGenerator } from "../../utils/IdGenerator";
import type { InstalledAppsStore } from "../../db/installedAppsRepository";
import { type RetryExecutor } from "../../utils/retry/RetryExecutor";
import { DevicePoolRefresh, type DevicePoolRefreshPort } from "../devicePoolRefresh";
import { type DeviceRecoveryPolicy } from "../poolConfig";
import { DeviceSessionRepository } from "../../db/deviceSessionRepository";
import { AndroidDeviceReboot } from "../../devices/androidDeviceReboot";
import { DeviceCriteriaMatcher } from "../DeviceCriteriaMatcher";
import { type IdentityEvidence } from "../../devices/deviceIdentityEvidence";
import {
  defaultEmulatorConsoleBusyRegistry,
  type EmulatorConsoleBusyRegistry,
} from "../../utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import { type EmulatorLossIncidentStore } from "../emulatorLossIncident";
import { type IosLivenessSnapshot } from "../idleDeviceReaper";
import { type BindingExclusion } from "../sessionBroker/provisioning/exclusion";
import {
  AdbServerResetQuarantine,
  type AdbServerResetQuarantinePoolPort,
} from "../adbServerResetQuarantine";
import {
  EmulatorProcessLifecycle,
  type EmulatorProcessLifecyclePoolPort,
} from "../emulatorProcessLifecycle";
import {
  MissingDeviceLiveness,
  type MissingDeviceLivenessPoolPort,
} from "../missingDeviceLiveness";
import {
  DeviceRuntimeIdentity,
  type DeviceRuntimeIdentityPoolPort,
} from "../deviceRuntimeIdentity";
import {
  DeviceShutdownReservations,
  type DeviceShutdownReservationsPoolPort,
} from "../deviceShutdownReservations";
import {
  getVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
} from "../../devices/virtualDeviceLifecycleCoordinator";
import { type OwnerDisconnectReleaseDeferral } from "../ownerDisconnectRelease";
import type { PooledDevice } from "../devicePoolTypes";

export type DeviceAutolockChildProcess = ChildProcess;

export interface McpSessionRecoveryLease {
  readonly device: PooledDevice;
  readonly token: symbol;
}

export function resolveDeviceHealthMarkers(
  markers: DeviceHealthMarkers | undefined,
  timer: Timer,
): DeviceHealthMarkers {
  return markers ?? new InMemoryDeviceHealthMarkers(timer);
}

export function resolveLifecycleCoordinator(
  coordinator: VirtualDeviceLifecycleCoordinator | undefined,
): VirtualDeviceLifecycleCoordinator {
  return coordinator ?? getVirtualDeviceLifecycleCoordinator();
}

export function resolveConsoleBusyRegistry(
  registry: EmulatorConsoleBusyRegistry | undefined,
): EmulatorConsoleBusyRegistry {
  return registry ?? defaultEmulatorConsoleBusyRegistry;
}

/** A stop's daemon-confirmed stable identity; labels supplied by the caller are only hints. */
export type RestartStopIdentity =
  | {
      confirmed: string;
    }
  | {
      unconfirmed: true;
    };

export interface RestartStopTargetIdentity {
  platform?: Platform;
  stableIds?: readonly string[];
  stopIdentity?: RestartStopIdentity;
}

/** A lifecycle stop that must not take a device another live daemon holds (#11200). */
export interface ShutdownForeignClaim {
  toolName: string;
  force: boolean;
  /** What the refused caller can do instead. */
  remedy?: string;
}

export function refreshFailureContext(failure: string | Error | undefined): string {
  const reason =
    failure instanceof DevicePoolError
      ? failure.refreshFailure
      : typeof failure === "string"
        ? failure
        : undefined;
  return reason === undefined
    ? ""
    : `Could not refresh device list: ${truncateBodyText(reason.split(/[\r\n\u2028\u2029]/, 1)[0], 256)}.\n`;
}

export function neutralIdentityEvidence(
  device: Pick<BootedDevice, "observedAt">,
): IdentityEvidence {
  return {
    unresolved: false,
    ...(device.observedAt === undefined ? {} : { observedAt: device.observedAt }),
  };
}

export function identityEvidenceFields(
  evidence: IdentityEvidence,
): Pick<PooledDevice, "identityObservedAt" | "identityUnresolved"> {
  return {
    ...(evidence.observedAt === undefined ? {} : { identityObservedAt: evidence.observedAt }),
    ...(evidence.unresolved ? { identityUnresolved: true } : {}),
  };
}

export interface RollbackAssignment {
  deviceId: string;
  session: Session;
}

export type SessionAssignmentSnapshot = Pick<
  PooledDevice,
  | "sessionId"
  | "status"
  | "health"
  | "lastUsedAt"
  | "assignmentCount"
  | "errorCount"
  | "autolockSessionId"
>;

export interface ShutdownIdentityReservation {
  device: PooledDevice | undefined;
  assignmentCount: number | undefined;
  session: Session | undefined;
  releaseSession: (() => void) | undefined;
}

export const ALLOCATION_SNAPSHOT_STALE_RETRIES = 3;

/**
 * Re-listings an exact-device iOS bind makes when the `simctl list` that proves the target
 * is still booted fails (a 15 s timeout during a boot burst above ~24 simulators, #15289).
 * Each wait is a cancellable backoff delay and each re-listing runs under the caller's own
 * deadline and signal, so the retries can never outlive the request.
 */
export const IOS_LIVENESS_REDISCOVERY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/** Wait hint on the typed retryable error once the re-listings are exhausted. */
export const IOS_LIVENESS_UNVERIFIED_RETRY_AFTER_MS = 5_000;

/** Bound on the adb state read that decides a recovery reservation's lift (#10074). */
export const ANDROID_OFFLINE_PROBE_TIMEOUT_MS = 10000;

/**
 * How long a session create waits, inside the assignment mutex, for a release admitted while
 * it was being created (#10836). It covers the release's capped teardown plus its bounded
 * terminal write and reason upgrade, with margin; past it the create is refused rather than
 * holding every other assignment behind a release that never settles.
 */
export const CREATE_SESSION_RELEASE_WAIT_MS =
  SESSION_RELEASE_TEARDOWN_CAP_MS + 2 * SESSION_RELEASE_PERSIST_TIMEOUT_MS + 10000;

/** Evidence belongs only to the entry captured before this target's discovery. */
export interface TargetDeviceDiscoverySnapshot {
  capturedEntry: PooledDevice | undefined;
  /** addDevice already published readiness for this entry during an earlier pass. */
  readyNotifiedEntry?: PooledDevice;
  bootedDevices?: BootedDevice[];
  iosLiveness?: IosLivenessSnapshot;
  androidPresence?: BootedDeviceDiscovery;
}

export interface TargetDeviceDiscoveryOptions {
  deviceId: string;
  sessionId?: string;
  readinessReservationOwners?: ReadonlySet<symbol>;
  sourceImage?: DeviceInfo;
  isLaunchProcessAlive?: () => boolean;
  expectedIdentity?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">;
  unavailableMessage: string;
  platform: Platform;
  operation: (snapshot: TargetDeviceDiscoverySnapshot) => Promise<string | undefined>;
}

export interface TargetDeviceValidationOptions {
  device: PooledDevice;
  expectedIdentity?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">;
  unavailableMessage: string;
  readinessReservationOwners?: ReadonlySet<symbol>;
  snapshot: TargetDeviceDiscoverySnapshot;
}

export interface DeviceDisconnectSessionReleaser {
  (
    sessionId: string,
    deviceId: string,
    releaseReason: SessionReleaseReason,
    shouldCommit?: () => boolean,
    options?: SessionReleaseOptions,
  ): Promise<boolean | void>;
}

export interface DeviceReadyListener {
  (deviceId: string): void;
}

export interface DeviceRemovedListener {
  (deviceId: string, platform: Platform): void;
}

/** Fired after a pooled device's status or holding session changed and the change committed. */
export interface DeviceStateChangedListener {
  (deviceId: string, platform: Platform): void;
}

export interface DeviceSessionExecutionCanceller {
  /** Same injected cancellation/drain seam, for work with no bound session. */
  cancelDeviceExecutions?(
    deviceId: string,
    reason: string | Error,
    options?: {
      excludeExecutionId?: string;
      onlySessionUuid?: string;
    },
  ): Promise<number>;
  (
    sessionId: string,
    reason: string,
    options?: {
      excludeExecutionId?: string;
    },
  ): Promise<number>;
}

/**
 * What a FUNNEL 1 caller can tell the pool about the observation it is folding
 * in. It carries the discovering execution plus whether discovery resolved
 * Android emulator names.
 *
 * Entering the quarantine cancels every execution indexed under the bound
 * session, and a session-bound destructive call -- `killDevice`, `deleteDevice`
 * -- can be the very path whose own discovery reads the placeholder. Cancelling
 * it would lose the `runWithinShutdownDeadline` signal race for the operation
 * that is ABOUT to confirm-or-refuse on exactly the evidence it just produced,
 * so the discovering execution is exempted while every other execution on the
 * session is still stopped
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 */
export interface DiscoveryReconcileOptions {
  /**
   * Only the disconnect-monitor tick sets this. After the membership-free FUNNEL 1
   * pass, the pool settles membership (under the assignment mutex) for each Android
   * observation whose RESOLVED name disagrees with the pooled entry on that serial.
   * The caller must NOT hold the assignment mutex.
   */
  readonly settleMembership?: boolean;
  /** The execution that performed this discovery; exempt from quarantine cancellation. */
  readonly excludeExecutionId?: string;
  /**
   * Whether discovery resolved Android emulator names. `false` short-circuits
   * identity resolution entirely: a serial-only listing carries no identity
   * evidence for any entry, so interpreting its synthetic placeholders per
   * device would quarantine healthy pooled peers that were never probed.
   */
  readonly namesResolved?: boolean;
  /**
   * A signal that is aborted once the caller's deadline/abort has already won
   * a race this observation is racing against. Checked between devices so a
   * stale, still-draining reconcile stops touching pooled identities the
   * instant the caller it was deferred from has already settled — an unrelated
   * acquisition may otherwise bind one of the remaining devices while this
   * loop is still walking toward it (#6955 review).
   */
  readonly signal?: AbortSignal;
}

export type DeviceReadinessReservation = (() => Promise<void>) & {
  readonly owner: symbol;
};

export interface AdbServerResetRecoveryReservation {
  deviceId: string;
  image: DeviceInfo;
  cancelled: boolean;
  settled: Promise<void>;
  resolve(): void;
  sessionId?: string;
  recoveryGeneration?: number;
}

export interface AdbServerResetCohortDetachment {
  devices: readonly PooledDevice[];
  deferred: boolean;
}

export interface AndroidStartupLeaseRequest {
  name?: string;
  exactName: boolean;
  ownsOfflineRecovery: boolean;
}

export interface SystemUiAnrRecoveryHandoff {
  readonly preservedSessionId?: string;
  readonly replacementDevice: PooledDevice;
  validatePreservedSession(): Promise<void>;
}

export type AndroidEmulatorRecoveryDevice = PooledDevice & {
  avdName: string;
  androidImage: DeviceInfo;
};

/**
 * Passive continuity (preserve the session, reattach when the AVD returns) only
 * needs the emulator's runtime identity resolved. It does not need the
 * configured image that active relaunch requires to know what to boot back;
 * see `isAndroidEmulatorActiveRelaunchEligible` for that stricter contract (#7546).
 */
export type AndroidEmulatorContinuityDevice = PooledDevice & {
  platform: "android";
};

export type IOSSimulatorRecoveryDevice = PooledDevice & {
  platform: "ios";
  id: string;
};

export type SessionContinuityDevice = AndroidEmulatorContinuityDevice | IOSSimulatorRecoveryDevice;

/**
 * Device Pool
 *
 * Manages a pool of Android devices for parallel test execution:
 * - Tracks which devices are available vs assigned to sessions
 * - Ensures each session gets a unique device
 * - Enables multiple tests to run in parallel
 *
 * Works with SessionManager to maintain bidirectional mappings.
 */
export interface OwnerDisconnectOptions {
  /**
   * Defaults to an ownership-fenced session release that returns the device to the pool. Resolve
   * with a deferral to keep the session while in-flight work vetoes the release.
   */
  release?: (
    session: Session,
    reason: SessionReleaseReason,
  ) => Promise<OwnerDisconnectReleaseDeferral | void>;
  /** Grace before the session is released. Defaults to {@link OWNER_DISCONNECT_GRACE_MS}. */
  graceMs?: number;
}

export interface ManagedExecutionOwnership {
  automationRefusal(sessionId: string): ActionableError | undefined;
  ownershipState?(sessionId: string): "unconfirmed" | "lost" | undefined;
}

export interface DevicePoolDependencies {
  /** Lazy because the re-owner is installed after the pool. */
  managedExecutionOwnership?: () => ManagedExecutionOwnership | undefined;
  androidAdbFactory?: AdbClientFactory;
  /**
   * Who else drives a device. Multi-device allocation skips devices another live daemon owns.
   * `DevicePool.create` reads CtrlProxy forwarding leases; a directly built pool sees none.
   */
  foreignDeviceOwnership?: ForeignDeviceOwnership;
  /** The same for iOS simulators, claimed by UDID (#10980). */
  iosForeignDeviceOwnership?: ForeignDeviceOwnership;
  /** The same for Apple Watch simulators, claimed by UDID (#14908). */
  watchForeignDeviceOwnership?: ForeignDeviceOwnership;
  /** Mirrors the claims `DevicePool.create` builds into the host-wide claims table (#11811 b). */
  deviceClaimMirrors?: { android?: DeviceClaimMirror; ios?: DeviceClaimMirror };
  /**
   * Devices broker bindings hold (#11174, #11178). Generic allocation, auto-start and explicit binds
   * never lend one, even while it is idle. A directly built pool has none.
   */
  bindingExclusion?: BindingExclusion;
  env?: Environment;
  deviceHealthMarkers?: DeviceHealthMarkers;
  deviceHealthRecoveryBackoff?: BackoffPolicy;
  sessionManager: SessionManager;
  daemonSessionId: string;
  timer?: Timer;
  installedAppsRepository?: InstalledAppsStore;
  deviceManager?: PlatformDeviceManager;
  retryExecutor?: RetryExecutor;
  deviceSessionRepository?: Pick<DeviceSessionRepository, "markAutolockSession">;
  criteriaMatcher?: DeviceCriteriaMatcher;
  releaseSessionForDisconnectedDevice?: DeviceDisconnectSessionReleaser;
  /** Release of a session whose owning client connection closed with no other owner (#10503). */
  ownerDisconnect?: OwnerDisconnectOptions;
  onDeviceReady?: DeviceReadyListener;
  androidDeviceReboot?: AndroidDeviceReboot;
  recoveryPolicy?: DeviceRecoveryPolicy;
  onDeviceRemoved?: DeviceRemovedListener;
  onDeviceIncarnationAssigned?: (deviceId: string, incarnation: number) => void;
  onDeviceStateChanged?: DeviceStateChangedListener;
  onDeviceFramesInvalidated?: (deviceId: string) => void;
  emulatorLossIncidentStore?: EmulatorLossIncidentStore;
  cancelDeviceSessionExecutions?: DeviceSessionExecutionCanceller;
  ambientExecutionIdReader?: AmbientExecutionIdReader;
  idGenerator?: IdGenerator;
  lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator;
  consoleBusyRegistry?: EmulatorConsoleBusyRegistry;
  /** Shared with the daemon monitor so refresh and monitor count one streak. */
  missingDeviceMisses?: Map<string, number>;
  adbServerResetQuarantineFactory?: (
    pool: AdbServerResetQuarantinePoolPort,
  ) => AdbServerResetQuarantine;
  missingDeviceLivenessFactory?: (pool: MissingDeviceLivenessPoolPort) => MissingDeviceLiveness;
  devicePoolRefreshFactory?: (pool: DevicePoolRefreshPort) => DevicePoolRefresh;
  runtimeIdentityFactory?: (pool: DeviceRuntimeIdentityPoolPort) => DeviceRuntimeIdentity;
  deviceShutdownReservationsFactory?: (
    pool: DeviceShutdownReservationsPoolPort,
  ) => DeviceShutdownReservations;
  emulatorProcessLifecycleFactory?: (
    pool: EmulatorProcessLifecyclePoolPort,
  ) => EmulatorProcessLifecycle;
  deviceSessionContinuityEnabled?: boolean;
}

export function createAdbServerResetQuarantine(
  port: AdbServerResetQuarantinePoolPort,
  factory?: DevicePoolDependencies["adbServerResetQuarantineFactory"],
): AdbServerResetQuarantine {
  return factory ? factory(port) : new AdbServerResetQuarantine(port);
}

export function createEmulatorProcessLifecycle(
  port: EmulatorProcessLifecyclePoolPort,
  factory?: DevicePoolDependencies["emulatorProcessLifecycleFactory"],
): EmulatorProcessLifecycle {
  return factory ? factory(port) : new EmulatorProcessLifecycle(port);
}

export function createMissingDeviceLiveness(
  port: MissingDeviceLivenessPoolPort,
  factory?: DevicePoolDependencies["missingDeviceLivenessFactory"],
): MissingDeviceLiveness {
  return factory ? factory(port) : new MissingDeviceLiveness(port);
}

export function createAndroidTransportAliases(factory?: AdbClientFactory): AndroidTransportAliases {
  return new AndroidTransportAliases(factory ?? androidTransportIdentityAdbFactory);
}

export function resolveMissingDeviceMisses(shared?: Map<string, number>): Map<string, number> {
  return shared ?? new Map();
}

export function createDevicePoolRefresh(
  port: DevicePoolRefreshPort,
  factory?: DevicePoolDependencies["devicePoolRefreshFactory"],
): DevicePoolRefresh {
  return factory ? factory(port) : new DevicePoolRefresh(port);
}

export function createDeviceRuntimeIdentity(
  port: DeviceRuntimeIdentityPoolPort,
  factory?: DevicePoolDependencies["runtimeIdentityFactory"],
): DeviceRuntimeIdentity {
  return factory ? factory(port) : new DeviceRuntimeIdentity(port);
}

export function createDeviceShutdownReservations(
  port: DeviceShutdownReservationsPoolPort,
  factory?: DevicePoolDependencies["deviceShutdownReservationsFactory"],
): DeviceShutdownReservations {
  return factory ? factory(port) : new DeviceShutdownReservations(port);
}

export interface StopAndroidEmulatorRecoveryOptions {
  device: PooledDevice;
  avdName: string;
  retainLeaseUntil: (settlement: Promise<unknown>) => void;
  allowActiveStop: boolean;
  handoffOwner: symbol;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
  /** The recovery's own cancellation signal, passed explicitly rather than read ambiently (#15671). */
  signal: AbortSignal | undefined;
}

export interface RebindSameAvdReplacementSessionOptions {
  device: PooledDevice;
  avdName: string;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
  preservedAutolockSessionId: string | undefined;
  recoveryImage: DeviceInfo;
  handoffOwner: symbol;
}

export interface BindRecoveredAndroidDeviceSessionOptions {
  previousDeviceId: string;
  avdName: string;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
  ready: BootedDevice;
  recoveryImage: DeviceInfo;
  childProcess: ChildProcess | null;
  preservedAutolockSessionId: string | undefined;
  handoffOwner: symbol | undefined;
}

export interface StopDiscoveredEmulatorOptions {
  disconnectedDevice: PooledDevice;
  avdName: string;
  retainLeaseUntil: (settlement: Promise<unknown>) => void;
  adoptOnly: boolean;
  handoffOwner: symbol;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
  /**
   * The caller's cancellation signal, combined with the shutdown deadline. Explicit (#15671): an
   * abort reaches this shutdown only through this field, never through the ambient abort context.
   */
  signal: AbortSignal | undefined;
}
