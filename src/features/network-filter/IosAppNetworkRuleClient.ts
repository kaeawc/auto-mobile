import { logger } from "../../utils/logger";
import type {
  NetworkFilterBridge,
  NetworkFilterRuleCommandResult,
  NetworkFilterRuleOutcome,
  NetworkFilterRuleOwnership,
  NetworkFilterRuleStatus,
  NetworkFilterRuleTarget,
  NetworkFilterState,
} from "./NetworkFilterBridge";

/**
 * Leased per-app offline rules on iOS Simulator (#10264), over the
 * network-filter controller.
 *
 * The provider ends a rule on its own unless it is renewed within the lease,
 * so a daemon that dies or hangs leaves an app offline for at most one lease.
 * The session renews well inside that bound.
 */
export const IOS_APP_NETWORK_RULE_LEASE_MS = 15_000;
export const IOS_APP_NETWORK_RULE_RENEW_INTERVAL_MS = 5_000;

/** A rule this daemon owns: target plus the ownership of its installed revision. */
export interface IosAppNetworkRule extends NetworkFilterRuleTarget, NetworkFilterRuleOwnership {}

/** The ownership a single iOS rule command carries, plus a way to fence it on rollback. */
export interface IosAppNetworkRuleCommandContext {
  rule: IosAppNetworkRule;
  /** Allocates the next revision for the same target (a rollback reset). */
  nextRevision: () => number;
}

export type IosAppNetworkApplyResult =
  /** The provider installed this revision (directly, or found it installed after an uncertain answer). */
  | { kind: "applied"; installedRevision: number; leaseRemainingMs?: number; reconciled: boolean }
  /** The provider definitively refused it; nothing of this command is installed. */
  | { kind: "refused"; outcome: NetworkFilterRuleOutcome; detail: string }
  /** The controller is not installed, approved or signed; nothing reached the provider. */
  | { kind: "not_ready"; state: NetworkFilterState; detail: string }
  /**
   * The answer was lost and the read-back did not show the rule. A reset with a
   * newer revision was sent so a late delivery cannot install it; `rolledBack`
   * says whether the provider confirmed that reset.
   */
  | { kind: "failed"; state: NetworkFilterState; detail: string; rolledBack: boolean };

export type IosAppNetworkResetResult =
  /** No rule of this owner remains for the target. */
  | { kind: "reset"; reconciled: boolean }
  /** The provider refused (another session's rule, or a stale revision). Nothing changed. */
  | { kind: "refused"; outcome: NetworkFilterRuleOutcome; detail: string }
  /** The outcome is unknown and the read-back could not settle it. */
  | { kind: "failed"; state: NetworkFilterState; detail: string };

export type IosAppNetworkRenewResult = "renewed" | "lost" | "retry";

/** States in which the controller never reached the provider, so nothing changed. */
const DEFINITIVELY_UNREACHED: ReadonlySet<NetworkFilterState> = new Set([
  "not_installed",
  "installation_required",
  "approval_required",
]);

function target(rule: IosAppNetworkRule): NetworkFilterRuleTarget {
  return { udid: rule.udid, bundleId: rule.bundleId };
}

function ownership(rule: IosAppNetworkRule): NetworkFilterRuleOwnership {
  return { owner: rule.owner, ownerGeneration: rule.ownerGeneration, revision: rule.revision };
}

function matchesTarget(status: NetworkFilterRuleStatus, rule: NetworkFilterRuleTarget): boolean {
  return (
    status.target.simulator.udid.toUpperCase() === rule.udid.toUpperCase() &&
    status.target.bundleId === rule.bundleId
  );
}

export class IosAppNetworkRuleClient {
  constructor(private readonly bridge: NetworkFilterBridge) {}

  /**
   * Apply `rule` (offline) with a lease. When the controller's answer is lost,
   * `status` decides: the rule's exact revision installed means applied;
   * otherwise a reset with `rollbackRevision()` fences a late delivery.
   */
  async applyOffline(
    rule: IosAppNetworkRule,
    leaseMs: number,
    rollbackRevision: () => number,
  ): Promise<IosAppNetworkApplyResult> {
    const result = await this.bridge.apply(target(rule), ownership(rule), leaseMs);
    if (result.rule) {
      return result.rule.outcome === "applied"
        ? {
            kind: "applied",
            installedRevision: result.rule.installedRevision ?? rule.revision,
            ...(result.rule.leaseRemainingMilliseconds !== undefined
              ? { leaseRemainingMs: result.rule.leaseRemainingMilliseconds }
              : {}),
            reconciled: false,
          }
        : { kind: "refused", outcome: result.rule.outcome, detail: result.detail };
    }
    if (DEFINITIVELY_UNREACHED.has(result.state)) {
      return { kind: "not_ready", state: result.state, detail: result.detail };
    }
    const installed = await this.installedRule(rule);
    if (installed?.revision === rule.revision && installed.owner === rule.owner) {
      return {
        kind: "applied",
        installedRevision: installed.revision,
        leaseRemainingMs: installed.leaseRemainingMilliseconds,
        reconciled: true,
      };
    }
    const rollback = await this.bridge.reset(target(rule), {
      ...ownership(rule),
      revision: rollbackRevision(),
    });
    const rolledBack = rollback.rule?.outcome === "reset";
    logger.warn(
      `[IosAppNetworkRuleClient] apply of ${rule.bundleId} on ${rule.udid} had no answer ` +
        `(${result.state}: ${result.detail}) and was not found installed; rollback ` +
        `${rolledBack ? "confirmed" : `unconfirmed (${rollback.state}: ${rollback.detail})`}`,
    );
    return { kind: "failed", state: result.state, detail: result.detail, rolledBack };
  }

  /** Remove this owner's rule. Never clears another session's rule. */
  async reset(rule: IosAppNetworkRule): Promise<IosAppNetworkResetResult> {
    const result = await this.bridge.reset(target(rule), ownership(rule));
    if (result.rule) {
      return result.rule.outcome === "reset"
        ? { kind: "reset", reconciled: false }
        : { kind: "refused", outcome: result.rule.outcome, detail: result.detail };
    }
    // No installed controller means no provider and therefore no rule.
    if (result.state === "not_installed") {
      return { kind: "reset", reconciled: true };
    }
    return this.reconcileReset(rule, result);
  }

  async renew(rule: IosAppNetworkRule, leaseMs: number): Promise<IosAppNetworkRenewResult> {
    const result = await this.bridge.renew(target(rule), ownership(rule), leaseMs);
    if (!result.rule) {
      return "retry";
    }
    return result.rule.outcome === "renewed" ? "renewed" : "lost";
  }

  private async reconcileReset(
    rule: IosAppNetworkRule,
    result: NetworkFilterRuleCommandResult,
  ): Promise<IosAppNetworkResetResult> {
    const status = await this.bridge.status();
    if (status.state !== "ready") {
      return { kind: "failed", state: result.state, detail: result.detail };
    }
    const installed = (status.rules ?? []).find((candidate) => matchesTarget(candidate, rule));
    // A rule left only by another owner, or none at all, means ours is gone.
    if (!installed || installed.owner !== rule.owner) {
      return { kind: "reset", reconciled: true };
    }
    return { kind: "failed", state: result.state, detail: result.detail };
  }

  private async installedRule(
    rule: IosAppNetworkRule,
  ): Promise<NetworkFilterRuleStatus | undefined> {
    const status = await this.bridge.status();
    if (status.state !== "ready") {
      return undefined;
    }
    return (status.rules ?? []).find(
      (candidate) =>
        matchesTarget(candidate, rule) && candidate.ownerGeneration === rule.ownerGeneration,
    );
  }
}
