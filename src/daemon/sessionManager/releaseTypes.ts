import type { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../models/managedExecutionLiveness";
import type { SessionReleaseReason } from "../releaseReasons";
import type { PendingSessionRelease } from "../sessionManager/internalContracts";
import type { ReleaseTeardownStage } from "./restorerTypes";
import type { Session } from "./sessionTypes";

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

export type ReleaseDeviceHold =
  | { skipDeviceWrites: true }
  | { settled: Promise<"teardown" | "skip-device-writes">; capMs: number };

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
