/**
 * Domain types for the vouch system — a web-of-trust used to gate access for
 * non-contributors opening GitHub issues and pull requests.
 *
 * The model mirrors Mitchell Hashimoto's Ghostty beta vouch system: a small set
 * of trusted seed members (the repo owner + known contributors) can vouch for
 * newcomers by issuing single-use invite tokens. Each member has a bounded
 * "vouch budget" that grows with reputation. Trust flows down a forest rooted at
 * seed members; denouncing a member revokes their whole downstream sub-tree and
 * charges a decaying reputation penalty up the chain that vouched them in
 * (shared accountability). Seed members (`founder`) can never be revoked by the
 * cascade, so denouncing a bad actor can never lock the owner out of their repo.
 */

/**
 * A member's standing tier.
 * - `founder`   — a seed root of trust (the repo owner). Immune from cascade
 *                 revocation; still subject to reputation penalties (which lower
 *                 its vouch budget) but never loses access.
 * - `contributor` — trusted directly (e.g. has merged contributions). Not vouched
 *                 in by anyone, so denouncements never cascade to it, but unlike a
 *                 founder it is not immune if explicitly denounced.
 * - `vouched`   — joined by redeeming an invite token. Subject to the full
 *                 cascade + accountability machinery.
 */
export type MemberRole = "founder" | "contributor" | "vouched";

/**
 * A member's lifecycle status.
 * - `active`    — trusted; their issues/PRs pass the gate.
 * - `revoked`   — denounced directly, or cascade-revoked because an ancestor was
 *                 denounced. Their issues/PRs are gated again.
 */
export type MemberStatus = "active" | "revoked";

/** An invite token's lifecycle status. */
export type InviteStatus = "pending" | "redeemed" | "revoked" | "expired";

/** The reason a member's status changed to `revoked`. */
export type RevocationCause =
  /** Denounced directly by an operator. */
  | "denounced"
  /** Cascade-revoked because an ancestor voucher was denounced. */
  | "voucher-revoked";

/** A member in the trust graph. */
export interface Member {
  /** GitHub login, canonicalised to lowercase (see {@link canonicalLogin}). */
  login: string;
  role: MemberRole;
  status: MemberStatus;
  /**
   * Reputation score. Drives bonus vouch capacity and absorbs accountability
   * penalties. Never negative.
   */
  reputation: number;
  /**
   * The login of the member who vouched this one in, or `null` for seed members
   * (`founder`/`contributor`). This single parent pointer encodes the trust-graph
   * edge; the whole forest is reconstructable from it.
   */
  vouchedBy: string | null;
  /** The invite token this member redeemed to join, or `null` for seed members. */
  redeemedToken: string | null;
  /** Why the member is revoked, or `null` while active. */
  revocationCause: RevocationCause | null;
  /** Free-text note captured at denouncement time, or `null`. */
  revocationReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** A single-use invite token issued by a member to bring in a newcomer. */
export interface InviteToken {
  token: string;
  /** Login of the issuing member. */
  issuedBy: string;
  status: InviteStatus;
  createdAtMs: number;
  expiresAtMs: number;
  /** Login of the member who redeemed it, or `null` while pending. */
  redeemedBy: string | null;
  redeemedAtMs: number | null;
  /** Why the token was revoked/expired, or `null`. */
  invalidatedReason: string | null;
}

/**
 * The full in-memory state the {@link VouchEngine} operates on. Deliberately
 * plain data (Maps of records) so the engine stays pure and trivially testable
 * without a database.
 */
export interface VouchState {
  /** Keyed by canonical login. */
  members: Map<string, Member>;
  /** Keyed by token. */
  invites: Map<string, InviteToken>;
}

/** The outcome of evaluating whether an actor's issue/PR should pass the gate. */
export interface GateDecision {
  /** Canonical login evaluated. */
  login: string;
  allowed: boolean;
  /** Machine-readable reason code. */
  reason:
    | "founder"
    | "contributor"
    | "vouched"
    | "unknown-actor"
    | "revoked";
  /** Human-readable explanation suitable for a gating comment. */
  message: string;
  /** The matched member, when the actor is known. */
  member?: Member;
}

/** Canonicalise a GitHub login for use as a stable key (GitHub logins are case-insensitive). */
export function canonicalLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** Create an empty state. */
export function emptyVouchState(): VouchState {
  return { members: new Map(), invites: new Map() };
}
