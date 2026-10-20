import { ENV } from "../config/env";
import { getDbWriteBarrier, type DbWriteBarrier } from "../db/dbWriteBarrier";
import {
  DeviceSessionRepository,
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
import {
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
  SESSION_HELD_BY_RECOVERY_CODE,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
} from "../models/deviceAcquisitionRefusals";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../models/managedExecutionLiveness";
import type { ObserveResult } from "../models/ObserveResult";
import { SessionNoLongerOwnsDeviceError } from "../models/sessionNoLongerOwnsDevice";
import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { readEnvPositiveInteger } from "../utils/envNumbers";
import {
  type KeepAwakeRestoreReport,
  type KeepScreenAwakeRestoreOutcome,
  type KeepScreenAwakeState,
} from "../utils/KeepScreenAwakeManager";
import { logger } from "../utils/logger";
import type { TimingData } from "../utils/PerformanceTracker";
import { defaultTimer, SteadyWallClock, type Timer } from "../utils/SystemTimer";
import { type DeferredRebindCleanup } from "./acquisitionReceipt";
import { type OwnerConnectedAtReader } from "./connectedOwnerStallExcuse";
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
import { type LivenessLeaseState, type LivenessOwnerHold } from "./livenessOwnerLease";
import { NoopTerminalReleaseJournal } from "./NoopTerminalReleaseJournal";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import { PlanLabelRegistry } from "./planLabelRegistry";
import { type DeviceReadinessLevel } from "./readiness/DeviceReadiness";
import { SessionReleasePersistTimeoutError } from "./releaseErrors";
import { type SessionReleaseReason } from "./releaseReasons";
import type { ReleaseSessionRequest } from "./releaseSessionRequest";
import { onSessionClock } from "./sessionClockPersistence";
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
import { TerminalSessionError } from "./sessionErrors";
import { SessionLivenessController } from "./sessionLivenessLease";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  getSessionHeartbeatCheckIntervalMs,
  getSessionIdleTimeoutMs,
} from "./sessionLivenessWindows";
import { SessionAcquisition } from "./sessionManager/acquisition";
import { SessionActivityClocks } from "./sessionManager/activityClocks";
import { SessionActivityPersistence } from "./sessionManager/activityPersistence";
import { SessionAdmission } from "./sessionManager/admission";
import { SessionBookkeeping } from "./sessionManager/bookkeeping";
import { SessionCache } from "./sessionManager/cache";
import { SessionCallbacks } from "./sessionManager/callbacks";
import { SessionCreation } from "./sessionManager/creation";
import { SessionCreationGuard } from "./sessionManager/creationGuard";
import { ForcedStuckRelease } from "./sessionManager/forcedStuckRelease";
import {
  createSessionManagerCollaboratorHost,
  type SessionManagerCollaboratorActions,
  type SessionManagerCollaboratorHost,
  type SessionManagerPersistenceCollaboratorActions,
} from "./sessionManager/host";
import {
  managedExecutionReleaseMarker,
  type ClaimedCreationRow,
  type PendingSessionCreation,
  type PendingSessionRebind,
  type PendingSessionRelease,
  type RecoveryAssignmentWait,
  type ReleaseReasonState,
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
import { SessionRecoveryPublication } from "./sessionManager/recoveryPublication";
import { SessionRehydration } from "./sessionManager/rehydration";
import { SessionReleaseCommit } from "./sessionManager/releaseCommit";
import { SessionReleasePersistence } from "./sessionManager/releasePersistence";
import { SessionReleaseRequests } from "./sessionManager/releaseRequests";
import { SessionReleaseWrite } from "./sessionManager/releaseWrite";
import { DeviceRestoreHealth } from "./sessionManager/restoreHealth";
import { SupersededSessionRows } from "./sessionManager/supersededRows";
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

  private waitOutRecreationOf(sessionId: string): Promise<void> {
    return this.supersededRows.waitOutRecreationOf(sessionId);
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
  private readonly releaseCommit = new SessionReleaseCommit(this.collaboratorHost);

  private readonly creationGuard = new SessionCreationGuard(this.collaboratorHost);

  private readonly admission = new SessionAdmission(this.collaboratorHost);

  private readonly bookkeeping = new SessionBookkeeping(this.collaboratorHost);

  private readonly callbacks = new SessionCallbacks(this.collaboratorHost);

  private readonly activityClocks = new SessionActivityClocks(this.collaboratorHost);

  private readonly recoveryPublication = new SessionRecoveryPublication(this.collaboratorHost);

  private readonly releaseWrite = new SessionReleaseWrite(this.collaboratorHost);
  private createCollaboratorActions(): SessionManagerCollaboratorActions {
    return {
      ...this.createPersistenceCollaboratorActions(),
      refusePlanLabelSessionOutsideItsRun: (...args) =>
        this.planLabelsLifecycle.refusePlanLabelSessionOutsideItsRun(...args),
      expireIfDue: (...args) => this.expireIfDue(...args),
      markIdentityReplacedRelease: (...args) =>
        this.restoreHealth.markIdentityReplacedRelease(...args),
      createReleaseReasonState: (...args) => this.releaseCommit.createReleaseReasonState(...args),
      judgeOwnerLeaseForRelease: (...args) => this.leaseExpiry.judgeOwnerLeaseForRelease(...args),
      finishReleaseForcedBeforeStart: (...args) => this.finishReleaseForcedBeforeStart(...args),
      releaseSessionInternal: (...args) => this.releaseCommit.releaseSessionInternal(...args),
      finishIdentityReplacedRelease: (...args) =>
        this.restoreHealth.finishIdentityReplacedRelease(...args),
      releaseFinalizedSession: (...args) => this.releaseCommit.releaseFinalizedSession(...args),
      persistTerminalReleaseIfNeeded: (...args) =>
        this.releasePersistence.persistTerminalReleaseIfNeeded(...args),
      isLiveDaemonSession: (...args) => this.recovery.isLiveDaemonSession(...args),
      liftTerminalFence: (...args) => this.liftTerminalFence(...args),
      endedBaseOfLabel: (...args) => this.admission.endedBaseOfLabel(...args),
      rejectCreationAfterShutdownFence: (...args) =>
        this.creationGuard.rejectCreationAfterShutdownFence(...args),
      assertTerminalReleaseAdmission: (...args) =>
        this.admission.assertTerminalReleaseAdmission(...args),
      invalidateFinalizedSessionIdentity: (...args) =>
        this.releaseCommit.invalidateFinalizedSessionIdentity(...args),
      cancelSessionlessUseOnAcquisition: (...args) =>
        this.callbacks.cancelSessionlessUseOnAcquisition(...args),
      notifySessionCreated: (...args) => this.callbacks.notifySessionCreated(...args),
      creationRowRollbackSnapshot: (...args) =>
        this.creationGuard.creationRowRollbackSnapshot(...args),
      retireAbandonedCreation: (...args) => this.creationGuard.retireAbandonedCreation(...args),
      revokeSupersededIdentityReplacement: (...args) =>
        this.restoreHealth.revokeSupersededIdentityReplacement(...args),
      abandonSupersededRelease: (...args) => this.releaseCommit.abandonSupersededRelease(...args),
      releaseHeartbeatTimeoutMs: (...args) => this.releaseCommit.releaseHeartbeatTimeoutMs(...args),
      persistTerminalReleaseWithinDeadline: (...args) =>
        this.releaseCommit.persistTerminalReleaseWithinDeadline(...args),
      abandonReleaseSupersededAfterPersist: (...args) =>
        this.releaseCommit.abandonReleaseSupersededAfterPersist(...args),
      commitReleaseRemoval: (...args) => this.releaseCommit.commitReleaseRemoval(...args),
      commitReplacedDeviceTeardown: (...args) =>
        this.releaseCommit.commitReplacedDeviceTeardown(...args),
      restoreNonTerminalRowOverSupersededReleaseLater: (...args) =>
        this.supersededRows.restoreNonTerminalRowOverSupersededReleaseLater(...args),
      completeReleasePersistence: (...args) =>
        this.releaseCommit.completeReleasePersistence(...args),
      recordFinalizedSessionRelease: (...args) =>
        this.releaseCommit.recordFinalizedSessionRelease(...args),
      finishCommittedRelease: (...args) => this.releaseCommit.finishCommittedRelease(...args),
      removeSession: (...args) => this.activityClocks.removeSession(...args),
      dropReplacedDeviceRestoreState: (...args) =>
        this.releaseCommit.dropReplacedDeviceRestoreState(...args),
      retireRestorations: (...args) => this.retireRestorations(...args),
      withReleaseReason: (...args) => this.withReleaseReason(...args),
      persistTerminalReleaseWithUpgrade: (...args) =>
        this.releaseCommit.persistTerminalReleaseWithUpgrade(...args),
      liftPlanLabelFenceForMint: (...args) =>
        this.planLabelsLifecycle.liftPlanLabelFenceForMint(...args),
      withinCreateDeadline: (...args) => this.creation.withinCreateDeadline(...args),
      creatorSourceForCreation: (...args) =>
        this.planLabelsLifecycle.creatorSourceForCreation(...args),
      recoverySessionFields: (...args) => this.recovery.recoverySessionFields(...args),
      notifyManagedExecutionRecovery: (...args) =>
        this.callbacks.notifyManagedExecutionRecovery(...args),
      persistAndPublishSession: (...args) => this.persistAndPublishSession(...args),
      claimedIncarnation: (...args) => this.creationGuard.claimedIncarnation(...args),
      rollBackCancelledClientChosenCreation: (...args) =>
        this.creationGuard.rollBackCancelledClientChosenCreation(...args),
      persistRejectedCreationRow: (...args) =>
        this.creationGuard.persistRejectedCreationRow(...args),
      persistCreationRollback: (...args) => this.creation.persistCreationRollback(...args),
      isSessionExpired: (...args) => this.isSessionExpired(...args),
      recordSessionActivity: (...args) => this.recordSessionActivity(...args),
      resolveSessionAcquisitionOptions: (...args) =>
        this.acquisition.resolveSessionAcquisitionOptions(...args),
      getSessionForNewExecution: (...args) => this.getSessionForNewExecution(...args),
      assertSessionNotSuspect: (...args) => this.leaseExpiry.assertSessionNotSuspect(...args),
      refuseControlCallOnLapsedOwnerLease: (...args) =>
        this.refuseControlCallOnLapsedOwnerLease(...args),
      refuseLabelCallOnLapsedBaseLease: (...args) =>
        this.admission.refuseLabelCallOnLapsedBaseLease(...args),
      refreshExistingSessionForAccess: (...args) =>
        this.admission.refreshExistingSessionForAccess(...args),
      refuseLabelOfEndedBase: (...args) => this.admission.refuseLabelOfEndedBase(...args),
      startOrJoinUnseenAssignment: (...args) =>
        this.acquisition.startOrJoinUnseenAssignment(...args),
      preFenceIdleReleaseReason: (...args) => this.admission.preFenceIdleReleaseReason(...args),
      expiredReleaseOfUnheldRow: (...args) => this.admission.expiredReleaseOfUnheldRow(...args),
      peekTerminalAnswerForEndedSession: (...args) =>
        this.peekTerminalAnswerForEndedSession(...args),
      expiredReleaseFromPersisted: (...args) =>
        this.persistedAdmission.expiredReleaseFromPersisted(...args),
      sessionEndReason: (...args) => this.admission.sessionEndReason(...args),
      expiredSessionReleaseReason: (...args) =>
        this.leaseExpiry.expiredSessionReleaseReason(...args),
      releaseSessionPastIdleDeadline: (...args) => this.releaseSessionPastIdleDeadline(...args),
      liveBaseOfDerivedId: (...args) => this.liveBaseOfDerivedId(...args),
      canStartSessionSetup: (...args) => this.bookkeeping.canStartSessionSetup(...args),
      clearSessionSetup: (...args) => this.bookkeeping.clearSessionSetup(...args),
      retryPendingTerminalReleasesNow: (...args) => this.retryPendingTerminalReleasesNow(...args),
      settleReleaseDrain: (...args) => this.bookkeeping.settleReleaseDrain(...args),
      getPendingDeviceCleanup: (...args) => this.getPendingDeviceCleanup(...args),
      armPendingDeviceCleanupCaps: (...args) => this.armPendingDeviceCleanupCaps(...args),
      forgiveMintBoundClaimLease: (...args) => this.leaseExpiry.forgiveMintBoundClaimLease(...args),
      cancelExecutionsOverriddenByExpiry: (...args) =>
        this.cancelExecutionsOverriddenByExpiry(...args),
      recoveryTargetFromPersisted: (...args) => this.recovery.recoveryTargetFromPersisted(...args),
      assignUnseenSessionToDevicePool: (...args) =>
        this.recovery.assignUnseenSessionToDevicePool(...args),
      getSession: (...args) => this.getSession(...args),
      settleManagedExecutionRecovery: (...args) =>
        this.callbacks.settleManagedExecutionRecovery(...args),
      rehydrationSkipReason: (...args) => this.rehydration.rehydrationSkipReason(...args),
      registerRehydrationRecovery: (...args) =>
        this.rehydration.registerRehydrationRecovery(...args),
      getTerminalReleaseSnapshot: (...args) => this.getTerminalReleaseSnapshot(...args),
      waitForSessionSetup: (...args) => this.waitForSessionSetup(...args),
      createReboundSession: (...args) => this.rebinding.createReboundSession(...args),
      restoreReleasedRowAfterReassert: (...args) =>
        this.supersededRows.restoreReleasedRowAfterReassert(...args),
      restoreIncarnationIsCurrent: (...args) => this.restoreIncarnationIsCurrent(...args),
      waitForIdentityReplacement: (...args) => this.waitForIdentityReplacement(...args),
      notifySessionDeviceUnbound: (...args) => this.callbacks.notifySessionDeviceUnbound(...args),
      restoreRebindOverrides: (...args) => this.rebinding.restoreRebindOverrides(...args),
      deferRebindOverrides: (...args) => this.rebinding.deferRebindOverrides(...args),
      releaseWritePrecondition: (...args) =>
        this.releasePersistence.releaseWritePrecondition(...args),
      issueReleaseRow: (...args) => this.releasePersistence.issueReleaseRow(...args),
      releaseRowFallback: (...args) => this.releasePersistence.releaseRowFallback(...args),
      trackLateReleaseWrite: (...args) => this.releasePersistence.trackLateReleaseWrite(...args),
      confirmReleaseWrite: (...args) => this.releasePersistence.confirmReleaseWrite(...args),
      handleReleaseWriteFailure: (...args) =>
        this.releasePersistence.handleReleaseWriteFailure(...args),
    };
  }
  private createPersistenceCollaboratorActions(): SessionManagerPersistenceCollaboratorActions {
    return {
      isTerminalReleaseRetryCurrent: (...args) => this.isTerminalReleaseRetryCurrent(...args),
      retryTerminalReleaseWrite: (...args) => this.retryTerminalReleaseWrite(...args),
      dropReleaseRetry: (...args) => this.releasePersistence.dropReleaseRetry(...args),
      refuseLabelMintOutsidePlanAllocation: (...args) =>
        this.admission.refuseLabelMintOutsidePlanAllocation(...args),
      rejectRefusedRebind: (...args) => this.recoveryPublication.rejectRefusedRebind(...args),
      readSessionRow: (sessionId) => this.deviceSessionRepository.getSession(sessionId),
      dispatchDeviceRestore: (...args) => this.dispatchDeviceRestore(...args),
      sessionNow: (...args) => this.sessionNow(...args),
      isRowOwnedByLivePeer: (...args) => this.releaseRequests.isRowOwnedByLivePeer(...args),
      isSessionBeingRecreated: (...args) => this.isSessionBeingRecreated(...args),
      sessionClockToWall: (...args) => this.sessionClockToWall(...args),
      rowWriteLivePeerDaemonSessionIds: (...args) =>
        this.supersededRows.rowWriteLivePeerDaemonSessionIds(...args),
      releaseSnapshotFromPersisted: (...args) =>
        this.recoveryPublication.releaseSnapshotFromPersisted(...args),
      persistSessionRelease: (...args) => this.persistSessionRelease(...args),
      notifySessionRelease: (...args) => this.callbacks.notifySessionRelease(...args),
      isLapsedUnownedRestartRecovery: (...args) =>
        this.acquisition.isLapsedUnownedRestartRecovery(...args),
      admitPersistedSession: (...args) => this.acquisition.admitPersistedSession(...args),
      isReissuablePersistedSession: (...args) =>
        this.persistedAdmission.isReissuablePersistedSession(...args),
      recoverPersistedRow: (...args) => this.recoverPersistedRow(...args),
      readPersistedSession: (...args) => this.persistedAdmission.readPersistedSession(...args),
      unlessBeingReplaced: (...args) => this.persistedAdmission.unlessBeingReplaced(...args),
      terminalReleaseFromPersisted: (...args) =>
        this.persistedAdmission.terminalReleaseFromPersisted(...args),
      recoveredRowOwner: (...args) => this.recoveredRowOwner(...args),
      isNameReissueOnlyRow: (...args) => this.persistedAdmission.isNameReissueOnlyRow(...args),
      terminalizePersistedRecoveryFailure: (...args) =>
        this.recoveryPublication.terminalizePersistedRecoveryFailure(...args),
      recoveryLivenessFromPersisted: (...args) => this.recoveryLivenessFromPersisted(...args),
      newSharedAssignment: (...args) => this.acquisition.newSharedAssignment(...args),
      recoverPersistedSession: (...args) => this.recovery.recoverPersistedSession(...args),
      waitForSharedAssignment: (...args) => this.acquisition.waitForSharedAssignment(...args),
      applyRecoveredTerminalReleaseIntents: (...args) =>
        this.applyRecoveredTerminalReleaseIntents(...args),
      listRecoverableSessionsBeforeDeadline: (...args) =>
        this.recoveryPublication.listRecoverableSessionsBeforeDeadline(...args),
      rehydratePersistedRow: (...args) => this.recoveryPublication.rehydratePersistedRow(...args),
      isRecoverablePersistedSession: (...args) =>
        this.persistedAdmission.isRecoverablePersistedSession(...args),
      assertTerminalRebindAdmission: (...args) =>
        this.admission.assertTerminalRebindAdmission(...args),
      createSession: (...args) => this.createSession(...args),
      notifyDeviceOwnershipChange: (...args) => this.callbacks.notifyDeviceOwnershipChange(...args),
      rebindSession: (...args) => this.rebindSession(...args),
      flushDeferredRebindCleanups: (...args) => this.flushDeferredRebindCleanups(...args),
      persistAndPublishRebind: (...args) =>
        this.recoveryPublication.persistAndPublishRebind(...args),
      endSessionTerminallyReleasedInRow: (...args) =>
        this.activityPersistence.endSessionTerminallyReleasedInRow(...args),
      trackReleaseDrainWrite: (...args) => this.trackReleaseDrainWrite(...args),
      getSessionForDevice: (...args) => this.getSessionForDevice(...args),
      trackPendingTeardownCleanup: (...args) => this.trackPendingTeardownCleanup(...args),
      registerPendingDeviceCleanup: (...args) => this.registerPendingDeviceCleanup(...args),
      isCurrentSession: (...args) => this.isCurrentSession(...args),
      persistSession: (...args) => this.persistSession(...args),
      awaitInFlightOwnRowWrites: (...args) =>
        this.activityPersistence.awaitInFlightOwnRowWrites(...args),
      scheduleTerminalReleaseRetry: (...args) => this.scheduleTerminalReleaseRetry(...args),
      captureReleaseRowGeneration: (...args) =>
        this.releasePersistence.captureReleaseRowGeneration(...args),
      recordPendingNonTerminalRelease: (...args) => this.recordPendingNonTerminalRelease(...args),
      retryRefusedRowWrite: (...args) => this.supersededRows.retryRefusedRowWrite(...args),
      retryNonTerminalRowAfterRelease: (...args) =>
        this.supersededRows.retryNonTerminalRowAfterRelease(...args),
      reassertSupersededLiveRow: (...args) =>
        this.supersededRows.reassertSupersededLiveRow(...args),
      restoreNonTerminalRowOverSupersededRelease: (...args) =>
        this.supersededRows.restoreNonTerminalRowOverSupersededRelease(...args),
      retryTerminalRowAfterRelease: (...args) =>
        this.supersededRows.retryTerminalRowAfterRelease(...args),
      waitOutRecreationOf: (...args) => this.supersededRows.waitOutRecreationOf(...args),
      replaceSupersededReleaseRow: (...args) =>
        this.supersededRows.replaceSupersededReleaseRow(...args),
      getLegacyLifecycleView: (...args) => this.getLegacyLifecycleView(...args),
      isAdmittedForAutomation: (...args) => this.isAdmittedForAutomation(...args),
      guardedRowRewriteOptions: (...args) => this.supersededRows.guardedRowRewriteOptions(...args),
      isRebindUnderWay: (...args) => this.supersededRows.isRebindUnderWay(...args),
      oweSupersededRowReassert: (...args) => this.supersededRows.oweSupersededRowReassert(...args),
      restoreNonTerminalRowAfterReassert: (...args) =>
        this.supersededRows.restoreNonTerminalRowAfterReassert(...args),
      reassertOwedLiveRowForActivity: (...args) =>
        this.supersededRows.reassertOwedLiveRowForActivity(...args),
      getPersistedTerminalRelease: (...args) =>
        this.persistedAdmission.getPersistedTerminalRelease(...args),
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
      upgradeReleaseReason: (...args) => this.releaseCommit.upgradeReleaseReason(...args),
      terminalReleaseAsOfNow: (...args) => this.admission.terminalReleaseAsOfNow(...args),
      findSession: (...args) => this.findSession(...args),
      updateSessionCache: (...args) => this.updateSessionCache(...args),
      getDeviceReadiness: (...args) => this.getDeviceReadiness(...args),
      invalidateAutomationReadiness: (...args) => this.invalidateAutomationReadiness(...args),
      getBiometricEnrollment: (...args) => this.getBiometricEnrollment(...args),
      getNetworkCondition: (...args) => this.getNetworkCondition(...args),
      reclaimAndRefreshExistingSession: (...args) =>
        this.admission.reclaimAndRefreshExistingSession(...args),
      recordRestartRecoveryActivity: (...args) => this.recordRestartRecoveryActivity(...args),
      getOrCreateSession: (...args) => this.getOrCreateSession(...args),
      observeSessionForRead: (...args) => this.leaseExpiry.observeSessionForRead(...args),
      unadmittedSessionError: (...args) => this.persistedAdmission.unadmittedSessionError(...args),
      terminalizeExpiredPersistedSession: (...args) =>
        this.terminalizeExpiredPersistedSession(...args),
    };
  }

  private createCollaboratorHost(): SessionManagerCollaboratorHost {
    return createSessionManagerCollaboratorHost(this.createCollaboratorActions(), {
      stateRestore: () => this.stateRestore,
      timer: () => this.timer,
      acceptingSessionCreations: () => this.acceptingSessionCreations,
      deviceSessionRepository: () => this.deviceSessionRepository,
      recoveredIntents: () => this.recoveredIntents,
      getBarrier: () => this.getBarrier?.bind(this),
      sessionSlots: () => this.sessionSlots,
      daemonSessionId: () => this.daemonSessionId,
      activeSessionExecutionChecker: () => this.activeSessionExecutionChecker?.bind(this),
      sessions: () => this.sessions,
      superseded: () => this.superseded,
      liveDaemonSessionIds: () => this.liveDaemonSessionIds?.bind(this),
      SESSION_TIMEOUT_MS: () => this.SESSION_TIMEOUT_MS,
      lateRehydrationListener: () => this.lateRehydrationListener,
      slotShadowProbe: () => this.slotShadowProbe,
      deviceHealth: () => this.deviceHealth,
      persistedRowGenerations: () => this.persistedRowGenerations,
      releaseRowGenerations: () => this.releaseRowGenerations,
      finalizedSessionReleases: () => this.finalizedSessionReleases,
      supersededRowReassertRetries: () => this.supersededRowReassertRetries,
      rowWriter: () => this.rowWriter,
      forcedStuckRelease: () => this.forcedStuckRelease,
      restartReleasePersistence: () => this.restartReleasePersistence,
      restartRecoveryActivityAt: () => this.restartRecoveryActivityAt,
      stallProbe: () => this.stallProbe?.bind(this),
      livenessOwnerCallInFlightReader: () => this.livenessOwnerCallInFlightReader,
      liveness: () => this.liveness,
      sessionExecutionDeadlineLookup: () => this.sessionExecutionDeadlineLookup?.bind(this),
      expiryReleaseExecutionCanceller: () => this.expiryReleaseExecutionCanceller?.bind(this),
      recoveryExpiryReleaseHandler: () => this.recoveryExpiryReleaseHandler,
      releaseDeviceHold: () => this.releaseDeviceHold,
      planLabels: () => this.planLabels,
      observerSessions: () => this.observerSessions,
      deviceSessionMap: () => this.deviceSessionMap,
      releaseRowSessions: () => this.releaseRowSessions,
      replacedRestoreGenerations: () => this.replacedRestoreGenerations,
      volatileTerminalReleaseIntents: () => this.volatileTerminalReleaseIntents,
      retiredCreationRows: () => this.retiredCreationRows,
      terminalReleaseJournal: () => this.terminalReleaseJournal,
      leaseExpiry: () => this.leaseExpiry,
      sessionSetupPromises: () => this.sessionSetupPromises,
      deviceCleanupQuarantine: () => this.deviceCleanupQuarantine,
      releaseCallbacks: () => this.releaseCallbacks,
      deviceOwnershipCallbacks: () => this.deviceOwnershipCallbacks,
      createdCallbacks: () => this.createdCallbacks,
      deviceUnboundCallbacks: () => this.deviceUnboundCallbacks,
      managedExecutionRecoveryListener: () => this.managedExecutionRecoveryListener?.bind(this),
      managedExecutionRecoveries: () => this.managedExecutionRecoveries,
      deferredAcquisitionCancellations: () => this.deferredAcquisitionCancellations,
      deviceAcquisitionExecutionCanceller: () =>
        this.deviceAcquisitionExecutionCanceller.bind(this),
      ownerConnectedAtReader: () => this.ownerConnectedAtReader,
      identityReplacementFences: () => this.identityReplacementFences,
      activeRestoreControllers: () => this.activeRestoreControllers,
    });
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
    retry: (entry) => this.supersededRows.retryOwedSupersededRowReassert(entry),
    retryDuringDrain: (entry) =>
      this.supersededRows.retryOwedSupersededRowReassertDuringDrain(entry),
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

  private waitForIdentityReplacement(deviceId: string, generation: number): Promise<boolean> {
    return this.restoreHealth.waitForIdentityReplacement(deviceId, generation);
  }
  private dispatchDeviceRestore(
    deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
    generation = this.replacedRestoreGenerations.get(deviceId) ?? 0,
    teardownStep?: number,
  ): Promise<void> {
    return this.recoveryPublication.dispatchDeviceRestore(
      deviceId,
      restore,
      generation,
      teardownStep,
    );
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
      removeSession: (sessionId, expectedSession) =>
        this.activityClocks.removeSession(sessionId, expectedSession),
      notifySessionRelease: (snapshot, options) =>
        this.callbacks.notifySessionRelease(snapshot, options),
      managedExecutionReleaseMarker,
      restartReleasePersistence: () => this.restartReleasePersistence,
      registerPendingDeviceCleanup: (deviceId, cleanup, capMs) =>
        this.registerPendingDeviceCleanup(deviceId, cleanup, capMs),
      persistSessionRelease: (snapshot) => this.persistSessionRelease(snapshot),
      scheduleTerminalReleaseRetry: (snapshot) => this.scheduleTerminalReleaseRetry(snapshot),
      trackReleaseDrainWrite: (write) => this.trackReleaseDrainWrite(write),
      retryNonTerminalRowAfterRelease: (snapshot) =>
        this.supersededRows.retryNonTerminalRowAfterRelease(snapshot),
      releaseRowSessions: () => this.releaseRowSessions,
      captureReleaseRowGeneration: (snapshot, generation) =>
        this.releasePersistence.captureReleaseRowGeneration(snapshot, generation),
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
  onSessionRelease(callback: SessionReleaseCallback): void {
    return this.callbacks.onSessionRelease(callback);
  }
  onDeviceOwnershipChange(
    callback: (deviceId: string, frameInvalidation: "generation-only" | "full") => void,
  ): () => void {
    return this.callbacks.onDeviceOwnershipChange(callback);
  }
  onSessionCreated(callback: SessionCreatedCallback): void {
    return this.callbacks.onSessionCreated(callback);
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
  getDeviceCleanupRetryAfterMs(deviceId: string): number {
    return this.bookkeeping.getDeviceCleanupRetryAfterMs(deviceId);
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
  hasDeviceCleanupInProgress(deviceId: string): boolean {
    return this.bookkeeping.hasDeviceCleanupInProgress(deviceId);
  }
  getIdleReleasesInProgress(): { sessionId: string; startedAtMs: number }[] {
    return this.bookkeeping.getIdleReleasesInProgress();
  }
  getNonTerminalReleasesInProgress(): {
    sessionId: string;
    startedAtMs: number;
    session: Session;
  }[] {
    return this.bookkeeping.getNonTerminalReleasesInProgress();
  }
  getTerminalReleasesInProgress(): { sessionId: string; startedAtMs: number }[] {
    return this.bookkeeping.getTerminalReleasesInProgress();
  }
  isReleaseInProgress(sessionId: string, startedAtMs: number): boolean {
    return this.bookkeeping.isReleaseInProgress(sessionId, startedAtMs);
  }
  getReleaseStuckAtMs(sessionId: string): number | undefined {
    return this.bookkeeping.getReleaseStuckAtMs(sessionId);
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
  restartMintBoundClaimLeases(ownerToken: string): void {
    return this.activityClocks.restartMintBoundClaimLeases(ownerToken);
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
  deferDeviceAcquisitionCancellation(sessionId: string): void {
    return this.callbacks.deferDeviceAcquisitionCancellation(sessionId);
  }
  settleDeviceAcquisitionCancellation(sessionId: string, committed: boolean): void {
    return this.callbacks.settleDeviceAcquisitionCancellation(sessionId, committed);
  }
  onSessionDeviceUnbound(callback: SessionDeviceUnboundCallback): void {
    return this.callbacks.onSessionDeviceUnbound(callback);
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
  createSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options: CreateSessionOptions = {},
  ): Promise<Session> {
    return this.creationGuard.createSession(sessionId, assignedDevice, platform, options);
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
  private persistAndPublishSession(
    session: Session,
    creation?: PendingSessionCreation,
    claimedRow?: ClaimedCreationRow,
    signal?: AbortSignal,
  ): Promise<Session> {
    return this.creation.persistAndPublishSession(session, creation, claimedRow, signal);
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

  /**
   * Get existing session
   */
  getSession(sessionId: string): Session | null {
    return this.expireIfDue(sessionId, false);
  }
  findSession(sessionId: string): Session | null {
    return this.admission.findSession(sessionId);
  }
  getSessionForNewExecution(
    sessionId: string,
    execution?: SessionExecutionMetadata,
  ): Session | null {
    return this.admission.getSessionForNewExecution(sessionId, execution);
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

  private releaseSessionPastIdleDeadline(sessionId: string, callerExecutionId?: string): void {
    return this.leaseExpiry.releaseSessionPastIdleDeadline(sessionId, callerExecutionId);
  }

  deviceHeldForLateRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): string | undefined {
    return this.leaseExpiry.deviceHeldForLateRead(sessionId, execution);
  }
  getOrCreateSession(
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
    return this.admission.getOrCreateSession(
      sessionId,
      devicePool,
      platform,
      execution,
      requireIssuedSession,
      accessOptions,
    );
  }

  admitIssuedSessionForAutomation(
    sessionId: string,
    execution?: SessionExecutionMetadata,
    options: { access?: SessionAccess; signal?: AbortSignal } = {},
  ): Promise<Session | undefined> {
    return this.acquisition.admitIssuedSessionForAutomation(sessionId, execution, options);
  }
  private recoverPersistedRow(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    persisted: DeviceSession | undefined,
    initialOwnership: "owned" | "awaiting-owner",
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    return this.recoveryPublication.recoverPersistedRow(
      sessionId,
      devicePool,
      platform,
      persisted,
      initialOwnership,
      shared,
    );
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

  private lateRehydrationListener?: (rehydrated: readonly string[]) => Promise<void>;

  /**
   * Notified with a session that finished rehydrating after the startup deadline (late row or
   * follow-up), so the daemon re-owns its broker binding like the startup batch (#11288).
   */
  setLateRehydrationListener(listener: (rehydrated: readonly string[]) => Promise<void>): void {
    this.lateRehydrationListener = listener;
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
  flushDeferredRebindCleanups(filter: { sessionId?: string; deviceId?: string } = {}): void {
    return this.rebinding.flushDeferredRebindCleanups(filter);
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
  getReleasedSessionReason(sessionId: string): Promise<string | undefined> {
    return this.admission.getReleasedSessionReason(sessionId);
  }
  getExpiredReleaseSnapshot(sessionId: string): Promise<SessionReleaseSnapshot | undefined> {
    return this.admission.getExpiredReleaseSnapshot(sessionId);
  }

  getTerminalReleaseSnapshot(sessionId: string): SessionReleaseSnapshot | undefined {
    const snapshot = this.sessionSlots.getTerminalSnapshot(sessionId);
    return snapshot ? { ...snapshot, heartbeat: { ...snapshot.heartbeat } } : undefined;
  }
  reserveSessionForTerminalRelease(session: Session, expectedDeviceId: string): () => void {
    return this.admission.reserveSessionForTerminalRelease(session, expectedDeviceId);
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
  trackSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    return this.bookkeeping.trackSessionSetup(session, createSetup);
  }
  drainReleasePromises(
    timeoutMs: number,
    additionalReleases: ReadonlyArray<Promise<unknown>> = [],
  ): Promise<boolean> {
    return this.bookkeeping.drainReleasePromises(timeoutMs, additionalReleases);
  }
  waitForSessionRelease(sessionId: string): Promise<void> {
    return this.bookkeeping.waitForSessionRelease(sessionId);
  }
  waitForSessionReleaseWithin(sessionId: string, timeoutMs: number): Promise<boolean> {
    return this.bookkeeping.waitForSessionReleaseWithin(sessionId, timeoutMs);
  }

  private trackPendingTeardownCleanup(deviceId: string, cleanups: readonly Promise<void>[]): void {
    this.deviceCleanupQuarantine.trackTeardown(deviceId, cleanups);
  }
  private withReleaseReason(
    snapshot: SessionReleaseSnapshot,
    releaseReason: string,
    session?: Session,
  ): SessionReleaseSnapshot {
    return this.releaseCommit.withReleaseReason(snapshot, releaseReason, session);
  }
  private persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean = false,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean> {
    return this.releaseWrite.persistSessionRelease(snapshot, retryPending, statementConditions);
  }

  private liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence = false,
    afterDelete?: () => void,
  ): void {
    return this.releasePersistence.liftTerminalFence(uuid, resolved, retainFence, afterDelete);
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
  private waitForSessionSetup(
    sessionId: string,
    setups: readonly Promise<void>[],
    phase: "release" | "rebind" = "release",
  ): Promise<{ pending: Promise<void> | null }> {
    return this.bookkeeping.waitForSessionSetup(sessionId, setups, phase);
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

  getBaseSessionOfDerivedLabel(sessionId: string): string | undefined {
    return this.planLabelsLifecycle.getBaseSessionOfDerivedLabel(sessionId);
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
  recordToolCallEnded(sessionId: string, end: { admitted: boolean } = { admitted: true }): void {
    return this.activityClocks.recordToolCallEnded(sessionId, end);
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
  private unlessBaseEnded(session: Session | null): Session | null {
    return this.admission.unlessBaseEnded(session);
  }
  terminalAnswerForEndedSession(
    sessionId: string,
    callerExecutionId?: string,
  ): TerminalSessionError | undefined {
    return this.admission.terminalAnswerForEndedSession(sessionId, callerExecutionId);
  }
  peekTerminalAnswerForEndedSession(sessionId: string): TerminalSessionError | undefined {
    return this.admission.peekTerminalAnswerForEndedSession(sessionId);
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

  ownerLeaseAwaitsReap(sessionId: string): boolean {
    return this.leaseExpiry.ownerLeaseAwaitsReap(sessionId);
  }

  judgedLeaseHeartbeat(session: Session): number {
    return this.leaseExpiry.judgedLeaseHeartbeat(session);
  }

  creditOwnerHeartbeatDuringRelease(sessionId: string, ownerToken: string): void {
    return this.leaseExpiry.creditOwnerHeartbeatDuringRelease(sessionId, ownerToken);
  }
  private refuseControlCallOnLapsedOwnerLease(
    session: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    return this.admission.refuseControlCallOnLapsedOwnerLease(
      session,
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
  startRehydratedOwnerWindows(): number {
    return this.activityClocks.startRehydratedOwnerWindows();
  }
  forgiveDaemonStall(resumedAt: number, lostMs: number, sleptMs = 0, gapBeganAt?: number): number {
    return this.activityClocks.forgiveDaemonStall(resumedAt, lostMs, sleptMs, gapBeganAt);
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
  cleanupExpiredSessions(): void {
    return this.activityClocks.cleanupExpiredSessions();
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

  private recordPersistedRowGeneration(incarnation: Session, rowGeneration: number | void): void {
    return this.activityPersistence.recordPersistedRowGeneration(incarnation, rowGeneration);
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
