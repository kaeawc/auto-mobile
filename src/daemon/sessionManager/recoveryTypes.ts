import type { Platform } from "../../models";
import type { RecoveryAssignmentWait } from "../sessionManager/internalContracts";
import type {
  PreCliLivenessSnapshot,
  SessionLivenessPolicy,
  SessionPersistenceMetadata,
} from "./sessionTypes";

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
