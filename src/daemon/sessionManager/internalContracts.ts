import {
  isDeviceRestartReleaseReason,
  type DeviceSessionActivityUpdate,
  type RecoverableRowIncarnation,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { ActionableError } from "../../models/ActionableError";
import {
  MANAGED_EXECUTION_LIVENESS_POLICY,
  ignoresManagedExecutionIdleDeadline,
} from "../../models/managedExecutionLiveness";
import {
  isAndroidEmulatorSerial,
  isAndroidTransportAddressSerial,
} from "../../utils/androidSerial";
import { type DeferredRebindCleanup } from "../acquisitionReceipt";
import { isTerminalReleaseReason, type SessionReleaseReason } from "../releaseReasons";
import {
  DEVICE_RESTART_RECOVERY_WINDOW_MS,
  SessionRecoveryIdentityLossError,
  getDefaultSessionHeartbeatTimeoutMs,
  type CreateSessionOptions,
  type PreCliLivenessSnapshot,
  type ReleaseCommitFence,
  type Session,
  type SessionAccess,
  type SessionExecutionMetadata,
  type SessionLivenessPolicy,
  type SessionRecoveryFailureReason,
  type SessionRecoveryLiveness,
  type SessionRecoveryTarget,
  type SessionReleaseOperation,
  type SessionReleaseSnapshot,
  type SessionReleaseStage,
} from "../sessionManager";
import { SessionSlots } from "../sessionSlots";
import { type TerminalReleaseIntent } from "../terminalReleaseJournal";
export function releaseSuperseded(shouldCommit: ReleaseCommitFence | undefined): boolean {
  return shouldCommit !== undefined && shouldCommit() === false;
}

export function isDeviceRestartReleasedRow(
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
export function restartRecoveryDeadlineFromPersisted(
  persisted: DeviceSession,
  callerInFlight = false,
): number | undefined {
  if (!isDeviceRestartReleasedRow(persisted)) {
    return undefined;
  }
  const restartWindowEnd = persisted.released_at_ms + DEVICE_RESTART_RECOVERY_WINDOW_MS;
  return callerInFlight || ignoresManagedExecutionIdleDeadline(persisted.liveness_policy)
    ? restartWindowEnd
    : Math.min(persisted.expires_at_ms, restartWindowEnd);
}

/** The persisted handoff's fixed window; idle activity never moves this deadline. */
export function hasLapsedRestartRecoveryWindow(persisted: DeviceSession, nowMs: number): boolean {
  const deadline = restartRecoveryDeadlineFromPersisted(persisted, true);
  // ORCHESTRATOR-CHOSEN: the window ends inclusively at released_at_ms + DEVICE_RESTART_RECOVERY_WINDOW_MS, matching persistedSessionExpiryReason and the admission probe.
  return deadline !== undefined && nowMs >= deadline;
}

export interface SharedSessionAssignment {
  controller: AbortController;
  /** Each deadline removes only its caller; an unbounded caller keeps recovery alive. */
  waiters: number;
  recoveryWait: PromiseWithResolvers<RecoveryAssignmentWait | undefined>;
}

/** A recoverable row this daemon claimed for recovery, and the owner a failed recovery restores. */
export interface ClaimedRecoverableRow {
  row: DeviceSession;
  previousOwner: string | null;
}

/**
 * `SessionDeviceAssigner` is an injected boundary. A recovery error can retain
 * its product payload while originating from another loaded bundle, in which
 * case `instanceof` alone would skip terminalizing an already-rejected UUID.
 */
export function isSessionRecoveryIdentityLossError(
  error: unknown,
): error is SessionRecoveryIdentityLoss {
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

/**
 * The durable device identity a persisted row can be recovered onto, or undefined when the row
 * recorded none. iOS device_id has always been the simulator's immutable UDID. Android's emulator
 * device_id and TCP/mDNS transport addresses cannot prove continuity; a physical handset serial
 * is its durable identity.
 */
export function persistedStableDeviceId(persisted: DeviceSession): string | undefined {
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

export function persistedHeartbeatTimeoutSource(
  value: string | null | undefined,
): "default" | "custom" {
  return value === "custom" ? "custom" : "default";
}

export function persistedLivenessPolicy(value: string | null | undefined): SessionLivenessPolicy {
  if (value === "cli-idle" || value === MANAGED_EXECUTION_LIVENESS_POLICY) {
    return value;
  }
  return "heartbeat";
}

export function persistedPreCliLiveness(
  persisted: DeviceSession,
): PreCliLivenessSnapshot | undefined {
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

/** The CLI idle default before the 2026-10-08 owner decision; rows persisted with it adopt the current one. */
export const LEGACY_DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** The idle window default before the 2026-10-08 owner decision; rows persisted with it adopt the current one. */
export const LEGACY_DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export type RehydrationRowOutcome =
  | { kind: "rehydrated" }
  | { kind: "terminalized"; reason: string }
  | { kind: "skipped"; reason: string };

/** One issued activity write; compared by identity so a newer write is never forgotten. */
export interface IssuedActivityWrite {
  key: string;
}

/** The activity row persisted for a session: copied from the session, never computed. */
export function sessionActivityUpdate(session: Session): DeviceSessionActivityUpdate {
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
export function activityUpdateKey(update: DeviceSessionActivityUpdate): string {
  return JSON.stringify(update);
}

/** Only reasons tagged in the release-reason table are terminal, so a match is a known reason. */
export function isTaggedTerminalReleaseReason(reason: string): reason is SessionReleaseReason {
  return isTerminalReleaseReason(reason);
}

/** A call whose start is known on the session clock, as every expiry judgement needs it. */
export type SessionClockExecution = SessionExecutionMetadata & { sessionClockStartTime: number };

export interface ReleaseReasonState {
  value: string;
  finalizedSnapshot?: SessionReleaseSnapshot;
  lateTerminalRelease?: Promise<string | null>;
  terminalPersisted?: boolean;
}

export interface SessionAcquisitionOptions {
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
  signal?: AbortSignal;
}

export type ResolvedSessionAcquisition = SessionAcquisitionOptions & { access: SessionAccess };

export interface RecoveryAssignmentWait {
  responseMarginMs: number;
  restartDeadlineMs?: number;
  timeoutError: () => ActionableError;
}

export interface PendingSessionRebind {
  session: Session;
  promise: Promise<Session>;
}

export interface PendingSessionRelease {
  promise: Promise<string | null>;
  reason: ReleaseReasonState;
}

export interface PendingSessionCreation {
  promise: Promise<Session>;
  /** Set when the creation outlived its deadline: it must not publish if it lands later (#10963). */
  abandoned?: boolean;
}

/** A recovery claim carries its release stamp on this daemon's session clock. */
export type ClaimedCreationRow = RecoverableRowIncarnation & {
  releaseReason?: string;
  releasedAtMs?: number;
};

export interface TerminalReleaseReservation {
  session: Session;
  deviceId: string;
  owner: symbol;
}

export type SessionRecoveryIdentityLoss = Pick<
  SessionRecoveryIdentityLossError,
  "sessionUuid" | "target" | "reason" | "terminalReleaseReason"
> &
  Partial<Pick<SessionRecoveryIdentityLossError, "ownerPid">>;

export function isSessionRecoveryFailureReason(
  reason: unknown,
): reason is SessionRecoveryFailureReason {
  return (
    reason === "target-absent" ||
    reason === "target-busy" ||
    reason === "identity-continuity-lost" ||
    reason === "owned-by-other-daemon"
  );
}

export function isSessionRecoveryTarget(target: unknown): target is SessionRecoveryTarget {
  if (!target || typeof target !== "object") {
    return false;
  }
  const candidate = target as Partial<SessionRecoveryTarget>;
  if (candidate.platform !== "android" && candidate.platform !== "ios") {
    return false;
  }
  return typeof candidate.stableDeviceId === "string" && typeof candidate.deviceId === "string";
}
export type SessionLifecycleSlots = SessionSlots<
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
>;

export function setReleaseStage(
  operation: SessionReleaseOperation | undefined,
  stage: SessionReleaseStage,
): void {
  if (operation) {
    operation.stage = stage;
  }
}

export function withCreateSessionDefaults(
  options: CreateSessionOptions,
): CreateSessionOptions & { initialOwnership: "owned" | "awaiting-owner" } {
  return { ...options, initialOwnership: options.initialOwnership ?? "owned" };
}

export function sessionCreationLiveness(
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

export function managedExecutionReleaseMarker(
  session: Pick<Session, "livenessPolicy">,
): Pick<SessionReleaseSnapshot, "livenessPolicy"> {
  return session.livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY
    ? { livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY }
    : {};
}
