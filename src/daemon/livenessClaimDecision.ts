/**
 * Who wins a liveness ownership claim (#10050, #11602), as one pure decision so the order of its
 * rules is written once and tested over every combination.
 *
 * A derived `${base}:${label}` session keeps its own liveness record, and counts as its base when
 * a claim on it is judged: the base's owner is never refused on its label, and no other token
 * gains the label while the base's owner holds the base.
 */

import type { LivenessLeasePhase } from "./livenessOwnerLease";

/**
 * An owner's hold for conflict purposes: its lease phase, or `none` when there is no owner or the
 * session is on the `cli-idle` policy, which never holds a lease against a claim (#6870).
 */
export type LivenessHoldState = LivenessLeasePhase | "none";

/** One session's liveness owner, as a claim sees it. */
export interface LivenessOwnerView {
  ownerToken: string | undefined;
  hold: LivenessHoldState;
}

export interface LivenessClaimInput {
  claimantToken: string;
  /** The session the claim names. */
  session: LivenessOwnerView;
  /** Whether the named session already processed a claim by this token (a retried claim). */
  claimAlreadyProcessed: boolean;
  /** The live outermost base when the named session is a derived label session. */
  base: LivenessOwnerView | undefined;
}

export type LivenessClaimDecision =
  | { outcome: "claimed" }
  | { outcome: "superseded" }
  | { outcome: "conflict"; holdOf: "session" | "base" };

/** Whether the owner still holds: its lease is live or inside the suspect grace. */
function holds(view: LivenessOwnerView | undefined): view is LivenessOwnerView {
  return (
    view !== undefined &&
    view.ownerToken !== undefined &&
    (view.hold === "live" || view.hold === "suspect")
  );
}

/**
 * Decide a claim. The rules, in order:
 *
 * 1. The named session's current owner is never refused its own re-claim.
 * 2. The owner holding the base is never refused on its label, whoever holds the label.
 * 3. A retried claim whose token has since been displaced never takes the session back.
 * 4. Another token holding the named session refuses the claim.
 * 5. Another token holding the base refuses a claim on its label.
 * 6. Otherwise the claim wins.
 */
export function decideLivenessClaim(input: LivenessClaimInput): LivenessClaimDecision {
  const { claimantToken, session, base } = input;
  if (session.ownerToken === claimantToken) {
    return { outcome: "claimed" };
  }
  if (holds(base) && base.ownerToken === claimantToken) {
    return { outcome: "claimed" };
  }
  if (session.ownerToken !== undefined && input.claimAlreadyProcessed) {
    return { outcome: "superseded" };
  }
  if (holds(session)) {
    return { outcome: "conflict", holdOf: "session" };
  }
  if (holds(base)) {
    return { outcome: "conflict", holdOf: "base" };
  }
  return { outcome: "claimed" };
}

/**
 * Whose hold a refused claim reports (#10701), without the claimant's token: the heartbeat
 * handler asks for it after the refusal. It is the hold {@link decideLivenessClaim} refused for:
 * the named session's when its owner holds it, else the base's when the base's owner holds that.
 * With neither held there was no conflict, and the named session's own state is reported.
 */
export function refusedClaimHoldSource(
  session: LivenessOwnerView,
  base: LivenessOwnerView | undefined,
): "session" | "base" {
  return !holds(session) && holds(base) ? "base" : "session";
}

export interface LivenessAdoptionInput {
  claimantToken: string;
  session: LivenessOwnerView;
  /** Whether the named session has processed any claim: adoption is for a session with none. */
  sessionHasClaimHistory: boolean;
  base: LivenessOwnerView | undefined;
}

/**
 * Whether a non-claiming heartbeat may adopt an unowned session's liveness after a daemon restart.
 * Only a session with no owner and no claim history is adopted, and a label is not adopted past
 * another token that holds its base.
 */
export function mayAdoptUnownedLiveness(input: LivenessAdoptionInput): boolean {
  if (input.session.ownerToken !== undefined || input.sessionHasClaimHistory) {
    return false;
  }
  return !(holds(input.base) && input.base.ownerToken !== input.claimantToken);
}
