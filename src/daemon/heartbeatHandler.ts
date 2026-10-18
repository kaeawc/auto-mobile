import { DAEMON_PROCESS_INSTANCE, reportedWallClock } from "./daemonInstanceClock";
import type { DaemonMethodResult, DaemonStateAccess } from "./daemonRequestHandlers";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import {
  DAEMON_INSTANCE_CHANGED_CODE,
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_IS_PROXY_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
  DaemonRequest,
  releasedSessionNotFoundFields,
} from "./types";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { sessionForIngress } from "./sessionForIngress";
import { isSessionReleasing } from "./sessionReleaseState";
import { Session, type LivenessClaimOutcome } from "./sessionManager";
import {
  CLI_KEEPER_LIVENESS_OWNER_KIND,
  CLI_SESSION_LIVENESS_POLICY,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
} from "./constants";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../models/managedExecutionLiveness";
import { vetoedIdleReleaseAt } from "./sessionHoldDiagnostics";
import { holdsOwnerHeartbeatLease } from "./sessionBroker/provisioning/executionLiveness";
import type { LivenessOwnerHold } from "./livenessOwnerLease";

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

/**
 * Session-not-found answer. A session the daemon knows it released also says why
 * (`releaseReason`, #10730; `idle: true` for an idle-window release, #10832) so a client can tell
 * an idle release from a restart or lapsed owner;
 * a UUID the daemon never issued stays a plain not-found.
 */
export async function sessionNotFoundResult(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  daemonInstance?: string,
): Promise<DaemonMethodResult> {
  return notFoundResult(
    sessionId,
    await lookupReleasedSessionReason(manager, sessionId),
    daemonInstance,
  );
}

function notFoundResult(
  sessionId: string,
  releaseReason: string | undefined,
  daemonInstance?: string,
): DaemonMethodResult {
  return {
    success: false,
    error: `Session not found: ${sessionId}`,
    code: DAEMON_SESSION_NOT_FOUND_CODE,
    ...releasedSessionNotFoundFields(releaseReason),
    ...(daemonInstance !== undefined ? { daemonInstance } : {}),
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

interface HeartbeatParams {
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

type HeartbeatSessionManager = ReturnType<DaemonStateAccess["getSessionManager"]>;

export async function handleHeartbeat(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const heartbeatParams = request.params as HeartbeatParams | undefined;
  const preflight = heartbeatPreflight(heartbeatParams, state);
  if ("refusal" in preflight) {
    return preflight.refusal;
  }
  const { sessionId, ackReport } = preflight;
  const manager = state.getSessionManager();
  const session = sessionForIngress(manager, sessionId);
  if (!session || isSessionReleasing(manager, sessionId, session)) {
    return heartbeatForMissingSession(manager, state, sessionId, heartbeatParams, ackReport);
  }
  const keeperAnswer = heartbeatKeeperAnswer(heartbeatParams?.livenessOwnerKind, session);
  if (keeperAnswer) {
    return keeperAnswer;
  }
  const livenessOwnerToken = nonEmptyOwnerToken(heartbeatParams?.livenessOwnerToken);
  if (!livenessOwnerToken && isTokenOwnedOrClaimPending(session)) {
    // Tokenless clients predate liveness ownership. Keep them compatible
    // only until a token-bearing owner has claimed this session; afterward
    // they are stale by definition and must not change policy or deadlines.
    return { success: true, result: { sessionId } };
  }
  if (livenessOwnerToken) {
    const ownerResult = await heartbeatFromLivenessOwner(
      manager,
      session,
      heartbeatParams,
      livenessOwnerToken,
      ackReport,
    );
    if (ownerResult) {
      return ownerResult;
    }
  }
  return applyHeartbeatLivenessPolicy(manager, sessionId, heartbeatParams, ackReport);
}

/** Validates the request itself: a session id, and a daemon instance this daemon answers for. */
function heartbeatPreflight(
  heartbeatParams: HeartbeatParams | undefined,
  state: DaemonStateAccess,
): { refusal: DaemonMethodResult } | { sessionId: string; ackReport: HeartbeatAckReport } {
  const sessionId = heartbeatParams?.sessionId;
  if (!sessionId) {
    return { refusal: { success: false, error: "sessionId parameter required" } };
  }
  const daemonInstance = state.getDaemonInstance?.() ?? DAEMON_PROCESS_INSTANCE;
  const instanceRefusal = refuseOtherDaemonInstance(
    heartbeatParams?.expectedDaemonInstance,
    daemonInstance,
    sessionId,
  );
  if (instanceRefusal) {
    return { refusal: instanceRefusal };
  }
  return {
    sessionId,
    ackReport: {
      idleRelease: heartbeatParams?.reportIdleRelease === true,
      ...(heartbeatParams?.reportDaemonInstance === true ? { daemonInstance } : {}),
    },
  };
}

/** A `--cli` keeper heartbeat that must not touch this session: refused, or a no-op ack. */
function heartbeatKeeperAnswer(
  livenessOwnerKind: string | undefined,
  session: Session,
): DaemonMethodResult | undefined {
  const keeperRefusal = refuseCliKeeperOnProxySession(livenessOwnerKind, session);
  if (keeperRefusal) {
    return keeperRefusal;
  }
  return isCliKeeperOnCliIdleSession(livenessOwnerKind, session)
    ? cliKeeperNoopAck(session.sessionId)
    : undefined;
}

function nonEmptyOwnerToken(token: unknown): string | undefined {
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

async function heartbeatForMissingSession(
  manager: HeartbeatSessionManager,
  state: DaemonStateAccess,
  sessionId: string,
  heartbeatParams: HeartbeatParams | undefined,
  ackReport: HeartbeatAckReport,
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

/**
 * A token-bearing heartbeat: resolves ownership and answers when it ends the heartbeat (a
 * rejection, or a verified keeper tick). Undefined means the heartbeat carries an explicit claim
 * and continues into the liveness-policy step.
 */
async function heartbeatFromLivenessOwner(
  manager: HeartbeatSessionManager,
  session: Session,
  heartbeatParams: HeartbeatParams | undefined,
  livenessOwnerToken: string,
  ackReport: HeartbeatAckReport,
): Promise<DaemonMethodResult | undefined> {
  const sessionId = session.sessionId;
  const claimsLivenessOwnership = heartbeatParams?.claimLivenessOwnership === true;
  // The current owner's heartbeat renews its lease on arrival, before ownership resolves across
  // an await (#11321). A control call arriving right behind it would otherwise read the lapsed
  // lease, release the session, and leave this heartbeat answered "not found". Only the token
  // that already owns the session is stamped here, so a rejected claim stays a no-op (#10050).
  if (manager.hasLivenessOwnership?.(sessionId, livenessOwnerToken)) {
    manager.recordHeartbeat?.(sessionId);
  }
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
    return answerHeartbeatRejection(
      manager,
      sessionId,
      rejection,
      heartbeatParams?.livenessOwnerKind,
      ackReport,
    );
  }
  if (!claimsLivenessOwnership) {
    // A verified keeper proves only that its current owner is still
    // alive. Policy changes are explicit claims, never recurring ticks.
    manager.recordHeartbeat?.(sessionId);
    return heartbeatAck(manager, sessionId, ackReport);
  }
  return undefined;
}

async function answerHeartbeatRejection(
  manager: HeartbeatSessionManager,
  sessionId: string,
  rejection: DaemonMethodResult,
  livenessOwnerKind: string | undefined,
  ackReport: HeartbeatAckReport,
): Promise<DaemonMethodResult> {
  if (rejection.code === DAEMON_SESSION_NOT_FOUND_CODE) {
    // The release that ended the session while the claim was resolving is named like on every
    // other not-found answer (#11646); the lookup changes nothing and nothing is recorded after.
    return sessionNotFoundResult(manager, sessionId, ackReport.daemonInstance);
  }
  // A concurrent `--cli` call can move the session onto the cli-idle policy (claiming it
  // with its own token) while the keeper's claim was resolving; the keeper still no-ops.
  const current = sessionForIngress(manager, sessionId);
  return rejection.code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE &&
    current &&
    isCliKeeperOnCliIdleSession(livenessOwnerKind, current)
    ? cliKeeperNoopAck(sessionId)
    : rejection;
}

function applyHeartbeatLivenessPolicy(
  manager: HeartbeatSessionManager,
  sessionId: string,
  heartbeatParams: HeartbeatParams | undefined,
  ackReport: HeartbeatAckReport,
): DaemonMethodResult {
  const livenessPolicy = heartbeatParams?.livenessPolicy;
  // A one-shot `--cli` client declares itself here (issue #6870) so the
  // daemon stops holding its session to the 10 s heartbeat contract no
  // one-shot process can keep. An unmarked Desktop heartbeat restores that
  // strict contract when a prior CLI invocation widened the same session.
  if (livenessPolicy === CLI_SESSION_LIVENESS_POLICY) {
    return adoptCliHeartbeatPolicy(manager, sessionId, heartbeatParams, ackReport);
  }
  if (
    (livenessPolicy === HEARTBEAT_SESSION_LIVENESS_POLICY || livenessPolicy === undefined) &&
    // A long-lived stdio/HTTP proxy CAN keep the strict contract and says so
    // on every heartbeat, so a session a previous `--cli` invocation moved
    // onto the minutes-long idle window goes back to it (issue #6870
    // review) instead of holding its device for that window after this
    // client disconnects.
    // `restoreHeartbeatLivenessPolicy` records the heartbeat itself as part
    // of re-stamping the deadlines off the restored timeouts.
    manager.restoreHeartbeatLivenessPolicy?.(sessionId)
  ) {
    return heartbeatAck(manager, sessionId, ackReport, {
      livenessPolicy: HEARTBEAT_SESSION_LIVENESS_POLICY,
    });
  }
  manager.recordHeartbeat?.(sessionId);
  return heartbeatAck(manager, sessionId, ackReport);
}

function adoptCliHeartbeatPolicy(
  manager: HeartbeatSessionManager,
  sessionId: string,
  heartbeatParams: HeartbeatParams | undefined,
  ackReport: HeartbeatAckReport,
): DaemonMethodResult {
  if (sessionForIngress(manager, sessionId)?.livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY) {
    // A managed execution's session stays on its owner lease (#11176): the CLI declaration is
    // refused, and the ack says which policy still governs the session.
    manager.recordHeartbeat?.(sessionId);
    return heartbeatAck(manager, sessionId, ackReport, {
      livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY,
      livenessUnchanged: true,
    });
  }
  // The invocation carries its own resolved idle timeout: it reuses a
  // running daemon, whose process env was read at startup and cannot
  // reflect this invocation's override (issue #6870 review). The manager
  // re-validates and bounds it.
  manager.adoptCliLivenessPolicy?.(sessionId, heartbeatParams?.idleTimeoutMs);
  // Reports the idle instant like every other ack when asked (#10972).
  return heartbeatAck(manager, sessionId, ackReport, {
    livenessPolicy: "cli-idle",
    idleTimeoutMs: sessionForIngress(manager, sessionId)?.heartbeatTimeoutMs,
  });
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
 * by the daemon's clock instead of its own (#10823). A numerical idle deadline moves only with
 * tool activity; a managed execution reports null while its judged owner lease is non-lapsed.
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

/**
 * A proxy owns a session when a token has claimed it under the strict heartbeat policy: stdio/HTTP
 * proxies claim with `heartbeat`, while one-shot `--cli` owners move the session to `cli-idle`.
 */
function isProxyOwnedSession(session: Session): boolean {
  return (
    holdsOwnerHeartbeatLease(session.livenessPolicy) && session.livenessOwnerToken !== undefined
  );
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
