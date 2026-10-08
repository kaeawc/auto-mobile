import {
  NETWORK_FILTER_CONTRACT_VERSION,
  type NetworkFilterBridge,
  type NetworkFilterRuleCommandResult,
  type NetworkFilterRuleOwnership,
  type NetworkFilterRuleStatus,
  type NetworkFilterRuleTarget,
  type NetworkFilterSnapshot,
  type NetworkFilterSnapshotResult,
  type NetworkFilterState,
  type NetworkFilterStatus,
} from "../../src/features/network-filter/NetworkFilterBridge";

export type FakeRuleCommand = "apply" | "reset" | "renew";

export interface FakeRuleCall {
  command: FakeRuleCommand;
  target: NetworkFilterRuleTarget;
  ownership: NetworkFilterRuleOwnership;
  leaseMs?: number;
}

/**
 * How the fake answers the next rule command:
 * - `deliver`: the provider runs it and the answer arrives (the default).
 * - `lost`: the provider runs it, but the answer is lost (`unavailable`, no `rule`).
 * - `dropped`: it never reaches the provider, and no answer arrives.
 * - a fixed result: returned as-is; the provider is not touched.
 */
export type FakeRuleScript = "deliver" | "lost" | "dropped" | NetworkFilterRuleCommandResult;

const FAKE_DEVICE_SET = "/fake/Devices";

/**
 * Scripted {@link NetworkFilterBridge}. Status and snapshot return the configured
 * result; rule commands run against a small in-memory model of the provider's
 * owner-fenced rules (one rule per target, owners never clear each other).
 */
export class FakeNetworkFilterBridge implements NetworkFilterBridge {
  private result: NetworkFilterSnapshotResult;
  statusCalls = 0;
  snapshotCalls = 0;
  readonly ruleCalls: FakeRuleCall[] = [];
  /** Consumed one per rule command; empty means `deliver`. */
  readonly ruleScripts: FakeRuleScript[] = [];
  /** Lease milliseconds remaining that the model reports for each rule. */
  leaseRemainingMs = 15_000;
  private readonly rules = new Map<string, NetworkFilterRuleStatus>();

  constructor(result: NetworkFilterSnapshotResult = { state: "not_installed", detail: "fake" }) {
    this.result = result;
  }

  /** Report `state` with the current contract version (none for `not_installed`). */
  setState(state: NetworkFilterState, detail = `fake ${state}`): void {
    this.result =
      state === "not_installed"
        ? { state, detail }
        : { state, detail, contractVersion: NETWORK_FILTER_CONTRACT_VERSION };
  }

  setResult(result: NetworkFilterSnapshotResult): void {
    this.result = result;
  }

  setSnapshot(snapshot: NetworkFilterSnapshot): void {
    this.result = { ...this.result, snapshot };
  }

  /** The rules the modelled provider holds right now. */
  activeRules(): NetworkFilterRuleStatus[] {
    return [...this.rules.values()];
  }

  /** As if the lease ran out or the provider restarted. */
  expireAll(): void {
    this.rules.clear();
  }

  async status(): Promise<NetworkFilterStatus> {
    this.statusCalls += 1;
    const { state, detail, contractVersion } = this.result;
    return {
      state,
      detail,
      ...(contractVersion === undefined ? {} : { contractVersion }),
      ...(state === "ready" ? { rules: this.activeRules() } : {}),
    };
  }

  async snapshot(): Promise<NetworkFilterSnapshotResult> {
    this.snapshotCalls += 1;
    return this.result;
  }

  apply(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
    leaseMs: number,
  ): Promise<NetworkFilterRuleCommandResult> {
    return this.run({ command: "apply", target, ownership, leaseMs });
  }

  reset(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
  ): Promise<NetworkFilterRuleCommandResult> {
    return this.run({ command: "reset", target, ownership });
  }

  renew(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
    leaseMs: number,
  ): Promise<NetworkFilterRuleCommandResult> {
    return this.run({ command: "renew", target, ownership, leaseMs });
  }

  private async run(call: FakeRuleCall): Promise<NetworkFilterRuleCommandResult> {
    this.ruleCalls.push(call);
    const script = this.ruleScripts.shift() ?? "deliver";
    if (typeof script === "object") {
      return script;
    }
    if (this.result.state !== "ready") {
      const { state, detail, contractVersion } = this.result;
      return { state, detail, ...(contractVersion === undefined ? {} : { contractVersion }) };
    }
    const lostAnswer: NetworkFilterRuleCommandResult = {
      state: "unavailable",
      detail: "fake: the controller's answer was lost",
    };
    if (script === "dropped") {
      return lostAnswer;
    }
    const rule = this.execute(call);
    return script === "lost"
      ? lostAnswer
      : {
          state: "ready",
          detail: `fake ${call.command}`,
          contractVersion: NETWORK_FILTER_CONTRACT_VERSION,
          rule,
        };
  }

  private execute(call: FakeRuleCall): NonNullable<NetworkFilterRuleCommandResult["rule"]> {
    const key = `${call.target.udid.toUpperCase()}|${call.target.bundleId}`;
    const existing = this.rules.get(key);
    const ours = existing?.owner === call.ownership.owner;
    switch (call.command) {
      case "apply":
        if (existing && !ours) {
          return { outcome: "owned_by_another_session" };
        }
        if (existing && existing.revision > call.ownership.revision) {
          return { outcome: "stale_revision", installedRevision: existing.revision };
        }
        this.rules.set(key, {
          target: {
            simulator: { deviceSet: FAKE_DEVICE_SET, udid: call.target.udid },
            bundleId: call.target.bundleId,
          },
          owner: call.ownership.owner,
          ownerGeneration: call.ownership.ownerGeneration,
          revision: call.ownership.revision,
          condition: "offline",
          leaseRemainingMilliseconds: this.leaseRemainingMs,
          droppedFlows: 0,
        });
        return {
          outcome: "applied",
          installedRevision: call.ownership.revision,
          leaseRemainingMilliseconds: this.leaseRemainingMs,
        };
      case "reset":
        if (existing && !ours) {
          return { outcome: "owned_by_another_session" };
        }
        this.rules.delete(key);
        return { outcome: "reset" };
      case "renew":
        if (!existing || !ours) {
          return { outcome: "not_found" };
        }
        return existing.revision === call.ownership.revision
          ? { outcome: "renewed", installedRevision: existing.revision }
          : { outcome: "stale_revision", installedRevision: existing.revision };
    }
  }
}
