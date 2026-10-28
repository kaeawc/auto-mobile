import { holderOf } from "../deviceBinding";
import { isAndroidOrIosPlatform, Platform } from "../../models";
import { DeviceAllocationCriteria } from "../DeviceCriteriaMatcher";
import {
  currentBindingReconciler,
  bindingRefusal,
  refreshAllocationBindingExclusion,
} from "../sessionBroker/provisioning/exclusion";
import {
  DeviceAssignedToBindingError,
  BindingDiscoveryIncompleteError,
} from "../sessionBroker/provisioning/refusal";
import type { PooledDevice } from "../devicePoolTypes";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface BindingOperations {
  /**
   * The synchronous broker binding refusal for a device, from the last snapshot: undefined when no
   * broker binding holds it or the requester is that binding's live execution. For lifecycle re-checks
   * that run under the assignment mutex; entry points refresh first through
   * {@link assertNotAssignedToBinding}.
   */
  bindingRefusalFor(input: {
    action: string;
    deviceId: string;
    platform: Platform;
    stableIds?: ReadonlyArray<string | undefined>;
    requesterSessionUuid?: string;
  }): Error | undefined;
  /** Whether the exclusion snapshot follows a failed registry read. */
  bindingSnapshotRetainedAfterFailedRead(): boolean;
  mayForceManagedReread(input: {
    deviceId: string;
    requesterSessionUuid?: string;
    maxAgeMs?: number;
  }): boolean;
  assertNotAssignedToBinding(input: {
    action: string;
    deviceId: string;
    platform: Platform;
    stableIds?: ReadonlyArray<string | undefined>;
    requesterSessionUuid?: string;
    /** Reuse a snapshot younger than this; destructive callers leave it unset (always fresh). */
    maxAgeMs?: number;
  }): Promise<void>;
  judgeRetainedManagedSnapshot(
    input: Parameters<DevicePoolOperations["assertNotAssignedToBinding"]>[0],
    error: BindingDiscoveryIncompleteError,
  ): void;
  bindingStableIds(platform: Platform): Promise<ReadonlySet<string>>;
  getDevicesMatchingCriteria(criteria?: DeviceAllocationCriteria): PooledDevice[];
}
type BindingState = Pick<
  DevicePoolState,
  "bindingExclusion" | "devices" | "timer" | "managedRereadAtMs" | "criteriaMatcher"
>;
export type BindingCallbacks = Pick<
  DevicePoolOperations,
  | "managedRefFor"
  | "isUnresolvedEmulatorWhileAndroidManaged"
  | "bindingRefusalFor"
  | "getAllDevices"
>;

/** Binding responsibilities of DevicePool. */
export class DevicePoolBinding {
  constructor(
    private readonly state: BindingState,
    private readonly callbacks: BindingCallbacks,
  ) {}
  /**
   * The synchronous broker binding refusal for a device, from the last snapshot: undefined when no
   * broker binding holds it or the requester is that binding's live execution. For lifecycle re-checks
   * that run under the assignment mutex; entry points refresh first through
   * {@link assertNotAssignedToBinding}.
   */
  bindingRefusalFor(input: {
    action: string;
    deviceId: string;
    platform: Platform;
    stableIds?: ReadonlyArray<string | undefined>;
    requesterSessionUuid?: string;
  }): Error | undefined {
    const refusal = bindingRefusal(this.state.bindingExclusion, {
      action: input.action,
      deviceId: input.deviceId,
      device: this.callbacks.managedRefFor(input.deviceId, input.platform, input.stableIds),
      requesterSessionUuid: input.requesterSessionUuid,
    });
    if (refusal) {
      return refusal;
    }
    // The same unresolved-identity rule as isBindingDevice: an idle emulator whose AVD name is
    // unread cannot be proven free, so a generic caller may not drive it (#11457). Only the
    // session that already holds it in the pool, or a binding reconciler, passes.
    const device = this.state.devices.get(input.deviceId);
    if (
      device &&
      // Only an Android emulator is ever unresolved; the guard also narrows the refusal's platform.
      isAndroidOrIosPlatform(device.platform) &&
      this.callbacks.isUnresolvedEmulatorWhileAndroidManaged(device) &&
      // A caller-supplied identity (the verified AVD name on acquire) was already judged above.
      !input.stableIds?.some((id) => id !== undefined && id !== "") &&
      !(input.requesterSessionUuid && holderOf(device) === input.requesterSessionUuid) &&
      currentBindingReconciler() === undefined
    ) {
      return new DeviceAssignedToBindingError(input.action, input.deviceId, {
        platform: device.platform,
        stableDeviceId: input.deviceId,
        holder: "session_broker",
        scopeKey: "",
        bindingIndex: null,
      });
    }
    return undefined;
  }

  /** Whether the exclusion snapshot follows a failed registry read. */
  bindingSnapshotRetainedAfterFailedRead(): boolean {
    return this.state.bindingExclusion?.lastReadFailed?.() ?? false;
  }

  mayForceManagedReread(input: {
    deviceId: string;
    requesterSessionUuid?: string;
    maxAgeMs?: number;
  }): boolean {
    const windowMs = input.maxAgeMs ?? 0;
    const now = this.state.timer.now();
    for (const [key, at] of this.state.managedRereadAtMs) {
      if (now - at >= windowMs) {
        this.state.managedRereadAtMs.delete(key);
      }
    }
    const key = JSON.stringify([input.deviceId, input.requesterSessionUuid]);
    if (this.state.managedRereadAtMs.has(key)) {
      return false;
    }
    this.state.managedRereadAtMs.set(key, now);
    return true;
  }

  /**
   * Refuse a generic caller's control of a device a broker binding holds (#11174, #11178), with a
   * fresh registry read: `device_assigned_to_binding`, not retryable. Only the binding's own
   * live execution session passes; no force flag overrides it. On a failed read, a session already
   * holding the device in this pool passes first; other sessions get retryable discovery failure
   * when a retained entry refuses them. Plain callers keep the retained fail-closed verdict.
   */
  async assertNotAssignedToBinding(input: {
    action: string;
    deviceId: string;
    platform: Platform;
    stableIds?: ReadonlyArray<string | undefined>;
    requesterSessionUuid?: string;
    /** Reuse a snapshot younger than this; destructive callers leave it unset (always fresh). */
    maxAgeMs?: number;
  }): Promise<void> {
    if (!this.state.bindingExclusion) {
      return;
    }
    try {
      await refreshAllocationBindingExclusion(this.state.bindingExclusion, {
        maxAgeMs: input.maxAgeMs,
      });
      let refusal = this.callbacks.bindingRefusalFor(input);
      if (
        refusal &&
        input.maxAgeMs &&
        input.requesterSessionUuid &&
        this.mayForceManagedReread(input)
      ) {
        // A cached snapshot can predate the requester's own claim of this slot (#11457). Re-read
        // with a load that starts after this call before refusing a session, so a fresh execution
        // is never refused its own device.
        await refreshAllocationBindingExclusion(this.state.bindingExclusion, { fresh: true });
        refusal = this.callbacks.bindingRefusalFor(input);
      }
      if (refusal) {
        throw refusal;
      }
    } catch (error) {
      if (!(error instanceof BindingDiscoveryIncompleteError)) {
        throw error;
      }
      this.judgeRetainedManagedSnapshot(input, error);
    }
  }

  judgeRetainedManagedSnapshot(
    input: Parameters<DevicePoolOperations["assertNotAssignedToBinding"]>[0],
    error: BindingDiscoveryIncompleteError,
  ): void {
    // A failed read cannot revoke a device this session already holds, even if the retained
    // snapshot predates its broker claim. Current successful reads still judge the registry first.
    if (
      input.requesterSessionUuid &&
      holderOf(this.state.devices.get(input.deviceId)) === input.requesterSessionUuid
    ) {
      return;
    }
    const holder = this.state.bindingExclusion?.holderOf(
      this.callbacks.managedRefFor(input.deviceId, input.platform, input.stableIds),
    );
    if (holder) {
      const refusal = this.callbacks.bindingRefusalFor(input);
      if (!refusal) {
        return;
      }
      // A session's retained refusal may name a previous execution; only a current read can
      // refuse it permanently. Plain callers still fail closed on known managed devices.
      throw input.requesterSessionUuid ? error : refusal;
    }
    throw error;
  }

  /**
   * Stable ids a selector-based start must skip on `platform` (AVD names, simulator UDIDs): every
   * device a broker binding holds, read fresh (#11174). Empty when the pool tracks no bindings.
   */
  async bindingStableIds(platform: Platform): Promise<ReadonlySet<string>> {
    if (!this.state.bindingExclusion) {
      return new Set();
    }
    await refreshAllocationBindingExclusion(this.state.bindingExclusion);
    return this.state.bindingExclusion.stableIdsFor(platform);
  }

  getDevicesMatchingCriteria(criteria?: DeviceAllocationCriteria): PooledDevice[] {
    return this.state.criteriaMatcher.filterDevices(this.callbacks.getAllDevices(), criteria);
  }
}

export function connectBinding(
  part: () => DevicePoolBinding,
  seams: Pick<
    DevicePoolOperations,
    | "bindingRefusalFor"
    | "bindingSnapshotRetainedAfterFailedRead"
    | "assertNotAssignedToBinding"
    | "bindingStableIds"
  >,
): BindingOperations {
  return {
    bindingRefusalFor: (...args) => seams.bindingRefusalFor(...args),
    bindingSnapshotRetainedAfterFailedRead: (...args) =>
      seams.bindingSnapshotRetainedAfterFailedRead(...args),
    mayForceManagedReread: (...args) => part().mayForceManagedReread(...args),
    assertNotAssignedToBinding: (...args) => seams.assertNotAssignedToBinding(...args),
    judgeRetainedManagedSnapshot: (...args) => part().judgeRetainedManagedSnapshot(...args),
    bindingStableIds: (...args) => seams.bindingStableIds(...args),
    getDevicesMatchingCriteria: (...args) => part().getDevicesMatchingCriteria(...args),
  };
}
