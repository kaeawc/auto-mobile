import { ENV } from "../config/env";
import { getDbWriteBarrier, type DbWriteBarrier } from "../db/dbWriteBarrier";
import {
  DeviceSessionRepository,
  DeviceSessionRowNotReleasableError,
  DeviceSessionRowNotRewritableError,
  isDeviceRestartReleaseReason,
  type DeviceSessionActivityUpdate,
  type DeviceSessionPersistence,
  type MarkReleasedOptions,
  type UpsertActiveSessionOptions,
} from "../db/deviceSessionRepository";
import type { DeviceSession } from "../db/types";
import {
  SCREEN_READER_RESTORE_TIMEOUT_MS,
  type ScreenReaderRestoreState,
} from "../features/accessibility/ScreenReaderRestore";
import { type RotationRestoreState } from "../features/action/Rotate";
import {
  IOS_APP_NETWORK_RULE_LEASE_MS,
  IOS_APP_NETWORK_RULE_RENEW_INTERVAL_MS,
  IosAppNetworkRuleClient,
  type IosAppNetworkRule,
  type IosAppNetworkRuleCommandContext,
} from "../features/networkFilter/IosAppNetworkRuleClient";
import { ExecNetworkFilterBridge } from "../features/networkFilter/NetworkFilterBridge";
import { type DeviceClockRestoreState } from "../features/utility/DeviceClock";
import {
  type BiometricEnrollment,
  type NetworkConditionProfile,
} from "../features/utility/DeviceState";
import { type BootedDevice, type Platform } from "../models";
import { ActionableError, toActionableError } from "../models/ActionableError";
import {
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
  DeviceOwnedByOtherDaemonError,
  SESSION_HELD_BY_RECOVERY_CODE,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
  SessionCreationTimeoutError,
  SessionReleasedDuringCreationError,
} from "../models/deviceAcquisitionRefusals";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../models/managedExecutionLiveness";
import type { ObserveResult } from "../models/ObserveResult";
import { SessionNoLongerOwnsDeviceError } from "../models/sessionNoLongerOwnsDevice";
import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import {
  getAbortSignal,
  runOutsideRequestContext,
  runWithAbortSignal,
} from "../utils/AbortContext";
import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import { errorMessage } from "../utils/describeUnknownError";
import { isDeviceLossCancellationReason } from "../utils/deviceLossCancellationReason";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { readEnvPositiveInteger } from "../utils/envNumbers";
import {
  type KeepAwakeRestoreReport,
  type KeepScreenAwakeRestoreOutcome,
  type KeepScreenAwakeState,
} from "../utils/KeepScreenAwakeManager";
import { logger } from "../utils/logger";
import type { TimingData } from "../utils/PerformanceTracker";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, SteadyWallClock, type Timer } from "../utils/SystemTimer";
import { requestAcquisitionReceipt, type DeferredRebindCleanup } from "./acquisitionReceipt";
import {
  daemonStallLeaseExtension,
  type OwnerConnectedAtReader,
} from "./connectedOwnerStallExcuse";
import { SESSION_RELEASE_DRAIN_TIMEOUT_MS } from "./constants";
import { assertCollaboratorsAttached, UNATTACHED } from "./daemonAttachedCollaborators";
import {
  DeviceCleanupQuarantine,
  type AbandonablePendingDeviceCleanup,
} from "./deviceCleanupQuarantine";
import type { DeviceHealthMarkers, DeviceHealthReason } from "./deviceHealthMarkers";
import {} from "./deviceStateRestoreQueue";
import { type IosAppNetworkRuleRestorer } from "./iosAppNetworkLease";
import { createLegacyLifecycleView } from "./legacyLifecycleView";
import { type LivenessOwnerView } from "./livenessClaimDecision";
import {
  hasMintBoundClaimLease,
  type LivenessLeaseState,
  type LivenessOwnerHold,
} from "./livenessOwnerLease";
import { NoopTerminalReleaseJournal } from "./NoopTerminalReleaseJournal";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import { PlanLabelRegistry } from "./planLabelRegistry";
import { type DeviceReadinessLevel } from "./readiness/DeviceReadiness";
import { RELEASE_PERSIST_TIMEOUT_REASON, SessionReleasePersistTimeoutError } from "./releaseErrors";
import {
  isIdleReleaseReason,
  isRecoverableDaemonReleaseReason,
  isReissuableByNameReleaseReason,
  isTerminalReleaseReason,
  resolveReleaseReason,
  type SessionReleaseReason,
} from "./releaseReasons";
import type { ReleaseSessionRequest } from "./releaseSessionRequest";
import { onSessionClock } from "./sessionClockPersistence";
import { effectiveLastToolActivity } from "./sessionClocks";
import {
  defaultBiometricEnrollmentRestorer,
  defaultClockRestorerFactory,
  defaultKeepScreenAwakeRestorer,
  defaultNetworkConditionRestorer,
  defaultRotationRestorerFactory,
  defaultScreenReaderRestorer,
} from "./sessionDefaultRestorers";
import {
  SessionDeviceStateRestore,
  type IosAppNetworkRuleSessionState,
} from "./sessionDeviceStateRestore";
import {
  DaemonSessionCreationRejectedError,
  SessionRebindingError,
  SessionTerminalReleaseInProgressError,
  TERMINAL_RELEASE_IN_PROGRESS_DETAIL,
  TerminalSessionError,
} from "./sessionErrors";
import { SessionLivenessController } from "./sessionLivenessLease";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  getSessionHeartbeatCheckIntervalMs,
  getSessionIdleTimeoutMs,
} from "./sessionLivenessWindows";
import { SessionAcquisition } from "./sessionManager/acquisition";
import { SessionActivityPersistence } from "./sessionManager/activityPersistence";
import { SessionCache } from "./sessionManager/cache";
import { SessionCreation } from "./sessionManager/creation";
import { ForcedStuckRelease } from "./sessionManager/forcedStuckRelease";
import type {
  SessionManagerCollaboratorActions,
  SessionManagerCollaboratorHost,
} from "./sessionManager/host";
import {
  releaseSuperseded,
  type ClaimedCreationRow,
  type PendingSessionCreation,
  type PendingSessionRebind,
  type PendingSessionRelease,
  type RecoveryAssignmentWait,
  type RehydrationRowOutcome,
  type ReleaseReasonState,
  type ResolvedSessionAcquisition,
  type SessionAcquisitionOptions,
  type SessionClockExecution,
  type SharedSessionAssignment,
  type TerminalReleaseReservation,
} from "./sessionManager/internalContracts";
import { SessionLeaseExpiry } from "./sessionManager/leaseExpiry";
import { PersistedSessionAdmission } from "./sessionManager/persistedAdmission";
import { SessionPlanLabels } from "./sessionManager/planLabelsLifecycle";
import { SessionRebinding } from "./sessionManager/rebinding";
import { RecoveredTerminalReleaseIntents } from "./sessionManager/recoveredTerminalReleaseIntents";
import { SessionRecovery } from "./sessionManager/recovery";
import { SessionRehydration } from "./sessionManager/rehydration";
import { SessionReleasePersistence } from "./sessionManager/releasePersistence";
import { SessionReleaseRequests } from "./sessionManager/releaseRequests";
import { DeviceRestoreHealth } from "./sessionManager/restoreHealth";
import { SessionRecoveryIdentityLossError } from "./sessionManager/SessionRecoveryIdentityLossError";
import { SupersededSessionRows } from "./sessionManager/supersededRows";
import { UnissuedSessionError } from "./sessionManager/UnissuedSessionError";
import { SessionReleasedDuringCallError } from "./sessionReleasedDuringCall";
import {
  SerializedSessionRowWriter,
  type ReleaseRowRetry,
  type SessionRowWriter,
} from "./sessionRowWriter";
import {
  deriveHeldSlotSession,
  deriveKnownSessionIds,
  deriveLatestSessionIdentity,
  isSlotCurrentSession,
  SessionSlots,
  type LegacyLifecycleView,
} from "./sessionSlots";
import { SessionSlotShadowProbe, type SlotShadowProbeMode } from "./sessionSlotShadowProbe";
import { type StallForgivingLeases } from "./stallForgiveness";
import type {
  OwedSupersededRowReassert,
  OwedSupersededRowReassertCallbacks,
  SupersededRowReasserts,
} from "./supersededRowReasserts";
import { type TerminalReleaseIntent, type TerminalReleaseJournal } from "./terminalReleaseJournal";

export * from "./releaseErrors";
export type { IosAppNetworkRuleSessionState } from "./sessionDeviceStateRestore";
export { SessionActivityPersistenceError } from "./sessionManager/SessionActivityPersistenceError";

/**
 * Device-label → session-UUID map. `buildDeviceLabelMap` assigns each configured
 * label its own session (the primary label reuses the base session UUID), so a
 * `device: "B"` tool argument can be routed to the correct label session.
 */
export type DeviceLabelMap = Record<string, string>;

/**
 * Narrow seam for restoring keep-awake state on session release. Production uses
 * `KeepScreenAwakeManager`; tests inject a fake to assert (without a real device)
 * that `releaseSession` reads the typed `keepScreenAwake` slot and passes its full
 * payload to `restore` — the behavioral half of the #2973 typed-slot round trip.
 */
export interface KeepScreenAwakeRestorer {
  restore(state: KeepScreenAwakeState): Promise<KeepScreenAwakeRestoreOutcome>;
}

/** Original simulator enrollment restored when a session releases its device. */
export interface BiometricEnrollmentSessionState {
  initialEnrollment: BiometricEnrollment;
}

/** What a pending restore must write, resolved before any await (see below). */
/** One restore a release started; `abandon` records it when the teardown cap expires first. */
export interface ReleaseTeardownStage {
  /** In-flight setup can still drive the serial even when restoration is skipped. */
  setup?: boolean;
  pending: Promise<void> | null;
  abandon?: () => void;
}

/** Narrow seam for restoring iOS Simulator biometric enrollment on release. */
export interface BiometricEnrollmentRestorer {
  restore(enrollment: BiometricEnrollment): Promise<void>;
}

/**
 * Original device-wide network condition restored when a session releases its
 * device (issue #6012). Written the first time a session degrades the network,
 * so release/expiry never hands an impaired device back to the pool.
 */
export interface NetworkConditionSessionState {
  initialProfile: NetworkConditionProfile;
  /**
   * iOS Simulator only (#10264): the one app this session took offline through
   * the network-extension filter. Restoring removes this session's rule rather
   * than resetting the whole device.
   */
  iosAppRule?: IosAppNetworkRuleSessionState;
}

/** What a pending network restore must write, resolved before any await. */

/** Original auto-time value recorded before the first session clock write. */
export type ClockSessionState = DeviceClockRestoreState;

export interface ClockRestorer {
  restore(state: ClockSessionState, signal?: AbortSignal): Promise<void>;
}
/** Original rotation settings recorded before the first session settings write. */
export type RotationSessionState = RotationRestoreState;

export interface RotationRestorer {
  restore(state: RotationSessionState, signal?: AbortSignal): Promise<void>;
}
/** TalkBack/VoiceOver state recorded before the first `accessibility` toggle in a session (#10146). */
export type ScreenReaderSessionState = ScreenReaderRestoreState;

export interface ScreenReaderRestorer {
  restore(state: ScreenReaderSessionState, signal?: AbortSignal): Promise<void>;
}
/** Overrides for the per-session device-state restorers; each omitted one uses production wiring. */
export interface DeviceStateRestorerFactories {
  networkCondition?: (device: BootedDevice) => NetworkConditionRestorer;
  clock?: (device: BootedDevice) => ClockRestorer;
  rotation?: (device: BootedDevice) => RotationRestorer;
  /** Delay before each rotation restore retry; defaults to a short exponential backoff. */
  rotationBackoff?: BackoffPolicy;
  screenReader?: (device: BootedDevice) => ScreenReaderRestorer;
  /** Delay before each screen-reader restore retry; defaults to a short exponential backoff. */
  screenReaderBackoff?: BackoffPolicy;
  /** iOS Simulator per-app network rules (#10264); defaults to the installed controller. */
  iosAppNetworkRule?: IosAppNetworkRuleRestorer;
}

/**
 * Everything SessionManager can be constructed with beyond `(timer, repository)`. Every field is
 * optional and defaults to the production wiring (#11796).
 */
export interface SessionManagerOptions {
  /**
   * Resolve per write: closeDatabase() -> resetDbWriteBarrier() makes the next track()
   * use a fresh barrier, not a pinned drained instance (#2912, #3154, #2885).
   */
  barrier?: () => DbWriteBarrier;
  /** Keep-awake restore seam (#2973); tests assert the typed slot's payload reaches `restore`. */
  keepScreenAwakeRestorer?: (device: BootedDevice) => KeepScreenAwakeRestorer;
  /** Simulator enrollment restore seam, parallel to keep-awake so tests never invoke simctl. */
  biometricEnrollmentRestorer?: (device: BootedDevice) => BiometricEnrollmentRestorer;
  restorers?: DeviceStateRestorerFactories;
}

/** Production defaults for every restorer the options leave out (#11796). */
function resolveDeviceStateRestorers(
  timer: Timer,
  overrides: DeviceStateRestorerFactories,
): Required<Omit<DeviceStateRestorerFactories, "iosAppNetworkRule">> &
  Pick<DeviceStateRestorerFactories, "iosAppNetworkRule"> {
  return {
    networkCondition: overrides.networkCondition ?? defaultNetworkConditionRestorer,
    clock: overrides.clock ?? defaultClockRestorerFactory(timer),
    rotation: overrides.rotation ?? defaultRotationRestorerFactory(timer),
    rotationBackoff: overrides.rotationBackoff ?? DEFAULT_ROTATION_RESTORE_BACKOFF,
    screenReader: overrides.screenReader ?? defaultScreenReaderRestorer,
    screenReaderBackoff: overrides.screenReaderBackoff ?? DEFAULT_SCREEN_READER_RESTORE_BACKOFF,
    iosAppNetworkRule: overrides.iosAppNetworkRule,
  };
}

/** Narrow seam for restoring the device-wide network condition on release. */
export interface NetworkConditionRestorer {
  restore(profile: NetworkConditionProfile): Promise<void>;
}

/**
 * Session Cache Data
 *
 * Stores data that can be reused across multiple tool calls
 * within the same test session, reducing redundant API calls.
 *
 * Every field is a typed top-level slot — the canonical source of truth for its
 * concern (issue #2917). Write each through its dedicated setter
 * (`setLastHierarchy`, `setKeepScreenAwake`, `setDeviceLabels`, …) so a
 * writer/reader type drift is caught at compile time.
 *
 * There is deliberately NO `customData?: Record<string, any>` escape hatch
 * (issue #2973): it previously held well-known, fixed-type keyed state
 * (keep-awake, device-label map) fished out with unchecked `as` casts, which
 * could silently reintroduce the #2917 decoy bug for any key. Any new
 * cross-tool session state gets its own typed slot here, not an untyped bag.
 */
export interface SessionCacheData {
  pendingSetupTiming?: TimingData; // Consumed once by this session; discarded with its cache.
  lastHierarchy?: ViewHierarchyResult; // Last observed view hierarchy (full, untrimmed)
  lastObserveTime?: number; // Timestamp of last hierarchy observation
  lastActionMetadata?: { deviceId: string; blocks: Record<string, unknown> };
  lastRenderedObservation?: ObserveResult; // Last observation emitted to the agent (sanitized), the #2761 diff baseline
  lastRenderedDisplayGeneration?: number; // Last caller-visible display.generation; survives invalidation
  lastRenderedDisplayRevision?: number; // Caller-visible display revision; survives panel cache invalidation
  displayPin?: string; // Session/device physical panel selector; dropped on release/rebind
  lastRenderedDisplayKey?: string; // Caller-visible panel, independent of the diff baseline
  keepScreenAwake?: KeepScreenAwakeState; // Keep-awake state applied at session setup, restored on release
  biometricEnrollment?: BiometricEnrollmentSessionState; // Original iOS Simulator biometric enrollment, restored on release
  networkCondition?: NetworkConditionSessionState; // Original device-wide network condition, restored on release (#6012)
  clock?: ClockSessionState;
  rotation?: RotationSessionState;
  screenReader?: ScreenReaderSessionState; // Screen-reader state before the session's first toggle, restored on release (#10146)
  deviceLabels?: DeviceLabelMap; // Device-label → session map for multi-device (`device:`-labelled) sessions
  /**
   * Highest {@link DeviceReadinessLevel} actually achieved by
   * `ToolExecutionContext`'s setup for this session (#6227). Lets a later call
   * on the same (possibly persisted/recovered) session detect that it needs a
   * higher readiness than a prior call achieved — e.g. a `booted`-only tool
   * ran first and left CtrlProxy/accessibility-service setup unprepared, then
   * an `automationReady` tool reuses the session — and upgrade in place
   * instead of silently skipping setup on the `existingSession` fast path.
   */
  deviceReadiness?: DeviceReadinessLevel;
}

/** Ownership retained in the device reverse map, regardless of expiry or release admission. */
export interface HeldDeviceSession {
  deviceId: string;
  sessionId: string;
  platform: string;
  stableDeviceId?: string;
}

/**
 * Session Record
 *
 * Represents a single test session with an assigned device.
 * Each JUnitRunner test process gets a unique session UUID.
 */
export interface Session {
  sessionId: string; // UUID provided by JUnitRunner
  assignedDevice: string; // Device ID this session is using
  stableDeviceId?: string; // Durable identity: Android AVD name or iOS simulator UDID
  platform: Platform; // Device platform
  createdAt: number; // Timestamp when session was created
  lastUsedAt: number; // Last activity timestamp
  activityGeneration: number; // Monotonic generation of durable activity refreshes
  expiresAt: number; // When session will expire (for cleanup)
  cacheData: SessionCacheData; // Cached data for this session
  lastHeartbeat: number; // Timestamp of last heartbeat
  /**
   * The last time the session's liveness OWNER was alive: its own heartbeats, a recorded
   * ownership claim, or the restore of a persisted owner. Unlike `lastHeartbeat` it is not advanced
   * by tool activity, so a non-owner that merely uses the session cannot keep the owner's lease live
   * (#10050). Unset until owner proof arrives; a mint-bound token uses its bind instant for claims.
   */
  lastOwnerHeartbeat?: number;
  /**
   * The daemon's own resume point after it detected a stall of its event loop
   * (#10051). Not persisted: the daemon cannot have received heartbeats while it
   * was stalled, so the lease is judged from this point when it is later than
   * `lastHeartbeat`.
   */
  stallForgivenAt?: number;
  /**
   * The daemon's resume point after a stall of its own event loop, for a `cli-idle` session's idle
   * judgement (#10835). Not persisted. A `cli-idle` session's idleness is measured from the later of
   * this and `lastUsedAt` (`effectiveLastToolActivity`), so time the daemon itself lost is never
   * held against the CLI, while `lastUsedAt` keeps meaning "last tool call". Only the daemon-stall
   * portion moves it, never host sleep, which counts toward idle. A later tool call supersedes it
   * because it stamps `lastUsedAt` past it.
   */
  idleStallForgivenAt?: number;
  sessionTimeoutMs: number; // Idle timeout used when extending this session
  heartbeatTimeoutMs: number; // Heartbeat timeout for this session
  heartbeatTimeoutSource: "default" | "custom"; // Whether the heartbeat timeout was defaulted or explicitly provided
  hasReceivedHeartbeat: boolean; // Whether any heartbeat has been received
  /** Whether this daemon has heard from the client that owns this session. */
  ownership: "owned" | "awaiting-owner";
  /** Set only while a rehydrated session is waiting for its previous owner. */
  awaitingOwnerSince?: number;
  livenessPolicy: SessionLivenessPolicy; // How this session's liveness is judged (#6870)
  /**
   * The current token authorized to refresh this session's liveness. It is
   * daemon-local deliberately: a newly established proxy or explicit CLI
   * adoption claims it, while a reconnecting keeper must prove it still owns
   * the token before extending the session.
   */
  livenessOwnerToken?: string;
  /**
   * The session-clock instant an acquisition bound the owner token. Non-persisted: it starts
   * the owner lease for claim judgement while the owner has no heartbeat stamp; it is not a
   * heartbeat. Cleared with the token it belongs to.
   */
  livenessOwnerBoundAt?: number;
  /**
   * Tokens whose explicit ownership claim this daemon has already processed.
   * A client may retry the same claim when its reply is lost; if a newer owner
   * has since taken over, the old token's retry must be a stale no-op rather
   * than reclaiming the session.
   */
  livenessOwnershipClaims?: Set<string>;
  /**
   * The strict-contract timeouts this session had before it adopted the
   * `cli-idle` policy, so a later long-lived owner can restore them (#6870).
   * Absent whenever the session is on (or has never left) the `heartbeat`
   * policy.
   */
  preCliLiveness?: PreCliLivenessSnapshot;
  /** Recovery-only metadata that must survive the active-row upsert. */
  persistenceMetadata?: SessionPersistenceMetadata;
  /**
   * The name the holding client registered with `daemon/registerSession`, for diagnostics only
   * (`holderKind`, #10671). Not persisted and never used for admission or ownership.
   */
  clientName?: string;
}

/**
 * `device_sessions.source` of a session an acquisition without an MCP connection id (a `--cli`
 * startDevice/getAndroid/getApple) created. Only such a session may be reused by another anonymous
 * acquisition of its device (#2421, #11071); it is persisted, so a daemon restart keeps the rule.
 */
export const ANONYMOUS_ACQUISITION_SESSION_SOURCE = "anonymous-acquisition";

/**
 * `device_sessions.source` of a derived `<base>:<label>` session a multi-device plan run minted
 * (#11572). Its lifetime is that plan run: the row is never rehydrated after a daemon restart, a
 * call naming it outside its run is refused as terminal, and only a later plan run's allocation
 * may mint the name again. It is persisted, so a daemon restart keeps the rule.
 */
export const PLAN_LABEL_SESSION_SOURCE = "plan-label";

/** Whether an anonymous acquisition (no MCP connection id) created this session (#11071). */
export function isAnonymousAcquisitionSession(session: Session): boolean {
  return session.persistenceMetadata?.source === ANONYMOUS_ACQUISITION_SESSION_SOURCE;
}

interface SessionPersistenceMetadata {
  source: string | null;
  autolockEnabled: boolean;
  mcpSessionId: string | null;
  daemonSessionId: string | null;
}

/** The heartbeat-policy timeouts `adoptCliLivenessPolicy` overwrote (#6870). */
export interface PreCliLivenessSnapshot {
  heartbeatTimeoutMs: number;
  heartbeatTimeoutSource: "default" | "custom";
  sessionTimeoutMs: number;
}

/**
 * How the heartbeat monitor judges a session's liveness (issue #6870).
 *
 * - `heartbeat` (the default): the strict contract a long-lived stdio/HTTP MCP
 *   client can keep — a first heartbeat within the pre-first-heartbeat grace,
 *   then one every `heartbeatTimeoutMs` (4 s by default, plus a 4 s suspect grace).
 * - `cli-idle`: the contract a one-shot `--cli` process can keep. Each
 *   invocation connects, runs one tool and exits, so between calls nobody is
 *   heartbeating; the session is instead reaped only after a wall-clock idle
 *   period measured in minutes, and never for a missing first heartbeat.
 * - `managed-execution` (#11176): a session a broker binding execution holds through its stdio
 *   proxy. Judged exactly like `heartbeat` (owner lease plus suspect grace, idle measured from the
 *   end of the last tool call, reads never count), but its idle window is the launcher-trusted
 *   override bounded to 2–60 minutes (default 2), and a one-shot `--cli` declaration never moves
 *   it onto `cli-idle`. See `./managedExecutionLiveness`.
 */
export type SessionLivenessPolicy =
  | "heartbeat"
  | "cli-idle"
  | typeof MANAGED_EXECUTION_LIVENESS_POLICY;

/** Result of an explicit owner-authorized liveness release. */
export type LivenessReleaseOutcome = "released" | "already-unowned" | "not-owner" | "not-found";

/**
 * Result of an explicit liveness-ownership claim (#10050).
 *
 * - `claimed`: the token now owns (or already owned) the session.
 * - `conflict`: a different token owns it and that owner's lease is live; nothing changed.
 * - `superseded`: this token already claimed and was displaced; it cannot reclaim an owned session.
 * - `not-found`: the session is unknown or was replaced while the claim waited.
 */
export type LivenessClaimOutcome = "claimed" | "conflict" | "superseded" | "not-found";

function sessionCreationLiveness(
  timeoutMs: number | undefined,
  heartbeatTimeoutMs: number | undefined,
  recoveredLiveness: SessionRecoveryLiveness | undefined,
  defaultSessionTimeoutMs: number,
): Pick<
  Session,
  | "sessionTimeoutMs"
  | "heartbeatTimeoutMs"
  | "heartbeatTimeoutSource"
  | "hasReceivedHeartbeat"
  | "livenessPolicy"
  | "preCliLiveness"
> {
  if (recoveredLiveness) {
    return {
      sessionTimeoutMs: recoveredLiveness.sessionTimeoutMs,
      heartbeatTimeoutMs: recoveredLiveness.heartbeatTimeoutMs,
      heartbeatTimeoutSource: recoveredLiveness.heartbeatTimeoutSource,
      hasReceivedHeartbeat: recoveredLiveness.hasReceivedHeartbeat,
      livenessPolicy: recoveredLiveness.livenessPolicy,
      preCliLiveness: recoveredLiveness.preCliLiveness,
    };
  }
  return {
    sessionTimeoutMs: timeoutMs ?? defaultSessionTimeoutMs,
    heartbeatTimeoutMs: heartbeatTimeoutMs ?? getDefaultSessionHeartbeatTimeoutMs(),
    heartbeatTimeoutSource: heartbeatTimeoutMs === undefined ? "default" : "custom",
    hasReceivedHeartbeat: false,
    livenessPolicy: "heartbeat",
  };
}

/** The {@link SessionReleaseSnapshot.livenessPolicy} marker for a managed execution's session. */
function managedExecutionReleaseMarker(
  session: Pick<Session, "livenessPolicy">,
): Pick<SessionReleaseSnapshot, "livenessPolicy"> {
  return session.livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY
    ? { livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY }
    : {};
}

/**
 * Session Manager
 *
 * Manages test session lifecycle:
 * - Create sessions with device assignment
 * - Track cache data per session
 * - Release sessions and free up devices
 * - Auto-cleanup expired sessions
 *
 * This enables parallel tests to each have their own device
 * while sharing centralized state in the daemon.
 */
export interface SessionReleaseSnapshot {
  sessionId: string;
  deviceId: string;
  releaseReason: string;
  releasedAtMs: number;
  terminal: boolean;
  /** PID of the other daemon that claimed the device, when the terminal reason names one (#11098). */
  ownerPid?: number;
  /**
   * Set to `managed-execution` when a broker binding execution's session is released on a live path
   * (commit or forced stuck release), so release listeners can keep its binding assignment while
   * clearing the execution owner (#11177). Absent for every other policy.
   */
  livenessPolicy?: typeof MANAGED_EXECUTION_LIVENESS_POLICY;
  heartbeat: {
    lastHeartbeatMs: number;
    hasReceivedHeartbeat: boolean;
    timeoutMs: number;
    ageMs: number;
  };
}

export {
  DaemonSessionCreationRejectedError,
  SessionHeldByRecoveryError,
  SessionRebindingError,
  SessionSuspectError,
  SessionTerminalReleaseInProgressError,
  TerminalSessionError,
} from "./sessionErrors";
export {
  SESSION_HELD_BY_RECOVERY_CODE,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
  SessionNoLongerOwnsDeviceError,
};

/** Idle expiry has no caller to return the device; its diagnostic may name a heartbeat timeout. */
export interface SessionReleaseOptions {
  /** The serial was replaced or this daemon no longer holds it: drop state without device writes. */
  deviceIdentityReplaced?: boolean;
  /** Device-restart release persistence, including a retry after a failed write. */
  releasePersisted?: Promise<void>;
  expiryOrigin?: "lazy-expiry" | "cleanup-expired";
  /** Set by the expiry handler when it owns the ordered device return after release. */
  deviceReleaseManaged?: boolean;
  /**
   * A terminal reason upgrading a release that already finalized and was already notified
   * (#10825). Its device may belong to another session by now, so device-keyed cleanup must
   * ignore it; only observers of the release reason (the broadcaster) act on it.
   */
  upgradeOnly?: boolean;
}

export type SessionReleaseCallback = (
  sessionId: string,
  deviceId: string,
  releaseReason: string,
  snapshot: SessionReleaseSnapshot,
  options: SessionReleaseOptions,
) => void;
export type SessionCreatedCallback = (session: Session) => void;
export type ReleaseDeviceHold =
  | { skipDeviceWrites: true }
  | { settled: Promise<"teardown" | "skip-device-writes">; capMs: number };
export interface SessionExecutionMetadata {
  executionId: string;
  /** When the call started, on the wall clock of the tracker that stamped it. */
  startTime: number;
  /**
   * {@link startTime} on the session clock, captured when the call started (#11290). Session
   * stamps are judged against this; without it the start is converted with the offset in force
   * when the session is looked up, which is the same instant unless the wall clock stepped in
   * between.
   */
  sessionClockStartTime?: number;
}

export interface ActiveSessionExecutionQuery {
  /** Count only session-preserving recovery, without consulting tracked executions. */
  recoveryOnly?: boolean;
  startedAtOrBefore?: number;
  /** Compare the start captured on the session clock, immune to wall-clock steps (#11290). */
  sessionClockStartedAtOrBefore?: number;
  /** Admission only: count non-aborted work within its deadline or its undated allowance. */
  liveOnSessionClock?: { at: number; undatedForMs: number };
  excludeExecutionId?: string;
  /** Count control calls only: reads never hold idle or owner-disconnect release (#11381). */
  excludeReads?: boolean;
}

export type ActiveSessionExecutionChecker = (
  sessionId: string,
  query?: ActiveSessionExecutionQuery,
) => boolean;

/**
 * The latest request deadline among a session's in-flight executions, on the session manager's
 * clock; `Number.POSITIVE_INFINITY` or undefined when some execution carries no deadline. Same
 * contract as `SessionExecutionProbe.latestExecutionDeadlineMs` (#10712).
 */
export type SessionExecutionDeadlineLookup = (
  sessionId: string,
  /** With `excludeReads`, reads' deadlines are left out, as the reads themselves are (#11322). */
  query?: Pick<ActiveSessionExecutionQuery, "excludeReads">,
) => number | undefined;

/**
 * Aborts a session's in-flight executions before an idle-expiry release overrides them (#10820).
 * Must signal the aborts synchronously: the expiry release starts in the same turn. `cancellation`
 * is what the calls are aborted with: the typed release, so their callers get the terminal
 * `session_ownership_lost` refusal rather than a generic abort (#11381).
 */
export type ExpiryReleaseExecutionCanceller = (
  sessionId: string,
  cancellation: SessionReleasedDuringCallError,
  query: ActiveSessionExecutionQuery,
  /**
   * The device the released session holds. A derived label session's release cuts its base
   * session's calls only where they drive this device.
   */
  releasedDeviceId?: string,
) => void;

/**
 * Aborts the sessionless executions driving a device a session just acquired (#10829). Must signal
 * the aborts synchronously: the new holder may drive the device in the same turn.
 */
export type DeviceAcquisitionExecutionCanceller = (deviceId: string, sessionId: string) => void;

export type SessionDeviceUnboundCallback = (
  sessionId: string,
  deviceId: string,
  options?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
) => void;

export interface SessionReleaseOperation extends PendingSessionRelease {
  options: SessionReleaseOptions;
  identityReplacement?: {
    deviceId: string;
    final: boolean;
    commitFences: ReleaseCommitFence[];
    resumeStep: number;
  };
  teardownStep?: number;
  teardownResumeStep?: number;
  teardownStages?: ReleaseTeardownStage[];
  session: Session;
  /** Suspect before the handoff: the owner's existing grace still runs across teardown (#11691). */
  judgeSuspectOwnerAtCommit?: boolean;
  /** Owner proof received during this release; never advances session activity or idle clocks. */
  ownerHeartbeatDuringRelease?: number;
  commitFenced?: boolean;
  /** A declined commit fence keeps the session live; its rewrite has no forced-release bound. */
  commitDeclined?: boolean;
  /** When the release started; bounds the retry hint for a bind it refuses (#10960). */
  startedAtMs?: number;
  /** Captured before teardown can clear state: first attempts, two writes and scheduling slack. */
  stuckDeadlineMs: number;
  /** Ownership holds bound teardown from their cap while waiting, and from their end once settled. */
  teardownStartsByMs?: number;
  /** Set for an idle release the manager started itself (#11481): see `getIdleReleasesInProgress`. */
  expiryOrigin?: SessionReleaseOptions["expiryOrigin"];
  /** The release's current stage, named when it is reported stuck (#10963). */
  stage?: SessionReleaseStage;
  /** Set once a stuck release has been forced: it no longer holds the device (#10963). */
  forced?: boolean;
  /**
   * Aborted when the release is forced (#11058): its teardown restores run under this signal, so
   * once the device may belong to the next owner nothing the stuck release started still drives it.
   */
  forcedAbort?: AbortController;
}

/** Whether a release was forced while it awaited: it must not touch the device again (#11058). */
export function releaseWasForced(operation: SessionReleaseOperation | undefined): boolean {
  return operation?.forced === true;
}

/** Where an in-flight release is, for a stuck-release report (#10963). */
export type SessionReleaseStage =
  | "awaiting-rebind"
  | "awaiting-ownership"
  | "teardown"
  | "terminal-persist"
  | "finalize-persist";

function setReleaseStage(
  operation: SessionReleaseOperation | undefined,
  stage: SessionReleaseStage,
): void {
  if (operation) {
    operation.stage = stage;
  }
}

export interface SessionDeviceAssigner {
  assignDeviceToSession(
    sessionId: string,
    platform?: Platform,
    recoveryTarget?: SessionRecoveryTarget,
  ): Promise<string>;
  /**
   * Hold each row's device for that row while restart recovery works through the rows (#11294).
   * The assigner must exempt a row's own recovery from its reservation, and may decline a device
   * (one a broker binding holds). Optional: an assigner without it recovers rows unreserved.
   */
  reserveDevicesForRehydration?(rows: readonly RehydrationDeviceReservation[]): Promise<void>;
  /** Give up the reservation made for `sessionId`; a no-op when there is none. */
  releaseRehydrationReservation?(sessionId: string): void;
}

/** The device a persisted row will be recovered onto, held for that row's session id (#11294). */
export interface RehydrationDeviceReservation {
  sessionId: string;
  target: Pick<
    SessionRecoveryTarget,
    "platform" | "stableDeviceId" | "deviceId" | "androidEmulator"
  >;
}

/**
 * How a call uses the session it names. `acquire` is the client's own control call: admitted
 * only on a usable session, and it is use (it restarts the idle window and reclaims an
 * awaiting-owner session). `read-only` is never refused and never use. `non-owner-control` is a
 * control call made on the holder's behalf by something that is not the session's client (a
 * desktop pane's direct `input/*`, #11417): it passes the same refusals as `acquire` (suspect,
 * lapsed owner lease, idle expiry) but changes nothing on admission — no reclaim of an
 * awaiting-owner session, no activity or liveness stamp, no restart-recovery credit.
 */
export type SessionAccess = "acquire" | "read-only" | "non-owner-control";

/** Persisted identity required before recovering a session after daemon restart. */
export interface SessionRecoveryTarget {
  platform: Platform;
  stableDeviceId: string;
  /** Transport identity recorded before the daemon restart. */
  deviceId: string;
  /** Distinguishes an Android AVD name from a physical-device serial. */
  androidEmulator?: boolean;
  /** Only device-restart releases may wait, bounded by session expiry and restart grace. */
  restartRecoveryDeadlineMs?: number;
  /** Shared acquisitions bound their callers separately using the pool's recovery error. */
  onRecoveryWait?: (wait: RecoveryAssignmentWait) => void;
  /** Liveness contract recorded before the daemon restart. */
  liveness?: SessionRecoveryLiveness;
  /** A startup rehydration reserves the device until its prior owner reconnects. */
  initialOwnership?: "owned" | "awaiting-owner";
  /** Autolock identity that the pool must restore before publishing the session. */
  persistenceMetadata?: SessionPersistenceMetadata;
}

export interface RehydrationSummary {
  rehydrated: string[];
  terminalized: Array<{ sessionUuid: string; reason: string }>;
  skipped: Array<{ sessionUuid: string; reason: string }>;
  timedOut: boolean;
}

/**
 * The durable portion of a session's liveness state needed while re-materializing
 * it after a daemon restart. Optional on {@link SessionRecoveryTarget} so an
 * assigner compiled against the older recovery-target contract remains valid.
 */
export interface SessionRecoveryLiveness {
  sessionTimeoutMs: number;
  heartbeatTimeoutMs: number;
  heartbeatTimeoutSource: "default" | "custom";
  hasReceivedHeartbeat: boolean;
  livenessPolicy: SessionLivenessPolicy;
  preCliLiveness?: PreCliLivenessSnapshot;
}

export type SessionRecoveryFailureReason =
  | "target-absent"
  | "target-busy"
  | "identity-continuity-lost"
  | "owned-by-other-daemon";

/** Which other daemon holds a recovery target (reason `owned-by-other-daemon`, #11076). */
export interface SessionRecoveryForeignOwner {
  deviceId: string;
  ownerPid: number | undefined;
}
export { SessionRecoveryIdentityLossError } from "./sessionManager/SessionRecoveryIdentityLossError";

/** Optional inputs to {@link SessionManager.createSession}. */
export interface CreateSessionOptions {
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  stableDeviceId?: string;
  recoveredLiveness?: SessionRecoveryLiveness;
  initialOwnership?: "owned" | "awaiting-owner";
  /** Persisted `source` recording who created the session; a rehydrated row's own wins. */
  persistenceSource?: string;
  signal?: AbortSignal;
}

function withCreateSessionDefaults(
  options: CreateSessionOptions,
): CreateSessionOptions & { initialOwnership: "owned" | "awaiting-owner" } {
  return { ...options, initialOwnership: options.initialOwnership ?? "owned" };
}

export interface RebindSessionOptions {
  /**
   * The runtime behind the same device ID restarted, so device-scoped session
   * state must be cleared even though the serial is unchanged.
   */
  force?: boolean;
  /** Durable identity of the replacement device. */
  stableDeviceId?: string;
  signal?: AbortSignal;
  /** Internal owner proving that a shutdown reservation authorized this recovery rebind. */
  terminalReleaseReservationOwner?: symbol;
  /** Only receipt-backed acquisitions can decide delivery versus undo. */
  deferCleanup?: (cleanup: DeferredRebindCleanup) => void;
}

export const KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS = 1_000;
export const BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS = 1_000;
export const NETWORK_CONDITION_RESTORE_TIMEOUT_MS = 1_000;
/**
 * Clock restore ends with `adb unroot`, which restarts adbd: the device goes offline and the
 * restore only finishes once it reconnects (a few seconds on an emulator). The network path's
 * 1 s deadline fired on every successful restore and quarantined it for nothing (#10771).
 */
export const CLOCK_RESTORE_TIMEOUT_MS = 15_000;
export const NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS = 250;
const DEFAULT_SCREEN_READER_RESTORE_BACKOFF = exponentialBackoff({
  initialDelayMs: 250,
  maxDelayMs: 2_000,
});
const DEFAULT_ROTATION_RESTORE_BACKOFF = exponentialBackoff({
  initialDelayMs: NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS,
  maxDelayMs: 2_000,
});
export const SESSION_SETUP_DRAIN_TIMEOUT_MS = 1_000;
/**
 * Cap for pending keep-awake, biometric and network teardown retries, measured with the
 * injected Timer. The release awaits their separately bounded first attempts, then hands
 * pending work back as device cleanup. Teardown runs under its own signal, not the caller's;
 * this cap stops wedged retries from holding the device quarantined. Screen-reader, clock
 * and rotation restores keep their own budgets and abandon mechanisms (#10198).
 */
export const SESSION_RELEASE_TEARDOWN_CAP_MS = 10_000;
/**
 * Bound on one release's `markReleased` write (#10836). It is the only await on the release
 * path that has no budget of its own, so a wedged DB write would otherwise hold the session's
 * device forever. A terminal release that reaches it keeps the session fenced in memory, frees
 * the device, and leaves the row for a later release to persist. It is longer than the shutdown
 * release drain by 1 s, so a write wedged at shutdown still keeps the database open and the
 * release on the drain's daemon-shutdown fallback path.
 */
export const SESSION_RELEASE_PERSIST_TIMEOUT_MS = SESSION_RELEASE_DRAIN_TIMEOUT_MS + 1_000;
/**
 * Scheduling slack between stages separated only by microtasks; monitor scan granularity is
 * budgeted separately. This is the only slack a release waiting on a pending rebind gets.
 */
export const SESSION_RELEASE_STUCK_MARGIN_MS = 2_000;
/** First attempts plus two row writes and scheduling slack: 18 s without own-budget state. */
export const SESSION_RELEASE_STUCK_DEADLINE_MS =
  SESSION_SETUP_DRAIN_TIMEOUT_MS +
  KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS +
  BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS +
  NETWORK_CONDITION_RESTORE_TIMEOUT_MS +
  2 * SESSION_RELEASE_PERSIST_TIMEOUT_MS +
  SESSION_RELEASE_STUCK_MARGIN_MS;

/**
 * The first attempts a release actually awaits: 18 s plus clock (15 s), rotation (1 s) and
 * screen-reader (35 s) budgets when it carries that state. Pending retries do not hold release.
 */
export function getSessionReleaseStuckDeadlineMs(
  state?: Pick<SessionCacheData, "clock" | "rotation" | "screenReader">,
): number {
  return (
    SESSION_RELEASE_STUCK_DEADLINE_MS +
    (state?.clock ? CLOCK_RESTORE_TIMEOUT_MS : 0) +
    (state?.rotation ? NETWORK_CONDITION_RESTORE_TIMEOUT_MS : 0) +
    (state?.screenReader ? SCREEN_READER_RESTORE_TIMEOUT_MS : 0)
  );
}

/**
 * Force at the first scan at or after the per-release deadline measured from teardown's start
 * (the ownership hold's cap while pending), even when a monitor reap joins it: one interval,
 * then the capped forced quarantine. A second interval allows a late timer tick. With the
 * default 2 s interval this advertises 32 s without clock, rotation or screen-reader state.
 * Every release in flight is tracked and forced by the monitor at its stuck deadline.
 */
export function getSessionReleaseCleanupWorstCaseMs(
  env: NodeJS.ProcessEnv = process.env,
  state?: Pick<SessionCacheData, "clock" | "rotation" | "screenReader">,
): number {
  return (
    getSessionReleaseStuckDeadlineMs(state) +
    2 * getSessionHeartbeatCheckIntervalMs(env) +
    SESSION_RELEASE_TEARDOWN_CAP_MS
  );
}

export type { AbandonablePendingDeviceCleanup } from "./deviceCleanupQuarantine";
/**
 * Bound on a session creation's own waits (#10963): a release of the same UUID still in flight,
 * and the creation's DB reads and writes. A device bind runs these under the pool's assignment
 * mutex, and the SQLite dialect queues every query behind an open transaction, so an unbounded
 * await held every other assignment for as long as the DB stayed wedged. Covers a release's
 * capped teardown and its bounded writes, with margin, like the pool's create-release wait.
 */
export const SESSION_CREATE_WAIT_TIMEOUT_MS =
  SESSION_RELEASE_TEARDOWN_CAP_MS + 2 * SESSION_RELEASE_PERSIST_TIMEOUT_MS + 10_000;
/** Non-terminal release reason recorded for a creation abandoned at its deadline (#10963). */
export const SESSION_CREATION_TIMEOUT_REASON =
  "session-creation-timeout" satisfies SessionReleaseReason;

/**
 * Retry delays for a terminal release write that timed out and then failed (#10959). The in-memory
 * fence keeps the UUID refused for this process; the row must still become terminal before a
 * restart, or the next daemon would admit the released UUID again. Retried until it lands.
 */
export const DEFAULT_TERMINAL_RELEASE_RETRY_BACKOFF: BackoffPolicy = exponentialBackoff({
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
});
// The superseded-row rewrite retry policy moved to the row writer's ledger (#11799 W3).
export { UnissuedSessionError } from "./sessionManager/UnissuedSessionError";
export {
  DEFAULT_SUPERSEDED_ROW_REASSERT_BACKOFF,
  SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS,
} from "./supersededRowReasserts";
export const SESSION_REHYDRATION_DEADLINE_MS = 15_000;
/** Persisted rows recovered at once during startup rehydration (#11114). */
export const SESSION_REHYDRATION_CONCURRENCY = 4;

/**
 * Synchronous commit predicate for a conditional release. Returning `false`
 * abandons the release without removing the session.
 */
export type ReleaseCommitFence = () => boolean;

/** DevicePool may defer or retry automatic release of a retained recovery fence. */
export interface RecoveryExpiryReleaseHandler {
  release(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    attempt: () => Promise<string | null>,
    options: SessionReleaseOptions,
  ): Promise<string | null> | undefined;
}

export type ConditionalSessionRelease =
  | { superseded: true }
  | { superseded: false; deviceId: string | null };

/** Plan cleanup frees devices; the base and label UUIDs may be issued again by name (not rehydrated). */
export const PLAN_AUTO_RELEASE_REASON = "plan-auto-release" satisfies SessionReleaseReason;

export function getDefaultSessionHeartbeatTimeoutMs(): number {
  return readEnvPositiveInteger(
    ENV.SESSION_HEARTBEAT_TIMEOUT_MS.name,
    ENV.SESSION_HEARTBEAT_TIMEOUT_MS.legacyName,
    { fallback: SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS },
  );
}

/**
 * The CLI idle-timeout contract lives in `./constants` so the CLI-side proxy can
 * resolve its own override without importing the daemon's session machinery
 * (issue #6870 review). Re-exported here for the daemon-side callers and tests
 * that have always read it from this module.
 */
export {
  DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
  getCliSessionIdleTimeoutMs,
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
  sanitizeCliSessionIdleTimeoutMs,
} from "./constants";

/** Default grace before a never-heartbeated default-policy session is reaped. */
export const DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS = 5_000;
// Give a restarted emulator the same three-minute cold-boot allowance as device readiness.
export const DEVICE_RESTART_RECOVERY_WINDOW_MS = DEFAULT_DEVICE_READY_TIMEOUT_MS;

/**
 * The grace `SessionHeartbeatMonitor` applies before reaping a default-policy
 * session that never sent its first heartbeat. Single-sourced here so the
 * `missing-first-heartbeat` release snapshot reports the deadline that actually
 * fired — the grace, not the (longer) heartbeat timeout — instead of leaving a
 * reader to conclude the daemon reaped early (issue #5689).
 */
export function getDefaultPreFirstHeartbeatGraceMs(): number {
  return readEnvPositiveInteger(
    ENV.SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS.name,
    ENV.SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS.legacyName,
    { fallback: DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS },
  );
}

export class SessionManager {
  private waitOutRebindOf(session: Session): Promise<void> {
    return this.supersededRows.waitOutRebindOf(session);
  }

  private waitOutReleaseOf(sessionId: string): Promise<void> {
    return this.supersededRows.waitOutReleaseOf(sessionId);
  }

  private async rejectRefusedRebind(
    existing: Session,
    rebind: { session: Session; promise: Promise<Session> },
    error: DeviceSessionRowNotRewritableError,
  ): Promise<never> {
    const sessionId = existing.sessionId;
    // The failed write never published its binding. End a terminal UUID after the rebind's
    // promise has rejected, so the release cannot wait on the very rebind adopting it.
    if (this.sessionSlots.getRebind(sessionId) === rebind) {
      this.sessionSlots.deleteRebind(sessionId);
    }
    const adoption = this.endSessionTerminallyReleasedInRow(existing);
    // Include the row read and any release it starts: the inner rebind already rejected.
    this.trackReleaseDrainWrite(
      adoption.then(
        () => {},
        (error: unknown) => {
          logger.warn(`[SessionManager] Rebind refusal adoption failed: ${errorMessage(error)}`);
        },
      ),
    );
    const terminal = await adoption;
    throw terminal instanceof TerminalSessionError ? terminal : error;
  }
  /** Raw persistence lookup, without the live session lookup's lazy expiry or recovery projection. */
  private readSessionRow(sessionId: string): Promise<DeviceSession | undefined> {
    return this.deviceSessionRepository.getSession(sessionId);
  }

  private readonly collaboratorHost = this.createCollaboratorHost();

  private readonly restoreHealth = new DeviceRestoreHealth(this.collaboratorHost);

  private readonly persistedAdmission = new PersistedSessionAdmission(this.collaboratorHost);

  private readonly recovery = new SessionRecovery(this.collaboratorHost);

  private readonly rehydration = new SessionRehydration(this.collaboratorHost);

  private readonly rebinding = new SessionRebinding(this.collaboratorHost);

  private readonly supersededRows = new SupersededSessionRows(this.collaboratorHost);

  private readonly releasePersistence = new SessionReleasePersistence(this.collaboratorHost);

  private readonly activityPersistence = new SessionActivityPersistence(this.collaboratorHost);

  private readonly leaseExpiry = new SessionLeaseExpiry(this.collaboratorHost);

  private readonly cache = new SessionCache(this.collaboratorHost);

  private readonly acquisition = new SessionAcquisition(this.collaboratorHost);

  private readonly releaseRequests = new SessionReleaseRequests(this.collaboratorHost);

  private readonly planLabelsLifecycle = new SessionPlanLabels(this.collaboratorHost);

  private readonly creation = new SessionCreation(this.collaboratorHost);
  private createCollaboratorActions(): SessionManagerCollaboratorActions {
    return {
      isTerminalReleaseRetryCurrent: (...args) => this.isTerminalReleaseRetryCurrent(...args),
      retryTerminalReleaseWrite: (...args) => this.retryTerminalReleaseWrite(...args),
      dropReleaseRetry: (...args) => this.dropReleaseRetry(...args),
      refuseLabelMintOutsidePlanAllocation: (...args) =>
        this.refuseLabelMintOutsidePlanAllocation(...args),
      rejectRefusedRebind: (...args) => this.rejectRefusedRebind(...args),
      readSessionRow: (sessionId) => this.readSessionRow(sessionId),
      dispatchDeviceRestore: (...args) => this.dispatchDeviceRestore(...args),
      sessionNow: (...args) => this.sessionNow(...args),
      isRowOwnedByLivePeer: (...args) => this.isRowOwnedByLivePeer(...args),
      isSessionBeingRecreated: (...args) => this.isSessionBeingRecreated(...args),
      sessionClockToWall: (...args) => this.sessionClockToWall(...args),
      rowWriteLivePeerDaemonSessionIds: (...args) => this.rowWriteLivePeerDaemonSessionIds(...args),
      releaseSnapshotFromPersisted: (...args) => this.releaseSnapshotFromPersisted(...args),
      persistSessionRelease: (...args) => this.persistSessionRelease(...args),
      notifySessionRelease: (...args) => this.notifySessionRelease(...args),
      isLapsedUnownedRestartRecovery: (...args) => this.isLapsedUnownedRestartRecovery(...args),
      admitPersistedSession: (...args) => this.admitPersistedSession(...args),
      isReissuablePersistedSession: (...args) => this.isReissuablePersistedSession(...args),
      recoverPersistedRow: (...args) => this.recoverPersistedRow(...args),
      readPersistedSession: (...args) => this.readPersistedSession(...args),
      unlessBeingReplaced: (...args) => this.unlessBeingReplaced(...args),
      terminalReleaseFromPersisted: (...args) => this.terminalReleaseFromPersisted(...args),
      recoveredRowOwner: (...args) => this.recoveredRowOwner(...args),
      isNameReissueOnlyRow: (...args) => this.isNameReissueOnlyRow(...args),
      terminalizePersistedRecoveryFailure: (...args) =>
        this.terminalizePersistedRecoveryFailure(...args),
      recoveryLivenessFromPersisted: (...args) => this.recoveryLivenessFromPersisted(...args),
      newSharedAssignment: (...args) => this.newSharedAssignment(...args),
      recoverPersistedSession: (...args) => this.recoverPersistedSession(...args),
      waitForSharedAssignment: (...args) => this.waitForSharedAssignment(...args),
      applyRecoveredTerminalReleaseIntents: (...args) =>
        this.applyRecoveredTerminalReleaseIntents(...args),
      listRecoverableSessionsBeforeDeadline: (...args) =>
        this.listRecoverableSessionsBeforeDeadline(...args),
      rehydratePersistedRow: (...args) => this.rehydratePersistedRow(...args),
      isRecoverablePersistedSession: (...args) => this.isRecoverablePersistedSession(...args),
      assertTerminalRebindAdmission: (...args) => this.assertTerminalRebindAdmission(...args),
      createSession: (...args) => this.createSession(...args),
      notifyDeviceOwnershipChange: (...args) => this.notifyDeviceOwnershipChange(...args),
      rebindSession: (...args) => this.rebindSession(...args),
      flushDeferredRebindCleanups: (...args) => this.flushDeferredRebindCleanups(...args),
      persistAndPublishRebind: (...args) => this.persistAndPublishRebind(...args),
      endSessionTerminallyReleasedInRow: (...args) =>
        this.endSessionTerminallyReleasedInRow(...args),
      trackReleaseDrainWrite: (...args) => this.trackReleaseDrainWrite(...args),
      getSessionForDevice: (...args) => this.getSessionForDevice(...args),
      trackPendingTeardownCleanup: (...args) => this.trackPendingTeardownCleanup(...args),
      registerPendingDeviceCleanup: (...args) => this.registerPendingDeviceCleanup(...args),
      isCurrentSession: (...args) => this.isCurrentSession(...args),
      persistSession: (...args) => this.persistSession(...args),
      awaitInFlightOwnRowWrites: (...args) => this.awaitInFlightOwnRowWrites(...args),
      scheduleTerminalReleaseRetry: (...args) => this.scheduleTerminalReleaseRetry(...args),
      captureReleaseRowGeneration: (...args) => this.captureReleaseRowGeneration(...args),
      recordPendingNonTerminalRelease: (...args) => this.recordPendingNonTerminalRelease(...args),
      retryRefusedRowWrite: (...args) => this.retryRefusedRowWrite(...args),
      retryNonTerminalRowAfterRelease: (...args) => this.retryNonTerminalRowAfterRelease(...args),
      reassertSupersededLiveRow: (...args) => this.reassertSupersededLiveRow(...args),
      restoreNonTerminalRowOverSupersededRelease: (...args) =>
        this.restoreNonTerminalRowOverSupersededRelease(...args),
      retryTerminalRowAfterRelease: (...args) => this.retryTerminalRowAfterRelease(...args),
      waitOutRecreationOf: (...args) => this.waitOutRecreationOf(...args),
      replaceSupersededReleaseRow: (...args) => this.replaceSupersededReleaseRow(...args),
      getLegacyLifecycleView: (...args) => this.getLegacyLifecycleView(...args),
      isAdmittedForAutomation: (...args) => this.isAdmittedForAutomation(...args),
      guardedRowRewriteOptions: (...args) => this.guardedRowRewriteOptions(...args),
      isRebindUnderWay: (...args) => this.isRebindUnderWay(...args),
      oweSupersededRowReassert: (...args) => this.oweSupersededRowReassert(...args),
      restoreNonTerminalRowAfterReassert: (...args) =>
        this.restoreNonTerminalRowAfterReassert(...args),
      reassertOwedLiveRowForActivity: (...args) => this.reassertOwedLiveRowForActivity(...args),
      getPersistedTerminalRelease: (...args) => this.getPersistedTerminalRelease(...args),
      cancelExecutionsCutByRelease: (...args) => this.cancelExecutionsCutByRelease(...args),
      releaseSessionForReason: (...args) => this.releaseSessionForReason(...args),
      releaseSession: (...args) => this.releaseSession(...args),
      deviceHeldForLateRead: (...args) => this.deviceHeldForLateRead(...args),
      unlessBaseEnded: (...args) => this.unlessBaseEnded(...args),
      wallToSessionClock: (...args) => this.wallToSessionClock(...args),
      peekSession: (...args) => this.peekSession(...args),
      judgedLeaseHeartbeat: (...args) => this.judgedLeaseHeartbeat(...args),
      ownershipSessionUuid: (...args) => this.ownershipSessionUuid(...args),
      getBaseSessionOfDerivedLabel: (...args) => this.getBaseSessionOfDerivedLabel(...args),
      getReleasingSession: (...args) => this.getReleasingSession(...args),
      upgradeReleaseReason: (...args) => this.upgradeReleaseReason(...args),
      terminalReleaseAsOfNow: (...args) => this.terminalReleaseAsOfNow(...args),
      findSession: (...args) => this.findSession(...args),
      updateSessionCache: (...args) => this.updateSessionCache(...args),
      getDeviceReadiness: (...args) => this.getDeviceReadiness(...args),
      invalidateAutomationReadiness: (...args) => this.invalidateAutomationReadiness(...args),
      getBiometricEnrollment: (...args) => this.getBiometricEnrollment(...args),
      getNetworkCondition: (...args) => this.getNetworkCondition(...args),
      reclaimAndRefreshExistingSession: (...args) => this.reclaimAndRefreshExistingSession(...args),
      recordRestartRecoveryActivity: (...args) => this.recordRestartRecoveryActivity(...args),
      getOrCreateSession: (...args) => this.getOrCreateSession(...args),
      observeSessionForRead: (...args) => this.observeSessionForRead(...args),
      unadmittedSessionError: (...args) => this.unadmittedSessionError(...args),
      terminalizeExpiredPersistedSession: (...args) =>
        this.terminalizeExpiredPersistedSession(...args),
      refusePlanLabelSessionOutsideItsRun: (...args) =>
        this.refusePlanLabelSessionOutsideItsRun(...args),
      expireIfDue: (...args) => this.expireIfDue(...args),
      markIdentityReplacedRelease: (...args) => this.markIdentityReplacedRelease(...args),
      createReleaseReasonState: (...args) => this.createReleaseReasonState(...args),
      judgeOwnerLeaseForRelease: (...args) => this.judgeOwnerLeaseForRelease(...args),
      finishReleaseForcedBeforeStart: (...args) => this.finishReleaseForcedBeforeStart(...args),
      releaseSessionInternal: (...args) => this.releaseSessionInternal(...args),
      finishIdentityReplacedRelease: (...args) => this.finishIdentityReplacedRelease(...args),
      releaseFinalizedSession: (...args) => this.releaseFinalizedSession(...args),
      persistTerminalReleaseIfNeeded: (...args) => this.persistTerminalReleaseIfNeeded(...args),
      isLiveDaemonSession: (...args) => this.isLiveDaemonSession(...args),
      liftTerminalFence: (...args) => this.liftTerminalFence(...args),
      endedBaseOfLabel: (...args) => this.endedBaseOfLabel(...args),
      rejectCreationAfterShutdownFence: (...args) => this.rejectCreationAfterShutdownFence(...args),
      assertTerminalReleaseAdmission: (...args) => this.assertTerminalReleaseAdmission(...args),
      invalidateFinalizedSessionIdentity: (...args) =>
        this.invalidateFinalizedSessionIdentity(...args),
      cancelSessionlessUseOnAcquisition: (...args) =>
        this.cancelSessionlessUseOnAcquisition(...args),
      notifySessionCreated: (...args) => this.notifySessionCreated(...args),
      creationRowRollbackSnapshot: (...args) => this.creationRowRollbackSnapshot(...args),
      retireAbandonedCreation: (...args) => this.retireAbandonedCreation(...args),
    };
  }

  private createCollaboratorHost(): SessionManagerCollaboratorHost {
    const manager = this;
    return {
      ...this.createCollaboratorActions(),
      get stateRestore() {
        return manager.stateRestore;
      },
      get timer() {
        return manager.timer;
      },
      get acceptingSessionCreations() {
        return manager.acceptingSessionCreations;
      },
      get deviceSessionRepository() {
        return manager.deviceSessionRepository;
      },
      get recoveredIntents() {
        return manager.recoveredIntents;
      },
      get getBarrier() {
        return manager.getBarrier?.bind(manager);
      },
      get sessionSlots() {
        return manager.sessionSlots;
      },
      get daemonSessionId() {
        return manager.daemonSessionId;
      },
      get activeSessionExecutionChecker() {
        return manager.activeSessionExecutionChecker?.bind(manager);
      },
      get sessions() {
        return manager.sessions;
      },
      get superseded() {
        return manager.superseded;
      },
      get liveDaemonSessionIds() {
        return manager.liveDaemonSessionIds?.bind(manager);
      },
      get SESSION_TIMEOUT_MS() {
        return manager.SESSION_TIMEOUT_MS;
      },
      get lateRehydrationListener() {
        return manager.lateRehydrationListener;
      },
      get slotShadowProbe() {
        return manager.slotShadowProbe;
      },
      get deviceHealth() {
        return manager.deviceHealth;
      },
      get persistedRowGenerations() {
        return manager.persistedRowGenerations;
      },
      get releaseRowGenerations() {
        return manager.releaseRowGenerations;
      },
      get finalizedSessionReleases() {
        return manager.finalizedSessionReleases;
      },
      get supersededRowReassertRetries() {
        return manager.supersededRowReassertRetries;
      },
      get rowWriter() {
        return manager.rowWriter;
      },
      get forcedStuckRelease() {
        return manager.forcedStuckRelease;
      },
      get restartReleasePersistence() {
        return manager.restartReleasePersistence;
      },
      get restartRecoveryActivityAt() {
        return manager.restartRecoveryActivityAt;
      },
      get stallProbe() {
        return manager.stallProbe?.bind(manager);
      },
      get livenessOwnerCallInFlightReader() {
        return manager.livenessOwnerCallInFlightReader;
      },
      get liveness() {
        return manager.liveness;
      },
      get sessionExecutionDeadlineLookup() {
        return manager.sessionExecutionDeadlineLookup?.bind(manager);
      },
      get expiryReleaseExecutionCanceller() {
        return manager.expiryReleaseExecutionCanceller?.bind(manager);
      },
      get recoveryExpiryReleaseHandler() {
        return manager.recoveryExpiryReleaseHandler;
      },
      get releaseDeviceHold() {
        return manager.releaseDeviceHold;
      },
      get planLabels() {
        return manager.planLabels;
      },
      get observerSessions() {
        return manager.observerSessions;
      },
      get deviceSessionMap() {
        return manager.deviceSessionMap;
      },
    };
  }

  private stallProbe: (() => void) | undefined;
  private sessions: Map<string, Session> = new Map();
  private deviceSessionMap: Map<string, string> = new Map(); // deviceId -> sessionId (reverse lookup)
  private cleanupTimer: NodeJS.Timeout | null = null;
  private get rehydrationFollowUpTimer(): NodeJS.Timeout | null {
    return this.rehydration.rehydrationFollowUpTimer;
  }
  private set rehydrationFollowUpTimer(value: NodeJS.Timeout | null) {
    this.rehydration.rehydrationFollowUpTimer = value;
  }

  private timer: Timer;
  /** The clock every session timestamp is stamped and judged with (#11080); see {@link sessionNow}. */
  private readonly sessionClock: SteadyWallClock;
  private releaseCallbacks: SessionReleaseCallback[] = [];
  private readonly restartReleasePersistence = new WeakMap<
    SessionReleaseSnapshot,
    PromiseWithResolvers<void>
  >();
  private readonly planLabels = new PlanLabelRegistry({
    hasSession: (sessionId) => this.sessions.has(sessionId),
  });
  private createdCallbacks: SessionCreatedCallback[] = [];
  private deviceUnboundCallbacks: SessionDeviceUnboundCallback[] = [];
  private readonly deviceOwnershipCallbacks = new Set<
    (deviceId: string, frameInvalidation: "generation-only" | "full") => void
  >();
  private rowWriter: SessionRowWriter;
  /** Crash-safe sidecar of terminal releases whose row write has not landed (#10959). */
  private terminalReleaseJournal: TerminalReleaseJournal = new NoopTerminalReleaseJournal();
  private readonly volatileTerminalReleaseIntents = new Map<string, string>();
  /**
   * The owning daemon's id, stamped on every persisted active row so a peer daemon sharing the
   * database can tell this daemon's live rows from a dead predecessor's (#11114).
   */
  private daemonSessionId: string | undefined;
  private liveDaemonSessionIds: (() => ReadonlySet<string>) | undefined;
  /** Finalized release state retained only while its exact Session identity is referenced. */
  private readonly finalizedSessionReleases: WeakMap<Session, ReleaseReasonState> = new WeakMap();
  /** The liveness owner lease and policy changes; its claim mutex serializes one session incarnation (#11797). */
  private readonly liveness: SessionLivenessController;
  private readonly recoveredIntents: RecoveredTerminalReleaseIntents;
  private readonly forcedStuckRelease: ForcedStuckRelease;
  private get persistedRowGenerations(): WeakMap<Session, number> {
    return this.activityPersistence.persistedRowGenerations;
  }

  private get retiredCreationRows(): WeakSet<Session> {
    return this.creation.retiredCreationRows;
  }

  private get releaseRowGenerations(): WeakMap<SessionReleaseSnapshot, number> {
    return this.releasePersistence.releaseRowGenerations;
  }

  private get releaseRowSessions(): WeakMap<SessionReleaseSnapshot, WeakRef<Session>> {
    return this.releasePersistence.releaseRowSessions;
  }

  /** Setup work that can modify device state after a session has been assigned. */
  private readonly sessionSetupPromises: Set<{ session: Session; promise: Promise<void> }> =
    new Set();
  /**
   * Device work that outlived its bounded release phase. The pool keeps the device assigned until
   * this settles, so no replacement session can race a late setup or keep-awake restore.
   */
  private readonly deviceCleanupQuarantine: DeviceCleanupQuarantine;
  private readonly sessionSlots = new SessionSlots<
    Promise<Session>,
    SharedSessionAssignment,
    PendingSessionCreation,
    DeviceSession,
    PendingSessionRelease,
    PendingSessionRebind,
    DeferredRebindCleanup,
    SessionReleaseOperation,
    SessionReleaseSnapshot,
    Session,
    SessionReleaseSnapshot,
    ReleaseReasonState,
    TerminalReleaseReservation,
    TerminalReleaseIntent
  >({
    rowPending: { pending: (uuid) => this.rowWriter.pending(uuid) },
    onFinalizedIdentityCollected: (uuid) => this.slotShadowProbe.transitionGuard.forget(uuid),
  });
  /** False once daemon shutdown fences acquisitions that outlive request quiescence. */
  private acceptingSessionCreations = true;
  private get restartRecoveryActivityAt(): Map<string, number> {
    return this.persistedAdmission.restartRecoveryActivityAt;
  }

  /** Row policy of an owed superseded-row rewrite; the writer's ledger schedules it (#11799). */
  private readonly supersededRowReassertRetries: OwedSupersededRowReassertCallbacks = {
    retry: (entry) => this.retryOwedSupersededRowReassert(entry),
    retryDuringDrain: (entry) => this.retryOwedSupersededRowReassertDuringDrain(entry),
  };
  private deviceSessionRepository: DeviceSessionPersistence;
  private readonly getBarrier: () => DbWriteBarrier;
  private readonly stateRestore: SessionDeviceStateRestore;
  private observerSessions?: Pick<ObserverSessionStore, "release"> &
    Partial<Pick<ObserverSessionStore, "list">> &
    Partial<StallForgivingLeases>;

  /** Retry delays for terminal release writes that failed after their deadline (#10959). */
  setTerminalReleaseRetryBackoff(backoff: BackoffPolicy): void {
    this.rowWriter.setRetryBackoff(backoff);
  }

  /** Retry delays for a live row's rewrite over its superseded release's terminal row (#11557). */
  setSupersededRowReassertBackoff(backoff: BackoffPolicy): void {
    this.superseded.setBackoff(backoff);
  }

  /** Superseded-row rewrite state, held by the row writer (#11799 W3). */
  private get superseded(): SupersededRowReasserts {
    return this.rowWriter.superseded;
  }

  /** Throws unless the daemon attached every late collaborator (their defaults are silent no-ops). */
  assertDaemonCollaboratorsAttached(): void {
    assertCollaboratorsAttached("SessionManager", {
      daemonSessionId: this.daemonSessionId,
      activeSessionExecutionChecker: this.activeSessionExecutionChecker,
      sessionExecutionDeadlineLookup: this.sessionExecutionDeadlineLookup,
      expiryReleaseExecutionCanceller: this.expiryReleaseExecutionCanceller,
      deviceAcquisitionExecutionCanceller: this.deviceAcquisitionExecutionCanceller,
    });
  }

  /** Attach the owning daemon's id; every later active-row write is stamped with it (#11114). */
  attachDaemonSessionId(daemonSessionId: string): void {
    this.daemonSessionId = daemonSessionId;
  }

  /**
   * Attach the live-daemon listing (the same one startup's stale-row sweep uses): a recoverable
   * row another live daemon has taken is not recovered here (#11200).
   */
  attachLiveDaemonSessionIds(provider: () => ReadonlySet<string>): void {
    this.liveDaemonSessionIds = provider;
  }

  /** A recovered row's dead owner is replaced by this daemon (#11114). */
  private recoveredRowOwner(): string | null {
    return this.daemonSessionId ?? null;
  }

  /**
   * Attach the terminal release journal (#10959) and adopt the intents a previous daemon left
   * unconfirmed. From here those UUIDs read as terminally released; startup rehydration then
   * writes their rows ({@link applyRecoveredTerminalReleaseIntents}).
   */
  attachTerminalReleaseJournal(journal: TerminalReleaseJournal): void {
    this.recoveredIntents.attachTerminalReleaseJournal(journal);
  }

  /**
   * Write the terminal row of every recovered intent whose row is not terminal yet, and drop the
   * intents whose rows already are. A write that fails keeps its intent (and the UUID fenced) for
   * the next startup.
   */
  applyRecoveredTerminalReleaseIntents(deadlineAt?: number): Promise<string[]> {
    return this.recoveredIntents.applyRecoveredTerminalReleaseIntents(deadlineAt);
  }

  /** Optional daemon wiring; existing constructors and device-session lookups stay unchanged. */
  setObserverSessionRegistry(
    registry: Pick<ObserverSessionStore, "release"> &
      Partial<Pick<ObserverSessionStore, "list">> &
      Partial<StallForgivingLeases>,
  ): void {
    this.observerSessions = registry;
    // Observer leases are excused the same stalls and host sleep as owner leases (#11554).
    registry.setStallProbe?.(this.stallProbe);
  }

  /**
   * Record the name a client registered for an existing device session (#10671). Diagnostic
   * only: it feeds `holderKind` and never changes ownership, liveness or deadlines.
   */
  recordSessionClientName(sessionId: string, clientName: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clientName = clientName;
    }
  }
  private get deviceHealth():
    | {
        markers: DeviceHealthMarkers;
        incarnation: (deviceId: string) => number | undefined;
        canRecover: (deviceId: string) => boolean;
        backoff: BackoffPolicy;
      }
    | undefined {
    return this.restoreHealth.deviceHealth;
  }
  private set deviceHealth(
    value:
      | {
          markers: DeviceHealthMarkers;
          incarnation: (deviceId: string) => number | undefined;
          canRecover: (deviceId: string) => boolean;
          backoff: BackoffPolicy;
        }
      | undefined,
  ) {
    this.restoreHealth.deviceHealth = value;
  }

  private get identityReplacementFences(): Map<
    string,
    { releases: Set<SessionReleaseOperation>; settled: Promise<void>; resume: () => void }
  > {
    return this.restoreHealth.identityReplacementFences;
  }

  private get replacedRestoreGenerations(): Map<string, number> {
    return this.restoreHealth.replacedRestoreGenerations;
  }

  private get activeRestoreControllers(): Map<string, Set<AbortController>> {
    return this.restoreHealth.activeRestoreControllers;
  }

  private markIdentityReplacedRelease(
    release: SessionReleaseOperation,
    options = release.options,
    shouldCommit?: ReleaseCommitFence,
  ): void {
    return this.restoreHealth.markIdentityReplacedRelease(release, options, shouldCommit);
  }

  private finishIdentityReplacedRelease(release: SessionReleaseOperation): void {
    return this.restoreHealth.finishIdentityReplacedRelease(release);
  }

  private revokeSupersededIdentityReplacement(operation?: SessionReleaseOperation): boolean {
    return this.restoreHealth.revokeSupersededIdentityReplacement(operation);
  }

  private waitForIdentityReplacement(deviceId: string, generation: number): Promise<boolean> {
    return this.restoreHealth.waitForIdentityReplacement(deviceId, generation);
  }

  /** Pause rather than consume a retry: a superseded handoff still owns its original baseline. */
  private async dispatchDeviceRestore(
    deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
    generation = this.replacedRestoreGenerations.get(deviceId) ?? 0,
    teardownStep?: number,
  ): Promise<void> {
    if (this.identityReplacementFences.has(deviceId)) {
      if (!(await this.waitForIdentityReplacement(deviceId, generation))) {
        return;
      }
    } else if ((this.replacedRestoreGenerations.get(deviceId) ?? 0) !== generation) {
      return;
    }
    const controller = new AbortController();
    let controllers = this.activeRestoreControllers.get(deviceId);
    if (!controllers) {
      controllers = new Set();
      this.activeRestoreControllers.set(deviceId, controllers);
    }
    controllers.add(controller);
    const teardown = Array.from(this.sessionSlots.activeReleases)
      .filter(
        (release) =>
          teardownStep !== undefined &&
          release.teardownStep === teardownStep &&
          release.stage === "teardown" &&
          release.session.assignedDevice === deviceId,
      )
      .map((release) => ({ release, step: release.teardownStep }));
    try {
      // Clients still receive the ambient abort, but a successful late acknowledgement only
      // becomes a failed restore for identity replacement, as ordinary teardown did on main.
      const ambient = getAbortSignal();
      const signal = ambient ? AbortSignal.any([ambient, controller.signal]) : controller.signal;
      await runWithAbortSignal(signal, () =>
        restore(signal, controller.signal, () => {
          // An acknowledged write already restored A, even if its handoff mark is later revoked.
          for (const { release, step } of teardown) {
            if (release.identityReplacement && step !== undefined) {
              release.identityReplacement.resumeStep = Math.max(
                release.identityReplacement.resumeStep,
                step + 1,
              );
            }
          }
          controller.signal.throwIfAborted();
        }),
      );
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) {
        this.activeRestoreControllers.delete(deviceId);
      }
    }
  }
  getDeviceHealthRecovery(
    deviceId: string,
    incarnation: number,
    reason: DeviceHealthReason,
  ): { recovering: boolean; retryAfterMs?: number } {
    return this.restoreHealth.getDeviceHealthRecovery(deviceId, incarnation, reason);
  }

  setDeviceHealthMarkers(
    markers: DeviceHealthMarkers,
    incarnation: (deviceId: string) => number | undefined,
    canRecover: (deviceId: string) => boolean,
    backoff: BackoffPolicy = exponentialBackoff({ initialDelayMs: 1000 }),
  ): void {
    return this.restoreHealth.setDeviceHealthMarkers(markers, incarnation, canRecover, backoff);
  }

  markDeviceNeedsAppCleanup(
    deviceId: string,
    retry: () => Promise<void>,
    retryTimeoutMs: number,
    retryKey?: string,
  ): void {
    return this.restoreHealth.markDeviceNeedsAppCleanup(deviceId, retry, retryTimeoutMs, retryKey);
  }

  markDeviceNeedsRecorderTeardown(
    deviceId: string,
    retry: () => Promise<void>,
    retryTimeoutMs: number,
    retryKey?: string,
  ): () => void {
    return this.restoreHealth.markDeviceNeedsRecorderTeardown(
      deviceId,
      retry,
      retryTimeoutMs,
      retryKey,
    );
  }

  private restoreIncarnationIsCurrent(target: {
    deviceId: string;
    incarnation?: number;
    restoreGeneration?: number;
  }): boolean {
    return this.restoreHealth.restoreIncarnationIsCurrent(target);
  }

  private clearRestoreHealth(
    target: { deviceId: string; incarnation?: number },
    reason: DeviceHealthReason,
  ): void {
    return this.restoreHealth.clearRestoreHealth(target, reason);
  }

  private abandonRestore(
    target: { deviceId: string; incarnation?: number },
    reason: Exclude<DeviceHealthReason, "clock">,
    restore: () => Promise<void>,
    restoreTimeoutMs: number = NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  ): void {
    return this.restoreHealth.abandonRestore(target, reason, restore, restoreTimeoutMs);
  }

  private activeSessionExecutionChecker: ActiveSessionExecutionChecker =
    UNATTACHED.activeSessionExecutionChecker;
  private livenessOwnerCallInFlightReader?: (ownerToken: string) => boolean;
  private ownerConnectedAtReader?: OwnerConnectedAtReader;
  // No lookup means no known deadline: the veto falls back to the unsettled-execution ceiling.
  private sessionExecutionDeadlineLookup: SessionExecutionDeadlineLookup =
    UNATTACHED.sessionExecutionDeadlineLookup;
  // No canceller means nothing to abort: only the daemon tracks executions (#10820).
  private expiryReleaseExecutionCanceller: ExpiryReleaseExecutionCanceller =
    UNATTACHED.expiryReleaseExecutionCanceller;
  private deviceAcquisitionExecutionCanceller: DeviceAcquisitionExecutionCanceller =
    UNATTACHED.deviceAcquisitionExecutionCanceller;
  // Session ids whose acquisition cancellation waits for the pool to commit the create (#10905):
  // a create can still be refused or rolled back after publish. Value: the device it published.
  private readonly deferredAcquisitionCancellations = new Map<string, string | undefined>();

  // Idle window (heartbeats, no tool call): 2 minutes from the end of the last
  // tool call, env-overridable (see `./sessionLivenessWindows`).
  private readonly SESSION_TIMEOUT_MS = getSessionIdleTimeoutMs();

  // Cleanup interval: every 5 minutes
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  static readonly DEFAULT_HEARTBEAT_TIMEOUT_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS;

  constructor(
    timer: Timer = defaultTimer,
    deviceSessionRepository: DeviceSessionPersistence = new DeviceSessionRepository(
      undefined,
      timer,
    ),
    options: SessionManagerOptions = {},
  ) {
    const restorers = options.restorers ?? {};
    this.timer = timer;
    this.sessionClock = new SteadyWallClock(timer);
    this.deviceCleanupQuarantine = new DeviceCleanupQuarantine({
      timer,
      now: () => this.sessionNow(),
      hasOwner: (deviceId) => this.getSessionForDevice(deviceId) !== null,
      teardownCapMs: SESSION_RELEASE_TEARDOWN_CAP_MS,
      defaultRetryAfterMs: DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
    });
    // Rows are read by other processes on their own session clocks: stamps cross as wall ms (#11162).
    this.deviceSessionRepository = onSessionClock(deviceSessionRepository, {
      toWall: (sessionClockMs) => this.sessionClockToWall(sessionClockMs),
      toSessionClock: (wallMs) => this.wallToSessionClock(wallMs),
    });
    this.rowWriter = SerializedSessionRowWriter.create({
      persistence: this.deviceSessionRepository,
      timer,
      backoff: DEFAULT_TERMINAL_RELEASE_RETRY_BACKOFF,
      logger,
      timeoutMs: SESSION_RELEASE_PERSIST_TIMEOUT_MS,
      timeoutError: SessionReleasePersistTimeoutError,
    });
    this.getBarrier = options.barrier ?? getDbWriteBarrier;
    const keepScreenAwake = options.keepScreenAwakeRestorer ?? defaultKeepScreenAwakeRestorer;
    const biometricEnrollment =
      options.biometricEnrollmentRestorer ?? defaultBiometricEnrollmentRestorer;
    const resolved = resolveDeviceStateRestorers(timer, restorers);
    this.stateRestore = new SessionDeviceStateRestore(
      {
        timer,
        dispatchDeviceRestore: (deviceId, restore, generation, teardownStep) =>
          this.dispatchDeviceRestore(deviceId, restore, generation, teardownStep),
        restoreGeneration: (deviceId) => this.replacedRestoreGenerations.get(deviceId) ?? 0,
        hasIdentityReplacementFence: (deviceId) => this.identityReplacementFences.has(deviceId),
        trackSessionSetup: (session, createSetup) => this.trackSessionSetup(session, createSetup),
        isPublished: (session) => this.sessions.get(session.sessionId) === session,
        healthIncarnation: (deviceId) => this.deviceHealth?.incarnation(deviceId),
        restoreIncarnationIsCurrent: (target) => this.restoreIncarnationIsCurrent(target),
        clearRestoreHealth: (target, reason) => this.clearRestoreHealth(target, reason),
        markHealth: (deviceId, incarnation, reason) =>
          this.deviceHealth?.markers.mark(deviceId, incarnation, reason),
        clearHealthMarker: (deviceId, incarnation, reason) =>
          this.deviceHealth?.markers.clear(deviceId, incarnation, reason),
        waitForIdentityReplacement: (deviceId, generation) =>
          this.waitForIdentityReplacement(deviceId, generation),
        abandonRestore: (target, reason, restore, restoreTimeoutMs) =>
          this.abandonRestore(target, reason, restore, restoreTimeoutMs),
        sessionSetupsOf: (session) =>
          Array.from(this.sessionSetupPromises, (setup) =>
            setup.session === session ? setup.promise : null,
          ).filter((setup): setup is Promise<void> => setup !== null),
        waitForSessionSetup: (sessionId, setups, phase) =>
          this.waitForSessionSetup(sessionId, setups, phase),
        noteTeardownBound: (bounded, settlesBy) =>
          this.deviceCleanupQuarantine.noteTeardownBound(bounded, settlesBy),
        trackPendingDeviceCleanup: (deviceId, cleanups) =>
          this.trackPendingDeviceCleanup(deviceId, cleanups),
        isAdmittedForAutomation: (session) => this.isAdmittedForAutomation(session),
        sessionNow: () => this.sessionNow(),
        registerPendingDeviceCleanup: (deviceId, cleanup, capMs) =>
          this.registerPendingDeviceCleanup(deviceId, cleanup, capMs),
      },
      {
        keepScreenAwake,
        biometricEnrollment,
        networkCondition: resolved.networkCondition,
        screenReader: resolved.screenReader,
        screenReaderBackoff: resolved.screenReaderBackoff,
        rotation: resolved.rotation,
        rotationBackoff: resolved.rotationBackoff,
        clock: resolved.clock,
        iosAppNetworkRuleRestorer: resolved.iosAppNetworkRule,
        defaultIosAppNetworkRuleRestorer,
        iosLease: {
          leaseMs: IOS_APP_NETWORK_RULE_LEASE_MS,
          renewIntervalMs: IOS_APP_NETWORK_RULE_RENEW_INTERVAL_MS,
        },
      },
    );
    this.recoveredIntents = new RecoveredTerminalReleaseIntents({
      terminalReleaseJournal: () => this.terminalReleaseJournal,
      setJournal: (journal) => {
        this.terminalReleaseJournal = journal;
      },
      daemonSessionId: () => this.daemonSessionId,
      liveDaemonSessionIds: () => this.liveDaemonSessionIds?.bind(this),
      sessionSlots: () => this.sessionSlots,
      deviceSessionRepository: () => this.deviceSessionRepository,
      timer,
      sessionNow: () => this.sessionNow(),
      wallToSessionClock: (at) => this.wallToSessionClock(at),
      checkSlotShadow: (sessionId, event) => this.slotShadowProbe.check(sessionId, event),
      liftTerminalFence: (uuid, resolved, retainFence) =>
        this.liftTerminalFence(uuid, resolved, retainFence),
    });
    this.forcedStuckRelease = new ForcedStuckRelease({
      sessionSlots: () => this.sessionSlots,
      removeSession: (sessionId, expectedSession) => this.removeSession(sessionId, expectedSession),
      notifySessionRelease: (snapshot, options) => this.notifySessionRelease(snapshot, options),
      managedExecutionReleaseMarker,
      restartReleasePersistence: () => this.restartReleasePersistence,
      registerPendingDeviceCleanup: (deviceId, cleanup, capMs) =>
        this.registerPendingDeviceCleanup(deviceId, cleanup, capMs),
      persistSessionRelease: (snapshot) => this.persistSessionRelease(snapshot),
      scheduleTerminalReleaseRetry: (snapshot) => this.scheduleTerminalReleaseRetry(snapshot),
      trackReleaseDrainWrite: (write) => this.trackReleaseDrainWrite(write),
      retryNonTerminalRowAfterRelease: (snapshot) => this.retryNonTerminalRowAfterRelease(snapshot),
      releaseRowSessions: () => this.releaseRowSessions,
      captureReleaseRowGeneration: (snapshot, generation) =>
        this.captureReleaseRowGeneration(snapshot, generation),
      persistedRowGenerations: () => this.persistedRowGenerations,
      volatileTerminalReleaseIntents: () => this.volatileTerminalReleaseIntents,
      terminalReleaseJournal: () => this.terminalReleaseJournal,
      rowWriter: () => this.rowWriter,
      timer,
      sessionNow: () => this.sessionNow(),
    });
    this.liveness = new SessionLivenessController({
      getSession: (sessionId) => this.getSession(sessionId),
      peekSession: (sessionId) => this.peekSession(sessionId),
      unlessBaseEnded: (session) => this.unlessBaseEnded(session),
      isAdmittedForAutomation: (session) => this.isAdmittedForAutomation(session),
      sessionNow: () => this.sessionNow(),
      ownershipSessionUuid: (sessionId) => this.ownershipSessionUuid(sessionId),
      livenessOwnerView: (session) => this.livenessOwnerView(session),
      hasUnissuedActivity: (session) => this.hasUnissuedActivity(session),
      recordSessionActivity: (session) => this.recordSessionActivity(session),
      getBarrier: () => this.getBarrier(),
      recordLivenessOwnership: (sessionId, ownerToken) =>
        this.deviceSessionRepository.recordLivenessOwnership(sessionId, ownerToken),
      replaceLivenessOwnership: (sessionId, ownerToken) =>
        this.deviceSessionRepository.replaceLivenessOwnership(sessionId, ownerToken),
      defaultHeartbeatTimeoutMs: () => getDefaultSessionHeartbeatTimeoutMs(),
    });

    // Start periodic cleanup of expired sessions
    this.startCleanupTimer();
  }

  /** Inject before creating sessions or scheduling release writes. */
  setRowWriter(writer: SessionRowWriter): void {
    this.rowWriter = writer;
  }

  private recoveryExpiryReleaseHandler?: RecoveryExpiryReleaseHandler;

  setRecoveryExpiryReleaseHandler(handler: RecoveryExpiryReleaseHandler): void {
    this.recoveryExpiryReleaseHandler = handler;
  }

  /** Reuse the injected Timer for fake-clock readiness, retry and backoff waits (#7541). */
  getTimer(): Timer {
    return this.timer;
  }

  /**
   * The current time on the clock every session timestamp (lease, idle, creation, release) is
   * stamped and judged with (#11080): wall-anchored, but advancing with the monotonic clock plus
   * measured host sleep, so a wall-clock step neither extends nor cuts a lease or an idle window.
   * Anything compared with a session timestamp must read this rather than `getTimer().now()`.
   */
  sessionNow(): number {
    return this.sessionClock.now();
  }

  /**
   * An instant on the session clock as wall-clock epoch ms, for reporting to other processes
   * (#11105): wall now + (instant - session now). Differs from the stamp only after a wall step.
   * This is the exact frame conversion that persisted stamps cross with (paired with
   * {@link wallToSessionClock}); values shown to a client use {@link sessionClockToReportedWall}.
   */
  sessionClockToWall(sessionClockMs: number): number {
    return this.timer.now() + (sessionClockMs - this.sessionNow());
  }

  /**
   * An instant on the session clock as wall-clock epoch ms for a REPORT only (#11368): a fixed
   * instant reads back the same value on every query, where {@link sessionClockToWall} re-derives
   * it against the wall clock each time and jitters by a few ms. Never stored or judged.
   */
  sessionClockToReportedWall(sessionClockMs: number): number {
    return this.sessionClock.toWall(sessionClockMs);
  }

  /**
   * A wall-clock epoch ms instant (a persisted stamp, another process's report) on the session
   * clock: the inverse of {@link sessionClockToWall} (#11162).
   */
  wallToSessionClock(wallMs: number): number {
    return this.sessionNow() + (wallMs - this.timer.now());
  }

  /**
   * Register a callback to be invoked when a session is released.
   * Used for centralized cleanup of session-scoped state (e.g., NavigationGraphManager).
   */
  onSessionRelease(callback: SessionReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }

  /** Observe changes to the live device-owner map; returns a listener removal function. */
  onDeviceOwnershipChange(
    callback: (deviceId: string, frameInvalidation: "generation-only" | "full") => void,
  ): () => void {
    this.deviceOwnershipCallbacks.add(callback);
    return () => this.deviceOwnershipCallbacks.delete(callback);
  }

  private notifyDeviceOwnershipChange(
    deviceId: string,
    frameInvalidation: "generation-only" | "full" = "generation-only",
  ): void {
    this.armPendingDeviceCleanupCaps(deviceId);
    for (const callback of this.deviceOwnershipCallbacks) {
      try {
        callback(deviceId, frameInvalidation);
      } catch (error) {
        logger.warn(`Device ownership callback failed for ${deviceId}: ${error}`);
      }
    }
  }

  /**
   * Register a callback invoked after a newly-created session is published.
   */
  onSessionCreated(callback: SessionCreatedCallback): void {
    this.createdCallbacks.push(callback);
  }

  /** Return outstanding post-release device work, if the device must stay quarantined. */
  getPendingDeviceCleanup(deviceId: string, ownGate?: Promise<void>): Promise<void> | null {
    return this.deviceCleanupQuarantine.get(deviceId, ownGate);
  }

  /** Wait for the device work that outlived release, without blocking shutdown indefinitely. */
  async drainPendingDeviceCleanups(timeoutMs: number): Promise<boolean> {
    this.flushDeferredRebindCleanups();
    return await this.deviceCleanupQuarantine.drain(timeoutMs);
  }

  /**
   * Quarantine a device until externally-dispatched session work settles.
   *
   * Callers must register the promise synchronously after dispatching work so
   * a concurrent session release observes the cleanup before returning the
   * device to the pool.
   */
  registerPendingDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    /** Numeric caps are trusted; only listener descriptors are manager-capped. */
    bound?: number | AbandonablePendingDeviceCleanup,
  ): void {
    this.deviceCleanupQuarantine.register(deviceId, cleanup, bound);
  }

  private armPendingDeviceCleanupCaps(deviceId: string): void {
    this.deviceCleanupQuarantine.armCaps(deviceId);
  }

  /**
   * How long a bind refused by {@link hasDeviceCleanupInProgress} should wait before retrying
   * (#10960): the remaining time of the cleanup's cap or of the in-flight release's bounded
   * forced-release worst case, or a default polling hint when nothing bounds it. An acquisition
   * cleanup counts once it quarantines the device, that is once its holder is gone (#11616).
   */
  getDeviceCleanupRetryAfterMs(deviceId: string): number {
    const now = this.sessionNow();
    const releaseBounds = Array.from(this.sessionSlots.activeReleases)
      .filter(
        (release) =>
          !release.forced && !release.commitDeclined && release.session.assignedDevice === deviceId,
      )
      .map(
        (release) =>
          (release.teardownStartsByMs ?? release.startedAtMs ?? now) +
          release.stuckDeadlineMs +
          2 * getSessionHeartbeatCheckIntervalMs() +
          SESSION_RELEASE_TEARDOWN_CAP_MS,
      );
    return this.deviceCleanupQuarantine.retryAfterMs(deviceId, releaseBounds);
  }

  /**
   * Like {@link registerPendingDeviceCleanup}, for work the current acquirer triggered on its own
   * device. While that session holds the device the work does not make
   * {@link hasDeviceCleanupInProgress} true (the holder's own reuse must not be refused); if the
   * holder releases first, the still-running work quarantines the device for the next acquirer.
   */
  registerAcquisitionDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    /** The cleanup's own cap, when it has one: it bounds the retry hint a refused bind gets. */
    capMs?: number,
  ): void {
    this.deviceCleanupQuarantine.registerAcquisition(deviceId, cleanup, capMs);
  }

  /** Release owns the device until both bounded teardown and any overflow work settle. */
  hasDeviceCleanupInProgress(deviceId: string): boolean {
    const receipt = requestAcquisitionReceipt();
    const ownGate =
      receipt?.rebound?.fromDeviceId === deviceId && receipt.deferredRebindCleanup?.retained
        ? receipt.deferredRebindCleanup?.settled
        : undefined;
    return (
      this.getPendingDeviceCleanup(deviceId, ownGate) !== null ||
      (this.deviceCleanupQuarantine.hasAcquisitionWork(deviceId) &&
        this.getSessionForDevice(deviceId) === null) ||
      Array.from(this.sessionSlots.activeReleases).some(
        (release) => !release.forced && release.session.assignedDevice === deviceId,
      )
    );
  }

  /**
   * The idle releases this manager started itself (the idle sweep, a lazy expiry) that still hold
   * their device (#11481). No caller awaits them and they are not reaps of the heartbeat monitor,
   * so the monitor reads them here to hold them to its stuck deadline (#10963). A forced release
   * no longer holds its device and is not listed, so it is forced exactly once.
   */
  getIdleReleasesInProgress(): { sessionId: string; startedAtMs: number }[] {
    return Array.from(this.sessionSlots.activeReleases)
      .filter((release) => release.expiryOrigin !== undefined && !release.forced)
      .map((release) => ({
        sessionId: release.session.sessionId,
        startedAtMs: release.startedAtMs ?? this.sessionNow(),
      }));
  }

  /**
   * The releases in progress that carry a non-terminal reason (a `device-restart:` handoff, a
   * `plan-auto-release`) and still hold their device (#11554). Heartbeats for a releasing session
   * are refused, so the heartbeat monitor must not count the time since `startedAtMs` as its
   * owner's silence; it still holds each one to its stuck deadline (#10963). A release a later
   * joiner upgraded to a terminal reason, an idle release (see {@link getIdleReleasesInProgress})
   * and a forced release are not listed.
   */
  getNonTerminalReleasesInProgress(): {
    sessionId: string;
    startedAtMs: number;
    session: Session;
  }[] {
    return Array.from(this.sessionSlots.releaseOps.values())
      .filter(
        (release) =>
          this.sessionSlots.hasActiveRelease(release) &&
          !release.forced &&
          release.expiryOrigin === undefined &&
          !isTerminalReleaseReason(release.reason.value),
      )
      .map((release) => ({
        sessionId: release.session.sessionId,
        startedAtMs: release.startedAtMs ?? this.sessionNow(),
        session: release.session,
      }));
  }

  /**
   * Terminal releases without an idle expiry origin that still hold their device. Together with
   * the idle and non-terminal lists, this lets the heartbeat monitor enforce the advertised
   * cleanup bound for every release, even when no monitor reap ever joins it.
   */
  getTerminalReleasesInProgress(): { sessionId: string; startedAtMs: number }[] {
    return Array.from(this.sessionSlots.activeReleases)
      .filter(
        (release) =>
          !release.forced &&
          !release.commitDeclined &&
          release.expiryOrigin === undefined &&
          isTerminalReleaseReason(release.reason.value),
      )
      .map((release) => ({
        sessionId: release.session.sessionId,
        startedAtMs: release.startedAtMs ?? this.sessionNow(),
      }));
  }

  /**
   * Whether the release of `sessionId` that started at `startedAtMs` (session clock) is still
   * running and still holds its device, whatever reason it carries now (#11554). The heartbeat
   * monitor asks this of a release it tracks once that release leaves the lists above: one a
   * joiner upgraded to a terminal reason is still the same wedged release and stays held to its
   * stuck deadline, while one that settled or was forced is over.
   */
  isReleaseInProgress(sessionId: string, startedAtMs: number): boolean {
    return Array.from(this.sessionSlots.activeReleases).some(
      (release) =>
        !release.forced &&
        release.session.sessionId === sessionId &&
        release.startedAtMs === startedAtMs,
    );
  }

  /** The unforced release's absolute stuck deadline on the session clock, if still in flight. */
  getReleaseStuckAtMs(sessionId: string): number | undefined {
    const release = Array.from(this.sessionSlots.activeReleases).find(
      (release) =>
        !release.forced && !release.commitDeclined && release.session.sessionId === sessionId,
    );
    return release
      ? (release.teardownStartsByMs ?? release.startedAtMs ?? this.sessionNow()) +
          release.stuckDeadlineMs
      : undefined;
  }

  /**
   * A release forced while it waited to start (#10963): the device may already belong to the next
   * owner, so no teardown may touch it. The force itself persists the fence it raised (#11058).
   */
  private async finishReleaseForcedBeforeStart(session: Session): Promise<null> {
    this.sessionSlots.unmarkReleasing(session);
    return null;
  }

  /**
   * Force a release that is stuck past the heartbeat monitor's deadline (#10963). The session is
   * released with the reason the stuck release carries (#11361): fenced terminally when that
   * reason is terminal (so its UUID never routes again), left recoverable or re-issuable when it
   * is not. Either way it is removed from the device maps, and its
   * device is quarantined only until the stuck release settles or {@link SESSION_RELEASE_TEARDOWN_CAP_MS}
   * passes, whichever is first; the caller then returns the device to the pool. Returns the device
   * to release and the stage the release was stuck in, or undefined when no release of this
   * session is in flight (it settled meanwhile) or it was already forced.
   */
  forceStuckRelease(
    sessionId: string,
  ): { deviceId: string; stage: SessionReleaseStage | undefined } | undefined {
    return this.forcedStuckRelease.forceStuckRelease(sessionId);
  }

  /**
   * Keep sessions assigned while their work is still running, even if their
   * idle timeout elapses. The daemon supplies the execution tracker; tests can
   * inject a deterministic checker.
   */
  setActiveSessionExecutionChecker(checker: ActiveSessionExecutionChecker): void {
    this.activeSessionExecutionChecker = checker;
  }

  setLivenessOwnerCallInFlightReader(reader: ((ownerToken: string) => boolean) | undefined): void {
    this.livenessOwnerCallInFlightReader = reader;
  }

  setOwnerConnectedAtReader(reader: OwnerConnectedAtReader | undefined): void {
    this.ownerConnectedAtReader = reader;
  }

  /** An owner's completed call restarts only its still-mint-bound claim leases. */
  restartMintBoundClaimLeases(ownerToken: string): void {
    const now = this.sessionNow();
    for (const session of this.sessions.values()) {
      if (session.livenessOwnerToken === ownerToken && hasMintBoundClaimLease(session)) {
        session.livenessOwnerBoundAt = Math.max(session.livenessOwnerBoundAt, now);
      }
    }
  }

  /**
   * Sibling of {@link setActiveSessionExecutionChecker}: how the idle sweep learns the request
   * deadline that bounds an in-flight execution's veto, so it judges the veto with the same
   * shared policy as the heartbeat and owner-disconnect paths (#10712, #10713).
   */
  setSessionExecutionDeadlineLookup(lookup: SessionExecutionDeadlineLookup): void {
    this.sessionExecutionDeadlineLookup = lookup;
  }

  /**
   * How a release aborts the executions it overrides once their veto has run out (#9839, #10820):
   * the idle-expiry releases, and the heartbeat reap and owner-disconnect release that share
   * {@link cancelExecutionsCutByRelease} with them (#11400). The daemon supplies the execution
   * tracker.
   */
  setExpiryReleaseExecutionCanceller(canceller: ExpiryReleaseExecutionCanceller): void {
    this.expiryReleaseExecutionCanceller = canceller;
  }

  /**
   * How acquiring a device cancels the sessionless calls admitted on it while it was free (#10829).
   * The daemon supplies the execution tracker.
   */
  setDeviceAcquisitionExecutionCanceller(canceller: DeviceAcquisitionExecutionCanceller): void {
    this.deviceAcquisitionExecutionCanceller = canceller;
  }

  /**
   * Hold the acquisition cancellation for `sessionId` until `settleDeviceAcquisitionCancellation`:
   * the pool publishes a session before deciding whether the create commits (#10905).
   */
  deferDeviceAcquisitionCancellation(sessionId: string): void {
    if (!this.deferredAcquisitionCancellations.has(sessionId)) {
      this.deferredAcquisitionCancellations.set(sessionId, undefined);
    }
  }

  /**
   * End a deferral: a committed create cancels the sessionless calls on the device it published; a
   * refused or rolled-back one cancels nothing, since the device ends up free (#10905).
   */
  settleDeviceAcquisitionCancellation(sessionId: string, committed: boolean): void {
    if (!this.deferredAcquisitionCancellations.has(sessionId)) {
      return;
    }
    const deviceId = this.deferredAcquisitionCancellations.get(sessionId);
    this.deferredAcquisitionCancellations.delete(sessionId);
    if (committed && deviceId !== undefined) {
      this.deviceAcquisitionExecutionCanceller(deviceId, sessionId);
    }
  }

  private cancelSessionlessUseOnAcquisition(deviceId: string, sessionId: string): void {
    if (this.deferredAcquisitionCancellations.has(sessionId)) {
      this.deferredAcquisitionCancellations.set(sessionId, deviceId);
      return;
    }
    this.deviceAcquisitionExecutionCanceller(deviceId, sessionId);
  }

  /**
   * Register cleanup for a device a session stopped using without ending that
   * session. This intentionally excludes session-wide cleanup and transport
   * unbinding, which must remain attached to a real session release.
   */
  onSessionDeviceUnbound(callback: SessionDeviceUnboundCallback): void {
    this.deviceUnboundCallbacks.push(callback);
  }

  private managedExecutionRecoveryListener?: (
    sessionId: string,
    recovered: Promise<unknown>,
  ) => void;
  private readonly managedExecutionRecoveries = new Map<string, PromiseWithResolvers<void>>();

  setManagedExecutionRecoveryListener(
    listener: (sessionId: string, recovered: Promise<unknown>) => void,
  ): void {
    this.managedExecutionRecoveryListener = listener;
  }

  /**
   * Create a new session with an assigned device
   *
   * This is called by the daemon when a session UUID is first used.
   * The DevicePool will assign an available device to this session.
   */
  async createSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options: CreateSessionOptions = {},
  ): Promise<Session> {
    const {
      timeoutMs,
      heartbeatTimeoutMs,
      stableDeviceId,
      recoveredLiveness,
      initialOwnership,
      persistenceSource,
      signal,
    } = withCreateSessionDefaults(options);
    signal?.throwIfAborted();
    if (!this.acceptingSessionCreations) {
      throw new DaemonSessionCreationRejectedError(sessionId);
    }
    this.assertTerminalReleaseAdmission(sessionId, this.sessions.get(sessionId));
    this.liftPlanLabelFenceForMint(sessionId);
    let terminalRelease = this.sessionSlots.getTerminalSnapshot(sessionId);
    if (terminalRelease) {
      throw new TerminalSessionError(sessionId, terminalRelease);
    }
    if (this.sessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already exists, returning existing session`);
      return this.sessions.get(sessionId)!;
    }
    this.refuseLabelMintOutsidePlanAllocation(sessionId, assignedDevice);
    const activeReleases = Array.from(this.sessionSlots.activeReleases)
      .filter((release) => release.session.sessionId === sessionId)
      .map((release) => release.promise);
    if (activeReleases.length > 0) {
      await this.withinCreateDeadline(sessionId, assignedDevice, Promise.all(activeReleases));
      this.assertTerminalReleaseAdmission(sessionId, this.sessions.get(sessionId));
      // The release just awaited ended the label's previous run, not this one.
      this.liftPlanLabelFenceForMint(sessionId);
      terminalRelease = this.sessionSlots.getTerminalSnapshot(sessionId);
      if (terminalRelease) {
        throw new TerminalSessionError(sessionId, terminalRelease);
      }
    }

    const pendingCreation = this.sessionSlots.getCreation(sessionId);
    if (pendingCreation) {
      return await this.withinCreateDeadline(sessionId, assignedDevice, pendingCreation.promise);
    }

    this.stateRestore.forgetKeepAwakeRestoreReport(sessionId);
    const now = this.sessionNow();
    const persistedRecovery = this.sessionSlots.getRecovery(sessionId);
    const creatorSource = this.creatorSourceForCreation(sessionId, persistenceSource);
    const liveness = sessionCreationLiveness(
      timeoutMs,
      heartbeatTimeoutMs,
      recoveredLiveness,
      this.SESSION_TIMEOUT_MS,
    );
    const session: Session = {
      sessionId,
      assignedDevice,
      stableDeviceId,
      platform,
      createdAt: now,
      lastUsedAt: now,
      activityGeneration: 0,
      expiresAt: now + liveness.sessionTimeoutMs,
      cacheData: {},
      lastHeartbeat: now,
      ...liveness,
      ownership: initialOwnership,
      ...(creatorSource
        ? {
            persistenceMetadata: {
              source: creatorSource,
              autolockEnabled: false,
              mcpSessionId: null,
              daemonSessionId: null,
            },
          }
        : {}),
      ...this.recoverySessionFields(persistedRecovery),
      ...(initialOwnership === "awaiting-owner"
        ? { awaitingOwnerSince: now, hasReceivedHeartbeat: false }
        : {}),
    };

    const creation: PendingSessionCreation = { promise: Promise.resolve(session) };
    const settleRecovery = this.notifyManagedExecutionRecovery(session, persistedRecovery);
    creation.promise = this.persistAndPublishSession(
      session,
      creation,
      this.claimedIncarnation(persistedRecovery),
      signal,
    );
    settleRecovery(creation.promise);
    this.sessionSlots.setCreation(sessionId, creation);
    this.slotShadowProbe.check(sessionId, "creation-start");
    try {
      const created = await this.withinCreateDeadline(
        sessionId,
        assignedDevice,
        creation.promise,
        () => {
          creation.abandoned = true;
        },
      );
      // Natural point to retry a rotation or screen reader an earlier release could not restore.
      await this.stateRestore.retryAbandonedRotationRestore(created.assignedDevice);
      await this.stateRestore.retryAbandonedScreenReaderRestore(created.assignedDevice);
      return created;
    } finally {
      if (this.sessionSlots.getCreation(sessionId) === creation) {
        this.sessionSlots.deleteCreation(sessionId);
        this.slotShadowProbe.check(sessionId, "creation-end");
      }
    }
  }

  /** Recovery alone has a completion signal; ordinary creation adds no promise turn. */
  private notifyManagedExecutionRecovery(
    session: Session,
    persistedRecovery: DeviceSession | undefined,
  ): (creation: Promise<Session>) => void {
    if (!persistedRecovery || session.livenessPolicy !== MANAGED_EXECUTION_LIVENESS_POLICY) {
      return () => {};
    }
    const { sessionId } = session;
    const recovered = Promise.withResolvers<void>();
    this.managedExecutionRecoveries.set(sessionId, recovered);
    // A listener may throw or be absent; creation failure must still be handled on this signal.
    void recovered.promise.catch((error: unknown) => {
      logger.debug(`[SessionManager] Managed recovery ${sessionId} did not complete`, error);
    });
    try {
      this.managedExecutionRecoveryListener?.(sessionId, recovered.promise);
    } catch (error) {
      logger.warn(`[SessionManager] Managed recovery hook failed for ${sessionId}`, error);
    }
    return (creation) => {
      void creation.then(undefined, recovered.reject);
    };
  }

  private settleManagedExecutionRecovery(sessionId: string, completed: boolean): void {
    const recovered = this.managedExecutionRecoveries.get(sessionId);
    this.managedExecutionRecoveries.delete(sessionId);
    if (completed) {
      recovered?.resolve();
    } else {
      recovered?.reject(new SessionReleasedDuringCreationError(sessionId));
    }
  }

  /**
   * Fence new session publication before daemon shutdown snapshots active work.
   *
   * A control-socket handler can outlive the bounded quiesce wait while preparing
   * a device. Its eventual DevicePool binding still reaches createSession(), so
   * this synchronous fence makes that assignment roll back instead of publishing
   * a session after the shutdown release snapshot.
   */
  stopAcceptingSessionCreations(): void {
    this.acceptingSessionCreations = false;
  }

  /** False once daemon shutdown has fenced session creation; it never becomes true again. */
  isAcceptingSessionCreations(): boolean {
    return this.acceptingSessionCreations;
  }
  private withinCreateDeadline<T>(
    sessionId: string,
    deviceId: string,
    wait: Promise<T>,
    onTimeout?: () => void,
  ): Promise<T> {
    return this.creation.withinCreateDeadline(sessionId, deviceId, wait, onTimeout);
  }

  /** The claimed incarnation a recovery's upsert is conditioned on, when `row` is a claim. */
  private claimedIncarnation(row: DeviceSession | undefined): ClaimedCreationRow | undefined {
    if (!row || !this.sessionSlots.isRowClaimed(row)) {
      return undefined;
    }
    return {
      rowGeneration: row.stable_identity_generation ?? 0,
      daemonSessionId: row.daemon_session_id ?? null,
      releaseReason: row.release_reason ?? undefined,
      releasedAtMs: row.released_at_ms ?? undefined,
    };
  }
  private persistAndPublishSession(
    session: Session,
    creation?: PendingSessionCreation,
    claimedRow?: ClaimedCreationRow,
    signal?: AbortSignal,
  ): Promise<Session> {
    return this.creation.persistAndPublishSession(session, creation, claimedRow, signal);
  }

  private persistCreationRollback(snapshot: SessionReleaseSnapshot): Promise<void> {
    return this.creation.persistCreationRollback(snapshot);
  }

  private creationRowRollbackSnapshot(
    session: Session,
    releaseReason: string,
    releasedAtMs: number = this.sessionNow(),
  ): SessionReleaseSnapshot {
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason,
      releasedAtMs,
      terminal: false,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
  }

  private async retireAbandonedCreation(session: Session): Promise<never> {
    this.retiredCreationRows.add(session);
    const releasedAtMs = this.sessionNow();
    const snapshot: SessionReleaseSnapshot = {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason: SESSION_CREATION_TIMEOUT_REASON,
      releasedAtMs,
      terminal: false,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
    this.captureReleaseRowGeneration(snapshot, this.persistedRowGenerations.get(session));
    await this.persistSessionRelease(snapshot, true).catch((error: unknown) => {
      logger.warn(
        `[SessionManager] Failed to release abandoned creation of ${session.sessionId}: ` +
          errorMessage(error),
      );
    });
    throw new SessionCreationTimeoutError(
      session.sessionId,
      session.assignedDevice,
      SESSION_CREATE_WAIT_TIMEOUT_MS,
    );
  }

  private async rejectCreationAfterShutdownFence(
    session: Session,
    rowWritten: boolean,
    claimedRow?: ClaimedCreationRow,
    cancellation?: AbortSignal,
  ): Promise<void> {
    if (this.acceptingSessionCreations && !cancellation?.aborted) {
      return;
    }
    // Still accepting creations past the return above: the request itself was cancelled.
    if (cancellation && this.acceptingSessionCreations) {
      await this.rollBackCancelledClientChosenCreation(session, rowWritten, cancellation);
    }
    const releasedAtMs = this.sessionNow();
    const snapshot: SessionReleaseSnapshot = {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason: cancellation?.aborted ? "session-creation-cancelled" : "daemon-shutdown",
      releasedAtMs,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
    if (snapshot.releaseReason === "session-creation-cancelled") {
      await this.persistTerminalReleaseIfNeeded(snapshot);
    } else {
      await this.persistRejectedCreationRow(session, snapshot, rowWritten, claimedRow);
    }
    this.notifySessionRelease(snapshot);
    if (cancellation?.aborted) {
      cancellation.throwIfAborted();
    }
    throw new DaemonSessionCreationRejectedError(session.sessionId, snapshot);
  }

  /** Keep the shutdown fence, but only retire the row this unpublished creation wrote. */
  private async persistRejectedCreationRow(
    session: Session,
    fence: SessionReleaseSnapshot,
    rowWritten: boolean,
    claimedRow?: ClaimedCreationRow,
  ): Promise<void> {
    this.retiredCreationRows.add(session);
    this.sessionSlots.setTerminalSnapshot(session.sessionId, fence);
    this.restartRecoveryActivityAt.delete(session.sessionId);
    if (!rowWritten) {
      this.terminalReleaseJournal.record({
        sessionId: fence.sessionId,
        reason: fence.releaseReason,
        at: this.sessionClockToWall(fence.releasedAtMs),
      });
      this.liftTerminalFence(fence.sessionId, fence, true);
      return;
    }
    const claimedReleaseReason = claimedRow?.releaseReason;
    const rowReason =
      claimedReleaseReason &&
      isReissuableByNameReleaseReason(claimedReleaseReason) &&
      !isRecoverableDaemonReleaseReason(claimedReleaseReason)
        ? claimedReleaseReason
        : fence.releaseReason;
    const rollback =
      rowReason === fence.releaseReason
        ? fence
        : this.creationRowRollbackSnapshot(session, rowReason, claimedRow?.releasedAtMs);
    this.captureReleaseRowGeneration(rollback, this.persistedRowGenerations.get(session));
    await this.persistCreationRollback(rollback);
  }

  /**
   * A mint cancelled under an id its client chose (#11593). The client knows the id although the
   * call never answered and names it again on its retry, so the id is not retired: nothing is
   * fenced, and the active row this mint already wrote is released as a plain allocation
   * rollback, which a later creation replaces. A release write that fails stays pending and is
   * retried; the retry creation's own upsert supersedes it. Rethrows the cancellation; returns
   * only for a session whose id this request's client did not choose.
   */
  private async rollBackCancelledClientChosenCreation(
    session: Session,
    rowWritten: boolean,
    cancellation: AbortSignal,
  ): Promise<void> {
    if (requestAcquisitionReceipt()?.clientChosenSessionId !== session.sessionId) {
      return;
    }
    if (!rowWritten) {
      cancellation.throwIfAborted();
      return;
    }
    this.retiredCreationRows.add(session);
    const releasedAtMs = this.sessionNow();
    const snapshot: SessionReleaseSnapshot = {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason: "allocation-rollback",
      releasedAtMs,
      terminal: false,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
    this.captureReleaseRowGeneration(snapshot, this.persistedRowGenerations.get(session));
    await this.persistSessionRelease(snapshot);
    cancellation.throwIfAborted();
  }
  private readPersistedSession(sessionId: string): Promise<DeviceSession | undefined> {
    return this.persistedAdmission.readPersistedSession(sessionId);
  }

  onRestartRecoveryActivity(callback: (sessionId: string, atMs: number) => void): void {
    return this.persistedAdmission.onRestartRecoveryActivity(callback);
  }

  private recordRestartRecoveryActivity(sessionId: string): void {
    return this.persistedAdmission.recordRestartRecoveryActivity(sessionId);
  }

  isReleasedSessionInRestartRecoveryWindow(sessionId: string): Promise<boolean> {
    return this.persistedAdmission.isReleasedSessionInRestartRecoveryWindow(sessionId);
  }

  expireRestartRecoveryReservation(sessionId: string): Promise<number | undefined> {
    return this.persistedAdmission.expireRestartRecoveryReservation(sessionId);
  }

  private getPersistedTerminalRelease(
    sessionId: string,
  ): Promise<SessionReleaseSnapshot | undefined> {
    return this.persistedAdmission.getPersistedTerminalRelease(sessionId);
  }

  private isReissuablePersistedSession(persisted: DeviceSession | undefined): boolean {
    return this.persistedAdmission.isReissuablePersistedSession(persisted);
  }

  private isRecoverablePersistedSession(persisted: DeviceSession | undefined): boolean {
    return this.persistedAdmission.isRecoverablePersistedSession(persisted);
  }

  private isNameReissueOnlyRow(persisted: DeviceSession | undefined): boolean {
    return this.persistedAdmission.isNameReissueOnlyRow(persisted);
  }

  private terminalizeExpiredPersistedSession(
    persisted: DeviceSession | undefined,
    onlyIfOwnedByDaemon?: string,
  ): Promise<DeviceSession | undefined> {
    return this.persistedAdmission.terminalizeExpiredPersistedSession(
      persisted,
      onlyIfOwnedByDaemon,
    );
  }

  terminalizeDeviceRestartHandoffForStop(sessionId: string): Promise<boolean> {
    return this.persistedAdmission.terminalizeDeviceRestartHandoffForStop(sessionId);
  }

  private unlessBeingReplaced(
    release: SessionReleaseSnapshot | undefined,
  ): SessionReleaseSnapshot | undefined {
    return this.persistedAdmission.unlessBeingReplaced(release);
  }

  private terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    return this.persistedAdmission.terminalReleaseFromPersisted(sessionId, persisted);
  }

  private expiredReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    return this.persistedAdmission.expiredReleaseFromPersisted(sessionId, persisted);
  }

  private unadmittedSessionError(
    sessionId: string,
    persisted: DeviceSession | undefined,
    neverIssued: UnissuedSessionError,
    access?: SessionAccess,
  ): Error {
    return this.persistedAdmission.unadmittedSessionError(
      sessionId,
      persisted,
      neverIssued,
      access,
    );
  }

  private releaseSnapshotFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
    releaseReason: string,
  ): SessionReleaseSnapshot {
    const releasedAtMs = persisted.released_at_ms ?? persisted.last_used_at_ms;
    const snapshot: SessionReleaseSnapshot = {
      sessionId,
      deviceId: persisted.device_id,
      releaseReason,
      releasedAtMs,
      terminal: isTerminalReleaseReason(releaseReason),
      heartbeat: {
        lastHeartbeatMs: persisted.last_used_at_ms,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        // Match the live snapshot: a missing-first-heartbeat reap is governed by
        // the pre-first-heartbeat grace, not the stored heartbeat timeout.
        timeoutMs:
          releaseReason === "missing-first-heartbeat"
            ? getDefaultPreFirstHeartbeatGraceMs()
            : persisted.heartbeat_timeout_ms,
        ageMs: Math.max(0, releasedAtMs - persisted.last_used_at_ms),
      },
    };
    this.captureReleaseRowGeneration(snapshot, persisted.stable_identity_generation);
    return snapshot;
  }

  /**
   * Get existing session
   */
  getSession(sessionId: string): Session | null {
    return this.expireIfDue(sessionId, false);
  }

  /** Pure lookup with getSession's default expiry judgement, apart from the stall probe. */
  findSession(sessionId: string): Session | null {
    this.stallProbe?.();
    if (this.sessionSlots.hasTerminalSnapshot(sessionId)) {
      return null;
    }
    const session = this.sessions.get(sessionId);
    return session && !this.isSessionExpired(session) ? session : null;
  }

  /**
   * Resolve a session before a new tool execution is accepted. A timely control call still in
   * flight keeps the session in use, so another control call may join it after the idle deadline.
   * Only live timely control work admits it: late or non-live calls end the idle session at once.
   * Recovery alone preserves the hold and refuses the late call with a typed retryable answer.
   */
  getSessionForNewExecution(
    sessionId: string,
    execution?: SessionExecutionMetadata,
  ): Session | null {
    return this.unlessBaseEnded(this.expireIfDue(sessionId, true, execution));
  }
  private expireIfDue(
    sessionId: string,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
    releaseExpired = true,
  ): Session | null {
    return this.leaseExpiry.expireIfDue(
      sessionId,
      expireDespiteActiveExecution,
      execution,
      releaseExpired,
    );
  }

  private releaseExpiredSessionLazily(session: Session, callerExecutionId?: string): void {
    return this.leaseExpiry.releaseExpiredSessionLazily(session, callerExecutionId);
  }

  private releaseSessionPastIdleDeadline(sessionId: string, callerExecutionId?: string): void {
    return this.leaseExpiry.releaseSessionPastIdleDeadline(sessionId, callerExecutionId);
  }

  private observeSessionForRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): Session | null {
    return this.leaseExpiry.observeSessionForRead(sessionId, execution);
  }

  deviceHeldForLateRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): string | undefined {
    return this.leaseExpiry.deviceHeldForLateRead(sessionId, execution);
  }

  /**
   * Get or create session with device assignment
   *
   * Automatically creates a session if it doesn't exist.
   * Called when --session-uuid is provided to a CLI command.
   *
   * @param sessionId - The session UUID
   * @param devicePool - DevicePool instance for automatic device assignment
   */
  /**
   * Resolving a session for a tool call is activity: extend both the idle
   * timeout (expiresAt) and the heartbeat clock (lastHeartbeat). Without the
   * latter, the daemon heartbeat watchdog would reap an actively-used session
   * whose tools never write session cache (e.g. autolock CLI/agent clients
   * that do not send explicit heartbeats). An awaiting-owner session is
   * reclaimed by the call.
   */
  private async reclaimAndRefreshExistingSession(existing: Session): Promise<void> {
    const now = this.sessionNow();
    const previousActivity = {
      lastUsedAt: existing.lastUsedAt,
      lastHeartbeat: existing.lastHeartbeat,
      expiresAt: existing.expiresAt,
      ownership: existing.ownership,
      awaitingOwnerSince: existing.awaitingOwnerSince,
    };
    if (existing.ownership === "awaiting-owner") {
      existing.ownership = "owned";
      existing.awaitingOwnerSince = undefined;
    }
    existing.lastUsedAt = now;
    existing.lastHeartbeat = now;
    existing.expiresAt = now + existing.sessionTimeoutMs;
    existing.activityGeneration++;
    const capturedGeneration = existing.activityGeneration;
    try {
      await this.recordSessionActivity(existing);
    } catch (error) {
      // An awaited activity refresh cannot advertise fresh in-memory liveness
      // after its durable write failed; callers receive the typed failure.
      // Only the latest refresh may roll back, so an older failure cannot clobber newer liveness.
      if (existing.activityGeneration === capturedGeneration) {
        Object.assign(existing, previousActivity);
      }
      throw error;
    }
  }
  private async refreshExistingSessionForAccess(
    existing: Session,
    access: SessionAccess,
  ): Promise<void> {
    // Only the client's own control call reclaims and refreshes: a read is not use, and a
    // non-owner control call must not stand in for the owner or its activity (#11417).
    if (access !== "acquire") {
      return;
    }
    await this.reclaimAndRefreshExistingSession(existing);
  }

  async getOrCreateSession(
    sessionId: string,
    devicePool?: SessionDeviceAssigner,
    platform?: Platform,
    execution?: SessionExecutionMetadata,
    // #6069: when true, a NEW session (no live in-memory session) may only be
    // minted for an id this daemon already issued — i.e. a persisted, non-terminal
    // row (live-during-restart recovery). This is set on the device-tool path so a
    // fabricated/never-issued sessionUuid can never be auto-assigned a pooled
    // device just because a device pool is in scope. Internal fresh mints
    // (device-label derived sessions) leave it false and keep minting.
    requireIssuedSession = false,
    accessOptions: SessionAccess | SessionAcquisitionOptions = "acquire",
  ): Promise<Session> {
    const { access, requestDeadlineMs, callerExecutionId, signal } =
      this.resolveSessionAcquisitionOptions(accessOptions);
    const pendingRebind = this.sessionSlots.getRebind(sessionId);
    if (pendingRebind) {
      await pendingRebind.promise;
      return await this.getOrCreateSession(
        sessionId,
        devicePool,
        platform,
        execution,
        requireIssuedSession,
        accessOptions,
      );
    }

    const existing = this.getSessionForNewExecution(sessionId, execution);
    if (existing) {
      const inFlightRelease = this.sessionSlots.getReleaseOp(sessionId);
      if (this.sessionSlots.isReleasing(existing) && inFlightRelease?.session === existing) {
        await inFlightRelease.promise;
        return await this.getOrCreateSession(
          sessionId,
          devicePool,
          platform,
          undefined,
          requireIssuedSession,
          accessOptions,
        );
      }
      logger.info(
        `[SessionManager] Found existing session ${sessionId} with device ${existing.assignedDevice}`,
      );
      this.assertSessionNotSuspect(existing, access);
      await this.refuseControlCallOnLapsedOwnerLease(
        existing,
        access,
        execution,
        callerExecutionId,
      );
      await this.refuseLabelCallOnLapsedBaseLease(existing, access, execution, callerExecutionId);
      await this.refreshExistingSessionForAccess(existing, access);
      return existing;
    }

    this.refuseLabelOfEndedBase(sessionId, access, execution, callerExecutionId);
    this.assertTerminalReleaseAdmission(sessionId);

    const terminalRelease = this.sessionSlots.getTerminalSnapshot(sessionId);
    if (terminalRelease) {
      throw new TerminalSessionError(sessionId, terminalRelease);
    }

    const inFlightRelease = this.forcedStuckRelease.inFlightReleaseStillOwning(sessionId);
    const currentSession = this.sessions.get(sessionId);
    if (
      inFlightRelease &&
      (currentSession === undefined || inFlightRelease.session === currentSession)
    ) {
      await inFlightRelease.promise;
      return await this.getOrCreateSession(
        sessionId,
        devicePool,
        platform,
        undefined,
        requireIssuedSession,
        accessOptions,
      );
    }

    return await this.startOrJoinUnseenAssignment(
      sessionId,
      devicePool,
      platform,
      requireIssuedSession,
      { access, requestDeadlineMs, signal },
    );
  }
  private resolveSessionAcquisitionOptions(
    options: SessionAccess | SessionAcquisitionOptions,
  ): ResolvedSessionAcquisition {
    return this.acquisition.resolveSessionAcquisitionOptions(options);
  }

  private startOrJoinUnseenAssignment(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    requireIssuedSession: boolean,
    acquisition: ResolvedSessionAcquisition,
  ): Promise<Session> {
    return this.acquisition.startOrJoinUnseenAssignment(
      sessionId,
      devicePool,
      platform,
      requireIssuedSession,
      acquisition,
    );
  }

  private newSharedAssignment(sessionId: string): SharedSessionAssignment {
    return this.acquisition.newSharedAssignment(sessionId);
  }

  private waitForAbortedAssignment(
    assignment: Promise<Session>,
    shared: SharedSessionAssignment,
    requestDeadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.acquisition.waitForAbortedAssignment(assignment, shared, requestDeadlineMs, signal);
  }

  private waitForSharedAssignment(
    sessionId: string,
    assignment: Promise<Session>,
    requestDeadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<Session> {
    return this.acquisition.waitForSharedAssignment(
      sessionId,
      assignment,
      requestDeadlineMs,
      signal,
    );
  }

  admitIssuedSessionForAutomation(
    sessionId: string,
    execution?: SessionExecutionMetadata,
    options: { access?: SessionAccess; signal?: AbortSignal } = {},
  ): Promise<Session | undefined> {
    return this.acquisition.admitIssuedSessionForAutomation(sessionId, execution, options);
  }

  private isLapsedUnownedRestartRecovery(persisted: DeviceSession | undefined): boolean {
    return this.acquisition.isLapsedUnownedRestartRecovery(persisted);
  }

  private admitPersistedSession(
    sessionId: string,
    persisted: DeviceSession | undefined,
  ): Promise<DeviceSession | undefined> {
    return this.acquisition.admitPersistedSession(sessionId, persisted);
  }

  private recoverPersistedSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    listed: DeviceSession | undefined,
    initialOwnership: "owned" | "awaiting-owner",
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    return this.recovery.recoverPersistedSession(
      sessionId,
      devicePool,
      platform,
      listed,
      initialOwnership,
      shared,
    );
  }

  private async recoverPersistedRow(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    persisted: DeviceSession | undefined,
    initialOwnership: "owned" | "awaiting-owner",
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    const recoveryTarget = await this.recoveryTargetFromPersisted(
      sessionId,
      persisted,
      platform,
      initialOwnership === "owned",
    );
    if (recoveryTarget && initialOwnership === "awaiting-owner") {
      recoveryTarget.initialOwnership = initialOwnership;
    }
    logger.info(
      `[SessionManager] Creating new session ${sessionId}, calling devicePool.assignDeviceToSession()`,
    );
    // A re-issue with no usable target still writes over its claimed row, as a recovery does.
    if (persisted && (recoveryTarget || this.isNameReissueOnlyRow(persisted))) {
      this.sessionSlots.setRecovery(sessionId, persisted);
    }
    try {
      const assign = () =>
        this.assignUnseenSessionToDevicePool(
          sessionId,
          devicePool,
          platform,
          recoveryTarget,
          persisted,
        );
      if (
        recoveryTarget?.restartRecoveryDeadlineMs !== undefined &&
        this.sessionNow() < recoveryTarget.restartRecoveryDeadlineMs
      ) {
        recoveryTarget.onRecoveryWait = (wait) => shared.recoveryWait.resolve(wait);
        await runWithAbortSignal(shared.controller.signal, assign);
      } else {
        shared.recoveryWait.resolve(undefined);
        await assign();
      }
      const session = this.getSession(sessionId);
      if (!session) {
        throw new SessionReleasedDuringCreationError(sessionId);
      }
      // The live session's own clocks take over from here.
      this.restartRecoveryActivityAt.delete(sessionId);
      logger.info(
        `[SessionManager] Successfully created session ${sessionId} with device ${session.assignedDevice}`,
      );
      this.settleManagedExecutionRecovery(sessionId, true);
      return session;
    } finally {
      // A successful recovery already resolved; every other exit rejects and drops its signal.
      this.settleManagedExecutionRecovery(sessionId, false);
      if (this.sessionSlots.getRecovery(sessionId) === persisted) {
        this.sessionSlots.deleteRecovery(sessionId);
      }
    }
  }
  private isLiveDaemonSession(daemonSessionId: string): boolean {
    return this.recovery.isLiveDaemonSession(daemonSessionId);
  }

  private rehydrationSkipReason(sessionId: string): string | undefined {
    return this.rehydration.rehydrationSkipReason(sessionId);
  }

  private registerRehydrationRecovery(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    persisted: DeviceSession,
    signal?: AbortSignal,
  ): Promise<Session> {
    return this.rehydration.registerRehydrationRecovery(sessionId, devicePool, persisted, signal);
  }

  rehydratePersistedSessions(
    devicePool: SessionDeviceAssigner,
    options: { deadlineMs?: number; concurrency?: number; signal?: AbortSignal } = {},
  ): Promise<RehydrationSummary> {
    return this.rehydration.rehydratePersistedSessions(devicePool, options);
  }

  private reserveDevicesForRehydration(
    persistedSessions: readonly DeviceSession[],
    devicePool: SessionDeviceAssigner,
    deadlineAt: number,
  ): Promise<void> {
    return this.rehydration.reserveDevicesForRehydration(persistedSessions, devicePool, deadlineAt);
  }

  private releaseRehydrationReservation(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
  ): void {
    return this.rehydration.releaseRehydrationReservation(sessionId, devicePool);
  }

  private async rehydratePersistedRow(
    persisted: DeviceSession,
    devicePool: SessionDeviceAssigner,
    signal?: AbortSignal,
  ): Promise<RehydrationRowOutcome> {
    const sessionId = persisted.session_uuid;
    if (!this.isRecoverablePersistedSession(persisted)) {
      return { kind: "skipped", reason: "not-recoverable" };
    }
    const skipReason = this.rehydrationSkipReason(sessionId);
    if (skipReason) {
      return { kind: "skipped", reason: skipReason };
    }
    try {
      await this.registerRehydrationRecovery(sessionId, devicePool, persisted, signal);
      return { kind: "rehydrated" };
    } catch (error) {
      const terminalRelease = this.getTerminalReleaseSnapshot(sessionId);
      if (terminalRelease) {
        return { kind: "terminalized", reason: terminalRelease.releaseReason };
      }
      if (error instanceof DeviceOwnedByOtherDaemonError) {
        // Another live daemon took the row or its device; that daemon recovers the session.
        return { kind: "skipped", reason: "owned-by-other-daemon" };
      }
      const reason = errorMessage(error);
      logger.warn(`[SessionManager] Failed to rehydrate session ${sessionId}: ${reason}`);
      return { kind: "skipped", reason };
    }
  }

  private lateRehydrationListener?: (rehydrated: readonly string[]) => Promise<void>;

  /**
   * Notified with a session that finished rehydrating after the startup deadline (late row or
   * follow-up), so the daemon re-owns its broker binding like the startup batch (#11288).
   */
  setLateRehydrationListener(listener: (rehydrated: readonly string[]) => Promise<void>): void {
    this.lateRehydrationListener = listener;
  }
  private recoverySessionFields(
    persisted: DeviceSession | undefined,
  ): Pick<
    Session,
    "persistenceMetadata" | "livenessOwnerToken" | "livenessOwnershipClaims" | "lastOwnerHeartbeat"
  > {
    return this.recovery.recoverySessionFields(persisted);
  }

  private async listRecoverableSessionsBeforeDeadline(
    deadlineAt: number,
    summary: RehydrationSummary,
  ): Promise<DeviceSession[]> {
    const deadlineWon = Symbol("startup-deadline");
    const recoverableSessions = this.deviceSessionRepository.listRecoverableSessions(
      this.sessionNow(),
      () => this.rowWriteLivePeerDaemonSessionIds(),
    );
    let result: typeof deadlineWon | DeviceSession[];
    try {
      result = await raceWithDeadline(recoverableSessions, {
        timer: this.timer,
        timeoutMs: Math.max(0, deadlineAt - this.sessionNow()),
        label: "Recoverable session listing",
        timeoutError: () => deadlineWon,
      });
    } catch (error) {
      if (error !== deadlineWon) {
        throw error;
      }
      result = deadlineWon;
    }
    if (typeof result !== "symbol") {
      return result;
    }
    void recoverableSessions.catch((error) =>
      logger.warn(
        `[SessionManager] Recoverable-session list continued after startup deadline: ${errorMessage(error)}`,
      ),
    );
    summary.timedOut = true;
    logger.warn("[SessionManager] Startup rehydration deadline reached while listing rows");
    return [];
  }
  private assignUnseenSessionToDevicePool(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    recoveryTarget: SessionRecoveryTarget | undefined,
    persisted: DeviceSession | undefined,
  ): Promise<void> {
    return this.recovery.assignUnseenSessionToDevicePool(
      sessionId,
      devicePool,
      platform,
      recoveryTarget,
      persisted,
    );
  }

  private async terminalizePersistedRecoveryFailure(
    sessionId: string,
    persisted: DeviceSession,
    error: Pick<SessionRecoveryIdentityLossError, "terminalReleaseReason"> &
      Partial<Pick<SessionRecoveryIdentityLossError, "ownerPid">>,
  ): Promise<void> {
    const releasedAtMs = this.sessionNow();
    await this.persistTerminalReleaseIfNeeded({
      sessionId,
      deviceId: persisted.device_id,
      releaseReason: error.terminalReleaseReason,
      releasedAtMs,
      terminal: true,
      ...(error.ownerPid === undefined ? {} : { ownerPid: error.ownerPid }),
      heartbeat: {
        lastHeartbeatMs: persisted.last_used_at_ms,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        timeoutMs: persisted.heartbeat_timeout_ms,
        ageMs: Math.max(0, releasedAtMs - persisted.last_used_at_ms),
      },
    });
  }
  rebindSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options: RebindSessionOptions = {},
  ): Promise<Session> {
    return this.rebinding.rebindSession(sessionId, assignedDevice, platform, options);
  }

  rebindSessionForTerminalReleaseRecovery(
    session: Session,
    assignedDevice: string,
    platform: Platform,
  ): Promise<Session> {
    return this.rebinding.rebindSessionForTerminalReleaseRecovery(
      session,
      assignedDevice,
      platform,
    );
  }

  private async persistAndPublishRebind(
    existing: Session,
    assignedDevice: string,
    platform: Platform,
    stableDeviceId: string | undefined,
    deferCleanup?: (cleanup: DeferredRebindCleanup) => void,
  ): Promise<Session> {
    const activeSetups = Array.from(this.sessionSetupPromises, (setup) =>
      setup.session === existing ? setup.promise : null,
    ).filter((setup): setup is Promise<void> => setup !== null);
    // Keep the old binding when setup cannot settle: a late mutation could
    // otherwise dirty the old simulator after its restore and pool release.
    const setupDrain = await this.waitForSessionSetup(existing.sessionId, activeSetups, "rebind");
    if (setupDrain.pending) {
      throw new ActionableError(
        `Session ${existing.sessionId} setup is still running; retry the device rebind after it settles.`,
      );
    }
    await this.liveness.livenessOwnershipClaimMutexFor(existing).runExclusive(async () => {
      await this.persistSession(
        this.createReboundSession(existing, assignedDevice, platform, stableDeviceId),
        existing,
        this.guardedRowRewriteOptions([...(this.superseded.remembered(existing) ?? [])]),
      );
      // The rebind's row is live: a rewrite still owed from before it is settled (#11557), so a
      // terminal row found under the session later is the UUID's end, not that rewrite's.
      this.superseded.settle(existing);
    });
    if (this.sessions.get(existing.sessionId) !== existing) {
      // A release waits for the rebind, but a forced one does not (#10963): it removed the
      // session and wrote its row while this row was in flight, and this row landed over it.
      await this.restoreReleasedRowAfterReassert(existing);
    }
    const previousDevice = existing.assignedDevice;
    const replacementFence = this.identityReplacementFences.get(previousDevice);
    const oldView: Session = { ...existing, cacheData: { ...existing.cacheData } };
    const expiry = this.stateRestore.peekNetworkConditionExpiry(existing.sessionId);
    const lease = this.stateRestore.activeIosAppNetworkLease(existing.sessionId);
    // These callbacks read the live session. Suspend TTL and transfer lease renewal before
    // publishing B, so neither can address B with A's state. Undo resumes the original deadline.
    this.stateRestore.cancelNetworkConditionExpiry(existing.sessionId);
    this.stateRestore.stopIosAppNetworkLease(existing.sessionId);
    // A replaced release waits for this rebind: its restore fence must not hold up the rebind.
    if (replacementFence) {
      const generation = this.replacedRestoreGenerations.get(previousDevice) ?? 0;
      const incarnation = this.deviceHealth?.incarnation(previousDevice);
      const releases = [...replacementFence.releases];
      const mayRestore = () => {
        const holder = this.getSessionForDevice(previousDevice);
        return (
          (holder === null || holder === oldView.sessionId) &&
          this.restoreIncarnationIsCurrent({
            deviceId: previousDevice,
            incarnation,
            restoreGeneration: generation,
          })
        );
      };
      // The pending release owns the handoff verdict. Retain A's view until its fence settles,
      // without making the rebind (which that release awaits) wait for restoration.
      const cleanup = runOutsideRequestContext(async () => {
        const current = await this.waitForIdentityReplacement(previousDevice, generation);
        const replaced = !current || releases.some(releaseWasForced) || !mayRestore();
        this.notifySessionDeviceUnbound(oldView.sessionId, previousDevice, {
          deviceIdentityReplaced: replaced,
        });
        if (replaced) {
          return;
        }
        const pending = await this.restoreRebindOverrides(oldView, mayRestore);
        this.trackPendingTeardownCleanup(previousDevice, pending);
        await Promise.allSettled(pending);
      }).catch((error: unknown) => {
        logger.warn(
          `Fenced rebind cleanup failed on ${previousDevice}: ${errorMessage(error)}`,
          error,
        );
      });
      this.registerPendingDeviceCleanup(previousDevice, cleanup);
    } else if (deferCleanup) {
      const cleanup = this.deferRebindOverrides(
        oldView,
        () => {
          if (expiry) {
            this.stateRestore.rearmNetworkConditionExpiry(existing, expiry);
          }
          if (lease) {
            this.stateRestore.confirmIosAppNetworkRule(existing, lease);
          }
        },
        lease,
      );
      deferCleanup(cleanup);
    } else {
      const pending = await this.restoreRebindOverrides(
        existing,
        () => !this.identityReplacementFences.has(previousDevice),
      );
      if (pending.length > 0) {
        this.trackPendingTeardownCleanup(previousDevice, pending);
      }
    }
    // Preserve object identity so an already-started release observes the
    // rebinding and frees its live replacement rather than a stale snapshot.
    // Recreate after awaited work to preserve activity and label-routing updates made in flight.
    Object.assign(
      existing,
      this.createReboundSession(existing, assignedDevice, platform, stableDeviceId),
    );
    const sessionId = existing.sessionId;
    this.rowWriter.noteLive(sessionId);
    if (this.deviceSessionMap.get(previousDevice) === existing.sessionId) {
      this.deviceSessionMap.delete(previousDevice);
    }
    this.deviceSessionMap.set(assignedDevice, existing.sessionId);
    if (assignedDevice !== previousDevice) {
      this.cancelSessionlessUseOnAcquisition(assignedDevice, existing.sessionId);
    }
    // Full: different-serial rebinds switch runtimes; same-serial force explicitly
    // means a restarted runtime. Terminal-release recovery also forces this path.
    this.notifyDeviceOwnershipChange(previousDevice, "full");
    if (assignedDevice !== previousDevice) {
      // Full: the replacement (including the same AVD on another serial) has its own screen.
      this.notifyDeviceOwnershipChange(assignedDevice, "full");
    }
    if (!replacementFence) {
      this.notifySessionDeviceUnbound(existing.sessionId, previousDevice, {
        deviceIdentityReplaced: this.identityReplacementFences.has(previousDevice),
      });
    }
    return existing;
  }
  flushDeferredRebindCleanups(filter: { sessionId?: string; deviceId?: string } = {}): void {
    return this.rebinding.flushDeferredRebindCleanups(filter);
  }

  private deferRebindOverrides(
    oldView: Session,
    resumeRetainedState: () => void,
    lease: IosAppNetworkRule | undefined,
  ): DeferredRebindCleanup {
    return this.rebinding.deferRebindOverrides(oldView, resumeRetainedState, lease);
  }

  private restoreRebindOverrides(
    existing: Session,
    mayRestore: () => boolean = () => true,
  ): Promise<Promise<void>[]> {
    return this.rebinding.restoreRebindOverrides(existing, mayRestore);
  }

  private createReboundSession(
    session: Session,
    assignedDevice: string,
    platform: Platform,
    stableDeviceId: string | undefined,
  ): Session {
    return this.rebinding.createReboundSession(session, assignedDevice, platform, stableDeviceId);
  }

  /**
   * Get device assigned to a session
   */
  getDeviceForSession(sessionId: string): string | null {
    const session = this.findSession(sessionId);
    if (!session) {
      return null;
    }
    return session.assignedDevice;
  }

  /** Final reason for this exact identity, including releases joined during teardown. */
  getFinalizedReleaseReason(session: Session): string | undefined {
    return this.finalizedSessionReleases.get(session)?.finalizedSnapshot?.releaseReason;
  }

  /**
   * The known end of a UUID (#10730), from the ended-session answer, in-memory terminal snapshot
   * or persisted `release_reason`. Undefined for a live session or an unknown UUID. A row released
   * before its latest handout keeps its stored reason regardless of its creation deadline.
   *
   * Idle ends are named from the start of teardown via registration's read-only ended-session
   * predicate. Other releases stay unanswered before the fence. Commit-fenced operations can
   * leave the session live, and non-terminal handoffs preserve it for reissue, so neither is
   * named early even if its idle deadline has passed. After the fence, a terminal non-device-loss
   * release uses the operation's live reason so a join is visible before its snapshot upgrades
   * (#11646); commit-fenced operations and device-loss cancellations stay unanswered.
   * The read-only answer also names an unheld idle deadline without starting release; a timely
   * control call's execution hold still keeps it live. A plan label whose base has ended is
   * otherwise answered with the base's reason.
   */
  async getReleasedSessionReason(sessionId: string): Promise<string | undefined> {
    const published = this.sessions.get(sessionId);
    const inMemory = this.sessionSlots.getTerminalSnapshot(sessionId)?.releaseReason;
    if (published) {
      const inFlightReason = (): string | undefined => {
        const operation = this.sessionSlots.getReleaseOp(sessionId);
        const current = operation?.session === published ? operation : undefined;
        if (inMemory === undefined) {
          return this.preFenceIdleReleaseReason(sessionId, current);
        }
        const reason = current?.reason.value ?? inMemory;
        return !current?.commitFenced &&
          reason !== undefined &&
          isTerminalReleaseReason(reason) &&
          !isDeviceLossCancellationReason(reason)
          ? reason
          : undefined;
      };
      // A label whose base has ended is answered with the base's end (#11640), before the
      // release that follows has recorded it on the label's own row.
      return inFlightReason() ?? this.endedBaseOfLabel(published)?.releaseReason;
    }
    if (inMemory) {
      return inMemory;
    }
    // Through the recovered-intent overlay so a pending intent reads as released (#11077).
    const persisted = await this.readPersistedSession(sessionId);
    if (!persisted) {
      return undefined;
    }
    // A row past its first deadline is answered as admission answers it (#11361), so a
    // heartbeat or session-info client is not told
    // a session is resumable when a call naming it is refused for good.
    return (
      this.expiredReleaseOfUnheldRow(sessionId, persisted)?.releaseReason ??
      persisted.release_reason ??
      undefined
    );
  }

  private preFenceIdleReleaseReason(
    sessionId: string,
    current: SessionReleaseOperation | undefined,
  ): string | undefined {
    if (current?.commitFenced || (current && !isTerminalReleaseReason(current.reason.value))) {
      return undefined;
    }
    const reason = this.peekTerminalAnswerForEndedSession(sessionId)?.release.releaseReason;
    return reason !== undefined && isIdleReleaseReason(reason) ? reason : undefined;
  }

  /**
   * {@link expiredReleaseFromPersisted} for a wire that answers outside admission: undefined while
   * this daemon is still creating, recovering or releasing the UUID. A caller in flight keeps a
   * device-restart recovery past the row's idle deadline, and a release in teardown has not
   * written its reason yet, so the row's deadline alone does not say the session has ended.
   */
  private expiredReleaseOfUnheldRow(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    if (
      this.sessions.has(sessionId) ||
      this.sessionSlots.hasAssignment(sessionId) ||
      this.sessionSlots.hasCreation(sessionId) ||
      this.sessionSlots.hasRecovery(sessionId) ||
      this.sessionSlots.hasReleaseOp(sessionId)
    ) {
      return undefined;
    }
    return this.expiredReleaseFromPersisted(sessionId, persisted);
  }

  /**
   * The release of a session whose row ran out its idle or recovery window with no daemon holding
   * it (#11361), for a wire that answers from a snapshot; undefined for a live, terminally
   * released, still-recoverable, in-recovery or never-issued UUID. Reads only: the row is left as
   * it is.
   */
  async getExpiredReleaseSnapshot(sessionId: string): Promise<SessionReleaseSnapshot | undefined> {
    if (this.sessions.has(sessionId) || this.sessionSlots.hasTerminalSnapshot(sessionId)) {
      return undefined;
    }
    const persisted = await this.readPersistedSession(sessionId);
    return persisted && this.expiredReleaseOfUnheldRow(sessionId, persisted);
  }

  getTerminalReleaseSnapshot(sessionId: string): SessionReleaseSnapshot | undefined {
    const snapshot = this.sessionSlots.getTerminalSnapshot(sessionId);
    return snapshot ? { ...snapshot, heartbeat: { ...snapshot.heartbeat } } : undefined;
  }

  /** Prevent this exact session UUID from being rebound while its device shutdown is in flight. */
  reserveSessionForTerminalRelease(session: Session, expectedDeviceId: string): () => void {
    if (session.assignedDevice !== expectedDeviceId) {
      throw new SessionNoLongerOwnsDeviceError(session.sessionId, expectedDeviceId);
    }
    if (this.sessionSlots.hasRebind(session.sessionId)) {
      throw new SessionRebindingError(session.sessionId);
    }
    const existing = this.sessionSlots.getTerminalReservation(session.sessionId);
    if (existing) {
      throw new SessionTerminalReleaseInProgressError(
        session.sessionId,
        expectedDeviceId,
        "is already reserved for terminal release",
      );
    }
    const reservation: TerminalReleaseReservation = {
      session,
      deviceId: expectedDeviceId,
      owner: Symbol(session.sessionId),
    };
    this.sessionSlots.setTerminalReservation(session.sessionId, reservation);
    return () => {
      if (
        this.sessionSlots.getTerminalReservation(session.sessionId)?.owner === reservation.owner
      ) {
        this.sessionSlots.deleteTerminalReservation(session.sessionId);
      }
    };
  }

  private assertTerminalReleaseAdmission(sessionId: string, allowedSession?: Session): void {
    const reservation = this.sessionSlots.getTerminalReservation(sessionId);
    if (reservation && reservation.session !== allowedSession) {
      throw new SessionTerminalReleaseInProgressError(
        sessionId,
        reservation.deviceId,
        TERMINAL_RELEASE_IN_PROGRESS_DETAIL,
      );
    }
  }

  private assertTerminalRebindAdmission(
    sessionId: string,
    reservationOwner: symbol | undefined,
  ): void {
    const reservation = this.sessionSlots.getTerminalReservation(sessionId);
    if (reservation && reservation.owner !== reservationOwner) {
      throw new SessionTerminalReleaseInProgressError(
        sessionId,
        reservation.deviceId,
        TERMINAL_RELEASE_IN_PROGRESS_DETAIL,
      );
    }
  }

  /**
   * Get session assigned to a device (reverse lookup)
   */
  getSessionForDevice(deviceId: string): string | null {
    return this.deviceSessionMap.get(deviceId) ?? null;
  }

  /** The same holders as getSessionForDevice, including expired and releasing sessions. */
  getHeldDeviceSessions(): readonly HeldDeviceSession[] {
    return [...this.deviceSessionMap].flatMap(([deviceId, sessionId]) => {
      const session = deriveHeldSlotSession(this.getLegacyLifecycleView(), sessionId);
      return session
        ? [
            {
              deviceId,
              sessionId,
              platform: session.platform,
              stableDeviceId: session.stableDeviceId,
            },
          ]
        : [];
    });
  }

  /** Map membership, including fenced releases and any newer same-UUID incarnation. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Whether this daemon holds `sessionId` as a live broker binding execution (#11275): present, on
   * the `managed-execution` policy and not being released. The stored idle deadline does not
   * decide managed liveness; a lapsed owner lease stays live until the heartbeat path actually
   * releases the session. A rehydrated session waiting for its proxy counts until released too.
   * Side-effect free apart from the stall probe every lookup runs.
   */
  isLiveManagedExecutionSession(sessionId: string): boolean {
    const session = this.expireIfDue(sessionId, false, undefined, false);
    return (
      session !== null &&
      session.livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY &&
      !this.sessionSlots.isReleasing(session)
    );
  }

  private lifecycleView?: LegacyLifecycleView<Session>;
  /** Read-only shadow adapter; its maps reflect subsequent lifecycle mutations. */
  getLegacyLifecycleView(): LegacyLifecycleView<Session> {
    return (this.lifecycleView ??= createLegacyLifecycleView(
      {
        sessions: this.sessions,
        pendingAssignments: this.sessionSlots.assignments,
        pendingCreations: this.sessionSlots.creations,
        pendingReleases: this.sessionSlots.releaseRequests,
        pendingRebinds: this.sessionSlots.rebinds,
        releaseOps: this.sessionSlots.releaseOps,
        terminalSnapshots: this.sessionSlots.terminalSnapshots,
        recoveredTerminalIntents: this.sessionSlots.recoveredTerminalIntents,
        latestFinalizedIdentities: this.sessionSlots.latestFinalizedIdentities,
      },
      { has: (session) => this.sessionSlots.isReleasing(session) },
    ));
  }

  private readonly slotShadowProbe = new SessionSlotShadowProbe(
    () => this.getLegacyLifecycleView(),
    undefined,
    logger,
    (uuid) => this.sessionSlots.notifySettled(uuid),
  );
  setSlotShadowProbeMode(mode: SlotShadowProbeMode): void {
    this.slotShadowProbe.mode = mode;
  }

  /** Explicit checks also cover retained older incarnations in agreement tests. */
  checkSlotShadowAgreement(uuid: string, event: string, identities: readonly Session[] = []): void {
    this.slotShadowProbe.check(uuid, event, identities);
  }

  isCurrentSession(session: Session): boolean {
    return isSlotCurrentSession(this.getLegacyLifecycleView(), session.sessionId, session);
  }

  isAdmittedForAutomation(session: Session): boolean {
    return this.isCurrentSession(session) && !this.sessionSlots.isReleasing(session);
  }

  /** Read ownership without admission, expiry cleanup or the stall probe (release guard, #11920). */
  getSessionLivenessOwnerToken(sessionId: string): string | undefined {
    return (this.sessions.get(sessionId) ?? this.sessionSlots.getReleaseOp(sessionId)?.session)
      ?.livenessOwnerToken;
  }

  /** Resolve an admitted release even after ordinary session lookup hides its identity. */
  getReleasingSession(sessionId: string): Session | null {
    return this.sessionSlots.getReleaseOp(sessionId)?.session ?? null;
  }

  /** Whether this is the newest published, releasing, or finalized incarnation for its UUID. */
  isLatestSessionIdentity(
    session: Session,
    options: { ignorePendingAssignment?: boolean } = {},
  ): boolean {
    return (
      deriveLatestSessionIdentity(
        this.getLegacyLifecycleView(),
        session.sessionId,
        options.ignorePendingAssignment,
      ) === session
    );
  }
  releaseSession(
    sessionId: string,
    releaseReason: SessionReleaseReason = "explicit-release",
    request: ReleaseSessionRequest = {},
  ): Promise<string | null> {
    return this.releaseRequests.releaseSession(sessionId, releaseReason, request);
  }

  private releaseSessionForReason(
    sessionId: string,
    releaseReason: string,
    request: ReleaseSessionRequest = {},
  ): Promise<string | null> {
    return this.releaseRequests.releaseSessionForReason(sessionId, releaseReason, request);
  }

  private releaseDeviceHold?: (sessionId: string) => ReleaseDeviceHold | undefined;

  /** Resolve ownership once per new release, before teardown or device-side release listeners. */
  setReleaseDeviceHold(resolver: (sessionId: string) => ReleaseDeviceHold | undefined): void {
    this.releaseDeviceHold = resolver;
  }
  releaseSessionUnlessSuperseded(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    request: ReleaseSessionRequest = {},
  ): Promise<ConditionalSessionRelease> {
    return this.releaseRequests.releaseSessionUnlessSuperseded(sessionId, releaseReason, request);
  }

  releaseSessionIfOwned(
    sessionId: string,
    expectedSession: Session,
    expectedDeviceId: string,
    releaseReason: SessionReleaseReason = "explicit-release",
  ): Promise<string | null> {
    return this.releaseRequests.releaseSessionIfOwned(
      sessionId,
      expectedSession,
      expectedDeviceId,
      releaseReason,
    );
  }

  private releasePersistedRestartRecovery(
    sessionId: string,
    releaseReason: string,
  ): Promise<string | null> {
    return this.releaseRequests.releasePersistedRestartRecovery(sessionId, releaseReason);
  }

  private isRowOwnedByLivePeer(row: DeviceSession): boolean {
    return this.releaseRequests.isRowOwnedByLivePeer(row);
  }

  /**
   * Track setup that can modify device state after a session has been assigned.
   * Release waits for this work so restoration sees the final cached state.
   */
  trackSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    if (!this.canStartSessionSetup(session)) {
      return Promise.resolve();
    }

    let resolveSetup!: () => void;
    let rejectSetup!: (error: unknown) => void;
    const setup = new Promise<void>((resolve, reject) => {
      resolveSetup = resolve;
      rejectSetup = reject;
    });
    const tracked = { session, promise: setup };
    this.sessionSetupPromises.add(tracked);
    try {
      void createSetup().then(resolveSetup, rejectSetup);
    } catch (error) {
      logger.warn(`Session setup factory failed for ${session.sessionId}: ${error}`);
      rejectSetup(error);
    }
    void setup.then(
      () => this.clearSessionSetup(tracked),
      () => this.clearSessionSetup(tracked),
    );
    return setup;
  }

  private canStartSessionSetup(session: Session): boolean {
    return (
      !this.sessionSlots.isReleasing(session) &&
      this.sessionSlots.getRebind(session.sessionId)?.session !== session &&
      this.sessions.get(session.sessionId) === session
    );
  }

  /** Wait a bounded amount of time for active and caller-started release work. */
  async drainReleasePromises(
    timeoutMs: number,
    additionalReleases: ReadonlyArray<Promise<unknown>> = [],
  ): Promise<boolean> {
    // Shutdown's drain (#11058): writes that fail from here on are retried at once and tracked.
    this.rowWriter.beginReleaseDrain();
    const releases = [
      ...Array.from(this.sessionSlots.activeReleases, (release) => release.promise),
      ...this.rowWriter.pendingDrainWrites(),
      // Shutdown does not wait out a retry's backoff: write every unconfirmed terminal row now,
      // before the database closes (#10959).
      ...this.retryPendingTerminalReleasesNow(),
      // Nor a live row's owed rewrite: left terminal, the next daemon would not rehydrate it.
      ...this.superseded.retryAllNow(),
      ...additionalReleases,
    ];
    try {
      if (releases.length === 0) {
        return true;
      }
      const deadline = new Error("Release drain timed out");
      try {
        return await raceWithDeadline(this.settleReleaseDrain(releases), {
          timer: this.timer,
          timeoutMs,
          label: "Release drain",
          timeoutError: () => deadline,
        });
      } catch (error) {
        if (error === deadline) {
          return false;
        }
        throw error;
      }
    } finally {
      this.rowWriter.clearPendingNonTerminalReleases();
      this.superseded.clearRowsUnderPendingRelease();
    }
  }

  /**
   * Settle the drain's releases, then any release write that started meanwhile: a write that
   * timed out or failed while the drain ran is tracked only after it began (#11058).
   */
  private async settleReleaseDrain(releases: ReadonlyArray<Promise<unknown>>): Promise<true> {
    let pending: ReadonlyArray<Promise<unknown>> = releases;
    while (pending.length > 0) {
      const settled = new Set(pending);
      await Promise.allSettled(pending);
      pending = Array.from(this.rowWriter.pendingDrainWrites()).filter(
        (write) => !settled.has(write),
      );
    }
    return true;
  }

  /** Wait for a release already admitted for this session, if any. */
  async waitForSessionRelease(sessionId: string): Promise<void> {
    const pendingSessionRelease = this.sessionSlots.getReleaseRequest(sessionId);
    if (pendingSessionRelease) {
      await pendingSessionRelease.promise;
      return;
    }

    const release = this.sessionSlots.getReleaseOp(sessionId);
    if (release) {
      await release.promise;
    }
  }

  /** Wait for this session's admitted release to settle, including failure, within a bound. */
  async waitForSessionReleaseWithin(sessionId: string, timeoutMs: number): Promise<boolean> {
    const release =
      this.sessionSlots.getReleaseRequest(sessionId) ?? this.sessionSlots.getReleaseOp(sessionId);
    if (!release) {
      return true;
    }
    const deadline = new Error("Session release wait timed out");
    try {
      return await raceWithDeadline(
        Promise.allSettled([release.promise]).then(() => true),
        {
          timer: this.timer,
          timeoutMs,
          label: "Session release wait",
          timeoutError: () => deadline,
        },
      );
    } catch (error) {
      if (error === deadline) {
        // A release may legitimately outlast the registration wait; the client can retry.
        logger.debug(`Timed out after ${timeoutMs}ms waiting for session ${sessionId} release`);
        return false;
      }
      throw error;
    }
  }

  private async releaseSessionInternal(
    sessionId: string,
    session: Session,
    reason: ReleaseReasonState,
    shouldCommit: ReleaseCommitFence | undefined,
    options: SessionReleaseOptions,
    operation?: SessionReleaseOperation,
  ): Promise<string | null> {
    const enter = (stage: SessionReleaseStage) => setReleaseStage(operation, stage);
    try {
      enter("teardown");
      // Release restores the device to `none` itself, so a standalone TTL is now
      // redundant — cancel it first so the two restore paths cannot both fire
      // (issue #6085 item 2). Whichever runs first (this release, or the TTL that
      // already cleared the slot) wins.
      this.stateRestore.cancelNetworkConditionExpiry(sessionId);
      // Release removes the iOS app rule itself; stop renewing it first.
      this.stateRestore.stopIosAppNetworkLease(sessionId);
      let pendingCleanup = await this.stateRestore.drainReleaseTeardown(
        sessionId,
        session,
        operation,
        options,
      );
      while (this.revokeSupersededIdentityReplacement(operation)) {
        pendingCleanup = await this.stateRestore.drainReleaseTeardown(
          sessionId,
          session,
          operation,
          options,
        );
      }
      const deviceId = session.assignedDevice;
      // Forced while tearing down (#11058): the force already fenced the session and handed the
      // device back, so nothing here may commit, quarantine or notify for it.
      if (releaseWasForced(operation)) {
        return null;
      }
      // Setup/restoration awaits above are where a newer identity confirmation
      // can overtake a device-loss eviction. Fence before the terminal snapshot
      // is persisted so a declined release leaves no terminal trace behind.
      if (releaseSuperseded(shouldCommit)) {
        // releaseSessionAttempt always supplies its operation before entering teardown.
        operation!.commitDeclined = true;
        return this.abandonSupersededRelease(sessionId, deviceId, pendingCleanup);
      }
      const releasedAtMs = this.sessionNow();
      this.judgeOwnerLeaseForRelease(session, reason, "commit", operation);
      const releaseReason = reason.value;
      const terminalFenceHeldBefore = this.sessionSlots.hasTerminalSnapshot(sessionId);
      let releaseSnapshot: SessionReleaseSnapshot = {
        sessionId,
        deviceId,
        releaseReason,
        releasedAtMs,
        terminal: isTerminalReleaseReason(releaseReason),
        ...managedExecutionReleaseMarker(session),
        heartbeat: {
          lastHeartbeatMs: session.lastHeartbeat,
          hasReceivedHeartbeat: session.hasReceivedHeartbeat,
          // A missing-first-heartbeat reap fires on the pre-first-heartbeat grace,
          // not the session's heartbeat timeout; report the deadline that actually
          // governed the release so `ageMs` stays coherent (issue #5689). The grace
          // is resolved from the shared env/default here — matching the daemon's
          // monitor, which is constructed with default config. (A monitor given an
          // explicit `preFirstHeartbeatGraceMs`, as in tests, would diverge; drive
          // the grace via env to keep the snapshot consistent.)
          timeoutMs: this.releaseHeartbeatTimeoutMs(releaseReason, session),
          ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
        },
      };
      this.releaseRowSessions.set(releaseSnapshot, new WeakRef(session));
      this.captureReleaseRowGeneration(releaseSnapshot, this.persistedRowGenerations.get(session));

      // A non-terminal release must not yield after freezing its reason: a
      // concurrent terminal release can only upgrade the shared reason while
      // this operation is awaiting teardown above.
      let terminalPersisted = true;
      if (releaseSnapshot.terminal) {
        enter("terminal-persist");
        ({ snapshot: releaseSnapshot, persisted: terminalPersisted } =
          await this.persistTerminalReleaseWithinDeadline(releaseSnapshot, reason, session));
      }
      while (this.revokeSupersededIdentityReplacement(operation)) {
        pendingCleanup = await this.stateRestore.drainReleaseTeardown(
          sessionId,
          session,
          operation,
          options,
        );
      }
      if (releaseWasForced(operation)) {
        return null;
      }
      // Final fence: evaluated synchronously right before the commit, with no
      // await in between, so the persistence awaits above cannot hide a newer
      // confirmation either. A terminal fence this release raised is lifted so
      // the live session keeps routing, and the terminal row it wrote is
      // rewritten live so a restart rehydrates it (#11206).
      if (releaseSuperseded(shouldCommit)) {
        operation!.commitDeclined = true;
        return await this.abandonReleaseSupersededAfterPersist(
          session,
          releaseSnapshot,
          pendingCleanup,
          !terminalFenceHeldBefore,
        );
      }
      const owedReasons = this.superseded.reasonsOwedTo(session);
      if (!this.commitReleaseRemoval(sessionId, session, deviceId, pendingCleanup)) {
        return null;
      }
      this.commitReplacedDeviceTeardown(sessionId, session, options, operation);
      if (!releaseSnapshot.terminal) {
        this.forcedStuckRelease.liftTerminalFenceIfPresent(sessionId);
        this.sessionSlots.deleteTerminalReasonState(sessionId);
        // The removal dropped the rewrite owed over a superseded release's terminal row, and
        // this release's own write does not replace a terminal row.
        this.restoreNonTerminalRowOverSupersededReleaseLater(session, owedReasons);
      }

      this.notifySessionRelease(releaseSnapshot, options);
      enter("finalize-persist");
      let persistedSnapshot: SessionReleaseSnapshot;
      try {
        persistedSnapshot = await this.completeReleasePersistence(
          releaseSnapshot,
          reason,
          session,
          terminalPersisted,
        );
      } catch (error) {
        // Removal committed before persistence. Retain its identity and reason
        // while the pending release snapshot is retried by the recovery owner.
        reason.finalizedSnapshot ??= releaseSnapshot;
        this.recordFinalizedSessionRelease(session, reason);
        throw toActionableError(error, `Failed to finalize session ${sessionId} release`);
      }
      return this.finishCommittedRelease(
        session,
        reason,
        releaseSnapshot,
        persistedSnapshot,
        options,
        pendingCleanup,
      );
    } finally {
      this.sessionSlots.unmarkReleasing(session);
    }
  }

  /** Persistence after removal cannot undo a committed release or re-run its listeners. */
  private finishCommittedRelease(
    session: Session,
    reason: ReleaseReasonState,
    releaseSnapshot: SessionReleaseSnapshot,
    persistedSnapshot: SessionReleaseSnapshot,
    options: SessionReleaseOptions,
    pendingCleanup: readonly Promise<void>[],
  ): string {
    const { sessionId, deviceId } = releaseSnapshot;
    this.recordFinalizedSessionRelease(session, reason);
    if (persistedSnapshot !== releaseSnapshot) {
      // A terminal reason upgraded this release while it persisted. Its cleanup already ran on
      // the first notification, so announce only the reason change (#10825, #11146).
      this.notifySessionRelease(persistedSnapshot, { ...options, upgradeOnly: true });
    }
    logger.info(
      pendingCleanup.length > 0
        ? `Released session ${sessionId}; device ${deviceId} remains quarantined until teardown completes`
        : `Released session ${sessionId}, freeing device ${deviceId}`,
    );
    return deviceId;
  }

  /**
   * Remove the released session and quarantine its device until the teardown handed back settles.
   * False when the session's ownership changed meanwhile; its teardown still quarantines the device.
   */
  private commitReleaseRemoval(
    sessionId: string,
    session: Session,
    deviceId: string,
    pendingCleanup: readonly Promise<void>[],
  ): boolean {
    const removed = this.removeSession(sessionId, session);
    if (pendingCleanup.length > 0) {
      this.trackPendingTeardownCleanup(deviceId, pendingCleanup);
    }
    if (!removed) {
      logger.warn(`Skipping release finalization for ${sessionId}: session ownership changed`);
    }
    return removed;
  }

  private trackPendingTeardownCleanup(deviceId: string, cleanups: readonly Promise<void>[]): void {
    this.deviceCleanupQuarantine.trackTeardown(deviceId, cleanups);
  }

  /** Only a committed handoff retires the old device's saved baselines and serial retries. */
  private commitReplacedDeviceTeardown(
    sessionId: string,
    session: Session,
    options: SessionReleaseOptions,
    operation?: SessionReleaseOperation,
  ): void {
    if (!options.deviceIdentityReplaced) {
      return;
    }
    // Retire the replaced serial captured at mark, even if an awaiting rebind published another
    // device. Its generations/retries are independent of the session's new binding (#12063).
    const deviceId = operation?.identityReplacement?.deviceId ?? session.assignedDevice;
    this.replacedRestoreGenerations.set(
      deviceId,
      (this.replacedRestoreGenerations.get(deviceId) ?? 0) + 1,
    );
    const dropped = new Set<string>();
    if (this.stateRestore.clockRestores.targets.has(deviceId)) {
      dropped.add("clock");
    }
    if (
      this.stateRestore.abandonedRotations.has(deviceId) ||
      this.stateRestore.rotationRestores.targets.has(deviceId)
    ) {
      dropped.add("rotation");
    }
    if (
      this.stateRestore.abandonedScreenReaders.has(deviceId) ||
      this.stateRestore.screenReaderRestores.targets.has(deviceId)
    ) {
      dropped.add("screen-reader");
    }
    this.dropReplacedDeviceRestoreState(session, dropped);
    this.retireRestorations(deviceId, "removal");
    if (dropped.size > 0) {
      logger.warn(
        `Dropped restore state for session ${sessionId} on replaced serial ${deviceId}: ${[...dropped].join(", ")}`,
      );
    }
  }

  /** Saved baselines belong to the retired device, never the new occupant of its serial. */
  private dropReplacedDeviceRestoreState(session: Session, dropped: Set<string>): void {
    const kinds = [
      ["keepScreenAwake", "keep-awake"],
      ["biometricEnrollment", "biometric"],
      ["networkCondition", "network-condition"],
      ["clock", "clock"],
      ["rotation", "rotation"],
      ["screenReader", "screen-reader"],
    ] as const;
    for (const [key, kind] of kinds) {
      if (session.cacheData[key]) {
        dropped.add(kind);
        delete session.cacheData[key];
      }
    }
  }

  private async persistTerminalReleaseWithUpgrade(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
  ): Promise<SessionReleaseSnapshot> {
    await this.persistTerminalReleaseIfNeeded(snapshot);
    if (reason.value === snapshot.releaseReason) {
      return snapshot;
    }
    const upgradedSnapshot = this.withReleaseReason(snapshot, reason.value, session);
    await this.persistTerminalReleaseIfNeeded(upgradedSnapshot);
    return upgradedSnapshot;
  }

  /**
   * Persist a terminal release before its session is removed, bounded by
   * {@link SESSION_RELEASE_PERSIST_TIMEOUT_MS} (#10836). At the deadline the in-memory terminal
   * fence (raised before the write) keeps the UUID from routing again, so the release goes on to
   * free the device instead of holding it for as long as the write stays wedged.
   */
  private async persistTerminalReleaseWithinDeadline(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
  ): Promise<{ snapshot: SessionReleaseSnapshot; persisted: boolean }> {
    try {
      return {
        snapshot: await this.persistTerminalReleaseWithUpgrade(snapshot, reason, session),
        persisted: true,
      };
    } catch (error) {
      if (!(error instanceof SessionReleasePersistTimeoutError)) {
        throw error;
      }
      const fenced = this.sessionSlots.getTerminalSnapshot(snapshot.sessionId) ?? snapshot;
      if (this.volatileTerminalReleaseIntents.get(fenced.sessionId) === fenced.releaseReason) {
        logger.warn(
          `Terminal release of session ${fenced.sessionId} has no crash-safe intent (volatile); ` +
            "freeing its device before the row lands can revive the UUID after a crash",
          error,
        );
      }
      logger.warn(
        `Freeing device ${fenced.deviceId} of session ${fenced.sessionId} before its terminal ` +
          `release row was written (reason=${RELEASE_PERSIST_TIMEOUT_REASON}); the session stays ` +
          "fenced and the next release of it retries the write",
        error,
      );
      return { snapshot: fenced, persisted: false };
    }
  }

  private abandonSupersededRelease(
    sessionId: string,
    deviceId: string,
    pendingCleanup: readonly Promise<void>[],
    liftTerminalFence: boolean = false,
  ): null {
    if (liftTerminalFence) {
      this.liftTerminalFence(sessionId);
    }
    if (pendingCleanup.length > 0) {
      this.trackPendingTeardownCleanup(deviceId, pendingCleanup);
    }
    logger.info(
      `Skipping release of ${sessionId}: a newer identity confirmation superseded the eviction of ${deviceId}`,
    );
    return null;
  }

  /**
   * The final supersede fence declined after the terminal write: lift the fence this release raised
   * and rewrite the live row it terminalized (#11206).
   */
  private async abandonReleaseSupersededAfterPersist(
    session: Session,
    releaseSnapshot: SessionReleaseSnapshot,
    pendingCleanup: readonly Promise<void>[],
    liftTerminalFence: boolean,
  ): Promise<null> {
    this.abandonSupersededRelease(
      session.sessionId,
      releaseSnapshot.deviceId,
      pendingCleanup,
      liftTerminalFence,
    );
    if (
      liftTerminalFence &&
      releaseSnapshot.terminal &&
      !this.superseded.wasRefused(releaseSnapshot)
    ) {
      await this.reassertSupersededLiveRow(session, [releaseSnapshot.releaseReason]);
    } else if (liftTerminalFence && this.superseded.remembered(session)?.size) {
      // This release's refusal proves only that its own write landed nothing. An earlier
      // superseded release's late row may have deferred its rewrite behind this fence.
      await this.reassertSupersededLiveRow(session, []);
    }
    return null;
  }
  private reassertSupersededLiveRow(
    session: Session,
    supersededReasons: readonly string[],
  ): Promise<boolean> {
    return this.supersededRows.reassertSupersededLiveRow(session, supersededReasons);
  }

  private rowWriteLivePeerDaemonSessionIds(): string[] {
    return this.supersededRows.rowWriteLivePeerDaemonSessionIds();
  }

  private guardedRowRewriteOptions(
    supersededReasons: readonly string[],
    expectedRowGeneration?: number,
  ): UpsertActiveSessionOptions {
    return this.supersededRows.guardedRowRewriteOptions(supersededReasons, expectedRowGeneration);
  }

  private retryRefusedRowWrite<T>(
    error: DeviceSessionRowNotRewritableError | DeviceSessionRowNotReleasableError,
    sessionId: string,
    guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    write: (
      guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    ) => Promise<T>,
    releaseReason?: string,
    releaseOptions: {
      unlessDaemonShutdown?: boolean;
      resolveRowGeneration?: (row: DeviceSession | undefined) => number | undefined;
      incarnation?: Session;
    } = {},
  ): Promise<T> {
    return this.supersededRows.retryRefusedRowWrite(
      error,
      sessionId,
      guard,
      write,
      releaseReason,
      releaseOptions,
    );
  }

  private isRebindUnderWay(session: Session): boolean {
    return this.supersededRows.isRebindUnderWay(session);
  }

  private restoreReleasedRowAfterReassert(session: Session): Promise<void> {
    return this.supersededRows.restoreReleasedRowAfterReassert(session);
  }

  private retryTerminalRowAfterRelease(sessionId: string): Promise<void> {
    return this.supersededRows.retryTerminalRowAfterRelease(sessionId);
  }

  private retryNonTerminalRowAfterRelease(snapshot: SessionReleaseSnapshot): Promise<void> {
    return this.supersededRows.retryNonTerminalRowAfterRelease(snapshot);
  }

  private restoreNonTerminalRowAfterReassert(session: Session): Promise<void> {
    return this.supersededRows.restoreNonTerminalRowAfterReassert(session);
  }

  private restoreNonTerminalRowOverSupersededReleaseLater(
    session: Session,
    supersededReasons: readonly string[],
  ): void {
    return this.supersededRows.restoreNonTerminalRowOverSupersededReleaseLater(
      session,
      supersededReasons,
    );
  }

  private restoreNonTerminalRowOverSupersededRelease(
    superseded: Session,
    supersededReasons: readonly string[],
  ): Promise<void> {
    return this.supersededRows.restoreNonTerminalRowOverSupersededRelease(
      superseded,
      supersededReasons,
    );
  }

  private replaceSupersededReleaseRow(
    session: Session,
    supersededReasons: readonly string[],
  ): Promise<boolean> {
    return this.supersededRows.replaceSupersededReleaseRow(session, supersededReasons);
  }

  private waitOutRecreationOf(sessionId: string): Promise<void> {
    return this.supersededRows.waitOutRecreationOf(sessionId);
  }

  private oweSupersededRowReassert(session: Session, supersededReasons: readonly string[]): void {
    return this.supersededRows.oweSupersededRowReassert(session, supersededReasons);
  }

  private retryOwedSupersededRowReassert(entry: OwedSupersededRowReassert): Promise<boolean> {
    return this.supersededRows.retryOwedSupersededRowReassert(entry);
  }

  private reassertOwedLiveRowForActivity(session: Session): Promise<boolean> {
    return this.supersededRows.reassertOwedLiveRowForActivity(session);
  }

  private retryOwedSupersededRowReassertDuringDrain(
    entry: OwedSupersededRowReassert,
  ): Promise<void> {
    return this.supersededRows.retryOwedSupersededRowReassertDuringDrain(entry);
  }

  private upgradeReleaseReason(reason: ReleaseReasonState, candidate: string): void {
    reason.value = resolveReleaseReason(reason.value, candidate);
  }

  private createReleaseReasonState(sessionId: string, releaseReason: string): ReleaseReasonState {
    const reason: ReleaseReasonState = { value: releaseReason };
    const terminalReleaseReason = this.sessionSlots.getTerminalSnapshot(sessionId)?.releaseReason;
    if (terminalReleaseReason) {
      this.upgradeReleaseReason(reason, terminalReleaseReason);
    }
    return reason;
  }

  private releaseHeartbeatTimeoutMs(releaseReason: string, session: Session): number {
    return releaseReason === "missing-first-heartbeat"
      ? getDefaultPreFirstHeartbeatGraceMs()
      : session.heartbeatTimeoutMs;
  }

  private withReleaseReason(
    snapshot: SessionReleaseSnapshot,
    releaseReason: string,
    session?: Session,
  ): SessionReleaseSnapshot {
    const upgraded: SessionReleaseSnapshot = {
      ...snapshot,
      releaseReason,
      terminal: isTerminalReleaseReason(releaseReason),
      heartbeat: {
        ...snapshot.heartbeat,
        timeoutMs: session
          ? this.releaseHeartbeatTimeoutMs(releaseReason, session)
          : snapshot.heartbeat.timeoutMs,
      },
    };
    const incarnation = this.releaseRowSessions.get(snapshot);
    if (incarnation) {
      this.releaseRowSessions.set(upgraded, incarnation);
    }
    this.captureReleaseRowGeneration(upgraded, this.releaseRowGenerations.get(snapshot));
    this.superseded.notePredecessors(upgraded, snapshot);
    return upgraded;
  }
  private captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void {
    return this.releasePersistence.captureReleaseRowGeneration(snapshot, rowGeneration);
  }

  private releaseWritePrecondition(snapshot: SessionReleaseSnapshot): MarkReleasedOptions {
    return this.releasePersistence.releaseWritePrecondition(snapshot);
  }

  private async completeReleasePersistence(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
    terminalPersisted: boolean,
  ): Promise<SessionReleaseSnapshot> {
    if (snapshot.terminal) {
      reason.finalizedSnapshot = snapshot;
      // A timed-out terminal write leaves the row for the next terminal release to persist.
      reason.terminalPersisted = terminalPersisted;
      this.sessionSlots.setTerminalReasonState(snapshot.sessionId, reason);
      return snapshot;
    }
    await this.persistSessionRelease(snapshot);
    if (reason.value === snapshot.releaseReason) {
      reason.finalizedSnapshot = snapshot;
      return snapshot;
    }
    const upgradedSnapshot = this.withReleaseReason(snapshot, reason.value, session);
    reason.finalizedSnapshot = upgradedSnapshot;
    this.recordFinalizedSessionRelease(session, reason);
    // The first reason's row, if its write failed, is no longer the one to retry (#11557).
    if (this.rowWriter.pendingNonTerminalReleases().get(snapshot.sessionId) === snapshot) {
      this.rowWriter.deletePendingNonTerminalRelease(snapshot.sessionId);
    }
    this.dropReleaseRetry(snapshot);
    if (upgradedSnapshot.terminal) {
      this.sessionSlots.setTerminalReasonState(upgradedSnapshot.sessionId, reason);
      await this.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      reason.terminalPersisted = true;
    } else {
      await this.persistSessionRelease(upgradedSnapshot);
    }
    return upgradedSnapshot;
  }

  private async releaseFinalizedSession(
    reason: ReleaseReasonState,
    releaseReason: string,
  ): Promise<string | null> {
    this.upgradeReleaseReason(reason, releaseReason);
    if (reason.lateTerminalRelease) {
      return await reason.lateTerminalRelease;
    }
    const snapshot = reason.finalizedSnapshot;
    if (!snapshot) {
      return null;
    }
    const indexedTerminalReason = this.sessionSlots.getTerminalReasonState(snapshot.sessionId);
    if (indexedTerminalReason && indexedTerminalReason !== reason) {
      return null;
    }
    if (snapshot.terminal && reason.terminalPersisted && snapshot.releaseReason === reason.value) {
      return snapshot.deviceId;
    }
    let upgradedSnapshot = this.withReleaseReason(snapshot, reason.value);
    reason.finalizedSnapshot = upgradedSnapshot;
    reason.terminalPersisted = false;
    this.sessionSlots.setTerminalReasonState(upgradedSnapshot.sessionId, reason);
    const release = (async () => {
      await this.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      if (reason.value !== upgradedSnapshot.releaseReason) {
        upgradedSnapshot = this.withReleaseReason(upgradedSnapshot, reason.value);
        reason.finalizedSnapshot = upgradedSnapshot;
        this.sessionSlots.setTerminalReasonState(upgradedSnapshot.sessionId, reason);
        await this.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      }
      reason.terminalPersisted = true;
      // The release's cleanup already ran on the first notification; the device may now belong to
      // the next owner, so announce only the reason change (#10825).
      this.notifySessionRelease(upgradedSnapshot, { upgradeOnly: true });
      return upgradedSnapshot.deviceId;
    })();
    reason.lateTerminalRelease = release;
    try {
      return await release;
    } finally {
      reason.lateTerminalRelease = undefined;
    }
  }

  private recordFinalizedSessionRelease(session: Session, reason: ReleaseReasonState): void {
    this.finalizedSessionReleases.set(session, reason);
    this.sessionSlots.recordFinalizedIdentity(session);
  }

  private invalidateFinalizedSessionIdentity(sessionId: string): void {
    const identity = this.sessionSlots.getFinalizedIdentity(sessionId);
    if (!identity) {
      return;
    }
    const session = identity.deref();
    if (session) {
      this.finalizedSessionReleases.delete(session);
    }
    this.sessionSlots.deleteFinalizedIdentity(sessionId);
  }

  private notifySessionRelease(
    snapshot: SessionReleaseSnapshot,
    options: SessionReleaseOptions = {},
  ): void {
    if (isDeviceRestartReleaseReason(snapshot.releaseReason)) {
      const persistence =
        this.restartReleasePersistence.get(snapshot) ?? Promise.withResolvers<void>();
      this.restartReleasePersistence.set(snapshot, persistence);
      options = { ...options, releasePersisted: persistence.promise };
    }
    for (const callback of this.releaseCallbacks) {
      try {
        callback(snapshot.sessionId, snapshot.deviceId, snapshot.releaseReason, snapshot, options);
      } catch (error) {
        logger.warn(`Session release callback failed for ${snapshot.sessionId}: ${error}`);
      }
    }
  }

  private async persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean = false,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean> {
    // A retry yields to a reissue until publish ends it or failed creation leaves it owed (#11557).
    if (retryPending && this.isSessionBeingRecreated(snapshot.sessionId)) {
      return false;
    }
    this.rowWriter.noteRelease(snapshot);
    try {
      if (snapshot.terminal) {
        // Record before issuing the row write; volatile intents cannot protect a crash at timeout.
        const durability = this.terminalReleaseJournal.record({
          sessionId: snapshot.sessionId,
          reason: snapshot.releaseReason,
          // Read back by the next daemon on its own session clock: stored as wall ms (#11162).
          at: this.sessionClockToWall(snapshot.releasedAtMs),
        });
        if (durability === "volatile") {
          this.volatileTerminalReleaseIntents.set(snapshot.sessionId, snapshot.releaseReason);
        } else {
          this.volatileTerminalReleaseIntents.delete(snapshot.sessionId);
        }
      }
      const precondition = { ...this.releaseWritePrecondition(snapshot), ...statementConditions };
      const issueWrite = (options: MarkReleasedOptions) => this.issueReleaseRow(snapshot, options);
      const fallback = this.releaseRowFallback(snapshot, precondition, issueWrite);
      const deadlineNow = () => this.timer.monotonicNow?.() ?? this.timer.now();
      const startedAtMs = deadlineNow();
      let deadlineExpired = false;
      let write = issueWrite(precondition);
      const deadlineOptions = {
        timer: this.timer,
        timeoutMs: SESSION_RELEASE_PERSIST_TIMEOUT_MS,
        unref: true,
        label: "Session release persistence",
        timeoutError: () =>
          new SessionReleasePersistTimeoutError(
            snapshot.sessionId,
            snapshot.releaseReason,
            SESSION_RELEASE_PERSIST_TIMEOUT_MS,
          ),
        // Attach fallback only after timeout: a late refusal still needs classification, while
        // a successful first statement retains the repository promise's original timing.
        onTimeout: () => {
          deadlineExpired = true;
          this.trackLateReleaseWrite(write.catch(fallback), snapshot);
        },
      };
      try {
        await raceWithDeadline(write, deadlineOptions);
      } catch (error) {
        write = fallback(error);
        if (deadlineExpired) {
          // A first refusal can win its race in the turn that also fired the deadline.
          // Its fallback is already observed by onTimeout; it cannot extend the release.
          throw deadlineOptions.timeoutError();
        }
        await raceWithDeadline(write, {
          ...deadlineOptions,
          // The first race clears its timer on rejection; spend only its remaining budget.
          timeoutMs: Math.max(
            0,
            SESSION_RELEASE_PERSIST_TIMEOUT_MS - (deadlineNow() - startedAtMs),
          ),
          onTimeout: () => this.trackLateReleaseWrite(write, snapshot),
        });
      }
      this.confirmReleaseWrite(snapshot);
      return true;
    } catch (error) {
      return this.handleReleaseWriteFailure(error, snapshot, retryPending);
    }
  }
  private releaseRowFallback(
    snapshot: SessionReleaseSnapshot,
    precondition: MarkReleasedOptions,
    issueWrite: (options: MarkReleasedOptions) => Promise<void>,
  ): (error: unknown) => Promise<void> {
    return this.releasePersistence.releaseRowFallback(snapshot, precondition, issueWrite);
  }

  private issueReleaseRow(snapshot: SessionReleaseSnapshot, options: MarkReleasedOptions) {
    return this.releasePersistence.issueReleaseRow(snapshot, options);
  }

  private handleReleaseWriteFailure(
    error: unknown,
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean,
  ): boolean {
    return this.releasePersistence.handleReleaseWriteFailure(error, snapshot, retryPending);
  }

  private trackLateReleaseWrite(write: Promise<void>, snapshot: SessionReleaseSnapshot): void {
    return this.releasePersistence.trackLateReleaseWrite(write, snapshot);
  }

  private liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence = false,
    afterDelete?: () => void,
  ): void {
    return this.releasePersistence.liftTerminalFence(uuid, resolved, retainFence, afterDelete);
  }

  private confirmReleaseWrite(snapshot: SessionReleaseSnapshot): void {
    return this.releasePersistence.confirmReleaseWrite(snapshot);
  }

  private dropReleaseRetry(snapshot: SessionReleaseSnapshot): void {
    return this.releasePersistence.dropReleaseRetry(snapshot);
  }

  private scheduleTerminalReleaseRetry(snapshot: SessionReleaseSnapshot): void {
    return this.releasePersistence.scheduleTerminalReleaseRetry(snapshot);
  }

  private trackReleaseDrainWrite(write: Promise<void>): void {
    return this.releasePersistence.trackReleaseDrainWrite(write);
  }

  private isTerminalReleaseRetryCurrent(snapshot: SessionReleaseSnapshot): boolean {
    return this.releasePersistence.isTerminalReleaseRetryCurrent(snapshot);
  }

  private retryTerminalReleaseWrite(entry: ReleaseRowRetry): Promise<void> {
    return this.releasePersistence.retryTerminalReleaseWrite(entry);
  }

  private retriedReleaseWritePrecondition(
    snapshot: SessionReleaseSnapshot,
  ): Promise<MarkReleasedOptions> {
    return this.releasePersistence.retriedReleaseWritePrecondition(snapshot);
  }

  private retryPendingTerminalReleasesNow(): Promise<void>[] {
    return this.releasePersistence.retryPendingTerminalReleasesNow();
  }

  private isSessionBeingRecreated(sessionId: string): boolean {
    return this.releasePersistence.isSessionBeingRecreated(sessionId);
  }

  private recordPendingNonTerminalRelease(snapshot: SessionReleaseSnapshot): void {
    return this.releasePersistence.recordPendingNonTerminalRelease(snapshot);
  }

  private persistTerminalReleaseIfNeeded(snapshot: SessionReleaseSnapshot): Promise<void> {
    return this.releasePersistence.persistTerminalReleaseIfNeeded(snapshot);
  }

  private clearSessionSetup(tracked: { session: Session; promise: Promise<void> }): void {
    this.sessionSetupPromises.delete(tracked);
  }

  private async waitForSessionSetup(
    sessionId: string,
    setups: readonly Promise<void>[],
    phase: "release" | "rebind" = "release",
  ): Promise<{ pending: Promise<void> | null }> {
    const settled = Promise.allSettled(setups);
    const timeout = new Error("Session setup drain timed out");
    const result = await raceWithDeadline(settled, {
      timer: this.timer,
      timeoutMs: SESSION_SETUP_DRAIN_TIMEOUT_MS,
      label: "Session setup drain",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return "timed-out" as const;
      }
      throw error;
    });
    if (result === "timed-out") {
      logger.warn(
        `Timed out after ${SESSION_SETUP_DRAIN_TIMEOUT_MS}ms waiting for session ${sessionId} setup during ${phase}`,
      );
      return { pending: settled.then(() => undefined) };
    }
    for (const setup of result) {
      if (setup.status === "rejected") {
        logger.warn(`Failed session setup for ${sessionId} before release: ${setup.reason}`);
      }
    }
    return { pending: null };
  }

  /**
   * Retire every restore queue the cause applies to: removal retires all kinds; a VM restore
   * (incarnation bump) retires the kinds whose policy says so, today the clock only (#11794).
   * No retries may target a replacement device.
   */
  retireRestorations(deviceId: string, cause: "removal" | "incarnation-bump"): void {
    for (const queue of [
      this.stateRestore.clockRestores,
      this.stateRestore.rotationRestores,
      this.stateRestore.screenReaderRestores,
    ]) {
      if (cause === "removal" || queue.policy.retiredOnIncarnationBump) {
        queue.retire(deviceId);
      }
    }
  }

  beginIosAppNetworkRule(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    return this.stateRestore.beginIosAppNetworkRule(session, target);
  }

  prepareIosAppNetworkReset(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    return this.stateRestore.prepareIosAppNetworkReset(session, target);
  }

  confirmIosAppNetworkRule(session: Session, rule: IosAppNetworkRule): void {
    this.stateRestore.confirmIosAppNetworkRule(session, rule);
  }

  finishIosAppNetworkReset(session: Session, rule: IosAppNetworkRule): void {
    this.stateRestore.finishIosAppNetworkReset(session, rule);
  }

  /** The iOS rule whose lease this session is renewing, if any (diagnostics and tests). */
  activeIosAppNetworkLease(sessionId: string): IosAppNetworkRule | undefined {
    return this.stateRestore.activeIosAppNetworkLease(sessionId);
  }

  /** Arm a per-condition network TTL; see {@link SessionDeviceStateRestore}. */
  scheduleNetworkConditionExpiry(
    session: Session,
    expiresInSeconds: number,
    generation?: number,
  ): void {
    this.stateRestore.scheduleNetworkConditionExpiry(session, expiresInSeconds, generation);
  }

  peekNetworkConditionExpiry(
    sessionId: string,
  ): { deadlineMs: number; generation: number } | undefined {
    return this.stateRestore.peekNetworkConditionExpiry(sessionId);
  }

  rearmNetworkConditionExpiry(
    session: Session,
    snapshot: { deadlineMs: number; generation: number },
  ): void {
    this.stateRestore.rearmNetworkConditionExpiry(session, snapshot);
  }

  cancelNetworkConditionExpiry(sessionId: string): void {
    this.stateRestore.cancelNetworkConditionExpiry(sessionId);
  }

  private trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<unknown>[]): void {
    this.deviceCleanupQuarantine.track(deviceId, cleanups);
  }

  private notifySessionDeviceUnbound(
    sessionId: string,
    deviceId: string,
    options?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void {
    for (const callback of this.deviceUnboundCallbacks) {
      try {
        callback(sessionId, deviceId, options);
      } catch (error) {
        logger.warn(`Session device-unbound callback failed for ${sessionId}: ${error}`);
      }
    }
  }

  private notifySessionCreated(session: Session): void {
    for (const callback of this.createdCallbacks) {
      try {
        callback(session);
      } catch (error) {
        logger.warn(`Session creation callback failed for ${session.sessionId}: ${error}`);
      }
    }
  }
  updateSessionCache(sessionId: string, updates: Partial<SessionCacheData>): void {
    return this.cache.updateSessionCache(sessionId, updates);
  }

  setLastHierarchy(sessionId: string, hierarchy: ViewHierarchyResult): void {
    return this.cache.setLastHierarchy(sessionId, hierarchy);
  }

  setLastRenderedObservation(
    sessionId: string,
    observation: ObserveResult,
    displayRevision?: number,
  ): void {
    return this.cache.setLastRenderedObservation(sessionId, observation, displayRevision);
  }

  getLastActionMetadata(
    sessionId: string,
    deviceId: string,
  ): Readonly<Record<string, unknown>> | undefined {
    return this.cache.getLastActionMetadata(sessionId, deviceId);
  }

  setLastActionMetadata(
    sessionId: string,
    deviceId: string,
    blocks: Record<string, unknown>,
  ): void {
    return this.cache.setLastActionMetadata(sessionId, deviceId, blocks);
  }

  getLastRenderedObservation(sessionId: string): ObserveResult | undefined {
    return this.cache.getLastRenderedObservation(sessionId);
  }

  setLastRenderedDisplayRevision(
    sessionId: string,
    revision: number,
    key?: string,
    generation?: number,
  ): void {
    return this.cache.setLastRenderedDisplayRevision(sessionId, revision, key, generation);
  }

  getLastRenderedDisplayGeneration(sessionId: string): number | undefined {
    return this.cache.getLastRenderedDisplayGeneration(sessionId);
  }

  setDisplayPin(sessionId: string, pin: string | null): void {
    return this.cache.setDisplayPin(sessionId, pin);
  }

  getDisplayPin(sessionId: string): string | undefined {
    return this.cache.getDisplayPin(sessionId);
  }

  getLastRenderedDisplayKey(sessionId: string): string | undefined {
    return this.cache.getLastRenderedDisplayKey(sessionId);
  }

  getLastRenderedDisplayRevision(sessionId: string): number | undefined {
    return this.cache.getLastRenderedDisplayRevision(sessionId);
  }

  /**
   * Cache the keep-awake state applied for a session in the typed top-level
   * `keepScreenAwake` slot (issue #2973). `ToolExecutionContext` writes it once at
   * session setup; `restoreKeepScreenAwake` reads the same slot on release. Both
   * go through this typed slot rather than an untyped `customData` cast, so a
   * writer/reader type drift is a compile error (the #2917 bug class).
   */
  setKeepScreenAwake(sessionId: string, state: KeepScreenAwakeState): void {
    this.updateSessionCache(sessionId, { keepScreenAwake: state });
  }
  getKeepScreenAwake(sessionId: string): KeepScreenAwakeState | undefined {
    return this.cache.getKeepScreenAwake(sessionId);
  }

  setDeviceReadiness(sessionId: string, level: DeviceReadinessLevel): void {
    return this.cache.setDeviceReadiness(sessionId, level);
  }

  getDeviceReadiness(sessionId: string): DeviceReadinessLevel | undefined {
    return this.cache.getDeviceReadiness(sessionId);
  }

  invalidateAutomationReadiness(sessionId: string, reason: string): void {
    return this.cache.invalidateAutomationReadiness(sessionId, reason);
  }

  invalidateAutomationReadinessForDevice(deviceId: string, reason: string): void {
    return this.cache.invalidateAutomationReadinessForDevice(deviceId, reason);
  }

  resetDeviceReadinessForDevice(deviceId: string): void {
    return this.cache.resetDeviceReadinessForDevice(deviceId);
  }

  setClock(session: Session, state: ClockSessionState): void {
    return this.cache.setClock(session, state);
  }

  getClock(sessionId: string): ClockSessionState | undefined {
    return this.cache.getClock(sessionId);
  }

  getKeepAwakeRestoreReport(sessionId: string): KeepAwakeRestoreReport | undefined {
    return this.cache.getKeepAwakeRestoreReport(sessionId);
  }

  trackClockSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    return this.cache.trackClockSessionSetup(session, createSetup);
  }

  runClockMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.cache.runClockMutationExclusive(sessionId, fn);
  }

  setRotation(session: Session, state: RotationSessionState): void {
    return this.cache.setRotation(session, state);
  }

  getRotation(sessionId: string): RotationSessionState | undefined {
    return this.cache.getRotation(sessionId);
  }

  trackRotationSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.cache.trackRotationSessionSetup(session, createSetup);
  }

  runRotationMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.cache.runRotationMutationExclusive(sessionId, fn);
  }

  trackScreenReaderSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.cache.trackScreenReaderSessionSetup(session, createSetup);
  }

  setScreenReader(session: Session, state: ScreenReaderSessionState): void {
    return this.cache.setScreenReader(session, state);
  }

  getScreenReader(sessionId: string): ScreenReaderSessionState | undefined {
    return this.cache.getScreenReader(sessionId);
  }

  runScreenReaderMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.cache.runScreenReaderMutationExclusive(sessionId, fn);
  }

  setBiometricEnrollment(sessionId: string, state: BiometricEnrollmentSessionState): void {
    return this.cache.setBiometricEnrollment(sessionId, state);
  }

  getBiometricEnrollment(sessionId: string): BiometricEnrollmentSessionState | undefined {
    return this.cache.getBiometricEnrollment(sessionId);
  }

  setNetworkCondition(sessionId: string, state: NetworkConditionSessionState): void {
    return this.cache.setNetworkCondition(sessionId, state);
  }

  bumpNetworkConditionGeneration(sessionId: string): number {
    return this.cache.bumpNetworkConditionGeneration(sessionId);
  }

  runNetworkConditionMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.cache.runNetworkConditionMutationExclusive(sessionId, fn);
  }

  getNetworkCondition(sessionId: string): NetworkConditionSessionState | undefined {
    return this.cache.getNetworkCondition(sessionId);
  }

  /**
   * Cache the device-label → session map for a multi-device session in the typed
   * top-level `deviceLabels` slot (issue #2973). Written by `registerDeviceLabelMap`
   * and read on the `device:`-label routing hot path (`resolveDeviceLabelSession`).
   */
  setDeviceLabels(sessionId: string, labels: DeviceLabelMap): void {
    if (this.findSession(sessionId)) {
      this.planLabels.indexDerivedLabels(sessionId, labels);
    }
    this.updateSessionCache(sessionId, { deviceLabels: labels });
  }
  openPlanLabelMints(baseSessionId: string, labels: DeviceLabelMap): () => void {
    return this.planLabelsLifecycle.openPlanLabelMints(baseSessionId, labels);
  }

  private creatorSourceForCreation(
    sessionId: string,
    persistenceSource: string | undefined,
  ): string | undefined {
    return this.planLabelsLifecycle.creatorSourceForCreation(sessionId, persistenceSource);
  }

  private liftPlanLabelFenceForMint(sessionId: string): void {
    return this.planLabelsLifecycle.liftPlanLabelFenceForMint(sessionId);
  }

  private refusePlanLabelSessionOutsideItsRun(
    sessionId: string,
    persisted: DeviceSession | undefined,
  ): void {
    return this.planLabelsLifecycle.refusePlanLabelSessionOutsideItsRun(sessionId, persisted);
  }

  getBaseSessionOfDerivedLabel(sessionId: string): string | undefined {
    return this.planLabelsLifecycle.getBaseSessionOfDerivedLabel(sessionId);
  }
  private refuseLabelMintOutsidePlanAllocation(sessionId: string, deviceId: string): void {
    if (this.planLabels.isMinting(sessionId) || this.sessionSlots.hasRecovery(sessionId)) {
      return;
    }
    const baseSessionId = this.liveBaseOfDerivedId(sessionId);
    if (baseSessionId === undefined) {
      return;
    }
    logger.warn(
      `Refused to create session ${sessionId} outside a plan allocation of its base ${baseSessionId}`,
    );
    const now = this.sessionNow();
    throw new TerminalSessionError(sessionId, {
      sessionId,
      deviceId,
      releaseReason: PLAN_AUTO_RELEASE_REASON,
      releasedAtMs: now,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: now,
        hasReceivedHeartbeat: false,
        timeoutMs: SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS,
        ageMs: 0,
      },
    });
  }

  private liveBaseOfDerivedId(sessionId: string): string | undefined {
    return this.planLabelsLifecycle.liveBaseOfDerivedId(sessionId);
  }

  isLiveSessionOfSamePlan(sessionId: string, otherSessionId: string): boolean {
    return this.planLabelsLifecycle.isLiveSessionOfSamePlan(sessionId, otherSessionId);
  }

  takeDerivedLabelSessions(baseSessionId: string, releaseReason?: string): string[] {
    return this.planLabelsLifecycle.takeDerivedLabelSessions(baseSessionId, releaseReason);
  }

  getDeviceLabels(sessionId: string): DeviceLabelMap | undefined {
    return this.cache.getDeviceLabels(sessionId);
  }

  getSessionCache(sessionId: string): SessionCacheData | null {
    return this.cache.getSessionCache(sessionId);
  }

  /**
   * A tool call on the session finished: restart the idle window from now (owner decision
   * 2026-10-08). The call stamped `lastUsedAt` when it started and held the session while it ran
   * (`activeSessionExecutionChecker`), so without this a call that outlasted the idle window would
   * release its session the moment it ended. The end of a call is tool usage, so it also refreshes
   * the session's activity heartbeat, exactly as the start did (`reclaimAndRefreshExistingSession`).
   */
  recordToolCallEnded(sessionId: string, end: { admitted: boolean } = { admitted: true }): void {
    // A call refused at admission (suspect, expired, not the holder) never used the session, so
    // its end must not restore a suspect lease or push an expired deadline out (#10824). A read
    // ends unadmitted too, and never extends the idle window, restart recovery included (#11281).
    if (!end.admitted) {
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session && this.restartRecoveryActivityAt.has(sessionId)) {
      // An admitted control call that waited on, or failed because of, a device restart is still
      // the client using the session: restart its idle window so recovery is only lost after real
      // quiet. One that failed at admission was credited there
      // ({@link creditControlCallFailedOnRestartRecovery}).
      this.recordRestartRecoveryActivity(sessionId);
      return;
    }
    if (!session || this.sessionSlots.isReleasing(session)) {
      return;
    }
    const now = this.sessionNow();
    session.lastUsedAt = Math.max(session.lastUsedAt, now);
    session.lastHeartbeat = Math.max(session.lastHeartbeat, now);
    session.expiresAt = Math.max(session.expiresAt, now + session.sessionTimeoutMs);
    session.activityGeneration++;
    void this.getBarrier()
      .track(() => this.recordSessionActivity(session))
      .catch((error) => {
        // Unlike a call's start, nobody awaits this write, so the in-memory refresh stands: the
        // call really did just end, and rolling back to its start would release a session that
        // outlived the idle window the moment it finished. The next activity write persists it.
        logger.warn(
          `[SessionManager] Failed to record tool-call end activity: ${errorMessage(error)}`,
        );
      });
  }

  /**
   * Record a liveness heartbeat for a session (#10656): it renews the owner lease and never the
   * tool-activity clocks. See {@link SessionLivenessController.recordHeartbeat}. Guarded by
   * `test/lint/livenessActivityClockSeparation.test.ts` (#10668).
   */
  recordHeartbeat(sessionId: string): void {
    this.liveness.recordHeartbeat(sessionId);
  }

  /** Make `ownerToken` the liveness owner unless another holds a live lease (#10050). */
  claimLivenessOwnership(sessionId: string, ownerToken: string): Promise<LivenessClaimOutcome> {
    return this.liveness.claimLivenessOwnership(sessionId, ownerToken);
  }

  /** Clear only the owner token; preserve the device, policy and existing lease/grace deadline. */
  releaseLivenessOwnership(sessionId: string, ownerToken: string): Promise<LivenessReleaseOutcome> {
    return this.liveness.releaseLivenessOwnership(sessionId, ownerToken);
  }

  /** Return whether `ownerToken` is still authorized to refresh the session. */
  hasLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return this.liveness.hasLivenessOwnership(sessionId, ownerToken);
  }

  /** Recover daemon-local liveness ownership after restart (#11602). */
  claimUnownedLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return this.liveness.claimUnownedLivenessOwnership(sessionId, ownerToken);
  }

  /** Bind acquisition identity and its claim-only lease start; no heartbeat or release changes. */
  bindAcquiredLivenessOwnerToken(sessionId: string, ownerToken: string): boolean {
    return this.liveness.bindAcquiredLivenessOwnerToken(sessionId, ownerToken);
  }

  /** Move a session onto the CLI liveness policy and record a heartbeat (#6870). */
  adoptCliLivenessPolicy(sessionId: string, requestedIdleTimeoutMs?: number): boolean {
    return this.liveness.adoptCliLivenessPolicy(sessionId, requestedIdleTimeoutMs);
  }

  /** Put a session on the `managed-execution` liveness policy with its idle window (#11176). */
  adoptManagedExecutionLivenessPolicy(
    sessionId: string,
    options: { idleTimeoutMs?: number } = {},
  ): Promise<Session> {
    return this.liveness.adoptManagedExecutionLivenessPolicy(sessionId, options);
  }

  /** Put a CLI-adopted session back on the strict heartbeat contract (#6870). */
  restoreHeartbeatLivenessPolicy(sessionId: string): boolean {
    return this.liveness.restoreHeartbeatLivenessPolicy(sessionId);
  }

  /**
   * The live session under `sessionId` for a lookup that only judges: unlike {@link getSession},
   * an expired session the scan has not reached is reported gone and is not released here.
   */
  peekSession(sessionId: string): Session | null {
    return this.unlessBaseEnded(this.expireIfDue(sessionId, false, undefined, false));
  }

  /**
   * How the base of the plan label session `label` has ended, when it has (#11640): the base's
   * end ends its labels, so a label whose base is released, being released for a terminal reason,
   * or past its idle deadline and not yet scanned is no longer a live session to anyone. The
   * reason is the base's recorded one, or the one its expiry would record. A read of state: it
   * releases, stamps and fences nothing. Undefined for a session no plan run minted, and once the
   * label itself has been removed, including while the release cascade runs.
   */
  private endedBaseOfLabel(
    label: Session,
  ): { baseSessionId: string; releaseReason: string } | undefined {
    if (label.persistenceMetadata?.source !== PLAN_LABEL_SESSION_SOURCE) {
      return undefined;
    }
    const retained = this.planLabels.retainedEndedBase(label.sessionId);
    if (retained) {
      return retained;
    }
    // Each hop is a strict prefix of the last, so this ends at the outermost base.
    for (
      let baseSessionId = this.getBaseSessionOfDerivedLabel(label.sessionId);
      baseSessionId !== undefined;
      baseSessionId = this.getBaseSessionOfDerivedLabel(baseSessionId)
    ) {
      const releaseReason = this.sessionEndReason(baseSessionId);
      if (releaseReason !== undefined) {
        return { baseSessionId, releaseReason };
      }
    }
    return undefined;
  }

  /** The terminal reason `sessionId` ended with, or would be released with by a lookup now. */
  private sessionEndReason(sessionId: string): string | undefined {
    const fenced = this.sessionSlots.getTerminalSnapshot(sessionId);
    if (fenced) {
      return fenced.releaseReason;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const inFlight = this.sessionSlots.getReleaseOp(sessionId);
    if (inFlight?.session === session && isTerminalReleaseReason(inFlight.reason.value)) {
      return inFlight.reason.value;
    }
    return this.isSessionExpired(session) ? this.expiredSessionReleaseReason(session) : undefined;
  }

  /** A looked-up session, unless it is a plan label whose base has ended (#11640). */
  private unlessBaseEnded(session: Session | null): Session | null {
    return session && this.endedBaseOfLabel(session) ? null : session;
  }

  /** The terminal release `session` is answered with before its own release has recorded one. */
  private terminalReleaseAsOfNow(session: Session, releaseReason: string): SessionReleaseSnapshot {
    const now = this.sessionNow();
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason,
      releasedAtMs: now,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, now - session.lastHeartbeat),
      },
    };
  }

  /**
   * Refuse a call naming a plan label whose base has ended (#11640) with the terminal answer the
   * base's own end gives, under the label's id and for the owner and anyone else alike. Judging
   * is a read; a refused control call then ends the base as a call naming the base would, through
   * the base's lazy expiry, and the base's release takes its labels with it. A read is not use
   * and releases nothing.
   */
  private refuseLabelOfEndedBase(
    sessionId: string,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    callerExecutionId: string | undefined,
  ): void {
    const label = this.sessions.get(sessionId);
    const ended = label && this.endedBaseOfLabel(label);
    if (!label || !ended) {
      return;
    }
    if (access !== "read-only") {
      this.releaseSessionPastIdleDeadline(
        ended.baseSessionId,
        execution?.executionId ?? callerExecutionId,
      );
    }
    throw new TerminalSessionError(
      sessionId,
      this.terminalReleaseAsOfNow(label, ended.releaseReason),
    );
  }

  /**
   * The terminal answer for a call that needs `sessionId` live when it has ended or is past its
   * idle deadline (#11640), or undefined while it is live. A plan step routed by a `device` label
   * asks this about its base once the base publishes no labels, so the plan fails with the base's
   * release reason rather than "label is not allocated". The step names the base, so a base past
   * its deadline is released here through its lazy expiry, like any call naming it.
   */
  terminalAnswerForEndedSession(
    sessionId: string,
    callerExecutionId?: string,
  ): TerminalSessionError | undefined {
    const answer = this.peekTerminalAnswerForEndedSession(sessionId);
    if (answer) {
      this.releaseSessionPastIdleDeadline(sessionId, callerExecutionId);
    }
    return answer;
  }

  /** The same terminal answer, judged without releasing or stamping anything (#11640). */
  peekTerminalAnswerForEndedSession(sessionId: string): TerminalSessionError | undefined {
    const session = this.sessions.get(sessionId);
    const releaseReason =
      this.sessionEndReason(sessionId) ??
      (session ? this.endedBaseOfLabel(session)?.releaseReason : undefined);
    if (releaseReason === undefined) {
      return undefined;
    }
    const fenced = this.sessionSlots.getTerminalSnapshot(sessionId);
    if (fenced || !session) {
      return fenced && new TerminalSessionError(sessionId, fenced);
    }
    return new TerminalSessionError(sessionId, this.terminalReleaseAsOfNow(session, releaseReason));
  }
  ownershipSessionUuid(sessionId: string): string {
    return this.leaseExpiry.ownershipSessionUuid(sessionId);
  }

  private livenessOwnerView(session: Session): LivenessOwnerView {
    return this.leaseExpiry.livenessOwnerView(session);
  }

  getOwnerLeaseHold(sessionId: string): LivenessOwnerHold | undefined {
    return this.leaseExpiry.getOwnerLeaseHold(sessionId);
  }

  getSessionLeaseState(sessionId: string): LivenessLeaseState | undefined {
    return this.leaseExpiry.getSessionLeaseState(sessionId);
  }

  private assertSessionNotSuspect(session: Session, access: SessionAccess): void {
    return this.leaseExpiry.assertSessionNotSuspect(session, access);
  }

  ownerLeaseAwaitsReap(sessionId: string): boolean {
    return this.leaseExpiry.ownerLeaseAwaitsReap(sessionId);
  }

  judgedLeaseHeartbeat(session: Session): number {
    return this.leaseExpiry.judgedLeaseHeartbeat(session);
  }

  creditOwnerHeartbeatDuringRelease(sessionId: string, ownerToken: string): void {
    return this.leaseExpiry.creditOwnerHeartbeatDuringRelease(sessionId, ownerToken);
  }

  private judgeOwnerLeaseForRelease(
    session: Session,
    reason: ReleaseReasonState,
    stage: "start" | "commit",
    operation?: SessionReleaseOperation,
  ): boolean {
    return this.leaseExpiry.judgeOwnerLeaseForRelease(session, reason, stage, operation);
  }

  private refuseControlCallOnLapsedOwnerLease(
    session: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    return this.leaseExpiry.refuseControlCallOnLapsedOwnerLease(
      session,
      access,
      execution,
      unnamedCallerExecutionId,
    );
  }

  private refuseLabelCallOnLapsedBaseLease(
    label: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    return this.leaseExpiry.refuseLabelCallOnLapsedBaseLease(
      label,
      access,
      execution,
      unnamedCallerExecutionId,
    );
  }

  /**
   * Register the detector that applies {@link forgiveDaemonStall} for a stall the monitor has not
   * yet noticed. Every expiry judgement (lookup, sweep) runs it first, so which timer fires first
   * after a stall or wake no longer decides the outcome. Pass undefined to detach.
   */
  setStallProbe(probe: (() => void) | undefined): void {
    this.stallProbe = probe;
    // The observer registry judges its own expiries, so it runs the same detector first (#11554).
    this.observerSessions?.setStallProbe?.(probe);
  }

  /**
   * Start every rehydrated session's owner-reconnect window now (#10051 follow-up). Rehydration
   * runs early in daemon startup, before iOS services, the control socket and the heartbeat
   * monitor, and no owner can reconnect until the socket accepts connections, so the window is
   * measured from when the daemon is ready to hear from owners rather than from rehydration.
   * Returns how many sessions were restarted.
   */
  startRehydratedOwnerWindows(): number {
    const now = this.sessionNow();
    let restarted = 0;
    for (const session of this.sessions.values()) {
      if (session.ownership === "awaiting-owner" && session.awaitingOwnerSince !== undefined) {
        session.awaitingOwnerSince = Math.max(session.awaitingOwnerSince, now);
        // The idle window starts when the session is usable, like the owner window (#11388).
        // Rehydration stamped both at its own time, which startup may have outlasted.
        session.lastUsedAt = Math.max(session.lastUsedAt, now);
        session.expiresAt = Math.max(session.expiresAt, now + session.sessionTimeoutMs);
        restarted++;
      }
    }
    return restarted;
  }

  /**
   * Do not hold the daemon's own stall, or the host's sleep, against an owner's lease (#10051,
   * #10699).
   *
   * Called by the heartbeat monitor, which tells the two apart by the wall clock running ahead of
   * the monotonic one rather than by length:
   *
   * - `lostMs`: the daemon's event loop stalled while the host was awake. Owners kept
   *   heartbeating and calling, but the daemon could not hear them, so the lease AND the idle
   *   deadline move forward by exactly that interval, whatever its length.
   * - `sleptMs`: the host was suspended. Nothing ran, owners included, so the lease moves forward
   *   by it, but the idle deadline does not: host sleep counts toward the idle window (owner
   *   policy, #10661).
   *
   * Nothing moves past `resumedAt`, so time an owner genuinely missed before the gap still counts.
   * A `cli-idle` session has no lease; its wall-clock idle window moves forward by the same
   * `lostMs` (and never by `sleptMs`) through `idleStallForgivenAt`, so whether it survives a stall
   * no longer depends on which timer fires first afterwards (#10835).
   *
   * `gapBeganAt`, when given, narrows full lease forgiveness (#11080) to owners live at the
   * gap's start (`ownerLeaseLiveAt`). A live owner is forgiven in full however long the gap.
   * An owned session whose socket was connected at that instant also receives awake-stall credit
   * (#11992), capped in total between raw owner heartbeats at 600 s if still connected at resume,
   * otherwise MAX_CREDIBLE_DAEMON_STALL_MS (30 s).
   * Sleep contributes no credit to this extra rule. Without another owner heartbeat, even an
   * always-open socket is released once its raw heartbeat age exceeds heartbeatTimeoutMs +
   * SUSPECT_GRACE_MS + that cap, plus one scan. With no late tick, the existing
   * lease + grace + one scan bound is unchanged (10 s at defaults). Returns sessions considered.
   *
   * Observer registrations are excused the same gap under the same rule (#11554): it is handed
   * on as durations, because the observer registry keeps its own clock.
   */
  forgiveDaemonStall(resumedAt: number, lostMs: number, sleptMs = 0, gapBeganAt?: number): number {
    const leaseLostMs = lostMs + sleptMs;
    this.observerSessions?.forgiveStall?.({
      lostMs,
      sleptMs,
      gapAgeMs: gapBeganAt === undefined ? undefined : resumedAt - gapBeganAt,
    });
    let forgiven = 0;
    let leaseExtended = 0;
    let connectedExtended = 0;
    let connectedCreditMs = 0;
    let idleExtended = 0;
    for (const session of this.sessions.values()) {
      if (session.livenessPolicy === "cli-idle") {
        // Shift, never reset (#10662), and never past the resume point.
        const idleStart = effectiveLastToolActivity(session);
        session.idleStallForgivenAt = Math.max(idleStart, Math.min(resumedAt, idleStart + lostMs));
        idleExtended += Number(session.idleStallForgivenAt > idleStart);
        // A rehydrated one is judged on its owner-reconnect window alone, so that window moves
        // with the idle anchor (#11481): by the daemon's stall, never by host sleep, which counts
        // toward a CLI session's idle window.
        if (session.awaitingOwnerSince !== undefined) {
          session.awaitingOwnerSince = Math.max(
            session.awaitingOwnerSince,
            Math.min(session.awaitingOwnerSince + lostMs, resumedAt),
          );
        }
        forgiven++;
        continue;
      }
      this.forgiveMintBoundClaimLease(session, resumedAt, leaseLostMs, gapBeganAt);
      const extension = daemonStallLeaseExtension(
        session,
        resumedAt,
        { lostMs, sleptMs, gapBeganAt },
        this.ownerConnectedAtReader,
      );
      if (extension.leaseStart !== undefined) {
        session.stallForgivenAt = extension.leaseStart;
      }
      leaseExtended += extension.leaseExtended;
      connectedExtended += extension.connectedExtended;
      connectedCreditMs += extension.connectedCreditMs;
      // Shift, never reset (#10662): a full window per late tick would let a session whose
      // owner is gone outlive its lease for as long as the ticks keep arriving late.
      const previousExpiry = session.expiresAt;
      session.expiresAt = Math.max(
        session.expiresAt,
        Math.min(session.expiresAt + lostMs, resumedAt + session.sessionTimeoutMs),
      );
      idleExtended += Number(session.expiresAt > previousExpiry);
      if (session.awaitingOwnerSince !== undefined) {
        session.awaitingOwnerSince = Math.max(
          session.awaitingOwnerSince,
          Math.min(session.awaitingOwnerSince + leaseLostMs, resumedAt),
        );
      }
      forgiven++;
    }
    if (forgiven > 0) {
      logger.info(
        `Stall forgiveness: ${leaseExtended} session lease(s) extended by ${leaseLostMs}ms, ` +
          `${connectedExtended} connected-owner lease(s) extended by ${connectedCreditMs}ms, ` +
          `${idleExtended} idle deadline(s) extended by ${lostMs}ms, of ${forgiven} session(s)`,
      );
    }
    return forgiven;
  }
  private forgiveMintBoundClaimLease(
    session: Session,
    resumedAt: number,
    leaseLostMs: number,
    gapBeganAt?: number,
  ): void {
    return this.leaseExpiry.forgiveMintBoundClaimLease(session, resumedAt, leaseLostMs, gapBeganAt);
  }

  clearSessionCache(sessionId: string, key?: string): void {
    return this.cache.clearSessionCache(sessionId, key);
  }

  /**
   * Get count of active sessions
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).filter((s) => !this.isSessionExpired(s));
  }

  /** Snapshot every in-memory session, including expired entries awaiting cleanup. */
  getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Snapshot every session identity that is published or still completing
   * creation, assignment, rebind, or early-release work.
   */
  getAllKnownSessionIds(): string[] {
    return deriveKnownSessionIds(this.getLegacyLifecycleView());
  }

  /**
   * Get all devices currently assigned to sessions
   */
  getAssignedDevices(): Set<string> {
    return new Set(
      Array.from(this.sessions.values())
        .filter((s) => !this.isSessionExpired(s))
        .map((s) => s.assignedDevice),
    );
  }
  private isSessionExpired(session: Session): boolean {
    return this.leaseExpiry.isSessionExpired(session);
  }

  getIdleReleaseExecutionVeto(sessionId: string): { latestDeadlineMs?: number } | undefined {
    return this.leaseExpiry.getIdleReleaseExecutionVeto(sessionId);
  }

  private cancelExecutionsOverriddenByExpiry(
    session: Session,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    return this.leaseExpiry.cancelExecutionsOverriddenByExpiry(
      session,
      releaseReason,
      excludeExecutionId,
    );
  }

  cancelExecutionsCutByRelease(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    return this.leaseExpiry.cancelExecutionsCutByRelease(
      sessionId,
      releaseReason,
      excludeExecutionId,
    );
  }

  private expiredSessionReleaseReason(session: Session): SessionReleaseReason {
    return this.leaseExpiry.expiredSessionReleaseReason(session);
  }

  private isSessionExpiredForNewExecution(
    session: Session,
    execution?: SessionClockExecution,
  ): boolean {
    return this.leaseExpiry.isSessionExpiredForNewExecution(session, execution);
  }

  private isLateExecutionWhileEarlierWorkIsActive(
    session: Session,
    execution: SessionClockExecution | undefined,
    hold: "any" | "timely-control" | "recovery" = "any",
  ): boolean {
    return this.leaseExpiry.isLateExecutionWhileEarlierWorkIsActive(session, execution, hold);
  }

  /**
   * Remove session from all maps
   */
  private removeSession(sessionId: string, expectedSession?: Session): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || (expectedSession && session !== expectedSession)) {
      return false;
    }
    const ownedDevice = this.deviceSessionMap.get(session.assignedDevice) === sessionId;
    if (ownedDevice) {
      this.deviceSessionMap.delete(session.assignedDevice);
    }
    this.sessions.delete(sessionId);
    this.slotShadowProbe.check(sessionId, "unpublished");
    this.planLabels.clearEndedBase(sessionId);
    // The session ended: its row is no longer rewritten live, and no retry timer outlives it.
    this.superseded.settle(session);
    this.stateRestore.forgetSession(sessionId);
    if (ownedDevice) {
      // Generation only: removing an owner leaves this device's screen/connection intact.
      // Any restore, removal or disconnect separately publishes its full boundary.
      this.notifyDeviceOwnershipChange(session.assignedDevice);
    }
    return true;
  }

  /**
   * Remove all expired sessions and fire release callbacks for them.
   *
   * Runs on the periodic cleanup timer, but is also invoked by the heartbeat
   * monitor on its (much shorter) interval so that idle sessions — including
   * autolocked devices past their 60 s idle window — are released promptly
   * instead of waiting for the next 5-minute sweep.
   */
  cleanupExpiredSessions(): void {
    this.stallProbe?.();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (this.isSessionExpired(session) && !this.sessionSlots.isReleasing(session)) {
        expiredSessions.push(sessionId);
      }
    }

    if (expiredSessions.length === 0) {
      return;
    }

    logger.info(
      `Cleaning up ${expiredSessions.length} expired sessions found by sweep: ` +
        expiredSessions.join(", "),
    );

    for (const sessionId of expiredSessions) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        continue;
      }
      const releaseReason = this.expiredSessionReleaseReason(session);
      const overridesControl = this.activeSessionExecutionChecker(sessionId, {
        excludeReads: true,
      });
      if (this.cancelExecutionsOverriddenByExpiry(session, releaseReason)) {
        if (overridesControl) {
          logger.warn(
            `Session ${sessionId} was kept past its idle deadline by control calls that never ` +
              `settled; cancelling them and releasing it past their request deadline plus grace, ` +
              `or the unsettled-execution ceiling when a control call has no deadline`,
          );
        } else {
          logger.info(`Session ${sessionId} idle release cut in-flight reads`);
        }
      }
      const release = this.releaseSession(sessionId, releaseReason, {
        allowExpired: true,
        expiryOrigin: "cleanup-expired",
      });
      void this.getBarrier()
        .trackExisting(release)
        .catch((error) =>
          logger.warn(`[SessionManager] Failed to release expired session ${sessionId}: ${error}`),
        );
    }
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = this.timer.setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.CLEANUP_INTERVAL_MS);

    // Allow process to exit even if timer is running
    if (
      this.cleanupTimer &&
      typeof (this.cleanupTimer as { unref?: () => void }).unref === "function"
    ) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop cleanup timer (called on daemon shutdown)
   */
  /** @internal Typed view of private state for unit tests; not part of the public API. */
  get testHooks() {
    return { sessions: this.sessions } as const;
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      this.timer.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.rehydrationFollowUpTimer) {
      this.timer.clearTimeout(this.rehydrationFollowUpTimer);
      this.rehydrationFollowUpTimer = null;
    }
    this.rowWriter.stopRetryTimers();
    this.superseded.stopTimers();
    // Cancel any armed per-condition network TTLs so a stopped manager leaves no
    // dangling timer (issue #6085 item 2).
    this.stateRestore.stopAll();
    this.rowWriter.clearPendingNonTerminalReleases();
    this.superseded.clearRowsUnderPendingRelease();
  }
  private persistSession(
    session: Session,
    incarnation: Session,
    upsertOptions?: UpsertActiveSessionOptions,
    upsertSettled?: () => void,
  ): Promise<void> {
    return this.activityPersistence.persistSession(
      session,
      incarnation,
      upsertOptions,
      upsertSettled,
    );
  }

  private awaitInFlightOwnRowWrites(
    incarnation: Session | undefined,
    row: DeviceSession | undefined,
    expectedRowGeneration: number | undefined,
  ): Promise<void> | undefined {
    return this.activityPersistence.awaitInFlightOwnRowWrites(
      incarnation,
      row,
      expectedRowGeneration,
    );
  }

  private recordPersistedRowGeneration(incarnation: Session, rowGeneration: number | void): void {
    return this.activityPersistence.recordPersistedRowGeneration(incarnation, rowGeneration);
  }

  private recoveryTargetFromPersisted(
    sessionId: string,
    persisted: DeviceSession | undefined,
    requestedPlatform: Platform | undefined,
    callerInFlight: boolean,
  ): Promise<SessionRecoveryTarget | undefined> {
    return this.recovery.recoveryTargetFromPersisted(
      sessionId,
      persisted,
      requestedPlatform,
      callerInFlight,
    );
  }

  protected recoveryLivenessFromPersisted(persisted: DeviceSession): SessionRecoveryLiveness {
    return this.recovery.recoveryLivenessFromPersisted(persisted);
  }

  private recordSessionActivity(session: Session): Promise<void> {
    return this.activityPersistence.recordSessionActivity(session);
  }

  private persistSessionActivity(
    session: Session,
    update: DeviceSessionActivityUpdate,
  ): Promise<void> {
    return this.activityPersistence.persistSessionActivity(session, update);
  }

  private endSessionTerminallyReleasedInRow(session: Session): Promise<Error> {
    return this.activityPersistence.endSessionTerminallyReleasedInRow(session);
  }

  private hasUnissuedActivity(session: Session): boolean {
    return this.activityPersistence.hasUnissuedActivity(session);
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    expiredSessions: number;
    assignedDevices: number;
  } {
    const activeSessions = this.getAllSessions().length;
    const expiredSessions = this.sessions.size - activeSessions;

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      expiredSessions,
      assignedDevices: this.getAssignedDevices().size,
    };
  }
}

/**
 * Removes and renews iOS per-app rules through the installed controller. A
 * reset that is not confirmed throws, so release keeps retrying and the device
 * stays quarantined until the rule is gone or its lease ends it.
 */
function defaultIosAppNetworkRuleRestorer(): IosAppNetworkRuleRestorer {
  const client = new IosAppNetworkRuleClient(new ExecNetworkFilterBridge());
  return {
    reset: async (rule) => {
      const result = await client.reset(rule);
      // Another session's rule for the same app is not ours to remove; ours is gone.
      if (
        result.kind === "reset" ||
        (result.kind === "refused" && result.outcome === "owned_by_another_session")
      ) {
        return;
      }
      throw new Error(
        `Failed to remove the offline rule for ${rule.bundleId} on ${rule.udid}: ${result.detail}`,
      );
    },
    renew: (rule, leaseMs) => client.renew(rule, leaseMs),
  };
}
