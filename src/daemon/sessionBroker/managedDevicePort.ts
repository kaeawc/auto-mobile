import type { ManagedExecutionRelease } from "../managedSlots/managedExecutionRelease";
import type { ManagedSlotAcquisition } from "../managedSlots/managedSlotAcquisition";
import type { ManagedSlotJournal } from "../managedSlots/slotJournal";
import { defaultSlotExecOwnerLiveness } from "../managedSlots/slotOwnerLiveness";
import { runAsManagedSlotReconciler } from "../managedSlots/managedSlotExclusion";
import {
  computeSlotScopeKey,
  journalOwnersEqual,
  sameBinding,
  type SlotAssignmentRecord,
  type SlotKey,
  type SlotRegistry,
  type SlotScopeIdentity,
  type SlotExecOwnerLiveness,
} from "../managedSlots/slotRegistry";
import { parseManagedSlotConfig, type ManagedSlotConfig } from "../../models/managedSlotConfig";
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

const BROKER_SLOT_ROLE = "session-broker-device";

type ManagedDevicePortRegistry = Pick<
  SlotRegistry,
  "getAssignment" | "listOpenSlotJournal" | "openSlotJournal"
>;
type ManagedSlotAcquisitionResult = Awaited<ReturnType<ManagedSlotAcquisition["acquire"]>>;
type ManagedSlotAcquisitionEntry = ManagedSlotAcquisitionResult["slots"][number];
type DestructionProgress = "absent" | "pending";

export interface ManagedDevicePortDependencies {
  /** Stable provider-owned identity. Consumer requests never choose this scope or a slot index. */
  scope: SlotScopeIdentity;
  managedSlotAcquisition: Pick<ManagedSlotAcquisition, "acquire">;
  managedExecutionRelease: Pick<ManagedExecutionRelease, "releaseExecution">;
  registry: ManagedDevicePortRegistry;
  managedSlotJournal: Pick<ManagedSlotJournal, "owner" | "redriveSlot">;
  /** Defaults to the managed-slot PID plus process-generation liveness check. */
  isExecOwnerLive?: SlotExecOwnerLiveness;
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
 * Bounded native bridge for the session broker's private managed slots.
 *
 * The managed-slot reconciler owns provisioning and readiness, the execution release owns the
 * bounded drain, and the durable slot journal owns destructive convergence. This adapter adds no
 * allocator, journal, pool, process, or background work.
 */
export class ManagedDevicePort implements SessionBrokerDevicePort {
  private readonly scope: SlotScopeIdentity;
  private readonly scopeKey: string;
  private readonly isExecOwnerLive: SlotExecOwnerLiveness;

  constructor(private readonly dependencies: ManagedDevicePortDependencies) {
    this.scope = { ...dependencies.scope };
    this.scopeKey = computeSlotScopeKey(this.scope);
    this.isExecOwnerLive = dependencies.isExecOwnerLive ?? defaultSlotExecOwnerLiveness;
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
    const config = this.managedSlotConfig(resource, profile, requestedSpec, options);
    const result = await this.dependencies.managedSlotAcquisition.acquire(config, {
      livenessOwnerToken: options.livenessOwnerToken,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const sessionId = await this.readySessionId(result, resource, profile);
    return { sessionId, profile };
  }

  private async readySessionId(
    result: ManagedSlotAcquisitionResult,
    resource: BrokerResourceRecord,
    profile: BrokerNativeProfile,
  ): Promise<string> {
    const slot = result.slots.find((entry) => entry.slotIndex === resource.allocationIndex);
    const resultReady = [
      result.outcome === "ready",
      result.scope.scopeKey === this.scopeKey,
      result.slots.length === 1,
    ].every(Boolean);
    if (resultReady && this.isReadySlot(slot, profile)) {
      return slot.sessionUuid;
    }
    const sessionId = slot === undefined ? null : slot.sessionUuid;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      await this.dependencies.managedExecutionRelease.releaseExecution(sessionId);
    }
    const { code, retryable, message } = result.failure ??
      slot?.failure ?? {
        code: "session_preparation_failed",
        retryable: false,
        message: "Managed device preparation did not return an automation-ready session",
      };
    throw new SessionBrokerFailureError({ code, retryable, message });
  }

  private isReadySlot(
    slot: ManagedSlotAcquisitionEntry | undefined,
    profile: BrokerNativeProfile,
  ): slot is ManagedSlotAcquisitionEntry & { sessionUuid: string } {
    if (slot === undefined || slot.readiness === null) {
      return false;
    }
    if (typeof slot.sessionUuid !== "string" || slot.sessionUuid.length === 0) {
      return false;
    }
    return [
      slot.platform === profile.platform,
      slot.failure === undefined,
      slot.device !== null,
      slot.readiness.mode === "automation",
      slot.readiness.status === "automation_ready",
    ].every(Boolean);
  }

  async release(sessionId: string): Promise<{ settled: boolean }> {
    if (!sessionId.trim()) {
      throw new ActionableError("A managed execution session UUID must be non-empty");
    }
    const result = await this.dependencies.managedExecutionRelease.releaseExecution(sessionId);
    return {
      settled:
        result.outcome === "reusable_for_this_slot" &&
        result.settlement === "confirmed" &&
        result.slotFailures.length === 0,
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
    const result = await runAsManagedSlotReconciler(key, () =>
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
    key: SlotKey,
    profile: BrokerNativeProfile,
    requestedSpec: ManagedSlotConfig["requests"][number]["requestedSpec"],
  ): Promise<SlotAssignmentRecord | DestructionProgress> {
    const assignment = await this.dependencies.registry.getAssignment(key);
    if (!assignment || assignment.stableDeviceId === null) {
      return this.confirmNoBinding(key);
    }
    return this.belongsToResource(assignment, profile, requestedSpec) ? assignment : "pending";
  }

  private async drainAssignment(
    key: SlotKey,
    assignment: SlotAssignmentRecord,
    profile: BrokerNativeProfile,
    requestedSpec: ManagedSlotConfig["requests"][number]["requestedSpec"],
  ): Promise<SlotAssignmentRecord | DestructionProgress> {
    if (!assignment.execOwner) {
      return assignment;
    }
    if (!journalOwnersEqual(assignment.execOwner, this.dependencies.managedSlotJournal.owner)) {
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
    key: SlotKey,
    assignment: SlotAssignmentRecord,
  ): Promise<DestructionProgress> {
    if (assignment.stableDeviceId === null) {
      return this.confirmNoBinding(key);
    }
    const stableDeviceId = assignment.stableDeviceId;
    const opened = await this.dependencies.registry.openSlotJournal(key, {
      kind: "replace",
      phase: "deleting",
      owner: this.dependencies.managedSlotJournal.owner,
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
    const redriven = await this.dependencies.managedSlotJournal.redriveSlot(key);
    if (redriven.kind === "blocked" || (await this.hasOpenJournal(key))) {
      return "pending";
    }
    const after = await this.dependencies.registry.getAssignment(key);
    return !after || after.stableDeviceId === null ? "absent" : "pending";
  }

  private async confirmNoBinding(key: SlotKey): Promise<DestructionProgress> {
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

  private key(resource: BrokerResourceRecord): SlotKey {
    return { scopeKey: this.scopeKey, slotIndex: resource.allocationIndex };
  }

  private managedSlotConfig(
    resource: BrokerResourceRecord,
    profile: BrokerNativeProfile,
    requestedSpec: ManagedSlotConfig["requests"][number]["requestedSpec"],
    options: SessionDevicePreparationOptions,
  ): ManagedSlotConfig {
    return parseManagedSlotConfig({
      contractVersion: 1,
      ...this.scope,
      localSlotCapacity: 1,
      requests: [
        {
          slotIndex: resource.allocationIndex,
          role: BROKER_SLOT_ROLE,
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
    });
  }

  private requestedSpec(
    profile: BrokerNativeProfile,
  ): ManagedSlotConfig["requests"][number]["requestedSpec"] {
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
    assignment: SlotAssignmentRecord,
    profile: BrokerNativeProfile,
    requestedSpec: ManagedSlotConfig["requests"][number]["requestedSpec"],
  ): boolean {
    if (
      assignment.scopeKey !== this.scopeKey ||
      assignment.role !== BROKER_SLOT_ROLE ||
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

  private async redriveOpenJournal(key: SlotKey): Promise<"clear" | "pending"> {
    if (!(await this.hasOpenJournal(key))) {
      return "clear";
    }
    const result = await this.dependencies.managedSlotJournal.redriveSlot(key);
    return result.kind === "clear" && !(await this.hasOpenJournal(key)) ? "clear" : "pending";
  }

  private async hasOpenJournal(key: SlotKey): Promise<boolean> {
    return (await this.dependencies.registry.listOpenSlotJournal(key)).length > 0;
  }
}
