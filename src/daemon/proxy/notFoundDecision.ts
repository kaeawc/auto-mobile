import { SESSION_REHYDRATION_DEADLINE_MS } from "../sessionManager/sessionConstants";
import { NO_HEARTBEAT_RELEASE_BUDGET_MS } from "../wire/sessionLivenessWindows";
import { isRecoverableDaemonReleaseReason } from "../releaseReasons";

/**
 * How long the proxy keeps heartbeating a session the daemon answers not-found for with a
 * recoverable reason (#11461): the restarted daemon's rehydration deadline, plus the time it then
 * gives the session's owner to return before releasing it. Past it the recovery this waits for
 * can no longer be met by a heartbeat, and only a tool call restores the session.
 */
export const RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS =
  SESSION_REHYDRATION_DEADLINE_MS + NO_HEARTBEAT_RELEASE_BUDGET_MS;

/**
 * What a not-found heartbeat answer means for the session it names (#11570). Decided by
 * {@link decideNotFoundAnswer} alone, for the latest binding and every held session alike.
 *
 * - `ended`: the daemon named a release that is not a recoverable handoff of a session this proxy
 *   owns. Terminal for that session only, under that reason.
 * - `awaited`: the session is inside its window (`windowSince`): it keeps being heartbeated, each
 *   heartbeat claiming again, and the connection is never reset for it. `handoff`: the answer is
 *   the first of that handoff, which opens the window now.
 * - `ask-again`: the latest binding, on a connection that had answered before and outside any
 *   window: asked once more on a fresh connection. `handoff`: the daemon named a recoverable
 *   handoff, so the daemon that answers there may be its successor.
 * - `stopped`: no longer heartbeated until a tool call reaches it again; never fenced.
 */
export type NotFoundAnswerOutcome =
  | { kind: "ended"; reason: string }
  | { kind: "awaited"; windowSince: number; handoff?: string }
  | { kind: "ask-again"; handoff: boolean }
  | { kind: "stopped" };

/**
 * The handoff a session's answer with no reason belongs to: a daemon the proxy just connected to
 * that has not rehydrated the session yet. A not-found answer names no daemon instance, so every
 * such answer is the same handoff until the daemon acknowledges the session again.
 */
export const UNREHYDRATED_HANDOFF = "unrehydrated";

/** Everything the outcome of a not-found heartbeat answer depends on. */
export interface NotFoundAnswerFacts {
  /** The release reason the daemon gave with the answer, when it gave one. */
  releaseReason: string | undefined;
  /** The proxy owns the session: only an owned session is handed back after a recoverable release. */
  owned: boolean;
  /**
   * The answer is the session's first on a connection that was established while the proxy held
   * it: the daemon behind it may have restarted and not rehydrated the session yet.
   */
  establishes: boolean;
  /** Positive evidence: this session last heard a different reported daemon process instance. */
  answeredByOtherDaemon: boolean;
  /** When the session's latest window opened, while it has had one (open or expired). */
  windowSince: number | undefined;
  /**
   * The handoffs the session already got its window for, since the daemon last acknowledged it
   * or admitted a call under it.
   */
  handoffs: ReadonlySet<string>;
  now: number;
  /** The heartbeat may be asked once more on a fresh connection (the latest binding's first ask). */
  mayAskAgain: boolean;
}

/**
 * Whether a release the daemon reports leaves the session with its owner: only a recoverable
 * handoff (`device-restart:<id>`, a daemon shutdown or restart) of a session this proxy owns,
 * because the daemon hands that session back to the next call.
 */
export function isRecoverableHandoffOfOwnedSession(
  releaseReason: string | undefined,
  owned: boolean,
): boolean {
  return releaseReason !== undefined && owned && isRecoverableDaemonReleaseReason(releaseReason);
}

/**
 * The one decision for a not-found heartbeat answer, from the session's own state (#11570).
 *
 * A window belongs to a HANDOFF, never to a connection. A handoff is identified by the
 * recoverable release reason the daemon names (#11461), or, for an answer with no reason that is
 * the session's first on a just-established connection or reports another daemon instance, by
 * {@link UNREHYDRATED_HANDOFF} (#11529, #11557). The first answer of a handoff opens one window of
 * {@link RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS}; no later answer of the same handoff opens or
 * extends one, whatever connection it arrives on (a reconnect by liveness recovery or to ask
 * again reaches the same daemon as far as the answer can tell). So a session that is not
 * acknowledged is heartbeated for at most one window per distinct handoff it was actually told
 * of. Inside a window every answer that does not end the session is awaited. Outside one the
 * session is stopped; the latest binding is first asked once more on a fresh connection when it
 * has had no window at all, or when the answer names a handoff it has had no window for yet.
 */
export function decideNotFoundAnswer(facts: NotFoundAnswerFacts): NotFoundAnswerOutcome {
  const { releaseReason, owned, windowSince, now } = facts;
  const establishes = notFoundAnswerEstablishes(facts);
  const recoverable = isRecoverableHandoffOfOwnedSession(releaseReason, owned);
  if (releaseReason !== undefined && !recoverable) {
    return { kind: "ended", reason: releaseReason };
  }
  const open =
    windowSince !== undefined && now - windowSince < RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS;
  const handoff = newHandoffOf(facts, recoverable);
  if (handoff !== undefined) {
    // A connection that had answered before named the handoff: the daemon is going away or
    // handing the session back, so the latest binding asks on a fresh one first.
    return recoverable && !open && !establishes && facts.mayAskAgain
      ? { kind: "ask-again", handoff: true }
      : { kind: "awaited", windowSince: now, handoff };
  }
  if (open) {
    return { kind: "awaited", windowSince };
  }
  return windowSince === undefined && facts.mayAskAgain
    ? { kind: "ask-again", handoff: false }
    : { kind: "stopped" };
}

/** Both the connection and a changed process instance provide positive establishment evidence. */
function notFoundAnswerEstablishes(facts: NotFoundAnswerFacts): boolean {
  return facts.establishes || facts.answeredByOtherDaemon;
}

/**
 * The handoff a not-found answer that does not end its session tells of, when the session has
 * had no window for it yet: the recoverable release the daemon names, or, with no reason, the
 * one {@link UNREHYDRATED_HANDOFF} when the answer is the session's first on a connection just
 * established or it reports another daemon instance. Undefined for a handoff it already had its
 * window for, and for an answer with no reason on a connection that had answered before and no
 * evidence of another daemon, which tells of none.
 */
function newHandoffOf(facts: NotFoundAnswerFacts, recoverable: boolean): string | undefined {
  const handoff = recoverable
    ? `release:${facts.releaseReason}`
    : facts.owned && notFoundAnswerEstablishes(facts)
      ? UNREHYDRATED_HANDOFF
      : undefined;
  return handoff === undefined || facts.handoffs.has(handoff) ? undefined : handoff;
}
