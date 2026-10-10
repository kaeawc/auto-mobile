/**
 * The one table of session release reasons (#11258).
 *
 * Every reason a session can be released with is tagged here, and every decision the daemon makes
 * on a reason reads these tags instead of keeping its own list. A new reason is a compile error
 * until it is added to {@link SESSION_RELEASE_REASON_TRAITS} (literal reasons) or
 * {@link SESSION_RELEASE_REASON_FAMILY_TRAITS} (reasons built from a prefix plus an id).
 *
 * Kept free of daemon machinery so the database layer and the proxy can read it cheaply.
 */

export interface SessionReleaseReasonTraits {
  /**
   * The session ran out its idle window (#10832): session-not-found answers carry `idle: true`
   * and the loss message explains the idle window.
   */
  readonly idle: boolean;
  /**
   * A timer, not a caller, ended the session: the row is persisted with status `expired`, and the
   * release goes through the pool's recovery-expiry handler, which may defer it.
   */
  readonly expiry: boolean;
  /**
   * The UUID ends with this release: it is fenced in memory, journaled before its row is written,
   * never rehydrated after a restart, and a later call naming it is refused with
   * `session_ownership_lost` (`retryable: false`, `nextAction: "acquire_new_session"`).
   */
  readonly terminal: boolean;
  /**
   * A daemon-side handoff: the session was released only because its daemon (or its device)
   * restarted, and a restarted daemon may rehydrate it for the same owner.
   */
  readonly recoverable: boolean;
}

/** Every literal session release reason. */
export type SessionReleaseReasonLiteral =
  | "explicit-release"
  | "lazy-expiry"
  | "cleanup-expired"
  | "cli-idle-timeout"
  | "missing-first-heartbeat"
  | "heartbeat-timeout"
  | "rehydration-owner-timeout"
  | "owner-disconnected"
  | "device-killed"
  | "session-creation-cancelled"
  | "session-creation-timeout"
  | "allocation-rollback"
  | "plan-auto-release"
  | "superseded"
  | "daemon-shutdown"
  | "daemon-restart"
  | "expired";

/** Prefixes of the reasons built from a prefix plus an id (a device, an incident, a sub-reason). */
export type SessionReleaseReasonFamily =
  | "identity-recovery-"
  | "device-disconnected:"
  | "device-disconnected-during-session-create:"
  | "device-restart:";

/** Any session release reason a producer may record. */
export type SessionReleaseReason =
  | SessionReleaseReasonLiteral
  | `${SessionReleaseReasonFamily}${string}`;

const NOT_TERMINAL: SessionReleaseReasonTraits = {
  idle: false,
  expiry: false,
  terminal: false,
  recoverable: false,
};
const TERMINAL: SessionReleaseReasonTraits = { ...NOT_TERMINAL, terminal: true };
const TERMINAL_EXPIRY: SessionReleaseReasonTraits = { ...TERMINAL, expiry: true };
/**
 * Every idle release ends the session, whatever the liveness policy: heartbeat, one-shot CLI or
 * managed execution (owner decision 2026-10-09, #11258).
 */
const IDLE_EXPIRY: SessionReleaseReasonTraits = { ...TERMINAL_EXPIRY, idle: true };
const RECOVERABLE_HANDOFF: SessionReleaseReasonTraits = { ...NOT_TERMINAL, recoverable: true };

/** The tags of every literal release reason. */
export const SESSION_RELEASE_REASON_TRAITS: Readonly<
  Record<SessionReleaseReasonLiteral, SessionReleaseReasonTraits>
> = {
  /** A client or the daemon released the session on purpose. */
  "explicit-release": TERMINAL,
  /** The idle window ran out, found by a lookup of the session. */
  "lazy-expiry": IDLE_EXPIRY,
  /** The idle window ran out, found by the periodic expiry sweep. */
  "cleanup-expired": IDLE_EXPIRY,
  /** A one-shot CLI session's idle window ran out. */
  "cli-idle-timeout": IDLE_EXPIRY,
  /** The owner never sent its first heartbeat inside the pre-first-heartbeat grace. */
  "missing-first-heartbeat": TERMINAL_EXPIRY,
  /** The owner's heartbeat lease lapsed. */
  "heartbeat-timeout": TERMINAL_EXPIRY,
  /** A rehydrated session's owner never reclaimed it. */
  "rehydration-owner-timeout": TERMINAL_EXPIRY,
  /** The owning connection closed and no other client owns the session. */
  "owner-disconnected": TERMINAL,
  /** The session's device was killed. */
  "device-killed": TERMINAL,
  /** The session's creation was cancelled before it was handed out. */
  "session-creation-cancelled": TERMINAL,
  /** A creation abandoned at its deadline (#10963); the UUID may be created again. */
  "session-creation-timeout": NOT_TERMINAL,
  /** An allocation rolled back before the session was handed out. */
  "allocation-rollback": NOT_TERMINAL,
  /** Plan cleanup frees devices while allowing the base and label UUIDs to be reused. */
  "plan-auto-release": NOT_TERMINAL,
  /** A newer incarnation of the same UUID replaced this one. */
  superseded: NOT_TERMINAL,
  /** The daemon shut down; its successor may rehydrate the session. */
  "daemon-shutdown": RECOVERABLE_HANDOFF,
  /** The daemon restarted; it may rehydrate the session. */
  "daemon-restart": RECOVERABLE_HANDOFF,
  /** A persisted row found past its deadline (it can no longer be recovered anyway). */
  expired: NOT_TERMINAL,
};

/** The tags of every prefix family, checked in this order. */
export const SESSION_RELEASE_REASON_FAMILY_TRAITS: Readonly<
  Record<SessionReleaseReasonFamily, SessionReleaseReasonTraits>
> = {
  /** Restart recovery could not prove the device's identity; the sub-reason follows the prefix. */
  "identity-recovery-": TERMINAL,
  /** The session's device disconnected (with an optional `;incident=` id). */
  "device-disconnected:": TERMINAL,
  /** The device disconnected while the session was still being created. */
  "device-disconnected-during-session-create:": NOT_TERMINAL,
  /** The device restarted; the restarted daemon may rehydrate the session onto it. */
  "device-restart:": RECOVERABLE_HANDOFF,
};

/** A reason this table does not know (a row an older daemon wrote): ordinary and non-terminal. */
const UNKNOWN_REASON_TRAITS = NOT_TERMINAL;

function isLiteralReleaseReason(reason: string): reason is SessionReleaseReasonLiteral {
  return Object.hasOwn(SESSION_RELEASE_REASON_TRAITS, reason);
}

/** The family a reason belongs to; a bare prefix with no id belongs to none. */
export function sessionReleaseReasonFamily(reason: string): SessionReleaseReasonFamily | undefined {
  return (Object.keys(SESSION_RELEASE_REASON_FAMILY_TRAITS) as SessionReleaseReasonFamily[]).find(
    (prefix) => reason.startsWith(prefix) && reason.length > prefix.length,
  );
}

/**
 * The tags of a release reason. Accepts any string, because persisted rows and wire payloads may
 * carry reasons an older or newer daemon wrote; an unknown reason is ordinary and non-terminal.
 */
export function sessionReleaseReasonTraits(reason: string): SessionReleaseReasonTraits {
  if (isLiteralReleaseReason(reason)) {
    return SESSION_RELEASE_REASON_TRAITS[reason];
  }
  const family = sessionReleaseReasonFamily(reason);
  return family === undefined
    ? UNKNOWN_REASON_TRAITS
    : SESSION_RELEASE_REASON_FAMILY_TRAITS[family];
}

/** Whether the UUID ends with this release (see {@link SessionReleaseReasonTraits.terminal}). */
export function isTerminalReleaseReason(reason: string): boolean {
  return sessionReleaseReasonTraits(reason).terminal;
}

/**
 * Whether a timer ended the session (see {@link SessionReleaseReasonTraits.expiry}). Only tagged
 * reasons carry the tag, so a match is a {@link SessionReleaseReason}.
 */
export function isExpiryReleaseReason(reason: string): reason is SessionReleaseReason {
  return sessionReleaseReasonTraits(reason).expiry;
}

/** Whether the session ran out its idle window (see {@link SessionReleaseReasonTraits.idle}). */
export function isIdleReleaseReason(reason: string): boolean {
  return sessionReleaseReasonTraits(reason).idle;
}

/** Whether a restarted daemon may rehydrate the session (see {@link SessionReleaseReasonTraits.recoverable}). */
export function isRecoverableDaemonReleaseReason(reason: string): boolean {
  return sessionReleaseReasonTraits(reason).recoverable;
}

/**
 * Whether `candidate` replaces `current` as the reason of one release. A terminal reason replaces a
 * non-terminal one. An idle reason is the weakest terminal reason: any other terminal reason
 * replaces it, so an idle sweep that races a heartbeat lapse, a device loss or an earlier terminal
 * release keeps that more specific diagnostic (#10051), as it did when idle releases were not
 * terminal. `device-killed` and `daemon-shutdown` have their own precedence at the call site.
 */
export function outranksReleaseReason(candidate: string, current: string): boolean {
  const next = sessionReleaseReasonTraits(candidate);
  if (!next.terminal) {
    return false;
  }
  const held = sessionReleaseReasonTraits(current);
  return !held.terminal || (held.idle && !next.idle);
}

/**
 * How firmly a release reason ends a session, the one ordering of "which release stands" for a
 * row's stored reason: 0 non-terminal (including recoverable handoffs and unknown reasons),
 * 1 idle terminal (the weakest terminal reason, see {@link outranksReleaseReason}), 2 any other
 * terminal reason.
 */
export type ReleaseReasonStrength = 0 | 1 | 2;

export function releaseReasonStrength(reason: string): ReleaseReasonStrength {
  const traits = sessionReleaseReasonTraits(reason);
  if (!traits.terminal) {
    return 0;
  }
  return traits.idle ? 1 : 2;
}

/**
 * Whether a release with `candidate` may overwrite a row holding `held` (null: no reason yet).
 * A stored terminal reason is never replaced by a weaker one, so a late non-terminal release (a
 * sweep's `expired`, a `daemon-shutdown` handoff) cannot erase a terminal fence; an equal or
 * stronger reason replaces it.
 */
export function releaseReasonMayReplace(candidate: string, held: string | null): boolean {
  return held === null || releaseReasonStrength(candidate) >= releaseReasonStrength(held);
}

/** The persisted status of a released row. */
export function releasedRowStatus(reason: string): "expired" | "released" {
  return isExpiryReleaseReason(reason) ? "expired" : "released";
}

/** The literal reasons with a tag, for SQL filters over `device_sessions.release_reason`. */
export function literalReleaseReasonsWhere(
  tag: keyof SessionReleaseReasonTraits,
): SessionReleaseReasonLiteral[] {
  return (Object.keys(SESSION_RELEASE_REASON_TRAITS) as SessionReleaseReasonLiteral[]).filter(
    (reason) => SESSION_RELEASE_REASON_TRAITS[reason][tag],
  );
}

/** The prefix families with a tag, for SQL filters over `device_sessions.release_reason`. */
export function releaseReasonFamiliesWhere(
  tag: keyof SessionReleaseReasonTraits,
): SessionReleaseReasonFamily[] {
  return (Object.keys(SESSION_RELEASE_REASON_FAMILY_TRAITS) as SessionReleaseReasonFamily[]).filter(
    (family) => SESSION_RELEASE_REASON_FAMILY_TRAITS[family][tag],
  );
}

/** The literal reasons strictly stronger than `strength`, for SQL filters. */
export function literalReleaseReasonsStrongerThan(
  strength: ReleaseReasonStrength,
): SessionReleaseReasonLiteral[] {
  return (Object.keys(SESSION_RELEASE_REASON_TRAITS) as SessionReleaseReasonLiteral[]).filter(
    (reason) => releaseReasonStrength(reason) > strength,
  );
}

/** The prefix families strictly stronger than `strength`, for SQL filters. */
export function releaseReasonFamiliesStrongerThan(
  strength: ReleaseReasonStrength,
): SessionReleaseReasonFamily[] {
  return (Object.keys(SESSION_RELEASE_REASON_FAMILY_TRAITS) as SessionReleaseReasonFamily[]).filter(
    (family) => releaseReasonStrength(`${family}x`) > strength,
  );
}
