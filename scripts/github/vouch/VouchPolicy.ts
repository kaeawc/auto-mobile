/**
 * Tunable constants and the derived capacity/penalty math for the vouch system.
 *
 * Kept separate from the engine so the numbers are the one obvious place to tune
 * behaviour, and so both the engine and any reporting surface derive capacity the
 * same way (one canonical formula per concern).
 */

import type { MemberRole } from "./types";

export interface VouchPolicy {
  /**
   * Base number of invites a member of each role may have outstanding at once,
   * before any reputation bonus.
   */
  baseCapacityByRole: Record<MemberRole, number>;
  /** Reputation a member of each role starts with when created. */
  initialReputationByRole: Record<MemberRole, number>;
  /**
   * Every whole multiple of this many reputation points grants one extra vouch
   * slot on top of the role's base capacity.
   */
  reputationPerBonusVouch: number;
  /**
   * Reputation the *direct* voucher loses when a member they vouched in is
   * denounced. Ancestors further up the chain pay a decayed fraction.
   */
  denouncePenalty: number;
  /**
   * Fraction of the penalty that propagates from one ancestor to the next up the
   * chain (0..1). e.g. 0.5 means the grand-voucher pays half what the direct
   * voucher paid, and so on until the penalty rounds to zero.
   */
  penaltyDecay: number;
  /** How long a freshly issued invite token stays redeemable. */
  inviteTtlMs: number;
}

/**
 * Default policy. Conservative but usable for a small OSS repo: the owner
 * (`founder`) can have ~10 invites outstanding plus a reputation bonus, a known
 * contributor ~5, and a vouched-in newcomer ~2 (so trust fans out but does not
 * explode). A denouncement costs the direct voucher a meaningful chunk of
 * reputation (and therefore some invite capacity) while decaying quickly up the
 * chain so distant ancestors are barely touched.
 */
export const DEFAULT_VOUCH_POLICY: VouchPolicy = {
  baseCapacityByRole: {
    founder: 10,
    contributor: 5,
    vouched: 2,
  },
  initialReputationByRole: {
    founder: 100,
    contributor: 50,
    vouched: 20,
  },
  reputationPerBonusVouch: 25,
  denouncePenalty: 30,
  penaltyDecay: 0.5,
  inviteTtlMs: 14 * 24 * 60 * 60 * 1000, // 14 days
};

/**
 * Total invite capacity for a member at a given reputation: the role's base plus
 * one bonus slot per whole {@link VouchPolicy.reputationPerBonusVouch} of
 * reputation. Reputation is clamped at zero first so a heavily-penalised member
 * never gets negative capacity.
 */
export function vouchCapacity(
  role: MemberRole,
  reputation: number,
  policy: VouchPolicy
): number {
  const base = policy.baseCapacityByRole[role];
  const bonus =
    policy.reputationPerBonusVouch > 0
      ? Math.floor(Math.max(0, reputation) / policy.reputationPerBonusVouch)
      : 0;
  return base + bonus;
}

/**
 * Apply a reputation penalty, clamped so reputation never drops below zero.
 */
export function applyPenalty(reputation: number, penalty: number): number {
  return Math.max(0, reputation - penalty);
}
