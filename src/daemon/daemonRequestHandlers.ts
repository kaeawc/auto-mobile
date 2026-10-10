import { isSessionReleasing } from "./sessionReleaseState";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  cancelAndReleaseSession,
  releaseSessionAndDevice,
  type SessionExecutionCanceller,
} from "./releaseSessionAndDevice";
import type { DeviceHealthMarker } from "./deviceHealthMarkers";
import { z } from "zod";
import {
  MAX_OBSERVER_CLIENT_NAME_LENGTH,
  MAX_OBSERVER_SESSION_ID_LENGTH,
  type ObserverSessionStore,
} from "./observerSessionRegistry";
import {
  DAEMON_INSTANCE_CHANGED_CODE,
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_IS_PROXY_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
  DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
  DaemonRequest,
  releasedSessionNotFoundFields,
} from "./types";
import {
  DeviceLabelMap,
  type LivenessClaimOutcome,
  type LivenessReleaseOutcome,
  Session,
  type SessionReleaseSnapshot,
} from "./sessionManager";
import type {
  LivenessLeasePhase,
  LivenessLeaseState,
  LivenessOwnerHold,
} from "./livenessOwnerLease";
import type { DeviceRecoveryEligibility, DeviceRecoveryPolicy, PooledDevice } from "./devicePool";
import type { DeviceSessionRecord, RetiredDeviceSession } from "./deviceSessionRegistry";
import type { BootedDevice } from "../models";
import {
  CLI_KEEPER_LIVENESS_OWNER_KIND,
  CLI_SESSION_LIVENESS_POLICY,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD,
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_LIST_DEVICE_SESSIONS_METHOD,
  DAEMON_DEVICE_LEASE_STATUS_METHOD,
  DAEMON_RELINQUISH_DEVICE_LEASE_METHOD,
  SESSION_RELEASE_DRAIN_TIMEOUT_MS,
} from "./constants";
import { executionTracker } from "../server/executionTracker";
import { sessionHoldDiagnostics, vetoedIdleReleaseAt } from "./sessionHoldDiagnostics";
import { readDeviceLeaseActivity, type DeviceLeaseActivitySources } from "./deviceLeaseActivity";
import {
  daemonDeviceLeaseActivitySources,
  daemonDeviceLeaseRelinquishPort,
  type DeviceLeaseRelinquishPort,
} from "./deviceLeaseActivitySources";
import { decideOwnerRelinquish } from "../features/observe/shared/ctrlProxyForwardLeaseOwnership";

/** Socket endpoint clients may query before sending optional newer parameters. */
export const DAEMON_CAPABILITIES_METHOD = "daemon/capabilities";

/** Non-destructive Android text input introduced with desktop keyboard forwarding. */
export const INPUT_TYPE_TEXT_APPEND_CAPABILITY = "input/typeText.mode:append";

/**
 * Streaming (real-time) gesture input: `input/gestureStart` / `input/gestureMove` /
 * `input/gestureEnd`, chained into one continued on-device gesture (Android only). A client probes
 * for this before streaming a drag; when absent it falls back to the atomic `input/swipe`.
 */
export const INPUT_GESTURE_STREAM_CAPABILITY = "input/gestureStream";

/**
 * Identifies this daemon process. A restarted daemon reports a different value, so a proxy can
 * tell a daemon that resumed after a stall from a new one (#10989).
 */
const DAEMON_PROCESS_INSTANCE = `${process.pid}:${performance.timeOrigin}`;

export interface DaemonStateAccess {
  isInitialized(): boolean;
  /** Overrides this process's {@link DAEMON_PROCESS_INSTANCE} (tests). */
  getDaemonInstance?(): string;
  /** Overrides the production lease-activity sources (tests). */
  getDeviceLeaseActivitySources?(): DeviceLeaseActivitySources;
  /** Overrides the production lease-relinquish policy and release (tests). */
  getDeviceLeaseRelinquishPort?(): DeviceLeaseRelinquishPort;
  getObserverSessionRegistry?(): ObserverSessionStore | undefined;
  getSessionManager(): {
    hasSession(sessionId: string): boolean;
    getSession(sessionId: string): Session | null;
    getReleasingSession?(sessionId: string): Session | null;
    waitForSessionReleaseWithin?(sessionId: string, timeoutMs: number): Promise<boolean>;
    getAllSessions?(): Session[];
    getTerminalReleaseSnapshot?(sessionId: string): SessionReleaseSnapshot | undefined;
    /** Why a session this daemon released was released; undefined for a never-issued UUID. */
    getReleasedSessionReason?(sessionId: string): Promise<string | undefined>;
    recordHeartbeat?(sessionId: string): void;
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
    getDeviceLabels(sessionId: string): DeviceLabelMap | undefined;
    releaseSession(sessionId: string): Promise<string | null>;
  };
  getDevicePool(): {
    isShutdownReserved?(deviceId: string): Promise<boolean>;
    restoreAutolockSessionsForMcpSession?(
      sessionIds: readonly string[],
      mcpSessionId: string,
    ): Promise<void>;
    restoreOwnedDeviceSessionsForMcpSession?(
      sessionIds: readonly string[],
      mcpSessionId: string,
      livenessOwnerToken?: string,
    ): Promise<void>;
    releaseMcpSessionBindings?(mcpSessionId: string): void;
    refreshDevices(): Promise<number>;
    refreshDevicesWithOutcome?(): Promise<import("./devicePoolRefresh").DevicePoolRefreshResult>;
    getStats(): DevicePoolStats;
    releaseDevice(deviceId: string, expectedSessionId: string): Promise<void>;
    getAllDevices?(): PooledDevice[];
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
  /** With `releaseReason`: an idle-window release (#10832). */
  idle?: true;
  code?:
    | typeof DAEMON_SESSION_NOT_FOUND_CODE
    | typeof DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE
    | typeof DAEMON_LIVENESS_OWNER_UNOWNED_CODE
    | typeof DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE
    | typeof DAEMON_LIVENESS_OWNER_CONFLICT_CODE
    | typeof DAEMON_LIVENESS_OWNER_IS_PROXY_CODE
    | typeof DAEMON_INSTANCE_CHANGED_CODE;
};

/** Device-session listing entry; a quarantined UUID cannot be subscribed to until identity resolves. */
export interface ListedDeviceSessionRecord extends DeviceSessionRecord {
  identityUnresolved?: true;
  unhealthy?: DeviceHealthMarker;
}

const registerSessionParams = z.object({
  sessionId: z.string().max(MAX_OBSERVER_SESSION_ID_LENGTH).uuid(),
  clientName: z.string().max(MAX_OBSERVER_CLIENT_NAME_LENGTH).trim().min(1),
});

async function handleRegisterSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const params: unknown = request.params;
  const parsed = registerSessionParams.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: `Invalid registerSession parameters: ${parsed.error.message}` };
  }
  const { sessionId, clientName } = parsed.data;
  const manager = state.getSessionManager();
  if (
    (await manager.waitForSessionReleaseWithin?.(sessionId, SESSION_RELEASE_DRAIN_TIMEOUT_MS)) ===
    false
  ) {
    return {
      success: false,
      error: `Session ${sessionId} release is still in progress after ${SESSION_RELEASE_DRAIN_TIMEOUT_MS}ms; retry registration`,
    };
  }
  const session = manager.getSession(sessionId);
  if (session) {
    manager.recordSessionClientName?.(sessionId, clientName);
    return {
      success: true,
      result: {
        accepted: true,
        heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        expiresAtMs: session.lastHeartbeat + session.heartbeatTimeoutMs,
      },
    };
  }
  const registry = state.getObserverSessionRegistry?.();
  if (!registry) {
    return { success: false, error: "Observer session registration is unavailable" };
  }
  const registration = registry.register(sessionId, clientName);
  return registration.accepted
    ? { success: true, result: { ...registration } }
    : { success: false, error: registration.error };
}

export async function handleDaemonRequest(
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions?: SessionExecutionCanceller,
): Promise<DaemonMethodResult> {
  if (!request.method.startsWith("daemon/")) {
    return {
      success: false,
      error: `Unsupported daemon method: ${request.method}`,
    };
  }

  // This is daemon self-description, not a pool operation. Keep it available while startup is
  // still settling so a client can decide whether to issue an optional request before forwarding.
  if (request.method === DAEMON_CAPABILITIES_METHOD) {
    return {
      success: true,
      result: {
        capabilities: [
          INPUT_TYPE_TEXT_APPEND_CAPABILITY,
          INPUT_GESTURE_STREAM_CAPABILITY,
          DAEMON_REGISTER_SESSION_METHOD,
        ],
      },
    };
  }

  if (!state.isInitialized()) {
    return {
      success: false,
      error: "Daemon not initialized",
    };
  }

  return handleInitializedDaemonRequest(request, state, executions);
}

type InitializedDaemonMethodHandler = (
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions?: SessionExecutionCanceller,
) => DaemonMethodResult | Promise<DaemonMethodResult>;

/** Socket daemon methods served once the daemon is initialized, by method name. */
const INITIALIZED_DAEMON_METHOD_HANDLERS: ReadonlyMap<string, InitializedDaemonMethodHandler> =
  new Map<string, InitializedDaemonMethodHandler>([
    [DAEMON_REGISTER_SESSION_METHOD, handleRegisterSession],
    [DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD, handleReleaseLivenessOwnership],
    [DAEMON_HEARTBEAT_METHOD, handleHeartbeat],
    [DAEMON_TOKEN_OWNED_SESSIONS_METHOD, handleTokenOwnedSessions],
    ["daemon/refreshDevices", handleRefreshDevices],
    ["daemon/availableDevices", handleAvailableDevices],
    ["daemon/sessionInfo", (request, state) => handleSessionInfo(request, state)],
    ["daemon/activeSessions", (request, state) => handleActiveSessions(request, state)],
    [
      "daemon/releaseSession",
      (request, state, executions) => handleReleaseSession(request, state, executions),
    ],
    [DAEMON_LIST_DEVICE_SESSIONS_METHOD, handleListDeviceSessions],
    [DAEMON_DEVICE_LEASE_STATUS_METHOD, handleDeviceLeaseStatus],
    [DAEMON_RELINQUISH_DEVICE_LEASE_METHOD, handleRelinquishDeviceLease],
  ]);

async function handleInitializedDaemonRequest(
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions?: SessionExecutionCanceller,
): Promise<DaemonMethodResult> {
  const handler = INITIALIZED_DAEMON_METHOD_HANDLERS.get(request.method);
  if (!handler) {
    return {
      success: false,
      error: `Unsupported daemon method: ${request.method}`,
    };
  }
  return await handler(request, state, executions);
}

async function handleReleaseLivenessOwnership(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const parsed = z
    .object({
      sessionId: z.string().min(1),
      livenessOwnerToken: z.string().refine((token) => token.trim().length > 0),
    })
    .safeParse(request.params);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid releaseLivenessOwnership parameters: ${parsed.error.message}`,
    };
  }
  const { sessionId, livenessOwnerToken } = parsed.data;
  const outcome = await state
    .getSessionManager()
    .releaseLivenessOwnership?.(sessionId, livenessOwnerToken);
  if (outcome === "not-found") {
    return {
      success: false,
      code: DAEMON_SESSION_NOT_FOUND_CODE,
      error: `Session not found: ${sessionId}`,
    };
  }
  if (outcome === "not-owner" || outcome === undefined) {
    return {
      success: false,
      code: DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
      error: `Session ${sessionId}'s liveness can only be released by its current owner token; nothing changed.`,
    };
  }
  return {
    success: true,
    result: { sessionId, alreadyUnowned: outcome === "already-unowned" },
  };
}

/**
 * The live sessions the given liveness owner token owns (#10990), so a proxy restarted with its
 * stable token can resume all of them. A releasing session is no longer resumable and is left out.
 */
export function handleTokenOwnedSessions(
  request: DaemonRequest,
  state: DaemonStateAccess,
): DaemonMethodResult {
  const parsed = z
    .object({ livenessOwnerToken: z.string().refine((token) => token.trim().length > 0) })
    .safeParse(request.params);
  if (!parsed.success) {
    return { success: false, error: "livenessOwnerToken parameter required" };
  }
  const { livenessOwnerToken } = parsed.data;
  const manager = state.getSessionManager();
  const sessions = (manager.getAllSessions?.() ?? []).filter(
    (session) =>
      session.livenessOwnerToken === livenessOwnerToken &&
      !isSessionReleasing(manager, session.sessionId, session),
  );
  return {
    success: true,
    result: {
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        deviceId: session.assignedDevice,
        platform: session.platform,
        // The daemon's own idle clock, so the resuming proxy judges idleness from the last tool
        // call rather than from the resume (#10656). Reported as wall-clock epoch ms: the proxy
        // compares it with its own wall clock, not the daemon's session clock (#11117).
        lastUsedAt: manager.sessionClockToWall?.(session.lastUsedAt) ?? session.lastUsedAt,
      })),
    },
  };
}

/**
 * True once a token-bearing proxy owns, or has a claim pending on, the session.
 * A tokenless heartbeat (socket or HTTP) must then be a liveness no-op: it
 * predates liveness ownership and must not renew the owner lease or deadlines.
 */
export function isTokenOwnedOrClaimPending(session: {
  livenessOwnerToken?: string;
  livenessOwnershipClaims?: { size: number };
}): boolean {
  return session.livenessOwnerToken !== undefined || !!session.livenessOwnershipClaims?.size;
}

/**
 * Session-not-found answer. A session the daemon knows it released also says why
 * (`releaseReason`, #10730; `idle: true` for an idle-window release, #10832) so a client can tell
 * an idle release from a restart or lapsed owner;
 * a UUID the daemon never issued stays a plain not-found.
 */
async function sessionNotFoundResult(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
): Promise<DaemonMethodResult> {
  const releaseReason = await lookupReleasedSessionReason(manager, sessionId);
  return {
    success: false,
    error: `Session not found: ${sessionId}`,
    code: DAEMON_SESSION_NOT_FOUND_CODE,
    ...releasedSessionNotFoundFields(releaseReason),
  };
}

/** The recorded release reason, or undefined when unknown or the lookup fails (best-effort). */
export async function lookupReleasedSessionReason(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
): Promise<string | undefined> {
  try {
    return await manager.getReleasedSessionReason?.(sessionId);
  } catch (error) {
    logger.warn(`Release reason lookup failed for ${sessionId}: ${errorMessage(error)}`, error);
    return undefined;
  }
}

async function handleHeartbeat(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const heartbeatParams = request.params as
    | {
        sessionId?: string;
        livenessPolicy?: string;
        idleTimeoutMs?: number;
        livenessOwnerToken?: string;
        claimLivenessOwnership?: boolean;
        reportIdleRelease?: boolean;
        reportDaemonInstance?: boolean;
        expectedDaemonInstance?: string;
        livenessOwnerKind?: string;
      }
    | undefined;
  const sessionId = heartbeatParams?.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error: "sessionId parameter required",
    };
  }
  const daemonInstance = state.getDaemonInstance?.() ?? DAEMON_PROCESS_INSTANCE;
  const instanceRefusal = refuseOtherDaemonInstance(
    heartbeatParams?.expectedDaemonInstance,
    daemonInstance,
    sessionId,
  );
  if (instanceRefusal) {
    return instanceRefusal;
  }
  const ackReport: HeartbeatAckReport = {
    idleRelease: heartbeatParams?.reportIdleRelease === true,
    ...(heartbeatParams?.reportDaemonInstance === true ? { daemonInstance } : {}),
  };
  const manager = state.getSessionManager();
  const session = manager.getSession(sessionId);
  if (!session || isSessionReleasing(manager, sessionId, session)) {
    if (
      typeof sessionId === "string" &&
      state.getObserverSessionRegistry?.()?.heartbeat(sessionId)
    ) {
      return { success: true, result: { sessionId } };
    }
    return sessionNotFoundResult(manager, sessionId);
  }
  const keeperRefusal = refuseCliKeeperOnProxySession(heartbeatParams?.livenessOwnerKind, session);
  if (keeperRefusal) {
    return keeperRefusal;
  }
  if (isCliKeeperOnCliIdleSession(heartbeatParams?.livenessOwnerKind, session)) {
    return cliKeeperNoopAck(sessionId);
  }
  const livenessOwnerToken =
    typeof heartbeatParams?.livenessOwnerToken === "string" &&
    heartbeatParams.livenessOwnerToken.length > 0
      ? heartbeatParams.livenessOwnerToken
      : undefined;
  const claimsLivenessOwnership = heartbeatParams?.claimLivenessOwnership === true;
  if (!livenessOwnerToken && isTokenOwnedOrClaimPending(session)) {
    // Tokenless clients predate liveness ownership. Keep them compatible
    // only until a token-bearing owner has claimed this session; afterward
    // they are stale by definition and must not change policy or deadlines.
    return { success: true, result: { sessionId } };
  }
  if (livenessOwnerToken) {
    const outcome = await resolveLivenessOwnership(
      manager,
      sessionId,
      livenessOwnerToken,
      claimsLivenessOwnership,
    );
    // No authorization crosses an await: check the session and owner at the final
    // synchronous boundary before changing policy or recording the heartbeat.
    const rejection = rejectHeartbeatWithoutOwnership(
      manager,
      session,
      sessionId,
      livenessOwnerToken,
      outcome,
    );
    if (rejection) {
      // A concurrent `--cli` call can move the session onto the cli-idle policy (claiming it
      // with its own token) while the keeper's claim was resolving; the keeper still no-ops.
      const current = manager.getSession(sessionId);
      return rejection.code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE &&
        current &&
        isCliKeeperOnCliIdleSession(heartbeatParams?.livenessOwnerKind, current)
        ? cliKeeperNoopAck(sessionId)
        : rejection;
    }
    if (!claimsLivenessOwnership) {
      // A verified keeper proves only that its current owner is still
      // alive. Policy changes are explicit claims, never recurring ticks.
      manager.recordHeartbeat?.(sessionId);
      return heartbeatAck(manager, sessionId, ackReport);
    }
  }
  // A one-shot `--cli` client declares itself here (issue #6870) so the
  // daemon stops holding its session to the 10 s heartbeat contract no
  // one-shot process can keep. An unmarked Desktop heartbeat restores that
  // strict contract when a prior CLI invocation widened the same session.
  if (heartbeatParams?.livenessPolicy === CLI_SESSION_LIVENESS_POLICY) {
    // The invocation carries its own resolved idle timeout: it reuses a
    // running daemon, whose process env was read at startup and cannot
    // reflect this invocation's override (issue #6870 review). The manager
    // re-validates and bounds it.
    manager.adoptCliLivenessPolicy?.(sessionId, heartbeatParams.idleTimeoutMs);
    // Reports the idle instant like every other ack when asked (#10972).
    return heartbeatAck(manager, sessionId, ackReport, {
      livenessPolicy: "cli-idle",
      idleTimeoutMs: manager.getSession(sessionId)?.heartbeatTimeoutMs,
    });
  }
  if (
    heartbeatParams?.livenessPolicy === HEARTBEAT_SESSION_LIVENESS_POLICY ||
    heartbeatParams?.livenessPolicy === undefined
  ) {
    // A long-lived stdio/HTTP proxy CAN keep the strict contract and says so
    // on every heartbeat, so a session a previous `--cli` invocation moved
    // onto the minutes-long idle window goes back to it (issue #6870
    // review) instead of holding its device for that window after this
    // client disconnects.
    // `restoreHeartbeatLivenessPolicy` records the heartbeat itself as part
    // of re-stamping the deadlines off the restored timeouts.
    if (manager.restoreHeartbeatLivenessPolicy?.(sessionId)) {
      return heartbeatAck(manager, sessionId, ackReport, {
        livenessPolicy: HEARTBEAT_SESSION_LIVENESS_POLICY,
      });
    }
  }
  manager.recordHeartbeat?.(sessionId);
  return heartbeatAck(manager, sessionId, ackReport);
}

/** What a heartbeat asked its acknowledgement to report besides the session id. */
interface HeartbeatAckReport {
  idleRelease: boolean;
  /** This daemon's process instance, when the heartbeat asked for it (#10989). */
  daemonInstance?: string;
}

/**
 * Refuse, before anything changes, a heartbeat meant for another daemon process (#10989). A proxy
 * probing for a daemon that resumed after a stall names the process it last heard from, so a
 * restarted daemon is not adopted behind the harness's back.
 */
function refuseOtherDaemonInstance(
  expected: unknown,
  daemonInstance: string,
  sessionId: string,
): DaemonMethodResult | undefined {
  if (typeof expected !== "string" || expected === daemonInstance) {
    return undefined;
  }
  return {
    success: false,
    code: DAEMON_INSTANCE_CHANGED_CODE,
    error: `The daemon was restarted since this heartbeat's owner last heard from it, so the heartbeat for session ${sessionId} was refused and nothing changed. Resume the session by naming its sessionUuid in a tool call.`,
  };
}

/**
 * A heartbeat acknowledgement that also reports when the daemon would idle-release the session
 * when the heartbeat asks (`reportIdleRelease`, so other clients' wire fixtures stay as they are)
 * (`idleReleaseAt`, an epoch-ms instant from the daemon's own idle window, veto included, the same
 * value `session-info` reports). It reports without extending anything: the proxy judges idleness
 * by the daemon's clock instead of its own (#10823). The value only moves when a tool call does,
 * so consecutive acks of an idle session are identical.
 */
function heartbeatAck(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  report: HeartbeatAckReport,
  extra: Record<string, unknown> = {},
): DaemonMethodResult {
  const session = manager.getSession(sessionId);
  const instance =
    report.daemonInstance === undefined ? {} : { daemonInstance: report.daemonInstance };
  const idle =
    report.idleRelease && session
      ? {
          idleReleaseAt:
            manager.sessionClockToWall?.(
              vetoedIdleReleaseAt(session, manager.getIdleReleaseExecutionVeto?.(sessionId)),
            ) ?? vetoedIdleReleaseAt(session, manager.getIdleReleaseExecutionVeto?.(sessionId)),
        }
      : {};
  return { success: true, result: { sessionId, ...extra, ...idle, ...instance } };
}

/**
 * A proxy owns a session when a token has claimed it under the strict heartbeat policy: stdio/HTTP
 * proxies claim with `heartbeat`, while one-shot `--cli` owners move the session to `cli-idle`.
 */
function isProxyOwnedSession(session: Session): boolean {
  return session.livenessPolicy === "heartbeat" && session.livenessOwnerToken !== undefined;
}

/**
 * The external CLI keeper is for one-shot CLI sessions only. Refuse it on a proxy-owned session
 * whatever its token or lease state, before any ownership or policy logic runs, so the refusal
 * changes nothing on the session (#10054). Requests without the keeper marker are unaffected.
 */
export function refuseCliKeeperOnProxySession(
  livenessOwnerKind: string | undefined,
  session: Session,
): DaemonMethodResult | undefined {
  if (livenessOwnerKind !== CLI_KEEPER_LIVENESS_OWNER_KIND || !isProxyOwnedSession(session)) {
    return undefined;
  }
  return {
    success: false,
    code: DAEMON_LIVENESS_OWNER_IS_PROXY_CODE,
    error: `Session ${session.sessionId} is owned by an MCP proxy, which is the only liveness owner for its sessions, so this heartbeat was rejected and nothing changed. The external heartbeat keeper is for one-shot CLI sessions only. Let the harness's proxy keep the session alive and check its state with \`--daemon session-info ${session.sessionId}\`.`,
  };
}

/**
 * Owner decision 2026-10-09 (#11096): an external `--daemon heartbeat` keeper adds nothing to a
 * `cli-idle` session — its idle window runs from tool calls, not heartbeats, and it never holds a
 * live owner lease — while every one-shot `--cli` call re-claims its liveness, so a keeper that
 * claimed it was displaced by the next call and failed its next tick. A keeper heartbeat on such
 * a session is therefore a successful no-op: it neither claims liveness ownership nor touches the
 * session. Sessions on the strict heartbeat contract keep the keeper's existing behaviour.
 */
function isCliKeeperOnCliIdleSession(
  livenessOwnerKind: string | undefined,
  session: Session,
): boolean {
  return (
    livenessOwnerKind === CLI_KEEPER_LIVENESS_OWNER_KIND && session.livenessPolicy === "cli-idle"
  );
}

function cliKeeperNoopAck(sessionId: string): DaemonMethodResult {
  return {
    success: true,
    result: { sessionId, livenessPolicy: "cli-idle", livenessUnchanged: true },
  };
}

/**
 * Verify the resolved ownership outcome at the synchronous heartbeat mutation boundary.
 * Returns the failure to answer with, or undefined
 * when the token owns the session. A rejected claim is a complete liveness
 * no-op: it cannot change the owner, restore a policy, or extend
 * lastUsedAt/lastHeartbeat/expiresAt (#10050).
 */
function rejectHeartbeatWithoutOwnership(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  session: Session,
  sessionId: string,
  livenessOwnerToken: string,
  outcome: LivenessClaimOutcome,
): DaemonMethodResult | undefined {
  // A claim can yield while release ends admission or replaces this UUID.
  // Keep the request bound to the device session admitted above.
  const currentSession = manager.getSession(sessionId);
  if (
    outcome === "not-found" ||
    !currentSession ||
    currentSession !== session ||
    isSessionReleasing(manager, sessionId, currentSession)
  ) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
      code: DAEMON_SESSION_NOT_FOUND_CODE,
    };
  }
  const stillOwns =
    manager.hasLivenessOwnership?.(sessionId, livenessOwnerToken) ??
    currentSession.livenessOwnerToken === livenessOwnerToken;
  return livenessOwnershipFailure(
    outcome === "claimed" && !stillOwns ? "superseded" : outcome,
    sessionId,
    currentSession.livenessOwnerToken !== undefined,
    () => manager.getOwnerLeaseHold?.(sessionId),
  );
}

async function resolveLivenessOwnership(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  livenessOwnerToken: string,
  claimsLivenessOwnership: boolean,
): Promise<LivenessClaimOutcome> {
  if (claimsLivenessOwnership) {
    return (await manager.claimLivenessOwnership?.(sessionId, livenessOwnerToken)) ?? "superseded";
  }
  const ownsLiveness =
    (manager.hasLivenessOwnership?.(sessionId, livenessOwnerToken) ?? false) ||
    (manager.claimUnownedLivenessOwnership?.(sessionId, livenessOwnerToken) ?? false);
  return ownsLiveness ? "claimed" : "superseded";
}

function livenessOwnershipFailure(
  outcome: LivenessClaimOutcome,
  sessionId: string,
  hasOwner: boolean,
  ownerHold: () => LivenessOwnerHold | undefined,
): DaemonMethodResult | undefined {
  if (outcome === "conflict") {
    const liveness = ownerHold();
    return {
      success: false,
      code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
      error: `Session ${sessionId} is owned by another liveness owner whose lease is still live, so this claim was rejected and nothing changed. Retry after the owner's lease expires, or claim with the owner's stable token.`,
      // How long the owner's hold lasts, so a challenger waits out the daemon's lease rather than
      // its own idea of it (#10701).
      ...(liveness ? { result: { liveness } } : {}),
    };
  }
  if (outcome === "superseded" && !hasOwner) {
    return {
      success: false,
      code: DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
      error: `Session ${sessionId}'s liveness is unowned. Explicitly claim ownership before sending keeper ticks; nothing changed.`,
    };
  }
  if (outcome === "superseded") {
    return {
      success: false,
      code: DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
      error: `The token no longer owns session ${sessionId}'s liveness. Another token has claimed it since. Re-claim with a fresh token and --claim-liveness-ownership once that owner's lease expires, or stop the keeper.`,
    };
  }
  return undefined;
}

async function handleRefreshDevices(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const pool = state.getDevicePool();
  const outcome = pool.refreshDevicesWithOutcome
    ? await pool.refreshDevicesWithOutcome()
    : { addedCount: await pool.refreshDevices() };
  if (outcome.failure !== undefined) {
    return {
      success: false,
      error: `Could not refresh device list: ${outcome.failure}. Resolve the cause and retry.`,
    };
  }
  const stats = pool.getStats();
  return {
    success: true,
    result: {
      addedDevices: outcome.addedCount,
      totalDevices: stats.total,
      availableDevices: stats.idle,
      stats,
    },
  };
}

async function handleAvailableDevices(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const pool = state.getDevicePool();
  const stats = pool.getStats();
  const recoveryPolicy = pool.getRecoveryPolicy?.();
  const devices = pool.getAllDevices?.().map((device) => ({
    deviceId: device.id,
    platform: device.platform,
    recoveryEligibility: pool.getRecoveryEligibility?.(device.id),
    ...(pool.getDeviceHealthMarker?.(device.id)
      ? { unhealthy: pool.getDeviceHealthMarker(device.id) }
      : {}),
  }));
  return {
    success: true,
    result: {
      availableDevices: stats.idle,
      totalDevices: stats.total,
      assignedDevices: stats.assigned,
      errorDevices: stats.error,
      stats,
      ...(recoveryPolicy ? { recoveryPolicy } : {}),
      ...(devices ? { devices } : {}),
    },
  };
}

/** Per-session in-flight execution count for the hold diagnostics (#10671). */
export interface SessionExecutionCounter {
  getActiveDeviceSessionExecutionCount(sessionUuid: string): number;
}

export async function handleSessionInfo(
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions: SessionExecutionCounter = executionTracker,
): Promise<DaemonMethodResult> {
  const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error: "sessionId parameter required",
    };
  }
  const manager = state.getSessionManager();
  const session = manager.getSession(sessionId);
  if (!session) {
    return sessionNotFoundResult(manager, sessionId);
  }
  return {
    success: true,
    result: {
      sessionId: session.sessionId,
      assignedDevice: session.assignedDevice,
      platform: session.platform,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      cacheSize: JSON.stringify(session.cacheData).length,
      ...sessionHoldDiagnostics(
        session,
        executions.getActiveDeviceSessionExecutionCount(sessionId),
        manager.getIdleReleaseExecutionVeto?.(sessionId),
        (ms) => manager.sessionClockToWall?.(ms) ?? ms,
      ),
      ...livenessInfo(manager.getSessionLeaseState?.(sessionId)),
      ...(isSessionReleasing(manager, sessionId, session) ? { releasing: true } : {}),
    },
  };
}

/**
 * Additive `liveness` field for `session-info` (#10051): `state` is `live`, or
 * `suspect` while the owner's lease has expired and the session is held for its
 * grace window; `remainingMs` counts down the lease (live) or the grace (suspect).
 */
function livenessInfo(
  lease: LivenessLeaseState | undefined,
): { liveness: { state: LivenessLeasePhase; remainingMs: number } } | Record<string, never> {
  return lease ? { liveness: { state: lease.phase, remainingMs: lease.remainingMs } } : {};
}

export async function handleActiveSessions(
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions: SessionExecutionCounter & { getActiveExecutionCount(): number } = executionTracker,
): Promise<DaemonMethodResult> {
  const manager = state.getSessionManager();
  const sessions = manager.getAllSessions?.() ?? [];
  const releasingSessions = sessions.filter((session) =>
    isSessionReleasing(manager, session.sessionId, session),
  ).length;
  // Who holds which device and why (#10671). Opt-in, so the counts-only reply busy checks poll
  // stays as small as it was.
  const includeSessions =
    (request.params as { includeSessions?: unknown } | undefined)?.includeSessions === true;
  return {
    success: true,
    result: {
      activeSessions: sessions.length,
      activeExecutions: executions.getActiveExecutionCount(),
      ...(releasingSessions > 0 ? { releasingSessions } : {}),
      ...(includeSessions
        ? {
            sessions: sessions.map((session) => ({
              sessionId: session.sessionId,
              assignedDevice: session.assignedDevice,
              platform: session.platform,
              ...sessionHoldDiagnostics(
                session,
                executions.getActiveDeviceSessionExecutionCount(session.sessionId),
                manager.getIdleReleaseExecutionVeto?.(session.sessionId),
                (ms) => manager.sessionClockToWall?.(ms) ?? ms,
              ),
              ...(isSessionReleasing(manager, session.sessionId, session)
                ? { releasing: true }
                : {}),
            })),
          }
        : {}),
    },
  };
}

async function handleReleaseSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions?: SessionExecutionCanceller,
): Promise<DaemonMethodResult> {
  const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error: "sessionId parameter required",
    };
  }
  const manager = state.getSessionManager();
  const session = manager.getSession(sessionId) ?? manager.getReleasingSession?.(sessionId);
  if (!session && !manager.hasSession(sessionId)) {
    if (typeof sessionId === "string" && state.getObserverSessionRegistry?.()?.release(sessionId)) {
      return {
        success: true,
        result: {
          message: `Session ${sessionId} released`,
          alreadyReleased: false,
        },
      };
    }
    // Session doesn't exist - treat as already released (idempotent)
    // This happens when daemon auto-releases after executePlan completes
    return {
      success: true,
      result: {
        message: `Session ${sessionId} already released or never existed`,
        alreadyReleased: true,
      },
    };
  }
  return releaseBoundSession(state, manager, sessionId, session, executions);
}

async function releaseBoundSession(
  state: DaemonStateAccess,
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  session: Session | null | undefined,
  executions: SessionExecutionCanceller = executionTracker,
): Promise<DaemonMethodResult> {
  const pool = state.getDevicePool();
  // A failed terminal write hides routing identity while retaining ownership.
  let deviceId =
    session?.assignedDevice ?? manager.getTerminalReleaseSnapshot?.(sessionId)?.deviceId ?? null;
  const release = () =>
    releaseSessionAndDevice(manager, pool, deviceId, sessionId, undefined, {
      release: async () => {
        deviceId = await manager.releaseSession(sessionId);
        return deviceId;
      },
    });
  // Preserve the idle path's timing: no cancellation await when there is no work.
  await (executions.hasActiveSessionUuidExecutions(sessionId)
    ? cancelAndReleaseSession(sessionId, "explicit-release", release, executions)
    : release());
  return {
    success: true,
    result: {
      message: `Session ${sessionId} released`,
      device: deviceId,
      alreadyReleased: false,
    },
  };
}

async function handleListDeviceSessions(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const registry = state.getDeviceSessionRegistry();
  const pool = state.getDevicePool();
  const deviceSessions: ListedDeviceSessionRecord[] = registry.list().map((record) => ({
    deviceSessionUuid: record.deviceSessionUuid,
    deviceId: record.deviceId,
    platform: record.platform,
    epochStartedAt: record.epochStartedAt,
    ...(pool.getDeviceHealthMarker?.(record.deviceId)
      ? { unhealthy: pool.getDeviceHealthMarker(record.deviceId) }
      : {}),
    ...(pool.isPooledIdentityUnresolved?.(record.deviceId) === true
      ? { identityUnresolved: true as const }
      : {}),
  }));
  return {
    success: true,
    result: {
      deviceSessions,
      totalDeviceSessions: deviceSessions.length,
    },
  };
}

/**
 * Report whether this daemon still uses a device, so another AutoMobile process
 * can decide whether to take over its CtrlProxy forwarding lease (#10497).
 */
async function handleDeviceLeaseStatus(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const parsed = z.object({ deviceId: z.string().min(1) }).safeParse(request.params);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid deviceLeaseStatus parameters: ${parsed.error.message}`,
    };
  }
  const { deviceId } = parsed.data;
  const manager = state.getSessionManager();
  const sources =
    state.getDeviceLeaseActivitySources?.() ??
    daemonDeviceLeaseActivitySources((id) => manager.getSessionForDevice?.(id) ?? null);
  return {
    success: true,
    result: {
      pid: process.pid,
      deviceId,
      ...readDeviceLeaseActivity(sources, deviceId),
    },
  };
}

/**
 * Give up this daemon's CtrlProxy forwarding lease on a device when it no longer
 * uses it, so another AutoMobile process can take it (#10497). The use check and
 * the release start in one synchronous step, so a tool call or CtrlProxy request
 * this daemon begins afterwards cannot lose the lease to the requester; it builds
 * a fresh client that competes for the lease again (#10506 review).
 */
async function handleRelinquishDeviceLease(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const parsed = z.object({ deviceId: z.string().min(1) }).safeParse(request.params);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid relinquishDeviceLease parameters: ${parsed.error.message}`,
    };
  }
  const { deviceId } = parsed.data;
  const manager = state.getSessionManager();
  const sources =
    state.getDeviceLeaseActivitySources?.() ??
    daemonDeviceLeaseActivitySources((id) => manager.getSessionForDevice?.(id) ?? null);
  const port = state.getDeviceLeaseRelinquishPort?.() ?? daemonDeviceLeaseRelinquishPort();
  const status = { pid: process.pid, deviceId, ...readDeviceLeaseActivity(sources, deviceId) };
  const decision = decideOwnerRelinquish(status, port.idleMs);
  if (!decision.release) {
    return {
      success: true,
      result: {
        ...status,
        released: false,
        reason: decision.reason,
        ...(decision.transient ? { transient: true } : {}),
      },
    };
  }
  // No await between the use check above and this call: release evicts the
  // device's client synchronously before its first await.
  await port.release(deviceId);
  return { success: true, result: { ...status, released: true, reason: decision.reason } };
}
