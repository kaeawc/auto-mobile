import type { SessionBrokerService } from "../sessionBroker/service";
import type { SessionBrokerProtocolErrorCode } from "../../devices/sessionBrokerResult";
import type { BootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import type { BindingInputGate } from "../inputDeviceOwnership";
import type { ReleaseCutExecutions } from "../releaseSessionAndDevice";
import type { DeviceHealthMarker } from "../deviceHealthMarkers";
import type { ObserverSessionStore } from "../observerSessionRegistry";
import type {
  DAEMON_INSTANCE_CHANGED_CODE,
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_IS_PROXY_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
  DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
  DaemonRequest,
} from "../types";
import type {
  DeviceLabelMap,
  HeldDeviceSession,
  LivenessClaimOutcome,
  LivenessReleaseOutcome,
  Session,
  SessionManager,
  SessionReleaseSnapshot,
} from "../sessionManager";
import type { LivenessLeaseState, LivenessOwnerHold } from "../livenessOwnerLease";
import type {
  DeviceRecoveryEligibility,
  DeviceRecoveryPolicy,
  PooledDevice,
  RefusedOwnedSessionRestore,
} from "../devicePool";
import type { DeviceSessionRecord, RetiredDeviceSession } from "../deviceSessionRegistry";
import type { BootedDevice } from "../../models";
import type { DeviceLeaseActivitySources } from "../deviceLeaseActivity";
import type { SESSION_OWNERSHIP_LOST_CODE } from "../sessionReleasedDuringCall";
import type { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../../models/deviceSessionRecovery";
import type { BrokerConnectionScopes } from "../sessionBroker/connectionScope";
import type { DEVICE_OUTSIDE_BROKER_GRANT_CODE } from "../sessionBroker/connectionRefusal";
import type { DeviceLeaseRelinquishPort } from "../deviceLeaseActivitySources";
import type { ScreenLockRegistry } from "../../features/utility/screenLock/ScreenLockRegistry";
import type { PowerRegistry } from "../../features/utility/power/PowerRegistry";

export interface DaemonStateAccess {
  isInitialized(): boolean;
  isSessionBrokerMode?(): boolean;
  getSessionBrokerService?(): SessionBrokerService | undefined;
  /** Overrides this process's daemon instance identifier (tests). */
  getDaemonInstance?(): string;
  /** Overrides the production lease-activity sources (tests). */
  getDeviceLeaseActivitySources?(): DeviceLeaseActivitySources;
  /** Overrides the production lease-relinquish policy and release (tests). */
  getDeviceLeaseRelinquishPort?(): DeviceLeaseRelinquishPort;
  /** Overrides the registry the release result reads `screenLockRestore` from (tests). */
  getScreenLockRegistry?(): ScreenLockRegistry;
  /** Overrides the registry the release result reads `powerRestore` from (tests). */
  getPowerRegistry?(): PowerRegistry;
  getObserverSessionRegistry?(): ObserverSessionStore | undefined;
  /** Socket sessions bound to broker bindings (#11178). */
  getBrokerConnectionScopes?(): Pick<BrokerConnectionScopes, "bind" | "get" | "unbind">;
  getSessionManager(): Partial<
    Pick<SessionManager, "getKeepAwakeRestoreReport" | "cleanupReceipts">
  > & {
    hasSession(sessionId: string): boolean;
    getSession(sessionId: string): Session | null;
    /** Admission/liveness judgement; never starts lazy release. */
    peekSession?(sessionId: string): Session | null;
    getReleasingSession?(sessionId: string): Session | null;
    getSessionLivenessOwnerToken?(sessionId: string): string | undefined;
    waitForSessionReleaseWithin?(sessionId: string, timeoutMs: number): Promise<boolean>;
    getAllSessions?(): Session[];
    /** Reverse-map holders, including sessions awaiting or completing release. */
    getHeldDeviceSessions?(): readonly HeldDeviceSession[];
    getTerminalReleaseSnapshot?(sessionId: string): SessionReleaseSnapshot | undefined;
    peekTerminalAnswerForEndedSession?(
      sessionId: string,
    ): { release: SessionReleaseSnapshot } | undefined;
    terminalAnswerForEndedSession?(sessionId: string): unknown;
    getExpiredReleaseSnapshot?(sessionId: string): Promise<SessionReleaseSnapshot | undefined>;
    /** Why a session this daemon released was released; undefined for a never-issued UUID. */
    getReleasedSessionReason?(sessionId: string): Promise<string | undefined>;
    recordHeartbeat?(sessionId: string): void;
    creditOwnerHeartbeatDuringRelease?(sessionId: string, ownerToken: string): void;
    /** Claim the token permitted to refresh this session's liveness. */
    claimLivenessOwnership?(sessionId: string, ownerToken: string): Promise<LivenessClaimOutcome>;
    releaseLivenessOwnership?(
      sessionId: string,
      ownerToken: string,
    ): Promise<LivenessReleaseOutcome>;
    /** Verify that a keeper still owns the token permitted to refresh liveness. */
    hasLivenessOwnership?(sessionId: string, ownerToken: string): boolean;
    /** Lease phase (live, suspect, lapsed) and time remaining in it; absent for `cli-idle` (#10051). */
    getSessionLeaseState?(sessionId: string): LivenessLeaseState | undefined;
    /** The current owner's hold, reported with a refused claim (#10701). */
    getOwnerLeaseHold?(sessionId: string): LivenessOwnerHold | undefined;
    /** Recover daemon-local ownership only when no token is currently recorded. */
    claimUnownedLivenessOwnership?(sessionId: string, ownerToken: string): boolean;
    /** Opt a one-shot `--cli`-owned session out of the heartbeat contract (#6870). */
    adoptCliLivenessPolicy?(sessionId: string, idleTimeoutMs?: number): boolean;
    /** Put a CLI-adopted session back on the strict heartbeat contract (#6870). */
    restoreHeartbeatLivenessPolicy?(sessionId: string): boolean;
    getSessionForDevice?(deviceId: string): string | null;
    /** Remember a registered client's name for `holderKind` diagnostics (#10671). */
    recordSessionClientName?(sessionId: string, clientName: string): void;
    /** What bounds an in-flight call's idle-release veto, for `idleReleaseAt` (#10671). */
    getIdleReleaseExecutionVeto?(sessionId: string): { latestDeadlineMs?: number } | undefined;
    /** Converts a session-clock instant to wall-clock epoch ms for reporting (#11105). */
    sessionClockToWall?(sessionClockMs: number): number;
    /** The same conversion, stable across queries, for values shown to a client (#11368). */
    sessionClockToReportedWall?(sessionClockMs: number): number;
    getDeviceLabels(sessionId: string): DeviceLabelMap | undefined;
    releaseSession(sessionId: string): Promise<string | null>;
  };
  getDevicePool(): {
    isShutdownReserved?(deviceId: string): Promise<boolean>;
    /** Synchronous: a shutdown reservation holds the device now (#11200). */
    isUnderShutdownReservation?(deviceId: string): boolean;
    restoreAutolockSessionsForMcpSession?(
      sessionIds: readonly string[],
      mcpSessionId: string,
    ): Promise<void>;
    restoreOwnedDeviceSessionsForMcpSession?(
      sessionIds: readonly string[],
      mcpSessionId: string,
      livenessOwnerToken?: string,
    ): Promise<readonly RefusedOwnedSessionRestore[] | void>;
    releaseMcpSessionBindings?(mcpSessionId: string): void;
    beginMcpToolCall?(mcpSessionId: string | undefined): (delivered?: boolean) => void;
    declareMcpSessionLivenessOwnerToken?(mcpSessionId: string, token: string): void;
    beginMcpSessionOwnerCall?(mcpSessionId: string, token: string): () => void;
    /** Give up the restart-recovery reservation made for a session, if any (#11294). */
    releaseRehydrationReservation?(sessionId: string): void;
    refreshDevices(): Promise<number>;
    refreshDevicesWithOutcome?(): Promise<import("../devicePoolRefresh").DevicePoolRefreshResult>;
    getStats(): DevicePoolStats;
    /** {@link getStats} after refreshing broker and foreign-daemon ownership (#11305). */
    getRefreshedStats?(): Promise<DevicePoolStats>;
    /** {@link getRefreshedStats} plus the live device ids it counted (#11568). */
    getRefreshedInventory?(): Promise<{
      stats: DevicePoolStats;
      deviceIds: ReadonlySet<string>;
    }>;
    releaseDevice(deviceId: string, expectedSessionId: string): Promise<void>;
    getAllDevices?(): PooledDevice[];
    /** The pooled device, whose `sessionId` is set as soon as a session is assigned it. */
    getDevice?(deviceId: string): PooledDevice | null;
    isPooledIdentityUnresolved?(deviceId: string): boolean;
    getRecoveryPolicy?(): DeviceRecoveryPolicy;
    getDeviceHealthMarker?(deviceId: string): DeviceHealthMarker | undefined;
    getRecoveryEligibility?(deviceId: string): DeviceRecoveryEligibility;
    assertSessionReadyForAutomation?(sessionId: string): void;
    /**
     * FUNNEL 2 — the device-addressed admission gate. Optional only so the
     * daemon-state fakes in older suites keep compiling; the real pool always
     * has it ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
     */
    assertDeviceActionable?(deviceId: string, purpose: string): void;
    /** The pooled canonical id for a known Android alias serial (identity otherwise). */
    resolveAndroidCanonicalId?(deviceId: string): string;
    /** Refuse control of a device a broker binding holds (#11178); see `DevicePool`. */
    assertNotAssignedToBinding?: BindingInputGate["assertNotAssignedToBinding"];
    /** FUNNEL 1 — fold a discovery observation into pooled identity. */
    reconcileDiscoveryObservation?(devices: readonly BootedDevice[], source: string): Promise<void>;
    resolveAutolockSessionForMcpSession?(
      mcpSessionId: string | undefined,
      platform?: "android" | "ios",
    ): string | undefined;
  };
  getDeviceSessionRegistry(): {
    list(): DeviceSessionRecord[];
    getRetiredByUuid?(uuid: string): RetiredDeviceSession | undefined;
  };
}

export type DevicePoolStats = {
  total: number;
  idle: number;
  assigned: number;
  error: number;
  avgAssignments?: number;
};

export type DaemonMethodResult = {
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  /** With a session-not-found `code`: why a session the daemon knows is released was released. */
  releaseReason?: string;
  /** With a session-not-found heartbeat answer that asked for it: this daemon process instance. */
  daemonInstance?: string;
  /** With `releaseReason`: an idle-window release (#10832). */
  idle?: true;
  /** With a typed refusal `code`: whether retrying the same request can succeed. */
  retryable?: boolean;
  /** Minimum backoff before retrying a transient refusal. */
  retryAfterMs?: number;
  /** With a typed refusal `code`: what to do instead of retrying. */
  nextAction?: typeof ACQUIRE_NEW_SESSION_NEXT_ACTION;
  /** With a typed refusal `code`: its structured evidence. */
  details?: Record<string, unknown>;
  code?:
    | typeof DAEMON_SESSION_NOT_FOUND_CODE
    /** `daemon/registerSession` naming a UUID an idle or heartbeat release ended (#11367). */
    | typeof SESSION_OWNERSHIP_LOST_CODE
    | typeof DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE
    | typeof DAEMON_LIVENESS_OWNER_UNOWNED_CODE
    | typeof DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE
    | typeof DAEMON_LIVENESS_OWNER_CONFLICT_CODE
    | typeof DAEMON_LIVENESS_OWNER_IS_PROXY_CODE
    | typeof DAEMON_INSTANCE_CHANGED_CODE
    /** Session broker protocol refusals. */
    | SessionBrokerProtocolErrorCode
    /** `daemon/registerSession` managed-connection refusals (#11178). */
    | typeof DEVICE_OUTSIDE_BROKER_GRANT_CODE
    /** A device-count read while a discovery source that exists has not completed (#11605). */
    | BootedDeviceDiscoveryIncompleteError["code"];
};

/** Device-session listing entry; a quarantined UUID cannot be subscribed to until identity resolves. */
export interface ListedDeviceSessionRecord extends DeviceSessionRecord {
  identityUnresolved?: true;
  unhealthy?: DeviceHealthMarker;
}

/** Who sent a socket daemon request. */
export interface DaemonRequestContext {
  /** The requesting socket session (the `__mcpSessionId` its forwarded tool calls carry). */
  socketSessionId?: string;
}

export type InitializedDaemonMethodHandler = (
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions: ReleaseCutExecutions | undefined,
  signal: AbortSignal | undefined,
  context: DaemonRequestContext,
) => DaemonMethodResult | Promise<DaemonMethodResult>;
