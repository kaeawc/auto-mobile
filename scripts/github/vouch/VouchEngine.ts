/**
 * The pure domain engine for the vouch system.
 *
 * It operates on an in-memory {@link VouchState} and performs no I/O — all
 * non-determinism (token generation, current time) is injected via
 * {@link IdGenerator} and {@link Timer}, so the whole trust/accountability model
 * is exercised by fast, deterministic unit tests. Persistence is layered on top
 * by the file-backed `FileVouchStore` (the committed JSON trust graph).
 *
 * Operations mutate the passed-in state and return a structured result describing
 * what changed, so a caller can persist exactly the touched entities.
 */

import type { IdGenerator } from "../../../src/utils/IdGenerator";
import { defaultIdGenerator } from "../../../src/utils/IdGenerator";
import type { Timer } from "../../../src/utils/SystemTimer";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { ActionableError } from "../../../src/models/ActionableError";
import { logger } from "../../../src/utils/logger";
import {
  applyPenalty,
  DEFAULT_VOUCH_POLICY,
  vouchCapacity,
  type VouchPolicy,
} from "./VouchPolicy";
import {
  canonicalLogin,
  type GateDecision,
  type InviteToken,
  type Member,
  type MemberRole,
  type VouchState,
} from "./types";

/** A reputation change applied to one member as accountability fallout. */
export interface ReputationChange {
  login: string;
  before: number;
  after: number;
}

/** The result of denouncing a member. */
export interface DenounceResult {
  /** The directly-denounced member plus every cascade-revoked descendant. */
  revoked: Member[];
  /** Ancestors up the vouch chain whose reputation was penalised. */
  penalised: ReputationChange[];
}

export interface VouchEngineOptions {
  idGenerator?: IdGenerator;
  timer?: Timer;
  policy?: VouchPolicy;
}

export class VouchEngine {
  private readonly idGenerator: IdGenerator;
  private readonly timer: Timer;
  readonly policy: VouchPolicy;

  constructor(options: VouchEngineOptions = {}) {
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.timer = options.timer ?? defaultTimer;
    this.policy = options.policy ?? DEFAULT_VOUCH_POLICY;
  }

  /**
   * Bootstrap a seed member — the repo owner (`founder`) or a directly-trusted
   * `contributor`. Seed members have no voucher, so denouncements never cascade
   * into them. Idempotency is the caller's concern: this throws if the login is
   * already a member.
   */
  seedMember(state: VouchState, login: string, role: "founder" | "contributor"): Member {
    const key = canonicalLogin(login);
    if (state.members.has(key)) {
      throw new ActionableError(
        `Cannot seed '${key}' as ${role}: already a known member. Use denounce/reinstate to change standing.`
      );
    }
    const now = this.timer.now();
    const member: Member = {
      login: key,
      role,
      status: "active",
      reputation: this.policy.initialReputationByRole[role],
      vouchedBy: null,
      redeemedToken: null,
      revocationCause: null,
      revocationReason: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    state.members.set(key, member);
    return member;
  }

  /**
   * Issue a single-use invite token on behalf of an active member with spare
   * vouch budget. Stale (expired) pending invites are reaped first so their slots
   * free up.
   */
  issueInvite(state: VouchState, issuerLogin: string): InviteToken {
    this.expireStaleInvites(state);
    const key = canonicalLogin(issuerLogin);
    const issuer = state.members.get(key);
    if (!issuer || issuer.status !== "active") {
      throw new ActionableError(
        `'${key}' cannot issue invites: not an active member of the trust graph.`
      );
    }
    const remaining = this.remainingCapacity(state, key);
    if (remaining <= 0) {
      throw new ActionableError(
        `'${key}' has no remaining vouch budget (capacity ${this.capacity(issuer)}, ` +
          `all slots committed). Wait for an outstanding invite to be redeemed/expire, ` +
          `or rebuild reputation.`
      );
    }
    const now = this.timer.now();
    const invite: InviteToken = {
      token: this.idGenerator.next(),
      issuedBy: key,
      status: "pending",
      createdAtMs: now,
      expiresAtMs: now + this.policy.inviteTtlMs,
      redeemedBy: null,
      redeemedAtMs: null,
      invalidatedReason: null,
    };
    state.invites.set(invite.token, invite);
    return invite;
  }

  /**
   * Redeem a pending invite, admitting the redeemer as a `vouched` member whose
   * trust flows from the issuer.
   */
  redeemInvite(state: VouchState, token: string, redeemerLogin: string): Member {
    this.expireStaleInvites(state);
    const invite = state.invites.get(token);
    if (!invite) {
      throw new ActionableError(`Unknown invite token.`);
    }
    if (invite.status !== "pending") {
      throw new ActionableError(`Invite token is ${invite.status} and cannot be redeemed.`);
    }
    const issuer = state.members.get(invite.issuedBy);
    if (!issuer || issuer.status !== "active") {
      // The issuer was revoked after issuing; the invite dies with them.
      invite.status = "revoked";
      invite.invalidatedReason = "issuer-no-longer-active";
      throw new ActionableError(
        `Invite token is no longer valid: its issuer is no longer an active member.`
      );
    }
    const redeemerKey = canonicalLogin(redeemerLogin);
    const existing = state.members.get(redeemerKey);
    if (existing && existing.status === "active") {
      throw new ActionableError(`'${redeemerKey}' is already an active member.`);
    }

    const now = this.timer.now();
    const member: Member = {
      login: redeemerKey,
      role: "vouched",
      status: "active",
      reputation: this.policy.initialReputationByRole.vouched,
      vouchedBy: issuer.login,
      redeemedToken: token,
      revocationCause: null,
      revocationReason: null,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };
    state.members.set(redeemerKey, member);
    invite.status = "redeemed";
    invite.redeemedBy = redeemerKey;
    invite.redeemedAtMs = now;
    return member;
  }

  /**
   * Denounce a member: revoke them and their entire downstream sub-tree, and
   * charge a decaying reputation penalty up the chain of vouchers that admitted
   * them (shared accountability).
   *
   * `founder` members are immune — denouncing one throws — so a denouncement can
   * never cascade or reach up to lock the repo owner out. Ancestors that happen
   * to be founders still take the reputation hit (lowering their invite budget)
   * but keep their `active` status.
   */
  denounce(state: VouchState, login: string, reason: string): DenounceResult {
    const key = canonicalLogin(login);
    const target = state.members.get(key);
    if (!target) {
      throw new ActionableError(`Cannot denounce unknown member '${key}'.`);
    }
    if (target.role === "founder") {
      throw new ActionableError(
        `Founder '${key}' is immune from denouncement (it is a root of trust). ` +
          `Remove it manually if truly intended.`
      );
    }
    if (target.status !== "active") {
      throw new ActionableError(`'${key}' is already revoked.`);
    }

    const now = this.timer.now();

    // 1. Revoke the target and its whole active descendant sub-tree.
    const revoked = this.revokeSubtree(state, target, reason, now);

    // 2. Charge decaying accountability penalties up the voucher chain.
    const penalised = this.chargeAncestors(state, target, now);

    logger.warn(
      `[vouch] denounced '${key}': revoked ${revoked.length} member(s), ` +
        `penalised ${penalised.length} ancestor(s).`
    );
    return { revoked, penalised };
  }

  /**
   * Decide whether an actor's issue/PR should pass the gate. Read-only.
   */
  evaluateGate(state: VouchState, login: string): GateDecision {
    const key = canonicalLogin(login);
    const member = state.members.get(key);
    if (!member) {
      return {
        login: key,
        allowed: false,
        reason: "unknown-actor",
        message:
          `'${key}' is not yet vouched for. Ask an existing contributor for an ` +
          `invite token and redeem it to gain access.`,
      };
    }
    if (member.status !== "active") {
      return {
        login: key,
        allowed: false,
        reason: "revoked",
        message: `'${key}' has been revoked${member.revocationReason ? `: ${member.revocationReason}` : ""}.`,
        member,
      };
    }
    return {
      login: key,
      allowed: true,
      reason: member.role,
      message: `'${key}' is a trusted ${member.role}.`,
      member,
    };
  }

  /** Total invite capacity for a member (base + reputation bonus). */
  capacity(member: Member): number {
    return vouchCapacity(member.role, member.reputation, this.policy);
  }

  /**
   * Remaining invite budget for a member: capacity minus outstanding commitments
   * (pending invites they issued + still-active members they vouched in).
   */
  remainingCapacity(state: VouchState, login: string): number {
    const key = canonicalLogin(login);
    const member = state.members.get(key);
    if (!member) {
      return 0;
    }
    let committed = 0;
    for (const invite of state.invites.values()) {
      if (invite.issuedBy === key && invite.status === "pending") {
        committed++;
      }
    }
    for (const other of state.members.values()) {
      if (other.vouchedBy === key && other.status === "active") {
        committed++;
      }
    }
    return this.capacity(member) - committed;
  }

  /**
   * Flip any pending invite whose TTL has elapsed to `expired`. Idempotent; safe
   * to call before any capacity-sensitive operation.
   */
  expireStaleInvites(state: VouchState): void {
    const now = this.timer.now();
    for (const invite of state.invites.values()) {
      if (invite.status === "pending" && invite.expiresAtMs <= now) {
        invite.status = "expired";
        invite.invalidatedReason = "ttl-elapsed";
      }
    }
  }

  /** BFS-revoke a member and all active descendants; returns everyone revoked. */
  private revokeSubtree(
    state: VouchState,
    root: Member,
    reason: string,
    now: number
  ): Member[] {
    // Precompute children adjacency once so the cascade is O(members), not O(n^2).
    const childrenByVoucher = new Map<string, Member[]>();
    for (const member of state.members.values()) {
      if (member.vouchedBy !== null) {
        const siblings = childrenByVoucher.get(member.vouchedBy) ?? [];
        siblings.push(member);
        childrenByVoucher.set(member.vouchedBy, siblings);
      }
    }

    const revoked: Member[] = [];
    const queue: Member[] = [root];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const member = queue.shift()!;
      if (seen.has(member.login)) {
        continue;
      }
      seen.add(member.login);

      // Founders are immune even if they somehow appear in a sub-tree (they never
      // should, having no voucher — but never revoke a root of trust).
      if (member.role === "founder" || member.status !== "active") {
        continue;
      }
      member.status = "revoked";
      member.revocationCause = member === root ? "denounced" : "voucher-revoked";
      member.revocationReason = reason;
      member.updatedAtMs = now;
      revoked.push(member);

      for (const child of childrenByVoucher.get(member.login) ?? []) {
        queue.push(child);
      }
    }
    return revoked;
  }

  /** Walk up the voucher chain applying a decaying reputation penalty. */
  private chargeAncestors(state: VouchState, target: Member, now: number): ReputationChange[] {
    const changes: ReputationChange[] = [];
    let penalty = this.policy.denouncePenalty;
    let current = target.vouchedBy ? state.members.get(target.vouchedBy) : undefined;
    const visited = new Set<string>([target.login]);

    while (current && penalty >= 1 && !visited.has(current.login)) {
      visited.add(current.login);
      const before = current.reputation;
      const after = applyPenalty(before, penalty);
      current.reputation = after;
      current.updatedAtMs = now;
      changes.push({ login: current.login, before, after });

      penalty *= this.policy.penaltyDecay;
      current = current.vouchedBy ? state.members.get(current.vouchedBy) : undefined;
    }
    return changes;
  }
}

/** Convenience: the initial reputation the engine would assign a role. */
export function initialReputationFor(role: MemberRole, policy: VouchPolicy = DEFAULT_VOUCH_POLICY): number {
  return policy.initialReputationByRole[role];
}
