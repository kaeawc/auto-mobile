import type { ReleaseRowRetry } from "./sessionRowWriter";
import type {
  ClaimedCreationRow,
  PendingSessionCreation,
  SharedSessionAssignment,
} from "./sessionManager/internalContracts";
import type { ReleaseSessionRequest } from "./releaseSessionRequest";
import type { LivenessOwnerView } from "./livenessClaimDecision";
import type {
  DeviceSessionActivityUpdate,
  UpsertActiveSessionOptions,
} from "../db/deviceSessionRepository";
import {
  SESSION_HELD_BY_RECOVERY_CODE,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
} from "../models/deviceAcquisitionRefusals";
import { SessionNoLongerOwnsDeviceError } from "../models/sessionNoLongerOwnsDevice";
import {
  SessionManagerForwarders,
  type SessionManagerForwardersHost,
} from "./sessionManager/forwarders";
import type { SessionLifecycleSlots } from "./sessionManager/internalContracts";
import { SessionManagerCleanup } from "./sessionManager/cleanup";
import { SessionManagerConfiguration } from "./sessionManager/configuration";
import { SessionQueries } from "./sessionManager/queries";
import { SessionManagerConstruction } from "./sessionManager/construction";
import { SessionManagerWiring } from "./sessionManager/wiring";
import { ENV } from "../config/env";
import { getDbWriteBarrier, type DbWriteBarrier } from "../db/dbWriteBarrier";
import {
  DeviceSessionRepository,
  type DeviceSessionPersistence,
  type MarkReleasedOptions,
} from "../db/deviceSessionRepository";
import type { DeviceSession } from "../db/types";
import {
  SCREEN_READER_RESTORE_TIMEOUT_MS,
  type ScreenReaderRestoreState,
} from "../features/accessibility/ScreenReaderRestore";
import { type RotationRestoreState } from "../features/action/Rotate";
import { type DeviceClockRestoreState } from "../features/utility/DeviceClock";
import {
  type BiometricEnrollment,
  type NetworkConditionProfile,
} from "../features/utility/DeviceState";
import { type BootedDevice, type Platform } from "../models";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../models/managedExecutionLiveness";
import type { ObserveResult } from "../models/ObserveResult";
import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { readEnvPositiveInteger } from "../utils/envNumbers";
import {
  type KeepScreenAwakeRestoreOutcome,
  type KeepScreenAwakeState,
} from "../utils/KeepScreenAwakeManager";
import { logger } from "../utils/logger";
import type { TimingData } from "../utils/PerformanceTracker";
import { defaultTimer, SteadyWallClock, type Timer } from "../utils/SystemTimer";
import { type DeferredRebindCleanup } from "./acquisitionReceipt";
import { SESSION_RELEASE_DRAIN_TIMEOUT_MS } from "./constants";
import { DeviceCleanupQuarantine } from "./deviceCleanupQuarantine";
import type { DeviceHealthReason } from "./deviceHealthMarkers";
import { type IosAppNetworkRuleRestorer } from "./iosAppNetworkLease";
import { NoopTerminalReleaseJournal } from "./NoopTerminalReleaseJournal";
import { PlanLabelRegistry } from "./planLabelRegistry";
import { type DeviceReadinessLevel } from "./readiness/DeviceReadiness";
import { SessionReleasePersistTimeoutError } from "./releaseErrors";
import { type SessionReleaseReason } from "./releaseReasons";
import { onSessionClock } from "./sessionClockPersistence";
import {
  SessionDeviceStateRestore,
  type IosAppNetworkRuleSessionState,
} from "./sessionDeviceStateRestore";
import { SessionLivenessController } from "./sessionLivenessLease";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  getSessionHeartbeatCheckIntervalMs,
  getSessionIdleTimeoutMs,
} from "./sessionLivenessWindows";
import { ForcedStuckRelease } from "./sessionManager/forcedStuckRelease";
import {
  type PendingSessionRelease,
  type RecoveryAssignmentWait,
  type ReleaseReasonState,
  type SessionClockExecution,
} from "./sessionManager/internalContracts";
import { RecoveredTerminalReleaseIntents } from "./sessionManager/recoveredTerminalReleaseIntents";
import { DeviceRestoreHealth } from "./sessionManager/restoreHealth";
import { SessionReleasedDuringCallError } from "./sessionReleasedDuringCall";
import { SerializedSessionRowWriter, type SessionRowWriter } from "./sessionRowWriter";
import { SessionSlots } from "./sessionSlots";
import { SessionSlotShadowProbe, type SlotShadowProbeMode } from "./sessionSlotShadowProbe";
import type {
  OwedSupersededRowReassertCallbacks,
  SupersededRowReasserts,
} from "./supersededRowReasserts";
import { type TerminalReleaseJournal } from "./terminalReleaseJournal";

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

export class SessionManager extends SessionManagerForwarders {
  protected readonly forwardersHost = this.createForwardersHost();
  private createForwardersHost(): SessionManagerForwardersHost {
    const manager = this;
    return {
      get rowWriter() {
        return manager.rowWriter;
      },
      get configuration() {
        return manager.configuration;
      },
      get recoveredIntents() {
        return manager.recoveredIntents;
      },
      get restoreHealth() {
        return manager.wiring.restoreHealth;
      },
      get sessionClock() {
        return manager.sessionClock;
      },
      get callbacks() {
        return manager.wiring.callbacks;
      },
      get deviceCleanupQuarantine() {
        return manager.deviceCleanupQuarantine;
      },
      get bookkeeping() {
        return manager.wiring.bookkeeping;
      },
      get forcedStuckRelease() {
        return manager.forcedStuckRelease;
      },
      get activityClocks() {
        return manager.wiring.activityClocks;
      },
      get creationGuard() {
        return manager.wiring.creationGuard;
      },
      get persistedAdmission() {
        return manager.wiring.persistedAdmission;
      },
      get admission() {
        return manager.wiring.admission;
      },
      get leaseExpiry() {
        return manager.wiring.leaseExpiry;
      },
      get acquisition() {
        return manager.wiring.acquisition;
      },
      get rehydration() {
        return manager.wiring.rehydration;
      },
      get rebinding() {
        return manager.wiring.rebinding;
      },
      get queries() {
        return manager.queries;
      },
      get slotShadowProbe() {
        return manager.slotShadowProbe;
      },
      get releaseRequests() {
        return manager.wiring.releaseRequests;
      },
      get stateRestore() {
        return manager.stateRestore;
      },
      get cache() {
        return manager.wiring.cache;
      },
      get planLabelsLifecycle() {
        return manager.wiring.planLabelsLifecycle;
      },
      get liveness() {
        return manager.liveness;
      },
      get cleanup() {
        return manager.cleanup;
      },
    };
  }
  private waitOutRebindOf(session: Session): Promise<void> {
    return this.wiring.supersededRows.waitOutRebindOf(session);
  }

  private waitOutReleaseOf(sessionId: string): Promise<void> {
    return this.wiring.supersededRows.waitOutReleaseOf(sessionId);
  }

  private waitOutRecreationOf(sessionId: string): Promise<void> {
    return this.wiring.supersededRows.waitOutRecreationOf(sessionId);
  }
  private readonly configuration = new SessionManagerConfiguration();
  private get stallProbe() {
    return this.configuration.stallProbe;
  }
  private set stallProbe(value: SessionManagerConfiguration["stallProbe"]) {
    this.configuration.stallProbe = value;
  }
  private get daemonSessionId() {
    return this.configuration.daemonSessionId;
  }
  private set daemonSessionId(value: SessionManagerConfiguration["daemonSessionId"]) {
    this.configuration.daemonSessionId = value;
  }
  private get liveDaemonSessionIds() {
    return this.configuration.liveDaemonSessionIds;
  }
  private set liveDaemonSessionIds(value: SessionManagerConfiguration["liveDaemonSessionIds"]) {
    this.configuration.liveDaemonSessionIds = value;
  }
  private get acceptingSessionCreations() {
    return this.configuration.acceptingSessionCreations;
  }
  private set acceptingSessionCreations(
    value: SessionManagerConfiguration["acceptingSessionCreations"],
  ) {
    this.configuration.acceptingSessionCreations = value;
  }
  private get observerSessions() {
    return this.configuration.observerSessions;
  }
  private set observerSessions(value: SessionManagerConfiguration["observerSessions"]) {
    this.configuration.observerSessions = value;
  }
  private get activeSessionExecutionChecker() {
    return this.configuration.activeSessionExecutionChecker;
  }
  private set activeSessionExecutionChecker(
    value: SessionManagerConfiguration["activeSessionExecutionChecker"],
  ) {
    this.configuration.activeSessionExecutionChecker = value;
  }
  private get livenessOwnerCallInFlightReader() {
    return this.configuration.livenessOwnerCallInFlightReader;
  }
  private set livenessOwnerCallInFlightReader(
    value: SessionManagerConfiguration["livenessOwnerCallInFlightReader"],
  ) {
    this.configuration.livenessOwnerCallInFlightReader = value;
  }
  private get ownerConnectedAtReader() {
    return this.configuration.ownerConnectedAtReader;
  }
  private set ownerConnectedAtReader(value: SessionManagerConfiguration["ownerConnectedAtReader"]) {
    this.configuration.ownerConnectedAtReader = value;
  }
  private get sessionExecutionDeadlineLookup() {
    return this.configuration.sessionExecutionDeadlineLookup;
  }
  private set sessionExecutionDeadlineLookup(
    value: SessionManagerConfiguration["sessionExecutionDeadlineLookup"],
  ) {
    this.configuration.sessionExecutionDeadlineLookup = value;
  }
  private get expiryReleaseExecutionCanceller() {
    return this.configuration.expiryReleaseExecutionCanceller;
  }
  private set expiryReleaseExecutionCanceller(
    value: SessionManagerConfiguration["expiryReleaseExecutionCanceller"],
  ) {
    this.configuration.expiryReleaseExecutionCanceller = value;
  }
  private get deviceAcquisitionExecutionCanceller() {
    return this.configuration.deviceAcquisitionExecutionCanceller;
  }
  private set deviceAcquisitionExecutionCanceller(
    value: SessionManagerConfiguration["deviceAcquisitionExecutionCanceller"],
  ) {
    this.configuration.deviceAcquisitionExecutionCanceller = value;
  }
  private get recoveryExpiryReleaseHandler() {
    return this.configuration.recoveryExpiryReleaseHandler;
  }
  private set recoveryExpiryReleaseHandler(
    value: SessionManagerConfiguration["recoveryExpiryReleaseHandler"],
  ) {
    this.configuration.recoveryExpiryReleaseHandler = value;
  }
  private get managedExecutionRecoveryListener() {
    return this.configuration.managedExecutionRecoveryListener;
  }
  private set managedExecutionRecoveryListener(
    value: SessionManagerConfiguration["managedExecutionRecoveryListener"],
  ) {
    this.configuration.managedExecutionRecoveryListener = value;
  }
  private get lateRehydrationListener() {
    return this.configuration.lateRehydrationListener;
  }
  private set lateRehydrationListener(
    value: SessionManagerConfiguration["lateRehydrationListener"],
  ) {
    this.configuration.lateRehydrationListener = value;
  }
  private get releaseDeviceHold() {
    return this.configuration.releaseDeviceHold;
  }
  private set releaseDeviceHold(value: SessionManagerConfiguration["releaseDeviceHold"]) {
    this.configuration.releaseDeviceHold = value;
  }
  private readonly wiring = this.createCollaboratorHost();
  private readonly queries = new SessionQueries(this.wiring.host, {
    getAllSessions: () => this.getAllSessions(),
    getAssignedDevices: () => this.getAssignedDevices(),
  });
  private readonly cleanup = this.createCleanup();
  private createCleanup(): SessionManagerCleanup {
    const manager = this;
    return new SessionManagerCleanup(this.wiring.host, {
      get CLEANUP_INTERVAL_MS() {
        return manager.CLEANUP_INTERVAL_MS;
      },
      cleanupExpiredSessions: () => this.cleanupExpiredSessions(),
      get rehydrationFollowUpTimer() {
        return manager.rehydrationFollowUpTimer;
      },
      set rehydrationFollowUpTimer(value) {
        manager.rehydrationFollowUpTimer = value;
      },
    });
  }

  private createCollaboratorHost(): SessionManagerWiring {
    const dependencies = {
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
      leaseExpiry: () => this.wiring.leaseExpiry,
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
    };
    const wiring = new SessionManagerWiring(
      {
        expireIfDue: (...args) => this.expireIfDue(...args),
        finishReleaseForcedBeforeStart: (...args) => this.finishReleaseForcedBeforeStart(...args),
        liftTerminalFence: (...args) => this.liftTerminalFence(...args),
        retireRestorations: (...args) => this.retireRestorations(...args),
        withReleaseReason: (...args) => this.withReleaseReason(...args),
        persistAndPublishSession: (...args) => this.persistAndPublishSession(...args),
        isSessionExpired: (...args) => this.isSessionExpired(...args),
        recordSessionActivity: (...args) => this.recordSessionActivity(...args),
        getSessionForNewExecution: (...args) => this.getSessionForNewExecution(...args),
        refuseControlCallOnLapsedOwnerLease: (...args) =>
          this.refuseControlCallOnLapsedOwnerLease(...args),
        peekTerminalAnswerForEndedSession: (...args) =>
          this.peekTerminalAnswerForEndedSession(...args),
        releaseSessionPastIdleDeadline: (...args) => this.releaseSessionPastIdleDeadline(...args),
        liveBaseOfDerivedId: (...args) => this.liveBaseOfDerivedId(...args),
        retryPendingTerminalReleasesNow: (...args) => this.retryPendingTerminalReleasesNow(...args),
        getPendingDeviceCleanup: (...args) => this.getPendingDeviceCleanup(...args),
        armPendingDeviceCleanupCaps: (...args) => this.armPendingDeviceCleanupCaps(...args),
        cancelExecutionsOverriddenByExpiry: (...args) =>
          this.cancelExecutionsOverriddenByExpiry(...args),
        getSession: (...args) => this.getSession(...args),
        getTerminalReleaseSnapshot: (...args) => this.getTerminalReleaseSnapshot(...args),
        waitForSessionSetup: (...args) => this.waitForSessionSetup(...args),
        restoreIncarnationIsCurrent: (...args) => this.restoreIncarnationIsCurrent(...args),
        waitForIdentityReplacement: (...args) => this.waitForIdentityReplacement(...args),
        isTerminalReleaseRetryCurrent: (...args) => this.isTerminalReleaseRetryCurrent(...args),
        retryTerminalReleaseWrite: (...args) => this.retryTerminalReleaseWrite(...args),
        dispatchDeviceRestore: (...args) => this.dispatchDeviceRestore(...args),
        sessionNow: (...args) => this.sessionNow(...args),
        isSessionBeingRecreated: (...args) => this.isSessionBeingRecreated(...args),
        sessionClockToWall: (...args) => this.sessionClockToWall(...args),
        persistSessionRelease: (...args) => this.persistSessionRelease(...args),
        recoverPersistedRow: (...args) => this.recoverPersistedRow(...args),
        recoveredRowOwner: (...args) => this.recoveredRowOwner(...args),
        recoveryLivenessFromPersisted: (...args) => this.recoveryLivenessFromPersisted(...args),
        applyRecoveredTerminalReleaseIntents: (...args) =>
          this.applyRecoveredTerminalReleaseIntents(...args),
        createSession: (...args) => this.createSession(...args),
        rebindSession: (...args) => this.rebindSession(...args),
        flushDeferredRebindCleanups: (...args) => this.flushDeferredRebindCleanups(...args),
        trackReleaseDrainWrite: (...args) => this.trackReleaseDrainWrite(...args),
        getSessionForDevice: (...args) => this.getSessionForDevice(...args),
        trackPendingTeardownCleanup: (...args) => this.trackPendingTeardownCleanup(...args),
        registerPendingDeviceCleanup: (...args) => this.registerPendingDeviceCleanup(...args),
        isCurrentSession: (...args) => this.isCurrentSession(...args),
        persistSession: (...args) => this.persistSession(...args),
        scheduleTerminalReleaseRetry: (...args) => this.scheduleTerminalReleaseRetry(...args),
        recordPendingNonTerminalRelease: (...args) => this.recordPendingNonTerminalRelease(...args),
        getLegacyLifecycleView: (...args) => this.getLegacyLifecycleView(...args),
        isAdmittedForAutomation: (...args) => this.isAdmittedForAutomation(...args),
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
        findSession: (...args) => this.findSession(...args),
        updateSessionCache: (...args) => this.updateSessionCache(...args),
        getDeviceReadiness: (...args) => this.getDeviceReadiness(...args),
        invalidateAutomationReadiness: (...args) => this.invalidateAutomationReadiness(...args),
        getBiometricEnrollment: (...args) => this.getBiometricEnrollment(...args),
        getNetworkCondition: (...args) => this.getNetworkCondition(...args),
        recordRestartRecoveryActivity: (...args) => this.recordRestartRecoveryActivity(...args),
        getOrCreateSession: (...args) => this.getOrCreateSession(...args),
        terminalizeExpiredPersistedSession: (...args) =>
          this.terminalizeExpiredPersistedSession(...args),
      },
      dependencies,
    );
    return wiring;
  }
  private sessions: Map<string, Session> = new Map();
  private deviceSessionMap: Map<string, string> = new Map();
  private get rehydrationFollowUpTimer(): NodeJS.Timeout | null {
    return this.wiring.rehydration.rehydrationFollowUpTimer;
  }
  private set rehydrationFollowUpTimer(value: NodeJS.Timeout | null) {
    this.wiring.rehydration.rehydrationFollowUpTimer = value;
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
  /** Finalized release state retained only while its exact Session identity is referenced. */
  private readonly finalizedSessionReleases: WeakMap<Session, ReleaseReasonState> = new WeakMap();
  /** The liveness owner lease and policy changes; its claim mutex serializes one session incarnation (#11797). */
  private readonly liveness: SessionLivenessController;
  private readonly recoveredIntents: RecoveredTerminalReleaseIntents;
  private readonly forcedStuckRelease: ForcedStuckRelease;
  private get persistedRowGenerations(): WeakMap<Session, number> {
    return this.wiring.activityPersistence.persistedRowGenerations;
  }

  private get retiredCreationRows(): WeakSet<Session> {
    return this.wiring.creation.retiredCreationRows;
  }

  private get releaseRowGenerations(): WeakMap<SessionReleaseSnapshot, number> {
    return this.wiring.releasePersistence.releaseRowGenerations;
  }

  private get releaseRowSessions(): WeakMap<SessionReleaseSnapshot, WeakRef<Session>> {
    return this.wiring.releasePersistence.releaseRowSessions;
  }

  /** Setup work that can modify device state after a session has been assigned. */
  private readonly sessionSetupPromises: Set<{ session: Session; promise: Promise<void> }> =
    new Set();
  /**
   * Device work that outlived its bounded release phase. The pool keeps the device assigned until
   * this settles, so no replacement session can race a late setup or keep-awake restore.
   */
  private readonly deviceCleanupQuarantine: DeviceCleanupQuarantine;
  private readonly sessionSlots: SessionLifecycleSlots = new SessionSlots({
    rowPending: { pending: (uuid) => this.rowWriter.pending(uuid) },
    onFinalizedIdentityCollected: (uuid) => this.slotShadowProbe.transitionGuard.forget(uuid),
  });
  private get restartRecoveryActivityAt(): Map<string, number> {
    return this.wiring.persistedAdmission.restartRecoveryActivityAt;
  }

  /** Row policy of an owed superseded-row rewrite; the writer's ledger schedules it (#11799). */
  private readonly supersededRowReassertRetries: OwedSupersededRowReassertCallbacks = {
    retry: (entry) => this.wiring.supersededRows.retryOwedSupersededRowReassert(entry),
    retryDuringDrain: (entry) =>
      this.wiring.supersededRows.retryOwedSupersededRowReassertDuringDrain(entry),
  };
  private deviceSessionRepository: DeviceSessionPersistence;
  private readonly getBarrier: () => DbWriteBarrier;
  private readonly stateRestore: SessionDeviceStateRestore;

  /** Retry delays for a live row's rewrite over its superseded release's terminal row (#11557). */
  setSupersededRowReassertBackoff(backoff: BackoffPolicy): void {
    this.superseded.setBackoff(backoff);
  }

  /** Superseded-row rewrite state, held by the row writer (#11799 W3). */
  private get superseded(): SupersededRowReasserts {
    return this.rowWriter.superseded;
  }

  private recoveredRowOwner(): string | null {
    return this.configuration.recoveredRowOwner();
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
  private get deviceHealth() {
    return this.wiring.restoreHealth.deviceHealth;
  }
  private set deviceHealth(value: DeviceRestoreHealth["deviceHealth"]) {
    this.wiring.restoreHealth.deviceHealth = value;
  }

  private get identityReplacementFences() {
    return this.wiring.restoreHealth.identityReplacementFences;
  }

  private get replacedRestoreGenerations(): Map<string, number> {
    return this.wiring.restoreHealth.replacedRestoreGenerations;
  }

  private get activeRestoreControllers(): Map<string, Set<AbortController>> {
    return this.wiring.restoreHealth.activeRestoreControllers;
  }

  private waitForIdentityReplacement(deviceId: string, generation: number): Promise<boolean> {
    return this.wiring.restoreHealth.waitForIdentityReplacement(deviceId, generation);
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
    return this.wiring.recoveryPublication.dispatchDeviceRestore(
      deviceId,
      restore,
      generation,
      teardownStep,
    );
  }

  private restoreIncarnationIsCurrent(target: {
    deviceId: string;
    incarnation?: number;
    restoreGeneration?: number;
  }): boolean {
    return this.wiring.restoreHealth.restoreIncarnationIsCurrent(target);
  }

  private clearRestoreHealth(
    target: { deviceId: string; incarnation?: number },
    reason: DeviceHealthReason,
  ): void {
    return this.wiring.restoreHealth.clearRestoreHealth(target, reason);
  }

  private abandonRestore(
    target: { deviceId: string; incarnation?: number },
    reason: Exclude<DeviceHealthReason, "clock">,
    restore: () => Promise<void>,
    restoreTimeoutMs: number = NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  ): void {
    return this.wiring.restoreHealth.abandonRestore(target, reason, restore, restoreTimeoutMs);
  }
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
    super();

    const construction = new SessionManagerConstruction(this.wiring.host, {
      trackSessionSetup: (...args) => this.trackSessionSetup(...args),
      clearRestoreHealth: (...args) => this.clearRestoreHealth(...args),
      abandonRestore: (...args) => this.abandonRestore(...args),
      trackPendingDeviceCleanup: (...args) => this.trackPendingDeviceCleanup(...args),
      livenessOwnerView: (...args) => this.livenessOwnerView(...args),
      hasUnissuedActivity: (...args) => this.hasUnissuedActivity(...args),
      getBarrier: () => this.getBarrier(),
      setJournal: (journal) => {
        this.terminalReleaseJournal = journal;
      },
    });

    this.timer = timer;
    this.sessionClock = new SteadyWallClock(timer);
    this.deviceCleanupQuarantine = construction.createDeviceCleanupQuarantine(timer);
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

    this.stateRestore = construction.createStateRestore(timer, options);
    this.recoveredIntents = construction.createRecoveredIntents(timer);
    this.forcedStuckRelease = construction.createForcedStuckRelease(timer);
    this.liveness = construction.createLiveness();

    // Start periodic cleanup of expired sessions
    this.startCleanupTimer();
  }

  /** Inject before creating sessions or scheduling release writes. */
  setRowWriter(writer: SessionRowWriter): void {
    this.rowWriter = writer;
  }

  /** Reuse the injected Timer for fake-clock readiness, retry and backoff waits (#7541). */
  getTimer(): Timer {
    return this.timer;
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
   * A wall-clock epoch ms instant (a persisted stamp, another process's report) on the session
   * clock: the inverse of {@link sessionClockToWall} (#11162).
   */
  wallToSessionClock(wallMs: number): number {
    return this.sessionNow() + (wallMs - this.timer.now());
  }

  /** Wait for the device work that outlived release, without blocking shutdown indefinitely. */
  async drainPendingDeviceCleanups(timeoutMs: number): Promise<boolean> {
    this.flushDeferredRebindCleanups();
    return await this.deviceCleanupQuarantine.drain(timeoutMs);
  }

  private armPendingDeviceCleanupCaps(deviceId: string): void {
    this.deviceCleanupQuarantine.armCaps(deviceId);
  }

  /**
   * A release forced while it waited to start (#10963): the device may already belong to the next
   * owner, so no teardown may touch it. The force itself persists the fence it raised (#11058).
   */
  private async finishReleaseForcedBeforeStart(session: Session): Promise<null> {
    this.sessionSlots.unmarkReleasing(session);
    return null;
  }
  private readonly managedExecutionRecoveries = new Map<string, PromiseWithResolvers<void>>();

  private persistAndPublishSession(
    session: Session,
    creation?: PendingSessionCreation,
    claimedRow?: ClaimedCreationRow,
    signal?: AbortSignal,
  ): Promise<Session> {
    return this.wiring.creation.persistAndPublishSession(session, creation, claimedRow, signal);
  }

  private recordRestartRecoveryActivity(sessionId: string): void {
    return this.wiring.persistedAdmission.recordRestartRecoveryActivity(sessionId);
  }

  private terminalizeExpiredPersistedSession(
    persisted: DeviceSession | undefined,
    onlyIfOwnedByDaemon?: string,
  ): Promise<DeviceSession | undefined> {
    return this.wiring.persistedAdmission.terminalizeExpiredPersistedSession(
      persisted,
      onlyIfOwnedByDaemon,
    );
  }

  /**
   * Get existing session
   */
  getSession(sessionId: string): Session | null {
    return this.expireIfDue(sessionId, false);
  }
  private expireIfDue(
    sessionId: string,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
    releaseExpired = true,
  ): Session | null {
    return this.wiring.leaseExpiry.expireIfDue(
      sessionId,
      expireDespiteActiveExecution,
      execution,
      releaseExpired,
    );
  }

  private releaseSessionPastIdleDeadline(sessionId: string, callerExecutionId?: string): void {
    return this.wiring.leaseExpiry.releaseSessionPastIdleDeadline(sessionId, callerExecutionId);
  }
  private recoverPersistedRow(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    persisted: DeviceSession | undefined,
    initialOwnership: "owned" | "awaiting-owner",
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    return this.wiring.recoveryPublication.recoverPersistedRow(
      sessionId,
      devicePool,
      platform,
      persisted,
      initialOwnership,
      shared,
    );
  }

  private reserveDevicesForRehydration(
    persistedSessions: readonly DeviceSession[],
    devicePool: SessionDeviceAssigner,
    deadlineAt: number,
  ): Promise<void> {
    return this.wiring.rehydration.reserveDevicesForRehydration(
      persistedSessions,
      devicePool,
      deadlineAt,
    );
  }

  private releaseRehydrationReservation(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
  ): void {
    return this.wiring.rehydration.releaseRehydrationReservation(sessionId, devicePool);
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

  private releaseSessionForReason(
    sessionId: string,
    releaseReason: string,
    request: ReleaseSessionRequest = {},
  ): Promise<string | null> {
    return this.wiring.releaseRequests.releaseSessionForReason(sessionId, releaseReason, request);
  }

  private trackPendingTeardownCleanup(deviceId: string, cleanups: readonly Promise<void>[]): void {
    this.deviceCleanupQuarantine.trackTeardown(deviceId, cleanups);
  }
  private withReleaseReason(
    snapshot: SessionReleaseSnapshot,
    releaseReason: string,
    session?: Session,
  ): SessionReleaseSnapshot {
    return this.wiring.releaseCommit.withReleaseReason(snapshot, releaseReason, session);
  }
  private persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean = false,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean> {
    return this.wiring.releaseWrite.persistSessionRelease(
      snapshot,
      retryPending,
      statementConditions,
    );
  }

  private liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence = false,
    afterDelete?: () => void,
  ): void {
    return this.wiring.releasePersistence.liftTerminalFence(
      uuid,
      resolved,
      retainFence,
      afterDelete,
    );
  }

  private scheduleTerminalReleaseRetry(snapshot: SessionReleaseSnapshot): void {
    return this.wiring.releasePersistence.scheduleTerminalReleaseRetry(snapshot);
  }

  private trackReleaseDrainWrite(write: Promise<void>): void {
    return this.wiring.releasePersistence.trackReleaseDrainWrite(write);
  }

  private isTerminalReleaseRetryCurrent(snapshot: SessionReleaseSnapshot): boolean {
    return this.wiring.releasePersistence.isTerminalReleaseRetryCurrent(snapshot);
  }

  private retryTerminalReleaseWrite(entry: ReleaseRowRetry): Promise<void> {
    return this.wiring.releasePersistence.retryTerminalReleaseWrite(entry);
  }

  private retriedReleaseWritePrecondition(
    snapshot: SessionReleaseSnapshot,
  ): Promise<MarkReleasedOptions> {
    return this.wiring.releasePersistence.retriedReleaseWritePrecondition(snapshot);
  }

  private retryPendingTerminalReleasesNow(): Promise<void>[] {
    return this.wiring.releasePersistence.retryPendingTerminalReleasesNow();
  }

  private isSessionBeingRecreated(sessionId: string): boolean {
    return this.wiring.releasePersistence.isSessionBeingRecreated(sessionId);
  }

  private recordPendingNonTerminalRelease(snapshot: SessionReleaseSnapshot): void {
    return this.wiring.releasePersistence.recordPendingNonTerminalRelease(snapshot);
  }
  private waitForSessionSetup(
    sessionId: string,
    setups: readonly Promise<void>[],
    phase: "release" | "rebind" = "release",
  ): Promise<{ pending: Promise<void> | null }> {
    return this.wiring.bookkeeping.waitForSessionSetup(sessionId, setups, phase);
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

  private trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<unknown>[]): void {
    this.deviceCleanupQuarantine.track(deviceId, cleanups);
  }
  updateSessionCache(sessionId: string, updates: Partial<SessionCacheData>): void {
    return this.wiring.cache.updateSessionCache(sessionId, updates);
  }

  setLastHierarchy(sessionId: string, hierarchy: ViewHierarchyResult): void {
    return this.wiring.cache.setLastHierarchy(sessionId, hierarchy);
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

  invalidateAutomationReadinessForDevice(deviceId: string, reason: string): void {
    return this.wiring.cache.invalidateAutomationReadinessForDevice(deviceId, reason);
  }

  resetDeviceReadinessForDevice(deviceId: string): void {
    return this.wiring.cache.resetDeviceReadinessForDevice(deviceId);
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

  private liveBaseOfDerivedId(sessionId: string): string | undefined {
    return this.wiring.planLabelsLifecycle.liveBaseOfDerivedId(sessionId);
  }

  getSessionCache(sessionId: string): SessionCacheData | null {
    return this.wiring.cache.getSessionCache(sessionId);
  }

  /**
   * The live session under `sessionId` for a lookup that only judges: unlike {@link getSession},
   * an expired session the scan has not reached is reported gone and is not released here.
   */
  peekSession(sessionId: string): Session | null {
    return this.unlessBaseEnded(this.expireIfDue(sessionId, false, undefined, false));
  }
  private unlessBaseEnded(session: Session | null): Session | null {
    return this.wiring.admission.unlessBaseEnded(session);
  }

  private livenessOwnerView(session: Session): LivenessOwnerView {
    return this.wiring.leaseExpiry.livenessOwnerView(session);
  }
  private refuseControlCallOnLapsedOwnerLease(
    session: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    return this.wiring.admission.refuseControlCallOnLapsedOwnerLease(
      session,
      access,
      execution,
      unnamedCallerExecutionId,
    );
  }

  private isSessionExpired(session: Session): boolean {
    return this.wiring.leaseExpiry.isSessionExpired(session);
  }

  private cancelExecutionsOverriddenByExpiry(
    session: Session,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    return this.wiring.leaseExpiry.cancelExecutionsOverriddenByExpiry(
      session,
      releaseReason,
      excludeExecutionId,
    );
  }

  private isSessionExpiredForNewExecution(
    session: Session,
    execution?: SessionClockExecution,
  ): boolean {
    return this.wiring.leaseExpiry.isSessionExpiredForNewExecution(session, execution);
  }

  private isLateExecutionWhileEarlierWorkIsActive(
    session: Session,
    execution: SessionClockExecution | undefined,
    hold: "any" | "timely-control" | "recovery" = "any",
  ): boolean {
    return this.wiring.leaseExpiry.isLateExecutionWhileEarlierWorkIsActive(
      session,
      execution,
      hold,
    );
  }
  private startCleanupTimer(): void {
    this.cleanup.startCleanupTimer();
  }

  /**
   * Stop cleanup timer (called on daemon shutdown)
   */
  /** @internal Typed view of private state for unit tests; not part of the public API. */
  get testHooks() {
    return { sessions: this.sessions } as const;
  }

  private persistSession(
    session: Session,
    incarnation: Session,
    upsertOptions?: UpsertActiveSessionOptions,
    upsertSettled?: () => void,
  ): Promise<void> {
    return this.wiring.activityPersistence.persistSession(
      session,
      incarnation,
      upsertOptions,
      upsertSettled,
    );
  }

  private recordPersistedRowGeneration(incarnation: Session, rowGeneration: number | void): void {
    return this.wiring.activityPersistence.recordPersistedRowGeneration(incarnation, rowGeneration);
  }

  protected recoveryLivenessFromPersisted(persisted: DeviceSession): SessionRecoveryLiveness {
    return this.wiring.recovery.recoveryLivenessFromPersisted(persisted);
  }

  private recordSessionActivity(session: Session): Promise<void> {
    return this.wiring.activityPersistence.recordSessionActivity(session);
  }

  private persistSessionActivity(
    session: Session,
    update: DeviceSessionActivityUpdate,
  ): Promise<void> {
    return this.wiring.activityPersistence.persistSessionActivity(session, update);
  }

  private hasUnissuedActivity(session: Session): boolean {
    return this.wiring.activityPersistence.hasUnissuedActivity(session);
  }
  recordHeartbeat(sessionId: string): void {
    this.liveness.recordHeartbeat(sessionId);
  }

  claimLivenessOwnership(sessionId: string, ownerToken: string): Promise<LivenessClaimOutcome> {
    return this.liveness.claimLivenessOwnership(sessionId, ownerToken);
  }

  releaseLivenessOwnership(sessionId: string, ownerToken: string): Promise<LivenessReleaseOutcome> {
    return this.liveness.releaseLivenessOwnership(sessionId, ownerToken);
  }

  hasLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return this.liveness.hasLivenessOwnership(sessionId, ownerToken);
  }

  claimUnownedLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return this.liveness.claimUnownedLivenessOwnership(sessionId, ownerToken);
  }

  bindAcquiredLivenessOwnerToken(sessionId: string, ownerToken: string): boolean {
    return this.liveness.bindAcquiredLivenessOwnerToken(sessionId, ownerToken);
  }

  adoptCliLivenessPolicy(sessionId: string, requestedIdleTimeoutMs?: number): boolean {
    return this.liveness.adoptCliLivenessPolicy(sessionId, requestedIdleTimeoutMs);
  }

  adoptManagedExecutionLivenessPolicy(
    sessionId: string,
    options: { idleTimeoutMs?: number } = {},
  ): Promise<Session> {
    return this.liveness.adoptManagedExecutionLivenessPolicy(sessionId, options);
  }

  restoreHeartbeatLivenessPolicy(sessionId: string): boolean {
    return this.liveness.restoreHeartbeatLivenessPolicy(sessionId);
  }
}
