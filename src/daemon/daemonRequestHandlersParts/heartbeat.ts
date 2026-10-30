import { isSessionReleasing } from "../sessionReleaseState";
import { z } from "zod";
import { type ObserverSessionStore } from "../observerSessionRegistry";
import {
  DAEMON_INSTANCE_CHANGED_CODE,
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_IS_PROXY_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
  DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
  DaemonRequest,
} from "../types";
import { type LivenessClaimOutcome, Session } from "../sessionManager";
import { sessionForIngress } from "../sessionForIngress";
import type { LivenessOwnerHold } from "../livenessOwnerLease";
import {
  CLI_KEEPER_LIVENESS_OWNER_KIND,
  CLI_SESSION_LIVENESS_POLICY,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
} from "../wire/constants";
import { vetoedIdleReleaseAt } from "../sessionHoldDiagnostics";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../models/managedExecutionLiveness";
import { holdsOwnerHeartbeatLease } from "../sessionBroker/provisioning/executionLiveness";
import type { DaemonStateAccess, DaemonMethodResult } from "./contracts";
import {
  reportedWallClock,
  sessionNotFoundResult,
  notFoundResult,
  lookupReleasedSessionReason,
} from "./sessionReporting";

/**
 * Identifies this daemon process. A restarted daemon reports a different value, so a proxy can
 * tell a daemon that resumed after a stall from a new one (#10989).
 */
const DAEMON_PROCESS_INSTANCE = `${process.pid}:${performance.timeOrigin}`;

export async function handleReleaseLivenessOwnership(
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
        lastUsedAt: reportedWallClock(manager, session.lastUsedAt),
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

/** What a heartbeat for a session the daemon no longer holds resolves to. */
export type HeartbeatMiss =
  | { kind: "observer" }
  | { kind: "notFound"; recordedReason: string | undefined };

/**
 * The one rule both heartbeat routes (socket and HTTP) apply to an unknown, released or releasing
 * session id (#11819): a token-bearing owner's heartbeat is still credited to the release in
 * flight, a live observer session is acknowledged, and anything else is not found, with the
 * recorded release reason when the daemon knows why. Order matters: credit, observer, lookup.
 */
export async function resolveHeartbeatMiss(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  observers: Pick<ObserverSessionStore, "heartbeat"> | undefined,
  sessionId: string,
  creditOwnerToken: string | undefined,
): Promise<HeartbeatMiss> {
  if (creditOwnerToken !== undefined) {
    manager.creditOwnerHeartbeatDuringRelease?.(sessionId, creditOwnerToken);
  }
  if (observers?.heartbeat(sessionId)) {
    return { kind: "observer" };
  }
  return {
    kind: "notFound",
    recordedReason: await lookupReleasedSessionReason(manager, sessionId),
  };
}

export async function handleHeartbeat(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const heartbeatParams = parseHeartbeatParams(request);
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
  const ackReport = heartbeatAckReport(heartbeatParams, daemonInstance);
  const manager = state.getSessionManager();
  const session = sessionForIngress(manager, sessionId);
  if (!session || isSessionReleasing(manager, sessionId, session)) {
    return heartbeatMiss(state, manager, sessionId, { params: heartbeatParams, report: ackReport });
  }
  const context = { manager, session, sessionId, params: heartbeatParams, report: ackReport };
  return heartbeatOwnership(context);
}

function parseHeartbeatParams(request: DaemonRequest) {
  return request.params as
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
}

interface HeartbeatContext {
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>;
  session: Session;
  sessionId: string;
  params: ReturnType<typeof parseHeartbeatParams>;
  report: HeartbeatAckReport;
}

async function heartbeatMiss(
  state: DaemonStateAccess,
  manager: HeartbeatContext["manager"],
  sessionId: string,
  { params: heartbeatParams, report: ackReport }: Pick<HeartbeatContext, "params" | "report">,
): Promise<DaemonMethodResult> {
  const miss = await resolveHeartbeatMiss(
    manager,
    state.getObserverSessionRegistry?.(),
    sessionId,
    typeof heartbeatParams?.livenessOwnerToken === "string"
      ? heartbeatParams.livenessOwnerToken
      : undefined,
  );
  if (miss.kind === "observer") {
    return { success: true, result: { sessionId } };
  }
  return notFoundResult(sessionId, miss.recordedReason, ackReport.daemonInstance);
}

function heartbeatOwnershipGuard(ctx: HeartbeatContext): DaemonMethodResult | undefined {
  return (
    refuseCliKeeperOnProxySession(ctx.params?.livenessOwnerKind, ctx.session) ??
    (isCliKeeperOnCliIdleSession(ctx.params?.livenessOwnerKind, ctx.session)
      ? cliKeeperNoopAck(ctx.sessionId)
      : undefined)
  );
}

async function heartbeatOwnership(ctx: HeartbeatContext): Promise<DaemonMethodResult> {
  const { manager, sessionId, report } = ctx;
  const refusal = heartbeatOwnershipGuard(ctx);
  if (refusal) {
    return refusal;
  }
  const token = heartbeatOwnerToken(ctx.params);
  const claimsOwnership = ctx.params?.claimLivenessOwnership === true;
  if (!token && isTokenOwnedOrClaimPending(ctx.session)) {
    // After an ownership claim, tokenless clients cannot change policy or deadlines.
    return { success: true, result: { sessionId } };
  }
  if (token) {
    // Renew only the current owner before awaiting a claim, preventing expiry races (#11321, #10050).
    if (manager.hasLivenessOwnership?.(sessionId, token)) {
      manager.recordHeartbeat?.(sessionId);
    }
    const outcome = await resolveLivenessOwnership(manager, sessionId, token, claimsOwnership);
    // Revalidate ownership synchronously before changing policy or recording the heartbeat.
    const rejection = heartbeatOwnershipRejection(ctx, token, outcome);
    if (rejection) {
      return rejection;
    }
    if (!claimsOwnership) {
      // Recurring keepers renew; only explicit claims change policy.
      manager.recordHeartbeat?.(sessionId);
      return heartbeatAck(manager, sessionId, report);
    }
  }
  return applyHeartbeatPolicy(ctx);
}

function heartbeatOwnershipRejection(
  ctx: HeartbeatContext,
  token: string,
  outcome: Awaited<ReturnType<typeof resolveLivenessOwnership>>,
): DaemonMethodResult | Promise<DaemonMethodResult> | undefined {
  const { manager, sessionId, report } = ctx;
  const rejection = rejectHeartbeatWithoutOwnership(manager, ctx.session, sessionId, {
    livenessOwnerToken: token,
    outcome,
  });
  if (rejection?.code === DAEMON_SESSION_NOT_FOUND_CODE) {
    // Name the release that ended this claim without recording anything afterward (#11646).
    return sessionNotFoundResult(manager, sessionId, report.daemonInstance);
  }
  if (rejection) {
    // A concurrent CLI claim can switch to cli-idle; its keeper must still no-op.
    const current = sessionForIngress(manager, sessionId);
    return rejection.code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE &&
      current &&
      isCliKeeperOnCliIdleSession(ctx.params?.livenessOwnerKind, current)
      ? cliKeeperNoopAck(sessionId)
      : rejection;
  }
  return undefined;
}

function applyHeartbeatPolicy(ctx: HeartbeatContext): DaemonMethodResult {
  const { manager, sessionId, report } = ctx;
  const cliAck = applyCliHeartbeatPolicy(ctx);
  if (cliAck) {
    return cliAck;
  }
  if (
    ctx.params?.livenessPolicy === HEARTBEAT_SESSION_LIVENESS_POLICY ||
    ctx.params?.livenessPolicy === undefined
  ) {
    // Restore the proxy's strict contract after CLI use; restoration also records the heartbeat (#6870).
    if (manager.restoreHeartbeatLivenessPolicy?.(sessionId)) {
      return heartbeatAck(manager, sessionId, report, {
        livenessPolicy: HEARTBEAT_SESSION_LIVENESS_POLICY,
      });
    }
  }
  manager.recordHeartbeat?.(sessionId);
  return heartbeatAck(manager, sessionId, report);
}

/** What a heartbeat asked its acknowledgement to report besides the session id. */
interface HeartbeatAckReport {
  idleRelease: boolean;
  /** This daemon's process instance, when the heartbeat asked for it (#10989). */
  daemonInstance?: string;
}

/** Refuse another daemon's heartbeat before mutation, so probes cannot adopt a restart (#10989). */
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
 * Opt-in idleReleaseAt matches session-info's vetoed daemon wall clock without extending it (#10823).
 * Tool activity alone moves idle deadlines; managed executions with a live owner lease report null.
 */
function heartbeatAck(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  report: HeartbeatAckReport,
  extra: Record<string, unknown> = {},
): DaemonMethodResult {
  const session = sessionForIngress(manager, sessionId);
  const instance =
    report.daemonInstance === undefined ? {} : { daemonInstance: report.daemonInstance };
  const idleDeadline =
    report.idleRelease && session
      ? vetoedIdleReleaseAt(
          session,
          manager.getIdleReleaseExecutionVeto?.(sessionId),
          manager.getSessionLeaseState?.(sessionId)?.phase,
        )
      : null;
  const idle =
    report.idleRelease && session
      ? {
          idleReleaseAt: idleDeadline === null ? null : reportedWallClock(manager, idleDeadline),
        }
      : {};
  return { success: true, result: { sessionId, ...extra, ...idle, ...instance } };
}

/** Proxy tokens claim heartbeat policy; one-shot CLI owners use cli-idle. */
function isProxyOwnedSession(session: Session): boolean {
  return (
    holdsOwnerHeartbeatLease(session.livenessPolicy) && session.livenessOwnerToken !== undefined
  );
}

/** Refuse marked CLI keepers on proxy sessions before any ownership/policy mutation (#10054). */
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
 * Owner decision 2026-10-09 (#11096): CLI-idle keepers succeed without touching or claiming sessions;
 * only tool calls move their idle windows, and each CLI call reclaims ownership. Strict leases retain
 * keeper behavior, while this no-op prevents the next CLI call from displacing an unnecessary claim.
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
 * Revalidate ownership at the synchronous mutation boundary; undefined means ownership is valid.
 * Rejected claims cannot change ownership, policy, lastUsedAt/lastHeartbeat/expiresAt (#10050).
 */
function rejectHeartbeatWithoutOwnership(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  session: Session,
  sessionId: string,
  { livenessOwnerToken, outcome }: { livenessOwnerToken: string; outcome: LivenessClaimOutcome },
): DaemonMethodResult | undefined {
  // A claim can yield while release ends admission or replaces this UUID.
  // Keep the request bound to the device session admitted above.
  const currentSession = sessionForIngress(manager, sessionId);
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

function heartbeatAckReport(
  heartbeatParams: ReturnType<typeof parseHeartbeatParams>,
  daemonInstance: string,
): HeartbeatAckReport {
  return {
    idleRelease: heartbeatParams?.reportIdleRelease === true,
    ...(heartbeatParams?.reportDaemonInstance === true ? { daemonInstance } : {}),
  };
}

function heartbeatOwnerToken(
  heartbeatParams: ReturnType<typeof parseHeartbeatParams>,
): string | undefined {
  return typeof heartbeatParams?.livenessOwnerToken === "string" &&
    heartbeatParams.livenessOwnerToken.length > 0
    ? heartbeatParams.livenessOwnerToken
    : undefined;
}

function applyCliHeartbeatPolicy(ctx: HeartbeatContext): DaemonMethodResult | undefined {
  // One-shot CLI use widens idle policy; proxy heartbeats restore the strict contract (#6870).
  if (
    ctx.params?.livenessPolicy === CLI_SESSION_LIVENESS_POLICY &&
    sessionForIngress(ctx.manager, ctx.sessionId)?.livenessPolicy ===
      MANAGED_EXECUTION_LIVENESS_POLICY
  ) {
    // Managed executions retain their owner lease and report the unchanged policy (#11176).
    ctx.manager.recordHeartbeat?.(ctx.sessionId);
    return heartbeatAck(ctx.manager, ctx.sessionId, ctx.report, {
      livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY,
      livenessUnchanged: true,
    });
  }
  if (ctx.params?.livenessPolicy === CLI_SESSION_LIVENESS_POLICY) {
    // Revalidate this invocation's timeout; a running daemon cannot reread its override (#6870).
    ctx.manager.adoptCliLivenessPolicy?.(ctx.sessionId, ctx.params.idleTimeoutMs);
    // Reports the idle instant like every other ack when asked (#10972).
    return heartbeatAck(ctx.manager, ctx.sessionId, ctx.report, {
      livenessPolicy: "cli-idle",
      idleTimeoutMs: sessionForIngress(ctx.manager, ctx.sessionId)?.heartbeatTimeoutMs,
    });
  }
  return undefined;
}
