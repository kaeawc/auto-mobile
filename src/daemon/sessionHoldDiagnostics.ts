/**
 * Why a device session still holds its device (#10671).
 *
 * `session-info` used to report only `lastUsedAt` and `expiresAt`, which could
 * not tell an idle-but-live owner from an active one, and named no holder. These
 * fields separate tool activity from owner liveness, give the moment idle release
 * is due, and say what kind of client holds the session.
 *
 * Pure functions of a session snapshot so the socket handlers and the CLI print
 * the same answer.
 */

import { suspectGraceMsFor } from "./livenessOwnerLease";
import { effectiveLastToolActivity } from "./sessionClocks";
import type { Session } from "./sessionManager";
import { unsettledExecutionVetoExpiresAt } from "./unsettledExecutionVeto";

/** The kind of client holding a device session. */
export type SessionHolderKind = "stdio-proxy" | "desktop" | "ide" | "cli" | "junit" | "unknown";

export interface SessionHoldDiagnostics {
  /** End (or start, while one is in flight) of the session's last tool call. */
  lastToolActivityAt: number;
  /** The owner's last heartbeat, or null when no owner has heartbeated yet. */
  lastOwnerHeartbeatAt: number | null;
  /**
   * When idle release is due: past this instant the next idle sweep releases the
   * session unless a new tool call arrives first. While a call is in flight its
   * veto pushes this out to the shared unsettled-execution bound (#10712, #10713):
   * the call's request deadline plus grace, or the fallback ceiling past the idle
   * deadline when some call has no deadline.
   */
  idleReleaseAt: number;
  holderKind: SessionHolderKind;
  /** Tool executions in flight on this session; idle release waits for them. */
  activeExecutions: number;
}

export type SessionHoldSnapshot = Pick<
  Session,
  | "lastUsedAt"
  | "idleStallForgivenAt"
  | "lastOwnerHeartbeat"
  | "expiresAt"
  | "livenessPolicy"
  | "livenessOwnerToken"
  | "hasReceivedHeartbeat"
  | "ownership"
  | "heartbeatTimeoutMs"
  | "clientName"
>;

/**
 * Client-name patterns, most specific first. The desktop app and the IDE plugin
 * register through the same client today, so the IDE pattern only matches a name
 * that says so.
 */
const CLIENT_NAME_KINDS: ReadonlyArray<readonly [RegExp, SessionHolderKind]> = [
  [/junit/i, "junit"],
  [/\b(ide|intellij|android studio|plugin)\b/i, "ide"],
  [/desktop/i, "desktop"],
];

/**
 * Classify the holder from what the daemon knows: a one-shot `--cli` owner moves
 * its session to the `cli-idle` policy; a registered client name says desktop,
 * IDE or JUnit; and a token-claimed `heartbeat` session is owned by an MCP proxy,
 * the only client that claims with a liveness owner token.
 */
export function classifySessionHolderKind(
  session: Pick<SessionHoldSnapshot, "livenessPolicy" | "livenessOwnerToken" | "clientName">,
): SessionHolderKind {
  if (session.livenessPolicy === "cli-idle") {
    return "cli";
  }
  const clientName = session.clientName;
  const named =
    clientName === undefined
      ? undefined
      : CLIENT_NAME_KINDS.find(([pattern]) => pattern.test(clientName));
  if (named) {
    return named[1];
  }
  return session.livenessOwnerToken === undefined ? "unknown" : "stdio-proxy";
}

/**
 * The idle deadline the daemon releases on. A `cli-idle` session is judged by
 * the heartbeat monitor on wall-clock idleness from its last tool activity; a
 * `heartbeat` session expires at `expiresAt`, plus the suspect grace when its
 * owner has heartbeated (`SessionManager.isSessionExpired`).
 */
export function idleReleaseAt(session: SessionHoldSnapshot): number {
  if (session.livenessPolicy === "cli-idle") {
    return effectiveLastToolActivity(session) + session.heartbeatTimeoutMs;
  }
  return session.expiresAt + suspectGraceMsFor(session);
}

/** What bounds an in-flight execution's veto (`SessionManager.getIdleReleaseExecutionVeto`). */
export interface IdleReleaseExecutionVeto {
  latestDeadlineMs?: number;
}

/**
 * {@link idleReleaseAt}, pushed out by an in-flight execution's veto under the shared
 * unsettled-execution policy. The veto counts from the idle deadline, exactly as
 * `SessionManager.isSessionExpired` judges a `heartbeat` session. The heartbeat
 * monitor starts a `cli-idle` session's fallback window at its first scan past the
 * idle deadline, so for those the ceiling-based instant can run up to one scan
 * interval early; a deadline-based bound is exact for both policies.
 */
export function vetoedIdleReleaseAt(
  session: SessionHoldSnapshot,
  veto: IdleReleaseExecutionVeto | undefined,
): number {
  const idleDeadline = idleReleaseAt(session);
  if (veto === undefined) {
    return idleDeadline;
  }
  return Math.max(
    idleDeadline,
    unsettledExecutionVetoExpiresAt({
      vetoedSince: idleDeadline,
      latestDeadlineMs: veto.latestDeadlineMs,
    }),
  );
}

/** Converts an instant on the session clock to wall-clock epoch ms (#11105). */
export type SessionClockToWall = (sessionClockMs: number) => number;

/**
 * The reported instants are epoch ms, but a session stamps them on the steady session clock; a
 * wall-clock step makes the two differ. `toWall` converts at this boundary (wall now + (instant -
 * session now)) so the daemon stays authoritative for the value and clients read it as epoch ms.
 */
export function sessionHoldDiagnostics(
  session: SessionHoldSnapshot,
  activeExecutions: number,
  veto?: IdleReleaseExecutionVeto,
  toWall: SessionClockToWall = (ms) => ms,
): SessionHoldDiagnostics {
  return {
    lastToolActivityAt: toWall(session.lastUsedAt),
    lastOwnerHeartbeatAt:
      session.lastOwnerHeartbeat === undefined ? null : toWall(session.lastOwnerHeartbeat),
    idleReleaseAt: toWall(vetoedIdleReleaseAt(session, veto)),
    holderKind: classifySessionHolderKind(session),
    activeExecutions,
  };
}
