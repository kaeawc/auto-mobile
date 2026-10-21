import {
  NETWORK_FILTER_CONTRACT_VERSION,
  networkFilterShapingRequestRejection,
  networkFilterShapingRejectionDetail,
  NETWORK_FILTER_UPGRADE_COMMAND,
  type NetworkFilterShapingRequest,
  type NetworkFilterShapingResolution,
  type NetworkFilterRuleResult,
  type NetworkFilterBridge,
  type NetworkFilterRuleCommandResult,
  type NetworkFilterRuleOwnership,
  type NetworkFilterRuleStatus,
  type NetworkFilterRuleTarget,
  type NetworkFilterSnapshot,
  type NetworkFilterSnapshotResult,
  type NetworkFilterState,
  type NetworkFilterStatus,
} from "../../src/features/networkFilter/NetworkFilterBridge";

export type FakeRuleCommand = "apply" | "reset" | "renew";

export interface FakeRuleCall {
  command: FakeRuleCommand;
  target: NetworkFilterRuleTarget;
  ownership: NetworkFilterRuleOwnership;
  leaseMs?: number;
  shaping?: NetworkFilterShapingRequest;
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
  controllerVersion: 3 | 4 = NETWORK_FILTER_CONTRACT_VERSION;
  supportsShaping = true;
  statusCalls = 0;
  snapshotCalls = 0;
  readonly ruleCalls: FakeRuleCall[] = [];
  /** Consumed one per rule command; empty means `deliver`. */
  readonly ruleScripts: FakeRuleScript[] = [];
  /** Lease milliseconds remaining that the model reports for each rule. */
  leaseRemainingMs = 15_000;
  private readonly requests = new Map<string, NetworkFilterShapingRequest>();
  private readonly rules = new Map<string, NetworkFilterRuleStatus>();

  constructor(result: NetworkFilterSnapshotResult = { state: "not_installed", detail: "fake" }) {
    this.result = result;
  }

  /** Report `state` with the current contract version (none for `not_installed`). */
  setState(state: NetworkFilterState, detail = `fake ${state}`): void {
    this.result =
      state === "not_installed"
        ? { state, detail }
        : { state, detail, contractVersion: this.controllerVersion };
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
    this.requests.clear();
  }

  async status(): Promise<NetworkFilterStatus> {
    this.statusCalls += 1;
    const { state, detail } = this.result;
    const contractVersion = state === "not_installed" ? undefined : this.controllerVersion;
    return {
      state,
      detail,
      ...(contractVersion === undefined ? {} : { contractVersion }),
      ...(state === "ready" ? { rules: this.activeRules() } : {}),
    };
  }

  async snapshot(): Promise<NetworkFilterSnapshotResult> {
    this.snapshotCalls += 1;
    return this.result.state === "not_installed"
      ? this.result
      : { ...this.result, contractVersion: this.controllerVersion };
  }

  apply(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
    leaseMs: number,
    shaping?: NetworkFilterShapingRequest,
  ): Promise<NetworkFilterRuleCommandResult> {
    const rejection = shaping && networkFilterShapingRequestRejection(shaping);
    if (rejection) {
      return Promise.resolve({
        state: "unavailable",
        detail: networkFilterShapingRejectionDetail(rejection),
      });
    }
    return this.run({
      command: "apply",
      target,
      ownership,
      leaseMs,
      ...(shaping ? { shaping } : {}),
    });
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
    if (call.shaping && this.controllerVersion === 3) {
      return {
        state: "unavailable",
        contractVersion: 3,
        detail: `Installed controller version 3 requires version 4 for shaping; update with ${NETWORK_FILTER_UPGRADE_COMMAND}.`,
        upgradeRequired: {
          installedVersion: 3,
          requiredVersion: 4,
          command: NETWORK_FILTER_UPGRADE_COMMAND,
        },
      };
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
          contractVersion: this.controllerVersion,
          rule,
        };
  }

  private execute(call: FakeRuleCall): NonNullable<NetworkFilterRuleCommandResult["rule"]> {
    const key = `${call.target.udid.toUpperCase()}|${call.target.bundleId}`;
    const existing = this.rules.get(key);
    const ours = existing?.owner === call.ownership.owner;
    switch (call.command) {
      case "apply":
        return this.applyRule(call, key, existing);
      case "reset":
        if (existing && !ours) {
          return { outcome: "owned_by_another_session" };
        }
        this.rules.delete(key);
        this.requests.delete(key);
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

  private applyRule(
    call: FakeRuleCall,
    key: string,
    existing?: NetworkFilterRuleStatus,
  ): NetworkFilterRuleResult {
    const resolved = call.shaping ? this.resolveShaping(call.shaping) : undefined;
    if (resolved && "outcome" in resolved) {
      return resolved;
    }
    if (existing && existing.owner !== call.ownership.owner) {
      return { outcome: "owned_by_another_session" };
    }
    if (existing && existing.revision > call.ownership.revision) {
      return { outcome: "stale_revision", installedRevision: existing.revision };
    }
    if (
      existing?.revision === call.ownership.revision &&
      existing.ownerGeneration === call.ownership.ownerGeneration &&
      !this.sameConfiguration(call, key, existing)
    ) {
      return { outcome: "invalid_command" };
    }
    const status = {
      target: {
        simulator: { deviceSet: FAKE_DEVICE_SET, udid: call.target.udid },
        bundleId: call.target.bundleId,
      },
      owner: call.ownership.owner,
      ownerGeneration: call.ownership.ownerGeneration,
      revision: call.ownership.revision,
      leaseRemainingMilliseconds: this.leaseRemainingMs,
      droppedFlows: 0,
    };
    this.rules.set(
      key,
      resolved
        ? { ...status, condition: "shaped", shaping: resolved }
        : { ...status, condition: "offline" },
    );
    if (call.shaping) {
      this.requests.set(key, { ...call.shaping });
    } else {
      this.requests.delete(key);
    }
    return {
      outcome: "applied",
      installedRevision: call.ownership.revision,
      leaseRemainingMilliseconds: this.leaseRemainingMs,
      ...(resolved ? { shaping: resolved } : {}),
    };
  }

  private sameConfiguration(
    call: FakeRuleCall,
    key: string,
    existing: NetworkFilterRuleStatus,
  ): boolean {
    const previous = this.requests.get(key);
    if (!call.shaping) {
      return existing.condition === "offline";
    }
    return (
      existing.condition === "shaped" &&
      previous !== undefined &&
      Math.round(previous.delayMs) === Math.round(call.shaping.delayMs) &&
      Math.round(previous.downloadKbps) === Math.round(call.shaping.downloadKbps) &&
      Math.round(previous.uploadKbps) === Math.round(call.shaping.uploadKbps) &&
      (previous.packetLossPercent ?? 0) === (call.shaping.packetLossPercent ?? 0)
    );
  }

  private resolveShaping(
    request: NetworkFilterShapingRequest,
  ): NetworkFilterShapingResolution | NetworkFilterRuleResult {
    if (!this.supportsShaping) {
      return { outcome: "unsupported_condition" };
    }
    const delayMs = Math.round(request.delayMs);
    const downloadKbps = Math.round(request.downloadKbps);
    const uploadKbps = Math.round(request.uploadKbps);
    const loss = request.packetLossPercent ?? 0;
    const ranges = [
      { component: "latency", valid: Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 4000 },
      { component: "downloadBandwidth", valid: this.validRate(downloadKbps) },
      { component: "uploadBandwidth", valid: this.validRate(uploadKbps) },
      { component: "packetLoss", valid: Number.isFinite(loss) && loss >= 0 && loss <= 100 },
    ] as const;
    const invalid = ranges.find((range) => !range.valid);
    if (invalid) {
      return {
        outcome: "invalid_shaping",
        rejection: { reason: "out_of_range", component: invalid.component },
      };
    }
    const applied: NetworkFilterShapingResolution["applied"] = [];
    if (delayMs > 0) {
      applied.push("latency");
    }
    if (downloadKbps > 0) {
      applied.push("downloadBandwidth");
    }
    if (uploadKbps > 0) {
      applied.push("uploadBandwidth");
    }
    const unapplied: NetworkFilterShapingResolution["unapplied"] = loss > 0 ? ["packetLoss"] : [];
    if (applied.length === 0) {
      return { outcome: "invalid_shaping", rejection: { reason: "nothing_to_apply", unapplied } };
    }
    return {
      profile: {
        outboundDelayMilliseconds: Math.ceil(delayMs / 2),
        inboundDelayMilliseconds: Math.floor(delayMs / 2),
        ...(downloadKbps > 0 ? { inboundBytesPerSecond: downloadKbps * 125 } : {}),
        ...(uploadKbps > 0 ? { outboundBytesPerSecond: uploadKbps * 125 } : {}),
      },
      applied,
      unapplied,
    };
  }

  private validRate(rate: number): boolean {
    return Number.isInteger(rate) && (rate === 0 || (rate >= 8 && rate <= 1000000));
  }
}
