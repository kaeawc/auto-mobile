import type { Environment } from "./poolConfig";
import { notifyDeviceIdentityReplaced } from "../utils/deviceIncarnation";
import { AndroidTransportAliases, type AndroidTransportRouting } from "../utils/androidSerial";
import {
  androidTransportIdentityAdbFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { isSessionReleasing } from "./sessionReleaseState";
import { releaseSessionAndDevice } from "./releaseSessionAndDevice";
import {
  InMemoryDeviceHealthMarkers,
  type DeviceHealthMarkers,
  type DeviceHealthMarker,
} from "./deviceHealthMarkers";
import { type BackoffPolicy } from "../utils/Backoff";
import type { AmbientExecutionIdReader } from "../utils/interfaces/AmbientExecutionIdReader";
import type { ChildProcess } from "child_process";
export type DeviceAutolockChildProcess = ChildProcess;
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { truncateBodyText } from "../utils/truncateBodyText";
import { displayTransitions } from "../features/observe/DisplayTransition";
import { getObserveCacheStore } from "../features/observe/cache/ObserveCacheRegistry";
import {
  SessionManager,
  SessionRecoveryIdentityLossError,
  type Session,
  type SessionRecoveryTarget,
} from "./sessionManager";
import { ActionableError, BootedDevice, DeviceInfo, Platform } from "../models";
import { isEmulatorLaunchCancelledError } from "../models/EmulatorLaunchCancelledError";
import {
  SessionRecoveryAssignmentError,
  formatSessionRecoveryIncidentContext,
} from "../models/SessionRecoveryAssignmentError";
import { Mutex } from "async-mutex";
import {
  MultiPlatformDeviceManager,
  PlatformDeviceManager,
  type BootedDeviceDiscovery,
  waitForDeviceReadyOrCancel,
} from "../devices/deviceUtils";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { SingleFlight } from "../utils/cache/SingleFlight";
import { TTLCache } from "../utils/cache/Cache";
import { type IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import type { InstalledAppsStore } from "../db/installedAppsRepository";
import { InstalledAppsRepository } from "../db/installedAppsRepository";
import { type RetryExecutor, DefaultRetryExecutor } from "../utils/retry/RetryExecutor";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import {
  DevicePoolRefresh,
  type DevicePoolRefreshPort,
  type DevicePoolRefreshResult,
} from "./devicePoolRefresh";
import {
  getDeviceRecoveryPolicy,
  getDeviceRecoveryWindowMs,
  type DeviceRecoveryPolicy,
  isDeviceSessionContinuityEnabled,
} from "./poolConfig";
import { DeviceSessionRepository } from "../db/deviceSessionRepository";
import { AndroidDeviceReboot, BoundedAndroidDeviceReboot } from "../devices/androidDeviceReboot";
import {
  DeviceCriteriaMatcher,
  DeviceAllocationCriteria,
  DeviceAllocationRequest,
} from "./DeviceCriteriaMatcher";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import {
  compareIdentityEvidence,
  deriveEvidenceFromPooledDevice,
  isUnresolvedAndroidEmulatorName,
  type IdentityEvidence,
} from "../devices/deviceIdentityEvidence";
import {
  didSourceSucceedForDevice,
  discoverySourceFor,
  type DiscoveryCompleteness,
} from "../utils/discoverySource";
import { consolePortFromSerial } from "../utils/android-cmdline-tools/EmulatorConsoleClient";
import {
  defaultEmulatorConsoleBusyRegistry,
  type EmulatorConsoleBusyRegistry,
} from "../utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { getAbortSignal, runWithAbortSignal, throwIfRequestAborted } from "../utils/AbortContext";
import {
  DeviceLostError,
  deviceLossCancellationReason,
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossDetectionPath,
  type EmulatorLossIncident,
  type EmulatorLossIncidentStore,
  type EmulatorLossRecoverySettlement,
} from "./emulatorLossIncident";
import { EmulatorLossIncidentLedger } from "./emulatorLossIncidentLedger";
import { AdbResetSessionRecovery } from "./adbResetSessionRecovery";
import { IdleDeviceReaper, type IosLivenessSnapshot } from "./idleDeviceReaper";
import {
  DeviceRecoveryCoordinator,
  type SessionPreservingRecovery,
} from "./deviceRecoveryCoordinator";
import {
  SessionPreservingRecoveryRunner,
  MAX_DEFERRED_RECOVERY_SHUTDOWNS,
  UNCONFIRMED_RECOVERY_SHUTDOWN_COOLDOWN_MS,
} from "./sessionPreservingRecovery";
import { DeviceAutolockManager, type AutolockClient } from "./deviceAutolockManager";
import {
  AdbServerResetQuarantine,
  type AdbServerResetQuarantinePoolPort,
} from "./adbServerResetQuarantine";
import {
  EmulatorProcessLifecycle,
  type EmulatorProcessLifecyclePoolPort,
  type EmulatorProcessOutputTail,
} from "./emulatorProcessLifecycle";
import {
  MissingDeviceLiveness,
  type MissingDeviceEvictionOptions,
  type MissingDeviceLivenessPoolPort,
} from "./missingDeviceLiveness";
import {
  DeviceRuntimeIdentity,
  type DeviceRuntimeIdentityPoolPort,
  type DeviceRetirementOptions,
} from "./deviceRuntimeIdentity";
import {
  DeviceShutdownReservations,
  type DeviceShutdownReservationsPoolPort,
  type ShutdownDeviceReservation,
} from "./deviceShutdownReservations";
import {
  DeviceDisconnectHandler,
  INCARNATION_ANY,
  type CurrentDisconnectStatus,
} from "./deviceDisconnectHandler";
export type { CurrentDisconnectStatus } from "./deviceDisconnectHandler";
export { McpSessionRecoveryInProgressError } from "./deviceAutolockManager";
import {
  AndroidRebootCoordinator,
  UnconfirmedRecoveryShutdownError,
  type AndroidEmulatorRecoveryOptions,
  type AndroidRebootCoordinatorPoolPort,
} from "./androidRebootCoordinator";
import {
  AndroidRecoveryRecordLedger,
  type AndroidRecoveryRecord,
  type AndroidRecoveryReservationKind,
} from "./androidRecoveryRecordLedger";
import {
  getVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
} from "../devices/virtualDeviceLifecycleCoordinator";

export type { DeviceAllocationCriteria, DeviceAllocationRequest } from "./DeviceCriteriaMatcher";
export type { DeviceRecoveryPolicy } from "./poolConfig";

interface McpSessionRecoveryLease {
  readonly device: PooledDevice;
  readonly token: symbol;
}

function resolveDeviceHealthMarkers(
  markers: DeviceHealthMarkers | undefined,
  timer: Timer,
): DeviceHealthMarkers {
  return markers ?? new InMemoryDeviceHealthMarkers(timer);
}

function resolveLifecycleCoordinator(
  coordinator: VirtualDeviceLifecycleCoordinator | undefined,
): VirtualDeviceLifecycleCoordinator {
  return coordinator ?? getVirtualDeviceLifecycleCoordinator();
}

function resolveConsoleBusyRegistry(
  registry: EmulatorConsoleBusyRegistry | undefined,
): EmulatorConsoleBusyRegistry {
  return registry ?? defaultEmulatorConsoleBusyRegistry;
}

/**
 * Error class for device pool operations with retryability flag.
 */
export class DevicePoolError extends Error {
  constructor(
    message: string,
    public readonly isRetryable: boolean,
    public readonly refreshFailure?: string,
  ) {
    super(message);
    this.name = "DevicePoolError";
  }
}

function refreshFailureContext(failure: string | Error | undefined): string {
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

/**
 * Why the last round of a multi-device allocation did not complete:
 * `queued` \u2014 an earlier conflicting request was still waiting (no attempt made);
 * `busy` \u2014 too few matching devices were idle to claim (no attempt made);
 * `contention` \u2014 an attempt was made and released its claims to retry.
 */
type MultiDeviceAllocationBlock = "queued" | "busy" | "contention";

interface MultiDeviceAllocationOutcome<T> {
  success: boolean;
  value?: T;
  attempts: number;
  lastBlock?: MultiDeviceAllocationBlock;
}

/** Attempt count for a timeout message, with why no attempt was made when zero (#9950). */
function describeMultiDeviceAllocationAttempts(
  outcome: Pick<MultiDeviceAllocationOutcome<unknown>, "attempts" | "lastBlock">,
): string {
  const count = `${outcome.attempts} attempts`;
  if (outcome.lastBlock === "queued") {
    return `${count}; still queued behind an earlier multi-device request that was waiting for devices`;
  }
  if (outcome.lastBlock === "busy") {
    return `${count}; too few matching devices were idle to attempt allocation`;
  }
  return count;
}

/**
 * Pooled Device Status
 */
export type DeviceStatus = "idle" | "busy" | "error";
type MutableMetadataSource = "refresh" | "snapshot";
export type SessionPreservingRecoveryResult =
  | "not-attempted"
  | "deferred"
  | "recovered"
  | "released";
export interface SessionRecoveryPreparation {
  sessionId: string;
  token: symbol;
}
export type DeviceRecoveryIneligibilityReason =
  | "disabled"
  | "not-automobile-owned"
  | "unsupported-platform"
  | "not-in-pool";

export type DeviceRecoveryEligibility =
  | { eligible: true; action: "restart" }
  | { eligible: false; reason: DeviceRecoveryIneligibilityReason };

/**
 * Pooled Device
 *
 * Represents a device in the pool with assignment info
 */
export interface PooledDevice {
  id: string; // Device ID (e.g., "emulator-5554")
  name: string; // Device name (e.g., "Pixel 7")
  platform: Platform; // Device platform
  sessionId: string | null; // Session currently using it, null if idle
  status: DeviceStatus; // Current status
  lastUsedAt: number; // Last usage timestamp
  assignmentCount: number; // How many times assigned
  errorCount: number; // Consecutive errors
  iosVersion?: string; // iOS version (simulators only)
  simulatorType?: string; // Simulator type display name (simulators only)
  autolockSessionId?: string; // Session ID generated by autolock (when enabled)
  /**
   * Refresh generation at which `name` was last written from a discovery
   * observation, for device classes whose name is mutable metadata. Undefined
   * until a refresh speaks for the name; used to reject an older start-path
   * snapshot that would otherwise revert it (#5690).
   */
  nameRefreshGeneration?: number;
  /**
   * Discovery sequence value that last wrote the mutable display name. When
   * both observations carry a stamp, the newer one wins regardless of its path.
   */
  nameObservedAt?: number;
  /** Authoritative AVD name captured when this pool starts an Android emulator. */
  avdName?: string;
  /** Source image metadata used to evaluate allocation criteria during recovery. */
  androidImage?: DeviceInfo;
  /** Session captured before a process-wide ADB reset detaches this connection. */
  adbServerResetSessionId?: string;
  /** Exact session incarnation captured with adbServerResetSessionId. */
  adbServerResetSession?: Session;
  /** Incident opened before reset cancellation so active calls receive correlation. */
  adbServerResetIncidentId?: string;
  /** Autolock owner captured before a process-wide ADB reset detaches this connection. */
  adbServerResetAutolockSessionId?: string;
  /** Recovery-record generation captured when this reset cohort was detached. */
  adbServerResetRecoveryGeneration?: number;
  /**
   * Monotonic id for this pooled connection incarnation, assigned when the
   * device is first added to the pool. A serial (`id`) can be reused across
   * boots, so this distinguishes "the device we intentionally stopped" from a
   * later same-serial or transport replacement — see `intentionalShutdowns`
   * (issue: DevicePool shutdown-marker same-serial-reuse race, follow-up to PR #5015).
   */
  incarnation: number;
  /**
   * Number of retry attempts consumed by the bounded reconciliation currently
   * checking a temporarily unreadable runtime AVD name. Defined only while the
   * reconciliation is in progress; the last confirmed `avdName` remains the
   * identity evidence and the entry remains actionable during this window.
   */
  identityReconcileAttempts?: number;
  identityReconcileOwner?: symbol;
  /** Injected-timer start time for the active bounded reconciliation. */
  identityReconcileStartedAt?: number;
  /**
   * Terminal quarantine flag: bounded unreadable-name reconciliation was
   * exhausted, or a resolved runtime name disagreed with this LIVE entry, so
   * the pool no longer knows which AVD is on the serial.
   *
   * The placeholder is not evidence of a replacement (it would evict a live
   * emulator on a transient console read) and it is not evidence of continuity
   * either, so the entry is neither evicted nor trusted: session and
   * `incarnation` are preserved, and everything that would ACT on or ROUTE BY the
   * pooled identity is withheld until a resolved name settles it.
   *
   * TWO FUNNELS carry this state, so no consumer decides for itself and review
   * has no per-site gating to find:
   *
   * - **FUNNEL 1 — {@link DevicePool.reconcileDiscoveryObservation}.** The ONE way
   *   an observation ENTERS or LEAVES the quarantine. Every path that discovers
   *   Android devices and then consults pooled identity folds its observation in
   *   there first — the refresh sweep and the assignment-time liveness check from
   *   inside the pool, and the disconnect monitor, the booted-devices resource,
   *   `listDevices`, the shutdown/kill preflight, the teardown precondition,
   *   pre-boot serial validation, the Android start lifecycle target,
   *   `provisionDevice`'s exact-boot discovery and the socket server's
   *   input-target and `ide/*` routes from outside it. Guarded by
   *   `test/lint/deviceDiscoveryReconcileFunnel.test.ts`.
   * - **FUNNEL 2 — {@link DevicePool.assertDeviceActionable}.** The ONE gate every
   *   device-addressed operation at the daemon boundary passes, with or without a
   *   session. Guarded by `test/lint/deviceAddressedAdmissionGate.test.ts`.
   *
   * The transitions, all of them, applied by
   * {@link DevicePool.reconcileObservedPooledIdentity}:
   *
   * - **reconcile, then enter** — the observation is the placeholder for an
   *   entry with a confirmed `avdName`. Three attempts are made through
   *   the injected retry executor. The entry stays actionable while they run;
   *   only exhaustion enters quarantine. Entering also CANCELS AND DRAINS the
   *   device-bound (including sessionless) and bound session's in-flight executions
   *   through the injected `cancelDeviceSessionExecutions` seam
   *   ({@link DevicePool.enterPooledIdentityQuarantine}): FUNNEL 2 only refuses
   *   LATER calls, while an execution already registered keeps issuing
   *   serial-addressed operations. The session and the `incarnation` survive;
   *   only the work in flight is stopped.
   * - **enter** — a resolved name DISAGREES and the replacement it calls for
   *   cannot be installed: either `evictMissingPooledDevice` is deferring eviction
   *   while killDevice holds a shutdown reservation, or the observation arrived
   *   through FUNNEL 1 from a path that does not own pool membership
   *   ({@link DevicePool.quarantineDisagreeingPooledIdentity}).
   * - **leave, restored** — a resolved name MATCHES. Same entry, same session,
   *   same `incarnation`.
   * - **leave, replaced** — a resolved name DISAGREES and the replacement
   *   installs: a fresh incarnation, the old session retired, exactly as an
   *   observed disappearance. A disagreement NEVER lifts the quarantine on the
   *   old entry by itself.
   *
   * The five consumers that read this state:
   *
   * 1. **Assignment** — the shared gate
   *    ({@link DevicePool.ensurePooledDevicePresentForUse}) reports a quarantined
   *    entry as not assignable, including one the assignment's OWN liveness check
   *    just quarantined, so idle selection skips it and the exact-device paths
   *    (`bindOrReuseDeviceSession`, autolock) refuse by serial.
   * 2. **Tool execution** — FUNNEL 2.
   *    {@link DevicePool.assertSessionReadyForAutomation} is one of its callers,
   *    not a second gate: a session addresses its device by serial, so it is just
   *    the session-keyed spelling of a device-addressed operation.
   * 3. **Publishing** — {@link DevicePool.describesPooledRuntime} reads it, so the
   *    booted-devices resource publishes neither the pooled epoch nor the pooled
   *    AVD label. It is also FUNNEL 1's idempotence check: an observation that
   *    already describes the pooled runtime changes nothing.
   * 4. **Destructive confirmation** — `deviceTools.getValidatedPooledAndroidAvdName`
   *    returns undefined, so no kill/delete path can act on the cached label.
   *    The kill does not merely drop the label: a quarantined entry produces a
   *    `quarantined` capture whose runtime confirmation is MANDATORY (the
   *    emulator console must name itself; an unanswered probe or a differing
   *    name refuses), because dropping the label also dropped the confirmation
   *    it exists to trigger. That confirmation is why the teardown path MATCHES
   *    through the quarantine (`getBootedAndroidTeardownStableName`) rather than
   *    refusing on it — a strictly stronger gate than the flag.
   * 5. **Stream routing** — the daemon's `DeviceSessionResolver` withholds the
   *    serial↔uuid mapping in both directions and every push server drops that
   *    serial's frames, so a possible replacement's passive events cannot reach
   *    the previous AVD's subscribers. The resolver also exposes FUNNEL 2, so a
   *    push server can REFUSE a device-addressed request (`request_observation`)
   *    instead of serving it into that routing black hole.
   */
  identityUnresolved?: boolean;

  /**
   * The `BootedDevice.observedAt` of the newest identity observation folded into
   * this entry, when that observation carried one — in EITHER direction: the
   * terminal placeholder exhaustion or disagreement that entered
   * {@link identityUnresolved}, and the resolved name that confirmed or lifted
   * it. In-progress unreadable observations are deliberately not recorded here:
   * they are no new identity evidence.
   *
   * Discovery calls run concurrently and finish out of order, so the observation
   * a funnel folds in is not necessarily the newest one. Recording it on the
   * quarantine transitions alone made the ordering rule one-sided: an older
   * listing that read the AVD name before it became unreadable could not lift a
   * newer quarantine, but a delayed placeholder or disagreement could still
   * quarantine an entry a NEWER observation had just resolved — cancelling the
   * bound session's in-flight executions and blocking routing on evidence the
   * pool already knew was superseded. Both directions are now ordered against
   * this one stamp, which is how the pool already orders mutable-name updates
   * (`nameObservedAt`)
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   *
   * Absent when no identity observation has carried a stamp (start-path
   * snapshots, legacy callers, test fakes): two unorderable observations are not
   * evidence of order, so the transition proceeds rather than wedging the entry
   * in whichever state it is in.
   */
  identityObservedAt?: number;
}

function neutralIdentityEvidence(device: Pick<BootedDevice, "observedAt">): IdentityEvidence {
  return {
    unresolved: false,
    ...(device.observedAt === undefined ? {} : { observedAt: device.observedAt }),
  };
}

function identityEvidenceFields(
  evidence: IdentityEvidence,
): Pick<PooledDevice, "identityObservedAt" | "identityUnresolved"> {
  return {
    ...(evidence.observedAt === undefined ? {} : { identityObservedAt: evidence.observedAt }),
    ...(evidence.unresolved ? { identityUnresolved: true } : {}),
  };
}

interface RollbackAssignment {
  deviceId: string;
  session: Session;
}

export type SessionAssignmentSnapshot = Pick<
  PooledDevice,
  "sessionId" | "status" | "lastUsedAt" | "assignmentCount" | "errorCount" | "autolockSessionId"
>;

export interface ShutdownIdentityReservation {
  device: PooledDevice | undefined;
  assignmentCount: number | undefined;
  session: Session | undefined;
  releaseSession: (() => void) | undefined;
}

const ALLOCATION_SNAPSHOT_STALE_RETRIES = 3;

/** Bound on the adb state read that decides a recovery reservation's lift (#10074). */
const ANDROID_OFFLINE_PROBE_TIMEOUT_MS = 10_000;

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
  sourceImage?: DeviceInfo;
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

interface AllocationDiscoverySnapshots {
  capturedEntries: ReadonlySet<PooledDevice>;
  iosLiveness?: IosLivenessSnapshot;
  androidPresence?: BootedDeviceDiscovery;
}

interface AssignableIdleDeviceSelection {
  device?: PooledDevice;
  livenessUnknown: boolean;
  snapshotStale: boolean;
}

interface DeviceDisconnectSessionReleaser {
  (
    sessionId: string,
    deviceId: string,
    releaseReason: string,
    shouldCommit?: () => boolean,
  ): Promise<boolean | void>;
}

interface DeviceReadyListener {
  (deviceId: string): void;
}

interface DeviceRemovedListener {
  (deviceId: string, platform: "android" | "ios"): void;
}

export interface DeviceSessionExecutionCanceller {
  /** Same injected cancellation/drain seam, for work with no bound session. */
  cancelDeviceExecutions?(
    deviceId: string,
    reason: string | Error,
    options?: { excludeExecutionId?: string; onlySessionUuid?: string },
  ): Promise<number>;
  (sessionId: string, reason: string, options?: { excludeExecutionId?: string }): Promise<number>;
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
export type AndroidEmulatorContinuityDevice = PooledDevice & { platform: "android" };

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
export interface DevicePoolDependencies {
  androidAdbFactory?: AdbClientFactory;
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
  onDeviceReady?: DeviceReadyListener;
  androidDeviceReboot?: AndroidDeviceReboot;
  recoveryPolicy?: DeviceRecoveryPolicy;
  onDeviceRemoved?: DeviceRemovedListener;
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

function createAdbServerResetQuarantine(
  port: AdbServerResetQuarantinePoolPort,
  factory?: DevicePoolDependencies["adbServerResetQuarantineFactory"],
): AdbServerResetQuarantine {
  return factory ? factory(port) : new AdbServerResetQuarantine(port);
}

function createEmulatorProcessLifecycle(
  port: EmulatorProcessLifecyclePoolPort,
  factory?: DevicePoolDependencies["emulatorProcessLifecycleFactory"],
): EmulatorProcessLifecycle {
  return factory ? factory(port) : new EmulatorProcessLifecycle(port);
}

function createMissingDeviceLiveness(
  port: MissingDeviceLivenessPoolPort,
  factory?: DevicePoolDependencies["missingDeviceLivenessFactory"],
): MissingDeviceLiveness {
  return factory ? factory(port) : new MissingDeviceLiveness(port);
}

function createAndroidTransportAliases(factory?: AdbClientFactory): AndroidTransportAliases {
  return new AndroidTransportAliases(factory ?? androidTransportIdentityAdbFactory);
}

function resolveMissingDeviceMisses(shared?: Map<string, number>): Map<string, number> {
  return shared ?? new Map();
}

function createDevicePoolRefresh(
  port: DevicePoolRefreshPort,
  factory?: DevicePoolDependencies["devicePoolRefreshFactory"],
): DevicePoolRefresh {
  return factory ? factory(port) : new DevicePoolRefresh(port);
}

function createDeviceRuntimeIdentity(
  port: DeviceRuntimeIdentityPoolPort,
  factory?: DevicePoolDependencies["runtimeIdentityFactory"],
): DeviceRuntimeIdentity {
  return factory ? factory(port) : new DeviceRuntimeIdentity(port);
}

function createDeviceShutdownReservations(
  port: DeviceShutdownReservationsPoolPort,
  factory?: DevicePoolDependencies["deviceShutdownReservationsFactory"],
): DeviceShutdownReservations {
  return factory ? factory(port) : new DeviceShutdownReservations(port);
}

interface StopAndroidEmulatorRecoveryOptions {
  device: PooledDevice;
  avdName: string;
  retainLeaseUntil: (settlement: Promise<unknown>) => void;
  allowActiveStop: boolean;
  handoffOwner: symbol;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
}

interface RebindSameAvdReplacementSessionOptions {
  device: PooledDevice;
  avdName: string;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
  preservedAutolockSessionId: string | undefined;
  recoveryImage: DeviceInfo;
  handoffOwner: symbol;
}

interface BindRecoveredAndroidDeviceSessionOptions {
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

interface StopDiscoveredEmulatorOptions {
  disconnectedDevice: PooledDevice;
  avdName: string;
  retainLeaseUntil: (settlement: Promise<unknown>) => void;
  adoptOnly: boolean;
  handoffOwner: symbol;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
}

export class DevicePool {
  private devices: Map<string, PooledDevice> = new Map();
  private deviceSessionStarts: Map<string, number> = new Map();
  private sessionManager: SessionManager;
  private assignmentMutex = new Mutex();
  // Tickets begin after preflight. Only platform-disjoint requests may
  // overtake earlier waiters; new partial claims are released before waiting.
  private readonly multiDeviceAllocationQueue: Array<{
    requests: DeviceAllocationRequest[];
  }> = [];
  private readonly multiDeviceAllocationWaiters = new Set<() => void>();

  private timer: Timer;
  private readonly idGenerator: IdGenerator;
  private lastUsedAtMarker = 0;
  private lastReleasedDeviceId: string | null = null;
  /**
   * Every daemon-MCP connection that acquired a result-minted device session.
   *
   * This is deliberately separate from the autolock routing maps below:
   * ordinary acquisitions do not opt into implicit autolock routing, but they
   * still own their exact device session and must not let another connection
   * adopt it through an idempotent getAndroid/getApple/startDevice call.
   */
  private readonly mcpSessionAcquiredDeviceSessions = new Map<string, Set<string>>();
  private readonly mcpSessionRecoveryDevices: Map<string, McpSessionRecoveryLease> = new Map();
  private readonly refreshMissingDeviceMisses: Map<string, number>;
  private readonly androidTransportAliases: AndroidTransportAliases;
  private androidAliasObservation = 0;
  private androidAliasAppliedObservation = 0;
  private androidAliasRetirement = 0;
  private androidAliasAppliedDevices: BootedDevice[] = [];
  private readonly suppressedAutoStartDeviceImageKeys: Set<string> = new Set();
  private readonly suppressedAutoStartImageKeyByDeviceId: Map<string, string> = new Map();
  private daemonSessionId: string;
  private installedAppsRepository: InstalledAppsStore;
  private deviceManager: PlatformDeviceManager;
  private readonly retryExecutor: RetryExecutor;
  private readonly deviceSessionRepository: Pick<DeviceSessionRepository, "markAutolockSession">;
  private readonly criteriaMatcher: DeviceCriteriaMatcher;
  private readonly releaseSessionForDisconnectedDevice: DeviceDisconnectSessionReleaser;
  private readonly onDeviceReady: DeviceReadyListener | undefined;
  private readonly onDeviceRemoved: DeviceRemovedListener | undefined;
  private readonly onDeviceFramesInvalidated: ((deviceId: string) => void) | undefined;
  private readonly cancelDeviceSessionExecutions: DeviceSessionExecutionCanceller;
  private readonly ambientExecutionIdReader: AmbientExecutionIdReader | undefined;
  private readonly androidDeviceReboot: AndroidDeviceReboot;
  private readonly recoveryPolicy: DeviceRecoveryPolicy;
  private readonly deviceSessionContinuityEnabled: boolean;
  private readonly recoveryCoordinator: DeviceRecoveryCoordinator;
  private readonly sessionPreservingRecovery: SessionPreservingRecoveryRunner;
  private readonly adbResetSessionRecovery: AdbResetSessionRecovery;
  private readonly adbServerResetQuarantine: AdbServerResetQuarantine;
  private get recoveringAndroidImages(): Map<string, DeviceInfo> {
    return this.recoveryCoordinator.recoveringAndroidImages;
  }
  private get recoveringAndroidDeviceIds(): Set<string> {
    return this.recoveryCoordinator.recoveringAndroidDeviceIds;
  }
  private get androidRecoveryHandoffOwners(): Map<string, symbol> {
    return this.recoveryCoordinator.androidRecoveryHandoffOwners;
  }
  private afterAndroidStartupRecoverySnapshot?: () => void;
  /**
   * A reset cohort is reserved before its first member is restarted. This keeps
   * a concurrent named getAndroid call from booting a later cohort member while
   * its detached AVD/session relationship is still being restored.
   */
  private readonly adbServerResetRecoveryReservations: Map<
    string,
    AdbServerResetRecoveryReservation
  > = new Map();
  /** Child-process handles retained after reset cohort pool entries are detached. */
  private readonly adbServerResetTrackedProcesses: WeakMap<PooledDevice, ChildProcess> =
    new WeakMap();
  /**
   * A named Android start holds this lease from reset-reservation preflight
   * through session binding so a reset cohort cannot detach that AVD mid-start.
   */
  private readonly androidStartupLeases: Map<symbol, AndroidStartupLeaseRequest> = new Map();
  /** Sessions whose old serial may be reused before their reset cohort settles. */
  private readonly adbServerResetQuarantinedSessions: Set<string> = new Set();
  private get sessionPreservingRecoveries(): Map<string, SessionPreservingRecovery> {
    return this.recoveryCoordinator.sessionPreservingRecoveries;
  }
  private readonly emulatorProcessLifecycle: EmulatorProcessLifecycle;
  private readonly missingDeviceLiveness: MissingDeviceLiveness;
  private readonly refreshCoordinator: DevicePoolRefresh;
  private readonly allocationRefresh = new SingleFlight<"allocation", DevicePoolRefreshResult>();
  private readonly recoveryRetryRefresh: TTLCache<"allocation", DevicePoolRefreshResult>;
  private readonly runtimeIdentity: DeviceRuntimeIdentity;
  private readonly shutdownReservationCoordinator: DeviceShutdownReservations;
  private readonly startedDeviceProcesses: Map<string, ChildProcess> = new Map();
  private readonly startedDeviceProcessOutput: Map<string, EmulatorProcessOutputTail> = new Map();
  private readonly emulatorLossLedger: EmulatorLossIncidentLedger;
  private readonly androidRecoveryRecordLedger: AndroidRecoveryRecordLedger;
  private readonly idleDeviceReaper: IdleDeviceReaper;
  private readonly autolockManager: DeviceAutolockManager;
  private readonly disconnectHandler: DeviceDisconnectHandler;
  private readonly androidRebootCoordinator: AndroidRebootCoordinator;
  private get recoveringSessionLosses(): Map<string, AndroidRecoveryRecord> {
    return this.androidRecoveryRecordLedger.recoveringSessionLosses;
  }
  private get failedTerminalRecoveryReleases(): Set<string> {
    return this.androidRecoveryRecordLedger.failedTerminalRecoveryReleases;
  }
  private get emulatorLossIncidentStore(): EmulatorLossIncidentStore {
    return this.emulatorLossLedger.emulatorLossIncidentStore;
  }
  private get emulatorLossRecoverySettlements(): Map<string, Promise<void>> {
    return this.emulatorLossLedger.emulatorLossRecoverySettlements;
  }
  private get emulatorLossRecoveryResolvers(): Map<string, () => void> {
    return this.emulatorLossLedger.emulatorLossRecoveryResolvers;
  }
  /** A late kill settled; only a later fresh observation can lift its fence. */
  private readonly settledLateShutdowns = new Map<
    string,
    { incarnation: number; refreshGeneration: number }
  >();
  /** Exact session incarnation last assigned to each pooled-device incarnation. */
  private readonly pooledSessionIdentities: WeakMap<PooledDevice, Session> = new WeakMap();
  /**
   * Serials the user intentionally stopped, mapped to the pooled-device
   * incarnation that was present at mark time (or {@link INCARNATION_ANY} when
   * only a recovery was in flight). Consuming this on a disconnect is gated on
   * incarnation so a stale disconnect for a prior incarnation cannot remove a
   * same-serial replacement, nor can a later crash of a replacement consume a
   * marker that belonged to a device that is already gone.
   */
  private readonly intentionalShutdowns: Map<string, number> = new Map();
  /** Releases waiting for late session teardown, bound to one pooled incarnation. */
  private readonly deferredDeviceReleases: Map<
    string,
    { device: PooledDevice; sessionId: string; assignmentCount: number; cleanup: Promise<void> }
  > = new Map();
  /**
   * Explicit session-release callbacks run before terminal persistence awaits.
   * Capture ownership there so the later caller-ordered pool release cannot
   * snapshot and free a same-UUID replacement assignment.
   */
  private readonly releasedDeviceCaptures: Map<
    string,
    { device: PooledDevice; deviceId: string; assignmentCount: number }
  > = new Map();
  private deviceIncarnationCounter = 0;

  // Max consecutive errors before marking device as failed
  private readonly MAX_DEVICE_ERRORS = 5;

  // Device wait configuration for parallel test execution
  private readonly DEVICE_WAIT_TIMEOUT_MS = 60000; // 60 seconds max wait
  private readonly DEVICE_WAIT_INTERVAL_MS = 1000; // Check every 1 second
  private readonly RECOVERY_RESPONSE_MARGIN_MS = 1000;
  // Match the daemon's 5s disconnect-monitor cadence: client retries must not
  // turn the three-miss eviction threshold into a tight-loop reboot trigger.
  private readonly RECOVERY_RETRY_REFRESH_INTERVAL_MS = 5000;
  private readonly lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  private readonly consoleBusyRegistry: EmulatorConsoleBusyRegistry;

  static create(deps: DevicePoolDependencies): DevicePool {
    return new DevicePool(deps);
  }

  private readonly deviceHealthMarkers: DeviceHealthMarkers;

  constructor({
    env,
    sessionManager,
    daemonSessionId,
    timer = defaultTimer,
    deviceHealthMarkers,
    deviceHealthRecoveryBackoff,
    installedAppsRepository,
    deviceManager = new MultiPlatformDeviceManager(),
    retryExecutor = new DefaultRetryExecutor(timer),
    deviceSessionRepository = new DeviceSessionRepository(),
    criteriaMatcher = new DeviceCriteriaMatcher(),
    releaseSessionForDisconnectedDevice,
    onDeviceReady,
    androidDeviceReboot,
    recoveryPolicy,
    onDeviceRemoved,
    onDeviceFramesInvalidated,
    emulatorLossIncidentStore = new InMemoryEmulatorLossIncidentStore(timer),
    cancelDeviceSessionExecutions,
    ambientExecutionIdReader,
    idGenerator = defaultIdGenerator,
    lifecycleCoordinator,
    consoleBusyRegistry,
    missingDeviceMisses,
    adbServerResetQuarantineFactory,
    emulatorProcessLifecycleFactory,
    missingDeviceLivenessFactory,
    devicePoolRefreshFactory,
    runtimeIdentityFactory,
    deviceShutdownReservationsFactory,
    deviceSessionContinuityEnabled,
    androidAdbFactory,
  }: DevicePoolDependencies) {
    this.sessionManager = sessionManager;
    this.daemonSessionId = daemonSessionId;
    this.timer = timer;
    this.androidTransportAliases = createAndroidTransportAliases(androidAdbFactory);
    this.recoveryRetryRefresh = new TTLCache(timer, {
      ttlMs: this.RECOVERY_RETRY_REFRESH_INTERVAL_MS,
      maxEntries: 1,
    });
    this.deviceHealthMarkers = resolveDeviceHealthMarkers(deviceHealthMarkers, timer);
    sessionManager.setDeviceHealthMarkers(
      this.deviceHealthMarkers,
      (id) => this.getDeviceIncarnation(id),
      (id) => {
        const device = this.devices.get(id);
        return (
          device?.status === "idle" &&
          !device.sessionId &&
          !sessionManager.hasDeviceCleanupInProgress(id)
        );
      },
      deviceHealthRecoveryBackoff,
    );
    this.refreshMissingDeviceMisses = resolveMissingDeviceMisses(missingDeviceMisses);
    this.idGenerator = idGenerator;
    this.consoleBusyRegistry = resolveConsoleBusyRegistry(consoleBusyRegistry);
    this.installedAppsRepository = installedAppsRepository ?? new InstalledAppsRepository();
    this.deviceManager = deviceManager;
    const shutdownReservationsPort: DeviceShutdownReservationsPoolPort =
      this.createShutdownReservationsPort();
    this.shutdownReservationCoordinator = createDeviceShutdownReservations(
      shutdownReservationsPort,
      deviceShutdownReservationsFactory,
    );
    const missingDevicePort: MissingDeviceLivenessPoolPort = this.createMissingDevicePort();
    this.missingDeviceLiveness = createMissingDeviceLiveness(
      missingDevicePort,
      missingDeviceLivenessFactory,
    );
    const refreshPort: DevicePoolRefreshPort = this.createRefreshPort();
    this.refreshCoordinator = createDevicePoolRefresh(refreshPort, devicePoolRefreshFactory);
    const emulatorProcessPort: EmulatorProcessLifecyclePoolPort = this.createEmulatorProcessPort();
    this.emulatorProcessLifecycle = createEmulatorProcessLifecycle(
      emulatorProcessPort,
      emulatorProcessLifecycleFactory,
    );
    this.idleDeviceReaper = this.createIdleDeviceReaper();
    this.retryExecutor = retryExecutor;
    this.deviceSessionRepository = deviceSessionRepository;
    this.autolockManager = this.createAutolockManager(env);
    this.criteriaMatcher = criteriaMatcher;
    this.onDeviceReady = onDeviceReady;
    this.onDeviceRemoved = onDeviceRemoved;
    this.onDeviceFramesInvalidated = onDeviceFramesInvalidated;
    this.cancelDeviceSessionExecutions = cancelDeviceSessionExecutions ?? (async () => 0);
    this.ambientExecutionIdReader = ambientExecutionIdReader;
    const runtimeIdentityPort: DeviceRuntimeIdentityPoolPort =
      this.createRuntimeIdentityPort(ambientExecutionIdReader);
    this.runtimeIdentity = createDeviceRuntimeIdentity(runtimeIdentityPort, runtimeIdentityFactory);
    this.androidRecoveryRecordLedger = new AndroidRecoveryRecordLedger(
      {
        getDevice: (deviceId) => this.getDevice(deviceId),
        getSession: (sessionId) => this.sessionManager.getSession(sessionId),
        clearAdbResetReservation: (record) => this.clearAdbResetRecoveryReservation(record),
      },
      this.timer,
    );
    this.recoveryCoordinator = this.createRecoveryCoordinator();
    this.sessionPreservingRecovery = this.createSessionPreservingRecovery();
    this.adbResetSessionRecovery = this.createAdbResetSessionRecovery();
    this.adbServerResetQuarantine = this.createAdbResetQuarantine(adbServerResetQuarantineFactory);
    this.emulatorLossLedger = new EmulatorLossIncidentLedger(
      {
        getDevice: (deviceId) => this.getDevice(deviceId),
        getRecoveryPolicy: () => this.getRecoveryPolicy(),
        getSessionForDevice: (deviceId) => this.sessionManager.getSessionForDevice(deviceId),
        getSession: (sessionId) => this.sessionManager.getSession(sessionId),
        getProcessOutputTail: (deviceId) => this.startedDeviceProcessOutput.get(deviceId),
      },
      emulatorLossIncidentStore,
      this.timer,
      this.retryExecutor,
    );
    this.lifecycleCoordinator = resolveLifecycleCoordinator(lifecycleCoordinator);
    // Resolve recovery policy once so retries and status agree even if the
    // process environment changes after construction.
    this.recoveryPolicy = this.resolveRecoveryPolicy(recoveryPolicy);
    this.deviceSessionContinuityEnabled = this.resolveDeviceSessionContinuity(
      deviceSessionContinuityEnabled,
    );
    this.androidDeviceReboot =
      androidDeviceReboot ??
      new BoundedAndroidDeviceReboot(
        timer,
        this.recoveryPolicy.maxAttempts,
        getDeviceRecoveryWindowMs(),
      );
    this.androidRebootCoordinator = this.createAndroidRebootCoordinator();
    this.disconnectHandler = this.createDisconnectHandler();
    this.releaseSessionForDisconnectedDevice =
      releaseSessionForDisconnectedDevice ??
      (async (sessionId, _deviceId, releaseReason, shouldCommit) => {
        // The session manager re-evaluates the fence immediately before it
        // removes the session, after its setup/restoration awaits (#7031).
        if (!shouldCommit) {
          await this.sessionManager.releaseSession(sessionId, releaseReason);
          return true;
        }
        const release = await this.sessionManager.releaseSessionUnlessSuperseded(
          sessionId,
          releaseReason,
          shouldCommit,
        );
        return !release.superseded;
      });

    this.registerSessionReleaseHandlers();
  }

  private createIdleDeviceReaper(): IdleDeviceReaper {
    return new IdleDeviceReaper(
      {
        getDevice: (deviceId) => this.getDevice(deviceId),
        removeDevice: (deviceId, awaitCacheCleanup, expectedDevice) =>
          this.removeDevice(deviceId, awaitCacheCleanup, expectedDevice),
        withAssignmentLock: (operation) => this.assignmentMutex.runExclusive(operation),
      },
      this.deviceManager,
    );
  }

  private createRuntimeIdentityPort(
    ambientExecutionIdReader: AmbientExecutionIdReader | undefined,
  ): DeviceRuntimeIdentityPoolPort {
    return {
      getAmbientExecutionId: () => ambientExecutionIdReader?.getExecutionId(),
      notifyDeviceFramesInvalidated: (deviceId) => this.notifyDeviceFramesInvalidated(deviceId),
      getDevices: () => this.devices,
      getDeviceManager: () => this.deviceManager,
      getRetryExecutor: () => this.retryExecutor,
      getTimer: () => this.timer,
      getRefreshGeneration: () => this.refreshCoordinator.getRefreshGeneration(),
      hasReusableSerial: (device) => this.hasReusableSerial(device),
      isReservedForShutdown: (device) => this.isReservedForShutdown(device),
      cancelDeviceExecutions: (deviceId, reason, options) =>
        this.cancelDeviceSessionExecutions.cancelDeviceExecutions?.(deviceId, reason, options) ??
        Promise.resolve(0),
      cancelDeviceSessionExecutions: (sessionId, reason, options) =>
        this.cancelDeviceSessionExecutions(sessionId, reason, options),
    };
  }

  private createDisconnectHandler(): DeviceDisconnectHandler {
    return new DeviceDisconnectHandler({
      getPooledDevice: (deviceId) => this.devices.get(deviceId),
      getIntentionalShutdownMarker: (deviceId) => this.intentionalShutdowns.get(deviceId),
      deleteIntentionalShutdownMarker: (deviceId) => {
        this.intentionalShutdowns.delete(deviceId);
      },
      isReservedForShutdown: (device) => this.isReservedForShutdown(device),
      removeDevice: (deviceId, awaitCacheCleanup, expectedDevice) =>
        this.removeDevice(deviceId, awaitCacheCleanup, expectedDevice),
      finishEmulatorLossIncident: (incidentId, outcome) =>
        this.finishEmulatorLossIncident(incidentId, outcome),
      recordEmulatorLossIncident: (deviceId, path, processExit, lastAdbState) =>
        this.recordEmulatorLossIncident(deviceId, path, processExit, lastAdbState),
      shouldRebootDisconnectedAndroidDevice: (device) =>
        this.shouldRebootDisconnectedAndroidDevice(device),
      rebootDisconnectedAndroidDevice: (device, incidentId) =>
        this.rebootDisconnectedAndroidDevice(device, incidentId),
      settleEmulatorLossIncident: (incidentId) => this.settleEmulatorLossIncident(incidentId),
      suppressAutoStartForDevice: (device) => this.suppressAutoStartForDevice(device),
      completeEmulatorLossRecovery: (incidentId, outcome) =>
        this.completeEmulatorLossRecovery(incidentId, outcome),
      refreshEmulatorLossRecoverySettlement: (incidentId, outcome) =>
        this.refreshEmulatorLossRecoverySettlement(incidentId, outcome),
      getRecoveryPolicy: () => this.getRecoveryPolicy(),
      isAndroidEmulatorActiveRelaunchEligible: (device) =>
        this.isAndroidEmulatorActiveRelaunchEligible(device),
      getDeviceManager: () => this.deviceManager,
      androidRediscoveryMatches: (candidate, deviceId, avdName) =>
        this.criteriaMatcher.androidRediscoveryMatches(candidate, deviceId, avdName),
    });
  }

  private registerSessionReleaseHandlers(): void {
    this.sessionManager.setRecoveryExpiryReleaseHandler({
      release: (sessionId, reason, attempt, options) => {
        const recoveryRelease = this.recoveryCoordinator.releaseFailedRecoveryOnExpiry(
          sessionId,
          reason,
          attempt,
          options,
        );
        if (recoveryRelease) {
          options.deviceReleaseManaged = true;
          return recoveryRelease;
        }
        const terminalRelease = this.sessionManager.getTerminalReleaseSnapshot(sessionId);
        if (!terminalRelease || !this.sessionManager.hasSession(sessionId)) {
          return undefined;
        }
        // This handler returns the device after the attempt, including when a
        // retained terminal fence upgrades the expiry's diagnostic reason.
        options.deviceReleaseManaged = true;
        let releasedDeviceId: string | null = null;
        return releaseSessionAndDevice(
          this.sessionManager,
          this,
          terminalRelease.deviceId,
          sessionId,
          reason,
          {
            release: async () => {
              releasedDeviceId = await attempt();
              return releasedDeviceId;
            },
          },
        ).then(() => releasedDeviceId);
      },
    });

    // Expiry has no caller available to return the device to the pool. Explicit
    // release callers retain their ordered cleanup and release flow, while
    // connection ownership and autolock metadata are removed when their session
    // ends.
    this.sessionManager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, options) => {
      this.clearMcpSessionOwnership(sessionId);
      // An expiry handler that owns the ordered release consumes its capture after the attempt.
      if (options.expiryOrigin && !options.deviceReleaseManaged) {
        this.releaseExpiredSessionDevice(sessionId, deviceId);
      } else {
        this.captureReleasedDevice(sessionId, deviceId);
        this.autolockManager.clearReleasedAutolockState(sessionId, deviceId);
      }
      this.recoveryCoordinator.finalizeReleasedRecoverySession(sessionId);
    });
  }

  private createShutdownReservationsPort(): DeviceShutdownReservationsPoolPort {
    return {
      getDevices: () => this.devices,
      getAssignmentMutex: () => this.assignmentMutex,
      getIntentionalShutdowns: () => this.intentionalShutdowns,
      assertReadinessReservationOwner: (device, client) =>
        this.assertReadinessReservationOwner(device, client),
      assertRuntimeIdentity: (device, identity) =>
        this.runtimeIdentity.assertRuntimeIdentity(device, identity),
      assertAndroidRecoveryExclusionForReadinessReservation: (device, identity, name, enforce) =>
        this.assertAndroidRecoveryExclusionForReadinessReservation(device, identity, name, enforce),
      reserveShutdownSessionIdentity: (deviceId) => this.reserveShutdownSessionIdentity(deviceId),
      completeShutdownSessionIdentity: (deviceId, device, identity) =>
        this.completeShutdownSessionIdentity(deviceId, device, identity),
      reserveMcpSessionRecoveryLease: (sessionId, device, token) =>
        this.reserveMcpSessionRecoveryLease(sessionId, device, token),
      releaseMcpSessionRecoveryLease: (sessionId, token) =>
        this.releaseMcpSessionRecoveryLease(sessionId, token),
      getOwnedAutolockSession: (device, client) =>
        this.autolockManager.getOwnedAutolockSession(device, client),
    };
  }

  private createMissingDevicePort(): MissingDeviceLivenessPoolPort {
    return {
      getDevices: () => this.devices,
      getRefreshMissingDeviceMisses: () => this.refreshMissingDeviceMisses,
      getAssignmentMutex: () => this.assignmentMutex,
      getDeviceManager: () => this.deviceManager,
      getRefreshGeneration: () => this.refreshCoordinator.getRefreshGeneration(),
      shouldRebootDisconnectedAndroidDevice: (device) =>
        this.shouldRebootDisconnectedAndroidDevice(device),
      mapAndroidDiscovery: (devices) => this.androidTransportAliases.mapDiscovery(devices, true),
      needsAndroidTransportNormalization: (devices) =>
        devices.some((device) => device.platform === "android") &&
        this.needsAndroidTransportNormalization(devices),
      isTransportEmulator: (deviceId) =>
        this.androidTransportAliases.avdName(deviceId) !== undefined,
      matchesRuntimeIdentity: (device, booted) =>
        this.runtimeIdentity.matchesRuntimeIdentity(device, booted),
      reconcilePooledIdentityResolution: (device, booted) =>
        this.runtimeIdentity.reconcilePooledIdentityResolution(device, booted),
      comparePooledIdentityEvidence: (device, observed) =>
        this.runtimeIdentity.comparePooledIdentityEvidence(device, observed),
      replacePooledDeviceForRuntimeIdentity: (device, booted) =>
        this.replacePooledDeviceForRuntimeIdentity(device, booted),
      finishSessionPreservingRecoveryPreparation: (preparation) =>
        this.finishSessionPreservingRecoveryPreparation(preparation),
      tryPreserveSessionForMissingDevice: (device, attempt, incidentId) =>
        this.tryPreserveSessionForMissingDevice(device, attempt, incidentId),
      releaseSessionForEvictedDevice: (device, incidentId, observation) =>
        this.releaseSessionForEvictedDevice(device, incidentId, observation),
      finishEmulatorLossIncident: (incidentId, outcome) =>
        this.finishEmulatorLossIncident(incidentId, outcome),
      removeDisconnectedDevice: (deviceId, mayBeStaleSignal, incidentId) =>
        this.removeDisconnectedDevice(deviceId, mayBeStaleSignal, incidentId),
      completeEmulatorLossRecovery: (incidentId, outcome) =>
        this.completeEmulatorLossRecovery(incidentId, outcome),
      settleEmulatorLossIncident: (incidentId) => this.settleEmulatorLossIncident(incidentId),
      removeDevice: (deviceId, awaitCacheCleanup, expectedDevice) =>
        this.removeDevice(deviceId, awaitCacheCleanup, expectedDevice),
      isReservedForShutdown: (device) => this.isReservedForShutdown(device),
      recordEmulatorLossIncident: (deviceId, path, exit, state) =>
        this.recordEmulatorLossIncident(deviceId, path, exit, state),
    };
  }

  private createRefreshPort(): DevicePoolRefreshPort {
    return {
      normalizeAndroidDiscovery: (devices, held, current, complete) =>
        this.normalizeAndroidDiscovery(devices, held, current, complete),
      isAndroidTransportAssignable: (device) => this.androidTransportAliases.isAssignable(device),
      needsAndroidTransportNormalization: (devices) =>
        this.needsAndroidTransportNormalization(devices),
      getTimer: () => this.timer,
      getDeviceManager: () => this.deviceManager,
      getDevices: () => this.devices,
      getAssignmentMutex: () => this.assignmentMutex,
      getCriteriaMatcher: () => this.criteriaMatcher,
      identityEvidenceForBootedDevice: (device) =>
        this.runtimeIdentity.identityEvidenceForBootedDevice(device),
      identityEvidenceFields: (evidence) => identityEvidenceFields(evidence),
      getDeviceSessionStarts: () => this.deviceSessionStarts,
      getRefreshMissingDeviceMisses: () => this.refreshMissingDeviceMisses,
      getSettledLateShutdowns: () => this.settledLateShutdowns,
      getIntentionalShutdowns: () => this.intentionalShutdowns,
      seedLastUsedAt: (now) => this.seedLastUsedAt(now),
      nextDeviceIncarnation: () => this.nextDeviceIncarnation(),
      setDeviceSessionTracking: (id, now) => this.setDeviceSessionTracking(id, now),
      clearAutoStartSuppressionForBootedDevice: (device) =>
        this.clearAutoStartSuppressionForBootedDevice(device),
      foldObservationIntoPooledEntry: (pooled, device, source) =>
        this.foldObservationIntoPooledEntry(pooled, device, source),
      removeMissingDevicesForRefresh: (held, generation, ids, platforms, succeeded, sources) =>
        this.missingDeviceLiveness.removeMissingDevicesForRefresh(
          held,
          generation,
          ids,
          platforms,
          succeeded,
          sources,
        ),
      notifyDeviceReady: (id) => this.notifyDeviceReady(id),
      liftUnconfirmedRecoveringAndroidImages: (discovery, generation) =>
        this.recoveryCoordinator.liftUnconfirmedRecoveringAndroidImages(discovery, generation),
    };
  }

  private createEmulatorProcessPort(): EmulatorProcessLifecyclePoolPort {
    return {
      getTimer: () => this.timer,
      getStartedDeviceProcesses: () => this.startedDeviceProcesses,
      getStartedDeviceProcessOutput: () => this.startedDeviceProcessOutput,
      getDevices: () => this.devices,
      getSessionManager: () => this.sessionManager,
      isReservedForShutdown: (device) => this.isReservedForShutdown(device),
      prepareSessionPreservingRecovery: (id, device) =>
        this.prepareSessionPreservingRecovery(id, device),
      finishSessionPreservingRecoveryPreparation: (preparation) =>
        this.finishSessionPreservingRecoveryPreparation(preparation),
      recordEmulatorLossIncident: (id, path, exit) =>
        this.recordEmulatorLossIncident(id, path, exit),
      finishEmulatorLossIncident: (id, outcome) => this.finishEmulatorLossIncident(id, outcome),
      evictMissingPooledDevice: (device, reason, attempt, incidentId, captured, preparation) =>
        this.evictMissingPooledDevice(device, reason, {
          attemptDeviceLossRecovery: attempt,
          incidentId,
          incidentCaptureComplete: captured,
          recoveryPreparation: preparation,
        }),
    };
  }

  private createAutolockManager(env: Environment | undefined): DeviceAutolockManager {
    return new DeviceAutolockManager(
      {
        getSessionManager: () => this.sessionManager,
        getDaemonSessionId: () => this.daemonSessionId,
        getDevice: (id) => this.devices.get(id),
        withAssignmentLock: (operation) => this.assignmentMutex.runExclusive(operation),
        withTargetDeviceDiscovery: (options) => this.withTargetDeviceDiscovery(options),
        assertRuntimeIdentity: (device, identity) =>
          this.runtimeIdentity.assertRuntimeIdentity(device, identity),
        assertNotReservedForShutdown: (device, message) =>
          this.assertNotReservedForShutdown(device, message),
        recordSourceAndroidAvd: (id, image) => this.recordSourceAndroidAvd(id, image),
        notifyTargetDeviceReady: (options) => this.notifyTargetDeviceReady(options),
        trackStartedDeviceProcess: (device, process) =>
          this.trackStartedDeviceProcess(device, process),
        assertIdleDeviceAssignable: (options) => this.assertIdleDeviceAssignable(options),
        validateOrReloadIdlePooledDevice: (options) =>
          this.validateOrReloadIdlePooledDevice(options),
        assertDeviceCleanupComplete: (id) => this.assertDeviceCleanupComplete(id),
        snapshotSessionAssignment: (device) => this.snapshotSessionAssignment(device),
        nextLastUsedAt: () => this.nextLastUsedAt(),
        createSessionOrRestore: (device, snapshot, create) =>
          this.createSessionOrRestore(device, snapshot, create),
        stableDeviceIdFor: (device) => this.stableDeviceIdFor(device),
        recordMcpSessionOwnership: (client, session) =>
          this.recordMcpSessionOwnership(client, session),
        restoreSessionAssignment: (device, snapshot) =>
          this.restoreSessionAssignment(device, snapshot),
        isSessionAssignmentCurrent: (device, session) =>
          this.isSessionAssignmentCurrent(device, session),
        getPooledSessionIdentity: (device) => this.pooledSessionIdentities.get(device),
        getMcpSessionRecoveryDevice: (client) => this.mcpSessionRecoveryDevices.get(client)?.device,
        isAdbServerResetQuarantined: (id) => this.adbServerResetQuarantinedSessions.has(id),
      },
      this.deviceSessionRepository,
      this.idGenerator,
      env,
    );
  }

  private createRecoveryCoordinator(): DeviceRecoveryCoordinator {
    return new DeviceRecoveryCoordinator({
      getRefreshGeneration: () => this.refreshCoordinator.getRefreshGeneration(),
      getAndroidOfflineDeviceIds: async (deviceIds) =>
        (await this.deviceManager.getAndroidOfflineDeviceIds?.(deviceIds, {
          timeoutMs: ANDROID_OFFLINE_PROBE_TIMEOUT_MS,
        })) ?? new Set<string>(),
      getRecoveringSessionLosses: () => this.recoveringSessionLosses,
      getPooledDevice: (id) => this.devices.get(id),
      getEmulatorLossIncident: (id) => this.emulatorLossIncidentStore.get(id),
      completeJoinedEmulatorLossRecovery: (id, outcome, state) =>
        this.completeEmulatorLossRecovery(id, outcome, state),
      getSessionForDevice: (id) => this.sessionManager.getSessionForDevice(id),
      waitForReleasingSession: (sessionId) =>
        this.sessionManager.getReleasingSession(sessionId)
          ? this.sessionManager.waitForSessionRelease(sessionId)
          : undefined,
      getAndroidSessionPreservingRecoveryTarget: (id, expected) =>
        this.getAndroidSessionPreservingRecoveryTarget(id, expected),
      getSessionPreservingRecoveryTarget: (id, expected) =>
        this.getSessionPreservingRecoveryTarget(id, expected),
      isIOSSimulatorContinuityDevice: (device) => this.isIOSSimulatorContinuityDevice(device),
      performSessionPreservingRecovery: (device, session, incident) =>
        this.performSessionPreservingRecovery(device, session, incident),
      finishEmulatorLossIncident: (incident, outcome) =>
        this.finishEmulatorLossIncident(incident, outcome),
      recoverSessionBoundAndroidDeviceAfterAdbServerReset: (id, expected) =>
        this.recoverSessionBoundAndroidDeviceAfterAdbServerReset(id, expected),
      releaseAdbServerResetCohortReservations: (devices) =>
        this.releaseAdbServerResetCohortReservations(devices),
      getTimer: () => this.timer,
      getAndroidRecoveryRecordLedger: () => this.androidRecoveryRecordLedger,
      getAdbServerResetQuarantinedSessions: () => this.adbServerResetQuarantinedSessions,
      getEmulatorLossRecoverySettlements: () => this.emulatorLossRecoverySettlements,
      hasReleasedDeviceCapture: (sessionId) => this.releasedDeviceCaptures.has(sessionId),
      refreshEmulatorLossRecoverySettlement: (incidentId, outcome) =>
        this.refreshEmulatorLossRecoverySettlement(incidentId, outcome),
      settleEmulatorLossIncident: (incidentId) => this.settleEmulatorLossIncident(incidentId),
      completeEmulatorLossRecovery: (incidentId, outcome) =>
        this.completeEmulatorLossRecovery(incidentId, outcome),
      releaseDisconnectedRecoverySessionWithRetry: (sessionId, deviceId, reason, attempt) =>
        this.releaseDisconnectedRecoverySessionWithRetry(sessionId, deviceId, reason, attempt),
      releaseDevice: (deviceId, sessionId) => this.releaseDevice(deviceId, sessionId),
    });
  }

  private createSessionPreservingRecovery(): SessionPreservingRecoveryRunner {
    return new SessionPreservingRecoveryRunner({
      getRecoveringSessionLoss: (id) => this.recoveringSessionLosses.get(id),
      startAndroidRecoveryRecord: (id, details, reservations, replace) =>
        this.startAndroidRecoveryRecord(id, details, reservations, replace),
      isAndroidEmulatorActiveRelaunchEligible: (device): device is AndroidEmulatorRecoveryDevice =>
        this.isAndroidEmulatorActiveRelaunchEligible(device),
      rebootDisconnectedAndroidDevice: (device, incidentId, options) =>
        this.rebootDisconnectedAndroidDevice(device, incidentId, options),
      getRecoveryPolicy: () => this.getRecoveryPolicy(),
      deviceSessionContinuityEnabled: () => this.deviceSessionContinuityEnabled,
      cancelDeviceSessionExecutions: (id, reason) => this.cancelDeviceSessionExecutions(id, reason),
      refreshReleasedRecoverySettlementAfterAwait: (record, incidentId) =>
        this.recoveryCoordinator.refreshReleasedRecoverySettlementAfterAwait(record, incidentId),
      finalizeReleasedRecoveryAfterAwait: (record, incidentId) =>
        this.recoveryCoordinator.finalizeReleasedRecoveryAfterAwait(record, incidentId),
      finalizeRecoveryRecord: (id, record) =>
        this.recoveryCoordinator.finalizeRecoveryRecord(id, record),
      finalizeReleasedRecoveryAfterCleanupFailure: (record, incidentId, error) =>
        this.recoveryCoordinator.finalizeReleasedRecoveryAfterCleanupFailure(
          record,
          incidentId,
          error,
        ),
      markAndroidRecoveryReleaseFailure: (record) =>
        this.recoveryCoordinator.markAndroidRecoveryReleaseFailure(record),
      completeEmulatorLossRecovery: (incidentId, outcome, state) =>
        this.completeEmulatorLossRecovery(incidentId, outcome, state),
      settleEmulatorLossIncident: (incidentId) => this.settleEmulatorLossIncident(incidentId),
      isPreservedSessionCurrent: (session, id) => this.isPreservedSessionCurrent(session, id),
      releaseDisconnectedRecoverySessionWithRetry: (sessionId, deviceId, reason) =>
        this.releaseDisconnectedRecoverySessionWithRetry(sessionId, deviceId, reason),
      stableDeviceIdFor: (device) => this.stableDeviceIdFor(device),
      getPooledDevice: (id) => this.devices.get(id),
      removeDevice: (id, awaitCacheCleanup, device) =>
        this.removeDevice(id, awaitCacheCleanup, device),
      suppressAutoStartForDevice: (device) => this.suppressAutoStartForDevice(device),
      getEmulatorLossIncident: (id) => this.emulatorLossIncidentStore.get(id),
      getFinalizedReleaseReason: (session) =>
        this.sessionManager.getFinalizedReleaseReason(session),
      now: () => this.timer.now(),
    });
  }

  private createAdbResetSessionRecovery(): AdbResetSessionRecovery {
    return new AdbResetSessionRecovery(
      {
        maxDeferredRecoveryShutdowns: MAX_DEFERRED_RECOVERY_SHUTDOWNS,
        unconfirmedRecoveryShutdownCooldownMs: UNCONFIRMED_RECOVERY_SHUTDOWN_COOLDOWN_MS,
        getRecoveryRecord: (sessionId) => this.recoveringSessionLosses.get(sessionId),
        getPooledDevice: (deviceId) => this.devices.get(deviceId),
        isPreservedSessionCurrent: (session, deviceId) =>
          this.isPreservedSessionCurrent(session, deviceId),
        startAndroidRecoveryRecord: (sessionId, details, reservations, replace) =>
          this.startAndroidRecoveryRecord(sessionId, details, reservations, replace),
        rebootDisconnectedAndroidDevice: (device, incidentId, options) =>
          this.rebootDisconnectedAndroidDevice(device, incidentId, options),
        releaseDisconnectedRecoverySessionWithRetry: (sessionId, deviceId, reason) =>
          this.releaseDisconnectedRecoverySessionWithRetry(sessionId, deviceId, reason),
        refreshEmulatorLossRecoverySettlement: (incidentId, outcome) =>
          this.refreshEmulatorLossRecoverySettlement(incidentId, outcome),
        completeEmulatorLossRecovery: (incidentId, outcome) =>
          this.completeEmulatorLossRecovery(incidentId, outcome),
        settleEmulatorLossIncident: (incidentId) => this.settleEmulatorLossIncident(incidentId),
        finalizeReleasedRecoveryAfterAwait: (record, incidentId) =>
          this.recoveryCoordinator.finalizeReleasedRecoveryAfterAwait(record, incidentId),
        finalizeReleasedRecoveryAfterCleanupFailure: (record, incidentId, error) =>
          this.recoveryCoordinator.finalizeReleasedRecoveryAfterCleanupFailure(
            record,
            incidentId,
            error,
          ),
        markAndroidRecoveryReleaseFailure: (record) =>
          this.recoveryCoordinator.markAndroidRecoveryReleaseFailure(record),
        finalizeRecoveryRecord: (sessionId, record) =>
          this.recoveryCoordinator.finalizeRecoveryRecord(sessionId, record),
      },
      this.timer,
    );
  }

  private createAndroidRebootCoordinator(): AndroidRebootCoordinator {
    return new AndroidRebootCoordinator(
      {
        getDeviceManager: () => this.getDeviceManager(),
        getTimer: () => this.getTimer(),
        getRecoveryPolicy: () => this.getRecoveryPolicy(),
        completeEmulatorLossRecovery: (incidentId, outcome, releasedSessionState) =>
          this.completeEmulatorLossRecovery(incidentId, outcome, releasedSessionState),
        recordEmulatorLossRecoveryAttempt: (incidentId, attempt) =>
          this.recordEmulatorLossRecoveryAttempt(incidentId, attempt),
        setRecoveringAndroidImage: (avdName, image) =>
          this.recoveryCoordinator.setRecoveringAndroidImage(avdName, image),
        addRecoveringAndroidDeviceId: (deviceId) =>
          this.recoveryCoordinator.addRecoveringAndroidDeviceId(deviceId),
        setAndroidRecoveryHandoffOwner: (deviceId, owner) =>
          this.recoveryCoordinator.setAndroidRecoveryHandoffOwner(deviceId, owner),
        clearAndroidRecoveryHandoffOwnerIfCurrent: (deviceId, owner) =>
          this.recoveryCoordinator.clearAndroidRecoveryHandoffOwnerIfCurrent(deviceId, owner),
        finishAndroidRecoveryAttempt: (avdName, deviceIds, retainImage, owner, lateShutdown) =>
          this.recoveryCoordinator.finishAndroidRecoveryAttempt(
            avdName,
            deviceIds,
            retainImage,
            owner,
            lateShutdown,
          ),
        stopAndroidEmulatorForRecovery: (
          ...[
            device,
            avdName,
            retainLeaseUntil,
            allowActiveStop,
            owner,
            sessionId,
            session,
          ]: Parameters<AndroidRebootCoordinatorPoolPort["stopAndroidEmulatorForRecovery"]>
        ) =>
          this.stopAndroidEmulatorForRecovery({
            device,
            avdName,
            retainLeaseUntil,
            allowActiveStop,
            handoffOwner: owner,
            preservedSessionId: sessionId,
            preservedSession: session,
          }),
        rebindSameAvdReplacementSession: (
          ...[device, avdName, sessionId, session, autolockSessionId, image, owner]: Parameters<
            AndroidRebootCoordinatorPoolPort["rebindSameAvdReplacementSession"]
          >
        ) =>
          this.rebindSameAvdReplacementSession({
            device,
            avdName,
            preservedSessionId: sessionId,
            preservedSession: session,
            preservedAutolockSessionId: autolockSessionId,
            recoveryImage: image,
            handoffOwner: owner,
          }),
        detachSessionForAndroidRecovery: (device, sessionId, session) =>
          this.detachSessionForAndroidRecovery(device, sessionId, session),
        removeDevice: (deviceId, awaitCacheCleanup, expectedDevice) =>
          this.removeDevice(deviceId, awaitCacheCleanup, expectedDevice),
        addDevice: (device, image, awaitSessionTracking, evidence) =>
          this.addDevice(device, image, awaitSessionTracking, evidence),
        identityEvidenceForBootedDevice: (device) =>
          this.runtimeIdentity.identityEvidenceForBootedDevice(device),
        bindRecoveredAndroidDeviceSession: (
          ...[
            previousDeviceId,
            avdName,
            sessionId,
            session,
            ready,
            image,
            childProcess,
            autolockSessionId,
            owner,
          ]: Parameters<AndroidRebootCoordinatorPoolPort["bindRecoveredAndroidDeviceSession"]>
        ) =>
          this.bindRecoveredAndroidDeviceSession({
            previousDeviceId,
            avdName,
            preservedSessionId: sessionId,
            preservedSession: session,
            ready,
            recoveryImage: image,
            childProcess,
            preservedAutolockSessionId: autolockSessionId,
            handoffOwner: owner,
          }),
        stopEmulatorProcess: (childProcess, retainLeaseUntil) =>
          this.stopEmulatorProcess(childProcess, retainLeaseUntil),
        consumeAndroidRecoveryCancellation: (device, recoveryDeviceIds) =>
          this.consumeAndroidRecoveryCancellation(device, recoveryDeviceIds),
      },
      this.androidRecoveryRecordLedger,
      this.criteriaMatcher,
      this.androidDeviceReboot,
    );
  }

  private createAdbResetQuarantine(
    factory: DevicePoolDependencies["adbServerResetQuarantineFactory"],
  ): AdbServerResetQuarantine {
    return createAdbServerResetQuarantine(
      {
        getAssignmentMutex: () => this.assignmentMutex,
        getDevices: () => this.devices,
        getSessionManager: () => this.sessionManager,
        getStartedDeviceProcesses: () => this.startedDeviceProcesses,
        getAdbServerResetTrackedProcesses: () => this.adbServerResetTrackedProcesses,
        getAdbServerResetRecoveryReservations: () => this.adbServerResetRecoveryReservations,
        getAndroidStartupLeases: () => this.androidStartupLeases,
        getRecoveringAndroidImages: () => this.recoveringAndroidImages,
        getRecoveringAndroidDeviceIds: () => this.recoveringAndroidDeviceIds,
        getRecoveringSessionLosses: () => this.recoveringSessionLosses,
        getFailedTerminalRecoveryReleases: () => this.failedTerminalRecoveryReleases,
        getRecoveryCoordinator: () => this.recoveryCoordinator,
        getAfterAndroidStartupRecoverySnapshot: () => this.afterAndroidStartupRecoverySnapshot,
        getDevice: (id) => this.getDevice(id),
        isPreservedSessionCurrent: (session, deviceId) =>
          this.isPreservedSessionCurrent(session, deviceId),
        isAndroidEmulatorActiveRelaunchEligible: (device) =>
          this.isAndroidEmulatorActiveRelaunchEligible(device),
        removeDevice: (id, awaitCacheCleanup, expected) =>
          this.removeDevice(id, awaitCacheCleanup, expected),
        startAndroidRecoveryRecord: (sessionId, details, reservations, replace) =>
          this.startAndroidRecoveryRecord(sessionId, details, reservations, replace),
        recordEmulatorLossIncident: (id, path, exit, state) =>
          this.recordEmulatorLossIncident(id, path, exit, state),
        cancelDeviceExecutions: (id, reason) =>
          this.cancelDeviceSessionExecutions.cancelDeviceExecutions?.(id, reason) ??
          Promise.resolve(0),
        cancelDeviceSessionExecutions: (id, reason) =>
          this.cancelDeviceSessionExecutions(id, reason),
        completeEmulatorLossRecovery: (id, outcome) =>
          this.completeEmulatorLossRecovery(id, outcome),
        settleEmulatorLossIncident: (id) => this.settleEmulatorLossIncident(id),
        finishEmulatorLossIncident: (id, outcome) => this.finishEmulatorLossIncident(id, outcome),
        stopTrackedEmulatorProcess: (id) => this.stopTrackedEmulatorProcess(id),
      },
      factory,
    );
  }

  /**
   * Resolve the effective recovery policy once at construction. Extracted from the
   * constructor body so the injected-primitive parameters (timer, idGenerator, …)
   * do not push the constructor over the complexity gate.
   */
  private resolveRecoveryPolicy(recoveryPolicy?: DeviceRecoveryPolicy): DeviceRecoveryPolicy {
    return { ...(recoveryPolicy ?? getDeviceRecoveryPolicy()) };
  }

  private resolveDeviceSessionContinuity(override: boolean | undefined): boolean {
    if (override !== undefined) {
      return override;
    }
    return isDeviceSessionContinuityEnabled();
  }

  private startAndroidRecoveryRecord(
    sessionId: string,
    details: Omit<
      Partial<AndroidRecoveryRecord>,
      "sessionId" | "generation" | "state" | "reservations"
    >,
    reservations: readonly AndroidRecoveryReservationKind[],
    replace = false,
  ): AndroidRecoveryRecord {
    return this.recoveryCoordinator.startAndroidRecoveryRecord(
      sessionId,
      details,
      reservations,
      replace,
    );
  }

  private clearAdbResetRecoveryReservation(record: AndroidRecoveryRecord): void {
    this.adbServerResetQuarantine.clearAdbResetRecoveryReservation(record);
  }

  /**
   * Initialize pool with available devices
   *
   * Call this once after daemon starts to populate the device list.
   * Typically gets devices from --device-list or by querying emulator status.
   */
  async initializeWithDevices(devices: BootedDevice[]): Promise<void> {
    if (this.needsAndroidTransportNormalization(devices)) {
      devices = this.mapAndroidDiscovery(devices);
    }
    const now = this.seedLastUsedAt(this.timer.now());
    const perf = createGlobalPerformanceTracker();

    perf.startOperation("populatePool");
    for (const device of devices) {
      if (!this.androidTransportAliases.isAssignable(device)) {
        continue;
      }
      this.clearAutoStartSuppressionForBootedDevice(device);
      // Full: init/reinit replaces the pooled entry and allocates a new incarnation.
      this.notifyDeviceFramesInvalidated(device.deviceId);
      this.devices.set(device.deviceId, {
        id: device.deviceId,
        name: device.name,
        platform: device.platform,
        sessionId: null,
        status: "idle",
        lastUsedAt: now,
        assignmentCount: 0,
        errorCount: 0,
        iosVersion: device.iosVersion,
        simulatorType: this.criteriaMatcher.getBootedDeviceSimulatorType(device),
        ...(device.observedAt !== undefined ? { nameObservedAt: device.observedAt } : {}),
        incarnation: this.nextDeviceIncarnation(),
      });
      this.deviceSessionStarts.set(device.deviceId, now);
      await this.setDeviceSessionTracking(device.deviceId, now);
    }
    perf.endOperation("populatePool");

    logger.info(`Device pool initialized with ${devices.length} devices`);
  }

  /**
   * Refresh device pool by discovering connected devices
   *
   * Automatically called when pool is empty and a session requests a device.
   * This handles race conditions during daemon startup where device discovery
   * may not have completed before tests begin.
   *
   * Adds newly booted devices and prunes unassigned devices that are no longer
   * booted. Assigned devices are kept so active sessions can be cancelled and
   * released by the disconnect monitor.
   */
  refreshDevices(): Promise<number> {
    return this.refreshCoordinator.refreshDevices();
  }

  refreshDevicesWithOutcome(): Promise<DevicePoolRefreshResult> {
    return this.refreshDevicesInternal(false);
  }

  /** @internal Test support for checking removal-stamp retention. */
  getDeviceRemovalStampCountForTest(): number {
    return this.refreshCoordinator.getDeviceRemovalStampCountForTest();
  }

  private refreshDevicesInternal(assignmentLockHeld: boolean): Promise<DevicePoolRefreshResult> {
    return this.refreshCoordinator.refreshDevicesInternal(assignmentLockHeld);
  }

  /** Notify consumers that a device has reached a boot-ready connection boundary. */
  notifyDeviceReady(deviceId: string): void {
    try {
      this.onDeviceReady?.(deviceId);
    } catch (error) {
      logger.warn(`[DevicePool] Device-ready listener failed for ${deviceId}: ${error}`);
    }
  }

  private notifyDeviceFramesInvalidated(deviceId: string): void {
    try {
      this.onDeviceFramesInvalidated?.(deviceId);
    } catch (error) {
      logger.warn(
        `[DevicePool] Frame invalidation listener failed for ${deviceId}: ${error}`,
        error,
      );
    }
  }

  /** Notify consumers that a device has been removed from the pool. */
  private notifyDeviceRemoved(deviceId: string, platform: "android" | "ios"): void {
    try {
      this.onDeviceRemoved?.(deviceId, platform);
    } catch (error) {
      // Mirror the ready-listener contract: observers cannot roll back a removal
      // after the pool has deleted the device, so keep mandatory cleanup running.
      logger.warn(`[DevicePool] Device-removed listener failed for ${deviceId}: ${error}`);
    }
  }

  /**
   * Add a new device to the pool
   */
  async addDevice(
    device: BootedDevice,
    sourceImage?: DeviceInfo,
    awaitSessionTracking: boolean = true,
    identityEvidence: IdentityEvidence = neutralIdentityEvidence(device),
  ): Promise<void> {
    device = this.mapAndroidDiscovery([device])[0];
    if (!this.androidTransportAliases.isAssignable(device)) {
      throw new ActionableError(
        `Android transport '${device.deviceId}' has no proven identity. Refresh devices after reconnecting it.`,
      );
    }
    this.clearAutoStartSuppressionForBootedDevice(device, sourceImage);
    if (sourceImage) {
      this.intentionalShutdowns.delete(device.deviceId);
    }
    const existing = this.devices.get(device.deviceId);
    if (existing) {
      this.recordSourceAndroidAvd(device.deviceId, sourceImage);
      // A successful (re)boot of an errored, idle device clears its failure state so
      // criteria autoboot can hand it out instead of failing with "no devices match".
      if (existing.status === "error" && !existing.sessionId) {
        existing.status = "idle";
        existing.errorCount = 0;
        existing.iosVersion = device.iosVersion ?? existing.iosVersion;
        existing.simulatorType =
          this.criteriaMatcher.getBootedDeviceSimulatorType(device) ?? existing.simulatorType;
        existing.lastUsedAt = this.seedLastUsedAt(this.timer.now());
        logger.info(`Recovered errored device ${device.deviceId} after successful boot`);
      } else {
        logger.warn(`Device ${device.deviceId} already in pool`);
      }
    } else {
      const now = this.seedLastUsedAt(this.timer.now());
      this.devices.set(device.deviceId, {
        id: device.deviceId,
        name: device.name,
        platform: device.platform,
        sessionId: null,
        status: "idle",
        lastUsedAt: now,
        assignmentCount: 0,
        errorCount: 0,
        iosVersion: device.iosVersion,
        simulatorType: this.criteriaMatcher.getBootedDeviceSimulatorType(device),
        ...(device.observedAt !== undefined ? { nameObservedAt: device.observedAt } : {}),
        ...identityEvidenceFields(identityEvidence),
        incarnation: this.nextDeviceIncarnation(),
      });
      this.recordSourceAndroidAvd(device.deviceId, sourceImage);
      this.deviceSessionStarts.set(device.deviceId, now);
      this.refreshMissingDeviceMisses.delete(device.deviceId);
      const sessionTracking = this.setDeviceSessionTracking(device.deviceId, now);
      if (awaitSessionTracking) {
        await sessionTracking;
      } else {
        // Shutdown replacement already owns assignmentMutex. Persisting cache
        // metadata is best-effort and must not make allocators wait forever.
        void sessionTracking;
      }

      logger.info(`Added device ${device.deviceId} to pool`);
    }

    this.notifyDeviceReady(device.deviceId);
  }

  private recordSourceAndroidAvd(deviceId: string, sourceImage?: DeviceInfo): void {
    const device = this.devices.get(deviceId);
    if (device?.platform === "android" && sourceImage?.platform === "android") {
      device.avdName = sourceImage.name;
      device.androidImage = sourceImage;
    }
  }

  /**
   * Replace a pooled connection whose stable serial now identifies a different
   * runtime.
   *
   * Callers reach here when {@link matchesRuntimeIdentity} rejects discovery.
   * An unverified pooled placeholder can also cause that rejection, so clearing
   * serial-scoped guest state additionally requires resolved identity evidence
   * after the captured entry has been retired.
   */
  private async replacePooledDeviceForRuntimeIdentity(
    pooledDevice: PooledDevice,
    bootedDevice: BootedDevice,
  ): Promise<boolean> {
    const capturedEntryStillPooled = this.devices.get(pooledDevice.id) === pooledDevice;
    this.runtimeIdentity.beginPendingReplacement(bootedDevice);
    try {
      await this.evictMissingPooledDevice(
        pooledDevice,
        `runtime identity changed to ${bootedDevice.platform}:${bootedDevice.name}`,
        { identityObservation: bootedDevice },
      );
      const replacement = this.runtimeIdentity.getPendingReplacement(bootedDevice.deviceId);
      if (!replacement || this.devices.has(replacement.deviceId)) {
        return false;
      }
      const replacementEvidence = this.runtimeIdentity.identityEvidenceForBootedDevice(replacement);
      const pendingUnresolvedEvidence = this.runtimeIdentity.getPendingUnresolvedEvidence(
        replacement.deviceId,
      );
      const identityEvidence =
        pendingUnresolvedEvidence &&
        ["newer", "unresolved-newer"].includes(
          compareIdentityEvidence(replacementEvidence, pendingUnresolvedEvidence),
        )
          ? pendingUnresolvedEvidence
          : replacementEvidence;
      // Eviction must have retired the captured entry, with no successor already
      // published. Placeholder names assert no identity unless the pool knows its AVD.
      if (
        capturedEntryStillPooled &&
        pooledDevice.id === replacement.deviceId &&
        !identityEvidence.unresolved &&
        !this.runtimeIdentity.matchesRuntimeIdentity(pooledDevice, replacement) &&
        this.runtimeIdentity.comparePooledIdentityEvidence(pooledDevice, replacement) !== "stale" &&
        !this.runtimeIdentity.hasUnresolvedEmulatorName({
          deviceId: pooledDevice.id,
          platform: pooledDevice.platform,
          name: pooledDevice.avdName ?? pooledDevice.name,
        })
      ) {
        notifyDeviceIdentityReplaced(pooledDevice.id);
      }
      await this.addDevice(replacement, undefined, true, identityEvidence);
      return true;
    } finally {
      this.runtimeIdentity.clearPendingReplacement(bootedDevice.deviceId);
    }
  }

  /**
   * Remove device from pool
   */
  async removeDevice(
    deviceId: string,
    awaitCacheCleanup: boolean = true,
    expectedDevice?: PooledDevice,
  ): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }
    if (expectedDevice && device !== expectedDevice) {
      logger.debug(`Ignoring stale removal for replacement device ${deviceId}`);
      return;
    }

    if (device.sessionId) {
      logger.warn(`Cannot remove device ${deviceId}: assigned to session ${device.sessionId}`);
      return;
    }

    this.devices.delete(deviceId);
    if (device.platform === "android" && this.androidTransportAliases.retire(deviceId)) {
      this.androidAliasRetirement++;
    }
    this.deviceHealthMarkers.clear(deviceId);
    // Full: removal retires this runtime; onDeviceRemoved prunes stream state after registry retirement.
    this.notifyDeviceFramesInvalidated(deviceId);
    this.sessionManager.retireClockRestoration(deviceId);
    this.sessionManager.retireRotationRestoration(deviceId);
    this.sessionManager.retireScreenReaderRestoration(deviceId);
    displayTransitions.reset(deviceId);
    getObserveCacheStore().clear(deviceId);
    this.refreshCoordinator.recordDeviceRemoval(deviceId);
    this.settledLateShutdowns.delete(deviceId);
    this.deferredDeviceReleases.delete(deviceId);
    this.notifyDeviceRemoved(deviceId, device.platform);
    this.deviceSessionStarts.delete(deviceId);
    this.refreshMissingDeviceMisses.delete(deviceId);
    this.startedDeviceProcesses.delete(deviceId);
    this.startedDeviceProcessOutput.delete(deviceId);
    if (this.lastReleasedDeviceId === deviceId) {
      this.lastReleasedDeviceId = null;
    }
    const cacheCleanup = this.clearDeviceSessionCache(deviceId);
    if (awaitCacheCleanup) {
      await cacheCleanup;
    } else {
      void cacheCleanup.catch((error) => {
        logger.warn(`[DevicePool] Deferred cache cleanup failed for ${deviceId}: ${error}`, error);
      });
    }
    logger.info(`Removed device ${deviceId} from pool and cleared cached data`);
  }

  /**
   * A verified AVD deletion retires the name's crash-loop history. Ordinary
   * pool removal and re-add keep it, because they can refer to the same AVD.
   */
  clearAndroidRebootBudgetForDeletedAvd(target: Pick<DeviceInfo, "platform" | "name">): void {
    if (target.platform === "android") {
      this.androidDeviceReboot.clear(target);
    }
  }

  removeDisconnectedDevice(
    deviceId: string,
    mayBeStaleSignal: boolean = true,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<void> {
    return this.disconnectHandler.removeDisconnectedDevice(
      deviceId,
      mayBeStaleSignal,
      incidentId,
      expectedDevice,
    );
  }

  /**
   * Opens a durable postmortem record without allowing diagnostics persistence
   * failure to block the critical device-loss cleanup path.
   */
  async recordEmulatorLossIncident(
    deviceId: string,
    detectionPath: EmulatorLossDetectionPath,
    processExit?: { code: number | null; signal: NodeJS.Signals | null },
    lastAdbState?: string,
  ): Promise<string | undefined> {
    return this.emulatorLossLedger.recordEmulatorLossIncident(
      deviceId,
      detectionPath,
      processExit,
      lastAdbState,
    );
  }

  private getDeviceManager(): PlatformDeviceManager {
    return this.deviceManager;
  }

  private getTimer(): Timer {
    return this.timer;
  }

  private async recordEmulatorLossRecoveryAttempt(
    incidentId: string | undefined,
    attempt: { attempt: number; outcome: "failed" | "succeeded" },
  ): Promise<void> {
    return this.emulatorLossLedger.recordEmulatorLossRecoveryAttempt(incidentId, attempt);
  }

  private async completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): Promise<void> {
    return this.emulatorLossLedger.completeEmulatorLossRecovery(
      incidentId,
      outcome,
      releasedSessionState,
    );
  }

  private buildEmulatorLossRecoverySettlement(
    incident: EmulatorLossIncident | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): EmulatorLossRecoverySettlement {
    return this.emulatorLossLedger.buildEmulatorLossRecoverySettlement(
      incident,
      outcome,
      releasedSessionState,
    );
  }

  async waitForEmulatorLossIncident(
    incidentId: string,
    timeoutMs?: number,
  ): Promise<Awaited<ReturnType<EmulatorLossIncidentStore["get"]>>> {
    return this.emulatorLossLedger.waitForEmulatorLossIncident(incidentId, timeoutMs);
  }

  private settleEmulatorLossIncident(incidentId: string | undefined): void {
    this.emulatorLossLedger.settleEmulatorLossIncident(incidentId);
  }

  async finishEmulatorLossIncident(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
  ): Promise<void> {
    return this.emulatorLossLedger.finishEmulatorLossIncident(incidentId, outcome);
  }

  isCurrentDisconnectedDevice(device: PooledDevice): Promise<CurrentDisconnectStatus> {
    return this.disconnectHandler.isCurrentDisconnectedDevice(device);
  }

  /** Assign the next monotonic incarnation id for a newly pooled connection. */
  private nextDeviceIncarnation(): number {
    return ++this.deviceIncarnationCounter;
  }

  markIntentionalShutdown(deviceId: string): void {
    const resetReservation = Array.from(this.adbServerResetRecoveryReservations.values()).find(
      (reservation) => reservation.deviceId === deviceId,
    );
    if (resetReservation) {
      // Resolve reset-cohort ownership before consulting the current serial. A
      // prior recovery may already have reused this serial for a different AVD.
      resetReservation.cancelled = true;
      return;
    }
    const device = this.devices.get(deviceId);
    if (device) {
      // Tie the marker to the incarnation present now, so a later same-serial
      // replacement is not treated as intentionally stopped.
      this.intentionalShutdowns.set(deviceId, device.incarnation);
      this.settledLateShutdowns.delete(deviceId);
      return;
    }
    if (this.recoveringAndroidDeviceIds.has(deviceId)) {
      // No pooled device yet (an in-flight recovery owns the serial); the mark
      // applies to whatever incarnation the recovery produces.
      this.intentionalShutdowns.set(deviceId, INCARNATION_ANY);
    }
  }

  clearIntentionalShutdown(deviceId: string): void {
    this.intentionalShutdowns.delete(deviceId);
    this.settledLateShutdowns.delete(deviceId);
  }

  /** Permit a later fresh booted observation to lift a timed-out kill's fence. */
  noteLatePlatformShutdownSettled(expectedDevice: PooledDevice): void {
    if (
      this.devices.get(expectedDevice.id) !== expectedDevice ||
      this.intentionalShutdowns.get(expectedDevice.id) !== expectedDevice.incarnation
    ) {
      return;
    }
    this.settledLateShutdowns.set(expectedDevice.id, {
      incarnation: expectedDevice.incarnation,
      refreshGeneration: this.refreshCoordinator.getRefreshGeneration(),
    });
  }

  /**
   * Assign multiple devices to sessions upfront with a shared timeout
   *
   * This is used for multi-device plans where we want to allocate all devices
   * before execution begins, ensuring we fail fast if not enough devices are available.
   *
   * @param sessionIds Array of session IDs to assign devices to
   * @param timeoutMs Total timeout in milliseconds for allocating ALL devices (default: 5 minutes)
   * @returns Map of sessionId -> deviceId for all assigned devices
   * @throws ActionableError if unable to allocate all devices within timeout
   */
  async assignMultipleDevices(
    sessionIds: string[],
    timeoutMs: number = 300000,
    platform?: Platform,
  ): Promise<Map<string, string>> {
    const ticket = {
      requests: sessionIds.map((sessionId) => ({ sessionId, criteria: { platform } })),
    };
    try {
      const startTime = this.timer.now();
      const assignments = new Map<string, string>();
      const assignmentsToRollback = new Map<string, RollbackAssignment>();
      const requiredCount = sessionIds.length;

      logger.info(
        `[DevicePool] Starting upfront allocation of ${requiredCount} devices ` +
          `(timeout: ${timeoutMs / 1000}s)`,
      );

      // Validate we have enough devices
      let refreshFailure = await this.ensurePoolRefreshed();
      const preallocationCandidates = this.getDevicesByPlatform(platform);
      await this.pruneStaleIdleIosDevices(preallocationCandidates);
      await this.evictUnavailableIdleDevicesMatching(
        (device) => !platform || device.platform === platform,
      );
      let stats = this.getStatsForPlatform(platform);

      if (stats.total < requiredCount) {
        const started = await this.startAdditionalDevices(
          requiredCount - stats.total,
          startTime + timeoutMs,
          platform,
        );
        if (started > 0) {
          refreshFailure = (await this.refreshDevicesWithOutcome()).failure;
          stats = this.getStatsForPlatform(platform);
        } else if (platform === "android") {
          // A queued start may have joined a boot without launching a device.
          stats = this.getStatsForPlatform(platform);
        }
      }

      this.assertMultiDeviceCapacity(stats, requiredCount, platform, refreshFailure);

      this.multiDeviceAllocationQueue.push(ticket);
      // Queue waits consume deadline time, but never allocation attempts.
      const assigned = new Set<string>();
      let firstWaitLogged = false;

      const allocate = () =>
        this.executeMultiDeviceAllocation(
          ticket,
          startTime + timeoutMs,
          (failure) => {
            refreshFailure = failure;
          },
          async () => {
            throwIfRequestAborted();
            // Try to assign all remaining sessions
            while (assigned.size < requiredCount) {
              const sessionId = sessionIds[assigned.size];

              if (this.recordHeldAssignment(ticket.requests[assigned.size], assignments)) {
                assigned.add(sessionId);
                continue;
              }

              const assignResult = await this.tryAssignDevice(sessionId, platform);
              if (assignResult.refreshCompleted) {
                refreshFailure = assignResult.refreshFailure;
              }

              if (assignResult.success) {
                assigned.add(sessionId);
                assignments.set(sessionId, assignResult.deviceId!);
                if (assignResult.session) {
                  assignmentsToRollback.set(sessionId, {
                    deviceId: assignResult.deviceId!,
                    session: assignResult.session,
                  });
                }
                logger.info(
                  `[DevicePool] Allocated device ${assignResult.deviceId} to session ${sessionId} (${assigned.size}/${requiredCount})`,
                );
              } else if (assignResult.livenessUnknown) {
                throw new DevicePoolError(
                  `Unable to verify iOS simulator liveness for session ${sessionId}; iOS discovery failed.`,
                  false,
                );
              } else if (!assignResult.shouldWait) {
                // No devices at all - non-retryable error
                const currentStats = this.getStatsForPlatform(platform);
                throw new DevicePoolError(
                  `Failed to allocate devices: no devices available.\n` +
                    `Required: ${requiredCount} devices, allocated: ${assigned.size}\n` +
                    `Device pool status:\n` +
                    `  Total devices: ${currentStats.total}\n` +
                    `  Idle: ${currentStats.idle}\n` +
                    `  Assigned: ${currentStats.assigned}\n` +
                    `  Error: ${currentStats.error}\n\n` +
                    `Suggestions:\n` +
                    `  - Start an emulator or simulator\n` +
                    `  - Check device pool status: auto-mobile --cli listDevices\n` +
                    `  - Verify device tooling is working for the selected platform`,
                  false,
                );
              } else {
                // Devices busy - throw retryable error to wait
                if (!firstWaitLogged) {
                  firstWaitLogged = true;
                  logger.info(
                    `[DevicePool] Waiting for ${requiredCount - assigned.size} more device(s) (${assignResult.totalDevices} total, all currently busy)...`,
                  );
                }
                await this.rollbackAssignments(assignmentsToRollback);
                assignmentsToRollback.clear();
                assignments.clear();
                assigned.clear();
                throw new DevicePoolError("All devices busy", true, refreshFailure);
              }
            }

            // All devices assigned successfully
            return assignments;
          },
        );

      let result: Awaited<ReturnType<typeof allocate>>;
      try {
        result = await allocate();
      } catch (error) {
        await this.rollbackAssignments(assignmentsToRollback);
        throw error;
      }

      if (!result.success) {
        await this.rollbackAssignments(assignmentsToRollback);
        throwIfRequestAborted();

        // Timeout case
        const elapsed = this.timer.now() - startTime;
        const currentStats = this.getStatsForPlatform(platform);
        throw new ActionableError(
          `Timed out allocating devices after ${Math.round(elapsed / 1000)}s ` +
            `(${describeMultiDeviceAllocationAttempts(result)}).\n` +
            refreshFailureContext(refreshFailure) +
            `Required: ${requiredCount} devices\n` +
            `Device pool status:\n` +
            `  Total devices: ${currentStats.total}\n` +
            `  Idle: ${currentStats.idle}\n` +
            `  Assigned: ${currentStats.assigned}\n` +
            `  Error: ${currentStats.error}\n\n` +
            `Suggestions:\n` +
            `  - Reduce parallel test count to match available devices\n` +
            `  - Start additional emulators or connect more physical devices\n` +
            `  - Increase device allocation timeout\n` +
            `  - Check if tests are properly releasing devices after completion`,
        );
      }

      const totalElapsed = this.timer.now() - startTime;
      logger.info(
        `[DevicePool] Successfully allocated ${requiredCount} devices ` +
          `in ${totalElapsed}ms (${result.attempts} attempts)`,
      );

      return result.value!;
    } finally {
      this.removeMultiDeviceAllocationTicket(ticket);
    }
  }

  /**
   * Assign multiple devices with per-session criteria.
   *
   * This is used when plans specify device definitions (platform/type/version).
   * When no booted device matches a request, a matching shutdown image may be
   * started before allocation.
   */
  async assignMultipleDevicesByCriteria(
    requests: DeviceAllocationRequest[],
    timeoutMs: number = 300000,
  ): Promise<Map<string, string>> {
    const ticket = { requests };
    try {
      const startTime = this.timer.now();
      const assignments = new Map<string, string>();
      const assignmentsToRollback = new Map<string, RollbackAssignment>();
      const requiredCount = requests.length;

      if (requiredCount === 0) {
        return assignments;
      }

      logger.info(
        `[DevicePool] Starting criteria-based allocation of ${requiredCount} devices ` +
          `(timeout: ${timeoutMs / 1000}s)`,
      );

      let refreshFailure = await this.ensurePoolRefreshed();
      const sortedRequests = this.criteriaMatcher.sortBySpecificity(requests);
      await this.pruneStaleIdleIosDevices(this.getDevicesMatchingAnyRequest(sortedRequests));
      await this.evictUnavailableIdleDevicesMatching((device) =>
        sortedRequests.some(
          (request) => this.criteriaMatcher.filterDevices([device], request.criteria).length > 0,
        ),
      );

      let needsRefresh = false;
      for (const request of sortedRequests) {
        const candidates = this.getDevicesMatchingCriteria(request.criteria);
        if (candidates.length === 0) {
          needsRefresh = true;
          break;
        }
      }

      if (needsRefresh) {
        refreshFailure = (await this.refreshDevicesWithOutcome()).failure;
      }

      const started = await this.startAdditionalDevicesForCriteria(
        sortedRequests,
        startTime + timeoutMs,
      );
      if (started > 0) {
        logger.info(
          `[DevicePool] Started ${started} additional device(s) for criteria-based allocation`,
        );
      }

      for (const request of requests) {
        const candidates = this.getDevicesMatchingCriteria(request.criteria);
        if (
          this.isCriteriaUnavailableWithoutPendingRecovery(candidates.length > 0, request.criteria)
        ) {
          const summary = this.criteriaMatcher.formatCriteriaSummary(request.criteria);
          throw new ActionableError(
            `No devices match criteria for session ${request.sessionId}${summary}.\n` +
              refreshFailureContext(refreshFailure) +
              `Ensure the required devices are installed, startable, and available.`,
          );
        }
      }

      // There is no configured pool maximum. A short current inventory may
      // grow through another flow, so preserve waiting for additional devices.
      this.multiDeviceAllocationQueue.push(ticket);

      let attemptCount = 0;
      let allocationCompleted = false;
      try {
        const result = await this.executeMultiDeviceAllocation(
          ticket,
          startTime + timeoutMs,
          (failure) => {
            refreshFailure = failure;
          },
          async () => {
            for (const request of sortedRequests) {
              if (assignments.has(request.sessionId)) {
                continue;
              }
              if (this.recordHeldAssignment(request, assignments)) {
                continue;
              }

              const result = await this.tryAssignDeviceWithCriteria(
                request.sessionId,
                request.criteria,
              );
              if (result.refreshCompleted) {
                refreshFailure = result.refreshFailure;
              }

              if (result.success) {
                this.recordCriteriaAssignment(request, result, assignments, assignmentsToRollback);
                logger.info(
                  `[DevicePool] Allocated device ${result.deviceId} to session ${request.sessionId} ` +
                    `(${assignments.size}/${requiredCount})`,
                );
              } else if (result.livenessUnknown) {
                throw new ActionableError(
                  `Unable to verify iOS simulator liveness for session ${request.sessionId}; iOS discovery failed.`,
                );
              } else if (!result.shouldWait) {
                const summary = this.criteriaMatcher.formatCriteriaSummary(request.criteria);
                throw new ActionableError(
                  `Failed to allocate device for session ${request.sessionId}${summary}.\n` +
                    `No matching devices are currently available.\n` +
                    `Suggestions:\n` +
                    `  - Boot a simulator or emulator that matches the requested criteria\n` +
                    `  - Wait for a device to become idle\n` +
                    `  - Reduce parallel test count to match available devices`,
                );
              }
            }

            if (assignments.size < requiredCount) {
              // Never retain new claims while waiting; existing sessions survive.
              await this.rollbackAssignments(assignmentsToRollback);
              assignmentsToRollback.clear();
              assignments.clear();
              throw new DevicePoolError("All devices busy", true, refreshFailure);
            }
            return assignments;
          },
        );
        attemptCount = result.attempts;
        if (!result.success) {
          const elapsed = this.timer.now() - startTime;
          throw new ActionableError(
            `Timed out allocating devices after ${Math.round(elapsed / 1000)}s ` +
              `(${describeMultiDeviceAllocationAttempts(result)}).\n` +
              refreshFailureContext(refreshFailure) +
              `Required: ${requiredCount} devices\n` +
              `Suggestions:\n` +
              `  - Boot additional simulators or emulators that match the plan requirements\n` +
              `  - Reduce the number of devices required in the test plan\n` +
              `  - Increase device allocation timeout`,
          );
        }
        allocationCompleted = true;
      } finally {
        if (!allocationCompleted) {
          await this.rollbackCriteriaAssignments(assignmentsToRollback);
        }
      }

      const totalElapsed = this.timer.now() - startTime;
      logger.info(
        `[DevicePool] Successfully allocated ${requiredCount} devices by criteria ` +
          `in ${totalElapsed}ms (${attemptCount} attempts)`,
      );

      return assignments;
    } finally {
      this.removeMultiDeviceAllocationTicket(ticket);
    }
  }

  /**
   * The device an existing session already owns in this pool, if any. Such a
   * session takes no new claim, so a multi-device request counts that device
   * toward its total instead of waiting for an idle device it will not use.
   */
  private deviceHeldByExistingSession(sessionId: string): PooledDevice | undefined {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const device = this.devices.get(session.assignedDevice);
    return device?.sessionId === sessionId ? device : undefined;
  }

  /**
   * Why a session's held device cannot serve a request: the same platform,
   * criteria and health rules an idle candidate must meet. Undefined when it can.
   */
  private heldDeviceDisqualification(
    request: DeviceAllocationRequest,
    device: PooledDevice,
  ): string | undefined {
    if (this.criteriaMatcher.filterDevices([device], request.criteria).length === 0) {
      return (
        `it does not match the requested criteria` +
        `${this.criteriaMatcher.formatCriteriaSummary(request.criteria)}`
      );
    }
    if (device.status === "error") {
      return "the device is in an error state";
    }
    const marker = this.getDeviceHealthMarker(device.id);
    return marker ? `the device is unhealthy (${marker.reason}, since ${marker.since})` : undefined;
  }

  /**
   * Records the device an existing session (e.g. an executePlan base session)
   * already holds (#10153). It needs no idle device and is never rolled back.
   * A held device that cannot serve the request fails the allocation: the
   * session keeps its device rather than silently moving to another one.
   */
  private recordHeldAssignment(
    request: DeviceAllocationRequest,
    assignments: Map<string, string>,
  ): boolean {
    const held = this.deviceHeldByExistingSession(request.sessionId);
    if (!held) {
      return false;
    }
    const disqualification = this.heldDeviceDisqualification(request, held);
    if (disqualification) {
      throw new ActionableError(
        `Session '${request.sessionId}' already holds device '${held.id}', but ${disqualification}.\n` +
          `A device label mapped to an existing session must use that session's device.\n` +
          `Suggestions:\n` +
          `  - Release the session or select a device that matches the plan's device requirements\n` +
          `  - Recover or replace the device (killDevice/startDevice) and retry`,
      );
    }
    assignments.set(request.sessionId, held.id);
    return true;
  }

  private multiDeviceAllocationBlock(
    ticket: (typeof this.multiDeviceAllocationQueue)[number],
  ): MultiDeviceAllocationBlock {
    return this.isQueuedBehindConflictingRequest(ticket) ? "queued" : "busy";
  }

  private isQueuedBehindConflictingRequest(
    ticket: (typeof this.multiDeviceAllocationQueue)[number],
  ): boolean {
    const earlier = this.multiDeviceAllocationQueue.slice(
      0,
      this.multiDeviceAllocationQueue.indexOf(ticket),
    );
    // Comparing live candidate IDs alone misses devices joining later. Use a
    // conservative platform-disjoint rule across both APIs, including wildcards.
    return earlier.some((waiter) =>
      waiter.requests.some((prior) =>
        ticket.requests.some(
          (request) =>
            !prior.criteria?.platform ||
            !request.criteria?.platform ||
            prior.criteria.platform === request.criteria.platform,
        ),
      ),
    );
  }

  private canClaimMultiDeviceAllocation(
    ticket: (typeof this.multiDeviceAllocationQueue)[number],
  ): boolean {
    // Sessions that already hold a pooled device need no new claim and must
    // survive rollback; anything else (including a session whose device left
    // the pool) counts as a claim, matching recordHeldAssignment.
    const claims: DeviceAllocationRequest[] = [];
    for (const request of ticket.requests) {
      const held = this.deviceHeldByExistingSession(request.sessionId);
      if (!held) {
        claims.push(request);
      } else if (this.heldDeviceDisqualification(request, held)) {
        // Let the attempt fail fast with the reason instead of waiting.
        return true;
      }
    }
    // A ticket that claims nothing cannot take a device from an earlier waiter,
    // so it is exempt from the queue (#10153).
    if (claims.length === 0) {
      return true;
    }
    if (this.isQueuedBehindConflictingRequest(ticket)) {
      return false;
    }
    const available = new Set<string>();
    let canClaim = true;
    for (const request of this.criteriaMatcher.sortBySpecificity(claims)) {
      const candidates = this.getDevicesMatchingCriteria(request.criteria);
      const device = candidates.find(
        (candidate) => this.isIdleDeviceEligible(candidate) && !available.has(candidate.id),
      );
      if (!device) {
        const idle = this.selectIdleDevice(candidates);
        // Healthy idle capacity already counted for another request may grow
        // later; it is neither a health failure nor a reason to claim partially.
        this.assertHealthyAllocationPossible(candidates, idle);
        if (
          !idle &&
          !this.shouldWaitForDevice(
            this.countBusyDevices(candidates),
            this.hasPendingAndroidRecoveryMatching(request.criteria),
          )
        ) {
          // Let the real attempt refresh once and report authoritative absence
          // (or recover an errored entry), as single-attempt allocation does.
          return true;
        }
        canClaim = false;
        continue;
      }
      available.add(device.id);
    }
    return canClaim;
  }

  private async executeMultiDeviceAllocation<T>(
    ticket: (typeof this.multiDeviceAllocationQueue)[number],
    deadlineMs: number,
    setRefreshFailure: (failure: string | undefined) => void,
    allocate: () => Promise<T>,
  ): Promise<MultiDeviceAllocationOutcome<T>> {
    let attempts = 0;
    let waited = false;
    let lastBlock: MultiDeviceAllocationBlock | undefined;
    while (true) {
      if (waited) {
        await this.waitForMultiDeviceRetry(deadlineMs);
        const refreshed = await this.refreshMultiDeviceInventory(ticket);
        if (refreshed) {
          setRefreshFailure(refreshed.failure);
        }
      }
      throwIfRequestAborted();
      if (this.timer.now() >= deadlineMs && waited) {
        return { success: false, attempts, lastBlock };
      }
      waited = true;
      if (!this.canClaimMultiDeviceAllocation(ticket)) {
        lastBlock = this.multiDeviceAllocationBlock(ticket);
        if (this.timer.now() >= deadlineMs) {
          return { success: false, attempts, lastBlock };
        }
        continue;
      }
      attempts++;
      lastBlock = "contention";
      try {
        return { success: true, value: await allocate(), attempts };
      } catch (error) {
        if (!(error instanceof DevicePoolError) || !error.isRetryable) {
          throw error instanceof DevicePoolError ? new ActionableError(error.message) : error;
        }
        // Contention is expected; allocate released this round's new claims.
        logger.debug("Multi-device allocation will retry after contention", error);
      }
    }
  }

  private async refreshMultiDeviceInventory(
    ticket: (typeof this.multiDeviceAllocationQueue)[number],
  ): Promise<DevicePoolRefreshResult | undefined> {
    // Busy-only rounds must retain the last actual discovery failure. Refresh
    // only for missing capacity; releases already publish availability directly.
    const candidates = this.getDevicesMatchingAnyRequest(ticket.requests);
    if (
      candidates.length < ticket.requests.length ||
      ticket.requests.some(
        (request) => this.getDevicesMatchingCriteria(request.criteria).length === 0,
      )
    ) {
      return this.refreshDevicesWithOutcome();
    }
    return undefined;
  }

  private async waitForMultiDeviceRetry(deadlineMs: number): Promise<void> {
    const delay = Math.min(this.DEVICE_WAIT_INTERVAL_MS, deadlineMs - this.timer.now());
    if (delay <= 0) {
      return;
    }
    let handle: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            wake = resolve;
            this.multiDeviceAllocationWaiters.add(resolve);
            handle = this.timer.setTimeout(resolve, delay);
          }),
        { timer: this.timer, signal: getAbortSignal(), label: "Multi-device allocation wait" },
      );
    } finally {
      if (wake) {
        this.multiDeviceAllocationWaiters.delete(wake);
      }
      if (handle !== undefined) {
        this.timer.clearTimeout(handle);
      }
    }
  }

  private notifyMultiDeviceAllocationWaiters(): void {
    for (const wake of this.multiDeviceAllocationWaiters) {
      wake();
    }
  }

  private assertMultiDeviceCapacity(
    stats: ReturnType<DevicePool["getStatsForPlatform"]>,
    requiredCount: number,
    platform: Platform | undefined,
    refreshFailure: string | undefined,
  ): void {
    if (
      !this.criteriaMatcher.hasSufficientCapacityIncludingAndroidRecovery(
        stats.total,
        requiredCount,
        this.recoveringAndroidImages.size,
        platform,
      )
    ) {
      throw new ActionableError(
        `Not enough devices in pool: need ${requiredCount}, have ${stats.total}.\n` +
          refreshFailureContext(refreshFailure) +
          `Device pool status:\n` +
          `  Total devices: ${stats.total}\n` +
          `  Idle: ${stats.idle}\n` +
          `  Assigned: ${stats.assigned}\n` +
          `  Error: ${stats.error}\n\n` +
          `Suggestions:\n` +
          `  - Start ${requiredCount - stats.total} more emulator(s) or simulators\n` +
          `  - Reduce the number of devices required in the test plan\n` +
          `  - Verify ADB is working: adb devices`,
      );
    }
  }

  private removeMultiDeviceAllocationTicket(
    ticket: (typeof this.multiDeviceAllocationQueue)[number],
  ): void {
    const index = this.multiDeviceAllocationQueue.indexOf(ticket);
    if (index >= 0) {
      this.multiDeviceAllocationQueue.splice(index, 1);
      this.notifyMultiDeviceAllocationWaiters();
    }
  }

  private async rollbackCriteriaAssignments(
    assignments: ReadonlyMap<string, RollbackAssignment>,
  ): Promise<void> {
    for (const [sessionId, allocation] of assignments) {
      try {
        await this.rollbackAssignments(new Map([[sessionId, allocation]]));
      } catch (error) {
        logger.warn(
          `[DevicePool] Failed to roll back criteria allocation for ${sessionId} on ${allocation.deviceId}`,
          error,
        );
      }
    }
  }

  private async startAdditionalDevices(
    requiredCount: number,
    deadlineMs: number,
    platform?: Platform,
  ): Promise<number> {
    if (!platform || requiredCount <= 0) {
      return 0;
    }

    try {
      const candidates = await this.getStartableDeviceImageCandidates(platform);
      if (candidates.length === 0) {
        return 0;
      }

      const toStart = candidates.slice(0, requiredCount);
      let started = 0;

      for (const device of toStart) {
        const label = device.deviceId ?? device.name;
        logger.info(`[DevicePool] Starting additional ${device.platform} device ${label}`);
        const remainingTimeoutMs = this.remainingStartDeadline(deadlineMs);
        if (remainingTimeoutMs <= 0) {
          break;
        }
        const startResult = await this.runCoordinatedDeviceStart(
          device,
          deadlineMs,
          "start",
          async (childProcess, signal, retainLeaseUntil) => {
            const readinessTimeoutMs = this.remainingStartDeadline(deadlineMs);
            if (readinessTimeoutMs <= 0) {
              logger.warn(
                `[DevicePool] Start deadline elapsed; cancelling ${label} before readiness`,
              );
              await this.cancelCoordinatedDeviceStart(device, childProcess, retainLeaseUntil);
              return false;
            }
            const ready = this.criteriaMatcher.withDeviceImageMetadata(
              await waitForDeviceReadyOrCancel(
                this.deviceManager,
                device,
                childProcess,
                readinessTimeoutMs,
                signal,
                this.timer,
                () => this.cancelCoordinatedDeviceStart(device, childProcess, retainLeaseUntil),
              ),
              device,
            );
            return { ready, childProcess };
          },
        );
        if (startResult) {
          // The lifecycle lease is released before taking assignmentMutex: never
          // acquire the pool assignment lock while holding a start lease.
          await this.assignmentMutex.runExclusive(async () => {
            await this.addDevice(
              startResult.ready,
              device,
              false,
              this.runtimeIdentity.identityEvidenceForBootedDevice(startResult.ready),
            );
            await this.trackStartedDeviceProcess(startResult.ready, startResult.childProcess);
          });
          started++;
        } else if (startResult === undefined && device.platform === "android") {
          // Rediscover the winner after releasing the lifecycle lease.
          await this.refreshDevices();
        }
      }

      return started;
    } catch (error) {
      logger.warn(`[DevicePool] Failed to start additional devices: ${error}`);
      return 0;
    }
  }

  private remainingStartDeadline(deadlineMs: number): number {
    return Math.max(0, deadlineMs - this.timer.now());
  }

  private async runCoordinatedDeviceStart<T>(
    device: DeviceInfo,
    deadlineMs: number,
    operation: "start" | "recovery",
    action: (
      childProcess: ChildProcess | null,
      signal: AbortSignal,
      retainLeaseUntil: (settlement: Promise<unknown>) => void,
    ) => Promise<T>,
  ): Promise<T | undefined> {
    const timeoutMs = this.remainingStartDeadline(deadlineMs);
    const controller = new AbortController();
    const timeoutError = new ActionableError(
      `Device pool start deadline elapsed for ${device.deviceId ?? device.name}`,
    );
    const timeoutHandle = this.timer.setTimeout(() => {
      controller.abort(timeoutError);
    }, timeoutMs);
    const identity =
      device.platform === "ios" && !device.deviceId
        ? { kind: "selector" as const, platform: "ios" as const, selector: device.name }
        : {
            kind: "stable" as const,
            platform: device.platform,
            stableId: device.platform === "android" ? device.name : device.deviceId!,
          };
    const lifecycleLease = await this.lifecycleCoordinator.reserve(identity, {
      operation,
      deadlineMs,
      signal: controller.signal,
    });
    const signal = AbortSignal.any([controller.signal, lifecycleLease.signal]);
    let retainedLeaseSettlement: Promise<unknown> | undefined;
    const retainLeaseUntil = (settlement: Promise<unknown>): void => {
      retainedLeaseSettlement = retainedLeaseSettlement
        ? Promise.all([retainedLeaseSettlement, settlement])
        : settlement;
    };
    try {
      // Recovery claimed before candidate selection is suppressed there. When
      // recovery or another start claims after selection, acquisition waits for
      // its lease; revalidate under that lease to join the winner's boot instead
      // of launching the same AVD again (#8381).
      // Every Android start, including uncontended starts, re-runs the existing
      // candidate path: one listDeviceImages and (when images exist) one
      // getBootedDevices. Android images with unknown running state are excluded.
      // Keep the funnelled post-skip refresh outside the lifecycle lease.
      if (device.platform === "android" && operation === "start") {
        const candidates = await this.getStartableDeviceImageCandidates("android");
        const pooled = this.getDevicesByPlatform("android");
        if (
          !candidates.some(
            (candidate) =>
              this.criteriaMatcher.getDeviceImageKey(candidate) ===
              this.criteriaMatcher.getDeviceImageKey(device),
          ) ||
          this.isAutoStartSuppressed(device) ||
          pooled.some(
            (entry) =>
              entry.id === device.deviceId || (entry.avdName ?? entry.name) === device.name,
          )
        ) {
          return undefined;
        }
      }
      const childProcess = await this.startCoordinatedDeviceProcess(
        device,
        deadlineMs,
        signal,
        retainLeaseUntil,
      );
      return await action(childProcess, signal, retainLeaseUntil);
    } finally {
      if (retainedLeaseSettlement) {
        void retainedLeaseSettlement.then(
          () => lifecycleLease.release(),
          () => lifecycleLease.release(),
        );
      } else {
        lifecycleLease.release();
      }
      this.timer.clearTimeout(timeoutHandle);
    }
  }

  /**
   * Starts the device under the coordinated lease. A launch cancelled after the
   * emulator spawned carries its child on the error; stop it here so the lease is
   * held until the exit is confirmed (#10075), since `action` never runs for it.
   */
  private async startCoordinatedDeviceProcess(
    device: DeviceInfo,
    deadlineMs: number,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<ChildProcess | null> {
    try {
      return await runWithAbortSignal(signal, () =>
        this.deviceManager.startDevice(device, this.remainingStartDeadline(deadlineMs)),
      );
    } catch (error) {
      if (isEmulatorLaunchCancelledError(error) && error.process) {
        await this.cancelCoordinatedDeviceStart(device, error.process, retainLeaseUntil);
      }
      throw error;
    }
  }

  private async cancelCoordinatedDeviceStart(
    device: DeviceInfo,
    childProcess: ChildProcess | null,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    if (device.platform === "android") {
      await this.stopEmulatorProcess(childProcess, retainLeaseUntil);
      return;
    }
    childProcess?.kill();
  }

  private async startAdditionalDevicesForCriteria(
    requests: DeviceAllocationRequest[],
    deadlineMs: number,
  ): Promise<number> {
    const reservedDeviceIds = new Set<string>();
    const excludedImageIds = new Set<string>();
    let started = 0;

    for (const request of requests) {
      const existing = this.getDevicesMatchingCriteria(request.criteria).find(
        (device) => device.status !== "error" && !reservedDeviceIds.has(device.id),
      );
      if (existing) {
        reservedDeviceIds.add(existing.id);
        continue;
      }

      const startedDevice = await this.startAdditionalDeviceMatchingCriteria(
        request.criteria,
        excludedImageIds,
        deadlineMs,
      );
      if (startedDevice) {
        reservedDeviceIds.add(startedDevice.id);
        started++;
      }
    }

    return started;
  }

  private async startAdditionalDeviceMatchingCriteria(
    criteria: DeviceAllocationCriteria | undefined,
    excludedImageIds: Set<string>,
    deadlineMs: number,
  ): Promise<PooledDevice | null> {
    if (!criteria?.platform) {
      return null;
    }

    try {
      const candidates = await this.getStartableDeviceImageCandidates(
        criteria.platform,
        criteria,
        excludedImageIds,
      );
      const device = candidates[0];
      if (!device) {
        return null;
      }

      const label = device.deviceId ?? device.name;
      logger.info(
        `[DevicePool] Starting ${device.platform} device ${label} for criteria ${this.criteriaMatcher.formatCriteriaSummary(criteria)}`,
      );
      excludedImageIds.add(this.criteriaMatcher.getDeviceImageKey(device));
      const remainingTimeoutMs = this.remainingStartDeadline(deadlineMs);
      if (remainingTimeoutMs <= 0) {
        return null;
      }
      const startResult = await this.runCoordinatedDeviceStart(
        device,
        deadlineMs,
        "start",
        async (childProcess, signal, retainLeaseUntil) => {
          const readinessTimeoutMs = this.remainingStartDeadline(deadlineMs);
          if (readinessTimeoutMs <= 0) {
            logger.warn(
              `[DevicePool] Start deadline elapsed; cancelling ${label} before readiness`,
            );
            await this.cancelCoordinatedDeviceStart(device, childProcess, retainLeaseUntil);
            return null;
          }
          const ready = this.criteriaMatcher.withDeviceImageMetadata(
            await waitForDeviceReadyOrCancel(
              this.deviceManager,
              device,
              childProcess,
              readinessTimeoutMs,
              signal,
              this.timer,
              () => this.cancelCoordinatedDeviceStart(device, childProcess, retainLeaseUntil),
            ),
            device,
          );
          return { ready, childProcess };
        },
      );
      if (!startResult) {
        if (startResult === undefined && criteria.platform === "android") {
          // Rediscover the winner after releasing the lifecycle lease.
          await this.refreshDevices();
        }
        return null;
      }
      // Start readiness and the lifecycle lease settle before assignmentMutex;
      // the pool publish and process association share one assignment turn.
      await this.assignmentMutex.runExclusive(async () => {
        await this.addDevice(
          startResult.ready,
          device,
          false,
          this.runtimeIdentity.identityEvidenceForBootedDevice(startResult.ready),
        );
        await this.trackStartedDeviceProcess(startResult.ready, startResult.childProcess);
      });
      return this.devices.get(startResult.ready.deviceId) ?? null;
    } catch (error) {
      logger.warn(
        `[DevicePool] Failed to start device for criteria ${this.criteriaMatcher.formatCriteriaSummary(criteria)}: ${error}`,
      );
      return null;
    }
  }

  private async getStartableDeviceImageCandidates(
    platform: Platform,
    criteria?: DeviceAllocationCriteria,
    excludedImageIds: Set<string> = new Set(),
  ): Promise<DeviceInfo[]> {
    const availableImages = await this.deviceManager.listDeviceImages(platform);
    if (availableImages.length === 0) {
      return [];
    }

    const bootedDevices = await this.deviceManager.getBootedDevices(platform);
    const bootedIds = new Set(bootedDevices.map((device) => device.deviceId));
    const bootedNames = new Set(bootedDevices.map((device) => device.name));
    const candidates: DeviceInfo[] = [];

    for (const image of availableImages) {
      if (!this.criteriaMatcher.deviceImageMatchesCriteria(image, criteria)) {
        continue;
      }
      if (!this.criteriaMatcher.isStartableDeviceImage(image)) {
        continue;
      }
      if (excludedImageIds.has(this.criteriaMatcher.getDeviceImageKey(image))) {
        continue;
      }
      if (this.isAutoStartSuppressed(image)) {
        continue;
      }
      if (image.deviceId && bootedIds.has(image.deviceId)) {
        continue;
      }
      const running = await this.isDeviceImageRunningForCandidate(image, bootedIds, bootedNames);
      if (running) {
        continue;
      }
      candidates.push(image);
    }

    return candidates;
  }

  private async isDeviceImageRunningForCandidate(
    image: DeviceInfo,
    bootedIds: Set<string>,
    bootedNames: Set<string>,
  ): Promise<boolean> {
    if (
      image.platform === "android" &&
      ((image.deviceId !== undefined && bootedIds.has(image.deviceId)) ||
        bootedNames.has(image.name))
    ) {
      return true;
    }
    if (image.isRunning === true) {
      return true;
    }
    if (image.isRunningStateKnown !== false) {
      return image.deviceId ? bootedIds.has(image.deviceId) : bootedNames.has(image.name);
    }
    return await this.deviceManager.isDeviceImageRunning(image);
  }

  private isAutoStartSuppressed(image: DeviceInfo): boolean {
    return (
      this.suppressedAutoStartDeviceImageKeys.has(this.criteriaMatcher.getDeviceImageKey(image)) ||
      this.suppressedAutoStartDeviceImageKeys.has(`${image.platform}:${image.name}`) ||
      (image.platform === "android" &&
        (this.recoveringAndroidImages.has(image.name) ||
          this.adbServerResetRecoveryReservations.has(image.name)))
    );
  }

  private hasPendingAndroidRecovery(platform?: Platform): boolean {
    return (
      (platform === undefined || platform === "android") &&
      (this.recoveringAndroidImages.size > 0 || this.adbServerResetRecoveryReservations.size > 0)
    );
  }

  private hasPendingAndroidRecoveryMatching(criteria?: DeviceAllocationCriteria): boolean {
    return (
      this.criteriaMatcher.someDeviceImageMatchesCriteria(
        this.recoveringAndroidImages.values(),
        criteria,
      ) ||
      this.criteriaMatcher.someDeviceImageMatchesCriteria(
        Array.from(
          this.adbServerResetRecoveryReservations.values(),
          (reservation) => reservation.image,
        ),
        criteria,
      )
    );
  }

  private isCriteriaUnavailableWithoutPendingRecovery(
    available: boolean,
    criteria?: DeviceAllocationCriteria,
  ): boolean {
    return !available && !this.hasPendingAndroidRecoveryMatching(criteria);
  }

  private shouldWaitForDevice(busyDevices: number, pendingRecovery: boolean): boolean {
    return busyDevices > 0 || pendingRecovery;
  }

  private countBusyDevices(candidates: PooledDevice[]): number {
    return candidates.filter(
      (device) => device.status === "busy" || this.isReservedForAssignment(device),
    ).length;
  }

  /**
   * Ensure device pool has been refreshed at least once
   * Return the refresh failure so allocation errors can retain its cause.
   */
  private async ensurePoolRefreshed(): Promise<string | undefined> {
    if (this.devices.size === 0) {
      logger.info("[DevicePool] Pool is empty, attempting auto-refresh...");
      return (await this.refreshDevicesWithOutcome()).failure;
    }
  }

  private seedLastUsedAt(now: number): number {
    if (now > this.lastUsedAtMarker) {
      this.lastUsedAtMarker = now;
    }
    return this.lastUsedAtMarker;
  }

  private nextLastUsedAt(): number {
    const now = this.timer.now();
    if (now <= this.lastUsedAtMarker) {
      this.lastUsedAtMarker += 1;
      return this.lastUsedAtMarker;
    }
    this.lastUsedAtMarker = now;
    return now;
  }

  private async evictUnavailableIdleDevicesMatching(
    matches: (device: PooledDevice) => boolean,
  ): Promise<number> {
    let evicted = 0;
    for (const device of Array.from(this.devices.values())) {
      if (device.status !== "idle" || !matches(device)) {
        continue;
      }
      if (!(await this.ensurePooledDevicePresentForUse(device, false, false, true))) {
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * The shared assignability gate every hand-out path runs an Android entry
   * through: idle selection, exact `bindOrReuseDeviceSession`, autolock and the
   * pre-allocation sweeps. It answers one question — may this entry be handed to
   * a session right now — which is presence AND a resolved identity, since the
   * liveness check it performs is also what ENTERS the quarantine.
   */
  private async ensurePooledDevicePresentForUse(
    device: PooledDevice,
    deferRecovery: boolean = false,
    assignmentLockHeld: boolean = false,
    idleEviction: boolean = false,
    discovery?: BootedDeviceDiscovery,
  ): Promise<boolean> {
    const present = await this.missingDeviceLiveness.ensurePooledDevicePresent(
      device,
      deferRecovery,
      assignmentLockHeld,
      idleEviction,
      discovery,
    );
    return present && this.runtimeIdentity.isPooledDeviceIdentityAssignable(device);
  }

  private async releaseSessionForEvictedDevice(
    device: PooledDevice,
    incidentId: string | undefined,
    identityObservation?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): Promise<boolean> {
    const sessionId = device.sessionId;
    if (!sessionId) {
      return true;
    }
    const isSupersededByNewerIdentity = () => {
      const currentEvidence = deriveEvidenceFromPooledDevice(device);
      return (
        identityObservation !== undefined &&
        !currentEvidence.unresolved &&
        compareIdentityEvidence(
          currentEvidence,
          this.runtimeIdentity.identityEvidenceForBootedDevice(identityObservation),
        ) === "stale"
      );
    };
    if (isSupersededByNewerIdentity()) {
      logger.info(
        `[DevicePool] Aborting session release for ${device.id}: a newer identity observation ` +
          "superseded this eviction",
      );
      return false;
    }
    const released = await this.retrySessionRelease(sessionId, device.id, () =>
      this.releaseSessionForDisconnectedDevice(
        sessionId,
        device.id,
        deviceLossCancellationReason(device.id, incidentId),
        () => !isSupersededByNewerIdentity(),
      ),
    );
    if (released === false) {
      logger.info(
        `[DevicePool] Aborting session release for ${device.id}: a newer identity observation ` +
          "superseded this eviction",
      );
      return false;
    }
    if (this.devices.get(device.id) !== device) {
      await this.finishEmulatorLossIncident(incidentId, "not-attempted");
      return false;
    }
    device.sessionId = null;
    return true;
  }

  private async tryPreserveSessionForMissingDevice(
    device: PooledDevice,
    attemptDeviceLossRecovery: boolean,
    incidentId: string | undefined,
  ): Promise<boolean> {
    const sessionId = device.sessionId ?? this.sessionManager.getSessionForDevice(device.id);
    const session = sessionId ? this.sessionManager.getSession(sessionId) : null;
    if (
      !attemptDeviceLossRecovery ||
      !sessionId ||
      !session ||
      isSessionReleasing(this.sessionManager, sessionId, session) ||
      !this.isSessionPreservingBinding(device, session)
    ) {
      return false;
    }
    return (
      (await this.recoverSessionBoundDeviceAfterLoss(device.id, incidentId, device)) !==
      "not-attempted"
    );
  }

  private shouldValidatePooledDevicePresence(device: PooledDevice): boolean {
    return this.missingDeviceLiveness.shouldValidatePooledDevicePresence(device);
  }

  private hasReusableSerial(device: PooledDevice): boolean {
    return this.missingDeviceLiveness.hasReusableSerial(device);
  }

  private takeFreshPresenceDiscovery(platform: Platform): Promise<BootedDeviceDiscovery> {
    return this.missingDeviceLiveness.takeFreshPresenceDiscovery(platform);
  }

  private evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    options: MissingDeviceEvictionOptions = {},
  ): Promise<void> {
    return this.missingDeviceLiveness.evictMissingPooledDevice(device, reason, options);
  }

  private shouldRebootDisconnectedAndroidDevice(
    device: PooledDevice,
    options: AndroidEmulatorRecoveryOptions = {},
  ): device is AndroidEmulatorRecoveryDevice {
    return (
      (options.bypassRecoveryPolicy || this.getRecoveryPolicy().onLoss) &&
      this.isAndroidEmulatorActiveRelaunchEligible(device) &&
      (options.allowExistingRecoveryReservation ||
        !this.recoveringAndroidImages.has(device.avdName))
    );
  }

  prepareSessionPreservingRecovery(
    deviceId: string,
    expectedDevice?: PooledDevice,
  ): SessionRecoveryPreparation | undefined {
    return this.recoveryCoordinator.prepareSessionPreservingRecovery(deviceId, expectedDevice);
  }
  finishSessionPreservingRecoveryPreparation(
    preparation: SessionRecoveryPreparation | undefined,
  ): void {
    this.recoveryCoordinator.finishSessionPreservingRecoveryPreparation(preparation);
  }
  async recoverSessionBoundAndroidDeviceAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.recoveryCoordinator.recoverSessionBoundAndroidDeviceAfterLoss(
      deviceId,
      incidentId,
      expectedDevice,
    );
  }
  async recoverSessionBoundDeviceAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.recoveryCoordinator.recoverSessionBoundDeviceAfterLoss(
      deviceId,
      incidentId,
      expectedDevice,
    );
  }
  async recoverSessionBoundIOSSimulatorAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.recoveryCoordinator.recoverSessionBoundIOSSimulatorAfterLoss(
      deviceId,
      incidentId,
      expectedDevice,
    );
  }
  async retryDueDeferredSessionRecoveries(): Promise<void> {
    return this.recoveryCoordinator.retryDueDeferredSessionRecoveries();
  }

  private async performSessionPreservingRecovery(
    device: SessionContinuityDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.sessionPreservingRecovery.performSessionPreservingRecovery(
      device,
      session,
      incidentId,
    );
  }

  private async joinSessionPreservingRecovery(
    recovery: SessionPreservingRecovery,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.recoveryCoordinator.joinSessionPreservingRecovery(recovery, incidentId);
  }
  async waitForSessionPreservingRecovery(sessionId: string, incidentId?: string): Promise<boolean> {
    return this.recoveryCoordinator.waitForSessionPreservingRecovery(sessionId, incidentId);
  }

  isSessionRecoveryInFlight(sessionId: string): boolean {
    return this.recoveryCoordinator.isSessionRecoveryInFlight(sessionId);
  }

  private getSessionPreservingRecoveryTarget(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ): { device: SessionContinuityDevice; session: Session } | undefined {
    const device = this.devices.get(deviceId);
    if (!device) {
      return undefined;
    }
    if (expectedDevice !== undefined && device !== expectedDevice) {
      return undefined;
    }
    const sessionId = device.sessionId ?? this.sessionManager.getSessionForDevice(device.id);
    if (!sessionId) {
      return undefined;
    }
    const session = this.sessionManager.getSession(sessionId);
    if (
      !session ||
      isSessionReleasing(this.sessionManager, sessionId, session) ||
      !this.isEligibleSessionPreservingRecoveryTarget(device, session)
    ) {
      return undefined;
    }
    return { device, session };
  }

  private getAndroidSessionPreservingRecoveryTarget(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ): { device: AndroidEmulatorContinuityDevice; session: Session } | undefined {
    const target = this.getSessionPreservingRecoveryTarget(deviceId, expectedDevice);
    return target && this.isAndroidEmulatorSessionContinuityDevice(target.device)
      ? { device: target.device, session: target.session }
      : undefined;
  }

  private isSessionPreservingBinding(device: PooledDevice, session: Session): boolean {
    return device.sessionId === session.sessionId || session.ownership === "awaiting-owner";
  }

  private isEligibleSessionPreservingRecoveryTarget(
    device: PooledDevice,
    session: Session,
  ): device is SessionContinuityDevice {
    return (
      this.isSessionPreservingBinding(device, session) &&
      session.assignedDevice === device.id &&
      session.platform === device.platform &&
      this.isSessionContinuityRecoveryDevice(device)
    );
  }

  /**
   * Passive continuity's entry gate for Android is deliberately looser than
   * active relaunch's: any session-bound emulator with a resolved, non-placeholder
   * AVD identity qualifies, regardless of whether it was acquired through
   * getAndroid/startDevice image enrichment, pool idle allocation, or an
   * enrichment failure that adopted the device without its configured image.
   * Recording the image is what `isAndroidEmulatorActiveRelaunchEligible` gates,
   * separately, before an actual reboot is attempted (#7546).
   */
  private isSessionContinuityRecoveryDevice(
    device: PooledDevice,
  ): device is SessionContinuityDevice {
    if (device.platform !== "android") {
      return this.deviceSessionContinuityEnabled && this.isIOSSimulatorContinuityDevice(device);
    }
    if (
      !(this.deviceSessionContinuityEnabled || this.getRecoveryPolicy().onLoss) ||
      !this.isAndroidEmulatorSessionContinuityDevice(device)
    ) {
      return false;
    }
    if (this.canRetryDeferredSessionRecovery(device)) {
      return true;
    }
    const stableDeviceId = this.stableDeviceIdFor(device);
    return stableDeviceId !== undefined && !this.recoveringAndroidImages.has(stableDeviceId);
  }

  private canRetryDeferredSessionRecovery(device: PooledDevice): boolean {
    const deferredUntil = this.recoveringSessionLosses.get(device.sessionId ?? "")?.deferredUntil;
    return deferredUntil !== undefined && this.timer.now() >= deferredUntil;
  }

  // rebindSameAvdReplacementSession and the recovery ports may have already
  // detached the entry: their session fence does not require pooled-entry identity.
  private isPreservedSessionCurrent(session: Session, deviceId: string): boolean {
    return this.sessionManager.isCurrentSession(session) && session.assignedDevice === deviceId;
  }

  /**
   * A process-wide ADB reset can make every emulator disappear at once. Only a
   * session already bound to an AutoMobile-started AVD can retain its ownership:
   * the replacement is selected by that recorded AVD name, never by a reused
   * emulator port or serial.
   */
  async recoverSessionBoundAndroidDeviceAfterAdbServerReset(
    deviceId: string,
    expectedDevice?: PooledDevice,
  ): Promise<boolean> {
    const device = this.getAdbResetRecoveryDevice(deviceId, expectedDevice);
    if (!device) {
      return false;
    }

    const session = this.getAdbResetRecoverySession(device);
    if (!session) {
      return false;
    }

    const inFlight = this.sessionPreservingRecoveries.get(session.sessionId);
    if (inFlight) {
      return (await this.joinSessionPreservingRecovery(inFlight, undefined)) === "recovered";
    }
    const entry = {} as SessionPreservingRecovery;
    const recovery = this.startAdbResetSessionRecovery(device, session, entry);
    entry.promise = recovery;
    this.recoveryCoordinator.registerSessionPreservingRecovery(session.sessionId, entry);
    try {
      return (await recovery) === "recovered";
    } finally {
      this.recoveryCoordinator.clearSessionPreservingRecoveryIfCurrent(session.sessionId, entry);
    }
  }

  private async startAdbResetSessionRecovery(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    entry: SessionPreservingRecovery,
  ): Promise<SessionPreservingRecoveryResult> {
    const incidentId =
      device.adbServerResetIncidentId ??
      (await this.recordEmulatorLossIncident(device.id, "adb-server-reset", undefined, "absent"));
    if (incidentId) {
      entry.incidentId = incidentId;
    }
    return await this.performAdbResetSessionRecovery(device, session, incidentId);
  }

  private async performAdbResetSessionRecovery(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    return await this.adbResetSessionRecovery.performAdbResetSessionRecovery(
      device,
      session,
      incidentId,
    );
  }

  private async finishAdbResetRecoveryAfterReboot(
    record: AndroidRecoveryRecord,
    recovered: boolean,
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<"recovered" | "released"> {
    return await this.adbResetSessionRecovery.finishAdbResetRecoveryAfterReboot(
      record,
      recovered,
      device,
      session,
      incidentId,
    );
  }

  private async refreshEmulatorLossRecoverySettlement(
    incidentId: string | undefined,
    fallbackOutcome: "exhausted" | "not-attempted",
  ): Promise<void> {
    return this.emulatorLossLedger.refreshEmulatorLossRecoverySettlement(
      incidentId,
      fallbackOutcome,
    );
  }

  private getAdbResetRecoveryDevice(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ): AndroidEmulatorRecoveryDevice | undefined {
    return this.adbServerResetQuarantine.getAdbResetRecoveryDevice(deviceId, expectedDevice);
  }
  private getAdbResetRecoverySession(device: PooledDevice): Session | undefined {
    return this.adbServerResetQuarantine.getAdbResetRecoverySession(device);
  }

  /**
   * Remove every captured reset-cohort connection before any AVD is restarted.
   * The session manager intentionally retains each old serial until recovery
   * rebinds it, so a replacement can safely reuse another cohort member's port.
   */
  async detachAdbServerResetCohort(
    cohort: readonly PooledDevice[],
  ): Promise<AdbServerResetCohortDetachment> {
    return await this.adbServerResetQuarantine.detachAdbServerResetCohort(cohort);
  }
  async waitForAdbServerResetRecovery(avdName: string, signal?: AbortSignal): Promise<void> {
    await this.adbServerResetQuarantine.waitForAdbServerResetRecovery(avdName, signal);
  }
  getRecoveringAndroidTargets(): { names: Set<string>; serials: Set<string> } {
    return this.adbServerResetQuarantine.getRecoveringAndroidTargets();
  }
  async reserveAndroidStartupLease(
    name: string | undefined,
    exactName: boolean,
    signal?: AbortSignal,
    ownsOfflineRecovery = false,
  ): Promise<() => Promise<void>> {
    return await this.adbServerResetQuarantine.reserveAndroidStartupLease(
      name,
      exactName,
      signal,
      ownsOfflineRecovery,
    );
  }
  async waitForAdbServerResetRecoveryMatchingName(
    name: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.adbServerResetQuarantine.waitForAdbServerResetRecoveryMatchingName(name, signal);
  }
  async releaseAdbServerResetCohortReservations(cohort: readonly PooledDevice[]): Promise<void> {
    await this.adbServerResetQuarantine.releaseAdbServerResetCohortReservations(cohort);
  }
  isDeviceLeasedForAndroidStartup(deviceId: string): boolean {
    return this.adbServerResetQuarantine.isDeviceLeasedForAndroidStartup(deviceId);
  }

  private async releasePreservedAdbResetSessionIfDetached(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
  ): Promise<void> {
    return await this.adbResetSessionRecovery.releasePreservedAdbResetSessionIfDetached(
      device,
      session,
    );
  }

  private async releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    releaseReason: string,
    attempt?: () => Promise<void>,
  ): Promise<void> {
    await this.retrySessionRelease(
      sessionId,
      deviceId,
      attempt ??
        (async () =>
          await this.releaseSessionForDisconnectedDevice(sessionId, deviceId, releaseReason)),
    );
  }

  private async retrySessionRelease<T>(
    sessionId: string,
    deviceId: string,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const device = this.devices.get(deviceId);
    const assignmentCount = device?.assignmentCount;
    try {
      return await this.retryExecutor.executeOrThrow(attempt, {
        onRetry: (error, attemptNumber, delay) => {
          logger.warn(
            `[DevicePool] Retrying recovery release for session ${sessionId} after attempt ${attemptNumber} failed; delay=${delay}ms: ${error}`,
            error,
          );
        },
      });
    } catch (releaseError) {
      // Retain ownership throughout backoff. Only the exhausted release may
      // free a removed session's device, and never a newer assignment.
      if (
        !this.sessionManager.hasSession(sessionId) &&
        device &&
        this.devices.get(deviceId) === device &&
        device.assignmentCount === assignmentCount &&
        device.sessionId === sessionId
      ) {
        try {
          await this.releaseDevice(deviceId, sessionId);
        } catch (poolError) {
          logger.warn(
            `Failed to free device ${deviceId} after session ${sessionId} release retries`,
            poolError,
          );
        }
      }
      throw releaseError;
    }
  }

  private async rebootDisconnectedAndroidDevice(
    device: PooledDevice,
    incidentId?: string,
    options: AndroidEmulatorRecoveryOptions = {},
  ): Promise<boolean> {
    if (!this.shouldRebootDisconnectedAndroidDevice(device, options)) {
      return false;
    }
    const avdName = device.avdName;
    if (!avdName) {
      return false;
    }
    const deadlineMs = this.timer.now() + 300_000;
    const lifecycleLease = await this.lifecycleCoordinator.reserve(
      { kind: "stable", platform: "android", stableId: avdName },
      { operation: "recovery", deadlineMs },
    );
    let retainedLeaseSettlement: Promise<unknown> | undefined;
    const retainLeaseUntil = (settlement: Promise<unknown>): void => {
      retainedLeaseSettlement = retainedLeaseSettlement
        ? Promise.all([retainedLeaseSettlement, settlement])
        : settlement;
    };
    try {
      return await runWithAbortSignal(
        lifecycleLease.signal,
        async () =>
          await this.rebootDisconnectedAndroidDeviceCoordinated(
            device,
            incidentId,
            options,
            lifecycleLease.signal,
            retainLeaseUntil,
          ),
      );
    } finally {
      if (retainedLeaseSettlement) {
        void retainedLeaseSettlement.then(
          () => lifecycleLease.release(),
          () => lifecycleLease.release(),
        );
      } else {
        lifecycleLease.release();
      }
    }
  }

  private async rebootDisconnectedAndroidDeviceCoordinated(
    device: PooledDevice,
    incidentId: string | undefined,
    options: AndroidEmulatorRecoveryOptions,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<boolean> {
    return await this.androidRebootCoordinator.rebootDisconnectedAndroidDeviceCoordinated(
      device,
      incidentId,
      options,
      signal,
      retainLeaseUntil,
    );
  }

  private async stopAndroidEmulatorForRecovery(
    options: StopAndroidEmulatorRecoveryOptions,
  ): Promise<"stopped" | "same-avd" | "declined"> {
    const {
      device,
      avdName,
      retainLeaseUntil,
      allowActiveStop,
      handoffOwner,
      preservedSessionId,
      preservedSession,
    } = options;
    const current = this.devices.get(device.id);
    if (this.sameAvdReplacements(device, avdName).length > 0) {
      return "same-avd";
    }
    if (!allowActiveStop) {
      return "declined";
    }
    if (current && current !== device) {
      logger.info(
        `[DevicePool] Preserving replacement ${current.id} while recovering ${avdName} after ADB reset`,
      );
      return "stopped";
    }
    const detachedProcess = this.adbServerResetTrackedProcesses.get(device);
    if (detachedProcess) {
      this.adbServerResetTrackedProcesses.delete(device);
      await this.stopEmulatorProcess(detachedProcess, retainLeaseUntil);
      return "stopped";
    }
    const trackedProcess = this.startedDeviceProcesses.get(device.id);
    const hadTrackedProcess = trackedProcess !== undefined;
    const trackedProcessExited = trackedProcess && this.getCompletedProcessExit(trackedProcess);
    await this.stopTrackedEmulatorProcess(device.id, retainLeaseUntil);
    if (!hadTrackedProcess || trackedProcessExited) {
      return await this.stopDiscoveredEmulatorByAvdName({
        disconnectedDevice: device,
        avdName,
        retainLeaseUntil,
        adoptOnly: hadTrackedProcess,
        handoffOwner,
        preservedSessionId,
        preservedSession,
      });
    }
    return "stopped";
  }

  private async rebindSameAvdReplacementSession(
    options: RebindSameAvdReplacementSessionOptions,
  ): Promise<boolean> {
    const {
      device,
      avdName,
      preservedSessionId,
      preservedSession,
      preservedAutolockSessionId,
      recoveryImage,
      handoffOwner,
    } = options;
    const replacements = this.sameAvdReplacements(device, avdName);
    if (replacements.length !== 1) {
      return false;
    }
    const replacement = replacements[0];
    if (!preservedSessionId) {
      return true;
    }
    if (preservedSession && !this.isPreservedSessionCurrent(preservedSession, device.id)) {
      return false;
    }
    try {
      await this.bindOrReuseDeviceSession(
        preservedSessionId,
        replacement.id,
        "android",
        recoveryImage,
        undefined,
        {
          deviceId: replacement.id,
          name: replacement.name,
          platform: "android",
        },
        true,
        new Set([handoffOwner]),
        undefined,
        device.id,
      );
      replacement.autolockSessionId = preservedAutolockSessionId;
      const detachedProcess = this.adbServerResetTrackedProcesses.get(device);
      if (detachedProcess) {
        this.adbServerResetTrackedProcesses.delete(device);
        this.startedDeviceProcesses.set(replacement.id, detachedProcess);
      }
      const rebound =
        this.sessionManager.getSession(preservedSessionId)?.assignedDevice === replacement.id;
      if (rebound) {
        this.sessionManager.setDeviceReadiness(preservedSessionId, "booted");
      }
      return rebound;
    } catch (error) {
      logger.warn(
        `[DevicePool] Could not rebind session ${preservedSessionId} to same-AVD replacement ${avdName}: ${error}`,
        error,
      );
      return false;
    }
  }

  private sameAvdReplacements(device: PooledDevice, avdName: string): PooledDevice[] {
    return this.getDevicesByPlatform("android").filter(
      (candidate) =>
        candidate !== device &&
        this.isPooledAndroidEmulator(candidate.id) &&
        !candidate.identityUnresolved &&
        !isUnresolvedAndroidEmulatorName({
          deviceId: candidate.id,
          name: candidate.name,
          platform: candidate.platform,
        }) &&
        this.stableDeviceIdFor(candidate) === avdName,
    );
  }

  private detachSessionForAndroidRecovery(
    device: PooledDevice,
    preservedSessionId: string | undefined,
    preservedSession: Session | undefined,
  ): boolean {
    if (!preservedSessionId) {
      return true;
    }
    if (
      preservedSession
        ? !this.isPreservedSessionCurrent(preservedSession, device.id)
        : this.sessionManager.getSession(preservedSessionId)?.assignedDevice !== device.id
    ) {
      return false;
    }
    // Keep the session manager's old routing until the ready replacement is
    // proven. removeDevice requires an unassigned pool entry.
    device.sessionId = null;
    device.status = "idle";
    return true;
  }

  private async bindRecoveredAndroidDeviceSession(
    options: BindRecoveredAndroidDeviceSessionOptions,
  ): Promise<void> {
    const {
      previousDeviceId,
      avdName,
      preservedSessionId,
      preservedSession,
      ready,
      recoveryImage,
      childProcess,
      preservedAutolockSessionId,
      handoffOwner,
    } = options;
    if (!preservedSessionId) {
      await this.trackStartedDeviceProcess(ready, childProcess);
      return;
    }
    if (
      preservedSession
        ? !this.isPreservedSessionCurrent(preservedSession, previousDeviceId)
        : this.sessionManager.getSession(preservedSessionId)?.assignedDevice !== previousDeviceId
    ) {
      throw new ActionableError(
        `Session '${preservedSessionId}' changed while Android AVD '${avdName}' was recovering.`,
      );
    }
    await this.bindOrReuseDeviceSession(
      preservedSessionId,
      ready.deviceId,
      "android",
      recoveryImage,
      childProcess,
      ready,
      true,
      handoffOwner ? new Set([handoffOwner]) : undefined,
      undefined,
      previousDeviceId,
    );
    this.sessionManager.setDeviceReadiness(preservedSessionId, "booted");
    const replacement = this.devices.get(ready.deviceId);
    if (replacement?.sessionId === preservedSessionId) {
      replacement.autolockSessionId = preservedAutolockSessionId;
    }
  }

  private consumeAdbServerResetRecoveryCancellation(device: PooledDevice): boolean {
    return this.adbServerResetQuarantine.consumeAdbServerResetRecoveryCancellation(device);
  }

  private consumeAndroidRecoveryCancellation(
    device: PooledDevice,
    recoveryDeviceIds: ReadonlySet<string>,
  ): boolean {
    return (
      this.consumeAdbServerResetRecoveryCancellation(device) ||
      this.consumeIntentionalShutdown(recoveryDeviceIds)
    );
  }

  private consumeIntentionalShutdown(deviceIds: ReadonlySet<string>): boolean {
    // Recovery cancellation is deliberately serial-scoped: a user's kill of a
    // serial cancels a pool reboot of that same serial regardless of incarnation
    // (issue #4915). Incarnation gating applies only to the disconnect path in
    // removeDisconnectedDevice.
    let consumed = false;
    for (const deviceId of deviceIds) {
      consumed = this.intentionalShutdowns.delete(deviceId) || consumed;
    }
    return consumed;
  }

  private async stopTrackedEmulatorProcess(
    deviceId: string,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    return this.emulatorProcessLifecycle.stopTrackedEmulatorProcess(deviceId, retainLeaseUntil);
  }

  private async stopDiscoveredEmulatorByAvdName(
    options: StopDiscoveredEmulatorOptions,
  ): Promise<"stopped" | "same-avd"> {
    const {
      disconnectedDevice,
      avdName,
      retainLeaseUntil,
      adoptOnly,
      handoffOwner,
      preservedSessionId,
      preservedSession,
    } = options;
    const timeoutMs = 30_000;
    const deadlineMs = this.timer.now() + timeoutMs;
    const deadlineController = new AbortController();
    const callerSignal = getAbortSignal();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadlineController.signal])
      : deadlineController.signal;
    const timeoutError = new ActionableError(
      `Android emulator '${avdName}' shutdown was not confirmed within ${timeoutMs}ms; recovery will not relaunch it`,
    );
    let shutdown: Promise<"stopped" | "same-avd"> | undefined;
    const startShutdown = () =>
      (shutdown = runWithAbortSignal(signal, async (): Promise<"stopped" | "same-avd"> => {
        const discover = async () => {
          signal.throwIfAborted();
          const discovery = await this.deviceManager.getBootedDevicesDetailed("android", {
            bypassAndroidDeviceListCache: true,
          });
          signal.throwIfAborted();
          if (!discovery.succeededPlatforms.has("android")) {
            throw new ActionableError(
              `Android discovery failed while confirming '${avdName}' shutdown; recovery will not relaunch it`,
            );
          }
          if (discovery.devices.some((device) => device.name.startsWith("Unknown ("))) {
            throw new ActionableError(
              `Android discovery contains an unresolved emulator identity while stopping '${avdName}'; recovery will not relaunch it`,
            );
          }
          return discovery.devices;
        };
        const booted = await discover();
        const matchingAvds = booted.filter(
          (device) => device.platform === "android" && device.name === avdName,
        );
        if (matchingAvds.length > 1) {
          throw new ActionableError(
            `Multiple running emulators identify as '${avdName}'; recovery will not relaunch it`,
          );
        }
        const matchingAvd = matchingAvds[0];
        if (!matchingAvd) {
          return await this.stopRecoveryTargetMissingFromOnlineList({
            avdName,
            deviceId: disconnectedDevice.id,
            adoptOnly,
            discover,
            signal,
            deadlineMs,
          });
        }
        if (matchingAvd.deviceId !== disconnectedDevice.id || adoptOnly) {
          if (matchingAvd.deviceId === disconnectedDevice.id) {
            if (
              this.devices.get(disconnectedDevice.id) !== disconnectedDevice ||
              !this.detachSessionForAndroidRecovery(
                disconnectedDevice,
                preservedSessionId,
                preservedSession,
              )
            ) {
              throw new ActionableError(
                `Android emulator '${avdName}' changed ownership during recovery; recovery will not relaunch it`,
              );
            }
            this.recoveryCoordinator.setAndroidRecoveryHandoffOwner(
              matchingAvd.deviceId,
              handoffOwner,
            );
            await this.removeDevice(disconnectedDevice.id, true, disconnectedDevice);
          } else {
            this.recoveryCoordinator.setAndroidRecoveryHandoffOwner(
              matchingAvd.deviceId,
              handoffOwner,
            );
          }
          await this.addDevice(matchingAvd, disconnectedDevice.androidImage);
          signal.throwIfAborted();
          return "same-avd";
        }
        await this.deviceManager.killDevice(matchingAvd, {
          timeoutMs: Math.max(1, deadlineMs - this.timer.now()),
          signal,
        });
        signal.throwIfAborted();
        return await this.confirmRecoveryStop(
          avdName,
          matchingAvd.deviceId,
          discover,
          signal,
          deadlineMs,
        );
      }));
    try {
      return await raceWithDeadline(startShutdown, {
        timer: this.timer,
        timeoutMs,
        signal: callerSignal,
        label: "Android emulator shutdown confirmation",
        timeoutError: () => {
          deadlineController.abort(timeoutError);
          return timeoutError;
        },
      });
    } catch (error) {
      // A late command must settle before another lifecycle owner may mutate
      // this AVD. Failure propagates before pool/session detachment or relaunch.
      if (shutdown) {
        retainLeaseUntil(shutdown);
      }
      throw new UnconfirmedRecoveryShutdownError(avdName, error);
    }
  }

  /**
   * The AVD is absent from the online-only list before any kill. That is not proof
   * its emulator stopped: a transport that dropped to adb `offline` leaves the
   * process running and holding the AVD (#10074, #10100). When the recovery's own
   * serial is still listed `offline`, send the console kill through the client's
   * offline handling (`force` is what makes it dispatch to a serial that is attached
   * but not online; the serial was just probed, so the only residual is a replacement
   * taking it inside that window), then confirm the exit like any other kill. An
   * adopt-only recovery never kills: its tracked process already exited. A serial
   * absent from adb, or an unavailable probe, keeps the earlier answer.
   */
  private async stopRecoveryTargetMissingFromOnlineList(options: {
    avdName: string;
    deviceId: string;
    adoptOnly: boolean;
    discover: () => Promise<BootedDevice[]>;
    signal: AbortSignal;
    deadlineMs: number;
  }): Promise<"stopped"> {
    const { avdName, deviceId, adoptOnly, discover, signal, deadlineMs } = options;
    if (
      adoptOnly ||
      !(await this.isAndroidSerialHeldOffline(avdName, deviceId, signal, deadlineMs))
    ) {
      return "stopped";
    }
    await this.deviceManager.killDevice(
      { deviceId, name: avdName, platform: "android" },
      { timeoutMs: Math.max(1, deadlineMs - this.timer.now()), signal, force: true },
    );
    signal.throwIfAborted();
    return await this.confirmRecoveryStop(avdName, deviceId, discover, signal, deadlineMs);
  }

  private async confirmRecoveryStop(
    avdName: string,
    deviceId: string,
    discover: () => Promise<BootedDevice[]>,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<"stopped"> {
    for (;;) {
      const devices = await discover();
      // A same-AVD replacement still holds the image's locks; a different
      // AVD reusing the old serial must be preserved without another kill.
      const stillPresent = devices.some((device) => device.name === avdName);
      // The online-only list also lacks an emulator that dropped to adb `offline`
      // mid-kill while its process still runs (#10100).
      if (
        !stillPresent &&
        !(await this.isAndroidSerialHeldOffline(avdName, deviceId, signal, deadlineMs))
      ) {
        logger.info(
          `[DevicePool] Confirmed untracked Android emulator ${avdName} stopped before recovery`,
        );
        return "stopped";
      }
      await this.timer.sleep(Math.min(1_000, Math.max(0, deadlineMs - this.timer.now())));
      signal.throwIfAborted();
    }
  }

  /**
   * Whether adb still lists the killed emulator's serial as `offline` (or its
   * state could not be read), so its absence from the online-only discovery does
   * not yet confirm the AVD stopped. The same "offline or probe failed means
   * unconfirmed" rule as the recovery-reservation lift (#10076).
   */
  private async isAndroidSerialHeldOffline(
    avdName: string,
    deviceId: string,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<boolean> {
    const probe = this.deviceManager.getAndroidOfflineDeviceIds?.bind(this.deviceManager);
    if (!probe) {
      return false;
    }
    try {
      const offline = await probe([deviceId], {
        signal,
        timeoutMs: Math.max(
          1,
          Math.min(ANDROID_OFFLINE_PROBE_TIMEOUT_MS, deadlineMs - this.timer.now()),
        ),
      });
      signal.throwIfAborted();
      if (offline.has(deviceId)) {
        logger.info(
          `[DevicePool] Android AVD '${avdName}' is absent from the booted list but adb still lists ${deviceId} as offline; shutdown not yet confirmed`,
        );
      }
      return offline.has(deviceId);
    } catch (error) {
      signal.throwIfAborted();
      // An unreadable state list cannot prove the serial left `adb devices`.
      logger.warn(
        `[DevicePool] adb device-state probe failed while confirming '${avdName}' stopped: ${errorMessage(error)}`,
        error,
      );
      return true;
    }
  }

  private async stopEmulatorProcess(
    childProcess: ChildProcess | null | undefined,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    return this.emulatorProcessLifecycle.stopEmulatorProcess(childProcess, retainLeaseUntil);
  }

  private async trackStartedDeviceProcess(
    device: BootedDevice,
    childProcess: ChildProcess | null | undefined,
  ): Promise<void> {
    return this.emulatorProcessLifecycle.trackStartedDeviceProcess(device, childProcess);
  }

  hasStartedDeviceProcess(
    deviceId: string,
    childProcess: ChildProcess | null | undefined,
  ): boolean {
    return this.emulatorProcessLifecycle.hasStartedDeviceProcess(deviceId, childProcess);
  }

  private getCompletedProcessExit(
    childProcess: ChildProcess,
  ): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.emulatorProcessLifecycle.getCompletedProcessExit(childProcess);
  }

  private async evictStartedDeviceAfterProcessExit(
    deviceId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    return this.emulatorProcessLifecycle.evictStartedDeviceAfterProcessExit(deviceId, code, signal);
  }

  private suppressAutoStartForDevice(device: PooledDevice): void {
    const imageKey = `${device.platform}:${device.avdName ?? device.name}`;
    this.suppressedAutoStartDeviceImageKeys.add(device.id);
    this.suppressedAutoStartDeviceImageKeys.add(imageKey);
    this.suppressedAutoStartImageKeyByDeviceId.set(device.id, imageKey);
  }

  private clearAutoStartSuppressionForBootedDevice(
    device: BootedDevice,
    sourceImage?: DeviceInfo,
  ): void {
    const rememberedImageKey = this.suppressedAutoStartImageKeyByDeviceId.get(device.deviceId);
    const observedImageKey = `${device.platform}:${device.name}`;
    const authoritativeImageKey =
      sourceImage?.platform === device.platform
        ? `${sourceImage.platform}:${sourceImage.name}`
        : observedImageKey;
    this.suppressedAutoStartDeviceImageKeys.delete(device.deviceId);
    this.suppressedAutoStartDeviceImageKeys.delete(observedImageKey);
    this.suppressedAutoStartDeviceImageKeys.delete(authoritativeImageKey);
    if (rememberedImageKey === authoritativeImageKey) {
      this.suppressedAutoStartDeviceImageKeys.delete(rememberedImageKey);
      this.suppressedAutoStartImageKeyByDeviceId.delete(device.deviceId);
    }
  }

  /**
   * Assign a device to a session
   *
   * Called when a new session is created or when a session needs to pick a device.
   * Returns the device ID assigned to the session.
   *
   * Uses mutex to ensure atomic device assignment and prevent race conditions
   * when multiple tests run in parallel.
   *
   * Automatically refreshes device pool if empty, handling race conditions during
   * daemon startup where device discovery may not have completed.
   *
   * When all devices are busy, waits with timeout for a device to become available.
   * This enables parallel test execution with limited devices.
   */
  async assignDeviceToSession(
    sessionId: string,
    platform?: Platform,
    recoveryTarget?: SessionRecoveryTarget,
  ): Promise<string> {
    const assignmentSignal = recoveryTarget ? getAbortSignal() : undefined;
    const recoveryDeadline = recoveryTarget?.restartRecoveryDeadlineMs;
    const timeoutMs =
      recoveryDeadline === undefined
        ? this.DEVICE_WAIT_TIMEOUT_MS
        : Math.max(0, recoveryDeadline - this.timer.now());
    // Include the deadline attempt: attempt one runs immediately, before any sleep.
    const maxAttempts = Math.max(
      1,
      Math.ceil(timeoutMs / this.DEVICE_WAIT_INTERVAL_MS) +
        (recoveryDeadline === undefined ? 0 : 1),
    );
    let firstAttemptLogged = false;
    let refreshFailure: string | undefined;
    let lossIncident: EmulatorLossIncident | undefined;
    recoveryTarget?.onRecoveryWait?.({
      responseMarginMs: this.RECOVERY_RESPONSE_MARGIN_MS,
      restartDeadlineMs: recoveryTarget.restartRecoveryDeadlineMs,
      timeoutError: () => this.recoveryAssignmentError(sessionId, recoveryTarget, lossIncident),
    });

    const result = await this.retryExecutor.execute(
      async (attempt) => {
        // Ordinary allocation must capture candidates before yielding to release/readiness.
        if (recoveryTarget) {
          lossIncident = await this.settledRecoveryLossIncident(sessionId, recoveryTarget);
        }
        // Try to assign device (mutex ensures atomic assignment)
        const assignResult = await this.tryAssignDevice(
          sessionId,
          platform,
          recoveryTarget,
          lossIncident !== undefined,
        );
        if (assignResult.refreshCompleted) {
          refreshFailure = assignResult.refreshFailure;
        }

        if (assignResult.success) {
          if (attempt > 1) {
            logger.info(
              `Device ${assignResult.deviceId} assigned to session ${sessionId} ` +
                `after ${attempt} attempts`,
            );
          }
          return assignResult.deviceId!;
        }

        if (recoveryTarget) {
          lossIncident = await this.checkRecoveryAssignmentFailure(
            sessionId,
            recoveryTarget,
            assignResult.refreshCompleteness,
            lossIncident,
          );
        }

        // No device available - check if we should wait or fail
        if (assignResult.livenessUnknown) {
          throw new DevicePoolError(
            `Unable to verify iOS simulator liveness for session ${sessionId}; iOS discovery failed.`,
            false,
          );
        }
        if (assignResult.shouldWait) {
          // Devices exist but are busy - throw retryable error
          if (!firstAttemptLogged) {
            firstAttemptLogged = true;
            logger.info(
              `All ${assignResult.totalDevices} devices busy, ` +
                `session ${sessionId} waiting for availability (timeout: ${timeoutMs / 1000}s)...`,
            );
          }
          throw new DevicePoolError("All devices busy", true, refreshFailure);
        } else {
          // No devices at all - fail immediately with non-retryable error
          const stats = this.getStatsForPlatform(platform);
          throw new DevicePoolError(
            `No devices in pool to assign to session ${sessionId}.\n` +
              `Device pool status:\n` +
              `  Total devices: ${stats.total}\n` +
              `  Idle: ${stats.idle}\n` +
              `  Assigned: ${stats.assigned}\n` +
              `  Error: ${stats.error}\n\n` +
              `Suggestions:\n` +
              `  - Start an emulator or connect a physical device\n` +
              `  - Check device pool status: auto-mobile --cli listDevices\n` +
              `  - Verify device tooling is working for the selected platform`,
            false,
          );
        }
      },
      {
        maxAttempts,
        signal: assignmentSignal,
        delays: () =>
          Math.min(
            this.DEVICE_WAIT_INTERVAL_MS,
            recoveryDeadline === undefined
              ? this.DEVICE_WAIT_INTERVAL_MS
              : Math.max(0, recoveryDeadline - this.timer.now()),
          ),
        shouldRetry: (error) =>
          error instanceof DevicePoolError &&
          error.isRetryable &&
          (recoveryDeadline === undefined || this.timer.now() < recoveryDeadline),
      },
    );

    if (!result.success) {
      this.throwSessionAssignmentFailure({
        sessionId,
        platform,
        recoveryTarget,
        error: result.error,
        attempts: result.attempts,
        timeoutMs,
        lossIncident,
      });
    }

    return result.value!;
  }

  private throwSessionAssignmentFailure({
    sessionId,
    platform,
    recoveryTarget,
    error,
    attempts,
    timeoutMs,
    lossIncident,
  }: {
    sessionId: string;
    platform?: Platform;
    recoveryTarget?: SessionRecoveryTarget;
    error?: Error;
    attempts: number;
    timeoutMs: number;
    lossIncident?: EmulatorLossIncident;
  }): never {
    if (recoveryTarget && error instanceof DevicePoolError) {
      throw this.recoveryAssignmentError(sessionId, recoveryTarget, lossIncident);
    }
    // Check if it was a non-retryable error (no devices)
    if (error instanceof DevicePoolError && !error.isRetryable) {
      throw new ActionableError(error.message);
    }
    if (error && !(error instanceof DevicePoolError && error.isRetryable)) {
      throw error;
    }
    // Timeout case - all attempts exhausted
    const stats = this.getStatsForPlatform(platform);
    throw new ActionableError(
      `Timed out waiting for device after ${Math.round(timeoutMs / 1000)}s (${attempts} attempts).\n` +
        refreshFailureContext(error) +
        `Session: ${sessionId}\n` +
        `Device pool status:\n` +
        `  Total devices: ${stats.total}\n` +
        `  Idle: ${stats.idle}\n` +
        `  Assigned: ${stats.assigned}\n` +
        `  Error: ${stats.error}\n\n` +
        `Suggestions:\n` +
        `  - Reduce parallel test count to match available devices\n` +
        `  - Start additional emulators or connect more physical devices\n` +
        `  - Check if tests are properly releasing devices after completion`,
    );
  }

  private async checkRecoveryAssignmentFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
    refreshCompleteness: DiscoveryCompleteness | undefined,
    incident: EmulatorLossIncident | undefined,
  ): Promise<EmulatorLossIncident | undefined> {
    // Loss can settle while discovery is in flight. Re-read diagnostics before
    // deciding whether this attempt should report pending.
    incident ??= await this.settledRecoveryLossIncident(sessionId, target);
    const failure = this.recoveryFailure(sessionId, target, refreshCompleteness);
    // Proven serial reuse is terminal even inside the recovery window.
    if (
      failure instanceof SessionRecoveryIdentityLossError &&
      failure.reason === "identity-continuity-lost"
    ) {
      throw failure;
    }
    // Reading diagnostics or discovery can cross the restart deadline. Only
    // recoveryFailure may decide absence once that window closes.
    if (
      incident &&
      target.restartRecoveryDeadlineMs !== undefined &&
      this.timer.now() < target.restartRecoveryDeadlineMs &&
      this.getDevicesMatchingRecoveryTarget(target).length === 0
    ) {
      throw this.recoveryAssignmentError(sessionId, target, incident);
    }
    if (failure) {
      throw failure;
    }
    return incident;
  }

  private recoveryAssignmentError(
    sessionId: string,
    target: SessionRecoveryTarget,
    incident?: EmulatorLossIncident,
  ): ActionableError {
    const now = this.timer.now();
    if (target.restartRecoveryDeadlineMs !== undefined && now < target.restartRecoveryDeadlineMs) {
      return new SessionRecoveryAssignmentError({
        sessionUuid: sessionId,
        platform: target.platform,
        deviceId: target.deviceId,
        stableDeviceId: target.stableDeviceId,
        ...(incident
          ? {
              incidentId: incident.id,
              detectionPath: incident.detectionPath,
              ...(incident.processExit ? { processExit: { ...incident.processExit } } : {}),
              recoveryOutcome: incident.recovery.outcome,
            }
          : {}),
        recoveryWindowRemainingMs: target.restartRecoveryDeadlineMs - now,
      });
    }
    const context = formatSessionRecoveryIncidentContext(
      incident
        ? {
            incidentId: incident.id,
            detectionPath: incident.detectionPath,
            processExit: incident.processExit,
            recoveryOutcome: incident.recovery.outcome,
          }
        : {},
    );
    return new ActionableError(
      `Cannot safely recover session ${sessionId}: ${target.platform} device ` +
        `'${target.stableDeviceId}' is unavailable or already in use. ` +
        "Acquire a new device with getAndroid or getApple. " +
        context,
    );
  }

  private async settledRecoveryLossIncident(
    sessionId: string,
    target: SessionRecoveryTarget,
  ): Promise<EmulatorLossIncident | undefined> {
    if (
      target.platform !== "android" ||
      target.restartRecoveryDeadlineMs === undefined ||
      this.timer.now() >= target.restartRecoveryDeadlineMs
    ) {
      return undefined;
    }
    try {
      const incident = (await this.emulatorLossIncidentStore.list()).find(
        (candidate) =>
          candidate.session?.sessionUuid === sessionId &&
          candidate.deviceId === target.deviceId &&
          (candidate.avdName === undefined || candidate.avdName === target.stableDeviceId),
      );
      return incident &&
        !this.emulatorLossLedger.emulatorLossRecoverySettlements.has(incident.id) &&
        (incident.recovery.outcome === "not-attempted" || incident.recovery.outcome === "exhausted")
        ? incident
        : undefined;
    } catch (error) {
      // Diagnostics failure must not replace the bounded recovery error.
      logger.warn("[DevicePool] Failed to read recovery loss incident", error);
      return undefined;
    }
  }

  /**
   * Try to assign a device to a session (single attempt)
   *
   * Returns success status and whether caller should wait and retry.
   */
  private async tryAssignDevice(
    sessionId: string,
    platform?: Platform,
    recoveryTarget?: SessionRecoveryTarget,
    settledRecoveryLoss = false,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }> {
    return this.tryAssignFrom(
      sessionId,
      () =>
        recoveryTarget
          ? this.getDevicesMatchingRecoveryTarget(recoveryTarget)
          : this.getDevicesByPlatform(platform),
      recoveryTarget ? "recovery target pool empty" : "platform pool empty",
      () => this.hasPendingAndroidRecovery(platform),
      recoveryTarget,
      settledRecoveryLoss,
    );
  }

  private recordCriteriaAssignment(
    request: DeviceAllocationRequest,
    result: Awaited<ReturnType<DevicePool["tryAssignDeviceWithCriteria"]>>,
    assignments: Map<string, string>,
    assignmentsToRollback: Map<string, RollbackAssignment>,
  ): void {
    assignments.set(request.sessionId, result.deviceId!);
    if (result.session) {
      assignmentsToRollback.set(request.sessionId, {
        deviceId: result.deviceId!,
        session: result.session,
      });
    }
  }

  private async tryAssignDeviceWithCriteria(
    sessionId: string,
    criteria?: DeviceAllocationCriteria,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }> {
    return this.tryAssignFrom(
      sessionId,
      () => this.getDevicesMatchingCriteria(criteria),
      "criteria pool empty",
      () => this.hasPendingAndroidRecoveryMatching(criteria),
    );
  }

  /**
   * Shared single-attempt assignment body for platform- and criteria-based
   * allocation. Parameterized only by how candidate devices are selected and
   * the label used when the candidate pool is empty.
   *
   * Selection order: prefer the most recently released device for reuse, then
   * fall back to the least-recently-used idle device for load distribution.
   *
   * @param emptyCandidatePoolReason label logged when candidates exist in the
   *   pool overall but none match this selector (the `totalDevices === 0` case)
   */
  private async tryAssignFrom(
    sessionId: string,
    selectCandidates: () => PooledDevice[],
    emptyCandidatePoolReason: string,
    hasPendingRecovery: () => boolean,
    recoveryTarget?: SessionRecoveryTarget,
    settledRecoveryLoss = false,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }> {
    let livenessUnknown = false;
    let refreshCompleteness: DiscoveryCompleteness | undefined;
    let refreshFailure: string | undefined;
    let refreshCompleted = false;
    let refreshed = false;
    let refreshInconclusive = false;
    let staleRetries = 0;

    while (true) {
      throwIfRequestAborted();
      const candidatesBeforeDiscovery = selectCandidates();
      // Only entries idle before discovery may be judged by this pass. A newly
      // released, added or replaced entry needs its own fresh snapshot.
      const capturedEntries = new Set(
        candidatesBeforeDiscovery.filter((device) => device.status === "idle"),
      );
      const [iosLiveness, androidPresence] = await raceWithDeadline(
        () =>
          Promise.all([
            candidatesBeforeDiscovery.some(
              (device) => device.status === "idle" && device.platform === "ios",
            )
              ? this.idleDeviceReaper.getIosLivenessSnapshot()
              : undefined,
            candidatesBeforeDiscovery.some(
              (device) =>
                device.status === "idle" && this.shouldValidatePooledDevicePresence(device),
            )
              ? this.takeFreshPresenceDiscovery("android")
              : undefined,
          ]),
        { timer: this.timer, signal: getAbortSignal(), label: "Device allocation discovery" },
      );
      const snapshots = { capturedEntries, iosLiveness, androidPresence };

      // Platform snapshots and refresh discovery are outside this boundary.
      // In-memory validation and short local DB/incident-ledger writes stay inside.
      // Shared identity reconciliation retains its bounded unreadable-AVD retries:
      // splitting its confirmed-identity/quarantine transition needs its own fence.
      const result = await this.assignmentMutex.runExclusive(async () => {
        throwIfRequestAborted();
        let candidates = selectCandidates();
        let selection = await this.selectAssignableIdleDevice(candidates, snapshots);
        let device = selection.device;
        let snapshotStale = selection.snapshotStale;
        livenessUnknown ||= selection.livenessUnknown;
        candidates = selectCandidates();

        // Selection can await local persistence, and release does not take this
        // mutex. Revalidate after that await; skip invalid entries without I/O.
        while (device && !this.isCurrentIdleDeviceAssignable(device)) {
          snapshotStale = true;
          candidates = candidates.filter((candidate) => candidate !== device);
          selection = await this.selectAssignableIdleDevice(candidates, snapshots);
          device = selection.device;
          livenessUnknown ||= selection.livenessUnknown;
        }

        if (device) {
          const totalDevices = selectCandidates().length;
          // No await between the final validation above and claim's field writes.
          const assignment = await this.claimSelectedDeviceForSession(
            sessionId,
            device,
            recoveryTarget,
          );
          logger.info(`Assigned device ${device.id} to session ${sessionId}`);
          return {
            success: true,
            deviceId: assignment.deviceId,
            session: assignment.session,
            shouldWait: false,
            totalDevices,
            shouldRefresh: false,
            snapshotStale,
          };
        }

        candidates = selectCandidates();
        const totalDevices = candidates.length;
        this.assertHealthyAllocationPossible(candidates, device);
        const busyDevices = this.countBusyDevices(candidates);
        const shouldRefresh =
          !refreshed && (this.devices.size === 0 || totalDevices === 0 || busyDevices === 0);
        if (shouldRefresh) {
          const refreshReason =
            this.devices.size === 0
              ? "empty pool"
              : totalDevices === 0
                ? emptyCandidatePoolReason
                : "no idle usable devices";
          logger.info(`[DevicePool] Auto-refreshing devices due to ${refreshReason}...`);
        }
        return {
          success: false,
          shouldWait: this.shouldWaitForDevice(busyDevices, hasPendingRecovery()),
          totalDevices,
          livenessUnknown,
          refreshCompleteness,
          shouldRefresh,
          snapshotStale,
        };
      });
      const { shouldRefresh, snapshotStale, ...assignment } = result;
      if (assignment.success) {
        return { ...assignment, refreshCompleteness, refreshFailure, refreshCompleted };
      }
      if (shouldRefresh) {
        refreshed = true;
        // Allocation waiters share discovery outside the mutex. The shared task
        // must not inherit one caller's cancellation; each waiter can stop alone.
        const refreshResult = await this.allocationRefresh.run(
          "allocation",
          () => this.refreshForAllocation(recoveryTarget, settledRecoveryLoss),
          getAbortSignal(),
        );
        refreshCompleteness = refreshResult.completeness;
        refreshFailure = refreshResult.failure;
        // Discarded discovery is neither a failure nor a successful refresh.
        refreshCompleted = refreshFailure !== undefined || refreshCompleteness !== undefined;
        // A background refresh can still supersede this flight. Its discarded
        // result (or failed discovery) cannot establish authoritative absence,
        // including for exact recovery targets; let the public retry bound it.
        refreshInconclusive = refreshCompleteness === undefined;
        continue;
      }
      if (refreshInconclusive) {
        return {
          ...assignment,
          shouldWait: true,
          refreshCompleteness,
          refreshFailure,
          refreshCompleted,
        };
      }
      if (!snapshotStale) {
        return { ...assignment, refreshCompleteness, refreshFailure, refreshCompleted };
      }
      if (staleRetries++ >= ALLOCATION_SNAPSHOT_STALE_RETRIES) {
        // Let the existing allocation timeout/retry loop bound sustained churn.
        return {
          ...assignment,
          shouldWait: true,
          refreshCompleteness,
          refreshFailure,
          refreshCompleted,
        };
      }
    }
  }

  private refreshForAllocation(
    target: SessionRecoveryTarget | undefined,
    settledRecoveryLoss: boolean,
  ): Promise<DevicePoolRefreshResult> {
    return runWithAbortSignal(undefined, () =>
      target
        ? this.refreshForRecoveryRetry(target, settledRecoveryLoss)
        : this.refreshDevicesInternal(false),
    );
  }

  private async refreshForRecoveryRetry(
    target: SessionRecoveryTarget,
    settledRecoveryLoss: boolean,
  ): Promise<DevicePoolRefreshResult> {
    if (
      target.restartRecoveryDeadlineMs === undefined ||
      this.timer.now() >= target.restartRecoveryDeadlineMs
    ) {
      return this.refreshDevicesInternal(false);
    }
    // Pool-wide, not per session: multiple recovering sessions must not each
    // spend a miss against the same bystander. Ordinary refreshes are not cached
    // here, so the first recovery retry still discovers after the loss.
    // Only the settled-loss fast pending error enables cache reuse. Unsettled
    // recovery retains its existing in-call polling and caller deadlines.
    const recent = settledRecoveryLoss ? this.recoveryRetryRefresh.get("allocation") : undefined;
    if (recent) {
      return recent;
    }
    const result = await this.refreshDevicesInternal(false);
    // Cache even inconclusive results to bound retries during discovery failure.
    // SingleFlight owns this task independently of each caller's cancellation.
    this.recoveryRetryRefresh.set("allocation", result);
    return result;
  }

  private isPooledEntryCurrent(device: PooledDevice): boolean {
    return this.devices.get(device.id) === device;
  }

  // selectAssignableIdleDevice additionally requires eligibility and resolved identity.
  private isCurrentIdleDeviceAssignable(device: PooledDevice): boolean {
    return (
      this.isPooledEntryCurrent(device) &&
      device.sessionId === null &&
      this.selectIdleDevice([device]) === device &&
      this.runtimeIdentity.isPooledDeviceIdentityAssignable(device)
    );
  }

  private async selectAssignableIdleDevice(
    candidates: PooledDevice[],
    { capturedEntries, iosLiveness, androidPresence }: AllocationDiscoverySnapshots,
  ): Promise<AssignableIdleDeviceSelection> {
    let device = this.selectIdleDevice(candidates);
    let livenessUnknown = false;
    let snapshotStale = [...capturedEntries].some(
      (entry) =>
        this.devices.get(entry.id) !== entry ||
        entry.status !== "idle" ||
        entry.sessionId !== null ||
        this.isReservedForAssignment(entry),
    );
    // One fresh Android sweep per pass (#6546), now taken outside the mutex.
    // Entry identity fences older snapshots from newer pool incarnations (#8130).
    while (device) {
      const skippedDeviceId = device.id;
      if (!capturedEntries.has(device)) {
        snapshotStale = true;
      } else if (!this.runtimeIdentity.isPooledDeviceIdentityAssignable(device)) {
        // Quarantined serial identity is not assignable, even if it is present.
      } else if (!this.isCurrentIdleDeviceAssignable(device)) {
        snapshotStale = true;
      } else if (this.shouldValidatePooledDevicePresence(device)) {
        if (!androidPresence) {
          // An entry that became idle after discovery needs a fresh pass.
          snapshotStale = true;
        } else if (!androidPresence.devices.some((booted) => booted.deviceId === skippedDeviceId)) {
          // Pre-lock absence may already be stale on this same entry. Skip it;
          // fenced refresh/monitor miss thresholds alone own missing eviction.
          snapshotStale = true;
        } else if (
          await this.ensurePooledDevicePresentForUse(device, true, true, false, androidPresence)
        ) {
          return { device, livenessUnknown, snapshotStale };
        } else {
          // Reconciliation may have removed or replaced this captured entry.
          // A replacement needs its own pass before it can be handed out.
          snapshotStale ||= this.devices.get(device.id) !== device;
        }
      } else {
        const status = this.idleDeviceReaper.getIdleDeviceLivenessStatus(device, iosLiveness);
        if (status === "assignable") {
          return { device, livenessUnknown, snapshotStale };
        }
        if (status === "stale") {
          // As with Android, absence before the lock cannot retire this entry.
          snapshotStale = true;
        } else {
          livenessUnknown = true;
          logger.warn(
            `[DevicePool] Cannot assign idle iOS ${this.idleDeviceReaper.iosDeviceNoun(device.id)} ${device.id}: ` +
              "its iOS liveness discovery source failed",
          );
        }
      }
      candidates = candidates.filter((candidate) => candidate.id !== skippedDeviceId);
      device = this.selectIdleDevice(candidates);
    }
    return { livenessUnknown, snapshotStale };
  }

  private async claimSelectedDeviceForSession(
    sessionId: string,
    device: PooledDevice,
    recoveryTarget?: SessionRecoveryTarget,
  ): Promise<{ deviceId: string; session?: Session }> {
    // Recovery deadline cancellation must fence the claim's synchronous field writes.
    if (recoveryTarget) {
      throwIfRequestAborted();
    }
    if (this.getDeviceHealthMarker(device.id)) {
      throw this.unhealthyDevicesError([device]);
    }
    const existingSession = this.sessionManager.getSession(sessionId);
    const assignmentSnapshot = this.snapshotSessionAssignment(device);
    device.sessionId = sessionId;
    device.status = "busy";
    device.lastUsedAt = this.nextLastUsedAt();
    device.assignmentCount++;
    device.errorCount = 0;
    if (recoveryTarget?.persistenceMetadata?.autolockEnabled) {
      device.autolockSessionId = sessionId;
    }
    const session = await this.createSessionOrRestore(device, assignmentSnapshot, () =>
      this.sessionManager.createSession(
        sessionId,
        device.id,
        device.platform,
        recoveryTarget?.liveness?.sessionTimeoutMs,
        recoveryTarget?.liveness?.heartbeatTimeoutMs,
        this.stableDeviceIdFor(device),
        recoveryTarget?.liveness,
        recoveryTarget?.initialOwnership,
      ),
    );
    if (session.assignedDevice !== device.id) {
      this.restoreSessionAssignment(device, assignmentSnapshot);
      return { deviceId: session.assignedDevice };
    }
    return existingSession === session ? { deviceId: device.id } : { deviceId: device.id, session };
  }

  private isIdleDeviceEligible(device: PooledDevice): boolean {
    return (
      device.status === "idle" &&
      this.androidTransportAliases.isAssignable({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
      }) &&
      !this.isReservedForAssignment(device) &&
      !this.getDeviceHealthMarker(device.id)
    );
  }

  private selectIdleDevice(candidates: PooledDevice[]): PooledDevice | undefined {
    // Find idle devices and prefer most recently released for reuse
    const idleDevices = candidates.filter((device) => this.isIdleDeviceEligible(device));
    if (idleDevices.length === 0) {
      return undefined;
    }

    if (this.lastReleasedDeviceId) {
      const lastReleased = idleDevices.find((d) => d.id === this.lastReleasedDeviceId);
      if (lastReleased) {
        return lastReleased;
      }
    }

    // Sort by lastUsedAt (ascending) to get least recently used device.
    // This provides better load distribution across devices.
    idleDevices.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    return idleDevices[0];
  }

  private getDevicesMatchingAnyRequest(requests: DeviceAllocationRequest[]): PooledDevice[] {
    const devicesById = new Map<string, PooledDevice>();
    for (const request of requests) {
      for (const device of this.getDevicesMatchingCriteria(request.criteria)) {
        devicesById.set(device.id, device);
      }
    }
    return Array.from(devicesById.values());
  }

  private async pruneStaleIdleIosDevices(candidates: PooledDevice[]): Promise<number> {
    return await this.idleDeviceReaper.pruneStaleIdleIosDevices(candidates);
  }

  private assertIdleDeviceAssignable({
    device,
    unavailableMessage,
    readinessReservationOwners,
    snapshot,
  }: TargetDeviceValidationOptions): void {
    this.assertDeviceCleanupComplete(device.id);
    if (device.status !== "idle" || device.sessionId) {
      return;
    }
    if (this.hasReadinessNameReservation(device, readinessReservationOwners)) {
      throw new ActionableError(unavailableMessage);
    }
    if (
      this.recoveryCoordinator.isAndroidRecoveryHandoffReserved(
        device.id,
        readinessReservationOwners,
      )
    ) {
      throw new ActionableError(unavailableMessage);
    }

    if (this.devices.get(device.id) !== device) {
      throw new ActionableError(unavailableMessage);
    }
    this.assertTargetDeviceLiveness({ device, unavailableMessage, snapshot });
  }

  private notifyTargetDeviceReady({
    device,
    snapshot,
  }: {
    device: PooledDevice;
    snapshot: TargetDeviceDiscoverySnapshot;
  }): void {
    if (device !== snapshot.readyNotifiedEntry) {
      this.notifyDeviceReady(device.id);
    }
  }

  private assertTargetDeviceLiveness({
    device,
    unavailableMessage,
    snapshot,
  }: {
    device: Pick<PooledDevice, "id" | "platform">;
    unavailableMessage: string;
    snapshot: TargetDeviceDiscoverySnapshot;
  }): void {
    const iosLiveness = snapshot.iosLiveness;
    const status = this.idleDeviceReaper.getIdleDeviceLivenessStatus(device, iosLiveness);
    if (status === "assignable") {
      return;
    }
    if (status === "stale") {
      // Absence observed before the lock never retires this pool incarnation.
      throw new ActionableError(unavailableMessage);
    }

    const noun = this.idleDeviceReaper.iosDeviceNoun(device.id);
    throw new ActionableError(
      `Unable to verify iOS ${noun} '${device.id}' is still booted before assignment.\n` +
        `iOS ${noun} discovery failed, so AutoMobile did not assign this pooled UDID.`,
    );
  }

  /** Health of the current runtime only; stale incarnations never gate allocation. */
  getDeviceHealthMarker(deviceId: string): DeviceHealthMarker | undefined {
    const incarnation = this.getDeviceIncarnation(deviceId);
    return incarnation === undefined
      ? undefined
      : this.deviceHealthMarkers.get(deviceId, incarnation);
  }

  private assertHealthyAllocationPossible(
    candidates: readonly PooledDevice[],
    selected: PooledDevice | undefined,
  ): void {
    if (selected) {
      return;
    }
    const healthyBusy = candidates.some(
      (device) =>
        !this.getDeviceHealthMarker(device.id) &&
        (device.status === "busy" || this.isReservedForAssignment(device)),
    );
    if (!healthyBusy && candidates.some((device) => this.getDeviceHealthMarker(device.id))) {
      // Health recovery has its own bounded retry budget. Allocation fails
      // promptly; waiting for a session release cannot clean these devices.
      throw this.unhealthyDevicesError(candidates);
    }
  }

  private unhealthyDevicesError(devices: readonly PooledDevice[]): ActionableError {
    const reasons = devices.flatMap((device) => {
      const marker = this.getDeviceHealthMarker(device.id);
      return marker ? [`'${device.id}' (${marker.reason}, since ${marker.since})`] : [];
    });
    const appCleanupRecovery = devices
      .filter((device) => this.getDeviceHealthMarker(device.id)?.reason === "app-cleanup")
      .map(
        (device) =>
          ` Device '${device.id}' is held for app-cleanup: an executePlan app cleanup did not ` +
          "complete and only three background retries are made, so it can stay unavailable " +
          `until it is replaced. Recovery: call killDevice with device { name: '${device.name}', ` +
          `deviceId: '${device.id}', platform: '${device.platform}' }, then startDevice to ` +
          "bring up a fresh device.",
      );
    return new ActionableError(
      `Unhealthy devices cannot be assigned: ${reasons.join(", ")}. ` +
        "Session state could not be restored. Retry after restoration succeeds, manually restore the state, " +
        "or use killDevice/startDevice to replace the device. Automatic erase/reboot is not performed." +
        appCleanupRecovery.join(""),
    );
  }

  /** Exact-device acquisition honors cleanup and health; live-owner reuse stays valid. */
  assertDeviceCleanupComplete(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (
      device &&
      this.getDeviceHealthMarker(deviceId) &&
      (!device.sessionId || !this.sessionManager.getSession(device.sessionId))
    ) {
      throw this.unhealthyDevicesError([device]);
    }
    if (this.sessionManager.hasDeviceCleanupInProgress(deviceId)) {
      throw new ActionableError(
        `Device '${deviceId}' is still completing session cleanup; retry after cleanup finishes.`,
      );
    }
  }

  /**
   * Undo the completed portion of a failed multi-device allocation.
   *
   * The mutex keeps a new allocation from taking ownership between releasing
   * the session and returning its device to the idle pool. The recorded Session
   * object prevents a reused UUID from making this rollback release a replacement
   * allocation.
   */
  private async rollbackAssignments(
    assignments: ReadonlyMap<string, RollbackAssignment>,
  ): Promise<void> {
    await this.assignmentMutex.runExclusive(async () => {
      for (const [sessionId, allocation] of assignments) {
        const { deviceId, session: allocatedSession } = allocation;
        const device = this.devices.get(deviceId);
        if (!device || device.sessionId !== sessionId) {
          logger.warn(
            `[DevicePool] Skipping allocation rollback for ${sessionId}: ` +
              `device ${deviceId} is no longer owned by that session`,
          );
          continue;
        }

        const currentSession = this.sessionManager.getSession(sessionId);
        if (currentSession !== allocatedSession) {
          if (currentSession?.assignedDevice === deviceId) {
            logger.warn(
              `[DevicePool] Preserving replacement session ${sessionId} on ${deviceId} ` +
                `during allocation rollback`,
            );
            continue;
          }
          logger.warn(
            `[DevicePool] Releasing stale allocation of ${deviceId} for replaced session ${sessionId}`,
          );
          await this.releaseDevice(deviceId, sessionId);
          continue;
        }

        if (allocatedSession.assignedDevice !== deviceId) {
          logger.warn(
            `[DevicePool] Preserving session ${sessionId} on ${allocatedSession.assignedDevice} ` +
              `while releasing stale allocation of ${deviceId}`,
          );
          await this.releaseDevice(deviceId, sessionId);
          continue;
        }

        await this.sessionManager.releaseSession(sessionId, "allocation-rollback");
        const replacementSession = this.sessionManager.getSession(sessionId);
        if (replacementSession?.assignedDevice === deviceId) {
          logger.warn(
            `[DevicePool] Preserving replacement session ${sessionId} on ${deviceId} ` +
              `during allocation rollback`,
          );
          continue;
        }
        await this.releaseDevice(deviceId, sessionId);
      }
    });
  }

  private snapshotSessionAssignment(device: PooledDevice): SessionAssignmentSnapshot {
    return {
      sessionId: device.sessionId,
      status: device.status,
      lastUsedAt: device.lastUsedAt,
      assignmentCount: device.assignmentCount,
      errorCount: device.errorCount,
      autolockSessionId: device.autolockSessionId,
    };
  }

  private restoreSessionAssignment(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
  ): void {
    Object.assign(device, snapshot);
  }

  private async createSessionOrRestore(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
    createSession: () => Promise<Session>,
  ): Promise<Session> {
    const attemptedSessionId = device.sessionId;
    try {
      const session = await createSession();
      if (session.assignedDevice !== device.id) {
        if (this.devices.get(device.id) === device && device.sessionId === attemptedSessionId) {
          this.restoreSessionAssignment(device, snapshot);
        }
        return session;
      }
      const currentSession = this.sessionManager.getSession(session.sessionId);
      if (currentSession !== session && currentSession?.assignedDevice === device.id) {
        // The attempted incarnation was replaced while its write completed.
        // Return the attempted object so rollback can preserve the replacement.
        return session;
      }
      await this.sessionManager.waitForSessionRelease(session.sessionId);
      // A tracked process can exit while the durable session write is pending.
      // Do not publish success for a device that eviction already removed or
      // released; undo the just-published session before restoring the pool.
      if (!this.isSessionAssignmentCurrent(device, session)) {
        await this.sessionManager.releaseSession(
          session.sessionId,
          `device-disconnected-during-session-create:${device.id}`,
        );
        throw new ActionableError(
          `Device '${device.id}' disconnected while its session was being created.`,
        );
      }
      this.pooledSessionIdentities.set(device, session);
      return session;
    } catch (error) {
      if (this.devices.get(device.id) === device && device.sessionId === attemptedSessionId) {
        this.restoreSessionAssignment(device, snapshot);
      }
      throw error;
    }
  }

  // createSessionOrRestore / DeviceAutolockManager check the session object and busy
  // assignment, including a held suspect session; automation admission is separate.
  private isSessionAssignmentCurrent(device: PooledDevice, session: Session): boolean {
    return (
      this.isPooledEntryCurrent(device) &&
      device.sessionId === session.sessionId &&
      device.status === "busy" &&
      this.sessionManager.getSession(session.sessionId) === session
    );
  }

  /**
   * Release device from session
   *
   * Called when a session completes or times out.
   * Frees the device so it can be assigned to other sessions.
   */
  async releaseDevice(deviceId: string, expectedSessionId: string): Promise<void> {
    const releasedCapture = this.releasedDeviceCaptures.get(expectedSessionId);
    if (releasedCapture?.deviceId === deviceId) {
      this.releasedDeviceCaptures.delete(expectedSessionId);
      await this.releaseCapturedDevice(
        releasedCapture.device,
        expectedSessionId,
        releasedCapture.assignmentCount,
      );
      return;
    }

    const device = this.devices.get(deviceId);
    if (!device) {
      logger.warn(`Cannot release device ${deviceId}: not in pool`);
      return;
    }
    await this.releaseCapturedDevice(device, expectedSessionId, device.assignmentCount);
  }

  private captureReleasedDevice(sessionId: string, deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device || device.sessionId !== sessionId) {
      return;
    }
    this.releasedDeviceCaptures.set(sessionId, {
      device,
      deviceId,
      assignmentCount: device.assignmentCount,
    });
  }

  private async releaseCapturedDevice(
    device: PooledDevice,
    expectedSessionId: string,
    expectedAssignmentCount: number,
  ): Promise<void> {
    const deviceId = device.id;
    if (!this.isCapturedReleaseCurrent(device, expectedSessionId, expectedAssignmentCount)) {
      return;
    }

    const existingDeferredRelease = this.deferredDeviceReleases.get(deviceId);
    if (existingDeferredRelease) {
      if (
        existingDeferredRelease.device === device &&
        existingDeferredRelease.sessionId === expectedSessionId &&
        existingDeferredRelease.assignmentCount === expectedAssignmentCount
      ) {
        return;
      }
      this.deferredDeviceReleases.delete(deviceId);
    }
    const cleanup = this.sessionManager.getPendingDeviceCleanup(deviceId);
    if (cleanup) {
      const deferredRelease = {
        device,
        sessionId: expectedSessionId,
        assignmentCount: expectedAssignmentCount,
        cleanup,
      };
      this.deferredDeviceReleases.set(deviceId, deferredRelease);
      void cleanup
        .then(() => {
          if (
            this.deferredDeviceReleases.get(deviceId) !== deferredRelease ||
            this.devices.get(deviceId) !== device ||
            device.assignmentCount !== expectedAssignmentCount
          ) {
            return;
          }
          this.deferredDeviceReleases.delete(deviceId);
          return this.releaseCapturedDevice(device, expectedSessionId, expectedAssignmentCount);
        })
        .catch((error) =>
          logger.warn(`Failed to release device ${deviceId} after late session teardown: ${error}`),
        );
      logger.info(`Keeping device ${deviceId} assigned until late session teardown completes`);
      return;
    }

    const sessionId = device.sessionId;
    device.sessionId = null;
    device.status = "idle";
    displayTransitions.reset(deviceId);
    getObserveCacheStore().clear(deviceId);
    device.errorCount = 0;
    this.lastReleasedDeviceId = deviceId;
    this.notifyMultiDeviceAllocationWaiters();

    logger.info(`Released device ${deviceId} from session ${sessionId}`);
  }

  // releaseCapturedDevice checks assignment generation, but permits release after
  // the session has left SessionManager and does not require a busy status.
  private isCapturedReleaseCurrent(
    device: PooledDevice,
    expectedSessionId: string,
    expectedAssignmentCount: number,
  ): boolean {
    const deviceId = device.id;
    if (!this.isPooledEntryCurrent(device)) {
      logger.debug(`Ignoring stale release for replacement device ${deviceId}`);
      return false;
    }
    if (device.assignmentCount !== expectedAssignmentCount) {
      logger.debug(`Ignoring stale release for reassigned device ${deviceId}`);
      return false;
    }
    if (expectedSessionId !== undefined && device.sessionId !== expectedSessionId) {
      logger.warn(
        `Cannot release device ${deviceId}: expected session ${expectedSessionId}, ` +
          `but it is owned by ${device.sessionId ?? "no session"}`,
      );
      return false;
    }

    if (!device.sessionId) {
      logger.debug(`Device ${deviceId} is already idle`);
      return false;
    }

    if (device.sessionId !== expectedSessionId) {
      logger.debug(
        `Ignoring stale release for device ${deviceId}: expected ${expectedSessionId}, owned by ${device.sessionId}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Retire a captured device incarnation without publishing it as idle first.
   * A device that has been explicitly stopped must not become assignable in the
   * interval between its session release and pool removal.
   */
  async retireDeviceForShutdown(
    expectedDevice: PooledDevice,
    options: DeviceRetirementOptions = {},
  ): Promise<boolean> {
    return await this.assignmentMutex.runExclusive(async () => {
      if (this.devices.get(expectedDevice.id) !== expectedDevice) {
        return false;
      }
      await this.runtimeIdentity.cancelRetiredDeviceExecutions(expectedDevice, options);
      if (this.devices.get(expectedDevice.id) !== expectedDevice) {
        return false;
      }
      this.releaseCapturedDeviceForShutdown(expectedDevice);
      await this.removeDevice(expectedDevice.id, false, expectedDevice);
      const retired = !this.devices.has(expectedDevice.id);
      if (retired) {
        this.intentionalShutdowns.delete(expectedDevice.id);
      }
      return retired;
    });
  }

  /**
   * A System UI recovery that has confirmed shutdown but cannot restore the
   * AVD has no usable successor for the session. Release it before retiring
   * the captured connection epoch.
   */
  async retireDeviceAfterSystemUiAnrRecoveryFailure(
    expectedDevice: PooledDevice,
  ): Promise<boolean> {
    let releaseError: unknown;
    if (expectedDevice.sessionId) {
      try {
        await this.releaseDisconnectedRecoverySessionWithRetry(
          expectedDevice.sessionId,
          expectedDevice.id,
          deviceLossCancellationReason(expectedDevice.id),
        );
      } catch (error) {
        releaseError = error;
      }
    }
    const retired = await this.retireDeviceForShutdown(expectedDevice, {
      cancelDeviceBoundExecutions: false,
    });
    if (releaseError) {
      throw releaseError;
    }
    return retired;
  }

  /**
   * Atomically replace a captured stopped-device incarnation with the device
   * discovered under the same ID. This keeps allocators from claiming the old
   * device during the handoff.
   */
  async replaceDeviceForShutdown(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    beforeReplacementPublishes?: () => void,
    options: Pick<DiscoveryReconcileOptions, "excludeExecutionId"> = {},
  ): Promise<PooledDevice | undefined> {
    return await this.assignmentMutex.runExclusive(async () => {
      if (this.devices.get(expectedDevice.id) !== expectedDevice) {
        return undefined;
      }
      // A kill's same-serial successor must not inherit the old device's work.
      // System UI recovery uses its separate session-preserving handoff.
      await this.runtimeIdentity.cancelRetiredDeviceExecutions(expectedDevice, options);
      if (this.devices.get(expectedDevice.id) !== expectedDevice) {
        return undefined;
      }
      this.releaseCapturedDeviceForShutdown(expectedDevice);
      await this.removeDevice(expectedDevice.id, false, expectedDevice);
      if (this.devices.has(expectedDevice.id)) {
        return undefined;
      }
      this.intentionalShutdowns.delete(expectedDevice.id);
      beforeReplacementPublishes?.();
      await this.addDevice(
        replacement,
        this.sourceImageForSameAndroidReplacement(expectedDevice, replacement),
        false,
        this.runtimeIdentity.identityEvidenceForBootedDevice(replacement),
      );
      return this.devices.get(replacement.deviceId);
    });
  }

  /**
   * Replace a stopped Android runtime while retaining the active AutoMobile
   * session. The caller keeps both a shutdown reservation and a stable AVD
   * readiness reservation until this handoff has completed.
   */
  async replaceDeviceForSystemUiAnrRecovery(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
    childProcess?: ChildProcess | null,
    beforeReplacementPublishes?: () => void,
    excludeExecutionId?: string,
  ): Promise<SystemUiAnrRecoveryHandoff> {
    return await this.assignmentMutex.runExclusive(async () => {
      // The caller's marker must cover the entire visible replacement
      // lifecycle, including a replacement that another pool path has already
      // discovered. It is moved before any session rebind or addDevice call.
      beforeReplacementPublishes?.();
      const currentExpectedDevice = this.devices.get(expectedDevice.id);
      const existingReplacement = this.devices.get(replacement.deviceId);
      if (
        currentExpectedDevice !== expectedDevice &&
        (existingReplacement === undefined || existingReplacement === expectedDevice)
      ) {
        throw new ActionableError(
          `Device '${expectedDevice.id}' changed while System UI recovery was in progress.`,
        );
      }
      this.assertSystemUiAnrReplacement(expectedDevice, replacement, sourceImage);

      const preservedSession = this.systemUiAnrRecoverySession(expectedDevice);
      const preservedSessionId = preservedSession?.sessionId;
      const preservedAutolockSessionId = expectedDevice.autolockSessionId;
      let replacementDevice: PooledDevice | undefined;
      try {
        replacementDevice = await this.replaceStoppedDeviceForSystemUiAnr(
          expectedDevice,
          replacement,
          sourceImage,
          beforeReplacementPublishes,
          excludeExecutionId,
        );
        await this.trackStartedDeviceProcess(replacement, childProcess);
        if (this.devices.get(replacementDevice.id) !== replacementDevice) {
          throw new ActionableError(
            `Replacement device '${replacementDevice.id}' exited before its recovery session was rebound.`,
          );
        }
        await this.restoreSystemUiAnrRecoverySession(
          preservedSession,
          expectedDevice.id,
          replacementDevice,
          preservedAutolockSessionId,
        );
      } catch (error) {
        // Once the handoff has detached the original incarnation, roll any
        // replacement back and release the preserved session so caller cleanup
        // cannot leave an idle device mapped to the stopped serial.
        const originalWasDetached =
          this.devices.get(expectedDevice.id) !== expectedDevice ||
          (preservedSession !== undefined && expectedDevice.sessionId === null);
        if (originalWasDetached) {
          await this.rollbackSystemUiAnrRecoveryReplacement(replacementDevice, preservedSession);
        }
        throw error;
      }
      if (!replacementDevice) {
        throw new ActionableError(
          `Replacement device '${replacement.deviceId}' was not retained by the device pool.`,
        );
      }
      this.transferMcpSessionRecoveryLeases(expectedDevice, replacementDevice);
      this.intentionalShutdowns.delete(expectedDevice.id);
      return {
        preservedSessionId,
        replacementDevice,
        validatePreservedSession: async () => {
          await this.validateSystemUiAnrRecoverySession(preservedSession, replacementDevice);
        },
      };
    });
  }

  private async validateSystemUiAnrRecoverySession(
    preservedSession: Session | undefined,
    replacementDevice: PooledDevice,
  ): Promise<void> {
    if (!preservedSession) {
      return;
    }
    await this.assignmentMutex.runExclusive(() => {
      if (
        this.devices.get(replacementDevice.id) !== replacementDevice ||
        replacementDevice.sessionId !== preservedSession.sessionId ||
        replacementDevice.status !== "busy" ||
        this.sessionManager.getSession(preservedSession.sessionId) !== preservedSession ||
        preservedSession.assignedDevice !== replacementDevice.id
      ) {
        throw new ActionableError(
          `Session '${preservedSession.sessionId}' was released while System UI recovery was becoming ready.`,
        );
      }
    });
  }

  private async rollbackSystemUiAnrRecoveryReplacement(
    replacementDevice: PooledDevice | undefined,
    preservedSession: Session | undefined,
  ): Promise<void> {
    if (replacementDevice) {
      await this.removeDevice(replacementDevice.id, false, replacementDevice);
    }
    if (
      preservedSession &&
      this.sessionManager.getSession(preservedSession.sessionId) === preservedSession
    ) {
      await this.retrySessionRelease(
        preservedSession.sessionId,
        preservedSession.assignedDevice,
        () =>
          this.sessionManager.releaseSessionIfOwned(
            preservedSession.sessionId,
            preservedSession,
            preservedSession.assignedDevice,
            deviceLossCancellationReason(replacementDevice?.id ?? preservedSession.assignedDevice),
          ),
      );
    }
  }

  private assertSystemUiAnrReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
  ): void {
    if (
      expectedDevice.platform !== "android" ||
      replacement.platform !== "android" ||
      sourceImage.platform !== "android" ||
      replacement.name !== sourceImage.name
    ) {
      throw new ActionableError(
        `System UI recovery must replace Android AVD '${sourceImage.name}' with the same runtime.`,
      );
    }
  }

  private systemUiAnrRecoverySession(expectedDevice: PooledDevice): Session | undefined {
    const sessionId = expectedDevice.sessionId;
    const session = sessionId ? this.sessionManager.getSession(sessionId) : null;
    if (
      session === null ||
      session.assignedDevice !== expectedDevice.id ||
      session.platform !== "android"
    ) {
      return undefined;
    }
    return session;
  }

  private async replaceStoppedDeviceForSystemUiAnr(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
    beforeReplacementPublishes?: () => void,
    excludeExecutionId?: string,
  ): Promise<PooledDevice> {
    const priorAssignmentCount = expectedDevice.assignmentCount;
    const priorLastUsedAt = expectedDevice.lastUsedAt;
    const existingReplacement = this.devices.get(replacement.deviceId);

    if (existingReplacement && existingReplacement !== expectedDevice) {
      this.assertPooledSystemUiAnrReplacement(existingReplacement, sourceImage);
      if (this.devices.get(expectedDevice.id) === expectedDevice) {
        await this.cancelOldDeviceWorkForSystemUiAnr(expectedDevice.id, excludeExecutionId);
        this.releaseCapturedDeviceForShutdown(expectedDevice);
        await this.removeDevice(expectedDevice.id, false, expectedDevice);
      }
      return await this.adoptSystemUiAnrReplacement(
        existingReplacement,
        sourceImage,
        priorAssignmentCount,
        priorLastUsedAt,
      );
    }

    // removeDevice rejects busy entries, so detach pool ownership only after
    // capturing any session that must be rebound below. The replacement remains
    // unavailable through the caller's readiness reservation while this runs.
    await this.cancelOldDeviceWorkForSystemUiAnr(expectedDevice.id, excludeExecutionId);
    this.releaseCapturedDeviceForShutdown(expectedDevice);
    await this.removeDevice(expectedDevice.id, false, expectedDevice);
    if (this.devices.has(replacement.deviceId)) {
      throw new ActionableError(
        `Replacement device '${replacement.deviceId}' was already added to the device pool.`,
      );
    }

    await this.addDevice(
      replacement,
      sourceImage,
      false,
      this.runtimeIdentity.identityEvidenceForBootedDevice(replacement),
    );
    const replacementDevice = this.devices.get(replacement.deviceId);
    if (!replacementDevice) {
      throw new ActionableError(
        `Replacement device '${replacement.deviceId}' was not retained by the device pool.`,
      );
    }
    replacementDevice.assignmentCount = priorAssignmentCount;
    replacementDevice.lastUsedAt = priorLastUsedAt;
    return replacementDevice;
  }

  private async cancelOldDeviceWorkForSystemUiAnr(
    deviceId: string,
    excludeExecutionId?: string,
  ): Promise<void> {
    if (excludeExecutionId === undefined) {
      logger.warn(
        `[DevicePool] Left old-device work running for ${deviceId} because the System UI ANR recovery execution is unknown`,
      );
      return;
    }
    await this.cancelDeviceSessionExecutions.cancelDeviceExecutions?.(
      deviceId,
      deviceLossCancellationReason(deviceId),
      { excludeExecutionId },
    );
  }

  private assertPooledSystemUiAnrReplacement(
    replacement: PooledDevice,
    sourceImage: DeviceInfo,
  ): void {
    if (
      replacement.platform !== "android" ||
      sourceImage.platform !== "android" ||
      replacement.name !== sourceImage.name
    ) {
      throw new ActionableError(
        `System UI recovery replacement '${replacement.id}' does not match Android AVD '${sourceImage.name}'.`,
      );
    }
    if (replacement.status !== "idle" || replacement.sessionId !== null) {
      throw new ActionableError(
        `System UI recovery replacement '${replacement.id}' is already assigned to a session.`,
      );
    }
  }

  private async adoptSystemUiAnrReplacement(
    replacementDevice: PooledDevice,
    sourceImage: DeviceInfo,
    priorAssignmentCount: number,
    priorLastUsedAt: number,
  ): Promise<PooledDevice> {
    this.recordSourceAndroidAvd(replacementDevice.id, sourceImage);
    replacementDevice.assignmentCount = priorAssignmentCount;
    replacementDevice.lastUsedAt = priorLastUsedAt;
    return replacementDevice;
  }

  private async restoreSystemUiAnrRecoverySession(
    session: Session | undefined,
    originalDeviceId: string,
    replacementDevice: PooledDevice,
    autolockSessionId: string | undefined,
  ): Promise<void> {
    if (!session) {
      return;
    }
    if (
      this.sessionManager.getSession(session.sessionId) !== session ||
      session.assignedDevice !== originalDeviceId
    ) {
      throw new ActionableError(
        `Session '${session.sessionId}' was released while System UI recovery was in progress.`,
      );
    }
    const reboundSession = await this.sessionManager.rebindSessionForTerminalReleaseRecovery(
      session,
      replacementDevice.id,
      replacementDevice.platform,
    );
    if (
      this.devices.get(replacementDevice.id) !== replacementDevice ||
      reboundSession !== session ||
      reboundSession.assignedDevice !== replacementDevice.id
    ) {
      throw new ActionableError(
        `Replacement device '${replacementDevice.id}' disconnected while its recovery session was being rebound.`,
      );
    }
    replacementDevice.sessionId = session.sessionId;
    replacementDevice.status = "busy";
    this.pooledSessionIdentities.set(replacementDevice, session);
    // addDevice leaves autolockSessionId undefined, which assertAutolockAccess
    // reads as "unlocked" and would let any session drive the recovered device
    // while the mcpSessionAutolockMap still points at the original. Carry the
    // lock forward so the original session keeps exclusive access.
    replacementDevice.autolockSessionId = autolockSessionId;
    replacementDevice.lastUsedAt = this.nextLastUsedAt();
  }

  private sourceImageForSameAndroidReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
  ): DeviceInfo | undefined {
    if (
      expectedDevice.platform !== "android" ||
      replacement.platform !== "android" ||
      !expectedDevice.avdName ||
      !expectedDevice.androidImage ||
      replacement.name !== expectedDevice.avdName ||
      !this.criteriaMatcher.androidRediscoveryMatches(
        replacement,
        expectedDevice.id,
        expectedDevice.avdName,
      )
    ) {
      return undefined;
    }
    return expectedDevice.androidImage;
  }

  private releaseCapturedDeviceForShutdown(device: PooledDevice): void {
    device.sessionId = null;
    device.status = "idle";
    device.errorCount = 0;
    this.lastReleasedDeviceId = device.id;
  }

  reserveDeviceForReadiness(
    deviceId: string,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
    stableRuntimeName = expectedIdentity.name,
    verifiedAndroidAvdName?: string,
    autolockClient?: AutolockClient,
    enforceAndroidRecoveryExclusion = false,
  ): Promise<DeviceReadinessReservation> {
    return this.shutdownReservationCoordinator.reserveDeviceForReadiness(
      deviceId,
      expectedIdentity,
      stableRuntimeName,
      verifiedAndroidAvdName,
      autolockClient,
      enforceAndroidRecoveryExclusion,
    );
  }

  reserveDeviceForShutdown(
    deviceId: string,
    abortSignal?: AbortSignal,
    autolockClient?: AutolockClient,
  ): Promise<ShutdownDeviceReservation | undefined> {
    return this.shutdownReservationCoordinator.reserveDeviceForShutdown(
      deviceId,
      abortSignal,
      autolockClient,
    );
  }

  private isReservedForReadiness(deviceId: string): boolean {
    return this.shutdownReservationCoordinator.isReservedForReadiness(deviceId);
  }

  private hasReadinessNameReservation(
    device: PooledDevice,
    readinessReservationOwners?: ReadonlySet<symbol>,
  ): boolean {
    return this.shutdownReservationCoordinator.hasReadinessNameReservation(
      device,
      readinessReservationOwners,
    );
  }

  private isReservedForShutdown(device: PooledDevice): boolean {
    return this.shutdownReservationCoordinator.isReservedForShutdown(device);
  }

  private assertReadinessReservationOwner(
    device: PooledDevice,
    client: AutolockClient | undefined,
  ): void {
    const session = device.sessionId ? this.sessionManager.getSession(device.sessionId) : null;
    if (!session) {
      return;
    }
    if (device.autolockSessionId) {
      this.autolockManager.getOwnedAutolockSession(device, client);
      return;
    }
    this.assertMcpSessionOwnsDeviceSession(client?.mcpSessionId, session, device);
  }

  private assertAndroidRecoveryExclusionForReadinessReservation(
    device: PooledDevice | undefined,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform">,
    stableRuntimeName: string,
    enforceAndroidRecoveryExclusion: boolean,
  ): void {
    if (!enforceAndroidRecoveryExclusion || expectedIdentity.platform !== "android") {
      return;
    }
    const recoveryTargets = this.getRecoveringAndroidTargets();
    const isRecoveringName = [device?.name, expectedIdentity.name, stableRuntimeName].some(
      (identifier) => identifier !== undefined && recoveryTargets.names.has(identifier),
    );
    const isRecoveringSerial =
      this.runtimeIdentity.hasUnresolvedEmulatorName(expectedIdentity) &&
      [device?.id, expectedIdentity.deviceId].some(
        (identifier) => identifier !== undefined && recoveryTargets.serials.has(identifier),
      );
    const isRecoveringCurrentPooledDevice =
      device?.id === expectedIdentity.deviceId &&
      device.name === expectedIdentity.name &&
      recoveryTargets.serials.has(device.id);
    const isRecoveringTarget =
      isRecoveringName || isRecoveringSerial || isRecoveringCurrentPooledDevice;
    if (!isRecoveringTarget) {
      return;
    }
    throw new ActionableError(
      `Android device '${expectedIdentity.name}' entered recovery while awaiting its readiness reservation; retry the request.`,
    );
  }

  private reserveShutdownSessionIdentity(deviceId: string): ShutdownIdentityReservation {
    const device = this.devices.get(deviceId);
    if (device && this.shutdownReservationCoordinator.isReservedForShutdown(device)) {
      throw new ActionableError(`Device '${deviceId}' is already shutting down.`);
    }
    const candidate = device ? this.pooledSessionIdentities.get(device) : undefined;
    const session =
      candidate !== undefined &&
      candidate.sessionId === device?.sessionId &&
      candidate.assignedDevice === deviceId &&
      this.sessionManager.isLatestSessionIdentity(candidate)
        ? candidate
        : undefined;
    return {
      device,
      assignmentCount: device?.assignmentCount,
      session,
      releaseSession: session
        ? this.sessionManager.reserveSessionForTerminalRelease(session, deviceId)
        : undefined,
    };
  }

  private reserveMcpSessionRecoveryLease(
    mcpSessionId: string | undefined,
    device: PooledDevice,
    token: symbol | undefined,
  ): void {
    if (!mcpSessionId || token === undefined) {
      return;
    }
    if (this.mcpSessionRecoveryDevices.has(mcpSessionId)) {
      throw new ActionableError(`MCP session '${mcpSessionId}' is already recovering a device.`);
    }
    this.mcpSessionRecoveryDevices.set(mcpSessionId, { device, token });
  }

  private releaseMcpSessionRecoveryLease(
    mcpSessionId: string | undefined,
    token: symbol | undefined,
  ): void {
    if (
      mcpSessionId &&
      token !== undefined &&
      this.mcpSessionRecoveryDevices.get(mcpSessionId)?.token === token
    ) {
      this.mcpSessionRecoveryDevices.delete(mcpSessionId);
    }
  }

  private transferMcpSessionRecoveryLeases(
    previous: PooledDevice,
    replacement: PooledDevice,
  ): void {
    for (const [mcpSessionId, lease] of this.mcpSessionRecoveryDevices) {
      if (lease.device === previous) {
        this.mcpSessionRecoveryDevices.set(mcpSessionId, { ...lease, device: replacement });
      }
    }
  }

  private completeShutdownSessionIdentity(
    deviceId: string,
    device: PooledDevice,
    identity: ShutdownIdentityReservation,
  ): void {
    if (identity.session) {
      return;
    }
    const session = this.pooledSessionIdentities.get(device);
    if (
      session?.sessionId !== device.sessionId ||
      session.assignedDevice !== deviceId ||
      // Every production assignment path holds assignmentMutex. Once this
      // callback owns it, an outer getOrCreateSession assignment can only be
      // awaiting its finally cleanup; it can no longer publish device state.
      !this.sessionManager.isLatestSessionIdentity(session, {
        ignorePendingAssignment: true,
      })
    ) {
      return;
    }
    identity.session = session;
    identity.releaseSession = this.sessionManager.reserveSessionForTerminalRelease(
      session,
      deviceId,
    );
  }

  /** Conservative, read-only admission for session-less hierarchy service setup. */
  isSafeForObservationServiceStart(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.sessionId || device.status !== "idle") {
      return false;
    }
    const stableId = this.stableDeviceIdFor(device);
    if (stableId === undefined) {
      return false;
    }
    const recovery = this.getRecoveringAndroidTargets();
    const blocked = [
      this.assignmentMutex.isLocked(),
      this.isReservedForAssignment(device),
      this.deferredDeviceReleases.has(deviceId),
      this.sessionManager.hasDeviceCleanupInProgress(deviceId),
      this.sessionManager.getSessionForDevice(deviceId) !== null,
      !!this.getDeviceHealthMarker(deviceId),
      !!device.identityUnresolved,
      !!device.identityReconcileOwner,
      !!device.adbServerResetSessionId,
      device.platform === "android" &&
        this.adbServerResetQuarantine.isLeasedForAndroidStartup(stableId),
      recovery.serials.has(deviceId),
      recovery.names.has(device.name),
      recovery.names.has(stableId),
      Array.from(this.recoveringSessionLosses.values()).some(
        (record) => record.deviceId === deviceId && record.state !== "finalized",
      ),
      Array.from(this.mcpSessionRecoveryDevices.values()).some((lease) => lease.device === device),
      this.lifecycleCoordinator.isReserved({ kind: "stable", platform: device.platform, stableId }),
      this.lifecycleCoordinator.isReserved({
        kind: "selector",
        platform: device.platform,
        selector: device.name,
      }),
    ];
    return !blocked.some(Boolean);
  }

  private isReservedForAssignment(device: PooledDevice): boolean {
    return (
      this.isReservedForReadiness(device.id) ||
      this.hasReadinessNameReservation(device) ||
      this.recoveryCoordinator.isAndroidRecoveryHandoffReserved(device.id) ||
      this.isReservedForShutdown(device) ||
      this.shutdownReservationCoordinator.isDeviceUnderShutdown(device.id)
    );
  }

  private assertNotReservedForShutdown(device: PooledDevice, unavailableMessage: string): void {
    if (this.isReservedForShutdown(device)) {
      throw new ActionableError(unavailableMessage);
    }
  }

  /**
   * Bind a known device to a session without running the pool's idle-device
   * selection. If the device is already bound to a live session, reuse that
   * session so repeated startDevice calls stay idempotent.
   */
  async bindOrReuseDeviceSession(
    sessionId: string,
    deviceId: string,
    platform: Platform,
    sourceImage?: DeviceInfo,
    childProcess?: ChildProcess | null,
    expectedIdentity?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
    allowSessionRebind = false,
    readinessReservationOwners?: ReadonlySet<symbol>,
    verifiedAndroidAvdIdentity?: DeviceInfo,
    expectedExistingSessionDeviceId?: string,
    mcpSessionId?: string,
  ): Promise<string> {
    return await this.withTargetDeviceDiscovery({
      deviceId,
      sourceImage: verifiedAndroidAvdIdentity ?? sourceImage,
      unavailableMessage: `Device '${deviceId}' is not available in the device pool.`,
      platform,
      operation: async (snapshot) => {
        throwIfRequestAborted();
        const androidAvdIdentity = verifiedAndroidAvdIdentity ?? sourceImage;
        const alreadyPooled = snapshot.capturedEntry !== undefined;
        let device = this.devices.get(deviceId);
        if (!device) {
          throw new ActionableError(`Device '${deviceId}' is not available in the device pool.`);
        }
        this.runtimeIdentity.assertRuntimeIdentity(device, expectedIdentity);
        this.assertNotReservedForShutdown(
          device,
          `Device '${deviceId}' is shutting down and cannot be assigned.`,
        );
        if (alreadyPooled) {
          this.recordSourceAndroidAvd(deviceId, androidAvdIdentity);
          this.notifyTargetDeviceReady({ device, snapshot });
        }
        await this.trackStartedDeviceProcess(
          {
            deviceId: device.id,
            name: device.name,
            platform: device.platform,
          },
          childProcess,
        );
        if (this.devices.get(deviceId) !== device) {
          throw new ActionableError(`Device '${deviceId}' exited before it could be assigned.`);
        }
        this.assertIdleDeviceAssignable({
          device,
          unavailableMessage: `Device '${deviceId}' is not available in the device pool.`,
          readinessReservationOwners,
          snapshot,
        });

        const validatedDevice = await this.validateOrReloadIdlePooledDevice({
          device,
          expectedIdentity,
          unavailableMessage:
            `Device '${deviceId}' is not available in the device pool. ` +
            "It may have been shut down or disconnected.",
          readinessReservationOwners,
          snapshot,
        });
        if (!validatedDevice) {
          return undefined;
        }
        device = validatedDevice;

        throwIfRequestAborted();
        if (this.devices.get(deviceId) !== device) {
          return undefined;
        }
        this.assertDeviceCleanupComplete(deviceId);
        if (device.sessionId) {
          const existingSession = this.sessionManager.getSession(device.sessionId);
          if (
            existingSession &&
            existingSession.assignedDevice === deviceId &&
            existingSession.platform === device.platform
          ) {
            this.assertExistingRecoverySessionOwner(
              existingSession,
              sessionId,
              deviceId,
              expectedExistingSessionDeviceId,
            );
            const confirmedSameOwner = this.assertMcpSessionOwnsDeviceSession(
              mcpSessionId,
              existingSession,
              device,
            );
            return this.reuseExistingDeviceSession(
              deviceId,
              existingSession.sessionId,
              sourceImage,
              confirmedSameOwner,
            );
          }

          if (existingSession) {
            throw new ActionableError(
              `Device '${deviceId}' is already assigned to session ${device.sessionId}.`,
            );
          }

          // Looking up an expired owner may itself start its release.
          this.assertDeviceCleanupComplete(deviceId);
          device.sessionId = null;
          device.status = "idle";
        }

        const assignmentSnapshot = this.snapshotSessionAssignment(device);
        const previousSession = this.sessionManager.getSession(sessionId);
        this.assertExpectedRecoverySession(
          previousSession,
          sessionId,
          deviceId,
          platform,
          expectedExistingSessionDeviceId,
        );
        device.sessionId = sessionId;
        device.status = "busy";
        device.lastUsedAt = this.nextLastUsedAt();
        device.assignmentCount++;
        device.errorCount = 0;

        await this.createSessionOrRestore(
          device,
          assignmentSnapshot,
          this.createSessionForBinding(
            previousSession,
            sessionId,
            deviceId,
            platform,
            allowSessionRebind,
            this.stableDeviceIdFor(device),
          ),
        );
        this.recordMcpSessionOwnership(mcpSessionId, sessionId);
        logger.info(`Bound device ${deviceId} to session ${sessionId}`);
        return sessionId;
      },
    });
  }

  private assertExpectedRecoverySession(
    session: Session | null,
    sessionId: string,
    deviceId: string,
    platform: Platform,
    expectedDeviceId: string | undefined,
  ): void {
    if (
      expectedDeviceId !== undefined &&
      (!session || session.assignedDevice !== expectedDeviceId || session.platform !== platform)
    ) {
      throw new ActionableError(
        `Session '${sessionId}' changed while device '${deviceId}' was recovering.`,
      );
    }
  }

  private assertExistingRecoverySessionOwner(
    session: Session,
    sessionId: string,
    deviceId: string,
    expectedDeviceId: string | undefined,
  ): void {
    if (expectedDeviceId !== undefined && session.sessionId !== sessionId) {
      throw new ActionableError(
        `Session '${sessionId}' changed while device '${deviceId}' was recovering.`,
      );
    }
  }

  /** Snapshot first, then serialize assertions and claim; replacements retry unlocked. */
  private async withTargetDeviceDiscovery({
    deviceId,
    sourceImage,
    unavailableMessage,
    platform,
    operation,
  }: TargetDeviceDiscoveryOptions): Promise<string> {
    let staleRetries = 0;
    let readyNotifiedEntry: PooledDevice | undefined;
    while (true) {
      throwIfRequestAborted();
      const capturedEntry = this.devices.get(deviceId);
      const removalFence = this.refreshCoordinator.captureDeviceRemovalFence(deviceId);
      const shutdownMarker = this.intentionalShutdowns.get(deviceId);
      const shutdownReserved = this.shutdownReservationCoordinator.isDeviceUnderShutdown(deviceId);
      let result: string | undefined;
      try {
        const snapshot = await raceWithDeadline(
          async (): Promise<TargetDeviceDiscoverySnapshot> => {
            const targetPlatform = capturedEntry?.platform ?? platform;
            if (targetPlatform === "android") {
              const androidPresence = await this.takeFreshPresenceDiscovery("android");
              return { capturedEntry, androidPresence, bootedDevices: androidPresence.devices };
            }
            if (capturedEntry) {
              return {
                capturedEntry,
                iosLiveness: await this.idleDeviceReaper.getIosLivenessSnapshot(),
              };
            }
            const discovery = await this.takeFreshPresenceDiscovery("ios");
            return {
              capturedEntry,
              bootedDevices: discovery.devices,
              iosLiveness: await this.idleDeviceReaper.getIosLivenessSnapshot({ discovery }),
            };
          },
          { timer: this.timer, signal: getAbortSignal(), label: "Exact device discovery" },
        );
        snapshot.readyNotifiedEntry = readyNotifiedEntry;
        result = await this.assignmentMutex.runExclusive(async () => {
          throwIfRequestAborted();
          if (this.devices.get(deviceId) !== capturedEntry) {
            return undefined;
          }
          if (capturedEntry) {
            return operation(snapshot);
          }
          // Undefined -> added -> retired -> undefined is also a changed incarnation.
          // Refuse before addDevice can clear a recorded intentional shutdown.
          if (
            removalFence.wasRemoved() ||
            shutdownReserved ||
            this.shutdownReservationCoordinator.isDeviceUnderShutdown(deviceId) ||
            shutdownMarker !== this.intentionalShutdowns.get(deviceId) ||
            shutdownMarker !== undefined
          ) {
            throw new ActionableError(unavailableMessage);
          }
          // A failed iOS source may return no target or a retained last-good
          // target. Either way, it cannot authorize a new pooled assignment.
          if (platform === "ios") {
            this.assertTargetDeviceLiveness({
              device: { id: deviceId, platform },
              unavailableMessage,
              snapshot,
            });
          }
          const booted = snapshot.bootedDevices?.find((device) => device.deviceId === deviceId);
          if (booted) {
            const addition = this.addDevice(
              booted,
              sourceImage,
              true,
              this.runtimeIdentity.identityEvidenceForBootedDevice(booted),
            );
            const addedEntry = this.devices.get(deviceId);
            await addition;
            readyNotifiedEntry = addedEntry;
            if (this.devices.get(deviceId) !== addedEntry) {
              return undefined;
            }
          }
          return operation(snapshot);
        });
      } finally {
        removalFence.release();
      }
      if (result !== undefined) {
        return result;
      }
      if (staleRetries++ >= ALLOCATION_SNAPSHOT_STALE_RETRIES) {
        throw new ActionableError(unavailableMessage);
      }
    }
  }

  private async validateOrReloadIdlePooledDevice(
    options: TargetDeviceValidationOptions,
  ): Promise<PooledDevice | undefined> {
    const { device, expectedIdentity, unavailableMessage, snapshot } = options;
    const presence = snapshot.androidPresence;
    // Existing pooled targets retain on source failure. A just-installed target
    // cannot use a failed confirmation pass as identity evidence. Authoritative
    // absence also stops before the liveness helper's eviction/recovery branch.
    if (
      presence &&
      (didSourceSucceedForDevice(presence, device.platform, device.id)
        ? !presence.devices.some((booted) => booted.deviceId === device.id)
        : snapshot.readyNotifiedEntry !== undefined)
    ) {
      throw new ActionableError(unavailableMessage);
    }
    // iOS uses the per-source liveness snapshot; Android reconciles the supplied evidence.
    if (await this.ensurePooledDevicePresentForUse(device, true, true, false, presence)) {
      if (this.devices.get(device.id) !== device) {
        return undefined;
      }
      this.assertIdleDeviceAssignable(options);
      // A reusable serial's initial listing predates installation in the pool.
      // Confirm it with a fresh unlocked pass before handing out the entry.
      if (!snapshot.capturedEntry && this.missingDeviceLiveness.hasReusableSerial(device)) {
        return undefined;
      }
      return device;
    }
    const replacement = this.devices.get(device.id);
    if (!replacement || (replacement === device && device.status === "error")) {
      throw new ActionableError(unavailableMessage);
    }
    if (replacement.identityUnresolved === true) {
      throw new ActionableError(
        this.runtimeIdentity.describeUnresolvedPooledIdentity(
          replacement,
          "Refusing to assign device",
        ),
      );
    }
    this.runtimeIdentity.assertRuntimeIdentity(replacement, expectedIdentity);
    // Reconciliation's replacement cannot inherit the captured entry's evidence.
    // Retry outside the mutex before judging or claiming that incarnation.
    return undefined;
  }

  private createSessionForBinding(
    previousSession: Session | null,
    sessionId: string,
    deviceId: string,
    platform: Platform,
    allowSessionRebind: boolean,
    stableDeviceId: string | undefined,
  ): () => Promise<Session> {
    const previousDeviceId = previousSession?.assignedDevice;
    if (!previousDeviceId || previousDeviceId === deviceId) {
      return async () => {
        const session = await this.sessionManager.createSession(
          sessionId,
          deviceId,
          platform,
          undefined,
          undefined,
          stableDeviceId,
        );
        if (previousSession && platform === "android") {
          this.sessionManager.invalidateAutomationReadiness(
            sessionId,
            "same-serial Android device recovery",
          );
        }
        return session;
      };
    }

    if (!allowSessionRebind) {
      return async () => {
        throw new ActionableError(
          `Session '${sessionId}' is already assigned to device '${previousDeviceId}'.`,
        );
      };
    }

    return async () => {
      const previousDevice = this.devices.get(previousDeviceId);
      const wasAutolocked = previousDevice?.autolockSessionId === sessionId;
      const replacement = this.devices.get(deviceId);
      if (wasAutolocked && replacement?.sessionId === sessionId) {
        replacement.autolockSessionId = sessionId;
      }
      const session = await this.sessionManager.rebindSession(sessionId, deviceId, platform, {
        stableDeviceId,
      });
      if (previousDevice) {
        this.autolockManager.clearRebindAutolockLock(sessionId, previousDeviceId, previousDevice);
      }
      await this.cancelOldDeviceWorkForRebind(previousDeviceId, sessionId);
      await this.releaseDevice(previousDeviceId, sessionId);
      return session;
    };
  }

  /**
   * Stop work still driving the device a session just left, and wait for it to
   * settle, before the device returns to the pool as idle (#9944). The caller
   * (`setActiveDevice`) is excluded so the rebind does not cancel itself; the
   * injected canceller drains with its own bounded, timer-injected wait.
   */
  private async cancelOldDeviceWorkForRebind(
    previousDeviceId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      // Scoped to this session: another session's or a sessionless read on the
      // still-booted old device must keep running.
      const cancelled =
        (await this.cancelDeviceSessionExecutions.cancelDeviceExecutions?.(
          previousDeviceId,
          new ActionableError(
            `Session ${sessionId} was rebound from device '${previousDeviceId}' to another device ` +
              "by setActiveDevice; this call was cancelled because it was still driving the old device.",
          ),
          {
            excludeExecutionId: this.ambientExecutionIdReader?.getExecutionId(),
            onlySessionUuid: sessionId,
          },
        )) ?? 0;
      if (cancelled > 0) {
        logger.info(
          `[DevicePool] Cancelled ${cancelled} in-flight execution(s) on ${previousDeviceId} ` +
            `after session ${sessionId} rebound to another device`,
        );
      }
    } catch (error) {
      // Rebind already committed; a failed cancel must not strand the old device.
      logger.warn(
        `[DevicePool] Failed to cancel work on ${previousDeviceId} after rebinding session ${sessionId}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async reuseExistingDeviceSession(
    deviceId: string,
    existingSessionId: string,
    sourceImage?: DeviceInfo,
    confirmedSameOwner = false,
  ): Promise<string> {
    if (sourceImage && !confirmedSameOwner) {
      throw new ActionableError(
        `Freshly started device '${deviceId}' was assigned to session ` +
          `${existingSessionId} before its owning session could reserve it.`,
      );
    }
    const refreshedSession = await this.sessionManager.getOrCreateSession(existingSessionId);
    logger.info(`Reusing existing session ${refreshedSession.sessionId} for device ${deviceId}`);
    return refreshedSession.sessionId;
  }

  /** Assert any supplied MCP identity and return whether same-owner reuse was proven. */
  private assertMcpSessionOwnsDeviceSession(
    mcpSessionId: string | undefined,
    session: Session,
    device: PooledDevice,
  ): boolean {
    if (mcpSessionId === undefined) {
      return false;
    }
    if (
      !this.mcpSessionAcquiredDeviceSessions.get(mcpSessionId)?.has(session.sessionId) ||
      !this.isSessionAssignmentCurrent(device, session) ||
      !this.sessionManager.isAdmittedForAutomation(session)
    ) {
      throw new ActionableError(
        `Device '${device.id}' is already assigned to another session. ` +
          "Acquire a different device or wait for its owner to release it.",
      );
    }
    return true;
  }

  private recordMcpSessionOwnership(mcpSessionId: string | undefined, sessionId: string): void {
    if (!mcpSessionId) {
      return;
    }
    const acquired = this.mcpSessionAcquiredDeviceSessions.get(mcpSessionId) ?? new Set<string>();
    acquired.add(sessionId);
    this.mcpSessionAcquiredDeviceSessions.set(mcpSessionId, acquired);
  }

  /**
   * The per-entry body of the refresh sweep, which — unlike
   * {@link reconcileDiscoveryObservation} — owns pool membership and so installs
   * the replacement a disagreeing observation calls for. Returns whether the
   * runtime was REPLACED, which the sweep counts as an add.
   */
  private async foldObservationIntoPooledEntry(
    pooled: PooledDevice,
    device: BootedDevice,
    metadataSource: MutableMetadataSource,
  ): Promise<boolean> {
    let entry: PooledDevice | undefined = pooled;
    let runtimeReplaced = false;
    let replacementDeferred = false;
    // A newer funnel observation may have confirmed this entry while the refresh was in flight.
    // Check before replacement, since eviction cannot be undone by later identity reconciliation.
    if (this.runtimeIdentity.comparePooledIdentityEvidence(pooled, device) === "stale") {
      return false;
    }
    if (!this.runtimeIdentity.matchesRuntimeIdentity(pooled, device)) {
      runtimeReplaced = await this.replacePooledDeviceForRuntimeIdentity(pooled, device);
      entry = this.devices.get(device.deviceId);
      replacementDeferred = !runtimeReplaced && entry === pooled;
    }
    if (!entry) {
      return runtimeReplaced;
    }
    entry.iosVersion = device.iosVersion;
    if (replacementDeferred) {
      // The entry the pool still holds is the one this observation DISAGREES
      // with, so neither its metadata nor its identity may be updated from it.
      await this.runtimeIdentity.quarantineDisagreeingPooledIdentity(
        entry,
        device,
        "and its replacement could not be installed yet",
      );
      return runtimeReplaced;
    }
    this.runtimeIdentity.applyMutableRuntimeMetadata(entry, device, metadataSource);
    await this.runtimeIdentity.reconcilePooledIdentityResolution(entry, device);
    return runtimeReplaced;
  }

  reconcileDiscoveryObservation(
    devices: readonly BootedDevice[],
    source: string,
    options: DiscoveryReconcileOptions = {},
  ): Promise<void> {
    return this.runtimeIdentity.reconcileDiscoveryObservation(devices, source, options);
  }

  /** Explicit routing state shared with adb clients; no process-global alias cache. */
  getAndroidTransportRouting(): AndroidTransportRouting {
    return this.androidTransportAliases;
  }

  getAndroidTransportAliases(deviceId: string): string[] {
    return this.androidTransportAliases.aliases(deviceId);
  }

  getAndroidTransportAvdName(deviceId: string): string | undefined {
    return this.androidTransportAliases.avdName(deviceId);
  }

  mapAndroidDiscovery(devices: readonly BootedDevice[]): BootedDevice[] {
    return this.androidTransportAliases.mapDiscovery(devices);
  }

  private isPooledAndroidEmulator(deviceId: string): boolean {
    return (
      isAndroidEmulatorSerial(deviceId) ||
      this.androidTransportAliases.avdName(deviceId) !== undefined
    );
  }

  needsAndroidTransportNormalization(devices: readonly BootedDevice[]): boolean {
    return this.androidTransportAliases.needsNormalization(devices);
  }

  async normalizeAndroidDiscovery(
    devices: readonly BootedDevice[],
    assignmentLockHeld = false,
    isCurrent: () => boolean = () => true,
    completeAndroidSnapshot = true,
  ): Promise<BootedDevice[]> {
    if (
      !this.needsAndroidTransportNormalization(devices) ||
      (!completeAndroidSnapshot && devices.every((device) => device.platform !== "android"))
    ) {
      return [...devices];
    }
    const observation = ++this.androidAliasObservation;
    const retirement = this.androidAliasRetirement;
    const evidence = await this.androidTransportAliases.prepare(devices);
    const fold = () => {
      if (!isCurrent()) {
        return [];
      }
      if (observation < this.androidAliasAppliedObservation) {
        return [...this.androidAliasAppliedDevices];
      }
      if (retirement !== this.androidAliasRetirement) {
        return this.mapAndroidDiscovery(devices);
      }
      this.androidAliasAppliedObservation = observation;
      const normalized = this.androidTransportAliases.fold(
        devices,
        evidence,
        new Set(this.devices.keys()),
        completeAndroidSnapshot,
      );
      this.androidAliasAppliedDevices = normalized;
      return normalized;
    };
    return assignmentLockHeld ? fold() : this.assignmentMutex.runExclusive(fold);
  }

  describesPooledRuntime(expected: Pick<BootedDevice, "deviceId" | "name" | "platform">): boolean {
    return this.runtimeIdentity.describesPooledRuntime(expected);
  }

  isPooledIdentityUnresolved(deviceId: string): boolean {
    return this.runtimeIdentity.isPooledIdentityUnresolved(deviceId);
  }

  assertDeviceActionable(deviceId: string, purpose: string): void {
    this.runtimeIdentity.assertDeviceActionable(deviceId, purpose);
  }

  autolockDevice(
    ...args: Parameters<DeviceAutolockManager["autolockDevice"]>
  ): Promise<string | undefined> {
    return this.autolockManager.autolockDevice(...args);
  }

  captureAutolockSessionForMcpSession(mcpSessionId: string | undefined): string | undefined {
    return this.autolockManager.captureAutolockSessionForMcpSession(mcpSessionId);
  }

  resolveAutolockSessionForMcpSession(
    ...args: Parameters<DeviceAutolockManager["resolveAutolockSessionForMcpSession"]>
  ): string | undefined {
    return this.autolockManager.resolveAutolockSessionForMcpSession(...args);
  }

  restoreAutolockSessionsForMcpSession(
    ...args: Parameters<DeviceAutolockManager["restoreAutolockSessionsForMcpSession"]>
  ): Promise<void> {
    return this.autolockManager.restoreAutolockSessionsForMcpSession(...args);
  }

  attachAutolockSessionToMcpSession(
    ...args: Parameters<DeviceAutolockManager["attachAutolockSessionToMcpSession"]>
  ): Promise<void> {
    return this.autolockManager.attachAutolockSessionToMcpSession(...args);
  }

  assertAutolockAccess(...args: Parameters<DeviceAutolockManager["assertAutolockAccess"]>): void {
    this.autolockManager.assertAutolockAccess(...args);
  }

  /**
   * Restore ownership of live result-minted sessions after a daemon socket
   * reconnect. Unlike autolock restoration, this intentionally does not select
   * an implicit routing default or mutate persisted autolock metadata.
   */
  async restoreOwnedDeviceSessionsForMcpSession(
    sessionIds: readonly string[],
    mcpSessionId: string,
  ): Promise<void> {
    await this.assignmentMutex.runExclusive(() => {
      for (const sessionId of sessionIds) {
        const session = this.sessionManager.getSession(sessionId);
        const device = session ? this.devices.get(session.assignedDevice) : undefined;
        if (
          session &&
          device &&
          this.isSessionAssignmentCurrent(device, session) &&
          this.sessionManager.isAdmittedForAutomation(session)
        ) {
          this.recordMcpSessionOwnership(mcpSessionId, sessionId);
        }
      }
    });
  }

  /** Drop every socket-scoped route and ownership marker for a disconnected MCP client. */
  releaseMcpSessionBindings(mcpSessionId: string): void {
    this.mcpSessionAcquiredDeviceSessions.delete(mcpSessionId);
    this.autolockManager.releaseMcpSessionBindings(mcpSessionId);
    this.mcpSessionRecoveryDevices.delete(mcpSessionId);
  }

  /**
   * Free a device whose autolock session has been released or has expired.
   *
   * Invoked via the SessionManager expiry callback. Only acts when the device
   * is still owned by the released session, so a stale callback cannot free a
   * replacement owner. Autolock-specific state is cleared when the device is
   * actually returned to idle.
   */
  private releaseExpiredSessionDevice(sessionId: string, deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device || device.sessionId !== sessionId) {
      return;
    }

    const assignmentCount = device.assignmentCount;
    const cleanup = this.sessionManager.getPendingDeviceCleanup(deviceId);
    const release = this.releaseCapturedDevice(device, sessionId, assignmentCount);
    void release
      .then(() => {
        if (!cleanup) {
          this.autolockManager.clearExpiredAutolockStateWhenIdle(
            sessionId,
            device,
            assignmentCount,
          );
        }
        logger.info(`Released device ${deviceId} from session ${sessionId}`);
      })
      .catch((error) => {
        logger.warn(`Failed to release expired-session device ${deviceId}: ${error}`, error);
      });
    if (cleanup) {
      void cleanup
        .then(() =>
          this.autolockManager.clearExpiredAutolockStateWhenIdle(
            sessionId,
            device,
            assignmentCount,
          ),
        )
        .catch((error) => {
          logger.warn(`Failed to finish expired-session cleanup for ${deviceId}: ${error}`, error);
        });
    }
  }

  private clearMcpSessionOwnership(sessionId: string): void {
    for (const [mcpSessionId, acquired] of this.mcpSessionAcquiredDeviceSessions) {
      acquired.delete(sessionId);
      if (acquired.size === 0) {
        this.mcpSessionAcquiredDeviceSessions.delete(mcpSessionId);
      }
    }
  }

  /**
   * Mark device as having an error
   *
   * Track consecutive errors. If errors exceed threshold, mark device as failed.
   */
  recordDeviceError(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }

    device.errorCount++;

    if (device.errorCount >= this.MAX_DEVICE_ERRORS) {
      device.status = "error";
      logger.error(
        `Device ${deviceId} marked as error ` + `(${device.errorCount} consecutive errors)`,
      );
    } else {
      logger.warn(`Device ${deviceId} error count: ${device.errorCount}/${this.MAX_DEVICE_ERRORS}`);
    }
  }

  /**
   * Clear error count for device (after successful operation)
   */
  clearDeviceError(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.errorCount = 0;
    }
  }

  /**
   * Get device by ID
   */
  getDevice(deviceId: string): PooledDevice | null {
    return this.devices.get(deviceId) || null;
  }

  /**
   * Connection epoch of the pooled device on `deviceId`, or undefined when the
   * serial is not pooled. The canonical answer for every per-device cache that
   * must not survive a same-serial reincarnation; see
   * `utils/deviceIncarnation.ts`.
   */
  getDeviceIncarnation(deviceId: string): number | undefined {
    return this.devices.get(deviceId)?.incarnation;
  }

  /** Advance the epoch for an already pooled device after a VM restore. */
  bumpDeviceIncarnation(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device) {
      return false;
    }
    this.sessionManager.retireClockRestoration(deviceId);
    this.deviceHealthMarkers.clear(deviceId);
    device.incarnation = this.nextDeviceIncarnation();
    // Full: a VM restore can replace the rendered screen even on the same connection/serial.
    this.notifyDeviceFramesInvalidated(deviceId);
    return true;
  }

  /**
   * Get device assigned to session
   */
  getDeviceForSession(sessionId: string): PooledDevice | null {
    return Array.from(this.devices.values()).find((d) => d.sessionId === sessionId) || null;
  }

  assertSessionReadyForAutomation(sessionId: string): void {
    if (this.adbServerResetQuarantinedSessions.has(sessionId)) {
      const loss = this.recoveringSessionLosses.get(sessionId);
      if (loss) {
        throw new DeviceLostError(
          loss.deviceId,
          deviceLossCancellationReason(loss.deviceId, loss.incidentId),
          loss.incidentId,
        );
      }
      throw new ActionableError(
        `Session '${sessionId}' is recovering from a process-wide ADB reset. Retry after device recovery completes.`,
      );
    }
    // Reject admission for a session whose device is being killed. Without this,
    // a session already bound to the device passes the gate during the killDevice
    // window and re-creates a fresh auto-reconnecting AndroidCtrlProxyClient via
    // getInstance, recreating the transport hold the teardown just removed. The
    // shutdown reservation blocks new *allocation* but not an already-bound
    // session; execution cancellation only happens later in retirement, so this
    // is the gate that closes that window (see #5494, follow-up to #5452/#5491).
    const assignedDeviceId = this.sessionManager.getSession(sessionId)?.assignedDevice;
    // The session addresses its device BY SERIAL, so this path is just the
    // session-keyed spelling of a device-addressed operation and goes through
    // FUNNEL 2 like every other one (#6863 review).
    if (assignedDeviceId) {
      this.runtimeIdentity.assertDeviceActionable(assignedDeviceId, "to run");
    }
    if (
      assignedDeviceId &&
      this.shutdownReservationCoordinator.isDeviceUnderShutdown(assignedDeviceId)
    ) {
      throw new ActionableError(
        `Session '${sessionId}' is bound to device '${assignedDeviceId}', which is shutting down. ` +
          `Retry after the device is released or reassigned.`,
      );
    }
  }

  /** Read the shutdown fence under the assignment lock used to install it. */
  isShutdownReserved(deviceId: string): Promise<boolean> {
    return this.shutdownReservationCoordinator.isShutdownReserved(deviceId);
  }

  /** Read only the active shutdown reservation under the assignment lock. */
  isShutdownReservationHeld(deviceId: string): Promise<boolean> {
    return this.shutdownReservationCoordinator.isShutdownReservationHeld(deviceId);
  }

  /**
   * Get all idle devices (available for assignment)
   */
  getIdleDevices(): PooledDevice[] {
    return Array.from(this.devices.values()).filter((device) => this.isIdleDeviceEligible(device));
  }

  /**
   * Get all devices currently assigned to sessions
   */
  getAssignedDevices(): PooledDevice[] {
    return Array.from(this.devices.values()).filter(
      (d) => d.status === "busy" && d.sessionId !== null,
    );
  }

  /**
   * Get all devices in error state
   */
  getErrorDevices(): PooledDevice[] {
    return Array.from(this.devices.values()).filter((d) => d.status === "error");
  }

  /**
   * Get count of available devices (can be assigned to new sessions)
   */
  getAvailableDeviceCount(): number {
    return this.getIdleDevices().length;
  }

  /**
   * Get total device count
   */
  getTotalDeviceCount(): number {
    return this.devices.size;
  }

  /**
   * Get all devices in pool
   */
  getAllDevices(): PooledDevice[] {
    return Array.from(this.devices.values());
  }

  /** Effective daemon-startup policy, copied so callers cannot mutate pool state. */
  getRecoveryPolicy(): DeviceRecoveryPolicy {
    return { ...this.recoveryPolicy };
  }

  getRecoveryEligibility(deviceId: string): DeviceRecoveryEligibility {
    const device = this.devices.get(deviceId);
    if (!device) {
      return { eligible: false, reason: "not-in-pool" };
    }
    if (!this.getRecoveryPolicy().onLoss) {
      return { eligible: false, reason: "disabled" };
    }
    if (device.platform !== "android") {
      return { eligible: false, reason: "unsupported-platform" };
    }
    if (!this.isAndroidEmulatorActiveRelaunchEligible(device)) {
      return { eligible: false, reason: "not-automobile-owned" };
    }
    return { eligible: true, action: "restart" };
  }

  /**
   * True only for an Android emulator with a recorded AVD name *and* its
   * configured image -- the metadata an active relaunch needs to know what to
   * boot back. This is narrower than what passive continuity requires: it
   * reflects "acquired through getAndroid/startDevice with image enrichment,"
   * not "AutoMobile launched this emulator" or "this session may be preserved"
   * (#7546). See `isAndroidEmulatorSessionContinuityDevice` for the passive gate.
   */
  private isAndroidEmulatorActiveRelaunchEligible(
    device: PooledDevice,
  ): device is PooledDevice & { avdName: string; androidImage: DeviceInfo } {
    return (
      device.platform === "android" &&
      consolePortFromSerial(device.id) !== null &&
      typeof device.avdName === "string" &&
      device.androidImage !== undefined
    );
  }

  /**
   * True for any Android emulator serial whose AVD identity discovery has
   * resolved -- via a recorded `avdName` or, absent that, a non-placeholder
   * discovered name (see `stableDeviceIdFor`). Passive continuity (preserve the
   * session, reattach on return) only needs this; it does not need the
   * configured image `isAndroidEmulatorActiveRelaunchEligible` requires (#7546).
   */
  private isAndroidEmulatorSessionContinuityDevice(
    device: PooledDevice,
  ): device is AndroidEmulatorContinuityDevice {
    return (
      device.platform === "android" &&
      consolePortFromSerial(device.id) !== null &&
      this.stableDeviceIdFor(device) !== undefined
    );
  }

  private isIOSSimulatorContinuityDevice(
    device: PooledDevice,
  ): device is IOSSimulatorRecoveryDevice {
    return (
      device.platform === "ios" &&
      typeof device.id === "string" &&
      device.id.length > 0 &&
      discoverySourceFor(device.platform, device.id) === "ios-simulator"
    );
  }

  private getDevicesMatchingCriteria(criteria?: DeviceAllocationCriteria): PooledDevice[] {
    return this.criteriaMatcher.filterDevices(this.getAllDevices(), criteria);
  }

  private getDevicesMatchingRecoveryTarget(target: SessionRecoveryTarget): PooledDevice[] {
    const matches = this.getDevicesByPlatform(target.platform).filter(
      (device) =>
        this.stableDeviceIdFor(device) === target.stableDeviceId &&
        (target.androidEmulator === undefined ||
          this.isPooledAndroidEmulator(device.id) === target.androidEmulator),
    );
    // A recovery target must prove one exact runtime. A duplicate stable identity
    // is ambiguous and must not collapse back to normal pool selection.
    return matches.length === 1 ? matches : [];
  }

  /**
   * Recovery is an identity operation, not ordinary pool allocation. Once an
   * exact target is absent, busy, or replaced at its old transport address,
   * fail immediately rather than allowing retry timing or discovery order to
   * choose another signed device. A device-restart release has a persisted,
   * bounded grace period for absence. An unresolved emulator identity at any
   * serial is not evidence of absence or replacement.
   */
  private recoveryFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
    refreshCompleteness?: DiscoveryCompleteness,
  ): SessionRecoveryIdentityLossError | DevicePoolError | undefined {
    const platformDevices = this.getDevicesByPlatform(target.platform);
    const exactMatches = platformDevices.filter(
      (device) =>
        this.stableDeviceIdFor(device) === target.stableDeviceId &&
        (target.androidEmulator === undefined ||
          this.isPooledAndroidEmulator(device.id) === target.androidEmulator),
    );
    if (exactMatches.length !== 1) {
      const { transportReused, transportIdentityUnresolved, absenceAuthoritative } =
        this.recoveryDiscoveryEvidence(target, platformDevices, refreshCompleteness);
      if (transportReused || exactMatches.length > 1) {
        return new SessionRecoveryIdentityLossError(sessionId, target, "identity-continuity-lost");
      }
      if (transportIdentityUnresolved) {
        if (
          target.restartRecoveryDeadlineMs === undefined ||
          this.timer.now() < target.restartRecoveryDeadlineMs
        ) {
          return new DevicePoolError("Recovery target identity is unresolved", true);
        }
      }
      if (!absenceAuthoritative) {
        return new DevicePoolError("Recovery target absence is not yet authoritative", true);
      }
      if (
        target.restartRecoveryDeadlineMs !== undefined &&
        this.timer.now() < target.restartRecoveryDeadlineMs
      ) {
        return new DevicePoolError("Recovery target is restarting", true);
      }
      return new SessionRecoveryIdentityLossError(sessionId, target, "target-absent");
    }
    const exact = exactMatches[0];
    if (exact.status === "busy" || this.isReservedForAssignment(exact)) {
      return new SessionRecoveryIdentityLossError(sessionId, target, "target-busy");
    }
    return undefined;
  }

  private recoveryDiscoveryEvidence(
    target: SessionRecoveryTarget,
    platformDevices: PooledDevice[],
    refreshCompleteness: DiscoveryCompleteness | undefined,
  ): {
    transportReused: boolean;
    transportIdentityUnresolved: boolean;
    absenceAuthoritative: boolean;
  } {
    const transportReused = platformDevices.some((device) => {
      const stableId = this.stableDeviceIdFor(device);
      return (
        device.id === target.deviceId &&
        stableId !== undefined &&
        stableId !== target.stableDeviceId
      );
    });
    const transportIdentityUnresolved =
      !isUnresolvedAndroidEmulatorName({
        deviceId: target.deviceId,
        name: target.stableDeviceId,
        platform: target.platform,
      }) &&
      platformDevices.some(
        (device) =>
          this.stableDeviceIdFor(device) === undefined &&
          (device.id === target.deviceId ||
            (target.platform === "android" &&
              target.androidEmulator === true &&
              this.isPooledAndroidEmulator(device.id))),
      );
    const absenceAuthoritative =
      refreshCompleteness !== undefined &&
      didSourceSucceedForDevice(refreshCompleteness, target.platform, target.deviceId);
    return { transportReused, transportIdentityUnresolved, absenceAuthoritative };
  }

  private stableDeviceIdFor(device: PooledDevice): string | undefined {
    if (device.platform === "ios") {
      return device.id;
    }
    if (!this.isPooledAndroidEmulator(device.id)) {
      return device.id;
    }
    return (
      device.avdName ??
      (device.identityUnresolved ||
      isUnresolvedAndroidEmulatorName({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
      })
        ? undefined
        : device.name)
    );
  }

  private getDevicesByPlatform(platform?: Platform): PooledDevice[] {
    if (!platform) {
      return this.getAllDevices();
    }
    return Array.from(this.devices.values()).filter((device) => device.platform === platform);
  }

  private getStatsForPlatform(platform?: Platform): {
    total: number;
    idle: number;
    assigned: number;
    error: number;
  } {
    const devices = this.getDevicesByPlatform(platform);
    const idle = devices.filter((device) => this.isIdleDeviceEligible(device)).length;
    const assigned = devices.filter(
      (device) => device.status === "busy" || this.isReservedForAssignment(device),
    ).length;
    const error = devices.filter((device) => device.status === "error").length;

    return {
      total: devices.length,
      idle,
      assigned,
      error,
    };
  }

  /**
   * Get pool statistics for monitoring
   */
  getStats(): {
    total: number;
    idle: number;
    assigned: number;
    error: number;
    avgAssignments: number;
  } {
    const all = this.getAllDevices();
    const idle = this.getIdleDevices().length;
    const assigned = all.filter(
      (device) => device.status === "busy" || this.isReservedForAssignment(device),
    ).length;
    const error = this.getErrorDevices().length;
    const avgAssignments =
      all.length > 0
        ? Math.round(all.reduce((sum, d) => sum + d.assignmentCount, 0) / all.length)
        : 0;

    return {
      total: all.length,
      idle,
      assigned,
      error,
      avgAssignments,
    };
  }

  /**
   * Get detailed status report
   */
  getStatusReport(): string {
    const stats = this.getStats();
    const lines = [
      "\n=== Device Pool Status ===",
      `Total Devices: ${stats.total}`,
      `  Idle:       ${stats.idle}`,
      `  Assigned:   ${stats.assigned}`,
      `  Error:      ${stats.error}`,
      `Avg Assignments: ${stats.avgAssignments}`,
      "",
      "Device Details:",
    ];

    for (const device of this.getAllDevices()) {
      const status = device.status === "error" ? "❌" : device.sessionId ? "🔴" : "🟢";
      const session = device.sessionId ? ` (${device.sessionId})` : "";
      lines.push(
        `  ${status} ${device.id}: ${device.status}${session} (${device.assignmentCount} uses, ${device.errorCount} errors)`,
      );
    }

    lines.push("=== End Report ===\n");
    return lines.join("\n");
  }

  /**
   * Set session tracking for a device in the installed apps cache
   */
  private async setDeviceSessionTracking(deviceId: string, sessionStart: number): Promise<void> {
    try {
      await this.installedAppsRepository.setSessionTracking(
        this.daemonSessionId,
        deviceId,
        sessionStart,
      );
    } catch (error) {
      logger.warn(`Failed to set session tracking for device ${deviceId}: ${error}`);
    }
  }

  /**
   * Clear installed apps cache for a device session
   */
  private async clearDeviceSessionCache(deviceId: string): Promise<void> {
    try {
      await getInstalledAppsCacheWriteCoordinator().invalidate(deviceId, () =>
        getDbWriteBarrier()
          .track(() => this.installedAppsRepository.clearDeviceSession(deviceId))
          .then(() => undefined),
      );
      // The device has left the pool for good, so forget its per-device
      // cache-coherence bookkeeping now that the final invalidation above has
      // drained — otherwise the coordinator retains a generation entry for every
      // device id the daemon ever saw (#6704). releaseDevice is generation-safe:
      // a rebuild that predates it cannot commit, and a reused serial starts clean.
      await getInstalledAppsCacheWriteCoordinator().releaseDevice(deviceId);
      logger.info(`[DevicePool] Cleared installed apps cache for device ${deviceId}`);
    } catch (error) {
      logger.warn(`Failed to clear device session cache for ${deviceId}: ${error}`);
    }
  }
}
