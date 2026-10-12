import type { DeferredRebindCleanup } from "./acquisitionReceipt";
import type { TimingData } from "../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import type { DeviceHealthMarkers, DeviceHealthReason } from "./deviceHealthMarkers";
import { Rotate, type RotationRestoreState } from "../features/action/Rotate";
import { RotationSettingManagedError } from "../models/RotationSettingManagedError";
import {
  restoreScreenReaderState,
  SCREEN_READER_RESTORE_TIMEOUT_MS,
  type ScreenReaderRestoreState,
} from "../features/accessibility/ScreenReaderRestore";
import { invalidateDisplayCaches } from "../features/observe/DisplayTransition";
import { ExecNetworkFilterBridge } from "../features/network-filter/NetworkFilterBridge";
import {
  IOS_APP_NETWORK_RULE_LEASE_MS,
  IOS_APP_NETWORK_RULE_RENEW_INTERVAL_MS,
  IosAppNetworkRuleClient,
  type IosAppNetworkRule,
  type IosAppNetworkRuleCommandContext,
} from "../features/network-filter/IosAppNetworkRuleClient";
import { IosAppNetworkLeases, type IosAppNetworkRuleRestorer } from "./iosAppNetworkLease";
import {
  AndroidDeviceClockAdapter,
  restoreDeviceClock,
  defaultDeviceClockRestoreRegistry,
  type DeviceClockRestoreState,
} from "../features/utility/DeviceClock";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import { resolveOwnershipSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import {
  decideLivenessClaim,
  mayAdoptUnownedLiveness,
  refusedClaimHoldSource,
  type LivenessOwnerView,
} from "./livenessClaimDecision";
import {
  getAbortSignal,
  runOutsideRequestContext,
  runWithAbortSignal,
} from "../utils/AbortContext";
import { requestAcquisitionReceipt } from "./acquisitionReceipt";
import { defaultTimer, SteadyWallClock, Timer } from "../utils/SystemTimer";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { logger } from "../utils/logger";
import { readEnvPositiveInteger } from "../utils/envNumbers";
import { isDeviceLossCancellationReason } from "../utils/deviceLossCancellationReason";
import { BootedDevice, Platform } from "../models";
import { KeepScreenAwakeManager, KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import {
  DeviceSessionNotActiveError,
  DeviceSessionRepository,
  DeviceSessionRowChangedError,
  DeviceSessionRowNotRewritableError,
  DeviceSessionRowNotReleasableError,
  DeviceSessionTerminallyReleasedError,
  isDeviceRestartReleaseReason,
  isRecoverableDeviceSession,
  persistedSessionExpiryReason,
  type DeviceSessionActivityUpdate,
  type DeviceSessionPersistence,
  type MarkReleasedOptions,
  type RecoverableRowIncarnation,
  type UpsertActiveSessionOptions,
} from "../db/deviceSessionRepository";
import type { DeviceSession } from "../db/types";
import { type DbWriteBarrier, getDbWriteBarrier } from "../db/dbWriteBarrier";
import { ActionableError, toActionableError } from "../models/ActionableError";
import {
  MANAGED_EXECUTION_LIVENESS_POLICY,
  clampManagedExecutionIdleTimeoutMs,
  holdsOwnerHeartbeatLease,
  resolveManagedExecutionIdleTimeoutMs,
} from "./managedExecutionLiveness";
import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import type { ObserveResult } from "../models/ObserveResult";
import {
  DeviceState,
  MAX_NETWORK_CONDITION_TTL_SECONDS,
  type BiometricEnrollment,
  type NetworkConditionProfile,
} from "../features/utility/DeviceState";
import { deviceReadinessRank, type DeviceReadinessLevel } from "../devices/DeviceSessionManager";
import {
  getCliSessionIdleTimeoutMs as resolveCliSessionIdleTimeoutMs,
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
  sanitizeCliSessionIdleTimeoutMs as sanitizeRequestedCliIdleTimeoutMs,
} from "./constants";
import { isAndroidEmulatorSerial, isAndroidTransportAddressSerial } from "../utils/androidSerial";
import { Mutex } from "async-mutex";
import { SingleFlight } from "../utils/cache/SingleFlight";
import { errorMessage } from "../utils/describeUnknownError";
import { effectiveLastToolActivity, sessionIdleDeadline } from "./sessionClocks";
import { forgivenLeaseStart, leaseRunningAt, type StallForgivingLeases } from "./stallForgiveness";
import { onSessionClock } from "./sessionClockPersistence";
import {
  judgedLeaseHeartbeat,
  hasMintBoundClaimLease,
  heartbeatLeasePastGrace,
  judgesOwnerHeartbeats,
  ownerLeaseLiveAt,
  livenessLeaseState,
  livenessOwnerHold,
  sessionOwnerLeaseSnapshot,
  sessionJudgedLeaseSnapshot,
  suspectGraceMsFor,
  type LivenessLeaseState,
  type LivenessOwnerHold,
  type LivenessOwnerLeaseSnapshot,
} from "./livenessOwnerLease";
import { isReleaseVetoedByExecutions } from "./unsettledExecutionVeto";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  getSessionIdleTimeoutMs,
} from "./sessionLivenessWindows";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import {
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
  SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE,
  SessionCreationTimeoutError,
  SessionReleasedDuringCreationError,
} from "./deviceAcquisitionRefusals";
import { SessionNoLongerOwnsDeviceError } from "./sessionNoLongerOwnsDevice";
import { DAEMON_SESSION_SUSPECT_CODE } from "./types";
import {
  isExpiryReleaseReason,
  isRecoverableDaemonReleaseReason,
  isReissuableByNameReleaseReason,
  isTerminalReleaseReason,
  outranksReleaseReason,
  IDLE_WINDOW_RELEASE_REASON,
  releasedRowStatus,
  shouldJudgeOwnerLeaseForRelease,
  type SessionReleaseReason,
} from "./releaseReasons";
import { SessionReleasedDuringCallError } from "./sessionReleasedDuringCall";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../models/deviceSessionRecovery";
import {
  NoopTerminalReleaseJournal,
  type TerminalReleaseIntent,
  type TerminalReleaseJournal,
} from "./terminalReleaseJournal";

/**
 * Device-label → session-UUID map. `buildDeviceLabelMap` assigns each configured
 * label its own session (the primary label reuses the base session UUID), so a
 * `device: "B"` tool argument can be routed to the correct label session.
 */
export type DeviceLabelMap = Record<string, string>;

/** The daemon could not durably refresh an existing session's liveness. */
export class SessionActivityPersistenceError extends ActionableError {
  constructor(sessionId: string, cause: unknown) {
    super(`Failed to persist liveness activity for session ${sessionId}.`, { cause });
    this.name = "SessionActivityPersistenceError";
  }
}

/**
 * Narrow seam for restoring keep-awake state on session release. Production uses
 * `KeepScreenAwakeManager`; tests inject a fake to assert (without a real device)
 * that `releaseSession` reads the typed `keepScreenAwake` slot and passes its full
 * payload to `restore` — the behavioral half of the #2973 typed-slot round trip.
 */
export interface KeepScreenAwakeRestorer {
  restore(state: KeepScreenAwakeState): Promise<void>;
}

/** Original simulator enrollment restored when a session releases its device. */
export interface BiometricEnrollmentSessionState {
  initialEnrollment: BiometricEnrollment;
}

/** What a pending restore must write, resolved before any await (see below). */
/** One restore a release started; `abandon` records it when the teardown cap expires first. */
interface ReleaseTeardownStage {
  pending: Promise<void> | null;
  abandon?: () => void;
}

/** Keep-awake restore resolved before any await, like the biometric target below. */
interface KeepScreenAwakeRestoreTarget {
  incarnation?: number;
  sessionId: string;
  deviceId: string;
  state: KeepScreenAwakeState;
}

interface BiometricRestoreTarget {
  incarnation?: number;
  sessionId: string;
  deviceId: string;
  enrollment: BiometricEnrollment;
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

/** The per-app rule a session owns on an iOS Simulator (#10264). */
export interface IosAppNetworkRuleSessionState {
  udid: string;
  bundleId: string;
  /** Fixed for this session binding; a later binding allocates a newer one. */
  ownerGeneration: number;
  /** The newest revision this session has sent for the target (apply or reset). */
  lastRevision: number;
  /** The revision the provider acknowledged as installed, while it is believed active. */
  installedRevision?: number;
}

/** What a pending network restore must write, resolved before any await. */
interface NetworkConditionRestoreTarget {
  incarnation?: number;
  sessionId: string;
  deviceId: string;
  profile: NetworkConditionProfile;
  /**
   * iOS Simulator: remove this exact rule, with a reset revision allocated when
   * the target was captured — newer than any apply this session sent.
   */
  iosAppRule?: IosAppNetworkRule;
}

/** Original auto-time value recorded before the first session clock write. */
export type ClockSessionState = DeviceClockRestoreState;
interface PendingClockRestore {
  state: ClockSessionState;
  removed: boolean;
  controller: AbortController;
  clear: () => void;
  result: Promise<{ pending: Promise<void> | null }>;
}

export interface ClockRestorer {
  restore(state: ClockSessionState, signal?: AbortSignal): Promise<void>;
}
/** Original rotation settings recorded before the first session settings write. */
export type RotationSessionState = RotationRestoreState;
interface PendingRotationRestore {
  state: RotationSessionState;
  removed: boolean;
  controller: AbortController;
  clear: () => void;
  result: Promise<{ pending: Promise<void> | null }>;
}

export interface RotationRestorer {
  restore(state: RotationSessionState, signal?: AbortSignal): Promise<void>;
}
/** TalkBack/VoiceOver state recorded before the first `accessibility` toggle in a session (#10146). */
export type ScreenReaderSessionState = ScreenReaderRestoreState;
interface PendingScreenReaderRestore {
  state: ScreenReaderSessionState;
  removed: boolean;
  controller: AbortController;
  clear: () => void;
  result: Promise<{ pending: Promise<void> | null }>;
}

export interface ScreenReaderRestorer {
  restore(state: ScreenReaderSessionState, signal?: AbortSignal): Promise<void>;
}
export interface DeviceStateRestorerFactories {
  networkCondition: (device: BootedDevice) => NetworkConditionRestorer;
  clock: (device: BootedDevice) => ClockRestorer;
  rotation?: (device: BootedDevice) => RotationRestorer;
  /** Delay before each rotation restore retry; defaults to a short exponential backoff. */
  rotationBackoff?: BackoffPolicy;
  screenReader?: (device: BootedDevice) => ScreenReaderRestorer;
  /** Delay before each screen-reader restore retry; defaults to a short exponential backoff. */
  screenReaderBackoff?: BackoffPolicy;
  /** iOS Simulator per-app network rules (#10264); defaults to the installed controller. */
  iosAppNetworkRule?: IosAppNetworkRuleRestorer;
}

/** The injected screen-reader restorer, else the real TalkBack/VoiceOver one. */
function screenReaderRestorerFactoryFrom(
  factories: ((device: BootedDevice) => NetworkConditionRestorer) | DeviceStateRestorerFactories,
): (device: BootedDevice) => ScreenReaderRestorer {
  const injected = typeof factories === "function" ? undefined : factories.screenReader;
  return (
    injected ??
    ((device) => ({
      restore: (state, signal) => restoreScreenReaderState(device, state, signal),
    }))
  );
}

function rotationBackoffFrom(
  factories: ((device: BootedDevice) => NetworkConditionRestorer) | DeviceStateRestorerFactories,
): BackoffPolicy {
  return (
    (typeof factories === "function" ? undefined : factories.rotationBackoff) ??
    DEFAULT_ROTATION_RESTORE_BACKOFF
  );
}

function screenReaderBackoffFrom(
  factories: ((device: BootedDevice) => NetworkConditionRestorer) | DeviceStateRestorerFactories,
): BackoffPolicy {
  return (
    (typeof factories === "function" ? undefined : factories.screenReaderBackoff) ??
    DEFAULT_SCREEN_READER_RESTORE_BACKOFF
  );
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

/**
 * Re-derive the idle deadline after a policy change widened `sessionTimeoutMs`, never shortening
 * it. The deadline is anchored on the last tool activity (`lastUsedAt`), never on the current time:
 * a liveness path may change the idle WINDOW but must not count as use (#10656, #10668).
 */
function widenIdleDeadlineFromLastActivity(session: Session): void {
  session.expiresAt = Math.max(session.expiresAt, session.lastUsedAt + session.sessionTimeoutMs);
}

/**
 * Re-derive the idle deadline after a policy change restored a shorter `sessionTimeoutMs`. Like
 * {@link widenIdleDeadlineFromLastActivity} it is anchored on the last tool activity, so the
 * liveness path that restores the policy cannot extend the deadline (#10656, #10668).
 */
function rebaseIdleDeadlineOnLastActivity(session: Session): void {
  session.expiresAt = session.lastUsedAt + session.sessionTimeoutMs;
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
 * - `managed-execution` (#11176): a session a managed slot execution holds through its stdio
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

function persistedHeartbeatTimeoutSource(value: string | null | undefined): "default" | "custom" {
  return value === "custom" ? "custom" : "default";
}

function persistedLivenessPolicy(value: string | null | undefined): SessionLivenessPolicy {
  if (value === "cli-idle" || value === MANAGED_EXECUTION_LIVENESS_POLICY) {
    return value;
  }
  return "heartbeat";
}

function persistedPreCliLiveness(persisted: DeviceSession): PreCliLivenessSnapshot | undefined {
  if (
    typeof persisted.pre_cli_heartbeat_timeout_ms !== "number" ||
    typeof persisted.pre_cli_session_timeout_ms !== "number"
  ) {
    return undefined;
  }
  return {
    heartbeatTimeoutMs: persisted.pre_cli_heartbeat_timeout_ms,
    heartbeatTimeoutSource: persistedHeartbeatTimeoutSource(
      persisted.pre_cli_heartbeat_timeout_source,
    ),
    sessionTimeoutMs: persisted.pre_cli_session_timeout_ms,
  };
}

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
   * Set to `managed-execution` when a managed slot execution's session is released on a live path
   * (commit or forced stuck release), so release listeners can keep its slot assignment while
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

/** A release's `markReleased` write did not settle within its deadline (#10836). */
export class SessionReleasePersistTimeoutError extends ActionableError {
  readonly reason = RELEASE_PERSIST_TIMEOUT_REASON;

  constructor(
    readonly sessionId: string,
    readonly releaseReason: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Persisting the ${releaseReason} release of session ${sessionId} did not finish within ` +
        `${timeoutMs}ms (reason=${RELEASE_PERSIST_TIMEOUT_REASON}).`,
    );
    this.name = "SessionReleasePersistTimeoutError";
  }
}

/**
 * A session under a kill's terminal release reservation cannot be bound, rebound or reserved again
 * (#11146). It has its own wire code, serialized with `retryable: false` (#11189): the session UUID
 * ends with that release, so only a new UUID (or nothing, for a second kill) can follow. It carries
 * `nextAction: "acquire_new_session"` so runners retry under a fresh session (#11231).
 */
export class SessionTerminalReleaseInProgressError extends ActionableError {
  readonly code = SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE;
  readonly retryable = false;
  /** The UUID can never recover; a fresh session can (#11098, #11231). */
  readonly nextAction = ACQUIRE_NEW_SESSION_NEXT_ACTION;

  constructor(
    readonly sessionUuid: string,
    readonly deviceId: string,
    detail: string,
  ) {
    super(
      `Session ${sessionUuid} ${detail} (code ${SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE}, device '${deviceId}').`,
    );
    this.name = "SessionTerminalReleaseInProgressError";
  }
}

export { SESSION_NO_LONGER_OWNS_DEVICE_CODE, SESSION_REBINDING_CODE };
export { SessionNoLongerOwnsDeviceError };

/**
 * A terminal-release reservation (killDevice) raced the session's own rebind to another device
 * (#11166). The rebind settles on its own, so retrying the shutdown afterwards is safe; it is
 * serialized `retryable: true` with a `retryAfterMs` hint (#11189).
 */
export class SessionRebindingError extends ActionableError {
  readonly code = SESSION_REBINDING_CODE;
  readonly retryable = true;
  readonly retryAfterMs = DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS;

  constructor(readonly sessionUuid: string) {
    super(
      `Session ${sessionUuid} is rebinding devices (code ${SESSION_REBINDING_CODE}); ` +
        "retry shutdown after it settles.",
    );
    this.name = "SessionRebindingError";
  }
}

const TERMINAL_RELEASE_IN_PROGRESS_DETAIL =
  "is being terminally released from its device; use a new session UUID";

export class TerminalSessionError extends Error {
  constructor(
    readonly sessionUuid: string,
    readonly release: SessionReleaseSnapshot,
  ) {
    super(
      (release.releaseReason === "explicit-release"
        ? `Session ${sessionUuid} was released and cannot be reused. `
        : `Session ${sessionUuid} is terminal after ${release.releaseReason} and cannot be reused. `) +
        "Acquire a new device with getAndroid or getApple.",
    );
    this.name = "TerminalSessionError";
  }
}

/**
 * A tool call reached a session whose owner's lease expired and that is held
 * inside its suspect window (#10051). Nothing runs against it until its owner
 * restores it with a heartbeat from the owner token.
 */
export class SessionSuspectError extends ActionableError {
  /** Travels on the socket response so a proxy can tell "restorable" from "gone" (#10053). */
  readonly code = DAEMON_SESSION_SUSPECT_CODE;

  constructor(
    readonly sessionUuid: string,
    readonly remainingMs: number,
  ) {
    super(
      `Session ${sessionUuid} missed a liveness heartbeat and is being restored; its device ` +
        `stays reserved for ${Math.ceil(remainingMs / 1000)}s. Retry this call now, without ` +
        `waiting. If the retry says the session was released, acquire a device again with ` +
        `getAndroid or getApple.`,
    );
    this.name = "SessionSuspectError";
  }
}

/** A new session cannot be published after the daemon has begun shutdown. */
export class DaemonSessionCreationRejectedError extends ActionableError {
  constructor(
    readonly sessionUuid: string,
    readonly release?: SessionReleaseSnapshot,
  ) {
    super(`Cannot create device session ${sessionUuid}: the daemon is shutting down.`);
    this.name = "DaemonSessionCreationRejectedError";
  }
}

/** Idle expiry has no caller to return the device; its diagnostic may name a heartbeat timeout. */
export interface SessionReleaseOptions {
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

/** A call whose start is known on the session clock, as every expiry judgement needs it. */
type SessionClockExecution = SessionExecutionMetadata & { sessionClockStartTime: number };

export interface ActiveSessionExecutionQuery {
  startedAtOrBefore?: number;
  /** Compare the start captured on the session clock, immune to wall-clock steps (#11290). */
  sessionClockStartedAtOrBefore?: number;
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

export type SessionDeviceUnboundCallback = (sessionId: string, deviceId: string) => void;

/** A recovery claim carries its release stamp on this daemon's session clock. */
type ClaimedCreationRow = RecoverableRowIncarnation & {
  releaseReason?: string;
  releasedAtMs?: number;
};

interface PendingSessionCreation {
  promise: Promise<Session>;
  /** Set when the creation outlived its deadline: it must not publish if it lands later (#10963). */
  abandoned?: boolean;
}

interface ReleaseReasonState {
  value: string;
  finalizedSnapshot?: SessionReleaseSnapshot;
  lateTerminalRelease?: Promise<string | null>;
  terminalPersisted?: boolean;
}

/**
 * A release row whose write failed, waiting to be retried: a terminal one (#10959), or a
 * non-terminal one whose session is already gone (#11557).
 */
interface TerminalReleaseRetry {
  snapshot: SessionReleaseSnapshot;
  attempt: number;
  handle?: NodeJS.Timeout;
  /** Already retried during shutdown's drain; a further failure is not retried again (#11058). */
  shutdownAttempted?: boolean;
}

/** A live row's rewrite over its superseded release's terminal row that failed (#11557). */
interface OwedSupersededRowReassert {
  /** The incarnation the rewrite is owed to; a session revived under the UUID owes nothing. */
  session: Session;
  /** Reasons of the superseded releases whose terminal row the rewrite may replace. */
  reasons: Set<string>;
  /** Failed attempts so far, the first write included. */
  attempt: number;
  /** The armed retry; absent while a retry runs and once the retries are exhausted. */
  handle?: NodeJS.Timeout;
  /** Already retried during shutdown's drain; a further failure is not retried again (#11058). */
  drainAttempted?: boolean;
}

interface PendingSessionRelease {
  promise: Promise<string | null>;
  reason: ReleaseReasonState;
}

interface SessionReleaseOperation extends PendingSessionRelease {
  session: Session;
  /** Suspect before the handoff: the owner's existing grace still runs across teardown (#11691). */
  judgeSuspectOwnerAtCommit?: boolean;
  /** Owner proof received during this release; never advances session activity or idle clocks. */
  ownerHeartbeatDuringRelease?: number;
  commitFenced?: boolean;
  /** When the release started; bounds the retry hint for a bind it refuses (#10960). */
  startedAtMs?: number;
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
function releaseWasForced(operation: SessionReleaseOperation | undefined): boolean {
  return operation?.forced === true;
}

/** Where an in-flight release is, for a stuck-release report (#10963). */
export type SessionReleaseStage =
  | "awaiting-rebind"
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

interface PendingSessionRebind {
  session: Session;
  promise: Promise<Session>;
}

interface RecoveryAssignmentWait {
  responseMarginMs: number;
  restartDeadlineMs?: number;
  timeoutError: () => ActionableError;
}

interface SharedSessionAssignment {
  controller: AbortController;
  /** Each deadline removes only its caller; an unbounded caller keeps recovery alive. */
  waiters: number;
  recoveryWait: PromiseWithResolvers<RecoveryAssignmentWait | undefined>;
}

interface TerminalReleaseReservation {
  session: Session;
  deviceId: string;
  owner: symbol;
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
   * (one a managed slot holds). Optional: an assigner without it recovers rows unreserved.
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

interface SessionAcquisitionOptions {
  access?: SessionAccess;
  /** Request-local only; not part of Session or the persistence contract. */
  requestDeadlineMs?: number;
  /**
   * The tracked call making this lookup, when it passes no execution metadata of its own: an
   * implicit (autolock) call refreshing its holder is already tracked under that session, and
   * must not be mistaken for earlier work still in flight when its admission is judged (#11400).
   * It only names the caller; expiry is still judged as for a lookup that carries no execution.
   */
  callerExecutionId?: string;
}

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

/** A recoverable row this daemon claimed for recovery, and the owner a failed recovery restores. */
interface ClaimedRecoverableRow {
  row: DeviceSession;
  previousOwner: string | null;
}

/** Which other daemon holds a recovery target (reason `owned-by-other-daemon`, #11076). */
export interface SessionRecoveryForeignOwner {
  deviceId: string;
  ownerPid: number | undefined;
}

/**
 * The persisted target cannot be recovered without assigning an unrelated
 * device. SessionManager fences the UUID when this reaches it.
 */
export class SessionRecoveryIdentityLossError extends ActionableError {
  readonly terminalReleaseReason: string;
  /** Wire code when another live daemon holds the target (`device_owned_by_other_daemon`). */
  readonly code: string | undefined;
  readonly deviceId: string | undefined;
  readonly ownerPid: number | undefined;

  constructor(
    readonly sessionUuid: string,
    readonly target: SessionRecoveryTarget,
    readonly reason: SessionRecoveryFailureReason,
    foreignOwner?: SessionRecoveryForeignOwner,
  ) {
    super(
      `Cannot safely recover session ${sessionUuid}: ${target.platform} device ` +
        `'${target.stableDeviceId}' ${recoveryFailureDetail(reason, foreignOwner)} ` +
        `(recovery reason: ${reason}). ` +
        "The persisted session is terminal; " +
        "acquire a new device with getAndroid or getApple.",
    );
    this.name = "SessionRecoveryIdentityLossError";
    this.terminalReleaseReason = `identity-recovery-${reason}`;
    this.code = reason === "owned-by-other-daemon" ? DEVICE_OWNED_BY_OTHER_DAEMON_CODE : undefined;
    this.deviceId = foreignOwner?.deviceId;
    this.ownerPid = foreignOwner?.ownerPid;
  }
}

function recoveryFailureDetail(
  reason: SessionRecoveryFailureReason,
  foreignOwner: SessionRecoveryForeignOwner | undefined,
): string {
  switch (reason) {
    case "target-busy":
      return "is already in use";
    case "identity-continuity-lost":
      return "lost identity continuity";
    case "owned-by-other-daemon":
      return (
        "is claimed by another AutoMobile daemon" +
        (foreignOwner?.ownerPid === undefined ? "" : ` (PID ${foreignOwner.ownerPid})`) +
        ` (code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE})`
      );
    case "target-absent":
      return "is unavailable";
  }
}

type SessionRecoveryIdentityLoss = Pick<
  SessionRecoveryIdentityLossError,
  "sessionUuid" | "target" | "reason" | "terminalReleaseReason"
> &
  Partial<Pick<SessionRecoveryIdentityLossError, "ownerPid">>;

function isSessionRecoveryFailureReason(reason: unknown): reason is SessionRecoveryFailureReason {
  return (
    reason === "target-absent" ||
    reason === "target-busy" ||
    reason === "identity-continuity-lost" ||
    reason === "owned-by-other-daemon"
  );
}

function isSessionRecoveryTarget(target: unknown): target is SessionRecoveryTarget {
  if (!target || typeof target !== "object") {
    return false;
  }
  const candidate = target as Partial<SessionRecoveryTarget>;
  if (candidate.platform !== "android" && candidate.platform !== "ios") {
    return false;
  }
  return typeof candidate.stableDeviceId === "string" && typeof candidate.deviceId === "string";
}

/**
 * `SessionDeviceAssigner` is an injected boundary. A recovery error can retain
 * its product payload while originating from another loaded bundle, in which
 * case `instanceof` alone would skip terminalizing an already-rejected UUID.
 */
function isSessionRecoveryIdentityLossError(error: unknown): error is SessionRecoveryIdentityLoss {
  if (!(error instanceof Error) || error.name !== "SessionRecoveryIdentityLossError") {
    return false;
  }
  const candidate = error as Partial<SessionRecoveryIdentityLoss>;
  return (
    typeof candidate.sessionUuid === "string" &&
    typeof candidate.terminalReleaseReason === "string" &&
    isSessionRecoveryFailureReason(candidate.reason) &&
    candidate.terminalReleaseReason === `identity-recovery-${candidate.reason}` &&
    isSessionRecoveryTarget(candidate.target)
  );
}

export interface RebindSessionOptions {
  /**
   * The runtime behind the same device ID restarted, so device-scoped session
   * state must be cleared even though the serial is unchanged.
   */
  force?: boolean;
  /** Durable identity of the replacement device. */
  stableDeviceId?: string;
  /** Internal owner proving that a shutdown reservation authorized this recovery rebind. */
  terminalReleaseReservationOwner?: symbol;
  /** Only receipt-backed acquisitions can decide delivery versus undo. */
  deferCleanup?: (cleanup: DeferredRebindCleanup) => void;
}

const KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS = 1_000;
/**
 * A failed keep-awake restore leaves a physical device that never sleeps, so — like the network
 * restorer — it is retried inside the pending cleanup, then handed to health recovery (#11145).
 */
const KEEP_SCREEN_AWAKE_RESTORE_RETRY_ATTEMPTS = 2;
const KEEP_SCREEN_AWAKE_RESTORE_RETRY_DELAY_MS = 250;
const BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS = 1_000;
/**
 * A failed restore leaves the simulator holding session-modified enrollment, so
 * the device must not return to the idle pool on the strength of one attempt.
 * Retries run inside the pending-cleanup promise, which keeps the device
 * quarantined until they settle.
 */
const BIOMETRIC_ENROLLMENT_RESTORE_RETRY_ATTEMPTS = 2;
const BIOMETRIC_ENROLLMENT_RESTORE_RETRY_DELAY_MS = 250;
const NETWORK_CONDITION_RESTORE_TIMEOUT_MS = 1_000;
/**
 * Clock restore ends with `adb unroot`, which restarts adbd: the device goes offline and the
 * restore only finishes once it reconnects (a few seconds on an emulator). The network path's
 * 1 s deadline fired on every successful restore and quarantined it for nothing (#10771).
 */
export const CLOCK_RESTORE_TIMEOUT_MS = 15_000;
/**
 * A failed network restore leaves the emulator holding session-modified shaping,
 * so — like the biometric restorer — the device must not return to the idle pool
 * on one attempt. Retries run inside the pending-cleanup promise, keeping the
 * device quarantined until they settle (issue #6012 review, was deferred #6085).
 */
const NETWORK_CONDITION_RESTORE_RETRY_ATTEMPTS = 2;
const NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS = 250;
/**
 * Each screen-reader restore attempt is a full TalkBack/VoiceOver toggle (it can
 * fall back to a `uiautomator dump`), so unlike the settings writes above it is
 * retried a small bounded number of times, with `Backoff` delays, never forever.
 */
const SCREEN_READER_RESTORE_RETRY_ATTEMPTS = 2;
const DEFAULT_SCREEN_READER_RESTORE_BACKOFF = exponentialBackoff({
  initialDelayMs: 250,
  maxDelayMs: 2_000,
});
/**
 * Rotation restore retries are bounded too. A fold/unfold between the session's
 * rotation and its release can leave the recorded settings unverifiable (the
 * window manager owns the new panel's rotation), so an unbounded retry kept the
 * device quarantined forever. After the cap the device leaves quarantine.
 */
const ROTATION_RESTORE_RETRY_ATTEMPTS = 5;
const DEFAULT_ROTATION_RESTORE_BACKOFF = exponentialBackoff({
  initialDelayMs: NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS,
  maxDelayMs: 2_000,
});
/**
 * A restore the window manager owns (a foldable re-applying rotation per device state)
 * can never verify by rewriting the setting, so it ends the retry loop immediately.
 */
function isNonRetryableRotationRestoreError(error: unknown): boolean {
  if (error instanceof RotationSettingManagedError) {
    return true;
  }
  const details: unknown =
    typeof error === "object" && error !== null && "details" in error ? error.details : undefined;
  return (
    typeof details === "object" &&
    details !== null &&
    "retryable" in details &&
    details.retryable === false
  );
}
export const SESSION_SETUP_DRAIN_TIMEOUT_MS = 1_000;
/**
 * Overall budget for the restores one release runs through the ambient signal
 * (keep-awake, biometric, network), measured from the start of the drain with the
 * injected Timer. Release teardown runs under its own signal, not the caller's, so
 * this bound is what stops a wedged device command from holding the device
 * quarantined; the screen-reader, clock and rotation restores keep their own budgets
 * and abandon mechanisms. Sized well above the three 1 s attempts plus their 250 ms
 * retries, below the screen-reader budget (#10198).
 */
export const SESSION_RELEASE_TEARDOWN_CAP_MS = 10_000;
/**
 * Bound on one release's `markReleased` write (#10836). It is the only await on the release
 * path that has no budget of its own, so a wedged DB write would otherwise hold the session's
 * device forever. A terminal release that reaches it keeps the session fenced in memory, frees
 * the device, and leaves the row for a later release to persist. It is longer than the shutdown
 * release drain, so a write wedged at shutdown still keeps the database open and the release on
 * the drain's daemon-shutdown fallback path.
 */
export const SESSION_RELEASE_PERSIST_TIMEOUT_MS = 10_000;
/** Logged reason when a release write outlives {@link SESSION_RELEASE_PERSIST_TIMEOUT_MS}. */
export const RELEASE_PERSIST_TIMEOUT_REASON = "release-persist-timeout";
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
/**
 * Retries of a live row's rewrite over its superseded release's terminal row (#11557): one failed
 * write (a busy database) must not leave the live session behind a terminal row. Bounded; after
 * the last one the rewrite stays owed and the session's next activity write issues it again.
 */
export const SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS = 5;
export const DEFAULT_SUPERSEDED_ROW_REASSERT_BACKOFF: BackoffPolicy = exponentialBackoff({
  initialDelayMs: 250,
  maxDelayMs: 5_000,
});
const MAX_PENDING_NON_TERMINAL_RELEASE_SNAPSHOTS = 256;
export const SESSION_REHYDRATION_DEADLINE_MS = 15_000;
/** Persisted rows recovered at once during startup rehydration (#11114). */
export const SESSION_REHYDRATION_CONCURRENCY = 4;

type RehydrationRowOutcome =
  | { kind: "rehydrated" }
  | { kind: "terminalized"; reason: string }
  | { kind: "skipped"; reason: string };

export class UnissuedSessionError extends ActionableError {}

/**
 * The durable device identity a persisted row can be recovered onto, or undefined when the row
 * recorded none. iOS device_id has always been the simulator's immutable UDID. Android's emulator
 * device_id and TCP/mDNS transport addresses cannot prove continuity; a physical handset serial
 * is its durable identity.
 */
function persistedStableDeviceId(persisted: DeviceSession): string | undefined {
  const recorded =
    persisted.stable_device_id ??
    (persisted.platform === "ios" ||
    (persisted.platform === "android" &&
      !isAndroidEmulatorSerial(persisted.device_id) &&
      !isAndroidTransportAddressSerial(persisted.device_id))
      ? persisted.device_id
      : undefined);
  return recorded || undefined;
}

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

function releaseSuperseded(shouldCommit: ReleaseCommitFence | undefined): boolean {
  return shouldCommit !== undefined && shouldCommit() === false;
}

/** Plan cleanup frees devices; the base and label UUIDs may be issued again by name (not rehydrated). */
export const PLAN_AUTO_RELEASE_REASON = "plan-auto-release" satisfies SessionReleaseReason;

export function getDefaultSessionHeartbeatTimeoutMs(): number {
  return readEnvPositiveInteger(
    "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
    "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
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
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
  getCliSessionIdleTimeoutMs,
  sanitizeCliSessionIdleTimeoutMs,
} from "./constants";

/** The idle window default before the 2026-10-08 owner decision; rows persisted with it adopt the current one. */
const LEGACY_DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
/** The CLI idle default before the 2026-10-08 owner decision; rows persisted with it adopt the current one. */
const LEGACY_DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Default grace before a never-heartbeated default-policy session is reaped. */
export const DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS = 5_000;
// Give a restarted emulator the same three-minute cold-boot allowance as device readiness.
export const DEVICE_RESTART_RECOVERY_WINDOW_MS = DEFAULT_DEVICE_READY_TIMEOUT_MS;

function isDeviceRestartReleasedRow(
  persisted: DeviceSession,
): persisted is DeviceSession & { released_at_ms: number } {
  return Boolean(
    persisted.release_reason &&
    isDeviceRestartReleaseReason(persisted.release_reason) &&
    persisted.released_at_ms !== null,
  );
}

/**
 * When a device-restart recovery must give up. Admission ends at the first of idle expiry
 * and the fixed handoff window. A caller-driven wait (`callerInFlight`) ignores idle expiry:
 * a tool call in flight is activity and is never released mid-call (owner decision 2026-10-08) — only the cold-boot
 * allowance bounds it.
 */
function restartRecoveryDeadlineFromPersisted(
  persisted: DeviceSession,
  callerInFlight = false,
): number | undefined {
  if (!isDeviceRestartReleasedRow(persisted)) {
    return undefined;
  }
  const restartWindowEnd = persisted.released_at_ms + DEVICE_RESTART_RECOVERY_WINDOW_MS;
  return callerInFlight ? restartWindowEnd : Math.min(persisted.expires_at_ms, restartWindowEnd);
}

/** The persisted handoff's fixed window; idle activity never moves this deadline. */
function hasLapsedRestartRecoveryWindow(persisted: DeviceSession, nowMs: number): boolean {
  const deadline = restartRecoveryDeadlineFromPersisted(persisted, true);
  return deadline !== undefined && nowMs >= deadline;
}

/**
 * The grace `SessionHeartbeatMonitor` applies before reaping a default-policy
 * session that never sent its first heartbeat. Single-sourced here so the
 * `missing-first-heartbeat` release snapshot reports the deadline that actually
 * fired — the grace, not the (longer) heartbeat timeout — instead of leaving a
 * reader to conclude the daemon reaped early (issue #5689).
 */
export function getDefaultPreFirstHeartbeatGraceMs(): number {
  return readEnvPositiveInteger(
    "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
    "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
    { fallback: DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS },
  );
}

export class SessionManager {
  private stallProbe: (() => void) | undefined;
  private sessions: Map<string, Session> = new Map();
  private sessionDeviceMap: Map<string, string> = new Map(); // sessionId -> deviceId
  private deviceSessionMap: Map<string, string> = new Map(); // deviceId -> sessionId (reverse lookup)
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** Pending follow-up sweep of rows the startup rehydration deadline skipped (#11114). */
  private rehydrationFollowUpTimer: NodeJS.Timeout | null = null;
  private timer: Timer;
  /** The clock every session timestamp is stamped and judged with (#11080); see {@link sessionNow}. */
  private readonly sessionClock: SteadyWallClock;
  private releaseCallbacks: SessionReleaseCallback[] = [];
  private readonly restartReleasePersistence = new WeakMap<
    SessionReleaseSnapshot,
    PromiseWithResolvers<void>
  >();
  // Base session → its derived `${base}:${label}` sessions (#11091), outside the base's cache so
  // it survives the base's removal. Consumed by takeDerivedLabelSessions.
  private readonly derivedLabelSessionsByBase = new Map<string, Set<string>>();
  // Retain the base's terminal end while the cascade owns a still-published label (#11640).
  private readonly endedLabelBases = new Map<
    string,
    { baseSessionId: string; releaseReason: string }
  >();
  /**
   * Derived label sessions a plan run's allocation may mint right now, counted per open run
   * (#11572). See {@link openPlanLabelMints}.
   */
  private readonly planLabelMints = new Map<string, number>();
  /**
   * Derived label sessions a plan run in this daemon minted, until their base is released
   * (#11572). Only these may be recovered by name, after a device restart during their run.
   */
  private readonly runningPlanLabelSessions = new Set<string>();
  private createdCallbacks: SessionCreatedCallback[] = [];
  private deviceUnboundCallbacks: SessionDeviceUnboundCallback[] = [];
  private readonly deviceOwnershipCallbacks = new Set<
    (deviceId: string, frameInvalidation: "generation-only" | "full") => void
  >();
  private readonly releasePromises: Map<string, SessionReleaseOperation> = new Map();
  /** Every release still running, including an older session that reused a UUID. */
  private readonly activeReleasePromises: Set<SessionReleaseOperation> = new Set();
  /** Release writes that outlived their deadline but may still land (#10836). */
  private readonly lateReleaseWrites: Set<Promise<void>> = new Set();
  /**
   * Release rows a write failed to persist, awaiting a retry: terminal ones (#10959), and the
   * non-terminal ones of {@link pendingNonTerminalReleaseSnapshots} (#11557).
   */
  private readonly pendingTerminalReleaseRetries: Map<string, TerminalReleaseRetry> = new Map();
  /**
   * Set once shutdown starts draining releases (#11058): a terminal write that fails from then on
   * is retried at once and tracked by the drain, since a backoff timer would outlive the database.
   */
  private releaseDrainStarted = false;
  private terminalReleaseRetryBackoff: BackoffPolicy = DEFAULT_TERMINAL_RELEASE_RETRY_BACKOFF;
  /** Crash-safe sidecar of terminal releases whose row write has not landed (#10959). */
  private terminalReleaseJournal: TerminalReleaseJournal = new NoopTerminalReleaseJournal();
  /**
   * The owning daemon's id, stamped on every persisted active row so a peer daemon sharing the
   * database can tell this daemon's live rows from a dead predecessor's (#11114).
   */
  private daemonSessionId: string | undefined;
  private liveDaemonSessionIds: (() => ReadonlySet<string>) | undefined;
  /**
   * Terminal releases a previous daemon recorded but never persisted. Until its row write lands, a
   * listed UUID reads as terminally released, so nothing can revive it.
   */
  private readonly recoveredTerminalReleaseIntents: Map<string, TerminalReleaseIntent> = new Map();
  /** Dead peer daemons whose journals were read after startup (#11355); never read again. */
  private readonly adoptedDeadDaemonJournals: Set<string> = new Set();
  /**
   * The dead daemon each post-startup adopted intent came from (#11355). Such an intent applies
   * only while its row is still that daemon's: a row another daemon took since is left alone.
   */
  private readonly adoptedTerminalReleaseOwners: Map<string, string> = new Map();
  /** Finalized release state retained only while its exact Session identity is referenced. */
  private readonly finalizedSessionReleases: WeakMap<Session, ReleaseReasonState> = new WeakMap();
  /**
   * What a forced release released its session as, when the reason is not terminal (#11361): the
   * stuck release it replaced may never finalize, and a row write that must be issued again after
   * a rewrite needs the release to issue (#11557).
   */
  private readonly forcedNonTerminalReleases: WeakMap<Session, SessionReleaseSnapshot> =
    new WeakMap();
  /** Serializes durable liveness claims within one exact session incarnation. */
  private readonly livenessOwnershipClaimMutexes = new WeakMap<Session, Mutex>();
  /**
   * The newest activity row issued for each session incarnation, until that write fails (#11079).
   * A heartbeat whose persisted fields match it has nothing to write, so steady-state heartbeats
   * do no DB work and a peer daemon holding the write lock cannot stall them.
   */
  private readonly issuedActivityWrites = new WeakMap<Session, IssuedActivityWrite>();
  /**
   * The row generation each session incarnation's latest upsert produced (#11129). A non-terminal
   * release captures it so its write cannot land on a row a later incarnation re-upserted.
   */
  private readonly persistedRowGenerations = new WeakMap<Session, number>();
  private readonly activityRowRePersists = new SingleFlight<Session, void>();
  private readonly retiredCreationRows = new WeakSet<Session>();
  /** Own superseded releases can land late for this incarnation's entire lifetime (#11557). */
  private readonly supersededReleaseReasons = new WeakMap<Session, Set<string>>();
  /** The row generation a non-terminal release snapshot may overwrite (#11129). */
  private readonly releaseRowGenerations = new WeakMap<SessionReleaseSnapshot, number>();
  /** Only the exact earlier reasons of this release may be replaced by its committed upgrade. */
  private readonly releaseReasonPredecessors = new WeakMap<
    SessionReleaseSnapshot,
    readonly string[]
  >();
  /** A refused release wrote nothing, so superseding it owes no live-row rewrite. */
  private readonly refusedReleaseWrites = new WeakSet<SessionReleaseSnapshot>();
  /** Latest finalized incarnation, weakly retained until a same-UUID replacement publishes. */
  private readonly latestFinalizedSessionIdentities: Map<string, WeakRef<Session>> = new Map();
  private readonly finalizedSessionIdentityRegistry = new FinalizationRegistry<{
    sessionId: string;
    identity: WeakRef<Session>;
  }>(({ sessionId, identity }) => {
    if (this.latestFinalizedSessionIdentities.get(sessionId) === identity) {
      this.latestFinalizedSessionIdentities.delete(sessionId);
    }
  });
  /** Finalized terminal state used to coalesce UUID-only recovery retries. */
  private readonly terminalReleaseReasonStates: Map<string, ReleaseReasonState> = new Map();
  /** UUID admission fences held while a device shutdown decides its terminal outcome. */
  private readonly terminalReleaseReservations: Map<string, TerminalReleaseReservation> = new Map();
  /** Setup work that can modify device state after a session has been assigned. */
  private readonly sessionSetupPromises: Set<{ session: Session; promise: Promise<void> }> =
    new Set();
  /** Sessions whose teardown has closed admission for further device-state setup. */
  private readonly releasingSessions: WeakSet<Session> = new WeakSet();
  /**
   * Device work that outlived its bounded release phase. The pool keeps the
   * device assigned until this settles, so no replacement session can race a
   * late setup or keep-awake restore.
   */
  private readonly pendingDeviceCleanups: Map<string, Promise<void>> = new Map();
  /** Individual promises let an undo join every cleanup except the gate it still owns. */
  private readonly pendingDeviceCleanupWork = new Map<string, Set<Promise<unknown>>>();
  /** The latest cap-bounded settle time of each device's pending cleanup, when one was given. */
  private readonly pendingDeviceCleanupSettlesBy: Map<string, number> = new Map();
  /**
   * Work started by the device's current acquisition (owner-less recording stop, #11041). It never
   * blocks the live holder, but counts as cleanup once the device has no owner again.
   */
  private readonly acquisitionDeviceCleanups: Map<string, Promise<void>> = new Map();
  /** When each device's capped acquisition cleanups settle at the latest (#11616). */
  private readonly acquisitionDeviceCleanupSettlesBy: Map<string, number> = new Map();
  /**
   * Active per-condition network TTLs (issue #6085 item 2), keyed by session id.
   * When a session degrades the network with an `expiresInSeconds`, a timer resets
   * the profile to `none` when it elapses — independent of session lifetime. The
   * timer is cancelled on release/rebind (whichever restore runs first wins) and
   * clears the restore slot when it fires, so it can never fire against a freed
   * device or double-restore.
   */
  private readonly networkConditionExpiryTimers: Map<
    string,
    { handle: NodeJS.Timeout; session: Session; deadlineMs: number; generation: number }
  > = new Map();
  /**
   * Monotonic per-session network-condition generation (issue #6177). Bumped by
   * {@link bumpNetworkConditionGeneration} on every apply/reset mutation, and
   * captured into a TTL expiry's closure when it is scheduled. A stale expiry
   * (condition A) that is still awaiting its restore when a newer condition
   * (B) is applied sees, on completion, that the session's generation has moved
   * on — so it can detect it was superseded and must not clear B's restore slot.
   */
  private readonly networkConditionGeneration: Map<string, number> = new Map();
  /**
   * Per-session tail of the promise chain serializing
   * {@link runNetworkConditionMutationExclusive} critical sections (issue #6178
   * PR #6183 review, structural fix). The generation guard alone cannot
   * preserve a displaced expiry: a later generation only proves a mutation was
   * ATTEMPTED, not that it succeeded, so two overlapping FAILURES (B then C)
   * could each see nothing to restore while a timed degrade's (A's) original
   * deadline is lost between them. Serializing the whole apply/reset + TTL
   * arm/cancel/re-arm sequence per session removes the race family outright —
   * see {@link runNetworkConditionMutationExclusive}.
   */
  private readonly networkConditionMutationQueues: Map<string, Promise<unknown>> = new Map();
  /** Creation writes that must finish before a session becomes visible to callers. */
  private readonly pendingSessionCreations: Map<string, PendingSessionCreation> = new Map();
  /** False once daemon shutdown fences acquisitions that outlive request quiescence. */
  private acceptingSessionCreations = true;
  /** Automatic device assignments that have not yet started their creation write. */
  private readonly pendingSessionAssignments: Map<string, Promise<Session>> = new Map();
  private readonly sharedSessionAssignments = new Map<string, SharedSessionAssignment>();
  /** Persisted recovery state consumed by createSession before it publishes an assigned session. */
  private readonly pendingPersistedRecoveries: Map<string, DeviceSession> = new Map();
  /** Rows this daemon claimed for recovery (#11200); their upsert is conditioned on the claim. */
  private readonly claimedRecoverableRows = new WeakSet<DeviceSession>();
  /**
   * Last tool-call activity (a call starting, joining, or ending) against a session that is
   * waiting out a device restart. The released row's `expires_at_ms` froze at the device loss,
   * so without this an agent that keeps calling through a cold boot longer than the idle window
   * would lose its session; it is projected onto the persisted row by
   * {@link readPersistedSession}. In memory only: a daemon restart falls back to the row.
   */
  private readonly restartRecoveryActivityAt: Map<string, number> = new Map();
  private readonly restartRecoveryActivityCallbacks: Array<
    (sessionId: string, atMs: number) => void
  > = [];
  /**
   * UUIDs whose live row this daemon is about to rewrite over a terminal row its own superseded
   * release wrote or may still write (#11206), counted per pending rewrite. While one is pending,
   * a terminal row under the live session is that release's, not the end of the UUID (#11498).
   */
  private readonly pendingSupersededRowReasserts: Map<string, number> = new Map();
  /**
   * Pending non-terminal releases whose row still holds their session's superseded release's
   * terminal row (#11557): the retry of `release` replaces that row before it writes its own.
   */
  private readonly supersededRowsUnderPendingRelease: Map<
    string,
    { session: Session; reasons: readonly string[]; release: SessionReleaseSnapshot }
  > = new Map();
  /**
   * The superseded releases' reasons whose terminal row a rewrite or a replacement under way is
   * replacing, one entry per write. Not the parked write's whole window: the row a peer or a
   * committed release wrote meanwhile is the UUID's end.
   */
  private readonly supersededReasonsBeingRewritten: Map<string, string[]> = new Map();
  /**
   * Rewrites of {@link pendingSupersededRowReasserts} that failed and are still owed (#11557):
   * retried with {@link supersededRowReassertBackoff}, then by the session's activity writes.
   * While one is owed, its release's terminal row under the live session is not the UUID's end.
   */
  private readonly owedSupersededRowReasserts: Map<string, OwedSupersededRowReassert> = new Map();
  private supersededRowReassertBackoff: BackoffPolicy = DEFAULT_SUPERSEDED_ROW_REASSERT_BACKOFF;
  /** Releases received before an assignment has published its session. */
  private readonly pendingSessionReleases: Map<string, PendingSessionRelease> = new Map();
  /** Rebinds that a release must await before it can remove the live binding. */
  private readonly pendingSessionRebinds: Map<string, PendingSessionRebind> = new Map();
  private readonly deferredRebindCleanups = new Map<
    DeferredRebindCleanup,
    {
      sessionId: string;
      deviceId: string;
    }
  >();
  private readonly terminalReleaseSnapshots: Map<string, SessionReleaseSnapshot> = new Map();
  private readonly pendingNonTerminalReleaseSnapshots: Map<string, SessionReleaseSnapshot> =
    new Map();
  private deviceSessionRepository: DeviceSessionPersistence;
  private readonly getBarrier: () => DbWriteBarrier;
  private readonly keepScreenAwakeRestorerFactory: (
    device: BootedDevice,
  ) => KeepScreenAwakeRestorer;
  private readonly biometricEnrollmentRestorerFactory: (
    device: BootedDevice,
  ) => BiometricEnrollmentRestorer;
  private readonly networkConditionRestorerFactory: (
    device: BootedDevice,
  ) => NetworkConditionRestorer;
  private readonly clockRestorerFactory: (device: BootedDevice) => ClockRestorer;
  private readonly pendingClockRestores = new Map<
    string,
    Map<ClockSessionState, PendingClockRestore>
  >();
  private readonly clockRemovalGenerations = new Map<string, number>();
  private readonly clockMutationQueues = new Map<string, Promise<unknown>>();
  private readonly rotationRestorerFactory: (device: BootedDevice) => RotationRestorer;
  private readonly pendingRotationRestores = new Map<
    string,
    Map<RotationSessionState, PendingRotationRestore>
  >();
  private readonly rotationRemovalGenerations = new Map<string, number>();
  private readonly rotationMutationQueues = new Map<string, Promise<unknown>>();
  private readonly screenReaderRestorerFactory: (device: BootedDevice) => ScreenReaderRestorer;
  private readonly pendingScreenReaderRestores = new Map<
    string,
    Map<ScreenReaderSessionState, PendingScreenReaderRestore>
  >();
  private readonly screenReaderRestoreBackoff: BackoffPolicy;
  private readonly rotationRestoreBackoff: BackoffPolicy;
  /** Rotation settings a device still holds after release cleanup gave up on them (#10714). */
  private readonly abandonedRotations = new Map<string, RotationSessionState>();
  private readonly abandonedRotationRetries = new Map<string, Promise<void>>();
  /** Screen-reader state a device still holds after the bounded retries gave up (#10159). */
  private readonly abandonedScreenReaders = new Map<string, ScreenReaderSessionState>();
  private injectedIosAppNetworkRuleRestorer?: IosAppNetworkRuleRestorer;
  /** Renews each session's installed iOS per-app rule (#10264). */
  private readonly iosAppNetworkLeases: IosAppNetworkLeases;
  /** Last owner generation handed out; see {@link allocateIosOwnerGeneration}. */
  private lastIosOwnerGeneration = 0;
  private readonly abandonedScreenReaderRetries = new Map<string, Promise<void>>();
  private readonly screenReaderRemovalGenerations = new Map<string, number>();
  private readonly screenReaderMutationQueues = new Map<string, Promise<unknown>>();
  private observerSessions?: Pick<ObserverSessionStore, "release"> &
    Partial<Pick<ObserverSessionStore, "list">> &
    Partial<StallForgivingLeases>;

  /** Retry delays for terminal release writes that failed after their deadline (#10959). */
  setTerminalReleaseRetryBackoff(backoff: BackoffPolicy): void {
    this.terminalReleaseRetryBackoff = backoff;
  }

  /** Retry delays for a live row's rewrite over its superseded release's terminal row (#11557). */
  setSupersededRowReassertBackoff(backoff: BackoffPolicy): void {
    this.supersededRowReassertBackoff = backoff;
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
    this.terminalReleaseJournal = journal;
    for (const intent of journal.loadUnconfirmed()) {
      // The journal holds wall ms, like the rows it backs (#11162).
      this.recoveredTerminalReleaseIntents.set(intent.sessionId, {
        ...intent,
        at: this.wallToSessionClock(intent.at),
      });
    }
  }

  /**
   * Write the terminal row of every recovered intent whose row is not terminal yet, and drop the
   * intents whose rows already are. A write that fails keeps its intent (and the UUID fenced) for
   * the next startup.
   */
  async applyRecoveredTerminalReleaseIntents(deadlineAt?: number): Promise<string[]> {
    const applied: string[] = [];
    for (const intent of Array.from(this.recoveredTerminalReleaseIntents.values())) {
      if (deadlineAt !== undefined && this.sessionNow() >= deadlineAt) {
        // The rest stay fenced in memory and are applied by the next startup.
        break;
      }
      try {
        const persisted = await this.deviceSessionRepository.getSession?.(intent.sessionId);
        if (
          persisted &&
          !(persisted.release_reason && isTerminalReleaseReason(persisted.release_reason)) &&
          this.adoptedTerminalReleaseApplies(persisted)
        ) {
          await raceWithDeadline(
            this.deviceSessionRepository.markReleased(
              intent.sessionId,
              releasedRowStatus(intent.reason),
              intent.at,
              intent.reason,
              ...this.adoptedTerminalReleaseFence(intent.sessionId),
            ),
            {
              timer: this.timer,
              timeoutMs: SESSION_RELEASE_PERSIST_TIMEOUT_MS,
              unref: true,
              label: "Recovered terminal session release",
              timeoutError: () =>
                new SessionReleasePersistTimeoutError(
                  intent.sessionId,
                  intent.reason,
                  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
                ),
            },
          );
          applied.push(intent.sessionId);
        }
      } catch (error) {
        logger.warn(
          `[SessionManager] Failed to apply the unconfirmed terminal release of session ` +
            `${intent.sessionId} (${intent.reason}); it stays fenced: ${errorMessage(error)}`,
          error,
        );
        continue;
      }
      this.recoveredTerminalReleaseIntents.delete(intent.sessionId);
      this.adoptedTerminalReleaseOwners.delete(intent.sessionId);
      this.terminalReleaseJournal.resolve(intent.sessionId, intent.reason);
    }
    if (applied.length > 0) {
      logger.warn(
        `[SessionManager] Terminalized ${applied.length} session(s) whose terminal release a ` +
          `previous daemon never persisted: ${applied.join(", ")}`,
      );
    }
    return applied;
  }

  /** A row a previous daemon terminally released without persisting it reads as released. */
  private withRecoveredTerminalRelease(persisted: DeviceSession): DeviceSession {
    const intent = this.recoveredTerminalReleaseIntents.get(persisted.session_uuid);
    if (
      !intent ||
      (persisted.release_reason !== null && isTerminalReleaseReason(persisted.release_reason)) ||
      !this.adoptedTerminalReleaseApplies(persisted)
    ) {
      return persisted;
    }
    return {
      ...persisted,
      status: releasedRowStatus(intent.reason),
      released_at_ms: intent.at,
      release_reason: intent.reason,
    };
  }

  /**
   * Whether the recovered intent for this row may terminalize it. An intent adopted from a peer
   * that died after this daemon started (#11355) applies only while the row is still that peer's.
   */
  private adoptedTerminalReleaseApplies(persisted: DeviceSession): boolean {
    const adoptedFrom = this.adoptedTerminalReleaseOwners.get(persisted.session_uuid);
    return adoptedFrom === undefined || (persisted.daemon_session_id ?? null) === adoptedFrom;
  }

  /**
   * The write fence of an intent adopted after startup (#11355): the check above is a prior read,
   * so the release itself is conditioned on the row still being the dead daemon's. A row another
   * survivor recovered meanwhile, or one this write reaches only after parking, is left alone.
   */
  private adoptedTerminalReleaseFence(sessionId: string): [] | [MarkReleasedOptions] {
    const adoptedFrom = this.adoptedTerminalReleaseOwners.get(sessionId);
    return adoptedFrom === undefined ? [] : [{ onlyIfOwnedByDaemon: adoptedFrom }];
  }

  /**
   * Adopt the terminal-release journal of this row's owner daemon once that daemon is known to be
   * dead (#11355). Startup adoption skips a peer that is live at the time, so a peer that parked a
   * terminal release and then died left a row a survivor would recover. Reading one of its rows
   * reads its whole journal first: the intents fence their UUIDs in memory at once, and their rows
   * are written before the read returns. The dead daemon's file stays in place until every one of
   * its intents is settled, so another survivor (or this daemon's successor) still finds it when
   * a write here parks or fails; a failed write is retried when a row of that daemon is next read. A
   * daemon whose liveness cannot be confirmed is left alone, because a live daemon's intents can
   * still be lifted. Resolves true when rows may have been written, so the caller re-reads.
   */
  private async adoptDeadOwnerTerminalReleases(stored: DeviceSession): Promise<boolean> {
    const owner = this.confirmedDeadOwner(stored);
    if (owner === undefined) {
      return false;
    }
    const firstRead = !this.adoptedDeadDaemonJournals.has(owner);
    if (firstRead && !this.fenceDeadDaemonIntents(owner)) {
      // Unreadable for now; the next read of one of this daemon's rows retries.
      return false;
    }
    const unsettled = this.hasUnsettledAdoptedIntent(owner);
    if (!firstRead && !unsettled) {
      return false;
    }
    if (unsettled) {
      await this.applyRecoveredTerminalReleaseIntents();
    }
    if (!this.hasUnsettledAdoptedIntent(owner)) {
      // Every row is terminal (or no longer the dead daemon's): nobody needs the file again.
      this.terminalReleaseJournal.discardDeadDaemon?.(owner);
    }
    return true;
  }

  /** Read `owner`'s journal and fence its intents; false when it cannot be read yet. */
  private fenceDeadDaemonIntents(owner: string): boolean {
    const intents = this.terminalReleaseJournal.readDeadDaemon?.(owner);
    if (intents === undefined) {
      return false;
    }
    this.adoptedDeadDaemonJournals.add(owner);
    for (const intent of intents) {
      // The journal holds wall ms, like the rows it backs (#11162).
      this.recoveredTerminalReleaseIntents.set(intent.sessionId, {
        ...intent,
        at: this.wallToSessionClock(intent.at),
      });
      this.adoptedTerminalReleaseOwners.set(intent.sessionId, owner);
    }
    if (intents.length > 0) {
      logger.warn(
        `[SessionManager] Adopted ${intents.length} unconfirmed terminal release(s) of dead ` +
          `daemon ${owner}: ${intents.map((intent) => intent.sessionId).join(", ")}`,
      );
    }
    return true;
  }

  private hasUnsettledAdoptedIntent(owner: string): boolean {
    for (const adoptedFrom of this.adoptedTerminalReleaseOwners.values()) {
      if (adoptedFrom === owner) {
        return true;
      }
    }
    return false;
  }

  /** The row's owner daemon, when it is a confirmed-dead peer whose journal can be adopted. */
  private confirmedDeadOwner(stored: DeviceSession): string | undefined {
    const owner = stored.daemon_session_id ?? null;
    if (owner === null || this.daemonSessionId === undefined || owner === this.daemonSessionId) {
      return undefined;
    }
    if (
      !this.terminalReleaseJournal.readDeadDaemon ||
      (stored.release_reason !== null && isTerminalReleaseReason(stored.release_reason))
    ) {
      return undefined;
    }
    return this.isConfirmedDeadDaemonSession(owner) ? owner : undefined;
  }

  /** True only when the live-daemon listing succeeded and does not name `daemonSessionId`. */
  private isConfirmedDeadDaemonSession(daemonSessionId: string): boolean {
    if (!this.liveDaemonSessionIds) {
      return false;
    }
    try {
      return !this.liveDaemonSessionIds().has(daemonSessionId);
    } catch (error) {
      logger.warn(
        `[SessionManager] Cannot list live daemons to check journal owner ${daemonSessionId}; ` +
          `its journal is not adopted yet: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
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

  private deviceHealth?: {
    markers: DeviceHealthMarkers;
    incarnation: (deviceId: string) => number | undefined;
    canRecover: (deviceId: string) => boolean;
    backoff: BackoffPolicy;
  };
  private readonly healthRecoveries = new Map<string, Promise<void>>();

  /** Optional pool wiring, preserving existing positional constructors. */
  setDeviceHealthMarkers(
    markers: DeviceHealthMarkers,
    incarnation: (deviceId: string) => number | undefined,
    canRecover: (deviceId: string) => boolean,
    backoff: BackoffPolicy = exponentialBackoff({ initialDelayMs: 1000 }),
  ): void {
    this.deviceHealth = { markers, incarnation, canRecover, backoff };
  }

  /**
   * A plan's app cleanup did not complete on this device. Marks it unhealthy so it cannot
   * be allocated dirty, and retries `retry` on the bounded health-recovery budget once the
   * device is idle; the marker clears when `retry` resolves. `retry` must run under its
   * own abort signal: the recovery inherits this call's (possibly aborted) ambient one.
   * `retryTimeoutMs` is the caller's real budget for one retry: a cleanup (`pm clear`,
   * simctl container removal, a physical-iOS reinstall) legitimately takes far longer than
   * the 1 s a settings restore gets, and a deadline shorter than the retry ends all retries
   * with the marker kept even though the retry would have succeeded.
   */
  markDeviceNeedsAppCleanup(
    deviceId: string,
    retry: () => Promise<void>,
    retryTimeoutMs: number,
  ): void {
    this.abandonRestore(
      { deviceId, incarnation: this.deviceHealth?.incarnation(deviceId) },
      "app-cleanup",
      retry,
      retryTimeoutMs,
    );
  }

  private restoreIncarnationIsCurrent(target: { deviceId: string; incarnation?: number }): boolean {
    return (
      target.incarnation === undefined ||
      this.deviceHealth?.incarnation(target.deviceId) === target.incarnation
    );
  }

  private clearRestoreHealth(
    target: { deviceId: string; incarnation?: number },
    reason: DeviceHealthReason,
  ): void {
    if (target.incarnation !== undefined && this.restoreIncarnationIsCurrent(target)) {
      this.deviceHealth?.markers.clear(target.deviceId, target.incarnation, reason);
    }
  }

  /**
   * Release cleanup settles first: this bounded recovery is deliberately NOT
   * pendingDeviceCleanup. Idle-but-marked devices cannot be allocated. Never
   * restore against a live owner (including a TTL's owner) or a replacement.
   */
  private abandonRestore(
    target: { deviceId: string; incarnation?: number },
    reason: Exclude<DeviceHealthReason, "clock">,
    restore: () => Promise<void>,
    restoreTimeoutMs: number = NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  ): void {
    const health = this.deviceHealth;
    if (target.incarnation === undefined) {
      logger.warn(
        `Gave up restoring state on ${target.deviceId} (${reason}); no health marker could be keyed because the device has no pool incarnation`,
      );
      return;
    }
    if (!health || !this.restoreIncarnationIsCurrent(target)) {
      return;
    }
    const marker = health.markers.mark(target.deviceId, target.incarnation, reason);
    const key = `${target.deviceId}#${target.incarnation}:${reason}`;
    if (this.healthRecoveries.has(key)) {
      return;
    }
    // Own context, never the caller's: this is started from a release that may be
    // running under an aborted request signal or an expired teardown shield, and a
    // recovery attempt that inherited it would fail before reaching the device (#10198).
    const recovery = runWithAbortSignal(undefined, async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await this.timer.sleep(health.backoff.delayForAttempt(attempt));
        if (!this.restoreIncarnationIsCurrent(target)) {
          return;
        }
        // A different unresolved reason may also exist; only clear our own.
        // Release or a successful TTL restore may already have satisfied this one.
        if (!health.markers.get(target.deviceId, target.incarnation!, reason)) {
          return;
        }
        if (!health.canRecover(target.deviceId)) {
          continue;
        }
        const timeout = new Error("Device health recovery timed out");
        // Async wrapper: a synchronous throw from `restore` becomes this attempt's rejection.
        const inFlight = (async () => restore())();
        try {
          // Later attempts get a scaled deadline: a device slow enough to miss the
          // first one is likely to need longer, not to fail outright (#11145).
          await raceWithDeadline(inFlight, {
            timer: this.timer,
            timeoutMs: restoreTimeoutMs * attempt,
            label: "Device health recovery",
            timeoutError: () => timeout,
          });
          this.clearRestoreHealth(target, reason);
          return;
        } catch (error) {
          logger.warn(
            `Device health recovery ${attempt} failed on ${target.deviceId} (${marker.reason})`,
            error,
          );
          // A timed-out command may still be running. Never issue an overlapping
          // retry: the marker stays while it runs, so no new session can race it.
          // Await it instead of giving up, so one slow command does not quarantine
          // the device until a kill/restart (#11145).
          if (error === timeout && (await this.inFlightRestoreSucceeded(inFlight, target))) {
            this.clearRestoreHealth(target, reason);
            return;
          }
        }
      }
    });
    this.healthRecoveries.set(key, recovery);
    void recovery
      .catch((error: unknown) => {
        logger.warn(`Device health recovery failed on ${target.deviceId}`, error);
      })
      .finally(() => {
        if (this.healthRecoveries.get(key) === recovery) {
          this.healthRecoveries.delete(key);
        }
      });
  }

  /** Settles a timed-out recovery command; true when it eventually completed. */
  private async inFlightRestoreSucceeded(
    inFlight: Promise<void>,
    target: { deviceId: string },
  ): Promise<boolean> {
    try {
      await inFlight;
      return true;
    } catch (error) {
      logger.warn(`Timed-out device health recovery failed late on ${target.deviceId}`, error);
      return false;
    }
  }

  private activeSessionExecutionChecker: ActiveSessionExecutionChecker = () => false;
  // No lookup means no known deadline: the veto falls back to the unsettled-execution ceiling.
  private sessionExecutionDeadlineLookup: SessionExecutionDeadlineLookup = () => undefined;
  // No canceller means nothing to abort: only the daemon tracks executions (#10820).
  private expiryReleaseExecutionCanceller: ExpiryReleaseExecutionCanceller = () => undefined;
  private deviceAcquisitionExecutionCanceller: DeviceAcquisitionExecutionCanceller = () =>
    undefined;
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
    // Resolve the shared barrier per write, not once at construction, so a
    // same-process DB reopen (resetDbWriteBarrier swaps in a fresh barrier) is
    // seen instead of a pinned drained instance (issue #2912). Because the barrier
    // is resolved per-write here, a same-process daemon restart (tests only) that
    // re-creates writer singletons needs no reconstruction of this SessionManager:
    // closeDatabase() -> resetDbWriteBarrier() cold-starts the barrier and the next
    // track() call picks it up. There is currently no in-process reopen path in
    // production; revisit this note if one is added (issue #3154, follow-up to #2885).
    getBarrier: () => DbWriteBarrier = getDbWriteBarrier,
    // Seam for keep-awake restore (issue #2973): defaults to the real manager;
    // tests inject a fake to assert the typed slot's payload reaches `restore`.
    keepScreenAwakeRestorerFactory: (device: BootedDevice) => KeepScreenAwakeRestorer = (device) =>
      new KeepScreenAwakeManager(device, defaultAdbClientFactory, (device) =>
        AndroidCtrlProxyClient.getInstance(device),
      ),
    // Simulator enrollment is session-scoped state. Keep this seam parallel to
    // keep-awake so lifecycle tests never invoke simctl.
    biometricEnrollmentRestorerFactory: (device: BootedDevice) => BiometricEnrollmentRestorer = (
      device,
    ) => ({
      restore: async (enrollment) => {
        const result = await new DeviceState(device).setBiometricEnrollmentState(enrollment);
        if (!result.supported || result.error || result.verified === false) {
          throw new Error(result.error ?? "Failed to restore iOS Simulator biometric enrollment");
        }
      },
    }),
    // Device-wide network conditioning is session-scoped state (issue #6012).
    // Keep this seam parallel to biometric/keep-awake so lifecycle tests never
    // invoke adb. The factories object also injects clock restoration while
    // preserving the existing positional network-restorer contract.
    // The default restores normal connectivity via the emulator
    // console; a released session must never leave a device impaired.
    networkConditionRestorerFactory:
      | ((device: BootedDevice) => NetworkConditionRestorer)
      | DeviceStateRestorerFactories = (device) => ({
      restore: async (profile) => {
        const result = await new DeviceState(device).setState({
          networkCondition: { profile },
        });
        if (!result.success) {
          throw new Error(
            result.networkCondition?.error ?? result.error ?? "Failed to restore network condition",
          );
        }
      },
    }),
  ) {
    this.timer = timer;
    this.sessionClock = new SteadyWallClock(timer);
    // Rows are read by other processes on their own session clocks: stamps cross as wall ms (#11162).
    this.deviceSessionRepository = onSessionClock(deviceSessionRepository, {
      toWall: (sessionClockMs) => this.sessionClockToWall(sessionClockMs),
      toSessionClock: (wallMs) => this.wallToSessionClock(wallMs),
    });
    this.getBarrier = getBarrier;
    this.keepScreenAwakeRestorerFactory = keepScreenAwakeRestorerFactory;
    this.biometricEnrollmentRestorerFactory = biometricEnrollmentRestorerFactory;
    this.networkConditionRestorerFactory =
      typeof networkConditionRestorerFactory === "function"
        ? networkConditionRestorerFactory
        : networkConditionRestorerFactory.networkCondition;
    this.clockRestorerFactory =
      typeof networkConditionRestorerFactory === "function"
        ? (device) => ({
            restore: async (value, signal) => {
              const adapter = new AndroidDeviceClockAdapter(
                defaultAdbClientFactory.create(device),
                signal,
              );
              const root = await adapter.ensureRoot();
              if (!root.success) {
                throw new Error(root.error);
              }
              value.rootedByUs ||= root.rootedByUs;
              const result = await restoreDeviceClock(device, adapter, value, {
                hostClock: this.timer,
                invalidate: (deviceId) => {
                  if (!signal?.aborted) {
                    invalidateDisplayCaches(deviceId, "Device clock restored");
                  }
                },
              });
              if (!result.verified) {
                throw new Error(result.error ?? "Clock restoration did not verify");
              }
            },
          })
        : networkConditionRestorerFactory.clock;
    this.rotationRestorerFactory =
      (typeof networkConditionRestorerFactory === "function"
        ? undefined
        : networkConditionRestorerFactory.rotation) ??
      ((device) => ({
        restore: (state, signal) =>
          new Rotate(device, null, this.timer).restoreRotationSettings(state, signal),
      }));
    this.screenReaderRestorerFactory = screenReaderRestorerFactoryFrom(
      networkConditionRestorerFactory,
    );
    this.screenReaderRestoreBackoff = screenReaderBackoffFrom(networkConditionRestorerFactory);
    this.rotationRestoreBackoff = rotationBackoffFrom(networkConditionRestorerFactory);
    this.injectedIosAppNetworkRuleRestorer =
      typeof networkConditionRestorerFactory === "function"
        ? undefined
        : networkConditionRestorerFactory.iosAppNetworkRule;
    this.iosAppNetworkLeases = new IosAppNetworkLeases(
      this.timer,
      () => this.iosAppNetworkRuleRestorer,
      {
        leaseMs: IOS_APP_NETWORK_RULE_LEASE_MS,
        renewIntervalMs: IOS_APP_NETWORK_RULE_RENEW_INTERVAL_MS,
      },
    );
    // Start periodic cleanup of expired sessions
    this.startCleanupTimer();
  }

  private recoveryExpiryReleaseHandler?: RecoveryExpiryReleaseHandler;

  setRecoveryExpiryReleaseHandler(handler: RecoveryExpiryReleaseHandler): void {
    this.recoveryExpiryReleaseHandler = handler;
  }

  /**
   * The `Timer` this manager was constructed with (issue #7541). Lets
   * call sites that already receive a `SessionManager` — e.g.
   * `ToolExecutionContext`'s device-readiness setup — reuse the same
   * injected `Timer` (a `FakeTimer` in tests) instead of hard-wiring
   * `defaultTimer`, so retry/backoff delays on that path stay fake-clock
   * testable rather than sleeping in real time.
   */
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
    if (ownGate) {
      const work = Array.from(this.pendingDeviceCleanupWork.get(deviceId) ?? []).filter(
        (cleanup) => cleanup !== ownGate,
      );
      return work.length > 0 ? Promise.allSettled(work).then(() => undefined) : null;
    }
    return this.pendingDeviceCleanups.get(deviceId) ?? null;
  }

  /** Wait for the device work that outlived release, without blocking shutdown indefinitely. */
  async drainPendingDeviceCleanups(timeoutMs: number): Promise<boolean> {
    this.flushDeferredRebindCleanups();
    const cleanups = [
      ...this.pendingDeviceCleanups.values(),
      ...this.acquisitionDeviceCleanups.values(),
    ];
    if (cleanups.length === 0) {
      return true;
    }
    const timedOut = Symbol("device cleanup drain timeout");
    try {
      await raceWithDeadline(Promise.allSettled(cleanups), {
        timer: this.timer,
        timeoutMs,
        label: "Device cleanup drain",
        timeoutError: () => timedOut,
      });
      return true;
    } catch (error) {
      if (error !== timedOut) {
        throw toActionableError(error, "Failed to drain pending device cleanups");
      }
      logger.warn(`Timed out after ${timeoutMs}ms draining pending device cleanups`);
      return false;
    }
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
    /** The cleanup's own cap, when it has one: it bounds the retry hint a refused bind gets. */
    capMs?: number,
  ): void {
    if (capMs !== undefined) {
      const settlesBy = this.sessionNow() + capMs;
      const previous = this.pendingDeviceCleanupSettlesBy.get(deviceId) ?? 0;
      this.pendingDeviceCleanupSettlesBy.set(deviceId, Math.max(previous, settlesBy));
    }
    this.trackPendingDeviceCleanup(deviceId, [cleanup]);
  }

  /**
   * How long a bind refused by {@link hasDeviceCleanupInProgress} should wait before retrying
   * (#10960): the remaining time of the cleanup's cap or of the in-flight release's bounded
   * teardown and persist phases, or a default polling hint when nothing bounds it. An acquisition
   * cleanup counts once it quarantines the device, that is once its holder is gone (#11616).
   */
  getDeviceCleanupRetryAfterMs(deviceId: string): number {
    const now = this.sessionNow();
    const bounds = Array.from(this.activeReleasePromises)
      .filter((release) => !release.forced && release.session.assignedDevice === deviceId)
      .map(
        (release) =>
          (release.startedAtMs ?? now) +
          SESSION_RELEASE_TEARDOWN_CAP_MS +
          SESSION_RELEASE_PERSIST_TIMEOUT_MS,
      );
    const cleanupBound = this.pendingDeviceCleanups.has(deviceId)
      ? this.pendingDeviceCleanupSettlesBy.get(deviceId)
      : undefined;
    if (cleanupBound !== undefined) {
      bounds.push(cleanupBound);
    }
    const acquisitionBound =
      this.acquisitionDeviceCleanups.has(deviceId) && this.getSessionForDevice(deviceId) === null
        ? this.acquisitionDeviceCleanupSettlesBy.get(deviceId)
        : undefined;
    if (acquisitionBound !== undefined) {
      bounds.push(acquisitionBound);
    }
    const remaining = Math.max(0, ...bounds.map((bound) => bound - now));
    return remaining > 0 ? remaining : DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS;
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
    if (capMs !== undefined) {
      const settlesBy = this.sessionNow() + capMs;
      const previous = this.acquisitionDeviceCleanupSettlesBy.get(deviceId) ?? 0;
      this.acquisitionDeviceCleanupSettlesBy.set(deviceId, Math.max(previous, settlesBy));
    }
    const tracked = Promise.allSettled([cleanup]).then(() => undefined);
    const previous = this.acquisitionDeviceCleanups.get(deviceId);
    const combined = previous
      ? Promise.allSettled([previous, tracked]).then(() => undefined)
      : tracked;
    this.acquisitionDeviceCleanups.set(deviceId, combined);
    void combined.then(() => {
      if (this.acquisitionDeviceCleanups.get(deviceId) === combined) {
        this.acquisitionDeviceCleanups.delete(deviceId);
        this.acquisitionDeviceCleanupSettlesBy.delete(deviceId);
      }
    });
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
      (this.acquisitionDeviceCleanups.has(deviceId) &&
        this.getSessionForDevice(deviceId) === null) ||
      Array.from(this.activeReleasePromises).some(
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
    return Array.from(this.activeReleasePromises)
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
    return Array.from(this.releasePromises.values())
      .filter(
        (release) =>
          this.activeReleasePromises.has(release) &&
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
   * Whether the release of `sessionId` that started at `startedAtMs` (session clock) is still
   * running and still holds its device, whatever reason it carries now (#11554). The heartbeat
   * monitor asks this of a release it tracks once that release leaves the lists above: one a
   * joiner upgraded to a terminal reason is still the same wedged release and stays held to its
   * stuck deadline, while one that settled or was forced is over.
   */
  isReleaseInProgress(sessionId: string, startedAtMs: number): boolean {
    return Array.from(this.activeReleasePromises).some(
      (release) =>
        !release.forced &&
        release.session.sessionId === sessionId &&
        release.startedAtMs === startedAtMs,
    );
  }

  /**
   * A release forced while it waited to start (#10963): the device may already belong to the next
   * owner, so no teardown may touch it. The force itself persists the fence it raised (#11058).
   */
  private async finishReleaseForcedBeforeStart(session: Session): Promise<null> {
    this.releasingSessions.delete(session);
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
    const operation = this.releasePromises.get(sessionId);
    if (!operation || operation.forced || !this.activeReleasePromises.has(operation)) {
      return undefined;
    }
    const { session } = operation;
    const deviceId = session.assignedDevice;
    operation.forced = true;
    // Stop every restore the stuck release started: the device is about to go back to the pool.
    operation.forcedAbort?.abort(
      new ActionableError(`Release of session ${sessionId} was forced; its teardown is abandoned`),
    );
    const fence = this.forcedReleaseSnapshot(sessionId, session, operation.reason.value);
    if (this.removeSession(sessionId, session)) {
      // The stuck release never reached its own notification: announce the release now so
      // proxies and stream servers stop treating the session as live.
      const snapshot = { ...fence, ...managedExecutionReleaseMarker(session) };
      if (isDeviceRestartReleaseReason(fence.releaseReason)) {
        // The callback's copy and the persisted fence must confirm the same row write.
        const persistence =
          this.restartReleasePersistence.get(fence) ?? Promise.withResolvers<void>();
        this.restartReleasePersistence.set(fence, persistence);
        this.restartReleasePersistence.set(snapshot, persistence);
      }
      this.notifySessionRelease(snapshot);
    }
    // The stuck release may never reach its own write: persist the release now (#11058), or a
    // restart would admit a terminally released UUID again.
    this.persistForcedReleaseFence(fence);
    const settled = operation.promise.then(
      () => undefined,
      () => undefined,
    );
    const capped = raceWithDeadline(settled, {
      timer: this.timer,
      timeoutMs: SESSION_RELEASE_TEARDOWN_CAP_MS,
      unref: true,
      label: "Forced stuck release",
    }).catch((error: unknown) => {
      // Reaching the cap is the expected outcome for a release that stays wedged: the device is
      // returned anyway, and the release's own stage was already reported above.
      logger.debug(`[SessionManager] Forced release of ${sessionId}: ${errorMessage(error)}`);
    });
    this.trackPendingDeviceCleanup(deviceId, [capped]);
    logger.warn(
      `[SessionManager] Forcing the stuck release of session ${sessionId} ` +
        `(stage=${operation.stage ?? "unknown"}, reason=${fence.releaseReason}): the session ` +
        `${fence.terminal ? "stays fenced" : "is released"} and device ` +
        `${deviceId} returns to the pool after at most ${SESSION_RELEASE_TEARDOWN_CAP_MS}ms`,
    );
    return { deviceId, stage: operation.stage };
  }

  /**
   * What a forced release releases the session as (#11361): the reason the stuck release was
   * started with, exactly as that release would have recorded it. A terminal reason raises (or
   * keeps) the in-memory fence; a non-terminal one (a `daemon-shutdown` or `device-restart:`
   * handoff, a `plan-auto-release`) raises none, so the session stays recoverable or its name
   * re-issuable as the reason says. Forcing only stops the wait for the device.
   */
  private forcedReleaseSnapshot(
    sessionId: string,
    session: Session,
    releaseReason: string,
  ): SessionReleaseSnapshot {
    const held = this.terminalReleaseSnapshots.get(sessionId);
    if (held) {
      return held;
    }
    const releasedAtMs = this.sessionNow();
    const snapshot: SessionReleaseSnapshot = {
      sessionId,
      deviceId: session.assignedDevice,
      releaseReason,
      releasedAtMs,
      terminal: isTerminalReleaseReason(releaseReason),
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
    if (snapshot.terminal) {
      this.terminalReleaseSnapshots.set(sessionId, snapshot);
    } else {
      // Applies only to the incarnation it released, like any non-terminal release (#11129).
      this.captureReleaseRowGeneration(snapshot, this.persistedRowGenerations.get(session));
      this.forcedNonTerminalReleases.set(session, snapshot);
    }
    return snapshot;
  }

  /**
   * The in-flight release a later call for this UUID must wait on or join. A release forced with a
   * non-terminal reason (#11361) is not one: it already released the session and raised no fence,
   * so a recovery, a re-issue of the name or a later release of it must not wait on a teardown
   * that may stay wedged. A release forced with a terminal reason is answered by its fence first.
   */
  private inFlightReleaseStillOwning(sessionId: string): SessionReleaseOperation | undefined {
    const operation = this.releasePromises.get(sessionId);
    return operation?.forced && !this.terminalReleaseSnapshots.has(sessionId)
      ? undefined
      : operation;
  }

  /**
   * Write a forced release's row in the background, tracked by the shutdown drain. A terminal
   * write that fails falls back to the terminal-write retry (#10959); one that times out is
   * already retried by the late-write tracker if it then fails. A non-terminal write that fails
   * stays pending in {@link persistSessionRelease} and is handed to the existing row retry.
   */
  private persistForcedReleaseFence(fence: SessionReleaseSnapshot): void {
    const write = this.persistSessionRelease(fence).then(
      () => undefined,
      (error: unknown) => {
        logger.warn(
          `[SessionManager] Failed to persist the forced release of ${fence.sessionId}: ` +
            errorMessage(error),
        );
        if (fence.terminal && !(error instanceof SessionReleasePersistTimeoutError)) {
          this.scheduleTerminalReleaseRetry(fence);
        } else if (!fence.terminal && !(error instanceof SessionReleasePersistTimeoutError)) {
          this.trackReleaseDrainWrite(this.retryNonTerminalRowAfterRelease(fence));
        }
      },
    );
    this.trackReleaseDrainWrite(write);
  }

  /**
   * Keep sessions assigned while their work is still running, even if their
   * idle timeout elapses. The daemon supplies the execution tracker; tests can
   * inject a deterministic checker.
   */
  setActiveSessionExecutionChecker(checker: ActiveSessionExecutionChecker): void {
    this.activeSessionExecutionChecker = checker;
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
    timeoutMs?: number,
    heartbeatTimeoutMs?: number,
    stableDeviceId?: string,
    recoveredLiveness?: SessionRecoveryLiveness,
    initialOwnership: "owned" | "awaiting-owner" = "owned",
    /** Persisted `source` recording who created the session; a rehydrated row's own wins. */
    persistenceSource?: string,
  ): Promise<Session> {
    getAbortSignal()?.throwIfAborted();
    if (!this.acceptingSessionCreations) {
      throw new DaemonSessionCreationRejectedError(sessionId);
    }
    this.assertTerminalReleaseAdmission(sessionId, this.sessions.get(sessionId));
    this.liftPlanLabelFenceForMint(sessionId);
    let terminalRelease = this.terminalReleaseSnapshots.get(sessionId);
    if (terminalRelease) {
      throw new TerminalSessionError(sessionId, terminalRelease);
    }
    if (this.sessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already exists, returning existing session`);
      return this.sessions.get(sessionId)!;
    }
    this.refuseLabelMintOutsidePlanAllocation(sessionId, assignedDevice);
    const activeReleases = Array.from(this.activeReleasePromises)
      .filter((release) => release.session.sessionId === sessionId)
      .map((release) => release.promise);
    if (activeReleases.length > 0) {
      await this.withinCreateDeadline(sessionId, assignedDevice, Promise.all(activeReleases));
      this.assertTerminalReleaseAdmission(sessionId, this.sessions.get(sessionId));
      // The release just awaited ended the label's previous run, not this one.
      this.liftPlanLabelFenceForMint(sessionId);
      terminalRelease = this.terminalReleaseSnapshots.get(sessionId);
      if (terminalRelease) {
        throw new TerminalSessionError(sessionId, terminalRelease);
      }
    }

    const pendingCreation = this.pendingSessionCreations.get(sessionId);
    if (pendingCreation) {
      return await this.withinCreateDeadline(sessionId, assignedDevice, pendingCreation.promise);
    }

    const now = this.sessionNow();
    const persistedRecovery = this.pendingPersistedRecoveries.get(sessionId);
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
    creation.promise = this.persistAndPublishSession(
      session,
      creation,
      this.claimedIncarnation(persistedRecovery),
    );
    this.pendingSessionCreations.set(sessionId, creation);
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
      await this.retryAbandonedRotationRestore(created.assignedDevice);
      await this.retryAbandonedScreenReaderRestore(created.assignedDevice);
      return created;
    } finally {
      if (this.pendingSessionCreations.get(sessionId) === creation) {
        this.pendingSessionCreations.delete(sessionId);
      }
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

  /**
   * Race one of a creation's waits against {@link SESSION_CREATE_WAIT_TIMEOUT_MS} (#10963). On
   * timeout the caller gets a typed retryable error and `onTimeout` runs; the wait itself is not
   * cancelled.
   */
  private async withinCreateDeadline<T>(
    sessionId: string,
    deviceId: string,
    wait: Promise<T>,
    onTimeout?: () => void,
  ): Promise<T> {
    return await raceWithDeadline(wait, {
      timer: this.timer,
      timeoutMs: SESSION_CREATE_WAIT_TIMEOUT_MS,
      unref: true,
      label: "Session creation",
      timeoutError: () =>
        new SessionCreationTimeoutError(sessionId, deviceId, SESSION_CREATE_WAIT_TIMEOUT_MS),
      onTimeout: () => {
        logger.warn(
          `[SessionManager] Creating session ${sessionId} did not finish within ` +
            `${SESSION_CREATE_WAIT_TIMEOUT_MS}ms (reason=${SESSION_CREATION_TIMEOUT_REASON}); ` +
            "refusing it so the device and the assignment mutex are freed",
        );
        onTimeout?.();
      },
    });
  }

  /** The claimed incarnation a recovery's upsert is conditioned on, when `row` is a claim. */
  private claimedIncarnation(row: DeviceSession | undefined): ClaimedCreationRow | undefined {
    if (!row || !this.claimedRecoverableRows.has(row)) {
      return undefined;
    }
    return {
      rowGeneration: row.stable_identity_generation ?? 0,
      daemonSessionId: row.daemon_session_id ?? null,
      releaseReason: row.release_reason ?? undefined,
      releasedAtMs: row.released_at_ms ?? undefined,
    };
  }

  /**
   * Persist a new session; a recovery of a claimed row writes only while the row is still its claim
   * (#11243). The terminal-row check before this write cannot fence a peer's terminal release that
   * lands between them; the conditioned upsert does, and that release ends this recovery as terminal.
   */
  private async persistCreatedSession(
    session: Session,
    claimedRow: RecoverableRowIncarnation | undefined,
  ): Promise<void> {
    try {
      await this.persistSession(session, session, claimedRow && { claimedRow });
    } catch (error) {
      if (!(error instanceof DeviceSessionRowChangedError)) {
        throw error;
      }
      const current = await this.readPersistedSession(session.sessionId);
      const terminalRelease = this.unlessBeingReplaced(
        current && this.terminalReleaseFromPersisted(session.sessionId, current),
      );
      if (terminalRelease) {
        this.terminalReleaseSnapshots.set(session.sessionId, terminalRelease);
        throw new TerminalSessionError(session.sessionId, terminalRelease);
      }
      const owner = current?.daemon_session_id ?? null;
      if (owner !== null && owner !== this.daemonSessionId) {
        logger.info(
          `[SessionManager] Not recovering session ${session.sessionId}: another AutoMobile ` +
            `daemon (${owner}) took its row during the recovery`,
        );
        throw new DeviceOwnedByOtherDaemonError(session.assignedDevice, undefined);
      }
      throw error;
    }
  }

  private async persistAndPublishSession(
    session: Session,
    creation?: PendingSessionCreation,
    claimedRow?: ClaimedCreationRow,
  ): Promise<Session> {
    try {
      return await this.publishSessionCreation(session, creation, claimedRow);
    } catch (error) {
      await this.rollBackFailedCreationRow(session, claimedRow);
      throw error;
    }
  }

  private async publishSessionCreation(
    session: Session,
    creation?: PendingSessionCreation,
    claimedRow?: ClaimedCreationRow,
  ): Promise<Session> {
    // A plan run minting its label writes over the row its previous run left, terminal or not.
    const persistedTerminalRelease = this.planLabelMints.has(session.sessionId)
      ? undefined
      : this.unlessBeingReplaced(await this.getPersistedTerminalRelease(session.sessionId));
    if (persistedTerminalRelease) {
      this.terminalReleaseSnapshots.set(session.sessionId, persistedTerminalRelease);
      throw new TerminalSessionError(session.sessionId, persistedTerminalRelease);
    }
    this.assertCreationNotAbandoned(session, creation);
    await this.rejectCreationAfterShutdownFence(session, false, claimedRow);
    await this.persistCreatedSession(session, claimedRow);
    await this.retireCreationIfAbandoned(session, creation);
    await this.rejectCreationAfterShutdownFence(session, true, claimedRow);
    this.assertTerminalReleaseAdmission(session.sessionId, session);
    const terminalRelease = this.terminalReleaseSnapshots.get(session.sessionId);
    if (terminalRelease) {
      await this.persistSessionRelease(terminalRelease);
      throw new TerminalSessionError(session.sessionId, terminalRelease);
    }
    this.invalidateFinalizedSessionIdentity(session.sessionId);
    this.pendingNonTerminalReleaseSnapshots.delete(session.sessionId);
    // A client that registered as an observer before acquiring a device keeps its name (#10671).
    const observerClientName = this.observerSessions
      ?.list?.()
      .find((observer) => observer.sessionId === session.sessionId)?.clientName;
    if (observerClientName !== undefined && session.clientName === undefined) {
      session.clientName = observerClientName;
    }
    this.observerSessions?.release(session.sessionId, "promotion");
    if (session.persistenceMetadata?.source === PLAN_LABEL_SESSION_SOURCE) {
      this.runningPlanLabelSessions.add(session.sessionId);
    }
    this.sessions.set(session.sessionId, session);
    this.sessionDeviceMap.set(session.sessionId, session.assignedDevice);
    this.deviceSessionMap.set(session.assignedDevice, session.sessionId);
    this.cancelSessionlessUseOnAcquisition(session.assignedDevice, session.sessionId);
    // Generation only: publishing an owner changes entitlement, not the screen/connection.
    this.notifyDeviceOwnershipChange(session.assignedDevice);
    this.notifySessionCreated(session);
    logger.info(`Created session ${session.sessionId} with device ${session.assignedDevice}`);
    return session;
  }

  /** An unpublished creation owns only the generation its upsert wrote, never a successor's row. */
  private async rollBackFailedCreationRow(
    session: Session,
    claimedRow?: ClaimedCreationRow,
  ): Promise<void> {
    const generation = this.persistedRowGenerations.get(session);
    if (
      generation === undefined ||
      this.sessions.get(session.sessionId) === session ||
      this.retiredCreationRows.has(session) ||
      this.terminalReleaseSnapshots.has(session.sessionId)
    ) {
      return;
    }
    this.retiredCreationRows.add(session);
    const snapshot = this.creationRowRollbackSnapshot(
      session,
      claimedRow?.releaseReason ?? "allocation-rollback",
      claimedRow?.releasedAtMs,
    );
    this.captureReleaseRowGeneration(snapshot, generation);
    await this.persistCreationRollback(snapshot);
  }

  private async persistCreationRollback(snapshot: SessionReleaseSnapshot): Promise<void> {
    try {
      await this.persistSessionRelease(snapshot);
    } catch (error) {
      // Persistence already logged the storage failure; rollback remains owed without replacing the caller's error.
      logger.debug(`[SessionManager] Creation rollback remains owed: ${errorMessage(error)}`);
      this.trackReleaseDrainWrite(this.retryNonTerminalRowAfterRelease(snapshot));
    }
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

  /**
   * A creation abandoned at its deadline whose write landed afterwards (#10963): its caller was
   * refused and its pool claim rolled back, so it must not publish, and its active row must not
   * let a restart rehydrate it. Unless a retry is re-creating the UUID, record a non-terminal
   * release (the caller may retry with the same UUID), then refuse.
   */
  /** An abandoned creation refused before anything was written has nothing to retire. */
  private assertCreationNotAbandoned(session: Session, creation?: PendingSessionCreation): void {
    if (creation?.abandoned) {
      throw new SessionCreationTimeoutError(
        session.sessionId,
        session.assignedDevice,
        SESSION_CREATE_WAIT_TIMEOUT_MS,
      );
    }
  }

  private async retireCreationIfAbandoned(
    session: Session,
    creation?: PendingSessionCreation,
  ): Promise<void> {
    if (creation?.abandoned) {
      await this.retireAbandonedCreation(session);
    }
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
  ): Promise<void> {
    const cancellation = getAbortSignal();
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
    this.terminalReleaseSnapshots.set(session.sessionId, fence);
    this.restartRecoveryActivityAt.delete(session.sessionId);
    if (!rowWritten) {
      this.terminalReleaseJournal.record({
        sessionId: fence.sessionId,
        reason: fence.releaseReason,
        at: this.sessionClockToWall(fence.releasedAtMs),
      });
      this.terminalReleaseJournal.resolve(fence.sessionId, fence.releaseReason);
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

  /** The persisted row, with tool activity during a device-restart recovery applied to its expiry. */
  private async readPersistedSession(sessionId: string): Promise<DeviceSession | undefined> {
    let stored = await this.deviceSessionRepository.getSession?.(sessionId);
    if (stored && (await this.adoptDeadOwnerTerminalReleases(stored))) {
      // The adopted releases were just written; this read predates them.
      stored = await this.deviceSessionRepository.getSession?.(sessionId);
    }
    const persisted = stored && this.withRecoveredTerminalRelease(stored);
    const activityAt = this.restartRecoveryActivityAt.get(sessionId);
    if (!persisted || activityAt === undefined || !isDeviceRestartReleasedRow(persisted)) {
      return persisted;
    }
    return {
      ...persisted,
      expires_at_ms: Math.max(persisted.expires_at_ms, activityAt + persisted.session_timeout_ms),
    };
  }

  /** Allow the pool to re-arm its idle hold when an admitted call records recovery activity. */
  onRestartRecoveryActivity(callback: (sessionId: string, atMs: number) => void): void {
    this.restartRecoveryActivityCallbacks.push(callback);
  }

  /**
   * A control call started, joined or ended against a session waiting out a device restart.
   *
   * The in-memory mark applies at once (see {@link readPersistedSession}); the durable write
   * (#10713) lets the extended expiry survive a daemon restart during the device restart, which
   * would otherwise fall back to the expiry stored at the device loss.
   */
  private recordRestartRecoveryActivity(sessionId: string): void {
    const activityAt = Math.max(
      this.restartRecoveryActivityAt.get(sessionId) ?? 0,
      this.sessionNow(),
    );
    this.restartRecoveryActivityAt.set(sessionId, activityAt);
    for (const callback of this.restartRecoveryActivityCallbacks) {
      try {
        callback(sessionId, activityAt);
      } catch (error) {
        logger.warn(`[SessionManager] Restart activity callback failed for ${sessionId}: ${error}`);
      }
    }
    void this.getBarrier()
      .track(async () => {
        await this.deviceSessionRepository.recordRestartRecoveryActivity?.(sessionId, activityAt);
      })
      .catch((error) => {
        // The in-memory mark still governs this process; only a daemon restart before the next
        // activity write would fall back to the stored expiry.
        logger.warn(
          `[SessionManager] Failed to persist restart-recovery activity for ${sessionId}: ` +
            errorMessage(error),
        );
      });
  }

  /** Read-only admission probe; recovery itself remains owned by getOrCreateSession. */
  async isReleasedSessionInRestartRecoveryWindow(sessionId: string): Promise<boolean> {
    if (this.terminalReleaseSnapshots.has(sessionId)) {
      return false;
    }
    const persisted = await this.readPersistedSession(sessionId);
    if (
      !persisted ||
      this.terminalReleaseSnapshots.has(sessionId) ||
      !this.isReissuablePersistedSession(persisted)
    ) {
      return false;
    }
    const deadline = restartRecoveryDeadlineFromPersisted(persisted);
    return deadline !== undefined && this.sessionNow() < deadline;
  }

  /**
   * Recheck a pool hold at its idle deadline. Local recovery calls and live peer claims retain
   * the cold-boot window; foreign-owned rows are never terminalized here. Expiry of our row is
   * guarded against an owner or generation change between this read and its write.
   */
  async expireRestartRecoveryReservation(sessionId: string): Promise<number | undefined> {
    const persisted = await this.readPersistedSession(sessionId);
    if (!persisted || !isDeviceRestartReleasedRow(persisted)) {
      return undefined;
    }
    const hasForeignOwner = (row: DeviceSession) =>
      this.daemonSessionId !== undefined &&
      (row.daemon_session_id ?? this.daemonSessionId) !== this.daemonSessionId;
    const livePeerDeadline = (row: DeviceSession) => {
      const deadline = restartRecoveryDeadlineFromPersisted(row, true)!;
      return this.isRowOwnedByLivePeer(row) && this.sessionNow() < deadline ? deadline : undefined;
    };
    if (hasForeignOwner(persisted)) {
      return livePeerDeadline(persisted);
    }
    const callerInFlight =
      this.isSessionBeingRecreated(sessionId) || this.activeSessionExecutionChecker(sessionId);
    const deadline = restartRecoveryDeadlineFromPersisted(persisted, callerInFlight)!;
    if (this.sessionNow() < deadline) {
      return deadline;
    }
    if (!callerInFlight) {
      const current = await this.terminalizeExpiredPersistedSession(
        persisted,
        persisted.daemon_session_id === this.daemonSessionId ? this.daemonSessionId : undefined,
      );
      // The conditional expiry write may lose to activity or a peer claiming the row.
      if (current && isDeviceRestartReleasedRow(current)) {
        if (hasForeignOwner(current)) {
          return livePeerDeadline(current);
        }
        const extendedDeadline = restartRecoveryDeadlineFromPersisted(current)!;
        if (this.sessionNow() < extendedDeadline) {
          return extendedDeadline;
        }
      }
    }
    return undefined;
  }

  private async getPersistedTerminalRelease(
    sessionId: string,
  ): Promise<SessionReleaseSnapshot | undefined> {
    const persisted = await this.readPersistedSession(sessionId);
    return persisted ? this.terminalReleaseFromPersisted(sessionId, persisted) : undefined;
  }

  /**
   * #6069, #11418: True when a call naming this persisted row's UUID may issue
   * the session again with a pooled device: an active row, or one released for a
   * re-issuable-by-name reason (a daemon/device handoff, or a plan's
   * `plan-auto-release`), that has not expired. Terminal reasons and the
   * never-reissuable ones (`superseded`, `allocation-rollback`, ...) are refused,
   * as is a missing row. This is wider than startup rehydration, which only takes
   * the recoverable handoffs. The claim and the claimed-row upsert share it.
   */
  private isReissuablePersistedSession(
    persisted: DeviceSession | undefined,
    callerInFlight = false,
  ): boolean {
    return Boolean(
      persisted &&
      (!persisted.release_reason || isReissuableByNameReleaseReason(persisted.release_reason)) &&
      isRecoverableDeviceSession(persisted, this.sessionNow()) &&
      (callerInFlight ||
        this.isRowOwnedByLivePeer(persisted) ||
        !hasLapsedRestartRecoveryWindow(persisted, this.sessionNow())),
    );
  }

  /**
   * The narrower startup-rehydration predicate (#11418): an active row, or one released for a
   * recoverable handoff, that has not expired. A `plan-auto-release` row is re-issuable by name
   * but is never rehydrated, so a finished plan's session does not come back to hold its device.
   * Neither is any row of a plan's derived label session (#11572), live or released for a handoff
   * (`daemon-shutdown`, `device-restart:`): its plan run ended with the daemon that ran it, so
   * nothing would own, heartbeat or release it. Its device is free for the next plan run.
   */
  private isRecoverablePersistedSession(persisted: DeviceSession | undefined): boolean {
    return Boolean(
      persisted &&
      persisted.source !== PLAN_LABEL_SESSION_SOURCE &&
      (!persisted.release_reason || isRecoverableDaemonReleaseReason(persisted.release_reason)) &&
      isRecoverableDeviceSession(persisted, this.sessionNow()) &&
      !hasLapsedRestartRecoveryWindow(persisted, this.sessionNow()),
    );
  }

  /**
   * True for a row that is re-issued rather than recovered (#11418): released for a reason that
   * is re-issuable by name but not recoverable (`plan-auto-release`). Its plan already gave the
   * device up, so the session has no device identity to keep: the re-issue prefers the old device
   * and otherwise takes any device ordinary allocation would, instead of ending the UUID.
   */
  private isNameReissueOnlyRow(persisted: DeviceSession | undefined): boolean {
    return Boolean(
      persisted?.release_reason &&
      !isRecoverableDaemonReleaseReason(persisted.release_reason) &&
      this.isReissuablePersistedSession(persisted),
    );
  }

  /**
   * Mark a row found past its deadline `expired`, and resolve with the row as it stands afterwards
   * (the row given when nothing was written). The write is conditioned, in the statement, on the
   * deadline still being at or before the instant it was judged at (#11498): an activity write by
   * the row's owner does not advance the generation, so a lease or a device-restart recovery
   * window it extended after this read would otherwise be released anyway. The caller answers from
   * the returned row, never from the one it read before the write.
   */
  private async terminalizeExpiredPersistedSession(
    persisted: DeviceSession | undefined,
    onlyIfOwnedByDaemon?: string,
  ): Promise<DeviceSession | undefined> {
    const now = this.sessionNow();
    if (
      persisted &&
      hasLapsedRestartRecoveryWindow(persisted, now) &&
      this.isRowOwnedByLivePeer(persisted)
    ) {
      return persisted;
    }
    if (persisted && persistedSessionExpiryReason(persisted, now) === "restart-recovery-timeout") {
      return this.terminalizeRestartRecoveryHandoff(persisted, onlyIfOwnedByDaemon);
    }
    if (
      !persisted ||
      persisted.expires_at_ms > now ||
      (persisted.release_reason && isTerminalReleaseReason(persisted.release_reason))
    ) {
      return persisted;
    }
    // Only the row judged expired: a peer may re-upsert the UUID after this read (#11129).
    await this.deviceSessionRepository.markReleased(
      persisted.session_uuid,
      "expired",
      now,
      "expired",
      {
        ...(persisted.stable_identity_generation === undefined
          ? {}
          : { expectedRowGeneration: persisted.stable_identity_generation }),
        // The repository compares stored stamps, which are wall ms; the session-clock wrapper
        // converts the release stamp but passes options through as given. A stamp this daemon
        // wrote itself is judged above as the session-clock instant it was written from (#11358),
        // so after a wall step the statement can disagree with that judgement by the step; then
        // nothing is written and the row is still answered as it reads below.
        onlyIfExpiredAtMs: this.sessionClockToWall(now),
        onlyIfOwnedByDaemon,
      },
    );
    const current = await this.readPersistedSession(persisted.session_uuid);
    this.confirmPersistedExpiry(persisted, current, "expired");
    if (!this.isReissuablePersistedSession(current)) {
      this.restartRecoveryActivityAt.delete(persisted.session_uuid);
    }
    return current;
  }

  /** Terminalize only this daemon's still-recoverable handoff after a confirmed sessionless stop. */
  async terminalizeDeviceRestartHandoffForStop(sessionId: string): Promise<boolean> {
    const persisted = await this.readPersistedSession(sessionId);
    if (
      !persisted ||
      !isDeviceRestartReleasedRow(persisted) ||
      this.sessions.has(sessionId) ||
      this.isSessionBeingRecreated(sessionId) ||
      this.daemonSessionId === undefined ||
      persisted.daemon_session_id !== this.daemonSessionId
    ) {
      logger.warn(
        `[SessionManager] Cannot terminalize stopped restart holder ${sessionId}: row is no longer this daemon's handoff`,
      );
      return false;
    }
    const current = await this.terminalizeRestartRecoveryHandoff(
      { ...persisted },
      this.daemonSessionId,
      "device-killed",
    );
    const confirmed =
      current?.release_reason === "device-killed" &&
      current.stable_identity_generation === persisted.stable_identity_generation;
    if (!confirmed) {
      logger.warn(
        `[SessionManager] Stopped restart holder ${sessionId} terminal row write was not confirmed`,
      );
    }
    return confirmed;
  }

  /** A conditional handoff expiry uses the terminal journal, but fences only a confirmed row. */
  private async terminalizeRestartRecoveryHandoff(
    persisted: DeviceSession,
    onlyIfOwnedByDaemon?: string,
    reason: "restart-recovery-timeout" | "device-killed" = "restart-recovery-timeout",
  ): Promise<DeviceSession | undefined> {
    let livePeerDaemonSessionIds: string[];
    try {
      livePeerDaemonSessionIds = this.rowWriteLivePeerDaemonSessionIds();
    } catch (error) {
      logger.warn(
        `[SessionManager] Cannot prove ownership to expire restart recovery for ` +
          `${persisted.session_uuid}: ${errorMessage(error)}`,
        error,
      );
      // Refuse from the row as read, without a write, journal intent, fence or release notice.
      return persisted;
    }
    const snapshot = this.releaseSnapshotFromPersisted(persisted.session_uuid, persisted, reason);
    snapshot.releasedAtMs = this.sessionNow();
    const recoveryWindowMs = reason === "device-killed" ? 0 : DEVICE_RESTART_RECOVERY_WINDOW_MS;
    await this.persistSessionRelease(snapshot, false, {
      expectedRowGeneration: persisted.stable_identity_generation ?? 0,
      onlyIfRecoverable: true,
      onlyIfOwnedByDaemon: onlyIfOwnedByDaemon ?? persisted.daemon_session_id ?? undefined,
      unlessTerminalOrOwnedByLivePeer: {
        livePeerDaemonSessionIds,
        reportRefusal: true,
      },
      onlyIfRestartRecoveryHandoff: {
        releasedAtOrBeforeMs: this.sessionClockToWall(snapshot.releasedAtMs - recoveryWindowMs),
        recoveryWindowMs,
      },
    });
    const current = await this.readPersistedSession(persisted.session_uuid);
    this.confirmPersistedExpiry(persisted, current, reason);
    return current;
  }

  /** Only the confirmed release of the generation read may end the local reservation. */
  private confirmPersistedExpiry(
    persisted: DeviceSession,
    current: DeviceSession | undefined,
    reason: "expired" | "restart-recovery-timeout" | "device-killed",
  ): void {
    if (
      this.terminalReleaseSnapshots.has(persisted.session_uuid) ||
      current?.release_reason !== reason ||
      current.stable_identity_generation !== persisted.stable_identity_generation
    ) {
      return;
    }
    const snapshot =
      reason === "expired"
        ? this.expiredReleaseFromPersisted(persisted.session_uuid, current)
        : this.terminalReleaseFromPersisted(persisted.session_uuid, current);
    if (snapshot) {
      this.terminalReleaseSnapshots.set(persisted.session_uuid, snapshot);
      this.restartRecoveryActivityAt.delete(persisted.session_uuid);
      this.notifySessionRelease(snapshot, { upgradeOnly: true });
    }
  }

  /**
   * `release`, read from the row by an issue of the name that would fence the UUID on it, unless
   * it is this daemon's own superseded release's row with its replacement under way (#11557):
   * that row ended nothing. The issue is then refused or goes on as for any row that is not
   * terminal, and raises no fence.
   */
  private unlessBeingReplaced(
    release: SessionReleaseSnapshot | undefined,
  ): SessionReleaseSnapshot | undefined {
    return release &&
      this.supersededReasonsBeingRewritten.get(release.sessionId)?.includes(release.releaseReason)
      ? undefined
      : release;
  }

  private terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    if (!persisted.release_reason || !isTerminalReleaseReason(persisted.release_reason)) {
      return undefined;
    }
    return this.releaseSnapshotFromPersisted(sessionId, persisted, persisted.release_reason);
  }

  /**
   * The release a call naming a row past its deadline is refused with (#11361), or undefined when
   * the row is not one: a session that ran out its idle or recovery window while no daemon was
   * there to release it is gone, so a control call naming it gets the typed terminal refusal (with
   * the first deadline's reason) rather than the untyped "not found" of a never-issued id. An
   * idle-first answer keeps the non-terminal `expired` row reason; a window-first answer names
   * the terminal `restart-recovery-timeout`. This read writes neither a row nor a fence.
   */
  private expiredReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    if (persisted.release_reason && isTerminalReleaseReason(persisted.release_reason)) {
      return undefined;
    }
    const reason = this.isRowOwnedByLivePeer(persisted)
      ? persisted.expires_at_ms <= this.sessionNow()
        ? "expired"
        : undefined
      : persistedSessionExpiryReason(persisted, this.sessionNow());
    if (!reason) {
      return undefined;
    }
    return {
      ...this.releaseSnapshotFromPersisted(sessionId, persisted, reason),
      terminal: true,
    };
  }

  /**
   * What a call naming a UUID that cannot be admitted is answered with. A control call naming a
   * row past its deadline gets the typed terminal refusal; a never-issued id gets `neverIssued`.
   * A read is never refused for an expired row: it gets `neverIssued` too, which its caller turns
   * into a sessionless read, exactly as before the expired answer existed (#11361).
   */
  private unadmittedSessionError(
    sessionId: string,
    persisted: DeviceSession | undefined,
    neverIssued: UnissuedSessionError,
    access?: SessionAccess,
  ): Error {
    if (access === "read-only") {
      return neverIssued;
    }
    const expired = persisted && this.expiredReleaseFromPersisted(sessionId, persisted);
    return expired ? new TerminalSessionError(sessionId, expired) : neverIssued;
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
    return this.getSessionInternal(sessionId, false);
  }

  /**
   * Resolve a session before a new tool execution is accepted. A timely control call still in
   * flight keeps the session in use, so another control call may join it after the idle deadline.
   * Calls that all began late cannot revive the session by counting each other.
   */
  getSessionForNewExecution(
    sessionId: string,
    execution?: SessionExecutionMetadata,
  ): Session | null {
    return this.unlessBaseEnded(this.getSessionInternal(sessionId, true, execution));
  }

  private getSessionInternal(
    sessionId: string,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
    releaseExpired = true,
  ): Session | null {
    this.stallProbe?.();
    if (this.terminalReleaseSnapshots.has(sessionId)) {
      return null;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const startedExecution = execution && this.executionOnSessionClock(execution);
    if (expireDespiteActiveExecution) {
      if (this.isLateExecutionWhileEarlierWorkIsActive(session, startedExecution, true)) {
        return session;
      }
      if (this.isLateExecutionWhileEarlierWorkIsActive(session, startedExecution)) {
        throw new Error(
          `Session ${sessionId} expired before this execution began while earlier work is still active.`,
        );
      }
    }
    if (this.shouldExpireSession(session, expireDespiteActiveExecution, startedExecution)) {
      if (!releaseExpired) {
        return null;
      }
      // Release owns this exact session object until it has restored device state
      // and removed its assignment. Keep expiry cleanup from creating a second
      // incarnation with the same UUID before teardown completes, without
      // exposing the expired session to callers during that teardown.
      this.releaseExpiredSessionLazily(session, execution?.executionId);
      return null;
    }
    return session;
  }

  /** The lazy-expiry release of a session a lookup found past its idle deadline. */
  private releaseExpiredSessionLazily(session: Session, callerExecutionId?: string): void {
    if (this.releasingSessions.has(session)) {
      return;
    }
    const sessionId = session.sessionId;
    logger.info(`Session ${sessionId} has expired, found by lookup, releasing`);
    const releaseReason = this.expiredSessionReleaseReason(session);
    this.cancelExecutionsOverriddenByExpiry(session, releaseReason, callerExecutionId);
    const release = this.releaseSession(sessionId, releaseReason, true, undefined, {
      expiryOrigin: "lazy-expiry",
    });
    void this.getBarrier()
      .trackExisting(release)
      .catch((error) =>
        logger.warn(`[SessionManager] Failed to release expired session ${sessionId}: ${error}`),
      );
  }

  /**
   * Release `sessionId` if it is past its idle deadline, exactly as a lookup naming it does
   * ({@link getSession}); a live, fenced or already releasing session is left as it is.
   */
  private releaseSessionPastIdleDeadline(sessionId: string, callerExecutionId?: string): void {
    const session = this.sessions.get(sessionId);
    if (
      session &&
      !this.terminalReleaseSnapshots.has(sessionId) &&
      this.isSessionExpired(session)
    ) {
      this.releaseExpiredSessionLazily(session, callerExecutionId);
    }
  }

  /**
   * The live session a read is admitted under, releasing nothing. A read that arrives after the
   * idle deadline while any control call or recovery still holds the session (#11361) is not
   * admitted under it: this returns null, read-only admission resolves undefined, and the caller
   * runs the read without a session on the device {@link deviceHeldForLateRead} names. Any other
   * read past the deadline also gets null here.
   */
  private observeSessionForRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): Session | null {
    if (this.deviceHeldForLateRead(sessionId, execution) !== undefined) {
      return null;
    }
    return this.unlessBaseEnded(this.getSessionInternal(sessionId, true, execution, false));
  }

  /**
   * The device of the live session a read named but arrived too late to be admitted under: past
   * the idle deadline, with any control call or recovery still holding the session (#11361).
   * The read runs sessionless against this device, the one it asked about, rather than whatever device a
   * sessionless call would otherwise select. Undefined in every other case. Reads no device and
   * changes nothing: no release, no refresh, no idle credit.
   */
  deviceHeldForLateRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || this.terminalReleaseSnapshots.has(sessionId)) {
      return undefined;
    }
    const started = execution && this.executionOnSessionClock(execution);
    return this.isLateExecutionWhileEarlierWorkIsActive(session, started)
      ? session.assignedDevice
      : undefined;
  }

  /**
   * A call's start on the clock `expiresAt` is stamped with (#11290): its wall-clock `startTime`
   * is not comparable with a session stamp once the wall clock has stepped.
   */
  private executionOnSessionClock(execution: SessionExecutionMetadata): SessionClockExecution {
    return {
      ...execution,
      sessionClockStartTime:
        execution.sessionClockStartTime ?? this.wallToSessionClock(execution.startTime),
    };
  }

  private shouldExpireSession(
    session: Session,
    expireDespiteActiveExecution: boolean,
    execution?: SessionClockExecution,
  ): boolean {
    return expireDespiteActiveExecution
      ? this.isSessionExpiredForNewExecution(session, execution)
      : this.isSessionExpired(session);
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
    const { access, requestDeadlineMs, callerExecutionId } =
      this.resolveSessionAcquisitionOptions(accessOptions);
    const pendingRebind = this.pendingSessionRebinds.get(sessionId);
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
      const inFlightRelease = this.releasePromises.get(sessionId);
      if (this.releasingSessions.has(existing) && inFlightRelease?.session === existing) {
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

    const terminalRelease = this.terminalReleaseSnapshots.get(sessionId);
    if (terminalRelease) {
      throw new TerminalSessionError(sessionId, terminalRelease);
    }

    const inFlightRelease = this.inFlightReleaseStillOwning(sessionId);
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
      access,
      requestDeadlineMs,
    );
  }

  /**
   * A control call that waited on a device restart and failed is still the client using the
   * session, so the recovery's idle window restarts where the call's admission failed (#11281).
   * It is credited here rather than at the call's end: a call that fails admission ends
   * unadmitted, exactly like a read, and a read must never extend the window.
   */
  private creditControlCallFailedOnRestartRecovery(sessionId: string, access: SessionAccess): void {
    if (
      access === "acquire" &&
      !this.sessions.has(sessionId) &&
      this.restartRecoveryActivityAt.has(sessionId)
    ) {
      this.recordRestartRecoveryActivity(sessionId);
    }
  }

  /** Preserve the existing access-string API while admitting request-local options. */
  private resolveSessionAcquisitionOptions(options: SessionAccess | SessionAcquisitionOptions): {
    access: SessionAccess;
    requestDeadlineMs?: number;
    callerExecutionId?: string;
  } {
    return typeof options === "string"
      ? { access: options }
      : {
          access: options.access ?? "acquire",
          requestDeadlineMs: options.requestDeadlineMs,
          callerExecutionId: options.callerExecutionId,
        };
  }

  /**
   * Join an in-flight assignment/creation for this id, or start a new one via
   * {@link createUnseenSession}. Split out of getOrCreateSession to keep that
   * method's branch count under the complexity ceiling.
   */
  private async startOrJoinUnseenAssignment(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    requireIssuedSession: boolean,
    access: SessionAccess,
    requestDeadlineMs?: number,
  ): Promise<Session> {
    try {
      return await this.joinOrStartUnseenAssignment(
        sessionId,
        devicePool,
        platform,
        requireIssuedSession,
        access,
        requestDeadlineMs,
      );
    } catch (error) {
      this.creditControlCallFailedOnRestartRecovery(sessionId, access);
      throw error;
    }
  }

  private async joinOrStartUnseenAssignment(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    requireIssuedSession: boolean,
    access: SessionAccess,
    requestDeadlineMs?: number,
  ): Promise<Session> {
    const pendingAssignment = this.pendingSessionAssignments.get(sessionId);
    if (pendingAssignment) {
      // Only a control call joining the recovery is use; a read joins without extending (#11281).
      if (access === "acquire" && this.restartRecoveryActivityAt.has(sessionId)) {
        this.recordRestartRecoveryActivity(sessionId);
      }
      const shared = this.sharedSessionAssignments.get(sessionId);
      if (shared?.controller.signal.aborted) {
        await this.waitForAbortedAssignment(pendingAssignment, shared, requestDeadlineMs);
        return await this.getOrCreateSession(
          sessionId,
          devicePool,
          platform,
          undefined,
          requireIssuedSession,
          { access, requestDeadlineMs },
        );
      }
      const joined = await this.waitForSharedAssignment(
        sessionId,
        pendingAssignment,
        requestDeadlineMs,
      );
      // An acquiring client that joined a startup rehydration is the owner returning.
      if (access === "acquire" && joined.ownership === "awaiting-owner") {
        joined.ownership = "owned";
        joined.awaitingOwnerSince = undefined;
      }
      return joined;
    }

    const pendingCreation = this.pendingSessionCreations.get(sessionId);
    if (pendingCreation) {
      return await pendingCreation.promise;
    }

    const shared = this.newSharedAssignment(sessionId);
    const assignment = this.createUnseenSession(
      sessionId,
      devicePool,
      platform,
      requireIssuedSession,
      shared,
    ).finally(() => {
      shared.recoveryWait.resolve(undefined);
      if (this.pendingSessionAssignments.get(sessionId) === assignment) {
        this.pendingSessionAssignments.delete(sessionId);
        this.sharedSessionAssignments.delete(sessionId);
      }
    });
    this.pendingSessionAssignments.set(sessionId, assignment);
    return await this.waitForSharedAssignment(sessionId, assignment, requestDeadlineMs);
  }

  private newSharedAssignment(sessionId: string): SharedSessionAssignment {
    const shared: SharedSessionAssignment = {
      controller: new AbortController(),
      waiters: 0,
      recoveryWait: Promise.withResolvers<RecoveryAssignmentWait | undefined>(),
    };
    this.sharedSessionAssignments.set(sessionId, shared);
    return shared;
  }

  /** Drain the old attempt before its successor can publish or clean up shared state. */
  private async waitForAbortedAssignment(
    assignment: Promise<Session>,
    shared: SharedSessionAssignment,
    requestDeadlineMs?: number,
  ): Promise<void> {
    const settled = assignment.then(
      () => {},
      (error: unknown) => {
        // No callers remain on this cancelled attempt; its rejection is internal.
        logger.debug("[SessionManager] Aborted session assignment settled", error);
      },
    );
    // A restart waiter learns this configuration before it can abort the assignment.
    const wait = await shared.recoveryWait.promise;
    await raceWithDeadline(settled, {
      timer: this.timer,
      timeoutMs:
        requestDeadlineMs !== undefined && Number.isFinite(requestDeadlineMs)
          ? Math.max(
              0,
              // The request deadline is wall time (#11359); judge it on the session clock.
              this.wallToSessionClock(requestDeadlineMs) -
                (wait?.responseMarginMs ?? 0) -
                this.sessionNow(),
            )
          : undefined,
      signal: getAbortSignal(),
      label: "Session restart recovery",
      timeoutError: wait?.timeoutError,
    });
  }

  private async waitForSharedAssignment(
    sessionId: string,
    assignment: Promise<Session>,
    requestDeadlineMs?: number,
  ): Promise<Session> {
    const shared = this.sharedSessionAssignments.get(sessionId);
    if (!shared) {
      return await assignment;
    }
    shared.waiters++;
    const signal = getAbortSignal();
    let waiting = true;
    const leave = () => {
      if (!waiting) {
        return;
      }
      waiting = false;
      shared.waiters--;
      if (shared.waiters === 0) {
        shared.controller.abort(new ActionableError("Session recovery has no remaining callers"));
      }
    };
    try {
      // Keep ordinary unbounded acquisition on its original scheduling path.
      if ((requestDeadlineMs === undefined || !Number.isFinite(requestDeadlineMs)) && !signal) {
        return await assignment;
      }
      const wait = await raceWithDeadline(
        [shared.recoveryWait.promise, assignment.then(() => undefined)],
        { timer: this.timer, label: "Session recovery wait configuration" },
      );
      if (!wait) {
        return await assignment;
      }
      const deadline =
        requestDeadlineMs !== undefined && Number.isFinite(requestDeadlineMs)
          ? // The request deadline is wall time (#11359); `restartDeadlineMs` is on the session clock.
            this.wallToSessionClock(requestDeadlineMs) - wait.responseMarginMs
          : undefined;
      return await raceWithDeadline(assignment, {
        timer: this.timer,
        timeoutMs:
          deadline !== undefined && deadline < (wait.restartDeadlineMs ?? Infinity)
            ? Math.max(0, deadline - this.sessionNow())
            : undefined,
        signal,
        label: "Session restart recovery",
        timeoutError: wait.timeoutError,
        // Fence claims in the timeout's own turn, before promise rejection cleanup.
        onTimeout: leave,
      });
    } finally {
      leave();
    }
  }

  /** Admit an identity already issued by this daemon, including a nonterminal persisted one. */
  async admitIssuedSessionForAutomation(
    sessionId: string,
    execution?: SessionExecutionMetadata,
    options: { access?: SessionAccess } = {},
  ): Promise<Session | undefined> {
    let unissuedSessionError: UnissuedSessionError | undefined;
    try {
      if (options.access === "read-only") {
        // Inventory reads still validate the forwarded identity, but observing a
        // startup-rehydrated session is not proof that its owner returned. In
        // particular, do not enter reclaimAndRefreshExistingSession(), whose
        // acquisition semantics promote awaiting-owner to owned.
        const observed = this.observeSessionForRead(sessionId, execution);
        if (observed) {
          // Answered in every lease phase (#11322): a read is never refused, and never restores
          // or extends the lease it is watching.
          return observed;
        }
        if (this.sessions.has(sessionId)) {
          return undefined;
        }
      }
      return await this.getOrCreateSession(
        sessionId,
        undefined,
        undefined,
        execution,
        false,
        options.access,
      );
    } catch (error) {
      if (!(error instanceof UnissuedSessionError)) {
        throw error;
      }
      unissuedSessionError = error;
    }

    const persisted = await this.readPersistedSession(sessionId);
    const persistedTerminalRelease = this.unlessBeingReplaced(
      persisted && this.terminalReleaseFromPersisted(sessionId, persisted),
    );
    if (persistedTerminalRelease) {
      this.terminalReleaseSnapshots.set(sessionId, persistedTerminalRelease);
      throw new TerminalSessionError(sessionId, persistedTerminalRelease);
    }
    if (persisted && this.isReissuablePersistedSession(persisted)) {
      return undefined;
    }
    throw this.unadmittedSessionError(sessionId, persisted, unissuedSessionError, options.access);
  }

  private isLapsedUnownedRestartRecovery(
    devicePool: SessionDeviceAssigner | undefined,
    persisted: DeviceSession | undefined,
  ): boolean {
    return Boolean(
      devicePool &&
      persisted &&
      persistedSessionExpiryReason(persisted, this.sessionNow()) === "restart-recovery-timeout" &&
      !this.isRowOwnedByLivePeer(persisted),
    );
  }

  private async createUnseenSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    requireIssuedSession: boolean,
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    let persisted = await this.readPersistedSession(sessionId);
    this.refusePlanLabelSessionOutsideItsRun(sessionId, persisted);
    const persistedTerminalRelease = this.unlessBeingReplaced(
      persisted ? this.terminalReleaseFromPersisted(sessionId, persisted) : undefined,
    );
    if (persistedTerminalRelease) {
      this.terminalReleaseSnapshots.set(sessionId, persistedTerminalRelease);
      throw new TerminalSessionError(sessionId, persistedTerminalRelease);
    }

    // #6069: On the device-tool path (requireIssuedSession), admission is decided
    // from the session registry — NOT from whether a device pool happens to be in
    // scope. A live in-memory session is already resolved by getOrCreateSession
    // before reaching here, so the only admissible new-session case is
    // live-during-restart recovery: a persisted, non-terminal row. Without this,
    // the `admittedSession ?? getOrCreateSession(uuid, realPool)` fallback in
    // ToolExecutionContext auto-assigned a pooled device to a fabricated,
    // never-issued sessionUuid (e.g. "kumquat-D") whenever the #6045 admit guard
    // was bypassed by the call path — the ownership bypass this closes. The
    // pool-less `if (!devicePool)` throw below stays as a secondary safety net.
    // Every recovery must enter while its fixed window is open, including plan-label callers
    // that may mint never-issued IDs. Idle-first rows retain that path's ordinary re-issue rules.
    const restartWindowLapsed = this.isLapsedUnownedRestartRecovery(devicePool, persisted);
    if (
      (requireIssuedSession || restartWindowLapsed) &&
      !this.isReissuablePersistedSession(persisted)
    ) {
      // Answered from the row as the expiry write left it (#11498): a row whose deadline was
      // extended under this call is still live or recoverable, and is admitted like any other.
      persisted = await this.terminalizeExpiredPersistedSession(persisted);
      const terminalRelease = this.unlessBeingReplaced(
        persisted && this.terminalReleaseFromPersisted(sessionId, persisted),
      );
      if (terminalRelease) {
        this.terminalReleaseSnapshots.set(sessionId, terminalRelease);
        throw new TerminalSessionError(sessionId, terminalRelease);
      }
      if (!this.isReissuablePersistedSession(persisted)) {
        throw this.unadmittedSessionError(
          sessionId,
          persisted,
          new UnissuedSessionError(
            `Session ${sessionId} is not an active daemon session (not found). ` +
              "Acquire a device with getAndroid or getApple before using its sessionUuid.",
          ),
        );
      }
    }
    // Need to create new session - assign device from pool
    if (!devicePool) {
      throw new UnissuedSessionError(
        `Session ${sessionId} is not an active daemon session (not found). ` +
          "Acquire a device with getAndroid or getApple before using its sessionUuid.",
      );
    }

    if (persisted && isDeviceRestartReleasedRow(persisted)) {
      this.recordRestartRecoveryActivity(sessionId);
    }
    return await this.recoverPersistedSession(
      sessionId,
      devicePool,
      platform,
      persisted,
      "owned",
      shared,
    );
  }

  /** Reuse the on-demand recovery path for startup rehydration. */
  private async recoverPersistedSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    listed: DeviceSession | undefined,
    initialOwnership: "owned" | "awaiting-owner",
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    const claim =
      listed && this.isReissuablePersistedSession(listed, true)
        ? await this.claimRecoverableRow(sessionId, listed)
        : undefined;
    try {
      return await this.recoverPersistedRow(
        sessionId,
        devicePool,
        platform,
        claim?.row ?? listed,
        initialOwnership,
        shared,
      );
    } catch (error) {
      if (claim) {
        await this.releaseFailedRecoveryClaim(sessionId, claim);
      }
      throw error;
    }
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
      this.pendingPersistedRecoveries.set(sessionId, persisted);
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
    } finally {
      if (this.pendingPersistedRecoveries.get(sessionId) === persisted) {
        this.pendingPersistedRecoveries.delete(sessionId);
      }
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
    return session;
  }

  /**
   * Take ownership of a recoverable row before recovering it (#11200). Two daemons starting
   * together both list the same recoverable row; without this, both rehydrated it, and the loser
   * (whose allocation claim then failed) terminalized the row under the winner's live session. The
   * claim is a compare-and-set on the row's generation and owner, so exactly one daemon takes the
   * incarnation both read. A row a live peer already took (its owner is another live daemon) is
   * that peer's to recover. A refusal writes nothing; the returned copy carries the claimed
   * generation, which this recovery's own later writes are conditioned on.
   *
   * A compare-and-set that misses re-reads the row once and claims the current incarnation
   * (#11243): a startup listing can predate this daemon's own on-demand claim of the row, or that
   * claim's hand-back, and must not refuse the row as if a peer had taken it. A second miss is a
   * writer racing this one, and refuses.
   *
   * Resolves undefined when the persistence cannot claim rows (the row is recovered as read).
   * Throws `DeviceOwnedByOtherDaemonError` (code `device_owned_by_other_daemon`), or
   * `TerminalSessionError` when the re-read finds the row terminal.
   */
  private async claimRecoverableRow(
    sessionId: string,
    listed: DeviceSession,
  ): Promise<ClaimedRecoverableRow | undefined> {
    const daemonSessionId = this.daemonSessionId;
    const claim = this.deviceSessionRepository.claimRecoverableSession?.bind(
      this.deviceSessionRepository,
    );
    if (!claim || daemonSessionId === undefined) {
      return undefined;
    }
    const claimed = await this.tryClaimRecoverableRow(sessionId, listed, claim, daemonSessionId);
    if (claimed) {
      return claimed;
    }
    const current = await this.readPersistedSession(sessionId);
    const terminalRelease = this.unlessBeingReplaced(
      current && this.terminalReleaseFromPersisted(sessionId, current),
    );
    if (terminalRelease) {
      this.terminalReleaseSnapshots.set(sessionId, terminalRelease);
      throw new TerminalSessionError(sessionId, terminalRelease);
    }
    if (current && this.isReissuablePersistedSession(current, true)) {
      const reclaimed = await this.tryClaimRecoverableRow(
        sessionId,
        current,
        claim,
        daemonSessionId,
      );
      if (reclaimed) {
        return reclaimed;
      }
    }
    throw this.recoverableRowClaimRefusal(sessionId, current ?? listed);
  }

  /** One compare-and-set against `row`; undefined when the row is no longer that incarnation. */
  private async tryClaimRecoverableRow(
    sessionId: string,
    row: DeviceSession,
    claim: NonNullable<DeviceSessionPersistence["claimRecoverableSession"]>,
    daemonSessionId: string,
  ): Promise<ClaimedRecoverableRow | undefined> {
    const owner = row.daemon_session_id ?? null;
    if (owner !== null && owner !== daemonSessionId && this.isLiveDaemonSession(owner)) {
      throw this.recoverableRowClaimRefusal(sessionId, row);
    }
    const generation = await claim(
      sessionId,
      { rowGeneration: row.stable_identity_generation ?? 0, daemonSessionId: owner },
      daemonSessionId,
    );
    if (generation === undefined) {
      return undefined;
    }
    const claimed = {
      ...row,
      stable_identity_generation: generation,
      daemon_session_id: daemonSessionId,
    };
    this.claimedRecoverableRows.add(claimed);
    return {
      row: claimed,
      // This daemon's own stale claim is handed back unowned, so a peer can take it.
      previousOwner: owner === daemonSessionId ? null : owner,
    };
  }

  private recoverableRowClaimRefusal(sessionId: string, row: DeviceSession): Error {
    const owner = row.daemon_session_id ?? null;
    if (owner !== null && owner !== this.daemonSessionId) {
      logger.info(
        `[SessionManager] Not recovering session ${sessionId}: another AutoMobile daemon ` +
          `(${owner}) took its row first`,
      );
      return new DeviceOwnedByOtherDaemonError(row.device_id, undefined);
    }
    logger.info(
      `[SessionManager] Not recovering session ${sessionId}: its row changed during recovery ` +
        `(now ${row.status}, ${row.release_reason ?? "no release reason"})`,
    );
    return new ActionableError(
      `Session ${sessionId} is no longer recoverable: its persisted row changed during recovery. ` +
        "Retry, or acquire a new device with getAndroid or getApple.",
    );
  }

  /**
   * A recovery that failed after claiming its row, without recovering or terminalizing it
   * (#11243): its caller cancelled or ran out of time, the requested platform did not match, or
   * the device assignment failed. Hand the claim back, so the row is not left owned by a live
   * daemon that will not retry it — which a peer, and this daemon's own startup, would refuse
   * until this daemon exited or the row expired. Releasing rather than retrying here keeps the
   * retry with whoever asks next (the session's owner reconnecting, or a peer's startup), which
   * already re-runs the full admission; a retry loop inside the daemon would recover a session no
   * caller is waiting for. The hand-back is conditioned on the claimed incarnation, so it is a
   * no-op once the recovery's own upsert, a terminal release, or a peer changed the row.
   */
  private async releaseFailedRecoveryClaim(
    sessionId: string,
    claim: ClaimedRecoverableRow,
  ): Promise<void> {
    const release = this.deviceSessionRepository.releaseRecoverableSessionClaim?.bind(
      this.deviceSessionRepository,
    );
    if (!release || this.sessions.has(sessionId) || this.terminalReleaseSnapshots.has(sessionId)) {
      return;
    }
    try {
      const released = await release(
        sessionId,
        {
          rowGeneration: claim.row.stable_identity_generation ?? 0,
          daemonSessionId: claim.row.daemon_session_id ?? null,
        },
        claim.previousOwner,
      );
      if (released) {
        logger.info(
          `[SessionManager] Recovery of session ${sessionId} failed; handed its row back to ` +
            `${claim.previousOwner ?? "no owner"} so another recovery can take it`,
        );
      }
    } catch (error) {
      // The recovery's own error is what the caller sees; the row stays claimed until this daemon
      // exits or the row expires, as before #11243.
      logger.warn(
        `[SessionManager] Failed to hand back the claim on session ${sessionId}: ` +
          errorMessage(error),
        error,
      );
    }
  }

  /** Whether `daemonSessionId` names a live daemon, by the attached provider (#11200). */
  private isLiveDaemonSession(daemonSessionId: string): boolean {
    if (!this.liveDaemonSessionIds) {
      return false;
    }
    try {
      return this.liveDaemonSessionIds().has(daemonSessionId);
    } catch (error) {
      // The row compare-and-set still keeps two concurrent recoveries apart; only a row a live
      // peer took before this daemon read it is left to that check.
      logger.warn(
        `[SessionManager] Cannot list live daemons to check row owner ${daemonSessionId}: ` +
          errorMessage(error),
        error,
      );
      return false;
    }
  }

  private rehydrationSkipReason(sessionId: string): string | undefined {
    if (this.sessions.has(sessionId)) {
      return "already-live";
    }
    if (this.pendingSessionAssignments.has(sessionId)) {
      return "already-pending";
    }
    return undefined;
  }

  private registerRehydrationRecovery(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    persisted: DeviceSession,
  ): Promise<Session> {
    const shared = this.newSharedAssignment(sessionId);
    const recoveryPromise = this.recoverPersistedSession(
      sessionId,
      devicePool,
      persisted.platform,
      persisted,
      "awaiting-owner",
      shared,
    ).finally(() => {
      shared.recoveryWait.resolve(undefined);
      if (this.pendingSessionAssignments.get(sessionId) === recoveryPromise) {
        this.pendingSessionAssignments.delete(sessionId);
        this.sharedSessionAssignments.delete(sessionId);
      }
    });
    this.pendingSessionAssignments.set(sessionId, recoveryPromise);
    return this.waitForSharedAssignment(sessionId, recoveryPromise);
  }

  async rehydratePersistedSessions(
    devicePool: SessionDeviceAssigner,
    options: { deadlineMs?: number; concurrency?: number } = {},
  ): Promise<RehydrationSummary> {
    const deadlineMs = options.deadlineMs ?? SESSION_REHYDRATION_DEADLINE_MS;
    const concurrency = Math.max(1, options.concurrency ?? SESSION_REHYDRATION_CONCURRENCY);
    const deadlineAt = this.sessionNow() + deadlineMs;
    const summary: RehydrationSummary = {
      rehydrated: [],
      terminalized: [],
      skipped: [],
      timedOut: false,
    };
    // Terminalize what a previous daemon released but never persisted before reviving anything.
    await this.applyRecoveredTerminalReleaseIntents(deadlineAt);
    const persistedSessions = (
      await this.listRecoverableSessionsBeforeDeadline(deadlineAt, summary)
    ).map((persisted) => this.withRecoveredTerminalRelease(persisted));
    await this.reserveDevicesForRehydration(persistedSessions, devicePool, deadlineAt);
    // Rows recover concurrently, so one slow row (an unresolved emulator waiting out its restart
    // grace) no longer holds every later row past the deadline (#11114).
    const outcomes: Array<RehydrationRowOutcome | undefined> = [];
    let nextIndex = 0;
    let deadlineReached = false;
    const worker = async (): Promise<void> => {
      while (!deadlineReached && nextIndex < persistedSessions.length) {
        const index = nextIndex++;
        const outcome = await this.rehydratePersistedRow(persistedSessions[index], devicePool);
        // However the row ended, its device is no longer held for it: a recovered session holds
        // the device itself, and a failed row gives it back at once (#11294).
        this.releaseRehydrationReservation(persistedSessions[index].session_uuid, devicePool);
        if (deadlineReached) {
          this.logLateRehydrationOutcome(persistedSessions[index].session_uuid, outcome);
        } else {
          outcomes[index] = outcome;
        }
      }
    };
    if (this.sessionNow() < deadlineAt && persistedSessions.length > 0) {
      const deadlineWon = Symbol("startup-deadline");
      const workers = Promise.all(
        Array.from({ length: Math.min(concurrency, persistedSessions.length) }, worker),
      );
      const result = await raceWithDeadline(workers, {
        timer: this.timer,
        timeoutMs: Math.max(0, deadlineAt - this.sessionNow()),
        label: "Session rehydration",
        timeoutError: () => deadlineWon,
      }).catch((error: unknown) => {
        if (error !== deadlineWon) {
          throw error;
        }
        return deadlineWon;
      });
      deadlineReached = result === deadlineWon;
    } else {
      deadlineReached = persistedSessions.length > 0;
    }
    // Rows the deadline kept from starting are recovered by a follow-up sweep, not abandoned.
    const unstarted = persistedSessions.slice(nextIndex);
    nextIndex = persistedSessions.length;
    // They no longer hold their devices: the deadline passed without them starting (#11294).
    for (const persisted of unstarted) {
      this.releaseRehydrationReservation(persisted.session_uuid, devicePool);
    }
    for (const [index, persisted] of persistedSessions.entries()) {
      this.recordRehydrationOutcome(summary, persisted, outcomes[index]);
    }
    if (deadlineReached && !summary.timedOut) {
      summary.timedOut = true;
      const skippedCount = summary.skipped.filter(
        ({ reason }) => reason === "startup-deadline",
      ).length;
      logger.warn(
        `[SessionManager] Startup rehydration deadline reached; skipped ${skippedCount} rows due to startup-deadline`,
      );
    }
    this.scheduleRehydrationFollowUp(unstarted, devicePool, concurrency);
    logger.info(
      `[SessionManager] Rehydration: ${summary.rehydrated.length} rehydrated, ` +
        `${summary.terminalized.length} terminalized, ${summary.skipped.length} skipped`,
    );
    return summary;
  }

  /**
   * Reserve every row's device before any row starts recovering (#11294): rows recover a few at
   * a time, and an allocation arriving meanwhile must not take a device a later row is about to
   * recover onto. A row with no durable device identity reserves nothing; its recovery reports
   * that. Bounded by the startup deadline, and never fatal: rows then recover unreserved.
   */
  private async reserveDevicesForRehydration(
    persistedSessions: readonly DeviceSession[],
    devicePool: SessionDeviceAssigner,
    deadlineAt: number,
  ): Promise<void> {
    const reserve = devicePool.reserveDevicesForRehydration?.bind(devicePool);
    const rows = persistedSessions.flatMap((persisted): RehydrationDeviceReservation[] => {
      const stableDeviceId = persistedStableDeviceId(persisted);
      if (
        stableDeviceId === undefined ||
        !this.isRecoverablePersistedSession(persisted) ||
        this.rehydrationSkipReason(persisted.session_uuid) !== undefined
      ) {
        return [];
      }
      return [
        {
          sessionId: persisted.session_uuid,
          target: {
            platform: persisted.platform,
            stableDeviceId,
            deviceId: persisted.device_id,
            ...(persisted.platform === "android"
              ? { androidEmulator: isAndroidEmulatorSerial(persisted.device_id) }
              : {}),
          },
        },
      ];
    });
    if (!reserve || rows.length === 0 || this.sessionNow() >= deadlineAt) {
      return;
    }
    const reservation = reserve(rows);
    try {
      await raceWithDeadline(reservation, {
        timer: this.timer,
        timeoutMs: Math.max(0, deadlineAt - this.sessionNow()),
        label: "Session rehydration device reservation",
      });
    } catch (error) {
      logger.warn(
        `[SessionManager] Could not reserve devices for rehydration: ${errorMessage(error)}`,
        error,
      );
      // A reservation that lands after the deadline must not outlive the rows it was made for.
      const releaseAll = (): void => {
        for (const row of rows) {
          devicePool.releaseRehydrationReservation?.(row.sessionId);
        }
      };
      releaseAll();
      void reservation.then(releaseAll, () => undefined);
    }
  }

  /**
   * Give up a row's reservation (#11294). A row its owner is recovering on demand right now keeps
   * the device until that recovery settles; it is the same row, so the reservation exempts it.
   */
  private releaseRehydrationReservation(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
  ): void {
    const release = (): void => devicePool.releaseRehydrationReservation?.(sessionId);
    const pending = this.pendingSessionAssignments.get(sessionId);
    if (pending) {
      void pending.then(release, release);
    } else {
      release();
    }
  }

  private recordRehydrationOutcome(
    summary: RehydrationSummary,
    persisted: DeviceSession,
    outcome: RehydrationRowOutcome | undefined,
  ): void {
    const sessionUuid = persisted.session_uuid;
    if (outcome?.kind === "rehydrated") {
      summary.rehydrated.push(sessionUuid);
    } else if (outcome?.kind === "terminalized") {
      summary.terminalized.push({ sessionUuid, reason: outcome.reason });
    } else if (outcome) {
      summary.skipped.push({ sessionUuid, reason: outcome.reason });
    } else if (!this.isRecoverablePersistedSession(persisted)) {
      summary.skipped.push({ sessionUuid, reason: "not-recoverable" });
    } else if (this.sessions.has(sessionUuid)) {
      summary.skipped.push({ sessionUuid, reason: "already-live" });
    } else {
      // Still recovering, or left to the follow-up sweep.
      summary.skipped.push({ sessionUuid, reason: "startup-deadline" });
    }
  }

  private async rehydratePersistedRow(
    persisted: DeviceSession,
    devicePool: SessionDeviceAssigner,
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
      await this.registerRehydrationRecovery(sessionId, devicePool, persisted);
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
   * follow-up), so the daemon re-owns its managed slot like the startup batch (#11288).
   */
  setLateRehydrationListener(listener: (rehydrated: readonly string[]) => Promise<void>): void {
    this.lateRehydrationListener = listener;
  }

  private logLateRehydrationOutcome(sessionId: string, outcome: RehydrationRowOutcome): void {
    logger.info(
      `[SessionManager] Rehydration of ${sessionId} finished after the startup deadline: ` +
        `${outcome.kind}${outcome.kind === "rehydrated" ? "" : ` (${outcome.reason})`}`,
    );
    if (outcome.kind !== "rehydrated" || !this.lateRehydrationListener) {
      return;
    }
    this.lateRehydrationListener([sessionId]).catch((error: unknown) => {
      logger.warn(
        `[SessionManager] Late rehydration hook failed for ${sessionId}: ${errorMessage(error)}`,
        error,
      );
    });
  }

  /**
   * Recover the rows the startup deadline kept from starting (#11114). A row its owner already
   * recovered on reconnect is skipped as already live or pending.
   */
  private scheduleRehydrationFollowUp(
    rows: DeviceSession[],
    devicePool: SessionDeviceAssigner,
    concurrency: number,
  ): void {
    const pending = rows.filter(
      (persisted) =>
        this.isRecoverablePersistedSession(persisted) && !this.sessions.has(persisted.session_uuid),
    );
    if (pending.length === 0) {
      return;
    }
    if (this.rehydrationFollowUpTimer) {
      this.timer.clearTimeout(this.rehydrationFollowUpTimer);
    }
    this.rehydrationFollowUpTimer = this.timer.setTimeout(() => {
      this.rehydrationFollowUpTimer = null;
      void this.runRehydrationFollowUp(pending, devicePool, concurrency);
    }, 0);
  }

  private async runRehydrationFollowUp(
    rows: DeviceSession[],
    devicePool: SessionDeviceAssigner,
    concurrency: number,
  ): Promise<void> {
    logger.info(`[SessionManager] Follow-up rehydration of ${rows.length} deadline-skipped rows`);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < rows.length) {
        const persisted = rows[nextIndex++];
        this.logLateRehydrationOutcome(
          persisted.session_uuid,
          await this.rehydratePersistedRow(persisted, devicePool),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  }

  private recoverySessionFields(
    persisted: DeviceSession | undefined,
  ): Pick<
    Session,
    "persistenceMetadata" | "livenessOwnerToken" | "livenessOwnershipClaims" | "lastOwnerHeartbeat"
  > {
    if (!persisted) {
      return {};
    }
    return {
      persistenceMetadata: {
        source: persisted.source,
        autolockEnabled: persisted.autolock_enabled === 1,
        mcpSessionId: persisted.mcp_session_id,
        // The persisted owner is the dead daemon; this daemon now owns the row (#11114).
        daemonSessionId: this.recoveredRowOwner(),
      },
      ...(persisted.liveness_owner_token
        ? {
            livenessOwnerToken: persisted.liveness_owner_token,
            livenessOwnershipClaims: new Set([persisted.liveness_owner_token]),
            lastOwnerHeartbeat: this.sessionNow(),
          }
        : {}),
    };
  }

  private async listRecoverableSessionsBeforeDeadline(
    deadlineAt: number,
    summary: RehydrationSummary,
  ): Promise<DeviceSession[]> {
    const deadlineWon = Symbol("startup-deadline");
    const recoverableSessions =
      this.deviceSessionRepository.listRecoverableSessions?.(this.sessionNow(), () =>
        this.rowWriteLivePeerDaemonSessionIds(),
      ) ?? Promise.resolve([]);
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

  /**
   * A recovery conflict is terminal for this UUID. Keep the fencing work out
   * of createUnseenSession so ordinary allocation stays easy to audit.
   */
  private async assignUnseenSessionToDevicePool(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    recoveryTarget: SessionRecoveryTarget | undefined,
    persisted: DeviceSession | undefined,
  ): Promise<void> {
    try {
      await devicePool.assignDeviceToSession(sessionId, platform, recoveryTarget);
    } catch (error) {
      if (
        !persisted ||
        !isSessionRecoveryIdentityLossError(error) ||
        error.sessionUuid !== sessionId
      ) {
        throw error;
      }
      if (!this.isNameReissueOnlyRow(persisted)) {
        await this.terminalizePersistedRecoveryFailure(sessionId, persisted, error);
        throw error;
      }
      // #11418: a re-issued plan session has no device identity to protect. Its old device being
      // taken or gone is not a loss; the UUID stays usable on whatever ordinary allocation grants.
      logger.info(
        `[SessionManager] Re-issuing session ${sessionId} on another device: its previous device ` +
          `${persisted.device_id} cannot be reused (${error.reason})`,
      );
      await devicePool.assignDeviceToSession(sessionId, platform ?? persisted.platform);
    }
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

  async rebindSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options: RebindSessionOptions = {},
  ): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    this.assertTerminalRebindAdmission(sessionId, options.terminalReleaseReservationOwner);
    if (!existing) {
      return await this.createSession(
        sessionId,
        assignedDevice,
        platform,
        undefined,
        undefined,
        options.stableDeviceId,
      );
    }
    if (existing.assignedDevice === assignedDevice && !options.force) {
      // Generation only: this no-op rebind retains the same serial, connection and incarnation.
      this.notifyDeviceOwnershipChange(assignedDevice);
      return existing;
    }

    const pendingRebind = this.pendingSessionRebinds.get(sessionId);
    if (pendingRebind) {
      await pendingRebind.promise;
      return await this.rebindSession(sessionId, assignedDevice, platform, options);
    }

    const inFlightRelease = this.releasePromises.get(sessionId);
    if (inFlightRelease?.session === existing) {
      await inFlightRelease.promise;
      throw new Error(`Cannot rebind released session ${sessionId}.`);
    }

    this.flushDeferredRebindCleanups({ sessionId });
    const promise = this.persistAndPublishRebind(
      existing,
      assignedDevice,
      platform,
      options.stableDeviceId ?? existing.stableDeviceId,
      options.deferCleanup,
    );
    const rebind = { session: existing, promise };
    this.pendingSessionRebinds.set(sessionId, rebind);
    try {
      return await promise;
    } catch (error) {
      if (!(error instanceof DeviceSessionRowNotRewritableError)) {
        throw error;
      }
      return await this.rejectRefusedRebind(existing, rebind, error);
    } finally {
      if (this.pendingSessionRebinds.get(sessionId) === rebind) {
        this.pendingSessionRebinds.delete(sessionId);
      }
    }
  }

  private async rejectRefusedRebind(
    existing: Session,
    rebind: { session: Session; promise: Promise<Session> },
    error: DeviceSessionRowNotRewritableError,
  ): Promise<never> {
    const sessionId = existing.sessionId;
    // The failed write never published its binding. End a terminal UUID after the rebind's
    // promise has rejected, so the release cannot wait on the very rebind adopting it.
    if (this.pendingSessionRebinds.get(sessionId) === rebind) {
      this.pendingSessionRebinds.delete(sessionId);
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

  /** Rebind the exact reserved session during its owner-controlled recovery handoff. */
  async rebindSessionForTerminalReleaseRecovery(
    session: Session,
    assignedDevice: string,
    platform: Platform,
  ): Promise<Session> {
    const reservation = this.terminalReleaseReservations.get(session.sessionId);
    if (reservation?.session !== session) {
      throw new Error(`Session ${session.sessionId} has no matching terminal release reservation.`);
    }
    return await this.rebindSession(session.sessionId, assignedDevice, platform, {
      force: true,
      terminalReleaseReservationOwner: reservation.owner,
    });
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
    await this.livenessOwnershipClaimMutexFor(existing).runExclusive(async () => {
      await this.persistSession(
        this.createReboundSession(existing, assignedDevice, platform, stableDeviceId),
        existing,
        this.guardedRowRewriteOptions([...(this.supersededReleaseReasons.get(existing) ?? [])]),
      );
      // The rebind's row is live: a rewrite still owed from before it is settled (#11557), so a
      // terminal row found under the session later is the UUID's end, not that rewrite's.
      this.settleOwedSupersededRowReassert(existing);
    });
    if (this.sessions.get(existing.sessionId) !== existing) {
      // A release waits for the rebind, but a forced one does not (#10963): it removed the
      // session and wrote its row while this row was in flight, and this row landed over it.
      await this.restoreReleasedRowAfterReassert(existing);
    }
    const previousDevice = existing.assignedDevice;
    const oldView: Session = { ...existing, cacheData: { ...existing.cacheData } };
    const expiry = this.peekNetworkConditionExpiry(existing.sessionId);
    const lease = this.iosAppNetworkLeases.active(existing.sessionId);
    // These callbacks read the live session. Suspend TTL and transfer lease renewal before
    // publishing B, so neither can address B with A's state. Undo resumes the original deadline.
    this.cancelNetworkConditionExpiry(existing.sessionId);
    this.iosAppNetworkLeases.stop(existing.sessionId);
    if (deferCleanup) {
      const cleanup = this.deferRebindOverrides(
        oldView,
        () => {
          if (expiry) {
            this.rearmNetworkConditionExpiry(existing, expiry);
          }
          if (lease) {
            this.confirmIosAppNetworkRule(existing, lease);
          }
        },
        lease,
      );
      deferCleanup(cleanup);
    } else {
      const pending = await this.restoreRebindOverrides(existing);
      if (pending.length > 0) {
        this.trackPendingDeviceCleanup(previousDevice, pending);
      }
    }
    // Preserve object identity so an already-started release observes the
    // rebinding and frees its live replacement rather than a stale snapshot.
    // Recreate the replacement after awaited work: activity and label-routing
    // updates remain live while persistence is in flight, and publishing the
    // pre-persistence snapshot would overwrite them.
    Object.assign(
      existing,
      this.createReboundSession(existing, assignedDevice, platform, stableDeviceId),
    );
    this.sessionDeviceMap.set(existing.sessionId, assignedDevice);
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
    this.notifySessionDeviceUnbound(existing.sessionId, previousDevice);
    return existing;
  }

  /** Flush only matching receipts; release, a later rebind and shutdown all commit once. */
  flushDeferredRebindCleanups(filter: { sessionId?: string; deviceId?: string } = {}): void {
    for (const [cleanup, owner] of this.deferredRebindCleanups) {
      if (
        (filter.sessionId === undefined || filter.sessionId === owner.sessionId) &&
        (filter.deviceId === undefined || filter.deviceId === owner.deviceId)
      ) {
        cleanup.commit();
      }
    }
  }

  private deferRebindOverrides(
    oldView: Session,
    resumeRetainedState: () => void,
    lease: IosAppNetworkRule | undefined,
  ): DeferredRebindCleanup {
    const gate = Promise.withResolvers<void>();
    let state: "deferred" | "started" | "cancelled" | "rebound" = "deferred";
    const incarnation = this.deviceHealth?.incarnation(oldView.assignedDevice);
    const mayRestore = () => {
      const holder = this.getSessionForDevice(oldView.assignedDevice);
      return (
        (holder === null || holder === oldView.sessionId) &&
        (incarnation === undefined ||
          this.deviceHealth?.incarnation(oldView.assignedDevice) === incarnation)
      );
    };
    const leaseKey = `rebind:${oldView.sessionId}:${oldView.assignedDevice}`;
    const finish = () => {
      this.timer.clearTimeout(bound);
      this.iosAppNetworkLeases.stop(leaseKey);
      this.deferredRebindCleanups.delete(cleanup);
    };
    const start = (failedUndo = false) => {
      if (state !== "deferred" && !(failedUndo && state === "cancelled")) {
        return;
      }
      state = "started";
      finish();
      // Quarantine was registered before publication. Check ownership again before any write;
      // a forcibly replaced holder must never receive this session's restores.
      if (!mayRestore()) {
        logger.warn(
          `Not restoring rebound device ${oldView.assignedDevice}: runtime changed or reassigned`,
        );
        gate.resolve();
        return;
      }
      void runOutsideRequestContext(async () => {
        const pending = await this.restoreRebindOverrides(oldView, mayRestore);
        await Promise.allSettled(pending);
      }).then(gate.resolve, (error: unknown) => {
        logger.warn(
          `Deferred rebind cleanup failed on ${oldView.assignedDevice}: ${errorMessage(error)}`,
          error,
        );
        gate.resolve();
      });
    };
    const cleanup: DeferredRebindCleanup = {
      settled: gate.promise,
      get retained() {
        return state === "cancelled";
      },
      commit: () => start(),
      cancel: () => {
        if (state === "started" || state === "rebound") {
          return false;
        }
        if (state === "deferred") {
          state = "cancelled";
          finish();
        }
        return true;
      },
      finish: (outcome) => {
        if (state === "cancelled") {
          if (outcome === "rebound") {
            state = "rebound";
            gate.resolve();
          } else {
            // Only failed undo may restart cancelled restores, using the same old-device view.
            start(true);
          }
        } else if (state === "deferred") {
          cleanup.commit();
        }
      },
      resumeRetainedState: () => {
        if (state === "cancelled") {
          resumeRetainedState();
        }
      },
    };
    // Reuse the creation/release-finalization wait (40s); an orphaned receipt cannot reserve A forever.
    const bound = this.timer.setTimeout(cleanup.commit, SESSION_CREATE_WAIT_TIMEOUT_MS);
    bound.unref?.();
    this.deferredRebindCleanups.set(cleanup, {
      sessionId: oldView.sessionId,
      deviceId: oldView.assignedDevice,
    });
    if (lease) {
      this.iosAppNetworkLeases.start(
        leaseKey,
        lease,
        () => state === "deferred" && this.getSessionForDevice(oldView.assignedDevice) === null,
      );
    }
    this.registerPendingDeviceCleanup(
      oldView.assignedDevice,
      gate.promise,
      SESSION_CREATE_WAIT_TIMEOUT_MS + SESSION_RELEASE_TEARDOWN_CAP_MS,
    );
    return cleanup;
  }

  /** One restore sequence shared by inline rebinds and receipt-owned deferred cleanup. */
  private async restoreRebindOverrides(
    existing: Session,
    mayRestore: () => boolean = () => true,
  ): Promise<Promise<void>[]> {
    const restores: Array<() => Promise<{ pending: Promise<void> | null }>> = [
      () => this.restoreKeepScreenAwakeBestEffort(existing),
      () => this.restoreBiometricEnrollmentBestEffort(existing),
      async () => {
        const networkTarget = this.networkConditionRestoreTarget(existing);
        if (!networkTarget) {
          return { pending: null };
        }
        const pending = await this.runUnderTeardownShield(async () => [
          {
            ...(await this.restoreNetworkConditionBestEffort(existing)),
            abandon: () => this.abandonCappedRestore(networkTarget, "network-condition"),
          },
        ]);
        return { pending: pending[0] ?? null };
      },
      () => this.getPendingClockRestoration(existing, null),
      () => this.getPendingRotationRestoration(existing, null),
      () => this.getPendingScreenReaderRestoration(existing, null),
    ];
    const pending: Promise<void>[] = [];
    for (const restore of restores) {
      // A shutdown or forced handoff can retire A during an earlier awaited write. Do not
      // capture subsequent targets from a replacement runtime or another session's holder.
      if (!mayRestore()) {
        break;
      }
      const result = await restore();
      if (result.pending) {
        pending.push(result.pending);
      }
    }
    return pending;
  }

  /**
   * Rebinding keeps only session-level routing cache. Hierarchy, rendered
   * observation, and keep-awake state belong to the old physical device.
   */
  private createReboundSession(
    session: Session,
    assignedDevice: string,
    platform: Platform,
    stableDeviceId: string | undefined,
  ): Session {
    return {
      ...session,
      assignedDevice,
      stableDeviceId,
      platform,
      cacheData:
        session.cacheData.deviceLabels === undefined
          ? {}
          : { deviceLabels: session.cacheData.deviceLabels },
    };
  }

  /**
   * Get device assigned to a session
   */
  getDeviceForSession(sessionId: string): string | null {
    const session = this.getSession(sessionId);
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
   * Why this daemon released a session it issued (#10730), from the in-memory terminal snapshot or
   * the persisted `release_reason`. Undefined for a live session or a UUID it never issued, so a
   * caller can tell a known release from a plain unknown id.
   *
   * A fenced terminal non-device-loss release is named while it writes its row (#11646), using
   * the operation's live reason so a join is visible before its snapshot upgrades. Only
   * commit-fenced releases can be abandoned after the terminal fence is raised; those are never
   * named, even if a join upgrades their reason. Teardown before the fence stays unanswered.
   * A plan label whose base has ended is otherwise answered with the base's reason.
   */
  async getReleasedSessionReason(sessionId: string): Promise<string | undefined> {
    const published = this.sessions.get(sessionId);
    const inMemory = this.terminalReleaseSnapshots.get(sessionId)?.releaseReason;
    if (published) {
      const inFlightReason = (): string | undefined => {
        const operation = this.releasePromises.get(sessionId);
        const current = operation?.session === published ? operation : undefined;
        const reason = current?.reason.value ?? inMemory;
        return inMemory !== undefined &&
          !current?.commitFenced &&
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
      this.pendingSessionAssignments.has(sessionId) ||
      this.pendingSessionCreations.has(sessionId) ||
      this.pendingPersistedRecoveries.has(sessionId) ||
      this.releasePromises.has(sessionId)
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
    if (this.sessions.has(sessionId) || this.terminalReleaseSnapshots.has(sessionId)) {
      return undefined;
    }
    const persisted = await this.readPersistedSession(sessionId);
    return persisted && this.expiredReleaseOfUnheldRow(sessionId, persisted);
  }

  getTerminalReleaseSnapshot(sessionId: string): SessionReleaseSnapshot | undefined {
    const snapshot = this.terminalReleaseSnapshots.get(sessionId);
    return snapshot ? { ...snapshot, heartbeat: { ...snapshot.heartbeat } } : undefined;
  }

  /** Prevent this exact session UUID from being rebound while its device shutdown is in flight. */
  reserveSessionForTerminalRelease(session: Session, expectedDeviceId: string): () => void {
    if (session.assignedDevice !== expectedDeviceId) {
      throw new SessionNoLongerOwnsDeviceError(session.sessionId, expectedDeviceId);
    }
    if (this.pendingSessionRebinds.has(session.sessionId)) {
      throw new SessionRebindingError(session.sessionId);
    }
    const existing = this.terminalReleaseReservations.get(session.sessionId);
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
    this.terminalReleaseReservations.set(session.sessionId, reservation);
    return () => {
      if (this.terminalReleaseReservations.get(session.sessionId)?.owner === reservation.owner) {
        this.terminalReleaseReservations.delete(session.sessionId);
      }
    };
  }

  private assertTerminalReleaseAdmission(sessionId: string, allowedSession?: Session): void {
    const reservation = this.terminalReleaseReservations.get(sessionId);
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
    const reservation = this.terminalReleaseReservations.get(sessionId);
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
      const session = this.sessions.get(sessionId) ?? this.releasePromises.get(sessionId)?.session;
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
   * Whether this daemon holds `sessionId` as a live managed slot execution (#11275): present, on
   * the `managed-execution` policy, not expired and not being released. A session rehydrated after
   * a restart and still waiting for its proxy counts: the heartbeat monitor releases it if the proxy
   * never returns. Side-effect free: an expired session is reported dead, never released here.
   */
  isLiveManagedExecutionSession(sessionId: string): boolean {
    const session = this.getSessionInternal(sessionId, false, undefined, false);
    return (
      session !== null &&
      session.livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY &&
      !this.releasingSessions.has(session)
    );
  }

  isCurrentSession(session: Session): boolean {
    return (
      this.sessions.get(session.sessionId) === session &&
      !this.terminalReleaseSnapshots.has(session.sessionId)
    );
  }

  isAdmittedForAutomation(session: Session): boolean {
    return this.isCurrentSession(session) && !this.releasingSessions.has(session);
  }

  /** Read ownership without admission, expiry cleanup or the stall probe (release guard, #11920). */
  getSessionLivenessOwnerToken(sessionId: string): string | undefined {
    return (this.sessions.get(sessionId) ?? this.releasePromises.get(sessionId)?.session)
      ?.livenessOwnerToken;
  }

  /** Resolve an admitted release even after ordinary session lookup hides its identity. */
  getReleasingSession(sessionId: string): Session | null {
    return this.releasePromises.get(sessionId)?.session ?? null;
  }

  /** Whether this is the newest published, releasing, or finalized incarnation for its UUID. */
  isLatestSessionIdentity(
    session: Session,
    options: { ignorePendingAssignment?: boolean } = {},
  ): boolean {
    const current = this.sessions.get(session.sessionId);
    if (current) {
      return current === session;
    }
    if (
      this.pendingSessionCreations.has(session.sessionId) ||
      (!options.ignorePendingAssignment && this.pendingSessionAssignments.has(session.sessionId))
    ) {
      return false;
    }
    const inFlightRelease = this.releasePromises.get(session.sessionId);
    if (inFlightRelease) {
      return inFlightRelease.session === session;
    }
    return this.latestFinalizedSessionIdentities.get(session.sessionId)?.deref() === session;
  }

  /**
   * Release a session and free its device
   *
   * Called when a test completes or times out.
   * Returns the device ID so DevicePool can mark it as available.
   */
  releaseSession(
    sessionId: string,
    releaseReason: SessionReleaseReason = "explicit-release",
    allowExpired: boolean = false,
    shouldCommit?: ReleaseCommitFence,
    options: SessionReleaseOptions = {},
  ): Promise<string | null> {
    // Not async: a pass-through, so it adds no microtask to the release's settled budget.
    return this.releaseSessionForReason(
      sessionId,
      releaseReason,
      allowExpired,
      shouldCommit,
      options,
    );
  }

  /**
   * {@link releaseSession} for a reason already recorded on a release in flight. New releases go
   * through `releaseSession`, whose typed reason must be tagged in the release-reason table.
   */
  private async releaseSessionForReason(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean = false,
    shouldCommit?: ReleaseCommitFence,
    options: SessionReleaseOptions = {},
  ): Promise<string | null> {
    const releaseOptions = { ...options };
    const attempt = () =>
      this.releaseSessionAttempt(
        sessionId,
        releaseReason,
        allowExpired,
        shouldCommit,
        releaseOptions,
      );
    if (isExpiryReleaseReason(releaseReason)) {
      const recoveryRelease = this.recoveryExpiryReleaseHandler?.release(
        sessionId,
        releaseReason,
        attempt,
        releaseOptions,
      );
      if (recoveryRelease) {
        return await recoveryRelease;
      }
    }
    return await attempt();
  }

  private async releaseSessionAttempt(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
    shouldCommit?: ReleaseCommitFence,
    options: SessionReleaseOptions = {},
  ): Promise<string | null> {
    const session =
      allowExpired || this.terminalReleaseSnapshots.has(sessionId)
        ? (this.sessions.get(sessionId) ?? null)
        : // Not `getSession`: a label whose base has ended is still there to release (#11640).
          this.getSessionInternal(sessionId, false);
    if (!session) {
      return await this.releaseUnpublishedSession(sessionId, releaseReason, allowExpired);
    }

    const inFlightRelease = this.releasePromises.get(sessionId);
    if (inFlightRelease?.session === session) {
      this.upgradeReleaseReason(inFlightRelease.reason, releaseReason);
      return await inFlightRelease.promise;
    }

    this.releasingSessions.add(session);
    const pendingRebind = this.pendingSessionRebinds.get(sessionId);
    const reason = this.createReleaseReasonState(sessionId, releaseReason);
    const judgeSuspectOwnerAtCommit = this.judgeOwnerLeaseForRelease(session, reason, "start");
    const release: SessionReleaseOperation = {
      session,
      commitFenced: shouldCommit !== undefined,
      promise: Promise.resolve(null),
      reason,
      judgeSuspectOwnerAtCommit,
      startedAtMs: this.sessionNow(),
      expiryOrigin: options.expiryOrigin,
      forcedAbort: new AbortController(),
    };
    const run = () => {
      this.flushDeferredRebindCleanups({ sessionId });
      return release.forced
        ? this.finishReleaseForcedBeforeStart(session)
        : this.releaseSessionInternal(sessionId, session, reason, shouldCommit, options, release);
    };
    if (pendingRebind?.session === session) {
      release.stage = "awaiting-rebind";
      release.promise = pendingRebind.promise.then(run, run);
    } else {
      release.promise = run();
    }
    const promise = release.promise;
    this.releasePromises.set(sessionId, release);
    this.activeReleasePromises.add(release);
    try {
      return await promise;
    } finally {
      this.activeReleasePromises.delete(release);
      if (this.releasePromises.get(sessionId) === release) {
        this.releasePromises.delete(sessionId);
      }
    }
  }

  /**
   * Release a session unless `shouldCommit` declines at the commit point.
   *
   * A device-loss eviction races discovery: a newer observation can confirm the
   * same serial still hosts the live runtime while release is awaiting tracked
   * setup or restoration work. The predicate is re-evaluated synchronously
   * immediately before the session is removed (after every await), so such a
   * confirmation stops the stale eviction instead of being outrun by it
   * (#7031). `superseded: true` means nothing was released.
   */
  async releaseSessionUnlessSuperseded(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    shouldCommit: ReleaseCommitFence | undefined,
    allowExpired: boolean = false,
  ): Promise<ConditionalSessionRelease> {
    let superseded = false;
    const fence: ReleaseCommitFence | undefined =
      shouldCommit === undefined
        ? undefined
        : () => {
            if (superseded || shouldCommit() === false) {
              superseded = true;
              return false;
            }
            return true;
          };
    const deviceId = await this.releaseSession(sessionId, releaseReason, allowExpired, fence);
    return superseded ? { superseded: true } : { superseded: false, deviceId };
  }

  /** Release only the recorded session incarnation while it still owns the device. */
  async releaseSessionIfOwned(
    sessionId: string,
    expectedSession: Session,
    expectedDeviceId: string,
    releaseReason: SessionReleaseReason = "explicit-release",
  ): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (session === expectedSession && session.assignedDevice === expectedDeviceId) {
      return await this.releaseSession(sessionId, releaseReason);
    }
    if (session) {
      return null;
    }
    if (
      this.pendingSessionAssignments.has(sessionId) ||
      this.pendingSessionCreations.has(sessionId)
    ) {
      return null;
    }
    const inFlightRelease = this.releasePromises.get(sessionId);
    if (inFlightRelease) {
      if (
        inFlightRelease.session === expectedSession &&
        expectedSession.assignedDevice === expectedDeviceId
      ) {
        return await this.releaseSession(sessionId, releaseReason);
      }
      return null;
    }
    return await this.releaseFinalizedSessionIfOwned(
      sessionId,
      expectedSession,
      expectedDeviceId,
      releaseReason,
    );
  }

  private async releaseFinalizedSessionIfOwned(
    sessionId: string,
    expectedSession: Session,
    expectedDeviceId: string,
    releaseReason: string,
  ): Promise<string | null> {
    const finalizedRelease = this.finalizedSessionReleases.get(expectedSession);
    if (
      finalizedRelease?.finalizedSnapshot?.sessionId === sessionId &&
      finalizedRelease.finalizedSnapshot.deviceId === expectedDeviceId &&
      isTerminalReleaseReason(releaseReason)
    ) {
      return await this.releaseFinalizedSession(finalizedRelease, releaseReason);
    }
    return null;
  }

  private async releaseUnpublishedSession(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
  ): Promise<string | null> {
    const inFlightRelease = this.inFlightReleaseStillOwning(sessionId);
    if (inFlightRelease) {
      if (inFlightRelease.reason.finalizedSnapshot && isTerminalReleaseReason(releaseReason)) {
        return await this.releaseFinalizedSession(inFlightRelease.reason, releaseReason);
      }
      this.upgradeReleaseReason(inFlightRelease.reason, releaseReason);
      return await inFlightRelease.promise;
    }
    const terminalSnapshot = this.terminalReleaseSnapshots.get(sessionId);
    if (terminalSnapshot && isTerminalReleaseReason(releaseReason)) {
      const terminalReason = this.terminalReleaseReasonStates.get(sessionId);
      if (terminalReason) {
        return await this.releaseFinalizedSession(terminalReason, releaseReason);
      }
      await this.persistSessionRelease(terminalSnapshot);
      return terminalSnapshot.deviceId;
    }
    const pendingSnapshot = this.pendingNonTerminalReleaseSnapshots.get(sessionId);
    if (pendingSnapshot) {
      return (await this.persistSessionRelease(pendingSnapshot, true))
        ? pendingSnapshot.deviceId
        : null;
    }
    const pendingAssignment = this.pendingSessionAssignments.get(sessionId);
    const pendingCreation = this.pendingSessionCreations.get(sessionId);
    const pendingSession = pendingAssignment ?? pendingCreation?.promise;
    if (!pendingSession) {
      return await this.releasePersistedRestartRecovery(sessionId, releaseReason);
    }
    return await this.releasePendingSessionWork(
      sessionId,
      releaseReason,
      allowExpired,
      pendingSession,
    );
  }

  /** Replace a removed session's restart permission only while its window is open. */
  private async releasePersistedRestartRecovery(
    sessionId: string,
    releaseReason: string,
  ): Promise<string | null> {
    if (isTerminalReleaseReason(releaseReason) || releaseReason === "superseded") {
      const persisted = await this.readPersistedSession(sessionId);
      const deadline = persisted && restartRecoveryDeadlineFromPersisted(persisted);
      if (
        persisted &&
        this.isReissuablePersistedSession(persisted) &&
        deadline !== undefined &&
        this.sessionNow() < deadline
      ) {
        const snapshot = this.terminalReleaseFromPersisted(sessionId, {
          ...persisted,
          // Use the existing terminal recovery namespace without making
          // ordinary superseded releases terminal outside restart recovery.
          release_reason:
            releaseReason === "superseded" ? "identity-recovery-superseded" : releaseReason,
          released_at_ms: this.sessionNow(),
        })!;
        await this.persistTerminalReleaseIfNeeded(snapshot);
        // The device-restart release already ran this session's device cleanup; the row's device
        // may belong to another session by now, so announce only the terminal reason (#11206).
        this.notifySessionRelease(snapshot, { upgradeOnly: true });
        return snapshot.deviceId;
      }
    }
    if (releaseReason === "explicit-release") {
      const released = await this.releaseUnrecoveredReissuableRow(sessionId);
      if (released !== undefined) {
        return released;
      }
    }
    logger.warn(`Cannot release session ${sessionId}: not found`);
    return null;
  }

  /**
   * An explicit release of a session this daemon does not hold, whose row a call naming the UUID
   * could still issue again (#11461): a restart handoff the startup deadline left to the follow-up
   * sweep, one whose recovery failed without terminalizing it, or a `plan-auto-release`. An
   * explicit release is terminal and never rehydrated, so the row is terminalized rather than
   * answered "already released" and brought back. One statement, conditioned on the incarnation
   * read: a recovery's claim (this daemon's or a peer's) advances the generation, so a row someone
   * took in between is left alone, as is a row another live daemon owns. An active row is never
   * touched: it is not in this daemon's map, so it is not this daemon's session.
   *
   * Resolves the row's device once terminalized, or undefined when there was nothing to release.
   */
  private async releaseUnrecoveredReissuableRow(sessionId: string): Promise<string | undefined> {
    // A recovery's claim can land between the read and the conditional write. The release is
    // not dropped for that: the row is released at its new generation, or, once the recovery
    // has started publishing the session, through the path that releases a session being created.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.sessions.has(sessionId)) {
        break;
      }
      if (this.isSessionBeingRecreated(sessionId)) {
        return (await this.releaseSession(sessionId, "explicit-release")) ?? undefined;
      }
      const released = await this.tryReleaseUnrecoveredReissuableRow(sessionId);
      if (released !== "row-changed") {
        return released;
      }
    }
    // Published by the recovery that won: the caller releases the live session (the daemon
    // request handler does, cutting its calls like any explicit release).
    return undefined;
  }

  /** One conditional release of the row as read; `row-changed` when another writer got there first. */
  private async tryReleaseUnrecoveredReissuableRow(
    sessionId: string,
  ): Promise<string | undefined | "row-changed"> {
    const persisted = await this.readPersistedSession(sessionId);
    if (!persisted?.release_reason || !this.isReissuablePersistedSession(persisted)) {
      return undefined;
    }
    if (this.isRowOwnedByLivePeer(persisted)) {
      logger.info(
        `[SessionManager] Not releasing session ${sessionId}: another AutoMobile daemon ` +
          `(${persisted.daemon_session_id}) owns its row`,
      );
      return undefined;
    }
    await this.deviceSessionRepository.markReleased(
      sessionId,
      releasedRowStatus("explicit-release"),
      this.sessionNow(),
      "explicit-release",
      persisted.stable_identity_generation === undefined
        ? {}
        : { expectedRowGeneration: persisted.stable_identity_generation },
    );
    return (await this.fenceExplicitlyReleasedRow(sessionId)) ?? "row-changed";
  }

  /** Whether another live daemon owns `row`: such a row is that daemon's to recover or end. */
  private isRowOwnedByLivePeer(row: DeviceSession): boolean {
    const owner = row.daemon_session_id ?? null;
    return owner !== null && owner !== this.daemonSessionId && this.isLiveDaemonSession(owner);
  }

  /**
   * Fence a UUID whose row now reads `explicit-release`, and announce it. Resolves the row's
   * device, or undefined when the conditional release did not apply (the row changed first).
   */
  private async fenceExplicitlyReleasedRow(sessionId: string): Promise<string | undefined> {
    const current = await this.readPersistedSession(sessionId);
    const snapshot = current && this.terminalReleaseFromPersisted(sessionId, current);
    if (snapshot?.releaseReason !== "explicit-release") {
      logger.info(
        `[SessionManager] Session ${sessionId} was not released: its row changed first ` +
          `(now ${current?.status ?? "missing"}, ${current?.release_reason ?? "no release reason"})`,
      );
      return undefined;
    }
    this.terminalReleaseSnapshots.set(sessionId, snapshot);
    this.restartRecoveryActivityAt.delete(sessionId);
    // The handoff release already ran this session's device cleanup, and the row's device may
    // belong to another session by now: announce only the terminal reason (#11206).
    this.notifySessionRelease(snapshot, { upgradeOnly: true });
    logger.info(`[SessionManager] Released unrecovered session ${sessionId} (explicit-release)`);
    return snapshot.deviceId;
  }

  private async releasePendingSessionWork(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
    pendingSession: Promise<Session>,
  ): Promise<string | null> {
    const existingRelease = this.pendingSessionReleases.get(sessionId);
    if (existingRelease) {
      this.upgradeReleaseReason(existingRelease.reason, releaseReason);
      return await existingRelease.promise;
    }

    const reason: ReleaseReasonState = { value: releaseReason };
    const release: PendingSessionRelease = {
      promise: this.releaseAfterPendingSessionWork(sessionId, reason, allowExpired, pendingSession),
      reason,
    };
    this.pendingSessionReleases.set(sessionId, release);
    try {
      return await release.promise;
    } finally {
      if (this.pendingSessionReleases.get(sessionId) === release) {
        this.pendingSessionReleases.delete(sessionId);
      }
    }
  }

  private async releaseAfterPendingSessionWork(
    sessionId: string,
    reason: ReleaseReasonState,
    allowExpired: boolean,
    pendingSession: Promise<Session>,
  ): Promise<string | null> {
    try {
      // Bounded like the creation itself (#10963): a creation that outlives this is abandoned and
      // never publishes, so there is nothing left to release.
      await raceWithDeadline(pendingSession, {
        timer: this.timer,
        timeoutMs: SESSION_CREATE_WAIT_TIMEOUT_MS,
        unref: true,
        label: "Release of a session still being created",
      });
      return await this.releaseSessionForReason(sessionId, reason.value, allowExpired);
    } catch (error) {
      logger.warn(`Session ${sessionId} assignment failed before release: ${error}`);
      return null;
    }
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
      !this.releasingSessions.has(session) &&
      this.pendingSessionRebinds.get(session.sessionId)?.session !== session &&
      this.sessions.get(session.sessionId) === session
    );
  }

  /** Wait a bounded amount of time for active and caller-started release work. */
  async drainReleasePromises(
    timeoutMs: number,
    additionalReleases: ReadonlyArray<Promise<unknown>> = [],
  ): Promise<boolean> {
    this.releaseDrainStarted = true;
    const releases = [
      ...Array.from(this.activeReleasePromises, (release) => release.promise),
      ...this.lateReleaseWrites,
      // Shutdown does not wait out a retry's backoff: write every unconfirmed terminal row now,
      // before the database closes (#10959).
      ...this.retryPendingTerminalReleasesNow(),
      // Nor a live row's owed rewrite: left terminal, the next daemon would not rehydrate it.
      ...this.retryOwedSupersededRowReassertsNow(),
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
      this.pendingNonTerminalReleaseSnapshots.clear();
      this.supersededRowsUnderPendingRelease.clear();
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
      pending = Array.from(this.lateReleaseWrites).filter((write) => !settled.has(write));
    }
    return true;
  }

  /** Wait for a release already admitted for this session, if any. */
  async waitForSessionRelease(sessionId: string): Promise<void> {
    const pendingSessionRelease = this.pendingSessionReleases.get(sessionId);
    if (pendingSessionRelease) {
      await pendingSessionRelease.promise;
      return;
    }

    const release = this.releasePromises.get(sessionId);
    if (release) {
      await release.promise;
    }
  }

  /** Wait for this session's admitted release to settle, including failure, within a bound. */
  async waitForSessionReleaseWithin(sessionId: string, timeoutMs: number): Promise<boolean> {
    const release =
      this.pendingSessionReleases.get(sessionId) ?? this.releasePromises.get(sessionId);
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
      this.cancelNetworkConditionExpiry(sessionId);
      // Release removes the iOS app rule itself; stop renewing it first.
      this.iosAppNetworkLeases.stop(sessionId);
      const pendingCleanup = await this.drainReleaseTeardown(sessionId, session, operation);
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
        return this.abandonSupersededRelease(sessionId, deviceId, pendingCleanup);
      }
      const releasedAtMs = this.sessionNow();
      this.judgeOwnerLeaseForRelease(session, reason, "commit", operation);
      const releaseReason = reason.value;
      const terminalFenceHeldBefore = this.terminalReleaseSnapshots.has(sessionId);
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
      if (releaseWasForced(operation)) {
        return null;
      }
      // Final fence: evaluated synchronously right before the commit, with no
      // await in between, so the persistence awaits above cannot hide a newer
      // confirmation either. A terminal fence this release raised is lifted so
      // the live session keeps routing, and the terminal row it wrote is
      // rewritten live so a restart rehydrates it (#11206).
      if (releaseSuperseded(shouldCommit)) {
        return await this.abandonReleaseSupersededAfterPersist(
          session,
          releaseSnapshot,
          pendingCleanup,
          !terminalFenceHeldBefore,
        );
      }
      const owedReasons = this.supersededReasonsOwedTo(session);
      if (!this.commitReleaseRemoval(sessionId, session, deviceId, pendingCleanup)) {
        return null;
      }
      if (!releaseSnapshot.terminal) {
        this.terminalReleaseSnapshots.delete(sessionId);
        this.terminalReleaseReasonStates.delete(sessionId);
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
    } finally {
      this.releasingSessions.delete(session);
    }
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
      this.trackPendingDeviceCleanup(deviceId, pendingCleanup);
    }
    if (!removed) {
      logger.warn(`Skipping release finalization for ${sessionId}: session ownership changed`);
    }
    return removed;
  }

  /**
   * Await tracked setup and start best-effort restoration for a releasing
   * session, returning the teardown that must still finish before the device
   * is handed out again.
   *
   * Teardown is cleanup that must run to completion whether or not the request
   * that triggered the release was cancelled or hit its deadline, so it never runs
   * under the caller's signal: that signal is already aborted for a cancelled plan,
   * and every adb/simctl call that resolves `signal ?? getAbortSignal()` would fail
   * before dispatch, leaving the device shaped and marked unhealthy (#10198). The
   * restores that go through the ambient signal run under a teardown-owned shield
   * bounded by {@link SESSION_RELEASE_TEARDOWN_CAP_MS}; at the cap the shield aborts
   * and whatever has not finished is recorded as abandoned. The first attempts are
   * awaited here as before; only their retries are handed back as pending cleanup.
   */
  private async drainReleaseTeardown(
    sessionId: string,
    session: Session,
    operation?: SessionReleaseOperation,
  ): Promise<readonly Promise<void>[]> {
    if (!this.releaseNeedsTeardown(session)) {
      return [];
    }
    const forcedSignal = operation?.forcedAbort?.signal;
    return this.runUnderTeardownShield(
      () => this.startReleaseTeardown(sessionId, session, operation),
      forcedSignal,
    );
  }

  /** Own the restore signal until all stages settle, bounded by the shared teardown cap. */
  private async runUnderTeardownShield(
    start: () => Promise<readonly ReleaseTeardownStage[]>,
    /** Aborts the shield early: the release was forced and no longer holds the device (#11058). */
    forcedSignal?: AbortSignal,
  ): Promise<readonly Promise<void>[]> {
    const shield = new AbortController();
    if (forcedSignal) {
      if (forcedSignal.aborted) {
        shield.abort(forcedSignal.reason);
      } else {
        forcedSignal.addEventListener("abort", () => shield.abort(forcedSignal.reason), {
          once: true,
        });
      }
    }
    const startedAtMs = this.sessionNow();
    const capHandle = this.timer.setTimeout(() => {
      shield.abort(new ActionableError("Session release teardown exceeded its budget"));
    }, SESSION_RELEASE_TEARDOWN_CAP_MS);
    try {
      const stages = await runWithAbortSignal(shield.signal, start);
      const cleanups = stages.flatMap((stage) => {
        const bounded = this.boundTeardownStage(stage, startedAtMs);
        return bounded ? [bounded] : [];
      });
      void Promise.allSettled(cleanups).then(() => this.timer.clearTimeout(capHandle));
      return cleanups;
    } catch (error) {
      this.timer.clearTimeout(capHandle);
      throw error;
    }
  }

  /** A release with nothing to restore skips the shield and cap timer entirely. */
  private releaseNeedsTeardown(session: Session): boolean {
    const {
      keepScreenAwake,
      biometricEnrollment,
      networkCondition,
      clock,
      rotation,
      screenReader,
    } = session.cacheData;
    return (
      keepScreenAwake?.applied === true ||
      Boolean(biometricEnrollment || networkCondition || clock || rotation || screenReader) ||
      this.abandonedScreenReaders.has(session.assignedDevice) ||
      this.abandonedRotations.has(session.assignedDevice) ||
      Array.from(this.sessionSetupPromises).some((setup) => setup.session === session)
    );
  }

  /**
   * Settle a capped stage at the teardown cap so the device stops being quarantined,
   * recording the restore it left undone. Stages without `abandon` (setup, screen
   * reader, clock, rotation) keep their own budgets and run to their own end.
   */
  private boundTeardownStage(
    stage: ReleaseTeardownStage,
    startedAtMs: number,
  ): Promise<void> | null {
    const { pending, abandon } = stage;
    if (!pending || !abandon) {
      return pending;
    }
    let settled = false;
    const tracked = pending.finally(() => {
      settled = true;
    });
    const capError = new Error("Session release teardown cap reached");
    return raceWithDeadline(tracked, {
      timer: this.timer,
      timeoutMs: Math.max(0, SESSION_RELEASE_TEARDOWN_CAP_MS - (this.sessionNow() - startedAtMs)),
      label: "Session release teardown",
      timeoutError: () => capError,
      onTimeout: () => {
        if (!settled) {
          abandon();
        }
      },
    }).catch((error: unknown) => {
      // Reaching the cap is the recorded outcome (`abandon` ran), not a failure to surface.
      if (error !== capError) {
        throw error;
      }
    });
  }

  private async startReleaseTeardown(
    sessionId: string,
    session: Session,
    operation?: SessionReleaseOperation,
  ): Promise<readonly ReleaseTeardownStage[]> {
    // Captured before any await: a rebind reassigns `session.assignedDevice`.
    const deviceId = session.assignedDevice;
    const keepScreenAwakeTarget = this.keepScreenAwakeRestoreTarget(session);
    const biometricTarget = this.biometricRestoreTarget(session);
    const networkTarget = this.networkConditionRestoreTarget(session);
    const setups = Array.from(this.sessionSetupPromises, (setup) =>
      setup.session === session ? setup.promise : null,
    ).filter((setup): setup is Promise<void> => setup !== null);
    // A forced release (#11058) stops before its next restore: the device may already belong to
    // the next owner. Whatever it started is aborted through `forcedAbort` and handed back as is.
    const forced = () => releaseWasForced(operation);
    // The clock, rotation and screen-reader restorers carry their own budgets and abandon
    // mechanisms and are not bound to the teardown cap, so they must not inherit its shield
    // either; the toggles they drive resolve the ambient signal themselves (#10159). They do run
    // under the release's forced signal, which only a forced release aborts (#11058).
    const forcedSignal = operation?.forcedAbort?.signal;
    const ownBudget = <T>(start: () => Promise<T>) => runWithAbortSignal(forcedSignal, start);
    let pendingSetups: Promise<void> | null = null;
    const steps: Array<() => Promise<ReleaseTeardownStage>> = [
      async () => {
        pendingSetups =
          setups.length > 0 ? (await this.waitForSessionSetup(sessionId, setups)).pending : null;
        return { pending: pendingSetups };
      },
      async () => ({
        pending: (await this.restoreKeepScreenAwakeBestEffort(session, forced)).pending,
        // A forced release (#11058) may already have handed the device to its next owner.
        abandon: () =>
          forced()
            ? logger.warn(
                `Gave up restoring keep-awake state on ${deviceId} after a forced release; ` +
                  `the screen may stay awake`,
              )
            : this.abandonCappedRestore(keepScreenAwakeTarget, "keep-screen-awake"),
      }),
      async () => ({
        pending: session.cacheData.biometricEnrollment
          ? (await this.getPendingBiometricRestoration(session, pendingSetups)).pending
          : null,
        abandon: () => this.abandonCappedRestore(biometricTarget, "biometric-enrollment"),
      }),
      async () => ({
        pending: session.cacheData.networkCondition
          ? (await this.getPendingNetworkRestoration(session, pendingSetups)).pending
          : null,
        abandon: () => this.abandonCappedRestore(networkTarget, "network-condition"),
      }),
      async () => ({
        pending: session.cacheData.clock
          ? (await ownBudget(() => this.getPendingClockRestoration(session, pendingSetups))).pending
          : null,
      }),
      async () => {
        // Snapshot before this release's own restore can record a fresh abandon: that one
        // waits for the next start or release instead of an immediate repeat attempt.
        const hadAbandonedRotation = this.abandonedRotations.has(session.assignedDevice);
        const own = session.cacheData.rotation
          ? (await ownBudget(() => this.getPendingRotationRestoration(session, pendingSetups)))
              .pending
          : null;
        return {
          pending:
            hadAbandonedRotation && !forced()
              ? ownBudget(() => this.retryAbandonedRotationAfter(session.assignedDevice, own))
              : own,
        };
      },
      async () => {
        const own = session.cacheData.screenReader
          ? (await ownBudget(() => this.getPendingScreenReaderRestoration(session, pendingSetups)))
              .pending
          : null;
        return {
          pending:
            this.abandonedScreenReaders.has(session.assignedDevice) && !forced()
              ? ownBudget(() => this.retryAbandonedScreenReaderAfter(session.assignedDevice, own))
              : own,
        };
      },
    ];
    const stages: ReleaseTeardownStage[] = [];
    for (const step of steps) {
      stages.push(await step());
      if (forced()) {
        break;
      }
    }
    return stages;
  }

  /** The teardown budget ran out with this restore unfinished: record it like an exhausted retry. */
  private abandonCappedRestore(
    target:
      | KeepScreenAwakeRestoreTarget
      | BiometricRestoreTarget
      | NetworkConditionRestoreTarget
      | null,
    reason: "keep-screen-awake" | "biometric-enrollment" | "network-condition",
  ): void {
    if (!target) {
      return;
    }
    logger.warn(
      `Session release teardown exceeded ${SESSION_RELEASE_TEARDOWN_CAP_MS}ms before the ${reason} ` +
        `restore finished on ${target.deviceId}; the device may hold session-modified state`,
    );
    this.abandonRestore(target, reason, () =>
      "state" in target
        ? this.restoreKeepScreenAwakeTarget(target)
        : "enrollment" in target
          ? this.restoreBiometricEnrollment(target)
          : this.restoreNetworkCondition(target),
    );
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
      const fenced = this.terminalReleaseSnapshots.get(snapshot.sessionId) ?? snapshot;
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
      this.terminalReleaseSnapshots.delete(sessionId);
      // The session lives on; a restart must not terminalize it from this release's intent.
      this.terminalReleaseJournal.resolve(sessionId);
    }
    if (pendingCleanup.length > 0) {
      this.trackPendingDeviceCleanup(deviceId, pendingCleanup);
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
      !this.refusedReleaseWrites.has(releaseSnapshot)
    ) {
      await this.reassertSupersededLiveRow(session, [releaseSnapshot.releaseReason]);
    } else if (liftTerminalFence && this.supersededReleaseReasons.get(session)?.size) {
      // This release's refusal proves only that its own write landed nothing. An earlier
      // superseded release's late row may have deferred its rewrite behind this fence.
      await this.reassertSupersededLiveRow(session, []);
    }
    return null;
  }

  /**
   * A superseded release lifted its terminal fence, but its terminal row may have landed (#11206).
   * Nothing else rewrites a terminal row, so re-upsert the live row, as a rebind does, while this
   * incarnation still holds the UUID unfenced. A failed write stays owed and is retried (#11557).
   * Resolves true when the live row was written.
   */
  private async reassertSupersededLiveRow(
    session: Session,
    supersededReasons: readonly string[],
  ): Promise<boolean> {
    supersededReasons = this.rememberSupersededReleaseReasons(session, supersededReasons);
    if (!this.isCurrentSession(session)) {
      return false;
    }
    if (this.isRebindUnderWay(session)) {
      // The rebind's row carries a binding this session does not hold yet, and this write could
      // land over it: owed instead, and settled when the rebind's row lands.
      this.oweSupersededRowReassert(session, supersededReasons);
      return false;
    }
    const writtenDevice = session.assignedDevice;
    const settle = this.expectSupersededRowReassert(session.sessionId, supersededReasons);
    try {
      await this.persistSession(
        session,
        session,
        this.supersededRowRewriteOptions(supersededReasons),
      );
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to re-persist live session ${session.sessionId} after its ` +
          `superseded release: ${errorMessage(error)}`,
        error,
      );
      // Owed before the in-flight count ends, so an activity write always sees one of the two.
      // A session that ended during the write is owed nothing, nor is one revived under its UUID.
      if (this.sessions.get(session.sessionId) === session) {
        this.oweSupersededRowReassert(session, supersededReasons);
      } else {
        // Unless a non-terminal release ended it: the superseded release's terminal row is then
        // still in place of that release's.
        this.restoreNonTerminalRowOverSupersededReleaseLater(session, supersededReasons);
      }
      return false;
    } finally {
      settle();
    }
    if (
      this.isCurrentSession(session) &&
      (this.isRebindUnderWay(session) || session.assignedDevice !== writtenDevice)
    ) {
      // A rebind began while the write was in flight, so the write may have landed over the
      // rebind's row with the binding from before it: still owed, for the binding now held.
      this.oweSupersededRowReassert(session, supersededReasons);
      return false;
    }
    this.settleOwedSupersededRowReassert(session);
    await this.restoreReleasedRowAfterReassert(session);
    return this.isCurrentSession(session);
  }

  /** Keep reasons beyond an owed entry's lifetime, without lending them to a same-UUID session. */
  private rememberSupersededReleaseReasons(
    session: Session,
    reasons: readonly string[],
  ): readonly string[] {
    const remembered = this.supersededReleaseReasons.get(session) ?? new Set<string>();
    for (const reason of reasons) {
      remembered.add(reason);
    }
    this.supersededReleaseReasons.set(session, remembered);
    return [...remembered];
  }

  /** Snapshot the attached liveness provider for the rewrite's statement guard (#11557). */
  private supersededRowRewriteOptions(
    supersededReasons: readonly string[],
    expectedRowGeneration?: number,
  ): UpsertActiveSessionOptions {
    const livePeerDaemonSessionIds = this.rowWriteLivePeerDaemonSessionIds();
    return {
      rewriteOverSupersededRelease: {
        supersededReasons,
        livePeerDaemonSessionIds,
        expectedRowGeneration,
      },
    };
  }

  /** Discovery failure propagates: an empty fallback would silently remove a statement guard. */
  private rowWriteLivePeerDaemonSessionIds(): string[] {
    return Array.from(this.liveDaemonSessionIds?.() ?? []).filter(
      (id) => id !== this.daemonSessionId,
    );
  }

  private guardedRowRewriteOptions(
    supersededReasons: readonly string[],
    expectedRowGeneration?: number,
  ): UpsertActiveSessionOptions {
    return {
      rewriteOverSupersededRelease: {
        supersededReasons,
        expectedRowGeneration,
        livePeerDaemonSessionIds: [],
        ownDaemonSessionId: this.daemonSessionId,
      },
    };
  }

  /** Only a refused first statement enters here; every subsequent attempt is still conditioned. */
  private async retryRefusedRowWrite<T>(
    error: DeviceSessionRowNotRewritableError | DeviceSessionRowNotReleasableError,
    sessionId: string,
    guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    write: (
      guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    ) => Promise<T>,
    releaseReason?: string,
    unlessDaemonShutdown?: boolean,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await this.deviceSessionRepository.getSession?.(sessionId);
      if (
        !this.deviceSessionRepository.getSession ||
        this.rowWritePermanentlyRefused(row, guard, releaseReason, unlessDaemonShutdown)
      ) {
        throw error;
      }
      if (row?.daemon_session_id && row.daemon_session_id !== this.daemonSessionId) {
        // Discovery errors propagate as transient failures; an empty fallback could erase a peer.
        return await write({
          ...guard,
          ownDaemonSessionId: undefined,
          livePeerDaemonSessionIds: this.rowWriteLivePeerDaemonSessionIds(),
        });
      }
      if (attempt === 1) {
        break;
      }
      // Expected hand-back race: the read now shows a row the first statement would write.
      logger.debug(`[SessionManager] Retrying writable row after statement miss for ${sessionId}`);
      try {
        return await write(guard);
      } catch (retryError) {
        if (
          !(retryError instanceof DeviceSessionRowNotRewritableError) &&
          !(retryError instanceof DeviceSessionRowNotReleasableError)
        ) {
          throw retryError;
        }
        // Reclassify the second miss; a still-writable row is transient, never a refusal.
        logger.debug(
          `[SessionManager] Reclassifying row write failure for ${sessionId}`,
          retryError,
        );
        error = retryError;
      }
    }
    throw new ActionableError(
      `Session ${sessionId} row stayed writable after two statement misses; retry its write.`,
    );
  }

  private rowWritePermanentlyRefused(
    row: DeviceSession | undefined,
    guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    releaseReason: string | undefined,
    unlessDaemonShutdown: boolean | undefined,
  ): boolean {
    if (!row) {
      return releaseReason !== undefined;
    }
    if (
      guard.expectedRowGeneration !== undefined &&
      row.stable_identity_generation !== guard.expectedRowGeneration
    ) {
      return true;
    }
    if (guard.unlessReleased && row.status === "released") {
      return true;
    }
    const reason = row.release_reason;
    if (!reason) {
      return false;
    }
    if (releaseReason !== undefined && outranksReleaseReason(reason, releaseReason)) {
      return true;
    }
    if (unlessDaemonShutdown && reason === "daemon-shutdown") {
      return true;
    }
    return isTerminalReleaseReason(reason) && !guard.supersededReasons.includes(reason);
  }

  private isRebindUnderWay(session: Session): boolean {
    return this.pendingSessionRebinds.get(session.sessionId)?.session === session;
  }

  /**
   * A release of the session began while the rewrite was in flight, so the rewrite may have landed
   * over that release's row, or have moved the row's generation under its guarded write: write the
   * released row again. A terminal fence is rewritten at once; a failed re-write is retried.
   */
  private async restoreReleasedRowAfterReassert(session: Session): Promise<void> {
    const sessionId = session.sessionId;
    const fence = this.terminalReleaseSnapshots.get(sessionId);
    if (!fence) {
      if (this.sessions.get(sessionId) !== session) {
        // Not awaited: a release that awaits this rewrite must not wait on its own end.
        this.trackReleaseDrainWrite(this.restoreNonTerminalRowAfterReassert(session));
      }
      return;
    }
    try {
      await this.persistSessionRelease(fence);
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to re-persist the terminal release of session ` +
          `${sessionId} after a live-row rewrite: ${errorMessage(error)}`,
        error,
      );
      this.trackReleaseDrainWrite(this.retryTerminalRowAfterRelease(sessionId));
      return;
    }
    // That release was superseded in turn, and its own rewrite may have landed before this row.
    await this.reassertSupersededLiveRow(session, [fence.releaseReason]);
  }

  /**
   * A terminal row's write failed outside the release that owns it (the re-write after a live-row
   * rewrite, or a write that outlived the release's deadline): hand the row to the terminal
   * release retry (#10959). That retry writes only for a fenced UUID that no session holds, so
   * not before the release that raised the fence has removed the session. Never rejects.
   */
  private async retryTerminalRowAfterRelease(sessionId: string): Promise<void> {
    await this.waitOutReleaseOf(sessionId);
    const fence = this.terminalReleaseSnapshots.get(sessionId);
    if (!fence) {
      // That release was superseded: it lifted its fence and rewrites the live row itself.
      return;
    }
    if (this.isSessionBeingRecreated(sessionId)) {
      logger.warn(
        `[SessionManager] The terminal release of session ${sessionId} is not persisted and ` +
          "is not retried: the session is still held behind its fence",
      );
      return;
    }
    this.scheduleTerminalReleaseRetry(fence);
  }

  /**
   * A non-terminal row's write failed: hand the row to the release retry, once the release that
   * issued it has ended. Until then that release may still take another reason and write that
   * row instead, which ends this one's retry. Never rejects.
   */
  private async retryNonTerminalRowAfterRelease(snapshot: SessionReleaseSnapshot): Promise<void> {
    await this.waitOutReleaseOf(snapshot.sessionId);
    this.scheduleTerminalReleaseRetry(snapshot);
  }

  /**
   * A non-terminal release removed the session while the rewrite was in flight. Its write names
   * the row generation from before the rewrite, so it either was skipped or was overwritten: once
   * that release has ended, issue its write again for the generation the rewrite produced. A
   * failed write stays pending like any non-terminal release's. Never rejects.
   */
  private async restoreNonTerminalRowAfterReassert(session: Session): Promise<void> {
    const sessionId = session.sessionId;
    await this.waitOutReleaseOf(sessionId);
    const snapshot = this.releaseThatEnded(session);
    if (!snapshot || snapshot.terminal) {
      // No release ended the session, or one upgraded to terminal wrote its row after the rewrite.
      return;
    }
    const rewrittenGeneration = this.persistedRowGenerations.get(session);
    if (rewrittenGeneration === undefined && this.isSessionBeingRecreated(sessionId)) {
      // No generation to guard the write with, and the UUID is being issued again: left alone.
      return;
    }
    // Guarded by the rewrite's generation: a row the UUID's next incarnation wrote since is kept.
    // A write of its own: the release's first write, still in flight for the generation before
    // the rewrite, is skipped by its statement, and must not pass for this one having landed.
    const rewritten: SessionReleaseSnapshot = { ...snapshot };
    this.captureReleaseRowGeneration(
      rewritten,
      rewrittenGeneration ?? this.releaseRowGenerations.get(snapshot),
    );
    try {
      await this.persistSessionRelease(rewritten);
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to re-persist the ${snapshot.releaseReason} release of session ` +
          `${sessionId} after a live-row rewrite: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /** The superseded releases whose terminal row the session's owed rewrite is to replace. */
  private supersededReasonsOwedTo(session: Session): readonly string[] {
    const owed = this.owedSupersededRowReasserts.get(session.sessionId);
    return owed?.session === session ? [...owed.reasons] : [];
  }

  /** Not awaited by a release: the restore waits for the release under way to end. */
  private restoreNonTerminalRowOverSupersededReleaseLater(
    session: Session,
    supersededReasons: readonly string[],
  ): void {
    if (supersededReasons.length > 0) {
      this.trackReleaseDrainWrite(
        this.restoreNonTerminalRowOverSupersededRelease(session, supersededReasons),
      );
    }
  }

  /** The release that removed `session`: the one that finalized, or the one forced in its place. */
  private releaseThatEnded(session: Session): SessionReleaseSnapshot | undefined {
    return (
      this.finalizedSessionReleases.get(session)?.finalizedSnapshot ??
      this.forcedNonTerminalReleases.get(session)
    );
  }

  /**
   * A non-terminal release ended `session` under the terminal row of its own superseded release:
   * that row landed after the release's (the write was parked, #11206), or its rewrite was still
   * owed when the session ended (#11557). No terminal release ended the UUID, yet the row would
   * refuse the name for good and keep a restart from recovering a handed-off session. Only a
   * live-row write replaces a terminal row, so the row is written as the session held it and then
   * released again, for the generation that write produced. Never rejects.
   */
  private async restoreNonTerminalRowOverSupersededRelease(
    superseded: Session,
    supersededReasons: readonly string[],
  ): Promise<void> {
    supersededReasons = this.rememberSupersededReleaseReasons(superseded, supersededReasons);
    const sessionId = superseded.sessionId;
    let session = superseded;
    const settle = this.expectSupersededRowReassert(sessionId, supersededReasons);
    try {
      await this.waitOutReleaseOf(sessionId);
      await this.waitOutRecreationOf(sessionId);
      // The name may have been issued and released again since: the row is then written as its
      // last incarnation held it.
      session = this.latestFinalizedSessionIdentities.get(sessionId)?.deref() ?? superseded;
      supersededReasons = [
        ...new Set([...supersededReasons, ...(this.supersededReleaseReasons.get(session) ?? [])]),
      ];
      const ended = this.releaseThatEnded(session);
      if (
        !ended ||
        ended.terminal ||
        this.terminalReleaseSnapshots.has(sessionId) ||
        this.sessions.has(sessionId)
      ) {
        // A terminal release ended the UUID after all, or the name was issued again: that
        // incarnation's row replaced the terminal one, or the late write's own rewrite does.
        return;
      }
      try {
        if (!(await this.replaceSupersededReleaseRow(session, supersededReasons))) {
          return;
        }
      } catch (error) {
        logger.warn(
          `[SessionManager] Failed to replace the superseded release's terminal row of session ` +
            `${sessionId}, which a non-terminal release ended: ${errorMessage(error)}`,
          error,
        );
        // Retried with the release's own row, which is written once this one is replaced.
        const pending: SessionReleaseSnapshot = { ...ended };
        this.captureReleaseRowGeneration(pending, this.releaseRowGenerations.get(ended));
        this.supersededRowsUnderPendingRelease.set(sessionId, {
          session,
          reasons: supersededReasons,
          release: pending,
        });
        this.recordPendingNonTerminalRelease(pending);
        this.scheduleTerminalReleaseRetry(pending);
        return;
      }
    } finally {
      settle();
    }
    await this.restoreNonTerminalRowAfterReassert(session);
  }

  /**
   * Write the row of the ended `session` as it held it, over the terminal row of its superseded
   * release. Resolves false, writing nothing, when the row is no longer that release's, or is
   * another daemon's session by now. Rejects when the read or the write fails.
   */
  private async replaceSupersededReleaseRow(
    session: Session,
    supersededReasons: readonly string[],
  ): Promise<boolean> {
    supersededReasons = [
      ...new Set([...supersededReasons, ...(this.supersededReleaseReasons.get(session) ?? [])]),
    ];
    const row = await this.deviceSessionRepository.getSession?.(session.sessionId);
    if (
      !row?.release_reason ||
      !supersededReasons.includes(row.release_reason) ||
      this.isRowOwnedByLivePeer(row)
    ) {
      return false;
    }
    await this.persistSession(
      session,
      session,
      this.supersededRowRewriteOptions(supersededReasons),
    );
    return true;
  }

  /**
   * Resolve once the release in flight for the UUID, if any, has ended or was forced: a forced
   * release has given the session up already and may never settle (#10963). Never rejects.
   */
  private async waitOutReleaseOf(sessionId: string): Promise<void> {
    const release = this.releasePromises.get(sessionId);
    if (!release || release.forced) {
      return;
    }
    try {
      // Without a deadline: only the force's signal ends the wait before the release does.
      await raceWithDeadline(release.promise, {
        timer: this.timer,
        signal: release.forcedAbort?.signal,
        label: "Session release",
      });
    } catch (error) {
      // The release reports its failure to its own caller, and a force is its own announcement:
      // only the end of the wait matters here.
      logger.debug(
        `[SessionManager] Release of session ${sessionId} failed or was forced while a row ` +
          `write waited on it: ${errorMessage(error)}`,
      );
    }
  }

  /** Resolve once no issue of the UUID is in flight (it published, or failed). Never rejects. */
  private async waitOutRecreationOf(sessionId: string): Promise<void> {
    for (;;) {
      const issue =
        this.pendingSessionAssignments.get(sessionId) ??
        this.pendingSessionCreations.get(sessionId)?.promise;
      if (!issue) {
        return;
      }
      try {
        await issue;
      } catch (error) {
        // The issue reports its failure to its own caller; only its end matters here.
        logger.debug(
          `[SessionManager] Issue of session ${sessionId} failed while a row write waited ` +
            `on it: ${errorMessage(error)}`,
        );
      }
      // The maps are cleared by the issue's own continuation, which may run after this one.
      await Promise.resolve();
      if (
        issue ===
        (this.pendingSessionAssignments.get(sessionId) ??
          this.pendingSessionCreations.get(sessionId)?.promise)
      ) {
        return;
      }
    }
  }

  /** Resolve once the rebind in flight for this incarnation, if any, has ended. Never rejects. */
  private async waitOutRebindOf(session: Session): Promise<void> {
    const rebind = this.pendingSessionRebinds.get(session.sessionId);
    if (rebind?.session !== session) {
      return;
    }
    try {
      await rebind.promise;
    } catch (error) {
      // The rebind reports its failure to its own caller; only its end matters here.
      logger.debug(
        `[SessionManager] Rebind of session ${session.sessionId} failed while a row write ` +
          `waited on it: ${errorMessage(error)}`,
      );
    }
  }

  /** Record a failed rewrite as owed and arm its next retry, while any are left (#11557). */
  private oweSupersededRowReassert(session: Session, supersededReasons: readonly string[]): void {
    supersededReasons = this.rememberSupersededReleaseReasons(session, supersededReasons);
    const sessionId = session.sessionId;
    const owed = this.owedSupersededRowReasserts.get(sessionId);
    const previous = owed?.session === session ? owed : undefined;
    if (owed?.handle !== undefined) {
      this.timer.clearTimeout(owed.handle);
    }
    const entry: OwedSupersededRowReassert = {
      session,
      reasons: new Set([...(previous?.reasons ?? []), ...supersededReasons]),
      attempt: (previous?.attempt ?? 0) + 1,
      drainAttempted: previous?.drainAttempted,
    };
    this.owedSupersededRowReasserts.set(sessionId, entry);
    this.armSupersededRowReassertRetry(entry);
  }

  private armSupersededRowReassertRetry(entry: OwedSupersededRowReassert): void {
    if (this.releaseDrainStarted && !entry.drainAttempted) {
      // A timer armed during shutdown's drain would outlive the database (#11058): one attempt
      // now, which the drain awaits.
      this.trackReleaseDrainWrite(this.retryOwedSupersededRowReassertDuringDrain(entry));
      return;
    }
    if (entry.attempt > SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS || this.releaseDrainStarted) {
      logger.warn(
        `[SessionManager] The live row of session ${entry.session.sessionId} is still not ` +
          `re-persisted after ${entry.attempt} attempt(s); its next activity write retries it`,
      );
      return;
    }
    entry.handle = this.timer.setTimeout(() => {
      entry.handle = undefined;
      this.trackReleaseDrainWrite(this.retryOwedSupersededRowReassert(entry).then(() => {}));
    }, this.supersededRowReassertBackoff.delayForAttempt(entry.attempt));
    (entry.handle as { unref?: () => void }).unref?.();
  }

  /**
   * Issue an owed rewrite again; resolves true when the live row was written. The entry is dropped
   * when the session ended, was revived as another incarnation or is fenced, and when the row
   * holds a terminal release that is not the superseded one: that row is the UUID's end, which
   * the session's next activity write acts on (#11498). Never rejects.
   */
  private async retryOwedSupersededRowReassert(entry: OwedSupersededRowReassert): Promise<boolean> {
    const { session } = entry;
    const sessionId = session.sessionId;
    const isOwed = (): boolean => this.owedSupersededRowReasserts.get(sessionId) === entry;
    if (!isOwed()) {
      return false;
    }
    if (!this.isCurrentSession(session)) {
      this.dropOwedSupersededRowReassert(entry);
      return false;
    }
    let persisted: DeviceSession | undefined;
    try {
      persisted = await this.readPersistedSession(sessionId);
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to read the row of live session ${sessionId} before ` +
          `re-persisting it: ${errorMessage(error)}`,
        error,
      );
      this.deferOwedSupersededRowReassert(entry);
      return false;
    }
    if (!isOwed()) {
      return false;
    }
    if (!this.isCurrentSession(session)) {
      this.dropOwedSupersededRowReassert(entry);
      return false;
    }
    if (this.supersededRowReassertMustStop(entry, persisted)) {
      // Peer ownership alone does not end the held session; that is an owner decision.
      this.dropOwedSupersededRowReassert(entry);
      return false;
    }
    if (this.releasingSessions.has(session) || this.isRebindUnderWay(session)) {
      // A release is under way: it removes the session (and this entry) unless it is superseded.
      // Or a rebind is: its row carries the new binding, which this session does not hold yet.
      this.deferOwedSupersededRowReassert(entry);
      return false;
    }
    return await this.reassertSupersededLiveRow(session, [...entry.reasons]);
  }

  /** A peer's winning row is left for the activity or ownership path, without more rewrites. */
  private supersededRowReassertMustStop(
    entry: OwedSupersededRowReassert,
    persisted: DeviceSession | undefined,
  ): boolean {
    if (!persisted) {
      return false;
    }
    if (this.isRowOwnedByLivePeer(persisted)) {
      logger.warn(
        `[SessionManager] Dropping owed rewrite of session ${entry.session.sessionId}: live peer ` +
          `${persisted.daemon_session_id} owns its row`,
      );
      return true;
    }
    const release = this.terminalReleaseFromPersisted(entry.session.sessionId, persisted);
    const reasons = this.rememberSupersededReleaseReasons(entry.session, [...entry.reasons]);
    return release !== undefined && !reasons.includes(release.releaseReason);
  }

  /** An attempt that could not issue its write counts as a failed one. */
  private deferOwedSupersededRowReassert(entry: OwedSupersededRowReassert): void {
    if (
      this.owedSupersededRowReasserts.get(entry.session.sessionId) !== entry ||
      entry.handle !== undefined
    ) {
      return;
    }
    entry.attempt++;
    this.armSupersededRowReassertRetry(entry);
  }

  private dropOwedSupersededRowReassert(entry: OwedSupersededRowReassert): void {
    if (entry.handle !== undefined) {
      this.timer.clearTimeout(entry.handle);
      entry.handle = undefined;
    }
    if (this.owedSupersededRowReasserts.get(entry.session.sessionId) === entry) {
      this.owedSupersededRowReasserts.delete(entry.session.sessionId);
    }
  }

  /** The live row was written, or the session ended: nothing is owed to this incarnation. */
  private settleOwedSupersededRowReassert(session: Session): void {
    const owed = this.owedSupersededRowReasserts.get(session.sessionId);
    if (owed?.session === session) {
      this.dropOwedSupersededRowReassert(owed);
    }
  }

  /**
   * Whether `persistedRelease`, found under the live `session`, is the terminal row of its own
   * superseded release with the rewrite still owed (#11557), rather than the end of the UUID.
   */
  private isSupersededRowReassertOwed(
    session: Session,
    persistedRelease: SessionReleaseSnapshot,
  ): boolean {
    const owed = this.owedSupersededRowReasserts.get(session.sessionId);
    return owed?.session === session && owed.reasons.has(persistedRelease.releaseReason);
  }

  /**
   * An activity write was refused against a terminal row while the session's rewrite is owed with
   * no retry armed (the retries are exhausted): issue the rewrite now. True when it landed; the
   * row then carries this activity.
   */
  private async reassertOwedLiveRowForActivity(session: Session): Promise<boolean> {
    const owed = this.owedSupersededRowReasserts.get(session.sessionId);
    if (owed?.session !== session || owed.handle !== undefined) {
      return false;
    }
    return await this.retryOwedSupersededRowReassert(owed);
  }

  /** Issue every owed rewrite now, skipping its backoff, and return the writes (shutdown). */
  private retryOwedSupersededRowReassertsNow(): Promise<void>[] {
    return Array.from(this.owedSupersededRowReasserts.values(), (entry) => {
      if (entry.handle !== undefined) {
        this.timer.clearTimeout(entry.handle);
        entry.handle = undefined;
      }
      return this.retryOwedSupersededRowReassertDuringDrain(entry);
    });
  }

  /**
   * The drain's one attempt at an owed rewrite. The retry yields to a rebind or release under way
   * and the drain arms no later one, so wait for it first: a rebind that failed still leaves the
   * live row written before the database closes (one that landed settled the entry).
   */
  private async retryOwedSupersededRowReassertDuringDrain(
    entry: OwedSupersededRowReassert,
  ): Promise<void> {
    entry.drainAttempted = true;
    await this.waitOutRebindOf(entry.session);
    await this.waitOutReleaseOf(entry.session.sessionId);
    await this.retryOwedSupersededRowReassert(entry);
  }

  /**
   * Count a pending rewrite of `sessionId`'s row over the terminal row of the superseded releases
   * named by `supersededReasons`; the returned function ends it, once.
   */
  private expectSupersededRowReassert(
    sessionId: string,
    supersededReasons: readonly string[] = [],
  ): () => void {
    const pending = this.pendingSupersededRowReasserts;
    pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1);
    const reasons = this.supersededReasonsBeingRewritten;
    if (supersededReasons.length > 0) {
      reasons.set(sessionId, [...(reasons.get(sessionId) ?? []), ...supersededReasons]);
    }
    let settled = false;
    return () => {
      if (settled) {
        return;
      }
      settled = true;
      const remaining = (pending.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        pending.set(sessionId, remaining);
      } else {
        pending.delete(sessionId);
      }
      const left = reasons.get(sessionId) ?? [];
      for (const reason of supersededReasons) {
        const index = left.indexOf(reason);
        if (index >= 0) {
          left.splice(index, 1);
        }
      }
      if (left.length === 0) {
        reasons.delete(sessionId);
      }
    };
  }

  private upgradeReleaseReason(reason: ReleaseReasonState, candidate: string): void {
    if (candidate === "device-killed" && reason.value !== candidate) {
      reason.value = candidate;
      return;
    }
    if (reason.value === "device-killed") {
      return;
    }
    if (candidate === "daemon-shutdown" && !isTerminalReleaseReason(reason.value)) {
      reason.value = candidate;
      return;
    }
    if (outranksReleaseReason(candidate, reason.value)) {
      reason.value = candidate;
    }
  }

  private createReleaseReasonState(sessionId: string, releaseReason: string): ReleaseReasonState {
    const reason: ReleaseReasonState = { value: releaseReason };
    const terminalReleaseReason = this.terminalReleaseSnapshots.get(sessionId)?.releaseReason;
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
    this.captureReleaseRowGeneration(upgraded, this.releaseRowGenerations.get(snapshot));
    this.releaseReasonPredecessors.set(upgraded, [
      ...(this.releaseReasonPredecessors.get(snapshot) ?? []),
      snapshot.releaseReason,
    ]);
    return upgraded;
  }

  private captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void {
    if (rowGeneration !== undefined) {
      this.releaseRowGenerations.set(snapshot, rowGeneration);
    }
  }

  /**
   * A release never replaces a live peer's row or an unrelated terminal reason (#11557).
   * A non-terminal one also applies only to its captured incarnation (#11129). A committed
   * terminal release can replace this incarnation's own known superseded terminal reason.
   * A parked non-terminal write also preserves the shutdown handoff of its incarnation.
   */
  private releaseWritePrecondition(snapshot: SessionReleaseSnapshot): MarkReleasedOptions {
    // A refused creation's shutdown fence retires only the generation its upsert wrote.
    const expectedRowGeneration =
      snapshot.terminal && snapshot.releaseReason !== "daemon-shutdown"
        ? undefined
        : this.releaseRowGenerations.get(snapshot);
    const held = this.sessions.get(snapshot.sessionId);
    const supersededReasons = held ? this.supersededReleaseReasons.get(held) : undefined;
    return {
      ...(expectedRowGeneration === undefined ? {} : { expectedRowGeneration }),
      ...(!snapshot.terminal && snapshot.releaseReason !== "daemon-shutdown"
        ? { unlessDaemonShutdown: true }
        : {}),
      unlessTerminalOrOwnedByLivePeer: {
        livePeerDaemonSessionIds: [],
        ownDaemonSessionId: this.daemonSessionId,
        reportRefusal: true,
        // A committed release may replace our known superseded release; its own reason must
        // never become another superseded row eligible for a later live rewrite.
        supersededReasons:
          snapshot.terminal && !supersededReasons?.has(snapshot.releaseReason)
            ? [
                ...(supersededReasons ?? []),
                ...(this.releaseReasonPredecessors.get(snapshot) ?? []),
              ]
            : [],
      },
    };
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
      this.terminalReleaseReasonStates.set(snapshot.sessionId, reason);
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
    if (this.pendingNonTerminalReleaseSnapshots.get(snapshot.sessionId) === snapshot) {
      this.pendingNonTerminalReleaseSnapshots.delete(snapshot.sessionId);
    }
    this.dropReleaseRetry(snapshot);
    if (upgradedSnapshot.terminal) {
      this.terminalReleaseReasonStates.set(upgradedSnapshot.sessionId, reason);
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
    const indexedTerminalReason = this.terminalReleaseReasonStates.get(snapshot.sessionId);
    if (indexedTerminalReason && indexedTerminalReason !== reason) {
      return null;
    }
    if (snapshot.terminal && reason.terminalPersisted && snapshot.releaseReason === reason.value) {
      return snapshot.deviceId;
    }
    let upgradedSnapshot = this.withReleaseReason(snapshot, reason.value);
    reason.finalizedSnapshot = upgradedSnapshot;
    reason.terminalPersisted = false;
    this.terminalReleaseReasonStates.set(upgradedSnapshot.sessionId, reason);
    const release = (async () => {
      await this.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      if (reason.value !== upgradedSnapshot.releaseReason) {
        upgradedSnapshot = this.withReleaseReason(upgradedSnapshot, reason.value);
        reason.finalizedSnapshot = upgradedSnapshot;
        this.terminalReleaseReasonStates.set(upgradedSnapshot.sessionId, reason);
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
    const existingIdentity = this.latestFinalizedSessionIdentities.get(session.sessionId);
    if (existingIdentity?.deref() === session) {
      return;
    }
    const identity = new WeakRef(session);
    this.latestFinalizedSessionIdentities.set(session.sessionId, identity);
    this.finalizedSessionIdentityRegistry.register(session, {
      sessionId: session.sessionId,
      identity,
    });
  }

  private invalidateFinalizedSessionIdentity(sessionId: string): void {
    const identity = this.latestFinalizedSessionIdentities.get(sessionId);
    if (!identity) {
      return;
    }
    const session = identity.deref();
    if (session) {
      this.finalizedSessionReleases.delete(session);
    }
    this.latestFinalizedSessionIdentities.delete(sessionId);
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
    // A resumed UUID can be in flight before it publishes. Check immediately
    // before issuing a retry so it cannot release the newly active row. The release stays
    // pending: publishing ends it, and a resume that fails leaves the row to its retry (#11557).
    if (retryPending && this.isSessionBeingRecreated(snapshot.sessionId)) {
      return false;
    }
    try {
      if (snapshot.terminal) {
        // Durable before the write is issued: a crash while it is parked must not revive the UUID.
        this.terminalReleaseJournal.record({
          sessionId: snapshot.sessionId,
          reason: snapshot.releaseReason,
          // Read back by the next daemon on its own session clock: stored as wall ms (#11162).
          at: this.sessionClockToWall(snapshot.releasedAtMs),
        });
      }
      const precondition = { ...this.releaseWritePrecondition(snapshot), ...statementConditions };
      const issueWrite = (options: MarkReleasedOptions) =>
        this.deviceSessionRepository.markReleased(
          snapshot.sessionId,
          releasedRowStatus(snapshot.releaseReason),
          snapshot.releasedAtMs,
          snapshot.releaseReason,
          options,
        );
      const guard = precondition.unlessTerminalOrOwnedByLivePeer!;
      let refusedWrite: Promise<void> | undefined;
      const fallback = (error: unknown) => {
        if (
          !(error instanceof DeviceSessionRowNotReleasableError) ||
          guard.ownDaemonSessionId === undefined
        ) {
          throw error;
        }
        // A deadline and the first refusal can settle in the same turn; resume only once.
        return (refusedWrite ??= this.retryRefusedRowWrite(
          error,
          snapshot.sessionId,
          {
            ...guard,
            supersededReasons: guard.supersededReasons ?? [],
            expectedRowGeneration: precondition.expectedRowGeneration,
          },
          (next) => issueWrite({ ...precondition, unlessTerminalOrOwnedByLivePeer: next }),
          snapshot.releaseReason,
          precondition.unlessDaemonShutdown,
        ));
      };
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

  private handleReleaseWriteFailure(
    error: unknown,
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean,
  ): boolean {
    if (error instanceof DeviceSessionRowNotReleasableError) {
      // Expected refusal: this row is not ours to release. Resolve intent, without a retry.
      logger.debug(`[SessionManager] Release row refused for ${snapshot.sessionId}`);
      this.refusedReleaseWrites.add(snapshot);
      this.confirmReleaseWrite(snapshot);
      return true;
    }
    logger.warn(
      `[SessionManager] Failed to mark session released (${snapshot.releaseReason}): ${error}`,
    );
    if (!snapshot.terminal && !this.sessions.has(snapshot.sessionId)) {
      this.recordPendingNonTerminalRelease(snapshot);
      if (!this.shouldSurfaceReleasePersistenceFailure(snapshot, retryPending)) {
        // The session is gone, its row still reads active, and no caller is told: without a
        // retry a restart would rehydrate it (#11557). Retried like a terminal row, on the
        // same backoff. A failure that is surfaced is its caller's to retry.
        this.trackReleaseDrainWrite(this.retryNonTerminalRowAfterRelease(snapshot));
      }
    }
    if (this.shouldSurfaceReleasePersistenceFailure(snapshot, retryPending)) {
      throw toActionableError(
        error,
        `Failed to persist ${snapshot.terminal ? "terminal" : "non-terminal"} release for session ${snapshot.sessionId}`,
      );
    }
    return false;
  }

  private trackLateReleaseWrite(write: Promise<void>, snapshot: SessionReleaseSnapshot): void {
    // From here until the rewrite below is done, a terminal row under a session that lives on is
    // this parked write's: an activity write that finds it must not end the session (#11498).
    const settleReassert = snapshot.terminal
      ? this.expectSupersededRowReassert(snapshot.sessionId)
      : undefined;
    // The session the release that gave up on this write was ending, if it still held it.
    const released = this.sessions.get(snapshot.sessionId);
    const settled = write
      .then(
        async () => {
          this.confirmReleaseWrite(snapshot);
          // A superseded release lifted its fence while this write was parked (#11206).
          const live = this.sessions.get(snapshot.sessionId);
          if (snapshot.terminal && live) {
            await this.reassertSupersededLiveRow(live, [snapshot.releaseReason]);
          } else if (snapshot.terminal && released) {
            // And the session it spared has ended since, for a reason that is not terminal.
            await this.restoreNonTerminalRowOverSupersededRelease(released, [
              snapshot.releaseReason,
            ]);
          }
        },
        (error: unknown) => {
          if (error instanceof DeviceSessionRowNotReleasableError) {
            // Expected refusal: no terminal write landed, so no compensating rewrite is owed.
            logger.debug(`[SessionManager] Late release row refused for ${snapshot.sessionId}`);
            this.refusedReleaseWrites.add(snapshot);
            this.confirmReleaseWrite(snapshot);
            return;
          }
          logger.warn(`[SessionManager] Late session release write failed: ${errorMessage(error)}`);
          // The row is still active: without a retry a restart would revive the released UUID.
          // The release that gave up on this write at its deadline may not have removed the
          // session yet, and the retry is only for a UUID no session holds: after that release.
          if (snapshot.terminal) {
            this.trackReleaseDrainWrite(this.retryTerminalRowAfterRelease(snapshot.sessionId));
          }
        },
      )
      .finally(() => settleReassert?.());
    this.trackReleaseDrainWrite(settled);
  }

  /**
   * A release row landed. A terminal one's journal intent is no longer needed (#10959); a
   * non-terminal one is no longer pending, which also ends its retry (#11557).
   */
  private confirmReleaseWrite(snapshot: SessionReleaseSnapshot): void {
    if (snapshot.terminal) {
      this.terminalReleaseJournal.resolve(snapshot.sessionId, snapshot.releaseReason);
    } else if (this.pendingNonTerminalReleaseSnapshots.get(snapshot.sessionId) === snapshot) {
      this.pendingNonTerminalReleaseSnapshots.delete(snapshot.sessionId);
    }
    this.forgetSupersededRowUnder(snapshot);
    this.restartReleasePersistence.get(snapshot)?.resolve();
  }

  private forgetSupersededRowUnder(release: SessionReleaseSnapshot): void {
    if (this.supersededRowsUnderPendingRelease.get(release.sessionId)?.release === release) {
      this.supersededRowsUnderPendingRelease.delete(release.sessionId);
    }
  }

  /** The retry of `snapshot` no longer matters: forget it, and a terminal row's journal intent. */
  private dropReleaseRetry(snapshot: SessionReleaseSnapshot): void {
    const pending = this.pendingTerminalReleaseRetries.get(snapshot.sessionId);
    if (pending?.snapshot === snapshot) {
      if (pending.handle !== undefined) {
        this.timer.clearTimeout(pending.handle);
      }
      this.pendingTerminalReleaseRetries.delete(snapshot.sessionId);
    }
    this.forgetSupersededRowUnder(snapshot);
    if (snapshot.terminal) {
      this.terminalReleaseJournal.resolve(snapshot.sessionId, snapshot.releaseReason);
    }
  }

  /**
   * Queue another write of a release row, after the next backoff delay: a terminal row (#10959),
   * or the pending non-terminal row of a session that is gone (#11557). A terminal row's retry
   * replaces a non-terminal one's for the same UUID, never the reverse.
   */
  private scheduleTerminalReleaseRetry(snapshot: SessionReleaseSnapshot): void {
    const pending = this.pendingTerminalReleaseRetries.get(snapshot.sessionId);
    if (!snapshot.terminal && pending?.snapshot.terminal) {
      return;
    }
    if (!this.isTerminalReleaseRetryCurrent(snapshot)) {
      this.dropReleaseRetry(snapshot);
      return;
    }
    const attempt = (pending?.snapshot === snapshot ? pending.attempt : 0) + 1;
    if (pending?.handle !== undefined) {
      this.timer.clearTimeout(pending.handle);
    }
    if (this.releaseDrainStarted) {
      this.retryTerminalReleaseDuringDrain(snapshot, attempt, pending);
      return;
    }
    const entry: TerminalReleaseRetry = { snapshot, attempt };
    entry.handle = this.timer.setTimeout(() => {
      entry.handle = undefined;
      void this.retryTerminalReleaseWrite(entry);
    }, this.terminalReleaseRetryBackoff.delayForAttempt(attempt));
    (entry.handle as { unref?: () => void }).unref?.();
    this.pendingTerminalReleaseRetries.set(snapshot.sessionId, entry);
    logger.warn(
      `[SessionManager] The ${snapshot.releaseReason} release of session ${snapshot.sessionId} ` +
        `is not persisted; retrying the write (attempt ${attempt})`,
    );
  }

  /**
   * Shutdown is draining (#11058): retry the write now and let the drain await it. One attempt per
   * snapshot during the drain, so a database that keeps failing cannot spin the drain.
   */
  private retryTerminalReleaseDuringDrain(
    snapshot: SessionReleaseSnapshot,
    attempt: number,
    pending: TerminalReleaseRetry | undefined,
  ): void {
    if (pending?.snapshot === snapshot && pending.shutdownAttempted) {
      this.pendingTerminalReleaseRetries.delete(snapshot.sessionId);
      logger.warn(
        `[SessionManager] The ${snapshot.releaseReason} release of session ` +
          `${snapshot.sessionId} is still not persisted at shutdown` +
          (snapshot.terminal ? "; the session stays fenced only until this process exits" : ""),
      );
      return;
    }
    const entry: TerminalReleaseRetry = { snapshot, attempt, shutdownAttempted: true };
    this.pendingTerminalReleaseRetries.set(snapshot.sessionId, entry);
    logger.warn(
      `[SessionManager] The ${snapshot.releaseReason} release of session ${snapshot.sessionId} ` +
        `is not persisted; retrying the write before shutdown (attempt ${attempt})`,
    );
    this.trackReleaseDrainWrite(this.retryTerminalReleaseWrite(entry));
  }

  /** Track a release write the shutdown drain must await before the database closes. */
  private trackReleaseDrainWrite(write: Promise<void>): void {
    this.lateReleaseWrites.add(write);
    void write.then(() => this.lateReleaseWrites.delete(write));
  }

  /**
   * The retry still matters. A terminal row's: the UUID is still fenced by this snapshot and not
   * being re-created. A non-terminal row's: the release is still pending, which a write that
   * landed, a re-issue of the name that published, and shutdown each end. While the name is being
   * issued again the retry waits ({@link retryTerminalReleaseWrite}): its write is conditioned on
   * the released incarnation's row, and an issue that fails leaves that row to release.
   */
  private isTerminalReleaseRetryCurrent(snapshot: SessionReleaseSnapshot): boolean {
    if (!snapshot.terminal) {
      return this.pendingNonTerminalReleaseSnapshots.get(snapshot.sessionId) === snapshot;
    }
    const fence = this.terminalReleaseSnapshots.get(snapshot.sessionId);
    return (
      fence !== undefined &&
      fence.releaseReason === snapshot.releaseReason &&
      !this.isSessionBeingRecreated(snapshot.sessionId)
    );
  }

  private async retryTerminalReleaseWrite(entry: TerminalReleaseRetry): Promise<void> {
    const { snapshot } = entry;
    if (!(await this.isReleaseRetryDue(entry))) {
      return;
    }
    try {
      const precondition = await this.prepareRetriedReleaseWrite(entry);
      if (!precondition) {
        return;
      }
      const issueWrite = (options: MarkReleasedOptions) =>
        this.deviceSessionRepository.markReleased(
          snapshot.sessionId,
          releasedRowStatus(snapshot.releaseReason),
          snapshot.releasedAtMs,
          snapshot.releaseReason,
          options,
        );
      const guard = precondition.unlessTerminalOrOwnedByLivePeer!;
      let refusedWrite: Promise<void> | undefined;
      const fallback = (error: unknown) => {
        if (
          !(error instanceof DeviceSessionRowNotReleasableError) ||
          guard.ownDaemonSessionId === undefined
        ) {
          throw error;
        }
        // A deadline and the first refusal can settle in the same turn; resume only once.
        return (refusedWrite ??= this.retryRefusedRowWrite(
          error,
          snapshot.sessionId,
          {
            ...guard,
            supersededReasons: guard.supersededReasons ?? [],
            expectedRowGeneration: precondition.expectedRowGeneration,
          },
          (next) => issueWrite({ ...precondition, unlessTerminalOrOwnedByLivePeer: next }),
          snapshot.releaseReason,
          precondition.unlessDaemonShutdown,
        ));
      };
      const deadlineNow = () => this.timer.monotonicNow?.() ?? this.timer.now();
      const startedAtMs = deadlineNow();
      let deadlineExpired = false;
      let write = issueWrite(precondition);
      const deadlineOptions = {
        timer: this.timer,
        timeoutMs: SESSION_RELEASE_PERSIST_TIMEOUT_MS,
        unref: true,
        label: "Session release retry",
        timeoutError: () =>
          new SessionReleasePersistTimeoutError(
            snapshot.sessionId,
            snapshot.releaseReason,
            SESSION_RELEASE_PERSIST_TIMEOUT_MS,
          ),
        // The retry's first statement can still refuse after its race has timed out.
        onTimeout: () => {
          deadlineExpired = true;
          void write.catch(fallback).catch((error: unknown) => {
            // The timeout already leaves this write owed to the existing retry backoff.
            logger.debug(
              `[SessionManager] Late release retry failed for ${snapshot.sessionId}`,
              error,
            );
          });
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
          // Fallback is already running; the timed-out retry leaves it to settle as before.
          onTimeout: undefined,
        });
      }
    } catch (error) {
      if (error instanceof DeviceSessionRowNotReleasableError) {
        if (await this.wasRetriedReleaseWriteSkipped(entry)) {
          this.scheduleTerminalReleaseRetry(snapshot);
          return;
        }
        // Expected refusal: the winning row is left untouched and this release is no longer owed.
        logger.debug(`[SessionManager] Retried release row refused for ${snapshot.sessionId}`);
        this.refusedReleaseWrites.add(snapshot);
        this.confirmReleaseWrite(snapshot);
        this.dropReleaseRetry(snapshot);
        return;
      }
      logger.warn(
        `[SessionManager] Retrying the ${snapshot.releaseReason} release write of session ` +
          `${snapshot.sessionId} failed: ${errorMessage(error)}`,
      );
      if (this.pendingTerminalReleaseRetries.get(snapshot.sessionId) === entry) {
        this.scheduleTerminalReleaseRetry(snapshot);
      }
      return;
    }
    if (await this.wasRetriedReleaseWriteSkipped(entry)) {
      this.scheduleTerminalReleaseRetry(snapshot);
      return;
    }
    this.confirmReleaseWrite(snapshot);
    if (this.pendingTerminalReleaseRetries.get(snapshot.sessionId) === entry) {
      this.pendingTerminalReleaseRetries.delete(snapshot.sessionId);
    }
  }

  /**
   * Whether a retried non-terminal write was skipped by its own precondition and is still owed: an
   * issue of the name that failed claimed the row and handed it back while the write was in
   * flight, so the generation it named is gone and the row still reads as a restart would
   * rehydrate it. A read that fails leaves the write counted as landed, as before the read.
   */
  private async wasRetriedReleaseWriteSkipped(entry: TerminalReleaseRetry): Promise<boolean> {
    const { snapshot } = entry;
    if (snapshot.terminal || this.pendingTerminalReleaseRetries.get(snapshot.sessionId) !== entry) {
      return false;
    }
    try {
      const row = await this.deviceSessionRepository.getSession?.(snapshot.sessionId);
      return (
        row !== undefined &&
        row.release_reason !== snapshot.releaseReason &&
        this.pendingTerminalReleaseRetries.get(snapshot.sessionId) === entry &&
        this.isRecoverablePersistedSession(row) &&
        !this.isRowOwnedByLivePeer(row) &&
        !this.isSessionBeingRecreated(snapshot.sessionId)
      );
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to read the row of session ${snapshot.sessionId} after ` +
          `retrying its ${snapshot.releaseReason} release: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  /** The entry is still the UUID's retry and still matters; forgotten when it no longer does. */
  private isReleaseRetryStillOwed(entry: TerminalReleaseRetry): boolean {
    const { snapshot } = entry;
    if (this.pendingTerminalReleaseRetries.get(snapshot.sessionId) !== entry) {
      return false;
    }
    if (!this.isTerminalReleaseRetryCurrent(snapshot)) {
      this.dropReleaseRetry(snapshot);
      return false;
    }
    return true;
  }

  /**
   * Whether the entry's write is to be issued now. A non-terminal row yields to an issue of the
   * name under way: the row is that issue's to claim. Once it publishes the release is no longer
   * pending; if it fails, the row is still this release's to write, so the retry is armed again
   * (or, in shutdown's drain, which arms none, waits for the issue to end).
   */
  private async isReleaseRetryDue(entry: TerminalReleaseRetry): Promise<boolean> {
    const { snapshot } = entry;
    if (!this.isReleaseRetryStillOwed(entry)) {
      return false;
    }
    if (snapshot.terminal || !this.isSessionBeingRecreated(snapshot.sessionId)) {
      return true;
    }
    if (!entry.shutdownAttempted) {
      this.scheduleTerminalReleaseRetry(snapshot);
      return false;
    }
    await this.waitOutRecreationOf(snapshot.sessionId);
    return this.isReleaseRetryStillOwed(entry);
  }

  /**
   * What must precede a retried release write: the superseded release's terminal row under a
   * pending non-terminal release is replaced first ({@link supersededRowsUnderPendingRelease}),
   * and the precondition is read. Resolves undefined when the entry was replaced meanwhile;
   * rejects when a write or a read fails.
   */
  private async prepareRetriedReleaseWrite(
    entry: TerminalReleaseRetry,
  ): Promise<MarkReleasedOptions | undefined> {
    const { snapshot } = entry;
    const superseded = this.supersededRowsUnderPendingRelease.get(snapshot.sessionId);
    if (superseded?.release === snapshot) {
      const settle = this.expectSupersededRowReassert(snapshot.sessionId, superseded.reasons);
      try {
        await this.replaceSupersededReleaseRow(superseded.session, superseded.reasons);
      } finally {
        settle();
      }
      this.forgetSupersededRowUnder(snapshot);
    }
    // A terminal write preserves peer/terminal rows; a non-terminal one also names its incarnation.
    const precondition = await this.retriedReleaseWritePrecondition(snapshot);
    return this.pendingTerminalReleaseRetries.get(snapshot.sessionId) === entry
      ? precondition
      : undefined;
  }

  /**
   * The precondition a retried release write carries. A non-terminal row is still pending because
   * its row reads live or recoverable with no session behind it, and an issue of the name that
   * failed may have claimed that row and handed it back meanwhile, which advances its generation
   * (#11243): the write then names the generation the row has now, while a restart would still
   * rehydrate the row, no live peer owns it and nothing holds or is issuing the UUID. Any other
   * row keeps the captured precondition, which leaves it alone.
   */
  private async retriedReleaseWritePrecondition(
    snapshot: SessionReleaseSnapshot,
  ): Promise<MarkReleasedOptions> {
    const captured = this.releaseWritePrecondition(snapshot);
    if (captured.expectedRowGeneration === undefined) {
      return captured;
    }
    const row = await this.deviceSessionRepository.getSession?.(snapshot.sessionId);
    if (
      !row ||
      row.stable_identity_generation === undefined ||
      !this.isRecoverablePersistedSession(row) ||
      this.isRowOwnedByLivePeer(row) ||
      this.isSessionBeingRecreated(snapshot.sessionId)
    ) {
      return captured;
    }
    return { ...captured, expectedRowGeneration: row.stable_identity_generation };
  }

  /** Issue every pending terminal retry now, skipping its backoff, and return the writes. */
  private retryPendingTerminalReleasesNow(): Promise<void>[] {
    return Array.from(this.pendingTerminalReleaseRetries.values(), (entry) => {
      if (entry.handle !== undefined) {
        this.timer.clearTimeout(entry.handle);
        entry.handle = undefined;
      }
      entry.shutdownAttempted = true;
      return this.retryTerminalReleaseWrite(entry);
    });
  }

  private isSessionBeingRecreated(sessionId: string): boolean {
    return (
      this.sessions.has(sessionId) ||
      this.pendingSessionCreations.has(sessionId) ||
      this.pendingSessionAssignments.has(sessionId)
    );
  }

  private shouldSurfaceReleasePersistenceFailure(
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean,
  ): boolean {
    // Device-disconnected releases are terminal, so the terminal check covers them.
    return (
      snapshot.terminal || retryPending || isDeviceRestartReleaseReason(snapshot.releaseReason)
    );
  }

  private recordPendingNonTerminalRelease(snapshot: SessionReleaseSnapshot): void {
    const pending = this.pendingNonTerminalReleaseSnapshots;
    if (
      !pending.has(snapshot.sessionId) &&
      pending.size >= MAX_PENDING_NON_TERMINAL_RELEASE_SNAPSHOTS
    ) {
      const oldestSessionId = pending.keys().next().value;
      if (oldestSessionId !== undefined) {
        pending.delete(oldestSessionId);
      }
    }
    pending.set(snapshot.sessionId, snapshot);
  }

  private async persistTerminalReleaseIfNeeded(snapshot: SessionReleaseSnapshot): Promise<void> {
    if (!snapshot.terminal) {
      return;
    }
    // Fence the UUID before durable persistence. If the write fails, callers
    // must still stop routing tools to a device that is already confirmed
    // lost; a later release retry can persist and complete removal.
    this.terminalReleaseSnapshots.set(snapshot.sessionId, snapshot);
    this.restartRecoveryActivityAt.delete(snapshot.sessionId);
    await this.persistSessionRelease(snapshot);
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

  private async restoreKeepScreenAwakeBestEffort(
    session: Session,
    forced: () => boolean = () => false,
  ): Promise<{ pending: Promise<void> | null }> {
    const target = this.keepScreenAwakeRestoreTarget(session);
    if (!target) {
      return { pending: null };
    }
    const restoration = this.restoreKeepScreenAwakeTarget(target).then(
      () => ({ outcome: "restored" as const }),
      (error: unknown) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Keep-awake restore timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.timer,
      timeoutMs: KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS,
      label: "Keep-awake restore",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return { outcome: "timed-out" as const };
      }
      throw error;
    });
    if (result.outcome === "failed") {
      logger.warn(
        `Failed to restore keep-awake state for session ${session.sessionId}: ${result.error}`,
      );
      // Quarantine the device until the retries settle, as the network restore does (#11145).
      return { pending: this.retryKeepScreenAwakeRestore(target, result.error, forced) };
    }
    if (result.outcome === "timed-out") {
      logger.warn(
        `Timed out after ${KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS}ms restoring keep-awake state for session ${session.sessionId}`,
      );
      return {
        pending: restoration.then((settled) =>
          settled.outcome === "failed"
            ? this.retryKeepScreenAwakeRestore(target, settled.error, forced)
            : undefined,
        ),
      };
    }
    return { pending: null };
  }

  private keepScreenAwakeRestoreTarget(session: Session): KeepScreenAwakeRestoreTarget | null {
    const state = session.cacheData.keepScreenAwake;
    if (session.platform !== "android" || !state?.applied) {
      return null;
    }
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      incarnation: this.deviceHealth?.incarnation(session.assignedDevice),
      state,
    };
  }

  private async restoreKeepScreenAwakeTarget(target: KeepScreenAwakeRestoreTarget): Promise<void> {
    if (!this.restoreIncarnationIsCurrent(target)) {
      return;
    }
    const device: BootedDevice = {
      name: target.deviceId,
      platform: "android",
      deviceId: target.deviceId,
    };
    await this.keepScreenAwakeRestorerFactory(device).restore(target.state);
    this.clearRestoreHealth(target, "keep-screen-awake");
  }

  /** Bounded retries after a failed keep-awake restore, then background health recovery. */
  private async retryKeepScreenAwakeRestore(
    target: KeepScreenAwakeRestoreTarget,
    initialError: unknown,
    forced: () => boolean,
  ): Promise<void> {
    let lastError = initialError;
    for (let attempt = 1; attempt <= KEEP_SCREEN_AWAKE_RESTORE_RETRY_ATTEMPTS; attempt++) {
      if (forced()) {
        // The device may belong to the next owner: never retry against it (#11058).
        logger.warn(
          `Not retrying the keep-awake restore for session ${target.sessionId} after a forced release: ${lastError}`,
        );
        return;
      }
      await this.timer.sleep(KEEP_SCREEN_AWAKE_RESTORE_RETRY_DELAY_MS);
      if (forced() || !this.restoreIncarnationIsCurrent(target)) {
        return;
      }
      try {
        await this.restoreKeepScreenAwakeTarget(target);
        return;
      } catch (error) {
        // Bounded: keep retrying, then hand the last failure to health recovery.
        lastError = error;
        logger.debug(
          `Retry ${attempt} restoring keep-awake state for session ${target.sessionId} failed: ${error}`,
        );
      }
    }
    logger.warn(
      `Gave up restoring keep-awake state for session ${target.sessionId} after ` +
        `${KEEP_SCREEN_AWAKE_RESTORE_RETRY_ATTEMPTS} retries; device ${target.deviceId} ` +
        `may stay awake: ${lastError}`,
    );
    this.abandonRestore(target, "keep-screen-awake", () =>
      this.restoreKeepScreenAwakeTarget(target),
    );
  }

  /**
   * Snapshot of what a restore must write, taken before any await. A rebind
   * reassigns `session.assignedDevice` while retries are still outstanding, so
   * resolving the device lazily from the session would aim them at the new
   * simulator and leave the old one dirty.
   */
  private biometricRestoreTarget(session: Session): BiometricRestoreTarget | null {
    const state = session.cacheData.biometricEnrollment;
    // Keyed on the cache alone, not session.platform. The slot is only ever
    // written by the iOS Simulator biometric path, so its presence is the
    // authoritative evidence that a simulator needs restoring — whereas
    // session.platform carries whatever the caller declared to setActiveDevice
    // and can disagree with the device actually bound.
    if (!state) {
      return null;
    }
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      incarnation: this.deviceHealth?.incarnation(session.assignedDevice),
      enrollment: state.initialEnrollment,
    };
  }

  private async restoreBiometricEnrollment(target: BiometricRestoreTarget): Promise<void> {
    const device: BootedDevice = {
      name: target.deviceId,
      platform: "ios",
      deviceId: target.deviceId,
    };
    if (!this.restoreIncarnationIsCurrent(target)) {
      return;
    }
    await this.biometricEnrollmentRestorerFactory(device).restore(target.enrollment);
    this.clearRestoreHealth(target, "biometric-enrollment");
  }

  private async restoreBiometricEnrollmentBestEffort(
    session: Session,
  ): Promise<{ pending: Promise<void> | null }> {
    const target = this.biometricRestoreTarget(session);
    if (!target) {
      return { pending: null };
    }
    const restoration = this.restoreBiometricEnrollment(target).then(
      () => ({ outcome: "restored" as const }),
      (error) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Biometric restore timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.timer,
      timeoutMs: BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS,
      label: "Biometric restore",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return { outcome: "timed-out" as const };
      }
      throw error;
    });
    if (result.outcome === "failed") {
      logger.warn(
        `Failed to restore biometric enrollment for session ${session.sessionId}: ${result.error}`,
      );
      // Quarantine the device until the retries below settle; a prompt
      // rejection otherwise returns a dirty simulator straight to the pool.
      return { pending: this.retryBiometricEnrollmentRestore(target, result.error) };
    }
    if (result.outcome === "timed-out") {
      logger.warn(
        `Timed out after ${BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS}ms restoring biometric enrollment for session ${session.sessionId}`,
      );
      return { pending: this.settleBiometricEnrollmentRestore(target, restoration) };
    }
    return { pending: null };
  }

  /** A slow restore can still fail; retry before the device leaves quarantine. */
  private async settleBiometricEnrollmentRestore(
    target: BiometricRestoreTarget,
    restoration: Promise<{ outcome: "restored" } | { outcome: "failed"; error: unknown }>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    logger.warn(
      `Failed to restore biometric enrollment for session ${target.sessionId}: ${result.error}`,
    );
    await this.retryBiometricEnrollmentRestore(target, result.error);
  }

  private async retryBiometricEnrollmentRestore(
    target: BiometricRestoreTarget,
    initialError: unknown,
  ): Promise<void> {
    let lastError = initialError;
    for (let attempt = 1; attempt <= BIOMETRIC_ENROLLMENT_RESTORE_RETRY_ATTEMPTS; attempt++) {
      await this.timer.sleep(BIOMETRIC_ENROLLMENT_RESTORE_RETRY_DELAY_MS);
      if (!this.restoreIncarnationIsCurrent(target)) {
        return;
      }
      try {
        await this.restoreBiometricEnrollment(target);
        logger.info(
          `Restored biometric enrollment for session ${target.sessionId} on retry ${attempt}`,
        );
        return;
      } catch (error) {
        // Teardown is best-effort: keep retrying, then report the last failure.
        lastError = error;
        logger.debug(
          `Retry ${attempt} restoring biometric enrollment for session ${target.sessionId} failed: ${error}`,
        );
      }
    }
    logger.warn(
      `Gave up restoring biometric enrollment for session ${target.sessionId} after ` +
        `${BIOMETRIC_ENROLLMENT_RESTORE_RETRY_ATTEMPTS} retries; device ${target.deviceId} ` +
        `may hold session-modified enrollment: ${lastError}`,
    );
    this.abandonRestore(target, "biometric-enrollment", () =>
      this.restoreBiometricEnrollment(target),
    );
  }

  /**
   * A timed-out setup can still write simulator state. Defer its restoration
   * until that write settles so an old command cannot overwrite the restore.
   */
  private restoreBiometricEnrollmentAfterSetups(
    session: Session,
    pendingSetups: Promise<void>,
  ): Promise<void> {
    return pendingSetups.then(async () => {
      const pendingRestoration = (await this.restoreBiometricEnrollmentBestEffort(session)).pending;
      await pendingRestoration;
    });
  }

  /**
   * Returned wrapped, never bare: `return somePromise` inside an async function
   * adopts that promise, which would make the caller await the very cleanup it
   * is trying to hand off and stall the release.
   */
  private async getPendingBiometricRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    if (pendingSetups && session.cacheData.biometricEnrollment) {
      return { pending: this.restoreBiometricEnrollmentAfterSetups(session, pendingSetups) };
    }
    return { pending: (await this.restoreBiometricEnrollmentBestEffort(session)).pending };
  }

  /** Use the same setup drain and pending device cleanup as network restoration. */
  private async getPendingClockRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    if (pendingSetups) {
      const deviceId = session.assignedDevice;
      const generation = this.clockRemovalGenerations.get(deviceId) ?? 0;
      return {
        pending: pendingSetups.then(async () => {
          if ((this.clockRemovalGenerations.get(deviceId) ?? 0) !== generation) {
            delete session.cacheData.clock;
            return;
          }
          const result = await this.getPendingClockRestoration(session, null);
          await result.pending;
        }),
      };
    }
    const state = session.cacheData.clock;
    if (!state) {
      return { pending: null };
    }
    const deviceId = session.assignedDevice;
    let targets = this.pendingClockRestores.get(deviceId);
    const existing = targets?.get(state);
    if (existing) {
      return existing.result;
    }
    if (!targets) {
      targets = new Map();
      this.pendingClockRestores.set(deviceId, targets);
    }
    const result = Promise.withResolvers<{ pending: Promise<void> | null }>();
    const target: PendingClockRestore = {
      state,
      removed: false,
      controller: new AbortController(),
      result: result.promise,
      clear: () => {
        if (session.cacheData.clock === state) {
          delete session.cacheData.clock;
        }
      },
    };
    // Publish the join point before starting any asynchronous restore work.
    targets.set(state, target);
    void this.startClockRestoration(deviceId, target).then(result.resolve, result.reject);
    return target.result;
  }

  private async startClockRestoration(
    deviceId: string,
    target: PendingClockRestore,
  ): Promise<{ pending: Promise<void> | null }> {
    const healthTarget = { deviceId, incarnation: this.deviceHealth?.incarnation(deviceId) };
    const device: BootedDevice = { name: deviceId, deviceId, platform: "android" };
    const signal = defaultDeviceClockRestoreRegistry.signal(deviceId);
    const restore = () =>
      defaultDeviceClockRestoreRegistry.runExclusive(
        deviceId,
        async () => {
          target.controller.signal.throwIfAborted();
          if (!this.restoreIncarnationIsCurrent(healthTarget)) {
            return;
          }
          await this.clockRestorerFactory(device).restore(target.state, target.controller.signal);
          target.controller.signal.throwIfAborted();
          defaultDeviceClockRestoreRegistry.restored(deviceId, target.state);
          target.clear();
          const targets = this.pendingClockRestores.get(deviceId);
          if (targets?.get(target.state) === target) {
            targets.delete(target.state);
            if (targets.size === 0) {
              this.pendingClockRestores.delete(deviceId);
            }
          }
          if (!this.pendingClockRestores.has(deviceId)) {
            this.clearRestoreHealth(healthTarget, "clock");
          }
        },
        undefined,
        signal,
      );
    const restoration = restore().then(
      () => ({ outcome: "restored" as const }),
      (error: unknown) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Clock restoration timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.timer,
      timeoutMs: CLOCK_RESTORE_TIMEOUT_MS,
      label: "Clock restoration",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return { outcome: "timed-out" as const };
      }
      throw error;
    });
    if (result.outcome === "restored") {
      return { pending: null };
    }
    logger.warn(`Clock restore ${result.outcome}; quarantining ${device.deviceId}`);
    if (healthTarget.incarnation === undefined) {
      logger.warn(
        `Failed to restore state on ${deviceId} (clock); no health marker could be keyed because the device has no pool incarnation`,
      );
    }
    if (
      healthTarget.incarnation !== undefined &&
      this.restoreIncarnationIsCurrent(healthTarget) &&
      !target.removed &&
      this.pendingClockRestores.get(deviceId)?.has(target.state)
    ) {
      this.deviceHealth?.markers.mark(deviceId, healthTarget.incarnation, "clock");
    }
    const pending = raceWithDeadline(
      this.retryClockRestore(device.deviceId, target, restoration, restore),
      {
        timer: this.timer,
        signal: target.controller.signal,
        label: "Pending clock restoration",
      },
    ).catch((error: unknown) => {
      if (!target.removed) {
        throw toActionableError(error, "Clock restoration failed");
      }
      // Proven removal retires ownership; no restoration may reach a replacement.
      logger.debug(`Retired clock restoration on removed device ${device.deviceId}`);
    });
    return { pending };
  }

  /** Same setup drain, deadline, retry delay and pool quarantine as network restoration.
   * Clock ownership remains pending beyond the network path's bounded retry batch.
   */
  private async retryClockRestore(
    deviceId: string,
    target: PendingClockRestore,
    restoration: Promise<{ outcome: "restored" } | { outcome: "failed"; error: unknown }>,
    restore: () => Promise<void>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    logger.warn(`Failed to restore clock on ${deviceId}`, result.error);
    while (!target.removed) {
      await this.timer.sleep(NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS);
      if (target.removed) {
        return;
      }
      try {
        await restore();
        return;
      } catch (error) {
        logger.warn(`Clock restore retry failed on ${deviceId}; device remains quarantined`, error);
      }
    }
  }

  /** Removal retires in-memory ownership; no retries may target a replacement device. */
  retireClockRestoration(deviceId: string): void {
    const incarnation = this.deviceHealth?.incarnation(deviceId);
    if (incarnation !== undefined) {
      this.deviceHealth?.markers.clear(deviceId, incarnation, "clock");
    }
    defaultDeviceClockRestoreRegistry.retire(deviceId);
    const targets = this.pendingClockRestores.get(deviceId);
    this.clockRemovalGenerations.set(
      deviceId,
      (this.clockRemovalGenerations.get(deviceId) ?? 0) + 1,
    );
    for (const target of targets?.values() ?? []) {
      target.removed = true;
      target.controller.abort();
      target.clear();
    }
    this.pendingClockRestores.delete(deviceId);
  }

  /**
   * A timed-out tracked network mutation can still issue `network delay/speed`
   * commands. Defer the restore until that setup settles, so a `none` restore
   * cannot land mid-mutation and then be re-shaped by a late command (issue #6012
   * review P1). Mirrors `restoreBiometricEnrollmentAfterSetups`.
   */
  private restoreNetworkConditionAfterSetups(
    session: Session,
    pendingSetups: Promise<void>,
  ): Promise<void> {
    return pendingSetups.then(async () => {
      const pendingRestoration = (await this.restoreNetworkConditionBestEffort(session)).pending;
      await pendingRestoration;
    });
  }

  /** Sequence restoration after any still-draining setup; deduplicate by owned slot. */
  private async getPendingRotationRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    if (pendingSetups) {
      const deviceId = session.assignedDevice;
      const generation = this.rotationRemovalGenerations.get(deviceId) ?? 0;
      return {
        pending: pendingSetups.then(async () => {
          if ((this.rotationRemovalGenerations.get(deviceId) ?? 0) !== generation) {
            delete session.cacheData.rotation;
            return;
          }
          const result = await this.getPendingRotationRestoration(session, null);
          await result.pending;
        }),
      };
    }
    const state = session.cacheData.rotation;
    if (!state) {
      return { pending: null };
    }
    const deviceId = session.assignedDevice;
    let targets = this.pendingRotationRestores.get(deviceId);
    const existing = targets?.get(state);
    if (existing) {
      return existing.result;
    }
    if (!targets) {
      targets = new Map();
      this.pendingRotationRestores.set(deviceId, targets);
    }
    const result = Promise.withResolvers<{ pending: Promise<void> | null }>();
    const target: PendingRotationRestore = {
      state,
      removed: false,
      controller: new AbortController(),
      result: result.promise,
      clear: () => {
        if (session.cacheData.rotation === state) {
          delete session.cacheData.rotation;
        }
      },
    };
    // Publish the join point before starting any asynchronous restore work.
    targets.set(state, target);
    void this.startRotationRestoration(deviceId, target).then(result.resolve, result.reject);
    return target.result;
  }

  private async startRotationRestoration(
    deviceId: string,
    target: PendingRotationRestore,
  ): Promise<{ pending: Promise<void> | null }> {
    const device: BootedDevice = { name: deviceId, deviceId, platform: "android" };
    const restore = async () => {
      target.controller.signal.throwIfAborted();
      await this.rotationRestorerFactory(device).restore(target.state, target.controller.signal);
      target.controller.signal.throwIfAborted();
      target.clear();
      const targets = this.pendingRotationRestores.get(deviceId);
      if (targets?.get(target.state) === target) {
        targets.delete(target.state);
        if (targets.size === 0) {
          this.pendingRotationRestores.delete(deviceId);
        }
      }
    };
    const restoration = restore().then(
      () => ({ outcome: "restored" as const }),
      (error: unknown) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Rotation restoration timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.timer,
      timeoutMs: NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
      label: "Rotation restoration",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return { outcome: "timed-out" as const };
      }
      throw toActionableError(error, "Rotation restoration failed");
    });
    if (result.outcome === "restored") {
      return { pending: null };
    }
    logger.warn(
      `Rotation restore ${result.outcome}; quarantining ${device.deviceId}: ${errorMessage(
        result.outcome === "failed" ? result.error : timeout,
      )}`,
    );
    const pending = raceWithDeadline(
      this.retryRotationRestore(device.deviceId, target, restoration, restore),
      {
        timer: this.timer,
        signal: target.controller.signal,
        label: "Pending rotation restoration",
      },
    ).catch((error: unknown) => {
      if (!target.removed) {
        throw toActionableError(error, "Rotation restoration failed");
      }
      // Proven removal retires ownership; no restoration may reach a replacement.
      logger.debug(`Retired rotation restoration on removed device ${device.deviceId}`);
    });
    return { pending };
  }

  /** Same setup drain, deadline and pool quarantine as network restoration.
   * Retries are bounded with the injected `Backoff`; after the cap the device
   * leaves quarantine instead of retrying forever.
   */
  private async retryRotationRestore(
    deviceId: string,
    target: PendingRotationRestore,
    restoration: Promise<{ outcome: "restored" } | { outcome: "failed"; error: unknown }>,
    restore: () => Promise<void>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    logger.warn(`Failed to restore rotation on ${deviceId}: ${errorMessage(result.error)}`);
    if (isNonRetryableRotationRestoreError(result.error)) {
      this.abandonRotationRestore(deviceId, target, result.error, "without retrying");
      return;
    }
    let lastError: unknown = result.error;
    for (let attempt = 1; attempt <= ROTATION_RESTORE_RETRY_ATTEMPTS; attempt++) {
      await this.timer.sleep(this.rotationRestoreBackoff.delayForAttempt(attempt));
      if (target.removed) {
        return;
      }
      try {
        await restore();
        return;
      } catch (error) {
        if (isNonRetryableRotationRestoreError(error)) {
          this.abandonRotationRestore(deviceId, target, error, `after ${attempt} retries`);
          return;
        }
        lastError = error;
        logger.warn(
          `Rotation restore retry ${attempt}/${ROTATION_RESTORE_RETRY_ATTEMPTS} failed on ${deviceId}; ` +
            `device remains quarantined: ${errorMessage(error)}`,
        );
      }
    }
    this.abandonRotationRestore(
      deviceId,
      target,
      lastError,
      `after ${ROTATION_RESTORE_RETRY_ATTEMPTS} retries`,
    );
  }

  /** Release the device from quarantine once the bounded rotation retries are spent. */
  private abandonRotationRestore(
    deviceId: string,
    target: PendingRotationRestore,
    lastError: unknown,
    when: string,
  ): void {
    if (target.removed) {
      return;
    }
    const { userRotation, accelerometerRotation, deviceStateRotationLock } = target.state;
    const lock =
      deviceStateRotationLock === undefined
        ? ""
        : `, device_state_rotation_lock=${deviceStateRotationLock}`;
    logger.warn(
      `Gave up restoring rotation settings on ${deviceId} ${when} ` +
        `(user_rotation=${userRotation ?? "unchanged"}, accelerometer_rotation=${accelerometerRotation ?? "unchanged"}${lock} ` +
        `not confirmed: ${errorMessage(lastError)}); releasing the device from cleanup. ` +
        `A fold or display change during the session can make the recorded settings unverifiable. ` +
        `Will try once more at the next session start or release on this device.`,
    );
    // An older abandoned baseline is the truer original; keep it over a newer session's.
    if (!this.abandonedRotations.has(deviceId)) {
      this.abandonedRotations.set(deviceId, target.state);
    }
    target.clear();
    const targets = this.pendingRotationRestores.get(deviceId);
    if (targets?.get(target.state) === target) {
      targets.delete(target.state);
      if (targets.size === 0) {
        this.pendingRotationRestores.delete(deviceId);
      }
    }
  }

  /** The older, truer baseline wins, so it runs after the session's own restoration settles. */
  private async retryAbandonedRotationAfter(
    deviceId: string,
    own: Promise<void> | null,
  ): Promise<void> {
    try {
      await own;
    } finally {
      await this.retryAbandonedRotationRestore(deviceId);
    }
  }

  /**
   * One bounded attempt at rotation settings an earlier release gave up on, awaited
   * before the device is handed to a new session; never on a timer. A transient failure
   * keeps the record for the next start or release. A window-manager-managed outcome is
   * definitively unrecoverable, so the record is dropped. Either way the device proceeds.
   */
  private retryAbandonedRotationRestore(deviceId: string): Promise<void> {
    const state = this.abandonedRotations.get(deviceId);
    if (!state) {
      return Promise.resolve();
    }
    const inFlight = this.abandonedRotationRetries.get(deviceId);
    if (inFlight) {
      return inFlight;
    }
    const controller = new AbortController();
    const device: BootedDevice = { name: deviceId, deviceId, platform: "android" };
    const forget = () => {
      if (this.abandonedRotations.get(deviceId) === state) {
        this.abandonedRotations.delete(deviceId);
      }
    };
    const attempt = (async () => {
      try {
        await raceWithDeadline(
          this.rotationRestorerFactory(device).restore(state, controller.signal),
          {
            timer: this.timer,
            timeoutMs: NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
            label: "Abandoned rotation restoration",
          },
        );
        forget();
        logger.info(`Restored rotation settings on ${deviceId} on its next natural attempt`);
      } catch (error) {
        controller.abort();
        if (isNonRetryableRotationRestoreError(error)) {
          forget();
          logger.warn(
            `Rotation settings on ${deviceId} cannot be restored (window manager owns rotation); ` +
              `dropping the abandoned restore: ${errorMessage(error)}`,
          );
          return;
        }
        logger.warn(
          `Rotation settings on ${deviceId} are still not restored; ` +
            `will try again at the next session start or release: ${errorMessage(error)}`,
        );
      }
    })().finally(() => {
      if (this.abandonedRotationRetries.get(deviceId) === attempt) {
        this.abandonedRotationRetries.delete(deviceId);
      }
    });
    this.abandonedRotationRetries.set(deviceId, attempt);
    return attempt;
  }

  /** Removal retires in-memory ownership; no retries may target a replacement device. */
  retireRotationRestoration(deviceId: string): void {
    const targets = this.pendingRotationRestores.get(deviceId);
    this.rotationRemovalGenerations.set(
      deviceId,
      (this.rotationRemovalGenerations.get(deviceId) ?? 0) + 1,
    );
    for (const target of targets?.values() ?? []) {
      target.removed = true;
      target.controller.abort();
      target.clear();
    }
    this.pendingRotationRestores.delete(deviceId);
    this.abandonedRotations.delete(deviceId);
  }

  /** Sequence restoration after any still-draining setup; deduplicate by owned slot (#10146). */
  private async getPendingScreenReaderRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    if (pendingSetups) {
      const deviceId = session.assignedDevice;
      const generation = this.screenReaderRemovalGenerations.get(deviceId) ?? 0;
      return {
        pending: pendingSetups.then(async () => {
          if ((this.screenReaderRemovalGenerations.get(deviceId) ?? 0) !== generation) {
            delete session.cacheData.screenReader;
            return;
          }
          const result = await this.getPendingScreenReaderRestoration(session, null);
          await result.pending;
        }),
      };
    }
    const state = session.cacheData.screenReader;
    if (!state) {
      return { pending: null };
    }
    const deviceId = session.assignedDevice;
    let targets = this.pendingScreenReaderRestores.get(deviceId);
    const existing = targets?.get(state);
    if (existing) {
      return existing.result;
    }
    if (!targets) {
      targets = new Map();
      this.pendingScreenReaderRestores.set(deviceId, targets);
    }
    const result = Promise.withResolvers<{ pending: Promise<void> | null }>();
    const target: PendingScreenReaderRestore = {
      state,
      removed: false,
      controller: new AbortController(),
      result: result.promise,
      clear: () => {
        if (session.cacheData.screenReader === state) {
          delete session.cacheData.screenReader;
        }
      },
    };
    // Publish the join point before starting any asynchronous restore work.
    targets.set(state, target);
    void this.startScreenReaderRestoration(deviceId, target).then(result.resolve, result.reject);
    return target.result;
  }

  private async startScreenReaderRestoration(
    deviceId: string,
    target: PendingScreenReaderRestore,
  ): Promise<{ pending: Promise<void> | null }> {
    const device: BootedDevice = { name: deviceId, deviceId, platform: target.state.platform };
    const restore = async () => {
      target.controller.signal.throwIfAborted();
      await this.screenReaderRestorerFactory(device).restore(
        target.state,
        target.controller.signal,
      );
      target.controller.signal.throwIfAborted();
      target.clear();
      const targets = this.pendingScreenReaderRestores.get(deviceId);
      if (targets?.get(target.state) === target) {
        targets.delete(target.state);
        if (targets.size === 0) {
          this.pendingScreenReaderRestores.delete(deviceId);
        }
      }
    };
    const restoration = restore().then(
      () => ({ outcome: "restored" as const }),
      (error: unknown) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Screen reader restoration timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.timer,
      timeoutMs: SCREEN_READER_RESTORE_TIMEOUT_MS,
      label: "Screen reader restoration",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return { outcome: "timed-out" as const };
      }
      throw toActionableError(error, "Screen reader restoration failed");
    });
    if (result.outcome === "restored") {
      return { pending: null };
    }
    logger.warn(
      `Screen reader restore ${result.outcome}; quarantining ${device.deviceId}`,
      result.outcome === "failed" ? result.error : timeout,
    );
    const pending = raceWithDeadline(
      this.retryScreenReaderRestore(device.deviceId, target, restoration, restore),
      {
        timer: this.timer,
        signal: target.controller.signal,
        label: "Pending screen reader restoration",
      },
    ).catch((error: unknown) => {
      if (!target.removed) {
        throw toActionableError(error, "Screen reader restoration failed");
      }
      // Proven removal retires ownership; no restoration may reach a replacement.
      logger.debug(`Retired screen reader restoration on removed device ${device.deviceId}`);
    });
    return { pending };
  }

  /**
   * Bounded retries with the injected `Backoff`. Each attempt is a full screen-reader
   * toggle, so after the cap the device is released from quarantine and the state it
   * still holds is remembered for one more attempt at its next natural point.
   */
  private async retryScreenReaderRestore(
    deviceId: string,
    target: PendingScreenReaderRestore,
    restoration: Promise<{ outcome: "restored" } | { outcome: "failed"; error: unknown }>,
    restore: () => Promise<void>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    logger.warn(`Failed to restore screen reader on ${deviceId}`, result.error);
    for (let attempt = 1; attempt <= SCREEN_READER_RESTORE_RETRY_ATTEMPTS; attempt++) {
      await this.timer.sleep(this.screenReaderRestoreBackoff.delayForAttempt(attempt));
      if (target.removed) {
        return;
      }
      try {
        await restore();
        return;
      } catch (error) {
        logger.warn(
          `Screen reader restore retry ${attempt}/${SCREEN_READER_RESTORE_RETRY_ATTEMPTS} failed on ${deviceId}`,
          error,
        );
      }
    }
    this.abandonScreenReaderRestore(deviceId, target);
  }

  private abandonScreenReaderRestore(deviceId: string, target: PendingScreenReaderRestore): void {
    if (target.removed) {
      return;
    }
    const { platform, previousEnabled } = target.state;
    logger.warn(
      `Gave up restoring the screen reader on ${deviceId} after ` +
        `${SCREEN_READER_RESTORE_RETRY_ATTEMPTS} retries; ${platform === "ios" ? "VoiceOver" : "TalkBack"} ` +
        `should be ${previousEnabled ? "enabled" : "disabled"} but was not confirmed. ` +
        `Will try once more at the next session start or release on this device.`,
    );
    this.abandonedScreenReaders.set(deviceId, target.state);
    target.clear();
    const targets = this.pendingScreenReaderRestores.get(deviceId);
    if (targets?.get(target.state) === target) {
      targets.delete(target.state);
      if (targets.size === 0) {
        this.pendingScreenReaderRestores.delete(deviceId);
      }
    }
  }

  /** The older, truer baseline wins, so it runs after the session's own restoration settles. */
  private async retryAbandonedScreenReaderAfter(
    deviceId: string,
    own: Promise<void> | null,
  ): Promise<void> {
    try {
      await own;
    } finally {
      await this.retryAbandonedScreenReaderRestore(deviceId);
    }
  }

  /** One bounded attempt at a state an earlier release gave up on; never on a timer. */
  private retryAbandonedScreenReaderRestore(deviceId: string): Promise<void> {
    const state = this.abandonedScreenReaders.get(deviceId);
    if (!state) {
      return Promise.resolve();
    }
    const inFlight = this.abandonedScreenReaderRetries.get(deviceId);
    if (inFlight) {
      return inFlight;
    }
    const controller = new AbortController();
    const device: BootedDevice = { name: deviceId, deviceId, platform: state.platform };
    const attempt = (async () => {
      try {
        await raceWithDeadline(
          this.screenReaderRestorerFactory(device).restore(state, controller.signal),
          {
            timer: this.timer,
            timeoutMs: SCREEN_READER_RESTORE_TIMEOUT_MS,
            label: "Screen reader restoration",
          },
        );
        if (this.abandonedScreenReaders.get(deviceId) === state) {
          this.abandonedScreenReaders.delete(deviceId);
        }
        logger.info(`Restored the screen reader on ${deviceId} on its next natural attempt`);
      } catch (error) {
        controller.abort();
        logger.warn(
          `Screen reader on ${deviceId} is still not restored to ${state.previousEnabled ? "enabled" : "disabled"}`,
          error,
        );
      }
    })().finally(() => {
      if (this.abandonedScreenReaderRetries.get(deviceId) === attempt) {
        this.abandonedScreenReaderRetries.delete(deviceId);
      }
    });
    this.abandonedScreenReaderRetries.set(deviceId, attempt);
    return attempt;
  }

  /** Removal retires in-memory ownership; no retries may target a replacement device. */
  retireScreenReaderRestoration(deviceId: string): void {
    const targets = this.pendingScreenReaderRestores.get(deviceId);
    this.screenReaderRemovalGenerations.set(
      deviceId,
      (this.screenReaderRemovalGenerations.get(deviceId) ?? 0) + 1,
    );
    for (const target of targets?.values() ?? []) {
      target.removed = true;
      target.controller.abort();
      target.clear();
    }
    this.pendingScreenReaderRestores.delete(deviceId);
    this.abandonedScreenReaders.delete(deviceId);
  }

  /**
   * Returned wrapped, never bare (see `getPendingBiometricRestoration`): sequence
   * the network restore after any still-draining setup so it never restores
   * `none` while a tracked mutation may still shape the device.
   */
  private async getPendingNetworkRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    if (pendingSetups && session.cacheData.networkCondition) {
      return { pending: this.restoreNetworkConditionAfterSetups(session, pendingSetups) };
    }
    return { pending: (await this.restoreNetworkConditionBestEffort(session)).pending };
  }

  /**
   * Snapshot of the network restore, taken before any await. Like the biometric
   * target, a rebind reassigns `session.assignedDevice` while a restore is in
   * flight, so the device is captured up front rather than read lazily.
   */
  private networkConditionRestoreTarget(session: Session): NetworkConditionRestoreTarget | null {
    const state = session.cacheData.networkCondition;
    // Keyed on the cache alone: the slot is only written by the Android emulator
    // network path or the iOS Simulator per-app path (`iosAppRule`), so its
    // presence is the authoritative evidence a device needs restoring —
    // independent of whatever platform the caller declared.
    if (!state) {
      return null;
    }
    const ios = state.iosAppRule;
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      incarnation: this.deviceHealth?.incarnation(session.assignedDevice),
      profile: state.initialProfile,
      // Each capture allocates a fresh reset revision, newer than every apply
      // this session sent, so a late apply cannot outlive the restore.
      ...(ios
        ? {
            iosAppRule: {
              udid: ios.udid,
              bundleId: ios.bundleId,
              owner: session.sessionId,
              ownerGeneration: ios.ownerGeneration,
              revision: ++ios.lastRevision,
            },
          }
        : {}),
    };
  }

  /** The injected iOS per-app rule restorer, else one over the installed controller. */
  private get iosAppNetworkRuleRestorer(): IosAppNetworkRuleRestorer {
    this.injectedIosAppNetworkRuleRestorer ??= defaultIosAppNetworkRuleRestorer();
    return this.injectedIosAppNetworkRuleRestorer;
  }

  /**
   * Owner generations must increase across daemon restarts, because the
   * provider keeps tombstones of released generations in memory. Seeding from
   * the host clock (milliseconds) and never repeating a value keeps a new
   * daemon's generations above an earlier daemon's.
   */
  private allocateIosOwnerGeneration(): number {
    this.lastIosOwnerGeneration = Math.max(
      this.lastIosOwnerGeneration + 1,
      Math.floor(this.sessionNow()),
    );
    return this.lastIosOwnerGeneration;
  }

  /**
   * Publish this session's iOS per-app rule slot before an `apply` (#10264), so
   * release, rebind and TTL expiry can remove it even if the apply is in flight.
   * One app per session: a different app must be reset first.
   */
  beginIosAppNetworkRule(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    const state = session.cacheData.networkCondition;
    const existing = state?.iosAppRule;
    if (existing && (existing.udid !== target.udid || existing.bundleId !== target.bundleId)) {
      throw new ActionableError(
        `Session ${session.sessionId} already holds an offline rule for ${existing.bundleId}; ` +
          `reset it with networkCondition { profile: "none", appId: "${existing.bundleId}" } first.`,
      );
    }
    const rule: IosAppNetworkRuleSessionState = existing ?? {
      udid: target.udid,
      bundleId: target.bundleId,
      ownerGeneration: this.allocateIosOwnerGeneration(),
      lastRevision: 0,
    };
    if (!existing) {
      session.cacheData.networkCondition = { initialProfile: "none", iosAppRule: rule };
    }
    return this.iosRuleContext(session, rule, ++rule.lastRevision);
  }

  /**
   * Ownership for an explicit `reset` of `target`. A session that holds no rule
   * for it still sends a reset (under a fresh generation it never stores): the
   * provider then answers `reset` when no rule exists, or refuses to clear
   * another session's rule.
   */
  prepareIosAppNetworkReset(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    const existing = session.cacheData.networkCondition?.iosAppRule;
    if (existing && existing.udid === target.udid && existing.bundleId === target.bundleId) {
      return this.iosRuleContext(session, existing, ++existing.lastRevision);
    }
    const transient: IosAppNetworkRuleSessionState = {
      udid: target.udid,
      bundleId: target.bundleId,
      ownerGeneration: this.allocateIosOwnerGeneration(),
      lastRevision: 1,
    };
    return this.iosRuleContext(session, transient, transient.lastRevision);
  }

  private iosRuleContext(
    session: Session,
    state: IosAppNetworkRuleSessionState,
    revision: number,
  ): IosAppNetworkRuleCommandContext {
    return {
      rule: {
        udid: state.udid,
        bundleId: state.bundleId,
        owner: session.sessionId,
        ownerGeneration: state.ownerGeneration,
        revision,
      },
      nextRevision: () => ++state.lastRevision,
    };
  }

  /**
   * The provider acknowledged `rule` as installed: record it and renew its lease
   * while this exact session still owns this exact revision.
   */
  confirmIosAppNetworkRule(session: Session, rule: IosAppNetworkRule): void {
    const state = session.cacheData.networkCondition?.iosAppRule;
    if (
      this.sessions.get(session.sessionId) !== session ||
      !state ||
      state.ownerGeneration !== rule.ownerGeneration
    ) {
      return;
    }
    state.installedRevision = rule.revision;
    this.iosAppNetworkLeases.start(session.sessionId, rule, () => {
      const current = session.cacheData.networkCondition?.iosAppRule;
      return (
        this.isAdmittedForAutomation(session) &&
        current === state &&
        current.installedRevision === rule.revision
      );
    });
  }

  /**
   * The session reset its rule (or the provider said it no longer holds one):
   * stop renewing and drop the slot, so release does not reset it again.
   */
  finishIosAppNetworkReset(session: Session, rule: IosAppNetworkRule): void {
    if (this.sessions.get(session.sessionId) !== session) {
      return;
    }
    const state = session.cacheData.networkCondition?.iosAppRule;
    if (!state || state.ownerGeneration !== rule.ownerGeneration) {
      return;
    }
    this.iosAppNetworkLeases.stop(session.sessionId);
    delete session.cacheData.networkCondition;
  }

  /** The iOS rule whose lease this session is renewing, if any (diagnostics and tests). */
  activeIosAppNetworkLease(sessionId: string): IosAppNetworkRule | undefined {
    return this.iosAppNetworkLeases.active(sessionId);
  }

  private async restoreNetworkCondition(target: NetworkConditionRestoreTarget): Promise<void> {
    if (target.iosAppRule) {
      if (!this.restoreIncarnationIsCurrent(target)) {
        return;
      }
      await this.iosAppNetworkRuleRestorer.reset(target.iosAppRule);
      this.clearRestoreHealth(target, "network-condition");
      return;
    }
    const device: BootedDevice = {
      name: target.deviceId,
      platform: "android",
      deviceId: target.deviceId,
    };
    if (!this.restoreIncarnationIsCurrent(target)) {
      return;
    }
    await this.networkConditionRestorerFactory(device).restore(target.profile);
    this.clearRestoreHealth(target, "network-condition");
  }

  /**
   * Best-effort network-condition restore, bounded by a timeout so a wedged
   * emulator console cannot stall release. A timeout hands the still-running
   * restore back as pending cleanup, keeping the device quarantined until it
   * settles (issue #6012).
   */
  private async restoreNetworkConditionBestEffort(
    session: Session,
  ): Promise<{ pending: Promise<void> | null }> {
    const target = this.networkConditionRestoreTarget(session);
    if (!target) {
      return { pending: null };
    }
    const restoration = this.restoreNetworkCondition(target).then(
      () => ({ outcome: "restored" as const }),
      (error) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Network condition restore timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.timer,
      timeoutMs: NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
      label: "Network condition restore",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return { outcome: "timed-out" as const };
      }
      throw error;
    });
    if (result.outcome === "failed") {
      logger.warn(
        `Failed to restore network condition for session ${session.sessionId}; device ` +
          `${target.deviceId} may hold session-modified shaping: ${result.error}`,
      );
      // Quarantine the device until the retries below settle; a prompt
      // rejection otherwise returns a shaped emulator straight to the pool.
      return { pending: this.retryNetworkConditionRestore(target, result.error) };
    }
    if (result.outcome === "timed-out") {
      logger.warn(
        `Timed out after ${NETWORK_CONDITION_RESTORE_TIMEOUT_MS}ms restoring network condition ` +
          `for session ${session.sessionId}`,
      );
      return { pending: this.settleNetworkConditionRestore(target, restoration) };
    }
    return { pending: null };
  }

  /** A slow restore can still fail; retry before the device leaves quarantine. */
  private async settleNetworkConditionRestore(
    target: NetworkConditionRestoreTarget,
    restoration: Promise<{ outcome: "restored" } | { outcome: "failed"; error: unknown }>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    logger.warn(
      `Failed to restore network condition for session ${target.sessionId}: ${result.error}`,
    );
    await this.retryNetworkConditionRestore(target, result.error);
  }

  private async retryNetworkConditionRestore(
    target: NetworkConditionRestoreTarget,
    initialError: unknown,
  ): Promise<void> {
    await this.retryNetworkConditionRestoreUntilSuccess(target, initialError);
  }

  /**
   * Bounded restore retries after an initial failure. Returns `true` if any retry
   * succeeded, `false` once the attempts are exhausted. The boolean lets the TTL
   * path decide whether it may release restoration ownership (clear the slot),
   * while the release path (which discards the session anyway) ignores it.
   */
  private async retryNetworkConditionRestoreUntilSuccess(
    target: NetworkConditionRestoreTarget,
    initialError: unknown,
  ): Promise<boolean> {
    let lastError = initialError;
    for (let attempt = 1; attempt <= NETWORK_CONDITION_RESTORE_RETRY_ATTEMPTS; attempt++) {
      await this.timer.sleep(NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS);
      if (!this.restoreIncarnationIsCurrent(target)) {
        return false;
      }
      try {
        await this.restoreNetworkCondition(target);
        logger.info(
          `Restored network condition for session ${target.sessionId} on retry ${attempt}`,
        );
        return true;
      } catch (error) {
        // Teardown is best-effort: keep retrying, then report the last failure.
        lastError = error;
        logger.debug(
          `Retry ${attempt} restoring network condition for session ${target.sessionId} failed: ${error}`,
        );
      }
    }
    logger.warn(
      `Gave up restoring network condition for session ${target.sessionId} after ` +
        `${NETWORK_CONDITION_RESTORE_RETRY_ATTEMPTS} retries; device ${target.deviceId} ` +
        `may hold session-modified shaping: ${lastError}`,
    );
    this.abandonRestore(target, "network-condition", () => this.restoreNetworkCondition(target));
    return false;
  }

  /**
   * Arm a standalone per-condition network TTL (issue #6085 item 2): when it
   * elapses, the device is reset to `none` independent of session lifetime.
   * Re-scheduling (a re-applied condition) cancels the prior timer first, so only
   * the latest TTL is armed. A non-positive TTL arms nothing (and still clears any
   * prior timer), matching the "TTL-only / neutral request applies nothing" rule.
   *
   * Keyed by session id but IDENTITY-GUARDED by the captured `Session` instance
   * (issue #6085 review): the caller passes the exact session it just mutated, and
   * the timer fires against that instance only — so a stale schedule from a
   * timed-out setup cannot arm or fire a TTL against a same-UUID REPLACEMENT
   * session. The TTL is clamped to `MAX_NETWORK_CONDITION_TTL_SECONDS` so the
   * millisecond product cannot overflow `setTimeout`'s signed 32-bit delay (item 4).
   *
   * `generation` MUST be the value the caller's own `bumpNetworkConditionGeneration`
   * call returned for the mutation this TTL belongs to (issue #6181 review) — NOT
   * re-read from the session's current generation here. Two mutations (B, C) can
   * bump the shared counter before either reaches this call (B under `await
   * trackSessionSetup`, C right behind it), so reading "current" at schedule time
   * can tag B's timer with C's generation. Comparing against a per-call, per-mutation
   * value closes that window: a timer only ever matches the generation it actually
   * belongs to. Callers that don't track their own generation (tests, and any
   * caller predating this parameter) may omit it, falling back to the session's
   * current generation at schedule time — safe as long as no concurrent mutation is
   * in flight for that call.
   */
  scheduleNetworkConditionExpiry(
    session: Session,
    expiresInSeconds: number,
    generation?: number,
  ): void {
    const sessionId = session.sessionId;
    this.cancelNetworkConditionExpiry(sessionId);
    if (!(expiresInSeconds > 0)) {
      return;
    }
    // A stale schedule (e.g. a setup that finished after this session was released
    // and replaced) must not arm a timer against the replacement — bail unless the
    // captured instance is still the live session.
    if (this.sessions.get(sessionId) !== session) {
      return;
    }
    const effectiveSeconds = Math.min(expiresInSeconds, MAX_NETWORK_CONDITION_TTL_SECONDS);
    if (effectiveSeconds < expiresInSeconds) {
      logger.warn(
        `networkCondition TTL of ${expiresInSeconds}s exceeds the ${MAX_NETWORK_CONDITION_TTL_SECONDS}s ` +
          `setTimeout limit for session ${sessionId}; clamping to ${effectiveSeconds}s`,
      );
    }
    // Capture the OWNING mutation's generation into the closure (issue #6177,
    // hardened #6181): if a newer condition supersedes it before this timer's
    // awaited restore settles, the generation check in restoreNetworkConditionOnExpiry
    // detects the mismatch and skips clearing the newer condition's restore slot.
    const effectiveGeneration = generation ?? this.currentNetworkConditionGeneration(sessionId);
    this.armNetworkConditionExpiryAt(
      session,
      this.sessionNow() + effectiveSeconds * 1000,
      effectiveGeneration,
    );
  }

  /**
   * Arm the timer for an absolute deadline and a fixed generation, shared by
   * {@link scheduleNetworkConditionExpiry} (a fresh TTL) and
   * {@link rearmNetworkConditionExpiry} (restoring a snapshot taken by
   * {@link peekNetworkConditionExpiry}). Identity-guarded like its callers: a
   * session that was replaced under the same id since the deadline was captured
   * is not armed against.
   */
  private armNetworkConditionExpiryAt(
    session: Session,
    deadlineMs: number,
    generation: number,
  ): void {
    const sessionId = session.sessionId;
    if (this.sessions.get(sessionId) !== session) {
      return;
    }
    const remainingMs = Math.max(0, deadlineMs - this.sessionNow());
    const handle = this.timer.setTimeout(() => {
      this.handleNetworkConditionExpiry(session, generation);
    }, remainingMs);
    this.networkConditionExpiryTimers.set(sessionId, { handle, session, deadlineMs, generation });
  }

  /**
   * Snapshot a pending network-condition TTL without disturbing it (issue
   * #6178 item 1). `runSessionNetworkMutation` calls this before cancelling the
   * timer to run its own mutation race-free (issue #6085 review), then re-arms
   * the snapshot via {@link rearmNetworkConditionExpiry} if that mutation does
   * not confirm success — so a manual reset whose emulator command fails does
   * not permanently drop the deadline a prior timed degrade promised.
   */
  peekNetworkConditionExpiry(
    sessionId: string,
  ): { deadlineMs: number; generation: number } | undefined {
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    return entry ? { deadlineMs: entry.deadlineMs, generation: entry.generation } : undefined;
  }

  /**
   * Re-arm a TTL previously captured via {@link peekNetworkConditionExpiry},
   * preserving its original deadline and generation exactly (issue #6178 item
   * 1). A deadline already in the past fires on the next tick rather than
   * being dropped, matching a TTL that elapsed while the failed mutation ran.
   *
   * Generation-guarded (issue #6178 PR #6183 review, P1): the caller's own
   * mutation attempt already bumped the counter to `snapshot.generation`
   * before it ran, so an UNCHANGED current generation means nothing else has
   * mutated since. But three overlapping requests on one session (A's timed
   * degrade, B's slow failing re-apply, C's later successful re-apply) can
   * settle out of order — B's failure must not blindly re-arm A's deadline
   * once C has already bumped the counter again and established its own
   * state (its own fresh TTL, live in the timer map, or a deliberate "no
   * TTL"). Skipping whenever the generation has moved on avoids both
   * resurrecting a deadline C already retired AND clobbering C's live timer
   * handle without cancelling it.
   *
   * Also refuses to re-arm a releasing/released session (issue #6178 PR #6183
   * review, P2): `releaseSessionInternal` cancels any pending TTL BEFORE
   * awaiting the tracked mutation that may still be in flight. If that
   * mutation then throws (or otherwise triggers a re-arm) while release is
   * still draining, blindly re-arming here would undo release's cancellation
   * — either running a stale timer concurrently with release's own
   * restoration, or pinning a released session's timer-map entry for up to
   * `MAX_NETWORK_CONDITION_TTL_SECONDS` (~24.8 days). Release's cancellation
   * must be the last word, so a releasing/no-longer-current session is never
   * re-armed.
   */
  rearmNetworkConditionExpiry(
    session: Session,
    snapshot: { deadlineMs: number; generation: number },
  ): void {
    const sessionId = session.sessionId;
    if (this.currentNetworkConditionGeneration(sessionId) !== snapshot.generation) {
      logger.debug(
        `Skipping network-condition TTL re-arm for session ${sessionId}: generation ` +
          `${snapshot.generation} has been superseded by a later mutation`,
      );
      return;
    }
    if (!this.isAdmittedForAutomation(session)) {
      logger.debug(
        `Skipping network-condition TTL re-arm for session ${sessionId}: session is releasing ` +
          `or no longer live`,
      );
      return;
    }
    this.armNetworkConditionExpiryAt(session, snapshot.deadlineMs, snapshot.generation);
  }

  /**
   * Cancel a pending network TTL. Called on release, rebind, and any subsequent
   * network mutation (a manual reset, or a re-apply BEFORE it re-arms) so the
   * release-restore and the TTL can never both fire. A no-op when no timer is armed.
   */
  cancelNetworkConditionExpiry(sessionId: string): void {
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    if (entry !== undefined) {
      this.timer.clearTimeout(entry.handle);
      this.networkConditionExpiryTimers.delete(sessionId);
    }
  }

  /**
   * TTL elapsed: reset the device to `none` via the SAME bounded restore/retry the
   * session-release path uses, and RETAIN restoration ownership — keep the restore
   * slot and the device quarantined — until the reset actually SUCCEEDS (issue
   * #6085 review). A transient emulator-console rejection therefore does not end
   * quarantine and hand a still-shaped device back to the pool: it retries, and if
   * every attempt is exhausted the slot is left in place so a later release still
   * retries. Only on success is the slot cleared, so a subsequent release cannot
   * double-restore.
   *
   * Identity-guarded on the captured `Session`: a fire against a same-UUID
   * REPLACEMENT session (or an already-released one) is a no-op, so it never acts
   * on a freed or replaced device.
   */
  private handleNetworkConditionExpiry(session: Session, expectedGeneration: number): void {
    const sessionId = session.sessionId;
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    if (entry && entry.session === session) {
      this.networkConditionExpiryTimers.delete(sessionId);
    }
    // Read the raw session map rather than getSession(), so a timer fire cannot
    // trigger a lazy-expiry release as a side effect. A missing or replaced
    // session was already released — its release-restore handled connectivity.
    if (this.sessions.get(sessionId) !== session) {
      return;
    }
    const target = this.networkConditionRestoreTarget(session);
    if (!target) {
      // Slot already cleared by a prior restore: nothing to do, no double-restore.
      return;
    }
    logger.info(
      `Network condition TTL elapsed for session ${sessionId}; resetting device ${target.deviceId} to none`,
    );
    this.trackPendingDeviceCleanup(target.deviceId, [
      this.runUnderTeardownShield(async () => [
        {
          pending: this.restoreNetworkConditionOnExpiry(session, target, expectedGeneration),
          abandon: () => this.abandonCappedRestore(target, "network-condition"),
        },
      ]).then(async (cleanups) => {
        await Promise.all(cleanups);
      }),
    ]);
  }

  /**
   * Reset the device on TTL expiry, then bounded-retry on failure — the same
   * machinery `restoreNetworkConditionBestEffort` uses on release. The restore slot
   * is cleared only after a definitive success, so ownership (and quarantine) is
   * retained until the device is actually clean.
   */
  private async restoreNetworkConditionOnExpiry(
    session: Session,
    target: NetworkConditionRestoreTarget,
    expectedGeneration: number,
  ): Promise<void> {
    try {
      await this.restoreNetworkCondition(target);
      this.clearNetworkConditionIfOwned(session, expectedGeneration);
      return;
    } catch (error) {
      logger.warn(
        `Failed to reset network condition on TTL expiry for session ${session.sessionId}; ` +
          `device ${target.deviceId} may hold session-modified shaping, retrying: ${error}`,
      );
      const succeeded = await this.retryNetworkConditionRestoreUntilSuccess(target, error);
      if (succeeded) {
        this.clearNetworkConditionIfOwned(session, expectedGeneration);
      }
      // On exhaustion the slot is intentionally retained so a later release retries.
    }
  }

  /**
   * Drop the network restore slot once a reset has satisfied it (issue #6085),
   * but ONLY while the captured session is still the live one — a same-UUID
   * replacement must keep its own freshly-published slot — AND only while the
   * session's network-condition generation still matches the one this expiry was
   * scheduled against (issue #6177). A stale expiry (condition A) that settles
   * after a newer condition (B) has been applied must not delete B's restore
   * slot: the generation mismatch is the signal that A has been superseded.
   */
  private clearNetworkConditionIfOwned(session: Session, expectedGeneration: number): void {
    if (this.sessions.get(session.sessionId) !== session) {
      return;
    }
    if (this.currentNetworkConditionGeneration(session.sessionId) !== expectedGeneration) {
      logger.debug(
        `Network condition TTL expiry for session ${session.sessionId} settled after a newer ` +
          `condition superseded it; leaving that condition's restore slot in place`,
      );
      return;
    }
    if (session.cacheData.networkCondition) {
      delete session.cacheData.networkCondition;
      this.iosAppNetworkLeases.stop(session.sessionId);
    }
  }

  private trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<unknown>[]): void {
    const work = this.pendingDeviceCleanupWork.get(deviceId) ?? new Set<Promise<unknown>>();
    this.pendingDeviceCleanupWork.set(deviceId, work);
    for (const promise of cleanups) {
      work.add(promise);
      const remove = () => {
        work.delete(promise);
        if (work.size === 0 && this.pendingDeviceCleanupWork.get(deviceId) === work) {
          this.pendingDeviceCleanupWork.delete(deviceId);
        }
      };
      void promise.then(remove, remove);
    }
    const previous = this.pendingDeviceCleanups.get(deviceId);
    const cleanup = Promise.allSettled(previous ? [previous, ...cleanups] : cleanups).then(
      () => undefined,
    );
    this.pendingDeviceCleanups.set(deviceId, cleanup);
    void cleanup.then(() => {
      if (this.pendingDeviceCleanups.get(deviceId) === cleanup) {
        this.pendingDeviceCleanups.delete(deviceId);
        this.pendingDeviceCleanupSettlesBy.delete(deviceId);
      }
    });
  }

  private notifySessionDeviceUnbound(sessionId: string, deviceId: string): void {
    for (const callback of this.deviceUnboundCallbacks) {
      try {
        callback(sessionId, deviceId);
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

  /**
   * Update session cache data
   *
   * Allows tools to store data (screenshots, hierarchies) that can be
   * reused by other tools in the same session without re-fetching.
   *
   * Cache data only: this never touches the session's activity or liveness clocks (#10703). It is
   * reached from paths that are not the owner's tool usage — a device incarnation change
   * resetting readiness, or an observe by device id from any client invalidating it — so stamping
   * `lastUsedAt` here would let them extend the owner's idle window and make `session-info`'s
   * `lastUsedAt` stop meaning "last tool call". A tool call's activity is stamped where the call is
   * admitted (`getOrCreateSession`) and where it ends (`recordToolCallEnded`).
   */
  updateSessionCache(sessionId: string, updates: Partial<SessionCacheData>): void {
    const session = this.getSession(sessionId);
    if (!session) {
      logger.warn(`Cannot update cache for session ${sessionId}: not found`);
      return;
    }

    session.cacheData = {
      ...session.cacheData,
      ...updates,
    };
    logger.debug(`Updated cache for session ${sessionId}`);
  }

  /**
   * Cache the most recent observed view hierarchy for a session.
   *
   * Writes the typed top-level `lastHierarchy` slot (the canonical source of
   * truth per issue #2917) and stamps `lastObserveTime`. Consumers such as the
   * hierarchy-diff baseline (#2761) read the typed slot directly rather than
   * fishing a differently-typed value out of `customData`.
   */
  setLastHierarchy(sessionId: string, hierarchy: ViewHierarchyResult): void {
    this.updateSessionCache(sessionId, {
      lastHierarchy: hierarchy,
      lastObserveTime: this.sessionNow(),
    });
  }

  /**
   * Cache the most recent observation emitted to the agent (the sanitized
   * `ObserveResult`) as the diff baseline for `--actions-diff-observe` (#2761).
   *
   * This is the "last observation output to the agent": `observe` resets it to
   * the full sanitized observation, and each non-observe action updates it to
   * its own post-action observation so the *next* action diffs against current
   * state. Stored in a typed top-level slot (canonical per #2917) rather than
   * the untyped `customData` bag. Distinct from `lastHierarchy`, which keeps the
   * full untrimmed hierarchy for internal reuse; this holds the wire-shaped
   * observation so diffs compare like-for-like.
   */
  setLastRenderedObservation(
    sessionId: string,
    observation: ObserveResult,
    displayRevision?: number,
  ): void {
    this.updateSessionCache(sessionId, {
      lastRenderedObservation: observation,
      lastRenderedDisplayGeneration: observation.display?.generation,
      lastRenderedDisplayKey: observation.display?.key,
      ...(displayRevision === undefined ? {} : { lastRenderedDisplayRevision: displayRevision }),
    });
  }

  /** Session cache owns this output-only state, so release/rebind clears it with the session. */
  getLastActionMetadata(
    sessionId: string,
    deviceId: string,
  ): Readonly<Record<string, unknown>> | undefined {
    const record = this.getSession(sessionId)?.cacheData.lastActionMetadata;
    return record?.deviceId === deviceId ? record.blocks : undefined;
  }

  setLastActionMetadata(
    sessionId: string,
    deviceId: string,
    blocks: Record<string, unknown>,
  ): void {
    this.updateSessionCache(sessionId, { lastActionMetadata: { deviceId, blocks } });
  }

  /**
   * Read the diff baseline (`lastRenderedObservation`) without recording session
   * activity (issue #3053). The `--actions-diff-observe` baseline store reads the
   * baseline on every non-observe action; routing that read through
   * `getSessionCache` would fire a second `recordActivity` UPDATE on top of the
   * `set` that follows (get + set = two fire-and-forget writes per diffed action).
   * This reader goes straight through `getSession`, which does not record activity
   * (its only mutation is lazy expiry — the same GC any session lookup triggers),
   * so a diffed action records activity once — from the baseline `set` — not twice.
   * Returns `undefined` for an unknown/expired session or when no observation has
   * been rendered yet.
   */
  getLastRenderedObservation(sessionId: string): ObserveResult | undefined {
    return this.getSession(sessionId)?.cacheData.lastRenderedObservation;
  }

  /** Keep the caller's revision even when a fold clears the hierarchy and diff baseline. */
  setLastRenderedDisplayRevision(
    sessionId: string,
    revision: number,
    key?: string,
    generation?: number,
  ): void {
    this.updateSessionCache(sessionId, {
      lastRenderedDisplayRevision: revision,
      lastRenderedDisplayGeneration: generation,
      ...(key === undefined ? {} : { lastRenderedDisplayKey: key }),
    });
  }

  getLastRenderedDisplayGeneration(sessionId: string): number | undefined {
    return this.getSession(sessionId)?.cacheData.lastRenderedDisplayGeneration;
  }

  setDisplayPin(sessionId: string, pin: string | null): void {
    this.updateSessionCache(sessionId, { displayPin: pin ?? undefined });
    if (pin === null) {
      const session = this.getSession(sessionId);
      if (session) {
        delete session.cacheData.displayPin;
      }
    }
  }

  getDisplayPin(sessionId: string): string | undefined {
    return this.getSession(sessionId)?.cacheData.displayPin;
  }

  getLastRenderedDisplayKey(sessionId: string): string | undefined {
    return this.getSession(sessionId)?.cacheData.lastRenderedDisplayKey;
  }

  getLastRenderedDisplayRevision(sessionId: string): number | undefined {
    return this.getSession(sessionId)?.cacheData.lastRenderedDisplayRevision;
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

  /**
   * Read the keep-awake state without recording session activity (mirrors
   * `getLastRenderedObservation`, issue #3053): this is a best-effort setup/restore
   * read, not a tool interaction, so it must not fire a session-activity write.
   * Returns `undefined` for an unknown/expired session or before setup ran.
   */
  getKeepScreenAwake(sessionId: string): KeepScreenAwakeState | undefined {
    return this.getSession(sessionId)?.cacheData.keepScreenAwake;
  }

  /**
   * Record the highest {@link DeviceReadinessLevel} actually achieved for a
   * session (#6227). Mirrors `setKeepScreenAwake`'s typed-slot pattern so a
   * later call reusing the same session UUID can detect an upgrade is needed
   * (e.g. a prior `booted`-only call left CtrlProxy setup unprepared) rather
   * than trusting `existingSession` alone.
   *
   * MONOTONIC by achieved level (#6227 round 7): only ever RAISES the
   * recorded level, never lowers it. `bindOrReuseDeviceSession` can hand back
   * a live session already bound to the exact requested device — a session
   * that previously reached `automationReady` through one acquisition path.
   * A later, less-demanding acquisition on that same session (e.g.
   * `provisionDevice({ readiness: "none" })`, or the `booted`-only branch of
   * `ensureReadinessUpgraded`) would otherwise overwrite that recorded level
   * with `"booted"`, silently downgrading it — a later `automationReady` tool
   * would then trust the stale `booted` record and skip CtrlProxy/
   * accessibility-service setup the device still needs, or an unnecessary
   * redundant setup would run. Comparing against the currently recorded level
   * and only writing when the new one is higher (or none has been recorded
   * yet) closes that hole. A genuine loss of automation readiness uses
   * `invalidateAutomationReadiness` instead of repurposing this recorder.
   */
  setDeviceReadiness(sessionId: string, level: DeviceReadinessLevel): void {
    const current = this.getDeviceReadiness(sessionId);
    if (current !== undefined && deviceReadinessRank(current) >= deviceReadinessRank(level)) {
      return;
    }
    this.updateSessionCache(sessionId, { deviceReadiness: level });
  }

  /**
   * Read the achieved readiness level without recording session activity
   * (mirrors `getKeepScreenAwake`). Returns `undefined` for an unknown/expired
   * session or before any setup has recorded a level.
   */
  getDeviceReadiness(sessionId: string): DeviceReadinessLevel | undefined {
    return this.getSession(sessionId)?.cacheData.deviceReadiness;
  }

  /** Drop stale automation readiness after its service becomes unavailable. */
  invalidateAutomationReadiness(sessionId: string, reason: string): void {
    if (!this.getSession(sessionId)) {
      logger.debug(`[SessionManager] Cannot invalidate readiness for unknown session ${sessionId}`);
      return;
    }
    logger.warn(`[SessionManager] Invalidating automation readiness for ${sessionId}: ${reason}`);
    this.updateSessionCache(sessionId, { deviceReadiness: "booted" });
  }

  /** Invalidate the session currently owning a device after an embedded hierarchy read fails. */
  invalidateAutomationReadinessForDevice(deviceId: string, reason: string): void {
    const sessionId = this.getSessionForDevice(deviceId);
    if (sessionId) {
      this.invalidateAutomationReadiness(sessionId, reason);
    }
  }

  /**
   * Drop a restored guest's automation proof without using the monotonic setter.
   * The next device-aware request must rerun runner/accessibility readiness.
   */
  resetDeviceReadinessForDevice(deviceId: string): void {
    const sessionId = this.getSessionForDevice(deviceId);
    if (!sessionId) {
      return;
    }
    this.updateSessionCache(sessionId, { deviceReadiness: "booted" });
  }

  /** Tracked setup retains this exact session even after a bounded release times out. */
  trackClockSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    const deviceId = session.assignedDevice;
    const generation = this.clockRemovalGenerations.get(deviceId) ?? 0;
    return this.trackSessionSetup(session, async () => {
      try {
        await createSetup();
      } finally {
        if ((this.clockRemovalGenerations.get(deviceId) ?? 0) !== generation) {
          delete session.cacheData.clock;
        } else if (this.sessions.get(session.sessionId) !== session && session.cacheData.clock) {
          // Baseline capture can finish after bounded release. Hand unbounded
          // retries to device quarantine so the setup/tool request can settle.
          const restoration = await this.getPendingClockRestoration(session, null);
          if (restoration.pending) {
            this.trackPendingDeviceCleanup(deviceId, [restoration.pending]);
          }
        }
      }
    });
  }

  setClock(session: Session, state: ClockSessionState): void {
    session.cacheData.clock ??= state;
  }
  getClock(sessionId: string): ClockSessionState | undefined {
    return this.getSession(sessionId)?.cacheData.clock;
  }
  runClockMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.runDeviceStateMutationExclusive(this.clockMutationQueues, sessionId, fn);
  }

  trackRotationSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    const deviceId = session.assignedDevice;
    const generation = this.rotationRemovalGenerations.get(deviceId) ?? 0;
    return this.trackSessionSetup(session, async () => {
      try {
        await createSetup(() => {
          if ((this.rotationRemovalGenerations.get(deviceId) ?? 0) !== generation) {
            throw new ActionableError(
              "Cannot change rotation: device was removed during session setup.",
            );
          }
        });
      } finally {
        if ((this.rotationRemovalGenerations.get(deviceId) ?? 0) !== generation) {
          delete session.cacheData.rotation;
        } else if (this.sessions.get(session.sessionId) !== session && session.cacheData.rotation) {
          // Rotate still holds the device mutex here. Publish quarantine before
          // setup settles, then let restoration acquire that mutex after return.
          const restoration = this.getPendingRotationRestoration(session, null).then(
            async ({ pending }) => {
              await pending;
            },
          );
          this.trackPendingDeviceCleanup(deviceId, [restoration]);
        }
      }
    });
  }

  setRotation(session: Session, state: RotationSessionState): void {
    session.cacheData.rotation ??= state;
  }
  getRotation(sessionId: string): RotationSessionState | undefined {
    return this.getSession(sessionId)?.cacheData.rotation;
  }
  runRotationMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.runDeviceStateMutationExclusive(this.rotationMutationQueues, sessionId, fn);
  }

  /** Tracked setup retains this exact session even after a bounded release times out (#10146). */
  trackScreenReaderSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    const deviceId = session.assignedDevice;
    const generation = this.screenReaderRemovalGenerations.get(deviceId) ?? 0;
    return this.trackSessionSetup(session, async () => {
      try {
        await createSetup(() => {
          if ((this.screenReaderRemovalGenerations.get(deviceId) ?? 0) !== generation) {
            throw new ActionableError(
              "Cannot change the screen reader: device was removed during session setup.",
            );
          }
        });
      } finally {
        if ((this.screenReaderRemovalGenerations.get(deviceId) ?? 0) !== generation) {
          delete session.cacheData.screenReader;
        } else if (
          this.sessions.get(session.sessionId) !== session &&
          session.cacheData.screenReader
        ) {
          // The toggle can finish after a bounded release gave up on this session.
          // Hand the restore to device quarantine so the tool request can settle.
          const restoration = this.getPendingScreenReaderRestoration(session, null).then(
            async ({ pending }) => {
              await pending;
            },
          );
          this.trackPendingDeviceCleanup(deviceId, [restoration]);
        }
      }
    });
  }

  /** Write-once: the first toggle's pre-change state is the one release restores. */
  setScreenReader(session: Session, state: ScreenReaderSessionState): void {
    session.cacheData.screenReader ??= state;
  }
  getScreenReader(sessionId: string): ScreenReaderSessionState | undefined {
    return this.getSession(sessionId)?.cacheData.screenReader;
  }
  runScreenReaderMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.runDeviceStateMutationExclusive(this.screenReaderMutationQueues, sessionId, fn);
  }

  /**
   * Preserve the pre-session iOS Simulator enrollment state. This setter is
   * intentionally write-once per session: every later enrollment change must
   * restore the same state the session first observed.
   */
  setBiometricEnrollment(sessionId: string, state: BiometricEnrollmentSessionState): void {
    if (this.getBiometricEnrollment(sessionId)) {
      return;
    }
    this.updateSessionCache(sessionId, { biometricEnrollment: state });
  }

  /** Read the original enrollment state without recording session activity. */
  getBiometricEnrollment(sessionId: string): BiometricEnrollmentSessionState | undefined {
    return this.getSession(sessionId)?.cacheData.biometricEnrollment;
  }

  /**
   * Record that a session degraded the device-wide network condition (issue
   * #6012), preserving the pre-session baseline to restore on release. Write-once
   * per session: the first degrade wins, so release always restores the same
   * baseline the session first observed.
   */
  setNetworkCondition(sessionId: string, state: NetworkConditionSessionState): void {
    if (this.getNetworkCondition(sessionId)) {
      return;
    }
    this.updateSessionCache(sessionId, { networkCondition: state });
  }

  /**
   * Bump the per-session network-condition generation (issue #6177). Called on
   * every apply/reset mutation, BEFORE the mutation runs, so a TTL scheduled for
   * the condition being replaced can never observe the generation it captures as
   * still current. Returns the new generation for the caller to arm a TTL with.
   */
  bumpNetworkConditionGeneration(sessionId: string): number {
    const next = (this.networkConditionGeneration.get(sessionId) ?? 0) + 1;
    this.networkConditionGeneration.set(sessionId, next);
    return next;
  }

  /**
   * Run `fn` as the next link in a per-session promise-chain mutex, so that
   * `runSessionNetworkMutation`'s ENTIRE critical section — generation bump,
   * TTL snapshot/cancel, the mutation itself, and its TTL re-arm/schedule
   * decision — never overlaps another same-session networkCondition mutation
   * (issue #6178 PR #6183 review). This is the structural fix for a family of
   * races the generation guard alone could not close: a later generation only
   * proves a mutation was ATTEMPTED, not that it succeeded, so two overlapping
   * FAILURES could each observe nothing to restore while a displaced TTL is
   * lost between them. With this lock, a later mutation's snapshot always sees
   * the FULLY SETTLED state (including any prior mutation's own re-arm) of the
   * one before it — the whole interleaving family becomes impossible, not just
   * the specific cases already patched.
   *
   * Scoped narrowly and reentrancy-safe by construction: keyed per session id
   * (never blocks a different session's mutations, or unrelated session work
   * like release/rebind — those act on the timer/session maps directly), and
   * `fn` is the caller's entire body, so nothing outside this one critical
   * section is ever held across an await. `.catch(() => undefined)` on the
   * chain tail ensures one mutation's rejection cannot wedge the queue for the
   * next; the `finally` drops the map entry once nothing is queued behind it,
   * so a dead session leaves no residue.
   */
  runNetworkConditionMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.runDeviceStateMutationExclusive(this.networkConditionMutationQueues, sessionId, fn);
  }

  private runDeviceStateMutationExclusive<T>(
    queues: Map<string, Promise<unknown>>,
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    queues.set(sessionId, next);
    return next.finally(() => {
      if (queues.get(sessionId) === next) {
        queues.delete(sessionId);
      }
    });
  }

  private currentNetworkConditionGeneration(sessionId: string): number {
    return this.networkConditionGeneration.get(sessionId) ?? 0;
  }

  /** Read the original network condition without recording session activity. */
  getNetworkCondition(sessionId: string): NetworkConditionSessionState | undefined {
    return this.getSession(sessionId)?.cacheData.networkCondition;
  }

  /**
   * Cache the device-label → session map for a multi-device session in the typed
   * top-level `deviceLabels` slot (issue #2973). Written by `registerDeviceLabelMap`
   * and read on the `device:`-label routing hot path (`resolveDeviceLabelSession`).
   */
  setDeviceLabels(sessionId: string, labels: DeviceLabelMap): void {
    if (this.getSession(sessionId)) {
      const derived = Object.values(labels).filter((labelSession) => labelSession !== sessionId);
      if (derived.length > 0) {
        const indexed = this.derivedLabelSessionsByBase.get(sessionId) ?? [];
        this.derivedLabelSessionsByBase.set(sessionId, new Set([...indexed, ...derived]));
      }
    }
    this.updateSessionCache(sessionId, { deviceLabels: labels });
  }

  /**
   * A plan run is about to allocate the derived `${base}:${label}` sessions in `labels` (#11572).
   * A derived label session lives only as long as its plan run, so however the previous run's
   * session ended (device lost or killed, daemon shutdown, the plan's own release), this run's
   * allocation may mint the name again: {@link createSession} lifts the fence the previous run
   * left and writes over its row. Nothing else may. A call that merely names the label session
   * while it is not live (a late call of the old run, a stray client) is still refused as terminal
   * by {@link getOrCreateSession}. The caller invokes the returned function when its allocation
   * settles.
   */
  openPlanLabelMints(baseSessionId: string, labels: DeviceLabelMap): () => void {
    const derived = [...new Set(Object.values(labels))].filter(
      (labelSession) => labelSession !== baseSessionId,
    );
    for (const labelSession of derived) {
      this.planLabelMints.set(labelSession, (this.planLabelMints.get(labelSession) ?? 0) + 1);
    }
    let open = true;
    return () => {
      if (!open) {
        return;
      }
      open = false;
      for (const labelSession of derived) {
        const remaining = (this.planLabelMints.get(labelSession) ?? 1) - 1;
        if (remaining > 0) {
          this.planLabelMints.set(labelSession, remaining);
        } else {
          this.planLabelMints.delete(labelSession);
        }
      }
    };
  }

  /** The persisted creator of a session being created: a plan run's label mint marks its row. */
  private creatorSourceForCreation(
    sessionId: string,
    persistenceSource: string | undefined,
  ): string | undefined {
    return this.planLabelMints.has(sessionId) ? PLAN_LABEL_SESSION_SOURCE : persistenceSource;
  }

  /**
   * Lift the terminal fence a derived label session's previous plan run left, for the run that is
   * minting it now (#11572). The pending terminal row write and its journal intent go with it, as
   * when a release is superseded: they belong to the incarnation that ended.
   */
  private liftPlanLabelFenceForMint(sessionId: string): void {
    if (!this.planLabelMints.has(sessionId) || this.sessions.has(sessionId)) {
      return;
    }
    this.endedLabelBases.delete(sessionId);
    if (this.terminalReleaseSnapshots.delete(sessionId)) {
      this.terminalReleaseReasonStates.delete(sessionId);
      this.terminalReleaseJournal.resolve(sessionId);
    }
  }

  /**
   * Refuse a call naming a derived label session that is not live and whose plan run is over
   * (#11572): the row a plan run minted, with no plan in this daemon publishing it. Without this a
   * `plan-auto-release` or `daemon-shutdown` row would be re-issued by name as a session of its
   * own, holding a device with no plan, label map or base. The answer is terminal; no fence is
   * raised and the row is left as it is, so the next plan run can mint the name. While the plan
   * run that minted the label is still running, a row waiting out a recoverable handoff (a device
   * restart) is recovered as before.
   */
  private refusePlanLabelSessionOutsideItsRun(
    sessionId: string,
    persisted: DeviceSession | undefined,
  ): void {
    if (persisted?.source !== PLAN_LABEL_SESSION_SOURCE) {
      return;
    }
    const recoverable =
      !persisted.release_reason || isRecoverableDaemonReleaseReason(persisted.release_reason);
    // A row this daemon did not mint under a still-running plan is a previous run's, whatever its
    // reason (a restarted daemon finds the old `daemon-shutdown` row): not a handoff to recover.
    if (recoverable && this.runningPlanLabelSessions.has(sessionId)) {
      return;
    }
    throw new TerminalSessionError(sessionId, {
      ...this.releaseSnapshotFromPersisted(
        sessionId,
        persisted,
        persisted.release_reason ?? PLAN_AUTO_RELEASE_REASON,
      ),
      terminal: true,
    });
  }

  /**
   * The base session a derived `${base}:${label}` session was published under, or undefined when
   * `sessionId` is not a known derived label session (#11111).
   */
  getBaseSessionOfDerivedLabel(sessionId: string): string | undefined {
    for (const [base, derived] of this.derivedLabelSessionsByBase) {
      if (derived.has(sessionId)) {
        return base;
      }
    }
    return undefined;
  }

  /**
   * The one rule on who mints a derived label session (#11602), applied where every session is
   * created: an id that reads as `${base}:${label}` of a live session is created only by that
   * base's plan run, through the allocation window {@link openPlanLabelMints} opens. Anything else
   * that would create it (a bind with or without a connection identity, a stray call) gets the
   * terminal answer a late label call gets, and holds no device. No fence is raised, so the plan's
   * allocation can still mint the name. A row being recovered was admitted by
   * {@link getOrCreateSession}, and an id whose prefix is no live session is a session of its own.
   */
  private refuseLabelMintOutsidePlanAllocation(sessionId: string, deviceId: string): void {
    if (this.planLabelMints.has(sessionId) || this.pendingPersistedRecoveries.has(sessionId)) {
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

  /** The live session `sessionId` reads as a `${base}:${label}` of, the longest such prefix. */
  private liveBaseOfDerivedId(sessionId: string): string | undefined {
    for (
      let separatorIndex = sessionId.lastIndexOf(":");
      separatorIndex > 0;
      separatorIndex = sessionId.lastIndexOf(":", separatorIndex - 1)
    ) {
      const candidate = sessionId.slice(0, separatorIndex);
      if (this.peekSession(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Whether `sessionId` is live and speaks for the same session as `otherSessionId` wherever
   * ownership is judged: the two are sessions of one plan (#11602). Releases nothing.
   *
   * A label that ended with that plan's base (#11640) still counts: a connection bound to the
   * plan is not told the label is some other session, its call goes on to admission and gets the
   * base's terminal release there.
   */
  isLiveSessionOfSamePlan(sessionId: string, otherSessionId: string): boolean {
    return (
      (this.peekSession(sessionId) !== null &&
        this.ownershipSessionUuid(sessionId) === this.ownershipSessionUuid(otherSessionId)) ||
      this.endedWithPlanOf(sessionId, otherSessionId)
    );
  }

  /** Whether `sessionId` is a label whose ended base is `otherSessionId` or its base. */
  private endedWithPlanOf(sessionId: string, otherSessionId: string): boolean {
    const label = this.sessions.get(sessionId);
    const ended = label && this.endedBaseOfLabel(label);
    if (!ended) {
      return false;
    }
    const other = this.sessions.get(otherSessionId);
    return (
      otherSessionId === ended.baseSessionId ||
      (other !== undefined && this.endedBaseOfLabel(other)?.baseSessionId === ended.baseSessionId)
    );
  }

  /**
   * Remove and return every derived `${base}:${label}` session ever published for `baseSessionId`
   * (#11091). Unlike the base's `deviceLabels` cache slot, this index survives the base's removal,
   * so a release of the base can still cascade to its derived sessions. Entries may name sessions
   * that are already gone; the caller checks each one.
   */
  takeDerivedLabelSessions(baseSessionId: string, releaseReason?: string): string[] {
    const derived = this.derivedLabelSessionsByBase.get(baseSessionId);
    if (releaseReason !== undefined && isTerminalReleaseReason(releaseReason)) {
      for (const labelSessionId of derived ?? []) {
        if (this.sessions.has(labelSessionId)) {
          this.endedLabelBases.set(labelSessionId, { baseSessionId, releaseReason });
        }
      }
    }
    this.derivedLabelSessionsByBase.delete(baseSessionId);
    // The base is being released: its plan run, and with it every label session's, is over.
    derived?.forEach((labelSession) => this.runningPlanLabelSessions.delete(labelSession));
    return derived ? [...derived] : [];
  }

  /**
   * Read the device-label map without recording session activity (issue #3053):
   * label routing reads this on every `device:`-labelled request, so it must not
   * fire a session-activity write per read. Returns `undefined` for an
   * unknown/expired session or a session with no registered labels.
   *
   * It releases nothing either (#11640): every route from a label to its base reads this map, so
   * a session past its idle deadline publishes no labels and is left to the scan, or to a call
   * that names it, to release.
   */
  getDeviceLabels(sessionId: string): DeviceLabelMap | undefined {
    return this.peekSession(sessionId)?.cacheData.deviceLabels;
  }

  /**
   * Get session cache data. A read: it records no activity (#10703), like the typed getters.
   */
  getSessionCache(sessionId: string): SessionCacheData | null {
    return this.getSession(sessionId)?.cacheData ?? null;
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
    if (!session || this.releasingSessions.has(session)) {
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
   * Record a liveness heartbeat for a session.
   *
   * A heartbeat proves the owner process is alive; it is not device use (#10656). It renews the
   * owner lease (`lastHeartbeat`, `lastOwnerHeartbeat`), marks the session as heartbeating, and
   * promotes an awaiting-owner session to owned. It must never write the tool-activity clocks
   * (`lastUsedAt`, `expiresAt`): an idle but live owner — a stdio proxy whose keeper ticks every
   * 2 s while its agent makes no tool calls — would otherwise hold its device forever. Only tool
   * calls (`getOrCreateSession` at the start, `recordToolCallEnded` at the end) move the idle
   * deadline. Guarded by
   * `test/lint/livenessActivityClockSeparation.test.ts` (#10668).
   */
  recordHeartbeat(sessionId: string): void {
    const session = this.unlessBaseEnded(this.getSession(sessionId));
    if (!session) {
      logger.warn(`Cannot record heartbeat for session ${sessionId}: not found`);
      return;
    }
    if (!this.isAdmittedForAutomation(session)) {
      return;
    }
    const now = this.sessionNow();
    session.lastHeartbeat = now;
    // Only a heartbeat advances the owner lease; both the socket and HTTP routes admit one only
    // from the owner (or a tokenless client on a session no proxy owns).
    session.lastOwnerHeartbeat = now;
    session.activityGeneration++;
    session.hasReceivedHeartbeat = true;
    if (session.ownership === "awaiting-owner") {
      session.ownership = "owned";
      session.awaitingOwnerSince = undefined;
    }
    // The heartbeat's own clocks are in-memory only; the row changes only when a persisted field
    // does (the first heartbeat, or a state an earlier write failed to store). Skipping the rest
    // keeps a contended or failing database off the heartbeat path entirely (#11079).
    if (!this.hasUnissuedActivity(session)) {
      return;
    }
    void this.getBarrier()
      .track(() => this.recordSessionActivity(session))
      .catch((error) => {
        // The heartbeat was acknowledged and the owner really is alive: rolling the lease back
        // here would release a healthy owner after lease + grace whenever writes fail (disk
        // full, read-only, busy peer) (#11079). The lease is in-memory; the unstored fields are
        // retried by the next heartbeat or tool call because the failed write is forgotten.
        logger.warn(
          `[SessionManager] Failed to record heartbeat activity for ${sessionId}: ${errorMessage(error)}`,
          error,
        );
      });
  }

  /**
   * Make `ownerToken` the current liveness owner for a session, unless another
   * token owns it with a live lease (#10050).
   *
   * This intentionally does not record activity. The request handler claims
   * ownership before applying the requested policy and recording its heartbeat,
   * so a rejected or stale token can be refused without changing any liveness
   * deadline, and a rejected claim leaves the session's owner and policy intact.
   *
   * Who wins is decided by {@link decideLivenessClaim}. A claim naming a derived
   * `${base}:${label}` session is judged against its base's owner too (#11602); the label keeps
   * its own liveness record, which the heartbeat path reads and renews under the label's id.
   */
  async claimLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<LivenessClaimOutcome> {
    const session = this.unlessBaseEnded(this.getSession(sessionId));
    if (!session) {
      logger.warn(`Cannot claim liveness ownership for session ${sessionId}: not found`);
      return "not-found";
    }
    const mutex = this.livenessOwnershipClaimMutexFor(session);
    return await mutex.runExclusive(async () => {
      if (this.unlessBaseEnded(this.getSession(sessionId)) !== session) {
        return "not-found";
      }
      const processedClaims = session.livenessOwnershipClaims ?? new Set<string>();
      session.livenessOwnershipClaims = processedClaims;
      const base = this.livenessBaseSession(session);
      // Decided with no await before the takeover below takes effect.
      const decision = decideLivenessClaim({
        claimantToken: ownerToken,
        session: this.livenessOwnerView(session),
        claimAlreadyProcessed: processedClaims.has(ownerToken),
        base: base ? this.livenessOwnerView(base) : undefined,
      });
      if (decision.outcome === "superseded") {
        // A retried claim whose token has since been displaced must never take
        // the session back, whatever the new owner's lease says.
        return "superseded";
      }
      if (decision.outcome === "conflict") {
        const holder = decision.holdOf === "base" ? `its base session ${base?.sessionId}` : "it";
        logger.warn(
          `Rejected liveness ownership claim for session ${sessionId}: another owner holds a live lease on ${holder}`,
        );
        return "conflict";
      }
      if (session.livenessOwnerToken === ownerToken && processedClaims.has(ownerToken)) {
        // The owner's own retried claim: nothing to take over.
        return "claimed";
      }
      return await this.takeLivenessOwnership(session, ownerToken, processedClaims);
    });
  }

  /**
   * The live base session of a derived `${base}:${label}` session (#11602): its outermost base, as
   * connection ownership is keyed (#11586). Undefined for a session that is not a published label,
   * and for a label whose base is gone.
   */
  private livenessBaseSession(session: Session): Session | undefined {
    const baseSessionId = this.ownershipSessionUuid(session.sessionId);
    return baseSessionId === session.sessionId
      ? undefined
      : (this.peekSession(baseSessionId) ?? undefined);
  }

  /**
   * The live session under `sessionId` for a lookup that only judges: unlike {@link getSession},
   * an expired session the scan has not reached is reported gone and is not released here.
   */
  peekSession(sessionId: string): Session | null {
    return this.unlessBaseEnded(this.getSessionInternal(sessionId, false, undefined, false));
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
    const retained = this.endedLabelBases.get(label.sessionId);
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
    const fenced = this.terminalReleaseSnapshots.get(sessionId);
    if (fenced) {
      return fenced.releaseReason;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const inFlight = this.releasePromises.get(sessionId);
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
    const fenced = this.terminalReleaseSnapshots.get(sessionId);
    if (fenced || !session) {
      return fenced && new TerminalSessionError(sessionId, fenced);
    }
    return new TerminalSessionError(sessionId, this.terminalReleaseAsOfNow(session, releaseReason));
  }

  /**
   * The session that speaks for `sessionId` wherever ownership is judged or recorded
   * ({@link resolveOwnershipSessionUuid}), resolved without releasing anything: an expired base
   * publishes no labels, and its release is left to the scan and the lazy-expiry paths.
   */
  ownershipSessionUuid(sessionId: string): string {
    return resolveOwnershipSessionUuid(sessionId, {
      getDeviceLabels: (id) => this.peekSession(id)?.cacheData.deviceLabels,
    });
  }

  /** A session's liveness owner as a claim judges it: on the owner's own heartbeats. */
  private livenessOwnerView(session: Session): LivenessOwnerView {
    const ownerToken = session.livenessOwnerToken;
    // A `cli-idle` session never holds a lease against a claim (#6870).
    const hold =
      ownerToken === undefined || session.livenessPolicy === "cli-idle"
        ? "none"
        : livenessLeaseState(sessionOwnerLeaseSnapshot(session, this.sessionNow())).phase;
    return { ownerToken, hold };
  }

  /** Clear only the owner token; preserve the device, policy and existing lease/grace deadline. */
  async releaseLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<LivenessReleaseOutcome> {
    const session = this.unlessBaseEnded(this.getSession(sessionId));
    if (!session || !this.isAdmittedForAutomation(session)) {
      return "not-found";
    }
    return await this.livenessOwnershipClaimMutexFor(session).runExclusive(async () => {
      if (
        this.unlessBaseEnded(this.getSession(sessionId)) !== session ||
        !this.isAdmittedForAutomation(session)
      ) {
        return "not-found";
      }
      if (session.livenessOwnerToken === undefined) {
        return "already-unowned";
      }
      if (session.livenessOwnerToken !== ownerToken) {
        return "not-owner";
      }
      // Tick adoption has no claim history. Fence all keeper ticks before the release write yields.
      session.livenessOwnershipClaims ??= new Set<string>();
      session.livenessOwnershipClaims.add(ownerToken);
      const previousOwnerBoundAt = session.livenessOwnerBoundAt;
      session.livenessOwnerToken = undefined;
      session.livenessOwnerBoundAt = undefined;
      // Fence an older heartbeat write's failure rollback across the handoff.
      session.activityGeneration++;
      try {
        await this.deviceSessionRepository.recordLivenessOwnership?.(sessionId, null);
      } catch (error) {
        session.livenessOwnerToken = ownerToken;
        session.livenessOwnerBoundAt = previousOwnerBoundAt;
        if (!this.isAdmittedForAutomation(session)) {
          return "not-found";
        }
        throw error;
      }
      return "released";
    });
  }

  private livenessOwnershipClaimMutexFor(session: Session): Mutex {
    const existing = this.livenessOwnershipClaimMutexes.get(session);
    if (existing) {
      return existing;
    }
    const mutex = new Mutex();
    this.livenessOwnershipClaimMutexes.set(session, mutex);
    return mutex;
  }

  /** Record a claim {@link decideLivenessClaim} let win. Runs inside the claim mutex. */
  private async takeLivenessOwnership(
    session: Session,
    ownerToken: string,
    processedClaims: Set<string>,
  ): Promise<LivenessClaimOutcome> {
    const previousOwnerToken = session.livenessOwnerToken;
    const previousOwnerHeartbeat = session.lastOwnerHeartbeat;
    const previousOwnerBoundAt = session.livenessOwnerBoundAt;
    const alreadyProcessed = processedClaims.has(ownerToken);
    processedClaims.add(ownerToken);
    session.livenessOwnerToken = ownerToken;
    session.livenessOwnerBoundAt = undefined;
    // Stamp the lease in the same step as the takeover, still inside the claim mutex. The
    // request handler records the claimant's heartbeat several awaits later; until then a second
    // foreign claimant would read the previous, lapsed lease and displace this one (#10050).
    session.lastOwnerHeartbeat = this.sessionNow();
    try {
      await this.persistNewLivenessOwnershipClaim(
        session,
        ownerToken,
        { previousOwnerToken, previousOwnerHeartbeat, previousOwnerBoundAt },
        processedClaims,
      );
    } catch (error) {
      if (alreadyProcessed) {
        processedClaims.add(ownerToken);
      }
      if (!this.isAdmittedForAutomation(session)) {
        // The session's release won the race with this claim: its row is no longer active, so
        // the ownership write matched nothing. The session is gone, as the claim reports.
        logger.info(
          `Liveness ownership claim for session ${session.sessionId} lost to its release: ` +
            errorMessage(error),
        );
        return "not-found";
      }
      throw error;
    }
    return "claimed";
  }

  /**
   * The current owner's hold on the session, judged as a claim is (on the owner's own
   * heartbeats), for a refused claim to report (#10701). For a derived label session it is the
   * hold the claim was refused for, the base owner's when the label's own owner holds nothing
   * (#11602). Undefined for an unknown session and for a `cli-idle` session, which has no lease.
   */
  getOwnerLeaseHold(sessionId: string): LivenessOwnerHold | undefined {
    const named = this.sessions.get(sessionId);
    const base = named ? this.livenessBaseSession(named) : undefined;
    const session =
      named &&
      base &&
      refusedClaimHoldSource(this.livenessOwnerView(named), this.livenessOwnerView(base)) === "base"
        ? base
        : named;
    if (!session || session.livenessPolicy === "cli-idle") {
      return undefined;
    }
    return livenessOwnerHold(sessionOwnerLeaseSnapshot(session, this.sessionNow()));
  }

  /**
   * Whether the session's owner lease is live or inside its suspect window, and
   * how long until that phase ends. Undefined for an unknown session and for a
   * `cli-idle` session, which has no lease.
   */
  getSessionLeaseState(sessionId: string): LivenessLeaseState | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.livenessPolicy === "cli-idle") {
      return undefined;
    }
    return livenessLeaseState(sessionJudgedLeaseSnapshot(session, this.sessionNow()));
  }

  /** Whether the session is inside its suspect window (lease expired, grace running). */
  private isSessionSuspect(session: Session): boolean {
    return (
      holdsOwnerHeartbeatLease(session.livenessPolicy) &&
      livenessLeaseState(sessionJudgedLeaseSnapshot(session, this.sessionNow())).phase === "suspect"
    );
  }

  /**
   * Reject a control call against a suspect session; only its owner's heartbeat restores it.
   * Reads are never refused (#11322): they are answered in every lease phase, restore nothing,
   * and never count as the owner's liveness.
   */
  private assertSessionNotSuspect(session: Session, access: SessionAccess): void {
    if (access !== "read-only" && this.isSessionSuspect(session)) {
      const { remainingMs } = livenessLeaseState(
        sessionJudgedLeaseSnapshot(session, this.sessionNow()),
      );
      throw new SessionSuspectError(session.sessionId, remainingMs);
    }
  }

  /**
   * Whether the owner's lease and suspect grace have both run out, so the heartbeat monitor's
   * next scan releases the session (#11285). Only a session judged on its owner's own heartbeats
   * qualifies: one no proxy owns is kept alive by its tool calls, which are its only liveness.
   */
  private isOwnerLeaseLapsed(session: Session): boolean {
    return (
      judgesOwnerHeartbeats(session) &&
      suspectGraceMsFor(session) > 0 &&
      heartbeatLeasePastGrace(
        this.sessionNow(),
        this.judgedLeaseHeartbeat(session),
        session.heartbeatTimeoutMs,
        suspectGraceMsFor(session),
      )
    );
  }

  /** A live owner's lapsed lease awaits the next scan, unless a control call keeps it. */
  ownerLeaseAwaitsReap(sessionId: string): boolean {
    const session = this.peekSession(sessionId);
    return (
      session !== null &&
      this.isOwnerLeaseLapsed(session) &&
      !this.activeSessionExecutionChecker(sessionId, { excludeReads: true })
    );
  }

  /** Later owner proof from a same-token base, including its release-local credit (#11722). */
  judgedLeaseHeartbeat(session: Session): number {
    const ownHeartbeat = judgedLeaseHeartbeat(session);
    const baseId = this.ownershipSessionUuid(session.sessionId);
    const releasingBaseId =
      baseId === session.sessionId ? this.getBaseSessionOfDerivedLabel(session.sessionId) : baseId;
    const base =
      this.livenessBaseSession(session) ??
      (releasingBaseId === undefined ? undefined : this.getReleasingSession(releasingBaseId));
    if (
      !base ||
      !judgesOwnerHeartbeats(base) ||
      base.livenessOwnerToken === undefined ||
      base.livenessOwnerToken !== session.livenessOwnerToken
    ) {
      return ownHeartbeat;
    }
    const operation = this.releasePromises.get(base.sessionId);
    return Math.max(
      ownHeartbeat,
      judgedLeaseHeartbeat(base),
      operation?.session === base
        ? (operation.ownerHeartbeatDuringRelease ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY,
    );
  }

  /**
   * Credit only the releasing session's owner, within its still-running lease and grace. Socket
   * heartbeats remain refused; this proof is private to the suspect handoff's commit judgement.
   */
  creditOwnerHeartbeatDuringRelease(sessionId: string, ownerToken: string): void {
    const session = this.getReleasingSession(sessionId);
    const operation = this.releasePromises.get(sessionId);
    if (
      !session ||
      operation?.session !== session ||
      operation.forced ||
      operation.judgeSuspectOwnerAtCommit !== true ||
      !shouldJudgeOwnerLeaseForRelease(operation.reason.value) ||
      ownerToken.length === 0 ||
      session.livenessOwnerToken !== ownerToken
    ) {
      return;
    }
    const snapshot = this.releaseOwnerLeaseSnapshot(session, operation);
    if (snapshot && livenessLeaseState(snapshot).phase !== "lapsed") {
      operation.ownerHeartbeatDuringRelease = snapshot.now;
    }
  }

  /**
   * Judge on the later of the session's own lease, a heartbeated same-token base's lease, and
   * release-local owner proof; keep the session's policy and clocks unchanged (#11707).
   */
  private releaseOwnerLeaseSnapshot(
    session: Session,
    operation?: SessionReleaseOperation,
  ): LivenessOwnerLeaseSnapshot | undefined {
    if (!judgesOwnerHeartbeats(session) || suspectGraceMsFor(session) === 0) {
      return undefined;
    }
    const snapshot = sessionJudgedLeaseSnapshot(session, this.sessionNow());
    snapshot.lastHeartbeat = Math.max(
      this.judgedLeaseHeartbeat(session),
      operation?.ownerHeartbeatDuringRelease ?? Number.NEGATIVE_INFINITY,
    );
    return snapshot;
  }

  /** Judge pre-handoff silence for plan cleanup and device restart only. */
  private judgeOwnerLeaseForRelease(
    session: Session,
    reason: ReleaseReasonState,
    stage: "start" | "commit",
    operation?: SessionReleaseOperation,
  ): boolean {
    if (
      (stage === "commit" && operation?.judgeSuspectOwnerAtCommit !== true) ||
      !shouldJudgeOwnerLeaseForRelease(reason.value)
    ) {
      return false;
    }
    const snapshot = this.releaseOwnerLeaseSnapshot(session, operation);
    if (!snapshot) {
      return false;
    }
    const { phase } = livenessLeaseState(snapshot);
    if (phase === "lapsed") {
      this.upgradeReleaseReason(reason, "heartbeat-timeout");
    }
    return phase === "suspect";
  }

  /**
   * Refuse a control call that reached a session whose owner is gone but which the heartbeat
   * monitor has not scanned yet (#11285). Admitting it would refresh the session and let the call
   * veto the scan's release, holding the dead owner's device past `NO_HEARTBEAT_RELEASE_BUDGET_MS`.
   * The session is released now exactly as the scan would release it, and the caller gets the
   * terminal refusal. A call already in flight keeps the session (#5343), bounded by the monitor's
   * unsettled-execution veto; the new call is still refused, as it is in the suspect window.
   * Reads are never refused here.
   */
  private async refuseControlCallOnLapsedOwnerLease(
    session: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    if (access === "read-only" || !this.isOwnerLeaseLapsed(session)) {
      return;
    }
    const callerExecutionId = execution?.executionId ?? unnamedCallerExecutionId;
    // Only a control call in flight keeps the session (#5343). A read admitted since the owner
    // went quiet is watching, not use: it must not turn this refusal retryable (#11322). Nor must
    // the refused call itself, which is tracked under the session when it arrived through
    // autolock (#11400).
    const query: ActiveSessionExecutionQuery = {
      excludeReads: true,
      ...(callerExecutionId === undefined ? {} : { excludeExecutionId: callerExecutionId }),
    };
    if (this.activeSessionExecutionChecker(session.sessionId, query)) {
      throw new SessionSuspectError(session.sessionId, 0);
    }
    logger.info(
      `Session ${session.sessionId} lost its owner's heartbeat lease before this call; releasing`,
    );
    // Cut what the scan's reap would cut, through the routine it uses: a read still in flight is
    // answered with the typed release instead of being left running on a freed device (#11400).
    this.cancelExecutionsCutByRelease(session.sessionId, "heartbeat-timeout", callerExecutionId);
    await this.releaseSession(session.sessionId, "heartbeat-timeout", true, undefined, {
      expiryOrigin: "lazy-expiry",
    });
    const terminalRelease =
      this.terminalReleaseSnapshots.get(session.sessionId) ??
      (await this.getPersistedTerminalRelease(session.sessionId));
    if (terminalRelease) {
      throw new TerminalSessionError(session.sessionId, terminalRelease);
    }
    // The release did not finish terminally; never admit the call on the strength of that.
    throw new SessionSuspectError(session.sessionId, 0);
  }

  /**
   * A control call naming a plan label whose base lost its owner's heartbeat lease, before the
   * monitor's scan (#11640): the base's end ends its labels, so the call is answered as a call
   * naming the base is ({@link refuseControlCallOnLapsedOwnerLease}), which releases the base
   * unless a control call in flight still keeps it. The terminal answer is given under the
   * label's id with the base's reason; the retryable one names the base, whose lease it is about.
   */
  private async refuseLabelCallOnLapsedBaseLease(
    label: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    if (access === "read-only" || label.persistenceMetadata?.source !== PLAN_LABEL_SESSION_SOURCE) {
      return;
    }
    const baseSessionId = this.getBaseSessionOfDerivedLabel(label.sessionId);
    const base = baseSessionId === undefined ? undefined : this.sessions.get(baseSessionId);
    if (!base || !this.isOwnerLeaseLapsed(base)) {
      return;
    }
    try {
      await this.refuseControlCallOnLapsedOwnerLease(
        base,
        access,
        execution,
        unnamedCallerExecutionId,
      );
    } catch (error) {
      if (error instanceof TerminalSessionError) {
        throw new TerminalSessionError(
          label.sessionId,
          this.terminalReleaseAsOfNow(label, error.release.releaseReason),
        );
      }
      throw error;
    }
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
   * `gapBeganAt`, when given, narrows the lease forgiveness (#11080): an owned session's lease is
   * excused only when the gap began within one lease of its owner's last heartbeat
   * ({@link ownerLeaseLiveAt}); its idle deadline is still moved as above. An owner whose lease
   * had already run out before the gap was not heartbeating, so the gap hid nothing from the
   * daemon; forgiving it anyway let a dead owner keep its device for as long as the daemon's scans
   * kept arriving late. A live owner is forgiven in full however long the gap. Returns how many
   * sessions were extended.
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
      if (ownerLeaseLiveAt(session, gapBeganAt)) {
        // The lease that is judged (#11162): for a session judged on its owner's heartbeats, a
        // non-owner's tool call must not move the forgiven lease start.
        const leaseStart = judgedLeaseHeartbeat(session);
        session.stallForgivenAt = forgivenLeaseStart(leaseStart, resumedAt, leaseLostMs);
        leaseExtended += Number(session.stallForgivenAt > leaseStart);
      }
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
          `${idleExtended} idle deadline(s) extended by ${lostMs}ms, of ${forgiven} session(s)`,
      );
    }
    return forgiven;
  }

  /** Compensate the claim-only mint lease independently of the activity-derived stall floor. */
  private forgiveMintBoundClaimLease(
    session: Session,
    resumedAt: number,
    leaseLostMs: number,
    gapBeganAt?: number,
  ): void {
    if (
      hasMintBoundClaimLease(session) &&
      (gapBeganAt === undefined ||
        leaseRunningAt(session.livenessOwnerBoundAt, session.heartbeatTimeoutMs, gapBeganAt))
    ) {
      session.livenessOwnerBoundAt = forgivenLeaseStart(
        session.livenessOwnerBoundAt,
        resumedAt,
        leaseLostMs,
      );
    }
  }

  private async persistNewLivenessOwnershipClaim(
    session: Session,
    ownerToken: string,
    previous: {
      previousOwnerToken: string | undefined;
      previousOwnerHeartbeat: number | undefined;
      previousOwnerBoundAt: number | undefined;
    },
    processedClaims: Set<string>,
  ): Promise<void> {
    const settleClaimantHeartbeat = this.markAcceptedClaimantHeartbeating(session);
    try {
      if (this.deviceSessionRepository.recordLivenessOwnership) {
        await this.deviceSessionRepository.recordLivenessOwnership(session.sessionId, ownerToken);
      } else {
        await this.recordSessionActivity(session);
      }
    } catch (error) {
      processedClaims.delete(ownerToken);
      session.livenessOwnerToken = previous.previousOwnerToken;
      session.lastOwnerHeartbeat = previous.previousOwnerHeartbeat;
      session.livenessOwnerBoundAt = previous.previousOwnerBoundAt;
      settleClaimantHeartbeat("undo");
      throw error;
    }
    settleClaimantHeartbeat("keep");
  }

  /**
   * An accepted claim is its owner's heartbeat (#11646). The claim arrives on the proxy's first
   * heartbeat, and the request handler records that heartbeat only after the ownership row write
   * resolves; until then the monitor would judge the session as one that never heartbeated, or
   * one still awaiting its rehydrated owner, and release it although its owner is live. The fact
   * is in-memory and set before the write, so a slow database stays off the heartbeat path
   * (#11079); the lease itself was stamped with the takeover, and is what the session is judged
   * on from here. Called only for an accepted claim, so a refused one changes nothing.
   *
   * Returns how the claim settles. "undo", for a claim whose write fails, leaves the session as
   * unheard and as unclaimed as the claim found it; a heartbeat or tool call recorded while the
   * write was pending moved the activity generation and stands on its own, so the undo leaves it
   * alone. A rehydrated session's owner window (`awaitingOwnerSince`) stays in place while the
   * write is pending, so the daemon's stall forgiveness keeps moving it and an undone claim
   * returns to the forgiven window, not the one the claim found; it is dropped once the
   * promotion stands.
   */
  private markAcceptedClaimantHeartbeating(session: Session): (outcome: "keep" | "undo") => void {
    const { hasReceivedHeartbeat, ownership, activityGeneration } = session;
    session.hasReceivedHeartbeat = true;
    if (ownership === "awaiting-owner") {
      session.ownership = "owned";
    }
    return (outcome) => {
      if (outcome === "undo" && session.activityGeneration === activityGeneration) {
        session.hasReceivedHeartbeat = hasReceivedHeartbeat;
        session.ownership = ownership;
        return;
      }
      if (ownership === "awaiting-owner" && session.ownership === "owned") {
        session.awaitingOwnerSince = undefined;
      }
    };
  }

  /** Return whether `ownerToken` is still authorized to refresh the session. */
  hasLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return this.unlessBaseEnded(this.getSession(sessionId))?.livenessOwnerToken === ownerToken;
  }

  /**
   * Recover daemon-local liveness ownership after restart without allowing a
   * keeper to replace an owner that was established by this daemon instance.
   * Decided by {@link mayAdoptUnownedLiveness}: a derived label session is not adopted past
   * another token that holds its base (#11602).
   */
  claimUnownedLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    const session = this.unlessBaseEnded(this.getSession(sessionId));
    if (!session || !this.adoptUnownedLivenessOwnerToken(session, ownerToken)) {
      return false;
    }
    session.lastOwnerHeartbeat = this.sessionNow();
    return true;
  }

  /** Bind acquisition identity and its claim-only lease start; no heartbeat or release changes. */
  bindAcquiredLivenessOwnerToken(sessionId: string, ownerToken: string): boolean {
    const session = this.peekSession(sessionId);
    if (!session || !this.adoptUnownedLivenessOwnerToken(session, ownerToken)) {
      return false;
    }
    session.livenessOwnerBoundAt = this.sessionNow();
    return true;
  }

  private adoptUnownedLivenessOwnerToken(session: Session, ownerToken: string): boolean {
    const base = this.livenessBaseSession(session);
    const adopt = mayAdoptUnownedLiveness({
      claimantToken: ownerToken,
      session: this.livenessOwnerView(session),
      sessionHasClaimHistory: Boolean(session.livenessOwnershipClaims?.size),
      base: base ? this.livenessOwnerView(base) : undefined,
    });
    if (!adopt) {
      return false;
    }
    session.livenessOwnerToken = ownerToken;
    session.livenessOwnerBoundAt = undefined;
    this.persistAdoptedLivenessOwnerToken(session);
    return true;
  }

  private persistAdoptedLivenessOwnerToken(session: Session): void {
    if (!this.deviceSessionRepository.replaceLivenessOwnership) {
      return;
    }
    void this.getBarrier()
      .track(() =>
        this.livenessOwnershipClaimMutexFor(session).runExclusive(async () => {
          if (
            this.peekSession(session.sessionId) !== session ||
            !this.isAdmittedForAutomation(session) ||
            !session.livenessOwnerToken
          ) {
            return;
          }
          // Read under the claim mutex: a queued adoption must not restore an older owner.
          await this.deviceSessionRepository.replaceLivenessOwnership?.(
            session.sessionId,
            session.livenessOwnerToken,
          );
        }),
      )
      .catch((error) => {
        if (error instanceof DeviceSessionNotActiveError) {
          // The row may have been released or not yet activated; in-memory adoption still stands.
          logger.debug("[SessionManager] Adopted liveness owner row is no longer active");
          return;
        }
        // Persistence is best-effort; omit error details because they may contain the token.
        logger.warn("[SessionManager] Failed to persist adopted liveness ownership");
      });
  }

  /**
   * Move a session onto the CLI liveness policy and record a heartbeat (#6870).
   *
   * Called when a one-shot `--cli` process declares ownership of the session it
   * just minted or joined. From here on the heartbeat monitor stops applying the
   * 10 s contract (which no one-shot process can keep between invocations) and
   * reaps the session only after {@link getCliSessionIdleTimeoutMs} of wall-clock
   * idleness. Returns false when the session is unknown — the CLI's declaration
   * is best-effort and must never fail the tool call that carried it.
   */
  adoptCliLivenessPolicy(sessionId: string, requestedIdleTimeoutMs?: number): boolean {
    const session = this.unlessBaseEnded(this.getSession(sessionId));
    if (!session) {
      logger.warn(`Cannot adopt CLI liveness policy for session ${sessionId}: not found`);
      return false;
    }
    if (session.livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY) {
      // A managed execution's proxy owns this session for the execution's lifetime (#11176); a
      // one-shot CLI declaration must not widen it onto a heartbeat-free idle policy.
      logger.warn(
        `Refusing the CLI liveness policy for managed-execution session ${sessionId}; it stays on its owner lease`,
      );
      return false;
    }
    // A `--cli` invocation reuses whatever daemon is already running, so the
    // daemon process environment cannot be the only source of the idle timeout:
    // the invocation sends its own resolved (and here re-validated, bounded)
    // value, and only an absent/unusable one falls back to this process's env
    // (issue #6870 review).
    const idleTimeoutMs =
      sanitizeRequestedCliIdleTimeoutMs(requestedIdleTimeoutMs) ??
      Math.min(resolveCliSessionIdleTimeoutMs(), MAX_CLI_SESSION_IDLE_TIMEOUT_MS);
    if (session.livenessPolicy === "heartbeat") {
      // Remember the strict contract exactly once, so a long-lived owner taking
      // this UUID over can put the session back on it (issue #6870 review). A
      // re-adoption must not overwrite the snapshot with the CLI's own widened
      // values.
      session.preCliLiveness = {
        heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        heartbeatTimeoutSource: session.heartbeatTimeoutSource,
        sessionTimeoutMs: session.sessionTimeoutMs,
      };
    }
    session.livenessPolicy = "cli-idle";
    session.heartbeatTimeoutMs = idleTimeoutMs;
    // Widen the ordinary expiry deadline too. An autolocked session is created
    // with a 60 s `sessionTimeoutMs`, and a later invocation's lookup expires a
    // session past `expiresAt` — so leaving `expiresAt` on the 60 s clock would
    // release a CLI-owned session long before the CLI idle timeout the policy
    // promises. `Math.max` keeps adoption from ever *shortening* the deadline of
    // a session that already had a longer one (a plain 30-minute session stays
    // at 30 minutes; the cli-idle policy still reaps it at the idle timeout,
    // which is the stricter of the two). The widened deadline is measured from
    // the last tool call, never from this declaration (#10656).
    session.sessionTimeoutMs = Math.max(session.sessionTimeoutMs, idleTimeoutMs);
    widenIdleDeadlineFromLastActivity(session);
    this.recordHeartbeat(sessionId);
    logger.debug(
      `Session ${sessionId} adopted the CLI liveness policy (idle timeout ${session.heartbeatTimeoutMs}ms)`,
    );
    return true;
  }

  /**
   * Put a session on the `managed-execution` liveness policy (#11176) with its idle window: the
   * launcher-trusted `idleTimeoutMs` (bounded 2–60 minutes) or the 2-minute default. Called by the
   * managed slot acquisition once it holds the session (epic #11172 step 5); a re-adoption updates
   * the window. The owner lease is unchanged, and the idle deadline is re-derived from the last
   * tool activity, never from now, so adopting the policy is not device use (#10656).
   *
   * Throws `ManagedSlotConfigError` for an out-of-bounds window and `ActionableError` for an
   * unknown session or a `cli-idle` one (a one-shot CLI session is not an execution's session).
   * A failed durable write rolls the in-memory change back and throws.
   */
  async adoptManagedExecutionLivenessPolicy(
    sessionId: string,
    options: { idleTimeoutMs?: number } = {},
  ): Promise<Session> {
    const idleTimeoutMs = resolveManagedExecutionIdleTimeoutMs(options.idleTimeoutMs);
    const session = this.getSession(sessionId);
    if (!session) {
      throw new ActionableError(
        `Cannot hold session ${sessionId} for a managed execution: the session is not active.`,
      );
    }
    if (session.livenessPolicy === "cli-idle") {
      throw new ActionableError(
        `Cannot hold session ${sessionId} for a managed execution: it is owned by a one-shot CLI.`,
      );
    }
    const previous = {
      livenessPolicy: session.livenessPolicy,
      sessionTimeoutMs: session.sessionTimeoutMs,
      expiresAt: session.expiresAt,
    };
    session.livenessPolicy = MANAGED_EXECUTION_LIVENESS_POLICY;
    session.sessionTimeoutMs = idleTimeoutMs;
    rebaseIdleDeadlineOnLastActivity(session);
    session.activityGeneration++;
    const capturedGeneration = session.activityGeneration;
    try {
      await this.recordSessionActivity(session);
    } catch (error) {
      // Only the latest change may roll back, so an older failure cannot clobber newer state.
      if (session.activityGeneration === capturedGeneration) {
        Object.assign(session, previous);
      }
      throw error;
    }
    logger.info(
      `Session ${sessionId} is held for a managed execution (idle window ${idleTimeoutMs}ms)`,
    );
    return session;
  }

  /**
   * Put a CLI-adopted session back on the strict heartbeat contract (#6870).
   *
   * `adoptCliLivenessPolicy` is sticky by design — a one-shot process is gone by
   * the time the next invocation arrives — but a long-lived stdio/HTTP proxy
   * that later owns the same session UUID *can* keep the 10 s contract, and its
   * heartbeats say so. Without this, that session would stay on the minutes-long
   * idle window and keep holding its device for the whole window after the
   * long-lived client disconnects. Returns false when there was nothing to
   * restore (unknown session, or one that never adopted the CLI policy).
   */
  restoreHeartbeatLivenessPolicy(sessionId: string): boolean {
    const session = this.unlessBaseEnded(this.getSession(sessionId));
    if (!session || session.livenessPolicy !== "cli-idle") {
      return false;
    }
    // Defensive fallback: a session that is somehow on the CLI policy without a
    // snapshot (a future recovery path that persists the policy) must still come
    // back to a strict timeout rather than keep the minutes-long one.
    const snapshot: PreCliLivenessSnapshot = session.preCliLiveness ?? {
      heartbeatTimeoutMs: getDefaultSessionHeartbeatTimeoutMs(),
      heartbeatTimeoutSource: "default",
      sessionTimeoutMs: session.sessionTimeoutMs,
    };
    session.livenessPolicy = "heartbeat";
    session.heartbeatTimeoutMs = snapshot.heartbeatTimeoutMs;
    session.heartbeatTimeoutSource = snapshot.heartbeatTimeoutSource;
    session.sessionTimeoutMs = snapshot.sessionTimeoutMs;
    delete session.preCliLiveness;
    // Re-derive the idle deadline from the restored (shorter) timeout, so the
    // widened deadline adoption installed does not outlive the policy that
    // justified it. It is measured from the last tool call: this heartbeat
    // proves liveness, not use, and must not extend it (#10656).
    rebaseIdleDeadlineOnLastActivity(session);
    this.recordHeartbeat(sessionId);
    logger.debug(
      `Session ${sessionId} restored the heartbeat liveness policy (timeout ${session.heartbeatTimeoutMs}ms)`,
    );
    return true;
  }

  /**
   * Clear session cache (for specific key or all)
   */
  clearSessionCache(sessionId: string, key?: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }

    if (key) {
      delete session.cacheData[key as keyof SessionCacheData];
    } else {
      // Observation-cache invalidation must not clear a deliberate session selection.
      session.cacheData =
        session.cacheData.displayPin === undefined
          ? {}
          : { displayPin: session.cacheData.displayPin };
    }

    logger.debug(`Cleared cache for session ${sessionId}${key ? ` (key: ${key})` : " (all)"}`);
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
    return Array.from(
      new Set([
        ...this.sessions.keys(),
        ...this.pendingSessionCreations.keys(),
        ...this.pendingSessionAssignments.keys(),
        ...this.pendingSessionRebinds.keys(),
        ...this.pendingSessionReleases.keys(),
        ...this.releasePromises.keys(),
      ]),
    );
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

  /**
   * Check if session is expired
   */
  private isSessionExpired(session: Session): boolean {
    // A CLI-owned session (#6870) is governed solely by the wall-clock idle
    // policy `SessionHeartbeatMonitor` applies, which releases it as
    // `cli-idle-timeout`. The ordinary expiry deadline must not release it
    // first: autolock mints sessions with a 60 s `sessionTimeoutMs`, and both
    // deadlines would otherwise land on the same millisecond once adoption
    // widens `expiresAt`, letting the generic sweep win the tie.
    if (session.livenessPolicy === "cli-idle") {
      return false;
    }
    // The idle deadline is exactly the idle window after the last control call: the suspect
    // grace (#10051) belongs to the heartbeat lease only, never to idleness (#11107).
    if (this.sessionNow() <= sessionIdleDeadline(session)) {
      return false;
    }
    return !isReleaseVetoedByExecutions({
      hasActiveExecutions: this.activeSessionExecutionChecker(session.sessionId, {
        excludeReads: true,
      }),
      now: this.sessionNow(),
      ...this.idleExecutionVetoBoundInput(session),
    });
  }

  /**
   * The facts the shared unsettled-execution policy (#10712) bounds an idle-release veto by
   * (#10713). Only control calls refresh `expiresAt`, so the veto has held since the idle deadline
   * passed: it lasts until the control calls' request deadline plus grace, or, when some control
   * call has no deadline, the ceiling after the idle deadline — the same bound the heartbeat and
   * owner-disconnect paths apply (#10663).
   */
  private idleExecutionVetoBoundInput(session: Session): {
    vetoedSince: number;
    latestDeadlineMs: number | undefined;
  } {
    return {
      vetoedSince: sessionIdleDeadline(session),
      latestDeadlineMs: this.sessionExecutionDeadlineLookup(session.sessionId, {
        excludeReads: true,
      }),
    };
  }

  /**
   * What bounds an in-flight control call's idle-release veto for `sessionId`, or undefined when
   * nothing that vetoes the release is in flight. Hold diagnostics derive `idleReleaseAt` from it
   * with the same shared policy the idle sweep applies (#10671, #10712, #10713).
   */
  getIdleReleaseExecutionVeto(sessionId: string): { latestDeadlineMs?: number } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    // Report the deadline the releaser applies (#11393): the heartbeat monitor and idle sweep
    // both count only control calls, for every liveness policy (#11381).
    const query: Pick<ActiveSessionExecutionQuery, "excludeReads"> = { excludeReads: true };
    if (!this.activeSessionExecutionChecker(sessionId, query)) {
      return undefined;
    }
    return { latestDeadlineMs: this.sessionExecutionDeadlineLookup(sessionId, query) };
  }

  /**
   * An idle-expiry release overrides in-flight work only once that work's veto has run out
   * (#10713). Abort it before the release starts so a call that never settles cannot keep driving
   * the device after its next owner binds it (#10820). Every expiry path consults the veto before
   * releasing (#10956), so by the time this runs any execution still in flight is one the release
   * overrides: cancel it unconditionally rather than free the device under a running call. The
   * execution whose own lookup expired the session is spared. Returns whether it cancelled.
   */
  private cancelExecutionsOverriddenByExpiry(
    session: Session,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    return this.cancelExecutionsCutByRelease(session.sessionId, releaseReason, excludeExecutionId);
  }

  /**
   * Abort every call still running under a session that is about to be released for a reason of
   * its own, with the typed release, so each cut caller gets the terminal refusal. The one routine
   * for every such release: idle sweep, lazy expiry, the lapsed-lease admission, and the daemon's
   * heartbeat reap and owner-disconnect release (#11400). It covers the released session's
   * implicit (autolock) calls too, and a base session's calls that drive a derived label session's
   * device, so a veto can never count a call the release then leaves running on a freed device.
   * A base session's call on any other device is counted by the veto but not cut: its session and
   * its device are both still held. Returns whether anything was in flight.
   */
  cancelExecutionsCutByRelease(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    const query: ActiveSessionExecutionQuery =
      excludeExecutionId === undefined ? {} : { excludeExecutionId };
    if (!this.activeSessionExecutionChecker(sessionId, query)) {
      return false;
    }
    this.expiryReleaseExecutionCanceller(
      sessionId,
      new SessionReleasedDuringCallError(sessionId, releaseReason),
      query,
      (this.sessions.get(sessionId) ?? this.getReleasingSession(sessionId))?.assignedDevice,
    );
    return true;
  }

  /** Keep the heartbeat diagnostic when idle expiry wins the scan or lookup race (#10051). */
  private expiredSessionReleaseReason(session: Session): SessionReleaseReason {
    if (
      suspectGraceMsFor(session) > 0 &&
      livenessLeaseState(sessionJudgedLeaseSnapshot(session, this.sessionNow())).phase === "lapsed"
    ) {
      return "heartbeat-timeout";
    }
    return session.livenessPolicy === "cli-idle" ? "cli-idle-timeout" : IDLE_WINDOW_RELEASE_REASON;
  }

  private isSessionExpiredForNewExecution(
    session: Session,
    execution?: SessionClockExecution,
  ): boolean {
    // A lookup that carries no execution (routing resolution: autolock, setActiveDevice, the
    // lifecycle ownership check) is not a call that arrived after the deadline; it only asks who
    // holds the device. It must respect the unsettled-execution veto exactly as the idle sweep
    // does, or it releases a session whose long call is still driving the device (#10956).
    if (execution === undefined) {
      return this.isSessionExpired(session);
    }
    // The deadline the scan releases on and the client is told (#11558): a `cli-idle` session's
    // moves with the daemon's own stall, which its `expiresAt` does not record.
    const idleDeadline = sessionIdleDeadline(session);
    if (this.sessionNow() <= idleDeadline) {
      return false;
    }
    return execution.sessionClockStartTime > idleDeadline;
  }

  /**
   * A late call while other control work or recovery holds the session. Only a timely control
   * call admits new control work; the unbounded check preserves the hold without admission.
   */
  private isLateExecutionWhileEarlierWorkIsActive(
    session: Session,
    execution: SessionClockExecution | undefined,
    timelyControlOnly = false,
  ): boolean {
    const idleDeadline = sessionIdleDeadline(session);
    return (
      execution !== undefined &&
      this.sessionNow() > idleDeadline &&
      execution.sessionClockStartTime > idleDeadline &&
      this.activeSessionExecutionChecker(session.sessionId, {
        ...(timelyControlOnly ? { sessionClockStartedAtOrBefore: idleDeadline } : {}),
        excludeExecutionId: execution.executionId,
        excludeReads: true,
      })
    );
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
    this.endedLabelBases.delete(sessionId);
    // The session ended: its row is no longer rewritten live, and no retry timer outlives it.
    this.settleOwedSupersededRowReassert(session);
    this.sessionDeviceMap.delete(sessionId);
    this.networkConditionGeneration.delete(sessionId);
    this.networkConditionMutationQueues.delete(sessionId);
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
      if (this.isSessionExpired(session) && !this.releasingSessions.has(session)) {
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
      const release = this.releaseSession(sessionId, releaseReason, true, undefined, {
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
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      this.timer.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.rehydrationFollowUpTimer) {
      this.timer.clearTimeout(this.rehydrationFollowUpTimer);
      this.rehydrationFollowUpTimer = null;
    }
    for (const entry of this.pendingTerminalReleaseRetries.values()) {
      if (entry.handle !== undefined) {
        this.timer.clearTimeout(entry.handle);
        entry.handle = undefined;
      }
    }
    for (const entry of this.owedSupersededRowReasserts.values()) {
      if (entry.handle !== undefined) {
        this.timer.clearTimeout(entry.handle);
        entry.handle = undefined;
      }
    }
    // Cancel any armed per-condition network TTLs so a stopped manager leaves no
    // dangling timer (issue #6085 item 2).
    for (const entry of this.networkConditionExpiryTimers.values()) {
      this.timer.clearTimeout(entry.handle);
    }
    this.networkConditionExpiryTimers.clear();
    this.iosAppNetworkLeases.stopAll();
    this.pendingNonTerminalReleaseSnapshots.clear();
    this.supersededRowsUnderPendingRelease.clear();
  }

  // Intentionally NOT barrier-tracked: this write is `await`ed by its caller
  // (createSession), so it is caller-tied, not fire-and-forget. The DbWriteBarrier
  // (issue #2885) only drains fire-and-forget writers at graceful shutdown; an
  // awaited write is already sequenced by its caller and must not be wrapped in
  // `track()`. Do not "fix" this by adding a barrier — that would be a non-bug fix.
  private async persistSession(
    session: Session,
    incarnation: Session,
    upsertOptions?: UpsertActiveSessionOptions,
    upsertSettled?: () => void,
  ): Promise<void> {
    const closeJoinableFlight = () => {
      upsertSettled?.();
      upsertSettled = undefined;
    };
    const write = (options: UpsertActiveSessionOptions | undefined) => {
      const statement = this.deviceSessionRepository.upsertActiveSession(
        {
          sessionUuid: session.sessionId,
          deviceId: session.assignedDevice,
          stableDeviceId: session.stableDeviceId,
          platform: session.platform,
          source: session.persistenceMetadata?.source ?? "session-manager",
          autolockEnabled: session.persistenceMetadata?.autolockEnabled,
          mcpSessionId: session.persistenceMetadata?.mcpSessionId,
          daemonSessionId: this.daemonSessionId ?? session.persistenceMetadata?.daemonSessionId,
          createdAtMs: session.createdAt,
          lastUsedAtMs: session.lastUsedAt,
          expiresAtMs: session.expiresAt,
          sessionTimeoutMs: session.sessionTimeoutMs,
          heartbeatTimeoutMs: session.heartbeatTimeoutMs,
          heartbeatTimeoutSource: session.heartbeatTimeoutSource,
          hasReceivedHeartbeat: session.hasReceivedHeartbeat,
          livenessPolicy: session.livenessPolicy,
          preCliHeartbeatTimeoutMs: session.preCliLiveness?.heartbeatTimeoutMs,
          preCliHeartbeatTimeoutSource: session.preCliLiveness?.heartbeatTimeoutSource,
          preCliSessionTimeoutMs: session.preCliLiveness?.sessionTimeoutMs,
        },
        // The retention prune compares release stamps (#11129); converted to wall ms with them.
        this.sessionNow(),
        options,
      );
      if (upsertSettled) {
        // Clear once at the statement boundary, before ownership work or refusal classification.
        void statement.then(closeJoinableFlight, closeJoinableFlight);
      }
      return statement;
    };
    const guard = upsertOptions?.rewriteOverSupersededRelease;
    let rowGeneration: number | void;
    try {
      rowGeneration = await write(upsertOptions);
    } catch (error) {
      if (
        !(error instanceof DeviceSessionRowNotRewritableError) ||
        guard?.ownDaemonSessionId === undefined
      ) {
        throw error;
      }
      rowGeneration = await this.retryRefusedRowWrite(error, session.sessionId, guard, (next) =>
        write({ ...upsertOptions, rewriteOverSupersededRelease: next }),
      );
    }
    // Recorded before the ownership write, which can fail after the row already advanced.
    this.recordPersistedRowGeneration(incarnation, rowGeneration);
    await this.deviceSessionRepository.replaceLivenessOwnership?.(
      session.sessionId,
      session.livenessOwnerToken ?? null,
    );
  }

  private recordPersistedRowGeneration(incarnation: Session, rowGeneration: number | void): void {
    if (typeof rowGeneration === "number") {
      this.persistedRowGenerations.set(incarnation, rowGeneration);
    }
  }

  private async recoveryTargetFromPersisted(
    sessionId: string,
    persisted: DeviceSession | undefined,
    requestedPlatform: Platform | undefined,
    callerInFlight: boolean,
  ): Promise<SessionRecoveryTarget | undefined> {
    // Admission already accepted this recovery; its own target wait decides at the window end.
    if (!persisted || !this.isReissuablePersistedSession(persisted, true)) {
      return undefined;
    }
    const stableDeviceId = persistedStableDeviceId(persisted);
    if (!stableDeviceId && this.isNameReissueOnlyRow(persisted)) {
      // Nothing to prefer: the re-issue is an ordinary allocation (#11418).
      return undefined;
    }
    if (!stableDeviceId) {
      await this.terminalizePersistedRecoveryFailure(sessionId, persisted, {
        terminalReleaseReason: "identity-recovery-identity-continuity-lost",
      });
      throw new ActionableError(
        `Cannot safely recover session ${sessionId}: its persisted device identity is unavailable. ` +
          "Acquire a new device with getAndroid or getApple.",
      );
    }
    if (requestedPlatform && requestedPlatform !== persisted.platform) {
      throw new ActionableError(
        `Cannot safely recover session ${sessionId}: requested platform ${requestedPlatform} ` +
          `does not match persisted platform ${persisted.platform}. ` +
          "Acquire a new device with getAndroid or getApple.",
      );
    }
    return {
      platform: persisted.platform,
      stableDeviceId,
      deviceId: persisted.device_id,
      restartRecoveryDeadlineMs: restartRecoveryDeadlineFromPersisted(persisted, callerInFlight),
      liveness: this.recoveryLivenessFromPersisted(persisted),
      persistenceMetadata: {
        source: persisted.source,
        autolockEnabled: persisted.autolock_enabled === 1,
        mcpSessionId: persisted.mcp_session_id,
        daemonSessionId: this.recoveredRowOwner(),
      },
      ...(persisted.platform === "android"
        ? { androidEmulator: isAndroidEmulatorSerial(persisted.device_id) }
        : {}),
    };
  }

  /**
   * Rebuild the liveness contract from the persisted row. Rows written before
   * the liveness columns existed fall back to the strict default contract;
   * autolock metadata alone is not proof that a client declared CLI liveness.
   */
  private recoveryLivenessFromPersisted(persisted: DeviceSession): SessionRecoveryLiveness {
    const heartbeatTimeoutSource = persistedHeartbeatTimeoutSource(
      persisted.heartbeat_timeout_source,
    );
    const livenessPolicy = persistedLivenessPolicy(persisted.liveness_policy);
    const persistedPreCli = persistedPreCliLiveness(persisted);
    const preCliLiveness = persistedPreCli && {
      ...persistedPreCli,
      heartbeatTimeoutMs: this.currentDefaultLease(
        persistedPreCli.heartbeatTimeoutMs,
        persistedPreCli.heartbeatTimeoutSource,
      ),
      sessionTimeoutMs: this.currentDefaultIdleWindow(persistedPreCli.sessionTimeoutMs),
    };
    if (livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY) {
      // The declared window is the execution's own, not a default to follow: 30 minutes (the
      // legacy default `currentDefaultIdleWindow` rewrites) is a valid managed window (#11176).
      return {
        sessionTimeoutMs: clampManagedExecutionIdleTimeoutMs(persisted.session_timeout_ms),
        heartbeatTimeoutMs: this.currentDefaultLease(
          persisted.heartbeat_timeout_ms,
          heartbeatTimeoutSource,
        ),
        heartbeatTimeoutSource,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        livenessPolicy,
      };
    }
    const sessionTimeoutMs = this.currentDefaultIdleWindow(persisted.session_timeout_ms);
    if (livenessPolicy === "cli-idle") {
      // A CLI session's heartbeat timeout is its idle timeout, whatever the stored source says.
      const cliIdleTimeoutMs =
        persisted.heartbeat_timeout_ms === LEGACY_DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS
          ? Math.min(resolveCliSessionIdleTimeoutMs(), MAX_CLI_SESSION_IDLE_TIMEOUT_MS)
          : persisted.heartbeat_timeout_ms;
      return {
        sessionTimeoutMs: Math.max(sessionTimeoutMs, cliIdleTimeoutMs),
        heartbeatTimeoutMs: cliIdleTimeoutMs,
        heartbeatTimeoutSource,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        livenessPolicy,
        ...(preCliLiveness ? { preCliLiveness } : {}),
      };
    }
    return {
      sessionTimeoutMs,
      heartbeatTimeoutMs: this.currentDefaultLease(
        persisted.heartbeat_timeout_ms,
        heartbeatTimeoutSource,
      ),
      heartbeatTimeoutSource,
      hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
      livenessPolicy,
      ...(preCliLiveness ? { preCliLiveness } : {}),
    };
  }

  /**
   * A recovered session's lease: one this daemon (or an older one) chose by default follows the
   * current default, so an upgrade does not leave a pre-upgrade session on the old lease for its
   * whole life. An explicitly requested lease is kept.
   */
  private currentDefaultLease(heartbeatTimeoutMs: number, source: "default" | "custom"): number {
    return source === "default" ? getDefaultSessionHeartbeatTimeoutMs() : heartbeatTimeoutMs;
  }

  /**
   * A recovered session's idle window. The stored value has no source column, so a row holding
   * exactly the pre-2026-10-08 default (30 min) is treated as defaulted and follows the current
   * idle window; any other value was requested and is kept.
   */
  private currentDefaultIdleWindow(sessionTimeoutMs: number): number {
    return sessionTimeoutMs === LEGACY_DEFAULT_SESSION_TIMEOUT_MS
      ? this.SESSION_TIMEOUT_MS
      : sessionTimeoutMs;
  }

  // Intentionally NOT barrier-tracked when reached via the awaited path
  // (getOrCreateSession -> `await recordSessionActivity`): that path is caller-tied,
  // not fire-and-forget, so the DbWriteBarrier deliberately does not cover it. The
  // fire-and-forget callers above wrap this in `getBarrier().track(...)`; the awaited
  // caller must not. See #2885 — do not wrap the awaited call in `track()`.
  private async recordSessionActivity(session: Session): Promise<void> {
    const update = sessionActivityUpdate(session);
    const issued: IssuedActivityWrite = { key: activityUpdateKey(update) };
    this.issuedActivityWrites.set(session, issued);
    try {
      await this.persistSessionActivity(session, update);
    } catch (error) {
      // Forget a failed write only while it is still the newest one, so a later write that
      // carries the same row is not undone; a stale entry only costs one redundant write.
      if (this.issuedActivityWrites.get(session) === issued) {
        this.issuedActivityWrites.delete(session);
      }
      if (error instanceof TerminalSessionError) {
        // Not a storage failure: the session ended, and the caller gets that typed answer.
        throw error;
      }
      throw new SessionActivityPersistenceError(session.sessionId, error);
    }
  }

  /**
   * Write an activity row. When no active row matched (#11129) while this daemon still holds the
   * session — a peer expired it — re-upsert the whole row so the live session stays recoverable. A
   * terminal row is final, whoever wrote it: the upsert refuses, in its statement, to make such a
   * row active again (#11498), and the refusal ends the session here with the row's release. A
   * session this daemon already released has no row to keep.
   */
  private async persistSessionActivity(
    session: Session,
    update: DeviceSessionActivityUpdate,
  ): Promise<void> {
    try {
      await this.deviceSessionRepository.recordActivity(session.sessionId, update);
      return;
    } catch (error) {
      if (!(error instanceof DeviceSessionNotActiveError)) {
        throw error;
      }
    }
    if (!this.isAdmittedForAutomation(session)) {
      // Expected: this daemon's own release retired the row while the write was in flight; the
      // released incarnation has nothing left to persist, and callers detect the release.
      logger.debug(`[SessionManager] Activity for released session ${session.sessionId} skipped`);
      return;
    }
    logger.warn(
      `[SessionManager] Session ${session.sessionId} is live but its row is not active; ` +
        "re-persisting it",
    );
    const repair = this.rePersistSessionActivity(session);
    this.trackReleaseDrainWrite(
      repair.then(
        () => {},
        () => {
          // The activity caller observes the failure; the drain only waits for its writes.
          logger.debug(`[SessionManager] Activity repair settled for ${session.sessionId}`);
        },
      ),
    );
    await repair;
  }

  private async rePersistSessionActivity(session: Session): Promise<void> {
    try {
      // No read decides this: a terminal release can land after any read, and while the upsert
      // awaits its retention prune (this daemon's own release included).
      const writtenDevice = session.assignedDevice;
      await this.activityRowRePersists.run(session, () =>
        this.persistSession(
          session,
          session,
          {
            unlessTerminal: true,
            rewriteOverSupersededRelease: {
              ...this.guardedRowRewriteOptions([], this.persistedRowGenerations.get(session))
                .rewriteOverSupersededRelease!,
              unlessReleased: true,
            },
          },
          () => this.activityRowRePersists.delete(session),
        ),
      );
      if (
        this.isCurrentSession(session) &&
        (this.isRebindUnderWay(session) || session.assignedDevice !== writtenDevice)
      ) {
        // A rebind began while the write was in flight, so the write may have landed over the
        // rebind's row with the binding from before it: owe the row for the binding now held.
        this.oweSupersededRowReassert(session, []);
      } else if (
        this.sessions.get(session.sessionId) !== session &&
        !this.terminalReleaseSnapshots.has(session.sessionId)
      ) {
        // A non-terminal release removed the session while the write was in flight, as it can
        // under a rewrite: the row it left active is released again.
        this.trackReleaseDrainWrite(this.restoreNonTerminalRowAfterReassert(session));
      }
    } catch (error) {
      if (
        !(error instanceof DeviceSessionTerminallyReleasedError) &&
        !(error instanceof DeviceSessionRowNotRewritableError)
      ) {
        throw error;
      }
      await this.handleActivityRowRefusal(session, error);
    }
  }

  private async handleActivityRowRefusal(
    session: Session,
    error: DeviceSessionRowNotRewritableError | DeviceSessionTerminallyReleasedError,
  ): Promise<void> {
    if (!this.isCurrentSession(session)) {
      const terminal = this.terminalReleaseSnapshots.get(session.sessionId);
      if (terminal) {
        throw new TerminalSessionError(session.sessionId, terminal);
      }
      // The old incarnation is retired: neither a retry nor a release of its replacement is owed.
      logger.debug(`[SessionManager] Superseded activity row refused for ${session.sessionId}`);
      return;
    }
    if (await this.reassertOwedLiveRowForActivity(session)) {
      return;
    }
    const terminal = await this.endSessionTerminallyReleasedInRow(session);
    throw terminal instanceof TerminalSessionError ? terminal : error;
  }

  /**
   * The re-persist of a live session found its row terminally released (#11498): the UUID has
   * ended, so the session is not kept in memory behind a row that says otherwise. It is released
   * with the row's own reason (cutting its calls in flight, and returning its device as a lookup
   * that finds an expired session does, because no caller is there to return it), and the typed
   * terminal refusal is resolved for the caller to throw. A session this daemon is already
   * releasing is left to that release.
   */
  private async endSessionTerminallyReleasedInRow(session: Session): Promise<Error> {
    const sessionId = session.sessionId;
    if (this.pendingSupersededRowReasserts.has(sessionId)) {
      // The terminal row is this daemon's own superseded release's, about to be rewritten live
      // (#11206): the session lives on, and only this activity write did not persist.
      return new DeviceSessionNotActiveError(sessionId);
    }
    const persistedRelease = await this.getPersistedTerminalRelease(sessionId);
    if (
      !persistedRelease ||
      this.pendingSupersededRowReasserts.has(sessionId) ||
      this.isSupersededRowReassertOwed(session, persistedRelease)
    ) {
      // The refused row is gone or unreadable (pruned, or a store without lookup), or is being
      // rewritten live, or that rewrite failed and is still owed (#11557): there is no release to
      // adopt, and the activity still did not persist.
      return new DeviceSessionNotActiveError(sessionId);
    }
    const releaseReason = persistedRelease.releaseReason;
    if (this.isAdmittedForAutomation(session)) {
      logger.warn(
        `[SessionManager] Session ${sessionId} is live but its row was terminally released ` +
          `(${releaseReason}); releasing it`,
      );
      if (isTaggedTerminalReleaseReason(releaseReason)) {
        this.cancelExecutionsCutByRelease(sessionId, releaseReason);
      }
      await this.releaseSessionForReason(sessionId, releaseReason, true, undefined, {
        expiryOrigin: "lazy-expiry",
      });
    }
    return new TerminalSessionError(
      sessionId,
      this.terminalReleaseSnapshots.get(sessionId) ?? persistedRelease,
    );
  }

  /** Whether the session's persisted activity fields differ from the newest issued write. */
  private hasUnissuedActivity(session: Session): boolean {
    const issued = this.issuedActivityWrites.get(session);
    return issued?.key !== activityUpdateKey(sessionActivityUpdate(session));
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

/** Only reasons tagged in the release-reason table are terminal, so a match is a known reason. */
function isTaggedTerminalReleaseReason(reason: string): reason is SessionReleaseReason {
  return isTerminalReleaseReason(reason);
}

/** One issued activity write; compared by identity so a newer write is never forgotten. */
interface IssuedActivityWrite {
  key: string;
}

/** The activity row persisted for a session: copied from the session, never computed. */
function sessionActivityUpdate(session: Session): DeviceSessionActivityUpdate {
  return {
    lastUsedAtMs: session.lastUsedAt,
    expiresAtMs: session.expiresAt,
    sessionTimeoutMs: session.sessionTimeoutMs,
    heartbeatTimeoutMs: session.heartbeatTimeoutMs,
    hasReceivedHeartbeat: session.hasReceivedHeartbeat,
    heartbeatTimeoutSource: session.heartbeatTimeoutSource,
    livenessPolicy: session.livenessPolicy,
    preCliHeartbeatTimeoutMs: session.preCliLiveness?.heartbeatTimeoutMs,
    preCliHeartbeatTimeoutSource: session.preCliLiveness?.heartbeatTimeoutSource,
    preCliSessionTimeoutMs: session.preCliLiveness?.sessionTimeoutMs,
  };
}

/** Stable identity of an activity row: the update's fields in declaration order. */
function activityUpdateKey(update: DeviceSessionActivityUpdate): string {
  return JSON.stringify(update);
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
