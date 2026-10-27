import type { Platform } from "../../models";
import type { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../models/managedExecutionLiveness";
import type { ObserveResult } from "../../models/ObserveResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { KeepScreenAwakeState } from "../../utils/KeepScreenAwakeManager";
import type { TimingData } from "../../utils/PerformanceTracker";
import type { DeferredRebindCleanup } from "../acquisitionReceipt";
import type { DeviceReadinessLevel } from "../readiness/DeviceReadiness";
import type { SessionRecoveryLiveness } from "./recoveryTypes";
import type { MutationRecorder } from "../sessionBroker/mutations/recorder";
import type {
  BiometricEnrollmentSessionState,
  ClockSessionState,
  NetworkConditionSessionState,
  RotationSessionState,
  ScreenReaderSessionState,
} from "./restorerTypes";

/**
 * Device-label → session-UUID map. `buildDeviceLabelMap` assigns each configured
 * label its own session (the primary label reuses the base session UUID), so a
 * `device: "B"` tool argument can be routed to the correct label session.
 */
export type DeviceLabelMap = Record<string, string>;

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
  mutationRecorder?: MutationRecorder;
  sessionId: string; // UUID provided by JUnitRunner
  assignedDevice: string; // Device ID this session is using
  stableDeviceId?: string; // Durable identity: Android AVD name or iOS simulator UDID
  /** In-memory serial changes observed by this daemon; absent means zero. */
  deviceGeneration?: number;
  previousDeviceId?: string;
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

export interface SessionPersistenceMetadata {
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
 * How a call uses the session it names. `acquire` is the client's own control call: admitted
 * only on a usable session, and it is use (it restarts the idle window and reclaims an
 * awaiting-owner session). `read-only` is never refused and never use. `non-owner-control` is a
 * control call made on the holder's behalf by something that is not the session's client (a
 * desktop pane's direct `input/*`, #11417): it passes the same refusals as `acquire` (suspect,
 * lapsed owner lease, idle expiry) but changes nothing on admission — no reclaim of an
 * awaiting-owner session, no activity or liveness stamp, no restart-recovery credit.
 */
export type SessionAccess = "acquire" | "read-only" | "non-owner-control";

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
  /**
   * The rebind moves the same session onto a replacement for a device that was lost (Android AVD
   * recovery, System UI replacement). Only these bump `deviceGeneration` and announce
   * `session_device_rebound`; a client-chosen move (setActiveDevice, an explicit bind) and the
   * undo of a cancelled one do not (#15456).
   */
  recovery?: boolean;
  /** Durable identity of the replacement device. */
  stableDeviceId?: string;
  signal?: AbortSignal;
  /** Internal owner proving that a shutdown reservation authorized this recovery rebind. */
  terminalReleaseReservationOwner?: symbol;
  /** Only receipt-backed acquisitions can decide delivery versus undo. */
  deferCleanup?: (cleanup: DeferredRebindCleanup) => void;
}

export type SessionCreatedCallback = (session: Session) => void;
