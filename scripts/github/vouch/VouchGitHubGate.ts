/**
 * Pure glue between the vouch domain and GitHub: parse `/vouch` slash-commands
 * from comment bodies, and turn a {@link GateDecision} into an action plan the
 * runtime script executes (label + comment, optionally close). No HTTP here — the
 * script (`scripts/github/vouch-gate.ts`) performs the side effects, so all the
 * decision logic stays unit-testable.
 */

import type { GateDecision } from "./types";
import { canonicalLogin } from "./types";

/** The label applied to gated (denied) issues/PRs. */
export const DEFAULT_GATE_LABEL = "needs-vouch";

/** A parsed `/vouch ...` slash command. */
export type VouchCommand =
  | { kind: "invite" }
  | { kind: "admit"; target: string }
  | { kind: "redeem"; token: string }
  | { kind: "denounce"; target: string; reason: string }
  | { kind: "status"; target: string | null };

const COMMAND_PREFIX = "/vouch";

/**
 * Parse the first `/vouch` command found at the start of any line of a comment
 * body. Returns null if there is no command. Logins may be written with or
 * without a leading `@`.
 */
export function parseVouchCommand(body: string): VouchCommand | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toLowerCase().startsWith(COMMAND_PREFIX)) {
      continue;
    }
    const rest = line.slice(COMMAND_PREFIX.length).trim();
    const [verb, ...args] = rest.split(/\s+/).filter(Boolean);
    if (!verb) {
      return null;
    }
    switch (verb.toLowerCase()) {
      case "invite":
        return { kind: "invite" };
      case "admit": {
        const target = stripAt(args[0]);
        return target ? { kind: "admit", target } : null;
      }
      case "redeem": {
        const token = args[0];
        return token ? { kind: "redeem", token } : null;
      }
      case "denounce": {
        const target = stripAt(args[0]);
        if (!target) {
          return null;
        }
        const reason = args.slice(1).join(" ").trim() || "denounced via /vouch";
        return { kind: "denounce", target, reason };
      }
      case "status": {
        const target = args[0] ? stripAt(args[0]) : null;
        return { kind: "status", target };
      }
      default:
        return null;
    }
  }
  return null;
}

function stripAt(token: string | undefined): string | null {
  if (!token) {
    return null;
  }
  const cleaned = token.replace(/^@/, "").trim();
  return cleaned.length > 0 ? canonicalLogin(cleaned) : null;
}

export interface GatePlanOptions {
  /**
   * When true, a denied actor's issue/PR is closed. When false (the safe
   * default), the gate is advisory: it comments guidance and applies the label
   * but leaves the issue/PR open.
   */
  enforce: boolean;
  gateLabel?: string;
  /** Where a newcomer can obtain access, woven into the guidance comment. */
  redeemHint?: string;
}

/** The side effects the runtime should apply for one gate evaluation. */
export interface GateActionPlan {
  allowed: boolean;
  /** Add this label (denied) — null means no label change needed. */
  addLabel: string | null;
  /** Remove this label (allowed, clearing a prior gate) — null means none. */
  removeLabel: string | null;
  /** Post this comment, or null to stay silent. */
  comment: string | null;
  /** Close the issue/PR (only when enforcing). */
  close: boolean;
}

/**
 * Decide what to do about an issue/PR opened by `decision`'s actor.
 *
 * Allowed actors clear any prior gate label and get no comment (no noise on the
 * happy path). Denied actors are labelled and commented with guidance; when
 * `enforce` is set they are also closed.
 */
export function planGateAction(decision: GateDecision, options: GatePlanOptions): GateActionPlan {
  const label = options.gateLabel ?? DEFAULT_GATE_LABEL;
  if (decision.allowed) {
    return { allowed: true, addLabel: null, removeLabel: label, comment: null, close: false };
  }

  const hint =
    options.redeemHint ??
    "Ask an existing contributor to run `/vouch admit @you` here, or redeem an invite token with `/vouch redeem <token>`.";
  const enforcementNote = options.enforce
    ? "This issue/PR has been closed pending a vouch."
    : "This issue/PR stays open, but a maintainer's attention may be gated until you're vouched.";
  const comment =
    `👋 Thanks for the contribution! ${decision.message}\n\n${hint}\n\n${enforcementNote}`;

  return {
    allowed: false,
    addLabel: label,
    removeLabel: null,
    comment,
    close: options.enforce,
  };
}
