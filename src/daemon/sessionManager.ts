import type { TimingData } from "../utils/PerformanceTracker";
import { isDeviceLossCancellationReason } from "./emulatorLossIncident";
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
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { defaultTimer, Timer } from "../utils/SystemTimer";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { logger } from "../utils/logger";
import { BootedDevice, Platform } from "../models";
import { KeepScreenAwakeManager, KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import {
  DeviceSessionRepository,
  isDeviceRestartReleaseReason,
  isRecoverableDeviceSession,
  type DeviceSessionPersistence,
} from "../db/deviceSessionRepository";
import type { DeviceSession } from "../db/types";
import { type DbWriteBarrier, getDbWriteBarrier } from "../db/dbWriteBarrier";
import { ActionableError, toActionableError } from "../models/ActionableError";
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
import { errorMessage } from "../utils/describeUnknownError";
import {
  effectiveLastHeartbeat,
  isLivenessOwnerLeaseLive,
  livenessLeaseState,
  sessionLeaseSnapshot,
  sessionOwnerLeaseSnapshot,
  suspectGraceMsFor,
  type LivenessLeaseState,
} from "./livenessOwnerLease";
import { OWNER_DISCONNECTED_RELEASE_REASON } from "./ownerDisconnectRelease";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { DAEMON_SESSION_SUSPECT_CODE } from "./types";

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
   * (#10050). Unset until an owner exists; the lease then falls back to `lastHeartbeat`.
   */
  lastOwnerHeartbeat?: number;
  /**
   * The daemon's own resume point after it detected a stall of its event loop
   * (#10051). Not persisted: the daemon cannot have received heartbeats while it
   * was stalled, so the lease is judged from this point when it is later than
   * `lastHeartbeat`.
   */
  stallForgivenAt?: number;
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
}

interface SessionPersistenceMetadata {
  source: string | null;
  autolockEnabled: boolean;
  mcpSessionId: string | null;
  daemonSessionId: string | null;
}

function rollbackSessionActivityIfCurrent(
  session: Session,
  previousActivity: Pick<Session, "lastUsedAt" | "lastHeartbeat" | "expiresAt">,
  capturedGeneration: number,
): void {
  if (session.activityGeneration !== capturedGeneration) {
    return;
  }
  session.lastUsedAt = previousActivity.lastUsedAt;
  session.lastHeartbeat = previousActivity.lastHeartbeat;
  session.expiresAt = previousActivity.expiresAt;
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
 *   then one every `heartbeatTimeoutMs` (10 s by default).
 * - `cli-idle`: the contract a one-shot `--cli` process can keep. Each
 *   invocation connects, runs one tool and exits, so between calls nobody is
 *   heartbeating; the session is instead reaped only after a wall-clock idle
 *   period measured in minutes, and never for a missing first heartbeat.
 */
export type SessionLivenessPolicy = "heartbeat" | "cli-idle";

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
  return value === "cli-idle" ? "cli-idle" : "heartbeat";
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
  heartbeat: {
    lastHeartbeatMs: number;
    hasReceivedHeartbeat: boolean;
    timeoutMs: number;
    ageMs: number;
  };
}

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
  expiryOrigin?: "lazy-expiry" | "cleanup-expired";
  /** Set by the expiry handler when it owns the ordered device return after release. */
  deviceReleaseManaged?: boolean;
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
  startTime: number;
}

export interface ActiveSessionExecutionQuery {
  startedAtOrBefore?: number;
  excludeExecutionId?: string;
}

export type ActiveSessionExecutionChecker = (
  sessionId: string,
  query?: ActiveSessionExecutionQuery,
) => boolean;

export type SessionDeviceUnboundCallback = (sessionId: string, deviceId: string) => void;

interface PendingSessionCreation {
  promise: Promise<Session>;
}

interface ReleaseReasonState {
  value: string;
  finalizedSnapshot?: SessionReleaseSnapshot;
  lateTerminalRelease?: Promise<string | null>;
  terminalPersisted?: boolean;
}

interface PendingSessionRelease {
  promise: Promise<string | null>;
  reason: ReleaseReasonState;
}

interface SessionReleaseOperation extends PendingSessionRelease {
  session: Session;
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
}

type SessionAccess = "acquire" | "read-only";

interface SessionAcquisitionOptions {
  access?: SessionAccess;
  /** Request-local only; not part of Session or the persistence contract. */
  requestDeadlineMs?: number;
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
  | "identity-continuity-lost";

/**
 * The persisted target cannot be recovered without assigning an unrelated
 * device. SessionManager fences the UUID when this reaches it.
 */
export class SessionRecoveryIdentityLossError extends ActionableError {
  readonly terminalReleaseReason: string;

  constructor(
    readonly sessionUuid: string,
    readonly target: SessionRecoveryTarget,
    readonly reason: SessionRecoveryFailureReason,
  ) {
    const detail =
      reason === "target-busy"
        ? "is already in use"
        : reason === "identity-continuity-lost"
          ? "lost identity continuity"
          : "is unavailable";
    super(
      `Cannot safely recover session ${sessionUuid}: ${target.platform} device ` +
        `'${target.stableDeviceId}' ${detail} (recovery reason: ${reason}). ` +
        "The persisted session is terminal; " +
        "acquire a new device with getAndroid or getApple.",
    );
    this.name = "SessionRecoveryIdentityLossError";
    this.terminalReleaseReason = `identity-recovery-${reason}`;
  }
}

type SessionRecoveryIdentityLoss = Pick<
  SessionRecoveryIdentityLossError,
  "sessionUuid" | "target" | "reason" | "terminalReleaseReason"
>;

function isSessionRecoveryFailureReason(reason: unknown): reason is SessionRecoveryFailureReason {
  return (
    reason === "target-absent" || reason === "target-busy" || reason === "identity-continuity-lost"
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
}

const KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS = 1_000;
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
const SESSION_SETUP_DRAIN_TIMEOUT_MS = 1_000;
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
const MAX_PENDING_NON_TERMINAL_RELEASE_SNAPSHOTS = 256;
export const SESSION_REHYDRATION_DEADLINE_MS = 15_000;
const EXPIRY_RELEASE_REASONS = new Set([
  "lazy-expiry",
  "cleanup-expired",
  "missing-first-heartbeat",
  "heartbeat-timeout",
  "cli-idle-timeout",
  "rehydration-owner-timeout",
]);

class UnissuedSessionError extends ActionableError {}

/**
 * Synchronous commit predicate for a conditional release. Returning `false`
 * abandons the release without removing the session.
 */
export type ReleaseCommitFence = () => boolean;

/** DevicePool may defer or retry automatic release of a retained recovery fence. */
export interface RecoveryExpiryReleaseHandler {
  release(
    sessionId: string,
    releaseReason: string,
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

/** Plan cleanup frees devices while allowing the base and label UUIDs to be reused. */
export const PLAN_AUTO_RELEASE_REASON = "plan-auto-release";

function isTerminalReleaseReason(releaseReason: string): boolean {
  return (
    releaseReason === "explicit-release" ||
    releaseReason === "missing-first-heartbeat" ||
    releaseReason === "heartbeat-timeout" ||
    releaseReason === "cli-idle-timeout" ||
    releaseReason === "rehydration-owner-timeout" ||
    releaseReason === OWNER_DISCONNECTED_RELEASE_REASON ||
    releaseReason === "device-killed" ||
    releaseReason === "session-creation-cancelled" ||
    releaseReason.startsWith("identity-recovery-") ||
    isDeviceLossCancellationReason(releaseReason)
  );
}

export function getDefaultSessionHeartbeatTimeoutMs(): number {
  const rawValue =
    process.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS ??
    process.env.AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS;
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;
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

/** Default grace before a never-heartbeated default-policy session is reaped. */
export const DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS = 5_000;
// Give a restarted emulator the same three-minute cold-boot allowance as device readiness.
const DEVICE_RESTART_RECOVERY_WINDOW_MS = DEFAULT_DEVICE_READY_TIMEOUT_MS;

function restartRecoveryDeadlineFromPersisted(persisted: DeviceSession): number | undefined {
  if (
    !persisted.release_reason ||
    !isDeviceRestartReleaseReason(persisted.release_reason) ||
    persisted.released_at_ms === null
  ) {
    return undefined;
  }
  return Math.min(
    persisted.expires_at_ms,
    persisted.released_at_ms + DEVICE_RESTART_RECOVERY_WINDOW_MS,
  );
}

/**
 * The grace `SessionHeartbeatMonitor` applies before reaping a default-policy
 * session that never sent its first heartbeat. Single-sourced here so the
 * `missing-first-heartbeat` release snapshot reports the deadline that actually
 * fired — the grace, not the (longer) heartbeat timeout — instead of leaving a
 * reader to conclude the daemon reaped early (issue #5689).
 */
export function getDefaultPreFirstHeartbeatGraceMs(): number {
  const rawValue =
    process.env.AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS ??
    process.env.AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS;
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS;
}

export class SessionManager {
  private stallProbe: (() => void) | undefined;
  private sessions: Map<string, Session> = new Map();
  private sessionDeviceMap: Map<string, string> = new Map(); // sessionId -> deviceId
  private deviceSessionMap: Map<string, string> = new Map(); // deviceId -> sessionId (reverse lookup)
  private cleanupTimer: NodeJS.Timeout | null = null;
  private timer: Timer;
  private releaseCallbacks: SessionReleaseCallback[] = [];
  private createdCallbacks: SessionCreatedCallback[] = [];
  private deviceUnboundCallbacks: SessionDeviceUnboundCallback[] = [];
  private readonly deviceOwnershipCallbacks = new Set<
    (deviceId: string, frameInvalidation: "generation-only" | "full") => void
  >();
  private readonly releasePromises: Map<string, SessionReleaseOperation> = new Map();
  /** Every release still running, including an older session that reused a UUID. */
  private readonly activeReleasePromises: Set<SessionReleaseOperation> = new Set();
  /** Finalized release state retained only while its exact Session identity is referenced. */
  private readonly finalizedSessionReleases: WeakMap<Session, ReleaseReasonState> = new WeakMap();
  /** Serializes durable liveness claims within one exact session incarnation. */
  private readonly livenessOwnershipClaimMutexes = new WeakMap<Session, Mutex>();
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
  /** Releases received before an assignment has published its session. */
  private readonly pendingSessionReleases: Map<string, PendingSessionRelease> = new Map();
  /** Rebinds that a release must await before it can remove the live binding. */
  private readonly pendingSessionRebinds: Map<string, PendingSessionRebind> = new Map();
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
  private observerSessions?: Pick<ObserverSessionStore, "release">;

  /** Optional daemon wiring; existing constructors and device-session lookups stay unchanged. */
  setObserverSessionRegistry(registry: Pick<ObserverSessionStore, "release">): void {
    this.observerSessions = registry;
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
        try {
          await raceWithDeadline(restore(), {
            timer: this.timer,
            timeoutMs: restoreTimeoutMs,
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
          // A timed-out command may still be running. Retain the marker and do
          // not issue overlapping retries or let a new session race that command.
          if (error === timeout) {
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

  private activeSessionExecutionChecker: ActiveSessionExecutionChecker = () => false;

  // Session timeout: 30 minutes
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  // Cleanup interval: every 5 minutes
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  static readonly DEFAULT_HEARTBEAT_TIMEOUT_MS = 10 * 1000;

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
    this.deviceSessionRepository = deviceSessionRepository;
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
  getPendingDeviceCleanup(deviceId: string): Promise<void> | null {
    return this.pendingDeviceCleanups.get(deviceId) ?? null;
  }

  /** Wait for the device work that outlived release, without blocking shutdown indefinitely. */
  async drainPendingDeviceCleanups(timeoutMs: number): Promise<boolean> {
    const cleanups = Array.from(this.pendingDeviceCleanups.values());
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
  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>): void {
    this.trackPendingDeviceCleanup(deviceId, [cleanup]);
  }

  /** Release owns the device until both bounded teardown and any overflow work settle. */
  hasDeviceCleanupInProgress(deviceId: string): boolean {
    return (
      this.pendingDeviceCleanups.has(deviceId) ||
      Array.from(this.activeReleasePromises).some(
        (release) => release.session.assignedDevice === deviceId,
      )
    );
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
  ): Promise<Session> {
    getAbortSignal()?.throwIfAborted();
    if (!this.acceptingSessionCreations) {
      throw new DaemonSessionCreationRejectedError(sessionId);
    }
    this.assertTerminalReleaseAdmission(sessionId, this.sessions.get(sessionId));
    let terminalRelease = this.terminalReleaseSnapshots.get(sessionId);
    if (terminalRelease) {
      throw new TerminalSessionError(sessionId, terminalRelease);
    }
    if (this.sessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already exists, returning existing session`);
      return this.sessions.get(sessionId)!;
    }
    const activeReleases = Array.from(this.activeReleasePromises)
      .filter((release) => release.session.sessionId === sessionId)
      .map((release) => release.promise);
    if (activeReleases.length > 0) {
      await Promise.all(activeReleases);
      this.assertTerminalReleaseAdmission(sessionId, this.sessions.get(sessionId));
      terminalRelease = this.terminalReleaseSnapshots.get(sessionId);
      if (terminalRelease) {
        throw new TerminalSessionError(sessionId, terminalRelease);
      }
    }

    const pendingCreation = this.pendingSessionCreations.get(sessionId);
    if (pendingCreation) {
      return await pendingCreation.promise;
    }

    const now = this.timer.now();
    const persistedRecovery = this.pendingPersistedRecoveries.get(sessionId);
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
      ...this.recoverySessionFields(persistedRecovery),
      ...(initialOwnership === "awaiting-owner"
        ? { awaitingOwnerSince: now, hasReceivedHeartbeat: false }
        : {}),
    };

    const creation: PendingSessionCreation = { promise: this.persistAndPublishSession(session) };
    this.pendingSessionCreations.set(sessionId, creation);
    try {
      const created = await creation.promise;
      // Natural point to retry a screen reader an earlier release could not restore.
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

  private async persistAndPublishSession(session: Session): Promise<Session> {
    const persistedTerminalRelease = await this.getPersistedTerminalRelease(session.sessionId);
    if (persistedTerminalRelease) {
      this.terminalReleaseSnapshots.set(session.sessionId, persistedTerminalRelease);
      throw new TerminalSessionError(session.sessionId, persistedTerminalRelease);
    }
    await this.rejectCreationAfterShutdownFence(session);
    await this.persistSession(session);
    await this.rejectCreationAfterShutdownFence(session);
    this.assertTerminalReleaseAdmission(session.sessionId, session);
    const terminalRelease = this.terminalReleaseSnapshots.get(session.sessionId);
    if (terminalRelease) {
      await this.persistSessionRelease(terminalRelease);
      throw new TerminalSessionError(session.sessionId, terminalRelease);
    }
    this.invalidateFinalizedSessionIdentity(session.sessionId);
    this.pendingNonTerminalReleaseSnapshots.delete(session.sessionId);
    this.observerSessions?.release(session.sessionId, "promotion");
    this.sessions.set(session.sessionId, session);
    this.sessionDeviceMap.set(session.sessionId, session.assignedDevice);
    this.deviceSessionMap.set(session.assignedDevice, session.sessionId);
    // Generation only: publishing an owner changes entitlement, not the screen/connection.
    this.notifyDeviceOwnershipChange(session.assignedDevice);
    this.notifySessionCreated(session);
    logger.info(`Created session ${session.sessionId} with device ${session.assignedDevice}`);
    return session;
  }

  private async rejectCreationAfterShutdownFence(session: Session): Promise<void> {
    const cancellation = getAbortSignal();
    if (this.acceptingSessionCreations && !cancellation?.aborted) {
      return;
    }
    const releasedAtMs = this.timer.now();
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
    await this.persistTerminalReleaseIfNeeded(snapshot);
    this.notifySessionRelease(snapshot);
    if (cancellation?.aborted) {
      cancellation.throwIfAborted();
    }
    throw new DaemonSessionCreationRejectedError(session.sessionId, snapshot);
  }

  /** Read-only admission probe; recovery itself remains owned by getOrCreateSession. */
  async isReleasedSessionInRestartRecoveryWindow(sessionId: string): Promise<boolean> {
    if (this.terminalReleaseSnapshots.has(sessionId)) {
      return false;
    }
    const persisted = await this.deviceSessionRepository.getSession?.(sessionId);
    if (
      !persisted ||
      this.terminalReleaseSnapshots.has(sessionId) ||
      !this.isRecoverablePersistedSession(persisted)
    ) {
      return false;
    }
    const deadline = restartRecoveryDeadlineFromPersisted(persisted);
    return deadline !== undefined && this.timer.now() < deadline;
  }

  private async getPersistedTerminalRelease(
    sessionId: string,
  ): Promise<SessionReleaseSnapshot | undefined> {
    const persisted = await this.deviceSessionRepository.getSession?.(sessionId);
    return persisted ? this.terminalReleaseFromPersisted(sessionId, persisted) : undefined;
  }

  /**
   * #6069: True when this persisted row is a non-terminal identity this daemon
   * issued that survived a restart and may be re-materialized with a pooled
   * device (live-during-restart recovery). Mirrors the persisted-recovery
   * admission in {@link admitIssuedSessionForAutomation}. A missing row (never
   * issued) is not recoverable.
   */
  private isRecoverablePersistedSession(persisted: DeviceSession | undefined): boolean {
    return Boolean(
      persisted &&
      (!persisted.release_reason || !isTerminalReleaseReason(persisted.release_reason)) &&
      isRecoverableDeviceSession(persisted, this.timer.now()),
    );
  }

  private async terminalizeExpiredPersistedSession(
    persisted: DeviceSession | undefined,
  ): Promise<void> {
    if (
      persisted &&
      persisted.expires_at_ms <= this.timer.now() &&
      (!persisted.release_reason || !isTerminalReleaseReason(persisted.release_reason))
    ) {
      await this.deviceSessionRepository.markReleased(
        persisted.session_uuid,
        "expired",
        this.timer.now(),
        "expired",
      );
    }
  }

  private terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    if (!persisted.release_reason || !isTerminalReleaseReason(persisted.release_reason)) {
      return undefined;
    }
    const releasedAtMs = persisted.released_at_ms ?? persisted.last_used_at_ms;
    return {
      sessionId,
      deviceId: persisted.device_id,
      releaseReason: persisted.release_reason,
      releasedAtMs,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: persisted.last_used_at_ms,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        // Match the live snapshot: a missing-first-heartbeat reap is governed by
        // the pre-first-heartbeat grace, not the stored heartbeat timeout.
        timeoutMs:
          persisted.release_reason === "missing-first-heartbeat"
            ? getDefaultPreFirstHeartbeatGraceMs()
            : persisted.heartbeat_timeout_ms,
        ageMs: Math.max(0, releasedAtMs - persisted.last_used_at_ms),
      },
    };
  }

  /**
   * Get existing session
   */
  getSession(sessionId: string): Session | null {
    return this.getSessionInternal(sessionId, false);
  }

  /**
   * Resolve a session before a new tool execution is accepted. Existing work may
   * defer expiry cleanup, but it must not let a request that arrived after the
   * deadline revive an expired session.
   */
  getSessionForNewExecution(
    sessionId: string,
    execution?: SessionExecutionMetadata,
  ): Session | null {
    return this.getSessionInternal(sessionId, true, execution);
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
    if (
      expireDespiteActiveExecution &&
      this.isLateExecutionWhileEarlierWorkIsActive(session, execution)
    ) {
      throw new Error(
        `Session ${sessionId} expired before this execution began while earlier work is still active.`,
      );
    }
    if (this.shouldExpireSession(session, expireDespiteActiveExecution, execution)) {
      if (!releaseExpired) {
        return null;
      }
      // Release owns this exact session object until it has restored device state
      // and removed its assignment. Keep expiry cleanup from creating a second
      // incarnation with the same UUID before teardown completes, without
      // exposing the expired session to callers during that teardown.
      if (this.releasingSessions.has(session)) {
        return null;
      }
      logger.info(`Session ${sessionId} has expired, releasing`);
      const release = this.releaseSession(
        sessionId,
        this.expiredSessionReleaseReason(session, "lazy-expiry"),
        true,
        undefined,
        { expiryOrigin: "lazy-expiry" },
      );
      void this.getBarrier()
        .trackExisting(release)
        .catch((error) =>
          logger.warn(`[SessionManager] Failed to release expired session ${sessionId}: ${error}`),
        );
      return null;
    }
    return session;
  }

  private shouldExpireSession(
    session: Session,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
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
    const now = this.timer.now();
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
    if (access === "read-only") {
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
    const { access, requestDeadlineMs } = this.resolveSessionAcquisitionOptions(accessOptions);
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
      this.assertSessionNotSuspect(existing);
      await this.refreshExistingSessionForAccess(existing, access);
      return existing;
    }

    this.assertTerminalReleaseAdmission(sessionId);

    const terminalRelease = this.terminalReleaseSnapshots.get(sessionId);
    if (terminalRelease) {
      throw new TerminalSessionError(sessionId, terminalRelease);
    }

    const inFlightRelease = this.releasePromises.get(sessionId);
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

  /** Preserve the existing access-string API while admitting request-local options. */
  private resolveSessionAcquisitionOptions(options: SessionAccess | SessionAcquisitionOptions): {
    access: SessionAccess;
    requestDeadlineMs?: number;
  } {
    return typeof options === "string"
      ? { access: options }
      : { access: options.access ?? "acquire", requestDeadlineMs: options.requestDeadlineMs };
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
    const pendingAssignment = this.pendingSessionAssignments.get(sessionId);
    if (pendingAssignment) {
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
          ? Math.max(0, requestDeadlineMs - (wait?.responseMarginMs ?? 0) - this.timer.now())
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
          ? requestDeadlineMs - wait.responseMarginMs
          : undefined;
      return await raceWithDeadline(assignment, {
        timer: this.timer,
        timeoutMs:
          deadline !== undefined && deadline < (wait.restartDeadlineMs ?? Infinity)
            ? Math.max(0, deadline - this.timer.now())
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
        const observed = this.getSessionInternal(sessionId, true, execution, false);
        if (observed) {
          this.assertSessionNotSuspect(observed);
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

    const persisted = await this.deviceSessionRepository.getSession?.(sessionId);
    const persistedTerminalRelease =
      persisted && this.terminalReleaseFromPersisted(sessionId, persisted);
    if (persistedTerminalRelease) {
      this.terminalReleaseSnapshots.set(sessionId, persistedTerminalRelease);
      throw new TerminalSessionError(sessionId, persistedTerminalRelease);
    }
    if (persisted && this.isRecoverablePersistedSession(persisted)) {
      return undefined;
    }
    throw unissuedSessionError;
  }

  private async createUnseenSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    requireIssuedSession: boolean,
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    const persisted = await this.deviceSessionRepository.getSession?.(sessionId);
    const persistedTerminalRelease = persisted
      ? this.terminalReleaseFromPersisted(sessionId, persisted)
      : undefined;
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
    if (requireIssuedSession && !this.isRecoverablePersistedSession(persisted)) {
      await this.terminalizeExpiredPersistedSession(persisted);
      throw new UnissuedSessionError(
        `Session ${sessionId} is not an active daemon session (not found). ` +
          "Acquire a device with getAndroid or getApple before using its sessionUuid.",
      );
    }
    // Need to create new session - assign device from pool
    if (!devicePool) {
      throw new UnissuedSessionError(
        `Session ${sessionId} is not an active daemon session (not found). ` +
          "Acquire a device with getAndroid or getApple before using its sessionUuid.",
      );
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
    persisted: DeviceSession | undefined,
    initialOwnership: "owned" | "awaiting-owner",
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    const recoveryTarget = await this.recoveryTargetFromPersisted(sessionId, persisted, platform);
    if (recoveryTarget && initialOwnership === "awaiting-owner") {
      recoveryTarget.initialOwnership = initialOwnership;
    }
    logger.info(
      `[SessionManager] Creating new session ${sessionId}, calling devicePool.assignDeviceToSession()`,
    );
    if (persisted && recoveryTarget) {
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
        this.timer.now() < recoveryTarget.restartRecoveryDeadlineMs
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
      throw new Error(`Session ${sessionId} creation failed after device assignment`);
    }
    logger.info(
      `[SessionManager] Successfully created session ${sessionId} with device ${session.assignedDevice}`,
    );
    return session;
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
    options: { deadlineMs?: number } = {},
  ): Promise<RehydrationSummary> {
    const deadlineMs = options.deadlineMs ?? SESSION_REHYDRATION_DEADLINE_MS;
    const deadlineAt = this.timer.now() + deadlineMs;
    const summary: RehydrationSummary = {
      rehydrated: [],
      terminalized: [],
      skipped: [],
      timedOut: false,
    };
    const persistedSessions = await this.listRecoverableSessionsBeforeDeadline(deadlineAt, summary);
    const markDeadline = (startIndex: number): void => {
      for (const remaining of persistedSessions.slice(startIndex)) {
        const sessionId = remaining.session_uuid;
        if (!this.isRecoverablePersistedSession(remaining)) {
          summary.skipped.push({ sessionUuid: sessionId, reason: "not-recoverable" });
        } else if (this.sessions.has(sessionId)) {
          summary.skipped.push({ sessionUuid: sessionId, reason: "already-live" });
        } else {
          summary.skipped.push({ sessionUuid: sessionId, reason: "startup-deadline" });
        }
      }
      if (!summary.timedOut) {
        summary.timedOut = true;
        const skippedCount = summary.skipped.filter(
          ({ reason }) => reason === "startup-deadline",
        ).length;
        logger.warn(
          `[SessionManager] Startup rehydration deadline reached; skipped ${skippedCount} rows due to startup-deadline`,
        );
      }
    };
    const recoveryDeadlineWon = Symbol("startup-deadline");
    for (const [index, persisted] of persistedSessions.entries()) {
      const sessionId = persisted.session_uuid;
      if (!this.isRecoverablePersistedSession(persisted)) {
        summary.skipped.push({ sessionUuid: sessionId, reason: "not-recoverable" });
        continue;
      }
      const skipReason = this.rehydrationSkipReason(sessionId);
      if (skipReason) {
        summary.skipped.push({ sessionUuid: sessionId, reason: skipReason });
        continue;
      }
      if (this.timer.now() >= deadlineAt) {
        markDeadline(index);
        break;
      }
      try {
        const recoveryPromise = this.registerRehydrationRecovery(sessionId, devicePool, persisted);
        const remaining = Math.max(0, deadlineAt - this.timer.now());
        const recoveryResult = await raceWithDeadline(recoveryPromise, {
          timer: this.timer,
          timeoutMs: remaining,
          label: "Session rehydration",
          timeoutError: () => recoveryDeadlineWon,
        }).catch((error: unknown) => {
          if (error !== recoveryDeadlineWon) {
            throw error;
          }
          return recoveryDeadlineWon;
        });
        if (recoveryResult === recoveryDeadlineWon) {
          void recoveryPromise.catch((error) =>
            logger.warn(
              `[SessionManager] Rehydration continued after startup deadline for ${sessionId}: ${errorMessage(error)}`,
            ),
          );
          markDeadline(index);
          break;
        }
        summary.rehydrated.push(sessionId);
      } catch (error) {
        const terminalRelease = this.getTerminalReleaseSnapshot(sessionId);
        if (terminalRelease) {
          summary.terminalized.push({
            sessionUuid: sessionId,
            reason: terminalRelease.releaseReason,
          });
        } else {
          const reason = errorMessage(error);
          logger.warn(`[SessionManager] Failed to rehydrate session ${sessionId}: ${reason}`);
          summary.skipped.push({ sessionUuid: sessionId, reason });
        }
      }
    }
    logger.info(
      `[SessionManager] Rehydration: ${summary.rehydrated.length} rehydrated, ` +
        `${summary.terminalized.length} terminalized, ${summary.skipped.length} skipped`,
    );
    return summary;
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
        daemonSessionId: persisted.daemon_session_id,
      },
      ...(persisted.liveness_owner_token
        ? {
            livenessOwnerToken: persisted.liveness_owner_token,
            livenessOwnershipClaims: new Set([persisted.liveness_owner_token]),
            lastOwnerHeartbeat: this.timer.now(),
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
      this.deviceSessionRepository.listRecoverableSessions?.() ?? Promise.resolve([]);
    let result: typeof deadlineWon | DeviceSession[];
    try {
      result = await raceWithDeadline(recoverableSessions, {
        timer: this.timer,
        timeoutMs: Math.max(0, deadlineAt - this.timer.now()),
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
        persisted &&
        isSessionRecoveryIdentityLossError(error) &&
        error.sessionUuid === sessionId
      ) {
        await this.terminalizePersistedRecoveryFailure(sessionId, persisted, error);
      }
      throw error;
    }
  }

  private async terminalizePersistedRecoveryFailure(
    sessionId: string,
    persisted: DeviceSession,
    error: Pick<SessionRecoveryIdentityLossError, "terminalReleaseReason">,
  ): Promise<void> {
    const releasedAtMs = this.timer.now();
    await this.persistTerminalReleaseIfNeeded({
      sessionId,
      deviceId: persisted.device_id,
      releaseReason: error.terminalReleaseReason,
      releasedAtMs,
      terminal: true,
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

    const promise = this.persistAndPublishRebind(
      existing,
      assignedDevice,
      platform,
      options.stableDeviceId ?? existing.stableDeviceId,
    );
    const rebind = { session: existing, promise };
    this.pendingSessionRebinds.set(sessionId, rebind);
    try {
      return await promise;
    } finally {
      if (this.pendingSessionRebinds.get(sessionId) === rebind) {
        this.pendingSessionRebinds.delete(sessionId);
      }
    }
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
      );
    });
    const pendingKeepScreenAwakeRestoration = (
      await this.restoreKeepScreenAwakeBestEffort(existing)
    ).pending;
    // Same contract as release: a failed restore must not hand the old
    // simulator back to the pool clean. Any outstanding retry is registered
    // against that device below, so DevicePool.releaseDevice defers idling it.
    const pendingBiometricRestoration = (await this.restoreBiometricEnrollmentBestEffort(existing))
      .pending;
    // Rebind restores the old device to `none` here, so cancel any standalone TTL
    // for this session — it must not later fire against the now-released old
    // device (issue #6085 item 2).
    this.cancelNetworkConditionExpiry(existing.sessionId);
    this.iosAppNetworkLeases.stop(existing.sessionId);
    const networkTarget = this.networkConditionRestoreTarget(existing);
    const pendingNetworkRestoration = networkTarget
      ? ((
          await this.runUnderTeardownShield(async () => [
            {
              ...(await this.restoreNetworkConditionBestEffort(existing)),
              abandon: () => this.abandonCappedRestore(networkTarget, "network-condition"),
            },
          ])
        )[0] ?? null)
      : null;

    const pendingClockRestoration = existing.cacheData.clock
      ? (await this.getPendingClockRestoration(existing, null)).pending
      : null;
    const pendingRotationRestoration = existing.cacheData.rotation
      ? (await this.getPendingRotationRestoration(existing, null)).pending
      : null;
    const pendingScreenReaderRestoration = existing.cacheData.screenReader
      ? (await this.getPendingScreenReaderRestoration(existing, null)).pending
      : null;
    const previousDevice = existing.assignedDevice;
    const pendingRebindCleanup = [
      pendingKeepScreenAwakeRestoration,
      pendingBiometricRestoration,
      pendingNetworkRestoration,
      pendingClockRestoration,
      pendingRotationRestoration,
      pendingScreenReaderRestoration,
    ].filter((cleanup): cleanup is Promise<void> => cleanup !== null);
    if (pendingRebindCleanup.length > 0) {
      this.trackPendingDeviceCleanup(previousDevice, pendingRebindCleanup);
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

  getTerminalReleaseSnapshot(sessionId: string): SessionReleaseSnapshot | undefined {
    const snapshot = this.terminalReleaseSnapshots.get(sessionId);
    return snapshot ? { ...snapshot, heartbeat: { ...snapshot.heartbeat } } : undefined;
  }

  /** Prevent this exact session UUID from being rebound while its device shutdown is in flight. */
  reserveSessionForTerminalRelease(session: Session, expectedDeviceId: string): () => void {
    if (session.assignedDevice !== expectedDeviceId) {
      throw new Error(`Session ${session.sessionId} no longer owns device ${expectedDeviceId}.`);
    }
    if (this.pendingSessionRebinds.has(session.sessionId)) {
      throw new Error(
        `Session ${session.sessionId} is rebinding devices; retry shutdown after it settles.`,
      );
    }
    const existing = this.terminalReleaseReservations.get(session.sessionId);
    if (existing) {
      throw new Error(`Session ${session.sessionId} is already reserved for terminal release.`);
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
      throw new Error(
        `Session ${sessionId} is being terminally released from device ${reservation.deviceId}; use a new session UUID.`,
      );
    }
  }

  private assertTerminalRebindAdmission(
    sessionId: string,
    reservationOwner: symbol | undefined,
  ): void {
    const reservation = this.terminalReleaseReservations.get(sessionId);
    if (reservation && reservation.owner !== reservationOwner) {
      throw new Error(
        `Session ${sessionId} is being terminally released from device ${reservation.deviceId}; use a new session UUID.`,
      );
    }
  }

  /**
   * Get session assigned to a device (reverse lookup)
   */
  getSessionForDevice(deviceId: string): string | null {
    return this.deviceSessionMap.get(deviceId) ?? null;
  }

  /** Map membership, including fenced releases and any newer same-UUID incarnation. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
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
  async releaseSession(
    sessionId: string,
    releaseReason: string = "explicit-release",
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
    if (EXPIRY_RELEASE_REASONS.has(releaseReason)) {
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
        : this.getSession(sessionId);
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
    const promise =
      pendingRebind?.session === session
        ? pendingRebind.promise.then(
            () => this.releaseSessionInternal(sessionId, session, reason, shouldCommit, options),
            () => this.releaseSessionInternal(sessionId, session, reason, shouldCommit, options),
          )
        : this.releaseSessionInternal(sessionId, session, reason, shouldCommit, options);
    const release = { session, promise, reason };
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
    releaseReason: string,
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
    releaseReason: string = "explicit-release",
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
    const inFlightRelease = this.releasePromises.get(sessionId);
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
      const persisted = await this.deviceSessionRepository.getSession?.(sessionId);
      const deadline = persisted && restartRecoveryDeadlineFromPersisted(persisted);
      if (
        persisted &&
        this.isRecoverablePersistedSession(persisted) &&
        deadline !== undefined &&
        this.timer.now() < deadline
      ) {
        const snapshot = this.terminalReleaseFromPersisted(sessionId, {
          ...persisted,
          // Use the existing terminal recovery namespace without making
          // ordinary superseded releases terminal outside restart recovery.
          release_reason:
            releaseReason === "superseded" ? "identity-recovery-superseded" : releaseReason,
          released_at_ms: this.timer.now(),
        })!;
        await this.persistTerminalReleaseIfNeeded(snapshot);
        this.notifySessionRelease(snapshot);
        return snapshot.deviceId;
      }
    }
    logger.warn(`Cannot release session ${sessionId}: not found`);
    return null;
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
      await pendingSession;
      return await this.releaseSession(sessionId, reason.value, allowExpired);
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
    const releases = [
      ...Array.from(this.activeReleasePromises, (release) => release.promise),
      ...additionalReleases,
    ];
    try {
      if (releases.length === 0) {
        return true;
      }
      const deadline = new Error("Release drain timed out");
      try {
        return await raceWithDeadline(
          Promise.allSettled(releases).then(() => true),
          {
            timer: this.timer,
            timeoutMs,
            label: "Release drain",
            timeoutError: () => deadline,
          },
        );
      } catch (error) {
        if (error === deadline) {
          return false;
        }
        throw error;
      }
    } finally {
      this.pendingNonTerminalReleaseSnapshots.clear();
    }
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
  ): Promise<string | null> {
    try {
      // Release restores the device to `none` itself, so a standalone TTL is now
      // redundant — cancel it first so the two restore paths cannot both fire
      // (issue #6085 item 2). Whichever runs first (this release, or the TTL that
      // already cleared the slot) wins.
      this.cancelNetworkConditionExpiry(sessionId);
      // Release removes the iOS app rule itself; stop renewing it first.
      this.iosAppNetworkLeases.stop(sessionId);
      const pendingCleanup = await this.drainReleaseTeardown(sessionId, session);
      const deviceId = session.assignedDevice;
      // Setup/restoration awaits above are where a newer identity confirmation
      // can overtake a device-loss eviction. Fence before the terminal snapshot
      // is persisted so a declined release leaves no terminal trace behind.
      if (releaseSuperseded(shouldCommit)) {
        return this.abandonSupersededRelease(sessionId, deviceId, pendingCleanup);
      }
      const releasedAtMs = this.timer.now();
      const releaseReason = reason.value;
      const terminalFenceHeldBefore = this.terminalReleaseSnapshots.has(sessionId);
      let releaseSnapshot: SessionReleaseSnapshot = {
        sessionId,
        deviceId,
        releaseReason,
        releasedAtMs,
        terminal: isTerminalReleaseReason(releaseReason),
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

      // A non-terminal release must not yield after freezing its reason: a
      // concurrent terminal release can only upgrade the shared reason while
      // this operation is awaiting teardown above.
      if (releaseSnapshot.terminal) {
        releaseSnapshot = await this.persistTerminalReleaseWithUpgrade(
          releaseSnapshot,
          reason,
          session,
        );
      }
      // Final fence: evaluated synchronously right before the commit, with no
      // await in between, so the persistence awaits above cannot hide a newer
      // confirmation either. A terminal fence this release raised is lifted so
      // the live session keeps routing; the persisted row is rewritten by
      // whichever release eventually commits.
      if (releaseSuperseded(shouldCommit)) {
        return this.abandonSupersededRelease(
          sessionId,
          deviceId,
          pendingCleanup,
          !terminalFenceHeldBefore,
        );
      }
      if (!this.removeSession(sessionId, session)) {
        if (pendingCleanup.length > 0) {
          this.trackPendingDeviceCleanup(deviceId, pendingCleanup);
        }
        logger.warn(`Skipping release finalization for ${sessionId}: session ownership changed`);
        return null;
      }
      if (pendingCleanup.length > 0) {
        this.trackPendingDeviceCleanup(deviceId, pendingCleanup);
      }
      if (!releaseSnapshot.terminal) {
        this.terminalReleaseSnapshots.delete(sessionId);
        this.terminalReleaseReasonStates.delete(sessionId);
      }

      this.notifySessionRelease(releaseSnapshot, options);
      let persistedSnapshot: SessionReleaseSnapshot;
      try {
        persistedSnapshot = await this.completeReleasePersistence(releaseSnapshot, reason, session);
      } catch (error) {
        // Removal committed before persistence. Retain its identity and reason
        // while the pending release snapshot is retried by the recovery owner.
        reason.finalizedSnapshot ??= releaseSnapshot;
        this.recordFinalizedSessionRelease(session, reason);
        throw toActionableError(error, `Failed to finalize session ${sessionId} release`);
      }
      this.recordFinalizedSessionRelease(session, reason);
      if (persistedSnapshot !== releaseSnapshot) {
        this.notifySessionRelease(persistedSnapshot, options);
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
  ): Promise<readonly Promise<void>[]> {
    if (!this.releaseNeedsTeardown(session)) {
      return [];
    }
    return this.runUnderTeardownShield(() => this.startReleaseTeardown(sessionId, session));
  }

  /** Own the restore signal until all stages settle, bounded by the shared teardown cap. */
  private async runUnderTeardownShield(
    start: () => Promise<readonly ReleaseTeardownStage[]>,
  ): Promise<readonly Promise<void>[]> {
    const shield = new AbortController();
    const startedAtMs = this.timer.now();
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
      timeoutMs: Math.max(0, SESSION_RELEASE_TEARDOWN_CAP_MS - (this.timer.now() - startedAtMs)),
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
  ): Promise<readonly ReleaseTeardownStage[]> {
    // Captured before any await: a rebind reassigns `session.assignedDevice`.
    const deviceId = session.assignedDevice;
    const biometricTarget = this.biometricRestoreTarget(session);
    const networkTarget = this.networkConditionRestoreTarget(session);
    const setups = Array.from(this.sessionSetupPromises, (setup) =>
      setup.session === session ? setup.promise : null,
    ).filter((setup): setup is Promise<void> => setup !== null);
    const pendingSetups =
      setups.length > 0 ? (await this.waitForSessionSetup(sessionId, setups)).pending : null;
    const pendingRestoration = (await this.restoreKeepScreenAwakeBestEffort(session)).pending;
    const pendingBiometricRestoration = session.cacheData.biometricEnrollment
      ? (await this.getPendingBiometricRestoration(session, pendingSetups)).pending
      : null;
    const pendingNetworkRestoration = session.cacheData.networkCondition
      ? (await this.getPendingNetworkRestoration(session, pendingSetups)).pending
      : null;
    // The remaining restorers carry their own budgets and abandon mechanisms and are
    // not bound to the teardown cap, so they must not inherit its shield either; the
    // toggles they drive resolve the ambient signal themselves (#10159).
    const ownBudget = <T>(start: () => Promise<T>) => runWithAbortSignal(undefined, start);
    const pendingClockRestoration = session.cacheData.clock
      ? (await ownBudget(() => this.getPendingClockRestoration(session, pendingSetups))).pending
      : null;
    const pendingRotationRestoration = session.cacheData.rotation
      ? (await ownBudget(() => this.getPendingRotationRestoration(session, pendingSetups))).pending
      : null;
    const ownScreenReaderRestoration = session.cacheData.screenReader
      ? (await ownBudget(() => this.getPendingScreenReaderRestoration(session, pendingSetups)))
          .pending
      : null;
    const pendingScreenReaderRestoration = this.abandonedScreenReaders.has(session.assignedDevice)
      ? ownBudget(() =>
          this.retryAbandonedScreenReaderAfter(session.assignedDevice, ownScreenReaderRestoration),
        )
      : ownScreenReaderRestoration;
    return [
      { pending: pendingSetups },
      {
        pending: pendingRestoration,
        abandon: () =>
          logger.warn(
            `Gave up restoring keep-awake state on ${deviceId} after ${SESSION_RELEASE_TEARDOWN_CAP_MS}ms; ` +
              `the screen may stay awake until the next session changes it`,
          ),
      },
      {
        pending: pendingBiometricRestoration,
        abandon: () => this.abandonCappedRestore(biometricTarget, "biometric-enrollment"),
      },
      {
        pending: pendingNetworkRestoration,
        abandon: () => this.abandonCappedRestore(networkTarget, "network-condition"),
      },
      { pending: pendingClockRestoration },
      { pending: pendingRotationRestoration },
      { pending: pendingScreenReaderRestoration },
    ];
  }

  /** The teardown budget ran out with this restore unfinished: record it like an exhausted retry. */
  private abandonCappedRestore(
    target: BiometricRestoreTarget | NetworkConditionRestoreTarget | null,
    reason: "biometric-enrollment" | "network-condition",
  ): void {
    if (!target) {
      return;
    }
    logger.warn(
      `Session release teardown exceeded ${SESSION_RELEASE_TEARDOWN_CAP_MS}ms before the ${reason} ` +
        `restore finished on ${target.deviceId}; the device may hold session-modified state`,
    );
    this.abandonRestore(target, reason, () =>
      "enrollment" in target
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

  private abandonSupersededRelease(
    sessionId: string,
    deviceId: string,
    pendingCleanup: readonly Promise<void>[],
    liftTerminalFence: boolean = false,
  ): null {
    if (liftTerminalFence) {
      this.terminalReleaseSnapshots.delete(sessionId);
    }
    if (pendingCleanup.length > 0) {
      this.trackPendingDeviceCleanup(deviceId, pendingCleanup);
    }
    logger.info(
      `Skipping release of ${sessionId}: a newer identity confirmation superseded the eviction of ${deviceId}`,
    );
    return null;
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
    if (!isTerminalReleaseReason(reason.value) && isTerminalReleaseReason(candidate)) {
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
    session: Session,
  ): SessionReleaseSnapshot {
    return {
      ...snapshot,
      releaseReason,
      terminal: isTerminalReleaseReason(releaseReason),
      heartbeat: {
        ...snapshot.heartbeat,
        timeoutMs: this.releaseHeartbeatTimeoutMs(releaseReason, session),
      },
    };
  }

  private async completeReleasePersistence(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
  ): Promise<SessionReleaseSnapshot> {
    if (snapshot.terminal) {
      reason.finalizedSnapshot = snapshot;
      reason.terminalPersisted = true;
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
    let upgradedSnapshot: SessionReleaseSnapshot = {
      ...snapshot,
      releaseReason: reason.value,
      terminal: true,
    };
    reason.finalizedSnapshot = upgradedSnapshot;
    reason.terminalPersisted = false;
    this.terminalReleaseReasonStates.set(upgradedSnapshot.sessionId, reason);
    const release = (async () => {
      await this.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      if (reason.value !== upgradedSnapshot.releaseReason) {
        upgradedSnapshot = {
          ...upgradedSnapshot,
          releaseReason: reason.value,
        };
        reason.finalizedSnapshot = upgradedSnapshot;
        this.terminalReleaseReasonStates.set(upgradedSnapshot.sessionId, reason);
        await this.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      }
      reason.terminalPersisted = true;
      this.notifySessionRelease(upgradedSnapshot);
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
  ): Promise<boolean> {
    // A resumed UUID can be in flight before it publishes. Check immediately
    // before issuing a retry so it cannot release the newly active row.
    if (retryPending && this.isSessionBeingRecreated(snapshot.sessionId)) {
      this.pendingNonTerminalReleaseSnapshots.delete(snapshot.sessionId);
      return false;
    }
    try {
      const terminalStatus = EXPIRY_RELEASE_REASONS.has(snapshot.releaseReason)
        ? "expired"
        : "released";
      await this.deviceSessionRepository.markReleased(
        snapshot.sessionId,
        terminalStatus,
        snapshot.releasedAtMs,
        snapshot.releaseReason,
      );
      if (this.pendingNonTerminalReleaseSnapshots.get(snapshot.sessionId) === snapshot) {
        this.pendingNonTerminalReleaseSnapshots.delete(snapshot.sessionId);
      }
      return true;
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to mark session released (${snapshot.releaseReason}): ${error}`,
      );
      if (!snapshot.terminal && !this.sessions.has(snapshot.sessionId)) {
        this.recordPendingNonTerminalRelease(snapshot);
      }
      if (this.shouldSurfaceReleasePersistenceFailure(snapshot, retryPending)) {
        throw toActionableError(
          error,
          `Failed to persist ${snapshot.terminal ? "terminal" : "non-terminal"} release for session ${snapshot.sessionId}`,
        );
      }
      return false;
    }
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
  ): Promise<{ pending: Promise<void> | null }> {
    if (!session.cacheData.keepScreenAwake?.applied) {
      return { pending: null };
    }
    const restoration = this.restoreKeepScreenAwake(session).then(
      () => ({ outcome: "restored" as const }),
      (error) => ({ outcome: "failed" as const, error }),
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
    } else if (result.outcome === "timed-out") {
      logger.warn(
        `Timed out after ${KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS}ms restoring keep-awake state for session ${session.sessionId}`,
      );
      return { pending: restoration.then(() => undefined) };
    }
    return { pending: null };
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
      timeoutMs: NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
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
    const { userRotation, accelerometerRotation } = target.state;
    logger.warn(
      `Gave up restoring rotation settings on ${deviceId} ${when} ` +
        `(user_rotation=${userRotation ?? "unchanged"}, accelerometer_rotation=${accelerometerRotation ?? "unchanged"} ` +
        `not confirmed: ${errorMessage(lastError)}); releasing the device from cleanup. ` +
        `A fold or display change during the session can make the recorded settings unverifiable.`,
    );
    target.clear();
    const targets = this.pendingRotationRestores.get(deviceId);
    if (targets?.get(target.state) === target) {
      targets.delete(target.state);
      if (targets.size === 0) {
        this.pendingRotationRestores.delete(deviceId);
      }
    }
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
      Math.floor(this.timer.now()),
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
      this.timer.now() + effectiveSeconds * 1000,
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
    const remainingMs = Math.max(0, deadlineMs - this.timer.now());
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
    const previous = this.pendingDeviceCleanups.get(deviceId);
    const cleanup = Promise.allSettled(previous ? [previous, ...cleanups] : cleanups).then(
      () => undefined,
    );
    this.pendingDeviceCleanups.set(deviceId, cleanup);
    void cleanup.then(() => {
      if (this.pendingDeviceCleanups.get(deviceId) === cleanup) {
        this.pendingDeviceCleanups.delete(deviceId);
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
    const previousActivity = {
      lastUsedAt: session.lastUsedAt,
      lastHeartbeat: session.lastHeartbeat,
      expiresAt: session.expiresAt,
    };
    session.lastUsedAt = this.timer.now();
    session.lastHeartbeat = this.timer.now();
    session.activityGeneration++;
    const capturedGeneration = session.activityGeneration;
    void this.getBarrier()
      .track(() => this.recordSessionActivity(session))
      .catch((error) => {
        rollbackSessionActivityIfCurrent(session, previousActivity, capturedGeneration);
        logger.warn(`[SessionManager] Failed to record session activity: ${error}`);
      });

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
      lastObserveTime: this.timer.now(),
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
    this.updateSessionCache(sessionId, { deviceLabels: labels });
  }

  /**
   * Read the device-label map without recording session activity (issue #3053):
   * label routing reads this on every `device:`-labelled request, so it must not
   * fire a session-activity write per read. Returns `undefined` for an
   * unknown/expired session or a session with no registered labels.
   */
  getDeviceLabels(sessionId: string): DeviceLabelMap | undefined {
    return this.getSession(sessionId)?.cacheData.deviceLabels;
  }

  /**
   * Get session cache data
   */
  getSessionCache(sessionId: string): SessionCacheData | null {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    // Update last used time when accessing cache
    const previousActivity = {
      lastUsedAt: session.lastUsedAt,
      lastHeartbeat: session.lastHeartbeat,
      expiresAt: session.expiresAt,
    };
    session.lastUsedAt = this.timer.now();
    session.lastHeartbeat = this.timer.now();
    session.activityGeneration++;
    const capturedGeneration = session.activityGeneration;
    void this.getBarrier()
      .track(() => this.recordSessionActivity(session))
      .catch((error) => {
        rollbackSessionActivityIfCurrent(session, previousActivity, capturedGeneration);
        logger.warn(`[SessionManager] Failed to record session activity: ${error}`);
      });

    return session.cacheData;
  }

  /**
   * Record a liveness heartbeat for a session.
   *
   * A heartbeat proves the owner process is alive; it is not device use (#10656). It renews the
   * owner lease (`lastHeartbeat`, `lastOwnerHeartbeat`), marks the session as heartbeating, and
   * promotes an awaiting-owner session to owned. It must never write the tool-activity clocks
   * (`lastUsedAt`, `expiresAt`): an idle but live owner — a stdio proxy whose keeper ticks every
   * 5 s while its agent makes no tool calls — would otherwise hold its device forever. Only tool
   * calls (`getOrCreateSession`) move the idle deadline. Guarded by
   * `test/lint/livenessActivityClockSeparation.test.ts` (#10668).
   */
  recordHeartbeat(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      logger.warn(`Cannot record heartbeat for session ${sessionId}: not found`);
      return;
    }
    if (!this.isAdmittedForAutomation(session)) {
      return;
    }
    const now = this.timer.now();
    const previousLiveness = {
      lastHeartbeat: session.lastHeartbeat,
      lastOwnerHeartbeat: session.lastOwnerHeartbeat,
      hasReceivedHeartbeat: session.hasReceivedHeartbeat,
      ownership: session.ownership,
      awaitingOwnerSince: session.awaitingOwnerSince,
    };
    session.lastHeartbeat = now;
    // Only a heartbeat advances the owner lease; both the socket and HTTP routes admit one only
    // from the owner (or a tokenless client on a session no proxy owns).
    session.lastOwnerHeartbeat = now;
    session.activityGeneration++;
    const capturedGeneration = session.activityGeneration;
    session.hasReceivedHeartbeat = true;
    if (session.ownership === "awaiting-owner") {
      session.ownership = "owned";
      session.awaitingOwnerSince = undefined;
    }
    void this.getBarrier()
      .track(() => this.recordSessionActivity(session))
      .catch((error) => {
        if (session.activityGeneration === capturedGeneration) {
          Object.assign(session, previousLiveness);
        }
        logger.warn(
          `[SessionManager] Failed to record session activity: ${errorMessage(error)}`,
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
   */
  async claimLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<LivenessClaimOutcome> {
    const session = this.getSession(sessionId);
    if (!session) {
      logger.warn(`Cannot claim liveness ownership for session ${sessionId}: not found`);
      return "not-found";
    }
    const mutex = this.livenessOwnershipClaimMutexFor(session);
    return await mutex.runExclusive(async () => {
      if (this.getSession(sessionId) !== session) {
        return "not-found";
      }
      return await this.claimLivenessOwnershipForSession(session, ownerToken);
    });
  }

  /** Clear only the owner token; preserve the device, policy and existing lease/grace deadline. */
  async releaseLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<LivenessReleaseOutcome> {
    const session = this.getSession(sessionId);
    if (!session || !this.isAdmittedForAutomation(session)) {
      return "not-found";
    }
    return await this.livenessOwnershipClaimMutexFor(session).runExclusive(async () => {
      if (this.getSession(sessionId) !== session || !this.isAdmittedForAutomation(session)) {
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
      session.livenessOwnerToken = undefined;
      // Fence an older heartbeat write's failure rollback across the handoff.
      session.activityGeneration++;
      try {
        await this.deviceSessionRepository.recordLivenessOwnership?.(sessionId, null);
      } catch (error) {
        session.livenessOwnerToken = ownerToken;
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

  private async claimLivenessOwnershipForSession(
    session: Session,
    ownerToken: string,
  ): Promise<LivenessClaimOutcome> {
    const processedClaims = session.livenessOwnershipClaims ?? new Set<string>();
    session.livenessOwnershipClaims = processedClaims;
    if (session.livenessOwnerToken !== undefined && processedClaims.has(ownerToken)) {
      // A retried claim whose token has since been displaced must never take
      // the session back, whatever the new owner's lease says.
      return session.livenessOwnerToken === ownerToken ? "claimed" : "superseded";
    }
    const previousOwnerToken = session.livenessOwnerToken;
    if (this.isForeignLiveOwner(session, ownerToken)) {
      logger.warn(
        `Rejected liveness ownership claim for session ${session.sessionId}: another owner holds a live lease`,
      );
      return "conflict";
    }
    const previousOwnerHeartbeat = session.lastOwnerHeartbeat;
    const alreadyProcessed = processedClaims.has(ownerToken);
    processedClaims.add(ownerToken);
    session.livenessOwnerToken = ownerToken;
    // Stamp the lease in the same step as the takeover, still inside the claim mutex. The
    // request handler records the claimant's heartbeat several awaits later; until then a second
    // foreign claimant would read the previous, lapsed lease and displace this one (#10050).
    session.lastOwnerHeartbeat = this.timer.now();
    try {
      await this.persistNewLivenessOwnershipClaim(
        session,
        ownerToken,
        { previousOwnerToken, previousOwnerHeartbeat },
        processedClaims,
      );
    } catch (error) {
      if (alreadyProcessed) {
        processedClaims.add(ownerToken);
      }
      throw error;
    }
    return "claimed";
  }

  /** Whether a different token owns `session` and its lease is still live. */
  private isForeignLiveOwner(session: Session, ownerToken: string): boolean {
    if (session.livenessOwnerToken === undefined || session.livenessOwnerToken === ownerToken) {
      return false;
    }
    // The owner's own heartbeats decide this, not tool activity by whoever else names the session.
    return isLivenessOwnerLeaseLive(sessionOwnerLeaseSnapshot(session, this.timer.now()));
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
    return livenessLeaseState(sessionLeaseSnapshot(session, this.timer.now()));
  }

  /** Whether the session is inside its suspect window (lease expired, grace running). */
  private isSessionSuspect(session: Session): boolean {
    return (
      session.livenessPolicy === "heartbeat" &&
      livenessLeaseState(sessionLeaseSnapshot(session, this.timer.now())).phase === "suspect"
    );
  }

  /** Reject a tool call against a suspect session; only its owner's heartbeat restores it. */
  private assertSessionNotSuspect(session: Session): void {
    if (this.isSessionSuspect(session)) {
      const { remainingMs } = livenessLeaseState(sessionLeaseSnapshot(session, this.timer.now()));
      throw new SessionSuspectError(session.sessionId, remainingMs);
    }
  }

  /**
   * Register the detector that applies {@link forgiveDaemonStall} for a stall the monitor has not
   * yet noticed. Every expiry judgement (lookup, sweep) runs it first, so which timer fires first
   * after a stall or wake no longer decides the outcome. Pass undefined to detach.
   */
  setStallProbe(probe: (() => void) | undefined): void {
    this.stallProbe = probe;
  }

  /**
   * Do not hold the daemon's own stall against any session (#10051).
   *
   * Called by the heartbeat monitor when its tick fired later than scheduled: the daemon cannot
   * have received heartbeats while its event loop was stalled. Each non-CLI session's lease is
   * moved forward by exactly the lost interval (`lostMs`), never past `resumedAt`, so the stalled
   * time is not counted against the owner while time the owner genuinely missed before the stall
   * still is. A stall at least as long as the session's idle window is sleep, not a hiccup, and
   * is not forgiven (host sleep counts toward idle). Returns how many sessions were extended.
   */
  forgiveDaemonStall(resumedAt: number, lostMs: number): number {
    let forgiven = 0;
    for (const session of this.sessions.values()) {
      if (session.livenessPolicy === "cli-idle") {
        continue;
      }
      // Idle time is wall-clock, host sleep included: a stall that alone outlasts the window
      // (timeout plus suspect grace) is idleness the owner did not use, not a hiccup to forgive.
      // Judged here so the monitor tick and every lazy lookup reach the same verdict.
      if (lostMs >= session.sessionTimeoutMs + suspectGraceMsFor(session)) {
        continue;
      }
      const leaseStart = effectiveLastHeartbeat(session);
      session.stallForgivenAt = Math.max(leaseStart, Math.min(resumedAt, leaseStart + lostMs));
      session.expiresAt = Math.max(session.expiresAt, resumedAt + session.sessionTimeoutMs);
      if (session.awaitingOwnerSince !== undefined) {
        session.awaitingOwnerSince = Math.max(session.awaitingOwnerSince, resumedAt);
      }
      forgiven++;
    }
    return forgiven;
  }

  private async persistNewLivenessOwnershipClaim(
    session: Session,
    ownerToken: string,
    previous: {
      previousOwnerToken: string | undefined;
      previousOwnerHeartbeat: number | undefined;
    },
    processedClaims: Set<string>,
  ): Promise<void> {
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
      throw error;
    }
  }

  /** Return whether `ownerToken` is still authorized to refresh the session. */
  hasLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return this.getSession(sessionId)?.livenessOwnerToken === ownerToken;
  }

  /**
   * Recover daemon-local liveness ownership after restart without allowing a
   * keeper to replace an owner that was established by this daemon instance.
   */
  claimUnownedLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    const session = this.getSession(sessionId);
    if (
      !session ||
      session.livenessOwnerToken !== undefined ||
      session.livenessOwnershipClaims?.size
    ) {
      return false;
    }
    session.livenessOwnerToken = ownerToken;
    session.lastOwnerHeartbeat = this.timer.now();
    return true;
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
    const session = this.getSession(sessionId);
    if (!session) {
      logger.warn(`Cannot adopt CLI liveness policy for session ${sessionId}: not found`);
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
    const session = this.getSession(sessionId);
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
    // A session whose owner has been heartbeating is held a further suspect
    // window past its deadline (#10051), so an owner that missed a beat can
    // still restore it.
    return (
      !this.activeSessionExecutionChecker(session.sessionId) &&
      this.timer.now() > session.expiresAt + suspectGraceMsFor(session)
    );
  }

  /** Keep the heartbeat diagnostic when idle expiry wins the scan or lookup race (#10051). */
  private expiredSessionReleaseReason(
    session: Session,
    idleReason: "lazy-expiry" | "cleanup-expired",
  ): string {
    if (
      suspectGraceMsFor(session) > 0 &&
      livenessLeaseState(sessionLeaseSnapshot(session, this.timer.now())).phase === "lapsed"
    ) {
      return "heartbeat-timeout";
    }
    return idleReason;
  }

  private isSessionExpiredForNewExecution(
    session: Session,
    execution?: SessionExecutionMetadata,
  ): boolean {
    if (this.timer.now() <= session.expiresAt + suspectGraceMsFor(session)) {
      return false;
    }
    return execution?.startTime === undefined || execution.startTime > session.expiresAt;
  }

  private isLateExecutionWhileEarlierWorkIsActive(
    session: Session,
    execution: SessionExecutionMetadata | undefined,
  ): boolean {
    return (
      execution !== undefined &&
      this.timer.now() > session.expiresAt &&
      execution.startTime > session.expiresAt &&
      this.activeSessionExecutionChecker(session.sessionId, {
        excludeExecutionId: execution.executionId,
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

  private async restoreKeepScreenAwake(session: Session): Promise<void> {
    if (session.platform !== "android") {
      return;
    }
    const state = session.cacheData.keepScreenAwake;
    if (!state || !state.applied) {
      return;
    }

    const device: BootedDevice = {
      name: session.assignedDevice,
      platform: session.platform,
      deviceId: session.assignedDevice,
    };
    const manager = this.keepScreenAwakeRestorerFactory(device);
    await manager.restore(state);
  }

  /**
   * Remove all expired sessions and fire release callbacks for them.
   *
   * Runs on the periodic cleanup timer, but is also invoked by the heartbeat
   * monitor on its (much shorter) interval so that idle sessions — including
   * autolocked devices, whose idle timeout equals their heartbeat timeout — are
   * released promptly instead of waiting for the next 5-minute sweep.
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
      `Cleaning up ${expiredSessions.length} expired sessions: ` + expiredSessions.join(", "),
    );

    for (const sessionId of expiredSessions) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        continue;
      }
      const release = this.releaseSession(
        sessionId,
        this.expiredSessionReleaseReason(session, "cleanup-expired"),
        true,
        undefined,
        { expiryOrigin: "cleanup-expired" },
      );
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
    // Cancel any armed per-condition network TTLs so a stopped manager leaves no
    // dangling timer (issue #6085 item 2).
    for (const entry of this.networkConditionExpiryTimers.values()) {
      this.timer.clearTimeout(entry.handle);
    }
    this.networkConditionExpiryTimers.clear();
    this.iosAppNetworkLeases.stopAll();
    this.pendingNonTerminalReleaseSnapshots.clear();
  }

  // Intentionally NOT barrier-tracked: this write is `await`ed by its caller
  // (createSession), so it is caller-tied, not fire-and-forget. The DbWriteBarrier
  // (issue #2885) only drains fire-and-forget writers at graceful shutdown; an
  // awaited write is already sequenced by its caller and must not be wrapped in
  // `track()`. Do not "fix" this by adding a barrier — that would be a non-bug fix.
  private async persistSession(session: Session): Promise<void> {
    await this.deviceSessionRepository.upsertActiveSession({
      sessionUuid: session.sessionId,
      deviceId: session.assignedDevice,
      stableDeviceId: session.stableDeviceId,
      platform: session.platform,
      source: session.persistenceMetadata?.source ?? "session-manager",
      autolockEnabled: session.persistenceMetadata?.autolockEnabled,
      mcpSessionId: session.persistenceMetadata?.mcpSessionId,
      daemonSessionId: session.persistenceMetadata?.daemonSessionId,
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
    });
    await this.deviceSessionRepository.replaceLivenessOwnership?.(
      session.sessionId,
      session.livenessOwnerToken ?? null,
    );
  }

  private async recoveryTargetFromPersisted(
    sessionId: string,
    persisted: DeviceSession | undefined,
    requestedPlatform: Platform | undefined,
  ): Promise<SessionRecoveryTarget | undefined> {
    if (!persisted || !this.isRecoverablePersistedSession(persisted)) {
      return undefined;
    }
    // iOS device_id has always been the simulator's immutable UDID. Android's
    // emulator device_id and TCP/mDNS transport addresses cannot prove
    // continuity; a physical handset serial is its durable identity.
    const stableDeviceId =
      persisted.stable_device_id ??
      (persisted.platform === "ios" ||
      (persisted.platform === "android" &&
        !isAndroidEmulatorSerial(persisted.device_id) &&
        !isAndroidTransportAddressSerial(persisted.device_id))
        ? persisted.device_id
        : undefined);
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
      restartRecoveryDeadlineMs: restartRecoveryDeadlineFromPersisted(persisted),
      liveness: this.recoveryLivenessFromPersisted(persisted),
      persistenceMetadata: {
        source: persisted.source,
        autolockEnabled: persisted.autolock_enabled === 1,
        mcpSessionId: persisted.mcp_session_id,
        daemonSessionId: persisted.daemon_session_id,
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
    const preCliLiveness = persistedPreCliLiveness(persisted);
    return {
      sessionTimeoutMs: persisted.session_timeout_ms,
      heartbeatTimeoutMs: persisted.heartbeat_timeout_ms,
      heartbeatTimeoutSource,
      hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
      livenessPolicy,
      ...(preCliLiveness ? { preCliLiveness } : {}),
    };
  }

  // Intentionally NOT barrier-tracked when reached via the awaited path
  // (getOrCreateSession -> `await recordSessionActivity`): that path is caller-tied,
  // not fire-and-forget, so the DbWriteBarrier deliberately does not cover it. The
  // fire-and-forget callers above wrap this in `getBarrier().track(...)`; the awaited
  // caller must not. See #2885 — do not wrap the awaited call in `track()`.
  private async recordSessionActivity(session: Session): Promise<void> {
    try {
      await this.deviceSessionRepository.recordActivity(session.sessionId, {
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
      });
    } catch (error) {
      throw new SessionActivityPersistenceError(session.sessionId, error);
    }
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
