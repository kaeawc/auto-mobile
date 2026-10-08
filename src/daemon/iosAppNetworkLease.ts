import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type {
  IosAppNetworkRenewResult,
  IosAppNetworkRule,
} from "../features/network-filter/IosAppNetworkRuleClient";

/** Narrow seam the session manager uses for iOS Simulator per-app network rules (#10264). */
export interface IosAppNetworkRuleRestorer {
  /** Remove the rule; throws unless no rule of this owner remains for the target. */
  reset(rule: IosAppNetworkRule): Promise<void>;
  renew(rule: IosAppNetworkRule, leaseMs: number): Promise<IosAppNetworkRenewResult>;
}

export interface IosAppNetworkLeaseOptions {
  leaseMs: number;
  renewIntervalMs: number;
}

interface LeaseEntry {
  rule: IosAppNetworkRule;
  handle?: NodeJS.Timeout;
  /** Host time of the last confirmed lease start (apply or renew). */
  confirmedAtMs: number;
  isCurrent: () => boolean;
}

/**
 * Renews each session's installed rule on an injected timer. The provider
 * enforces the lease on its own; this only keeps a live session's rule alive.
 *
 * Every tick, and every renew answer that arrives after an await, re-checks
 * that the entry is still the one it was started for and that the caller still
 * owns the rule (`isCurrent`), so a release, rebind, reset or replacement that
 * happens while a renew is in flight is never undone by a late callback.
 * A renew the provider refuses, or no confirmed renew within one lease, ends
 * renewal: the provider has dropped the rule by then.
 */
export class IosAppNetworkLeases {
  private readonly entries = new Map<string, LeaseEntry>();

  constructor(
    private readonly timer: Timer,
    private readonly restorer: () => IosAppNetworkRuleRestorer,
    private readonly options: IosAppNetworkLeaseOptions,
  ) {}

  /** Start (or restart) renewal for `key`; the rule was just confirmed installed. */
  start(key: string, rule: IosAppNetworkRule, isCurrent: () => boolean): void {
    this.stop(key);
    const entry: LeaseEntry = {
      rule,
      confirmedAtMs: this.timer.now(),
      isCurrent,
    };
    this.entries.set(key, entry);
    this.schedule(key, entry);
  }

  stop(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.handle !== undefined) {
      this.timer.clearTimeout(entry.handle);
    }
    this.entries.delete(key);
  }

  /** The rule whose lease is being renewed for `key`, if any. */
  active(key: string): IosAppNetworkRule | undefined {
    return this.entries.get(key)?.rule;
  }

  stopAll(): void {
    for (const key of [...this.entries.keys()]) {
      this.stop(key);
    }
  }

  private schedule(key: string, entry: LeaseEntry): void {
    entry.handle = this.timer.setTimeout(() => {
      void this.tick(key, entry);
    }, this.options.renewIntervalMs);
  }

  private live(key: string, entry: LeaseEntry): boolean {
    return this.entries.get(key) === entry && entry.isCurrent();
  }

  private async tick(key: string, entry: LeaseEntry): Promise<void> {
    if (!this.live(key, entry)) {
      this.stopIfSame(key, entry);
      return;
    }
    let result: IosAppNetworkRenewResult;
    try {
      result = await this.restorer().renew(entry.rule, this.options.leaseMs);
    } catch (error) {
      logger.warn(
        `[IosAppNetworkLeases] renewing ${entry.rule.bundleId} on ${entry.rule.udid} failed: ${errorMessage(error)}`,
        error,
      );
      result = "retry";
    }
    // Delayed callback: the session may have been released, rebound or reset meanwhile.
    if (!this.live(key, entry)) {
      this.stopIfSame(key, entry);
      return;
    }
    if (result === "renewed") {
      entry.confirmedAtMs = this.timer.now();
      this.schedule(key, entry);
      return;
    }
    if (result === "retry" && this.timer.now() - entry.confirmedAtMs < this.options.leaseMs) {
      this.schedule(key, entry);
      return;
    }
    logger.warn(
      `[IosAppNetworkLeases] lease for ${entry.rule.bundleId} on ${entry.rule.udid} ` +
        `(revision ${entry.rule.revision}) ended: ${result === "lost" ? "the provider no longer holds it" : "no renew was confirmed within the lease"}`,
    );
    this.stopIfSame(key, entry);
  }

  private stopIfSame(key: string, entry: LeaseEntry): void {
    if (this.entries.get(key) === entry) {
      this.stop(key);
    }
  }
}
