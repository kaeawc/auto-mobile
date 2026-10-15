import type { BrokerExecutionRelease } from "./provisioning/executionRelease";
import type { BrokerDeviceAcquisition } from "./provisioning/deviceAcquisition";
import type { BindingJournal } from "./registry/bindingJournal";
import { defaultBindingExecOwnerLiveness } from "./registry/ownerLiveness";
import { runAsBindingReconciler } from "./provisioning/exclusion";
import {
  computeBindingScopeKey,
  journalOwnersEqual,
  sameBinding,
  type BindingAssignmentRecord,
  type BindingKey,
  type BindingRegistry,
  type BindingScopeIdentity,
  type BindingExecOwnerLiveness,
} from "./registry/bindingRegistry";
import { type BrokerProvisionRequest } from "./provisioning/provisionRequest";
import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models/DeviceInfo";
import { parseAndroidSystemImageRuntime } from "../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import {
  SessionBrokerFailureError,
  type SessionBrokerDevicePort,
  type SessionDevicePreparationOptions,
} from "./devicePort";
import { nativeProfile, type BrokerNativeProfile } from "./profile";
import type { BrokerResourceRecord } from "./store";

import { BROKER_BINDING_ROLE } from "./persistedIdentity";

type ManagedDevicePortRegistry = Pick<
  BindingRegistry,
  "getAssignment" | "listOpenBindingJournal" | "openBindingJournal"
>;
type BrokerDeviceAcquisitionResult = Awaited<ReturnType<BrokerDeviceAcquisition["acquire"]>>;
type BrokerDeviceAcquisitionEntry = BrokerDeviceAcquisitionResult["bindings"][number];
type DestructionProgress = "absent" | "pending";

export interface ManagedDevicePortDependencies {
  /** Stable provider-owned identity. Consumer requests never choose this scope or a binding index. */
  scope: BindingScopeIdentity;
  brokerDeviceAcquisition: Pick<BrokerDeviceAcquisition, "acquire">;
  brokerExecutionRelease: Pick<BrokerExecutionRelease, "releaseExecution">;
  registry: ManagedDevicePortRegistry;
  bindingJournal: Pick<BindingJournal, "owner" | "redriveBinding">;
  /** Defaults to the binding PID plus process-generation liveness check. */
  isExecOwnerLive?: BindingExecOwnerLiveness;
  /** Supplied only for qualified platform reset implementations. */
  resetIosBaseline?: (
    device: BootedDevice,
    profile: Extract<BrokerNativeProfile, { platform: "ios" }>,
    assertOwned: () => Promise<void>,
  ) => Promise<"clean">;
  /** Durable request/revision fence; a stale reset must not act on a later session's resource. */
  isCurrentReset?: (resource: BrokerResourceRecord) => Promise<boolean>;
}

/**
 * Bounded native bridge for the session broker's private bindings.
 *
 * The binding reconciler owns provisioning and readiness, the execution release owns the
 * bounded drain, and the durable binding journal owns destructive convergence. This adapter adds no
 * allocator, journal, pool, process, or background work.
 */
export class ManagedDevicePort implements SessionBrokerDevicePort {
  private readonly scope: BindingScopeIdentity;
  private readonly scopeKey: string;
  private readonly isExecOwnerLive: BindingExecOwnerLiveness;

  constructor(private readonly dependencies: ManagedDevicePortDependencies) {
    this.scope = { ...dependencies.scope };
    this.scopeKey = computeBindingScopeKey(this.scope);
    this.isExecOwnerLive = dependencies.isExecOwnerLive ?? defaultBindingExecOwnerLiveness;
  }

  async prepare(
    resource: BrokerResourceRecord,
    options: SessionDevicePreparationOptions,
  ): Promise<{ sessionId: string; profile: BrokerNativeProfile }> {
    this.assertResource(resource, "reserved");
    if (!resource.requestId) {
      throw new ActionableError("A broker device reservation must belong to a session request");
    }
    const profile = nativeProfile(resource);
    const requestedSpec = this.requestedSpec(profile);
    const config = this.bindingConfig(resource, profile, requestedSpec, options);
    const result = await this.dependencies.brokerDeviceAcquisition.acquire(config, {
      livenessOwnerToken: options.livenessOwnerToken,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const sessionId = await this.readySessionId(result, resource, profile);
    return { sessionId, profile };
  }

  private async readySessionId(
    result: BrokerDeviceAcquisitionResult,
    resource: BrokerResourceRecord,
    profile: BrokerNativeProfile,
  ): Promise<string> {
    const binding = result.bindings.find(
      (entry) => entry.bindingIndex === resource.allocationIndex,
    );
    const resultReady = [
      result.outcome === "ready",
      result.scope.scopeKey === this.scopeKey,
      result.bindings.length === 1,
    ].every(Boolean);
    if (resultReady && this.isReadyBinding(binding, profile)) {
      return binding.sessionUuid;
    }
    const sessionId = binding === undefined ? null : binding.sessionUuid;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      await this.dependencies.brokerExecutionRelease.releaseExecution(sessionId);
    }
    const { code, retryable, message } = result.failure ??
      binding?.failure ?? {
        code: "session_preparation_failed",
        retryable: false,
        message: "Managed device preparation did not return an automation-ready session",
      };
    throw new SessionBrokerFailureError({ code, retryable, message });
  }

  private isReadyBinding(
    binding: BrokerDeviceAcquisitionEntry | undefined,
    profile: BrokerNativeProfile,
  ): binding is BrokerDeviceAcquisitionEntry & { sessionUuid: string } {
    if (binding === undefined || binding.readiness === null) {
      return false;
    }
    if (typeof binding.sessionUuid !== "string" || binding.sessionUuid.length === 0) {
      return false;
    }
    return [
      binding.platform === profile.platform,
      binding.failure === undefined,
      binding.device !== null,
      binding.readiness.mode === "automation",
      binding.readiness.status === "automation_ready",
    ].every(Boolean);
  }

  async release(sessionId: string): Promise<{ settled: boolean }> {
    if (!sessionId.trim()) {
      throw new ActionableError("A managed execution session UUID must be non-empty");
    }
    const result = await this.dependencies.brokerExecutionRelease.releaseExecution(sessionId);
    return {
      settled:
        result.outcome === "reusable_for_this_binding" &&
        result.settlement === "confirmed" &&
        result.bindingFailures.length === 0,
    };
  }

  async reset(resource: BrokerResourceRecord): Promise<"clean" | "pending"> {
    this.assertResource(resource, "resetting");
    const profile = nativeProfile(resource);
    const reset = this.dependencies.resetIosBaseline;
    const isCurrent = this.dependencies.isCurrentReset;
    if (profile.platform !== "ios" || !reset || !isCurrent) {
      return "pending";
    }
    const key = this.key(resource);
    const assignment = await this.dependencies.registry.getAssignment(key);
    if (!assignment?.stableDeviceId || !assignment.deviceName) {
      throw new ActionableError("Reset requires a current bound native device");
    }
    const name = assignment.deviceName;
    const expected = {
      generation: assignment.generation,
      stableDeviceId: assignment.stableDeviceId,
    };
    const assertOwned = async () => {
      if (!(await isCurrent(resource))) {
        throw new ActionableError("Clean reset no longer owns its durable resource revision");
      }
      const current = await this.dependencies.registry.getAssignment(key);
      const valid =
        current &&
        sameBinding(current, expected) &&
        current.state === "ready" &&
        current.execOwner === null &&
        current.settler === null &&
        this.belongsToResource(current, profile, this.requestedSpec(profile));
      if (!valid || (await this.hasOpenJournal(key))) {
        throw new ActionableError("Clean reset lost exclusive native binding ownership");
      }
    };
    await assertOwned();
    const result = await runAsBindingReconciler(key, () =>
      reset(
        {
          platform: "ios",
          deviceId: expected.stableDeviceId,
          name,
        },
        profile,
        assertOwned,
      ),
    );
    await assertOwned();
    return result;
  }

  async destroy(resource: BrokerResourceRecord): Promise<DestructionProgress> {
    this.assertResource(resource, "destroying");
    const profile = nativeProfile(resource);
    const requestedSpec = this.requestedSpec(profile);
    const key = this.key(resource);

    if ((await this.redriveOpenJournal(key)) === "pending") {
      return "pending";
    }

    const current = await this.destroyableAssignment(key, profile, requestedSpec);
    if (typeof current === "string") {
      return current;
    }
    const drained = await this.drainAssignment(key, current, profile, requestedSpec);
    return typeof drained === "string" ? drained : this.deleteAssignment(key, drained);
  }

  private async destroyableAssignment(
    key: BindingKey,
    profile: BrokerNativeProfile,
    requestedSpec: BrokerProvisionRequest["requests"][number]["requestedSpec"],
  ): Promise<BindingAssignmentRecord | DestructionProgress> {
    const assignment = await this.dependencies.registry.getAssignment(key);
    if (!assignment || assignment.stableDeviceId === null) {
      return this.confirmNoBinding(key);
    }
    return this.belongsToResource(assignment, profile, requestedSpec) ? assignment : "pending";
  }

  private async drainAssignment(
    key: BindingKey,
    assignment: BindingAssignmentRecord,
    profile: BrokerNativeProfile,
    requestedSpec: BrokerProvisionRequest["requests"][number]["requestedSpec"],
  ): Promise<BindingAssignmentRecord | DestructionProgress> {
    if (!assignment.execOwner) {
      return assignment;
    }
    if (!journalOwnersEqual(assignment.execOwner, this.dependencies.bindingJournal.owner)) {
      return this.isExecOwnerLive(assignment.execOwner) ? "pending" : assignment;
    }
    const released = await this.release(assignment.execOwner.sessionUuid);
    if (!released.settled) {
      return "pending";
    }
    const after = await this.dependencies.registry.getAssignment(key);
    if (!after) {
      return this.confirmNoBinding(key);
    }
    const unchanged = [
      sameBinding(after, {
        generation: assignment.generation,
        stableDeviceId: assignment.stableDeviceId,
      }),
      after.execOwner === null,
      this.belongsToResource(after, profile, requestedSpec),
    ].every(Boolean);
    return unchanged ? after : "pending";
  }

  private async deleteAssignment(
    key: BindingKey,
    assignment: BindingAssignmentRecord,
  ): Promise<DestructionProgress> {
    if (assignment.stableDeviceId === null) {
      return this.confirmNoBinding(key);
    }
    const stableDeviceId = assignment.stableDeviceId;
    const opened = await this.dependencies.registry.openBindingJournal(key, {
      kind: "replace",
      phase: "deleting",
      owner: this.dependencies.bindingJournal.owner,
      target: {
        oldStableId: stableDeviceId,
        oldName: assignment.deviceName,
        newName: null,
        newStableId: null,
        requestedSpec: assignment.requestedSpec,
        resolvedSpec: assignment.resolvedSpec,
        specFingerprint: assignment.specFingerprint,
      },
      assignment: {
        kind: "state",
        expected: {
          generation: assignment.generation,
          stableDeviceId,
        },
        state: "replacing",
      },
    });
    if (opened.kind !== "opened" && opened.kind !== "journal_open") {
      return "pending";
    }
    const redriven = await this.dependencies.bindingJournal.redriveBinding(key);
    if (redriven.kind === "blocked" || (await this.hasOpenJournal(key))) {
      return "pending";
    }
    const after = await this.dependencies.registry.getAssignment(key);
    return !after || after.stableDeviceId === null ? "absent" : "pending";
  }

  private async confirmNoBinding(key: BindingKey): Promise<DestructionProgress> {
    const assignment = await this.dependencies.registry.getAssignment(key);
    if (
      assignment !== null &&
      (assignment.stableDeviceId !== null ||
        assignment.execOwner !== null ||
        assignment.settler !== null)
    ) {
      return "pending";
    }
    return (await this.hasOpenJournal(key)) ? "pending" : "absent";
  }

  private assertResource(
    resource: BrokerResourceRecord,
    expectedState: "reserved" | "destroying" | "resetting",
  ): void {
    if (!resource.resourceId.trim()) {
      throw new ActionableError("A broker resource identity must be non-empty");
    }
    if (
      !Number.isSafeInteger(resource.allocationIndex) ||
      resource.allocationIndex < 0 ||
      resource.scopeKey !== this.scopeKey
    ) {
      throw new ActionableError("Broker resource does not belong to this provider-owned scope");
    }
    if (resource.state !== expectedState) {
      throw new ActionableError(
        `Broker resource '${resource.resourceId}' must be ${expectedState}, not ${resource.state}`,
      );
    }
  }

  private key(resource: BrokerResourceRecord): BindingKey {
    return { scopeKey: this.scopeKey, bindingIndex: resource.allocationIndex };
  }

  private bindingConfig(
    resource: BrokerResourceRecord,
    profile: BrokerNativeProfile,
    requestedSpec: BrokerProvisionRequest["requests"][number]["requestedSpec"],
    options: SessionDevicePreparationOptions,
  ): BrokerProvisionRequest {
    return {
      contractVersion: 1,
      ...this.scope,
      localBindingCapacity: 1,
      requests: [
        {
          bindingIndex: resource.allocationIndex,
          role: BROKER_BINDING_ROLE,
          platform: profile.platform,
          requestedSpec,
        },
      ],
      ...(options.preparationTimeoutMs === undefined
        ? {}
        : { preparationTimeoutMs: options.preparationTimeoutMs }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.executionOwnerPid === undefined
        ? {}
        : { executionOwnerPid: options.executionOwnerPid }),
    };
  }

  private requestedSpec(
    profile: BrokerNativeProfile,
  ): BrokerProvisionRequest["requests"][number]["requestedSpec"] {
    if (profile.platform === "ios") {
      return {
        runtime: profile.runtimeId,
        deviceType: profile.simulatorDeviceTypeIdentifier,
      };
    }
    const runtime = parseAndroidSystemImageRuntime(profile.systemImagePackage);
    if (
      !runtime ||
      runtime.apiLevel !== profile.apiLevel ||
      runtime.abi !== profile.abi ||
      runtime.tag !== profile.flavor
    ) {
      throw new ActionableError(
        "Stored Android profile does not agree with its exact system-image package",
      );
    }
    return {
      runtime: runtime.systemImagePackage,
      deviceType: profile.profileId,
    };
  }

  private belongsToResource(
    assignment: BindingAssignmentRecord,
    profile: BrokerNativeProfile,
    requestedSpec: BrokerProvisionRequest["requests"][number]["requestedSpec"],
  ): boolean {
    if (
      assignment.scopeKey !== this.scopeKey ||
      assignment.role !== BROKER_BINDING_ROLE ||
      assignment.platform !== profile.platform
    ) {
      return false;
    }
    const stored = assignment.requestedSpec;
    if (!stored || typeof stored !== "object") {
      return false;
    }
    const candidate = stored as { runtime?: unknown; deviceType?: unknown };
    return (
      candidate.runtime === requestedSpec.runtime &&
      candidate.deviceType === requestedSpec.deviceType
    );
  }

  private async redriveOpenJournal(key: BindingKey): Promise<"clear" | "pending"> {
    if (!(await this.hasOpenJournal(key))) {
      return "clear";
    }
    const result = await this.dependencies.bindingJournal.redriveBinding(key);
    return result.kind === "clear" && !(await this.hasOpenJournal(key)) ? "clear" : "pending";
  }

  private async hasOpenJournal(key: BindingKey): Promise<boolean> {
    return (await this.dependencies.registry.listOpenBindingJournal(key)).length > 0;
  }
}
