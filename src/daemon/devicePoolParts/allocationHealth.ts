import { holderOf, isBusy, isIdle } from "../deviceBinding";
import {
  type AllocationDiscoverySnapshots,
  type AssignableIdleDeviceSelection,
} from "../deviceAllocation";
import {
  DeviceCleanupInProgressError,
  DeviceUnhealthyError,
  DEVICE_UNHEALTHY_CODE,
} from "../../models/deviceAcquisitionRefusals";
import { type DeviceHealthMarker } from "../deviceHealthMarkers";
import { type Session } from "../sessionManager";
import { ActionableError } from "../../models";
import { BootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import { DeviceAllocationCriteria, DeviceAllocationRequest } from "../DeviceCriteriaMatcher";
import { type DiscoveryCompleteness } from "../../utils/discoverySource";
import { getAbortSignal } from "../../utils/AbortContext";
import type { PooledDevice } from "../devicePoolTypes";
import {
  IOS_LIVENESS_UNVERIFIED_RETRY_AFTER_MS,
  RollbackAssignment,
  TargetDeviceDiscoverySnapshot,
  TargetDeviceValidationOptions,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface AllocationHealthOperations {
  recordCriteriaAssignment(
    request: DeviceAllocationRequest,
    result: Awaited<ReturnType<DevicePoolOperations["tryAssignDeviceWithCriteria"]>>,
    assignments: Map<string, string>,
    assignmentsToRollback: Map<string, RollbackAssignment>,
  ): void;
  tryAssignDeviceWithCriteria(
    sessionId: string,
    criteria?: DeviceAllocationCriteria,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }>;
  isPooledEntryCurrent(device: PooledDevice): boolean;
  isCurrentIdleDeviceAssignable(device: PooledDevice, forSessionId?: string): boolean;
  selectAssignableIdleDevice(
    candidates: PooledDevice[],
    { capturedEntries, iosLiveness, androidPresence }: AllocationDiscoverySnapshots,
    forSessionId?: string,
  ): Promise<AssignableIdleDeviceSelection>;
  isIdleDeviceEligible(device: PooledDevice, forSessionId?: string): boolean;
  selectIdleDevice(candidates: PooledDevice[], forSessionId?: string): PooledDevice | undefined;
  getDevicesMatchingAnyRequest(requests: DeviceAllocationRequest[]): PooledDevice[];
  pruneStaleIdleIosDevices(candidates: PooledDevice[]): Promise<number>;
  assertIdleDeviceAssignable({
    device,
    unavailableMessage,
    readinessReservationOwners,
    snapshot,
  }: TargetDeviceValidationOptions): void;
  notifyTargetDeviceReady({
    device,
    snapshot,
  }: {
    device: PooledDevice;
    snapshot: TargetDeviceDiscoverySnapshot;
  }): void;
  assertTargetDeviceLiveness({
    device,
    unavailableMessage,
    snapshot,
  }: {
    device: Pick<PooledDevice, "id" | "platform">;
    unavailableMessage: string;
    snapshot: TargetDeviceDiscoverySnapshot;
  }): void;
  /** Health of the current runtime only; stale incarnations never gate allocation. */
  getDeviceHealthMarker(deviceId: string): DeviceHealthMarker | undefined;
  assertHealthyAllocationPossible(
    candidates: readonly PooledDevice[],
    selected: PooledDevice | undefined,
  ): void;
  unhealthyDevicesError(devices: readonly PooledDevice[]): DeviceUnhealthyError;
  /** Exact-device acquisition honors cleanup and health; live-owner reuse stays valid. */
  assertDeviceCleanupComplete(deviceId: string): void;
}
type AllocationHealthState = Pick<
  DevicePoolState,
  | "deviceAllocation"
  | "devices"
  | "idleDeviceReaper"
  | "recoveryCoordinator"
  | "deviceHealthMarkers"
  | "sessionManager"
>;
export type AllocationHealthCallbacks = Pick<
  DevicePoolOperations,
  | "getDevicesMatchingCriteria"
  | "assertDeviceCleanupComplete"
  | "hasReadinessNameReservation"
  | "notifyDeviceReady"
  | "getDeviceIncarnation"
  | "getDeviceHealthMarker"
  | "isReservedForAssignment"
>;

/** Allocation Health responsibilities of DevicePool. */
export class DevicePoolAllocationHealth {
  constructor(
    private readonly state: AllocationHealthState,
    private readonly callbacks: AllocationHealthCallbacks,
  ) {}
  recordCriteriaAssignment(
    request: DeviceAllocationRequest,
    result: Awaited<ReturnType<DevicePoolOperations["tryAssignDeviceWithCriteria"]>>,
    assignments: Map<string, string>,
    assignmentsToRollback: Map<string, RollbackAssignment>,
  ): void {
    return this.state.deviceAllocation.recordCriteriaAssignment(
      request,
      result,
      assignments,
      assignmentsToRollback,
    );
  }

  tryAssignDeviceWithCriteria(
    sessionId: string,
    criteria?: DeviceAllocationCriteria,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }> {
    return this.state.deviceAllocation.tryAssignDeviceWithCriteria(
      sessionId,
      criteria,
      getAbortSignal(),
    );
  }

  /**
   * The one pooled-entry identity check: the captured object is still the entry
   * stored under its own id (not removed, not replaced by a rebind or recovery).
   * The captured-entry predicates below layer their own field checks on top of
   * it; isPreservedSessionCurrent deliberately does not use it because its
   * callers may already have detached the entry. Checks keyed by a separately
   * captured id compare `this.devices.get(id)` directly.
   */
  isPooledEntryCurrent(device: PooledDevice): boolean {
    return this.state.devices.get(device.id) === device;
  }

  isCurrentIdleDeviceAssignable(device: PooledDevice, forSessionId?: string): boolean {
    return this.state.deviceAllocation.isCurrentIdleDeviceAssignable(device, forSessionId);
  }

  selectAssignableIdleDevice(
    candidates: PooledDevice[],
    { capturedEntries, iosLiveness, androidPresence }: AllocationDiscoverySnapshots,
    forSessionId?: string,
  ): Promise<AssignableIdleDeviceSelection> {
    return this.state.deviceAllocation.selectAssignableIdleDevice(
      candidates,
      { capturedEntries, iosLiveness, androidPresence },
      forSessionId,
    );
  }

  isIdleDeviceEligible(device: PooledDevice, forSessionId?: string): boolean {
    return this.state.deviceAllocation.isIdleDeviceEligible(device, forSessionId);
  }

  selectIdleDevice(candidates: PooledDevice[], forSessionId?: string): PooledDevice | undefined {
    return this.state.deviceAllocation.selectIdleDevice(candidates, forSessionId);
  }

  getDevicesMatchingAnyRequest(requests: DeviceAllocationRequest[]): PooledDevice[] {
    const devicesById = new Map<string, PooledDevice>();
    for (const request of requests) {
      for (const device of this.callbacks.getDevicesMatchingCriteria(request.criteria)) {
        devicesById.set(device.id, device);
      }
    }
    return Array.from(devicesById.values());
  }

  async pruneStaleIdleIosDevices(candidates: PooledDevice[]): Promise<number> {
    return await this.state.idleDeviceReaper.pruneStaleIdleIosDevices(candidates);
  }

  assertIdleDeviceAssignable({
    device,
    unavailableMessage,
    readinessReservationOwners,
    snapshot,
  }: TargetDeviceValidationOptions): void {
    this.callbacks.assertDeviceCleanupComplete(device.id);
    if (!isIdle(device) || holderOf(device)) {
      return;
    }
    if (this.callbacks.hasReadinessNameReservation(device, readinessReservationOwners)) {
      throw new ActionableError(unavailableMessage);
    }
    if (
      this.state.recoveryCoordinator.isAndroidRecoveryHandoffReserved(
        device.id,
        readinessReservationOwners,
      )
    ) {
      throw new ActionableError(unavailableMessage);
    }
    if (!this.isPooledEntryCurrent(device)) {
      throw new ActionableError(unavailableMessage);
    }
    this.assertTargetDeviceLiveness({ device, unavailableMessage, snapshot });
  }

  notifyTargetDeviceReady({
    device,
    snapshot,
  }: {
    device: PooledDevice;
    snapshot: TargetDeviceDiscoverySnapshot;
  }): void {
    if (device !== snapshot.readyNotifiedEntry) {
      this.callbacks.notifyDeviceReady(device.id);
    }
  }

  assertTargetDeviceLiveness({
    device,
    unavailableMessage,
    snapshot,
  }: {
    device: Pick<PooledDevice, "id" | "platform">;
    unavailableMessage: string;
    snapshot: TargetDeviceDiscoverySnapshot;
  }): void {
    const iosLiveness = snapshot.iosLiveness;
    const status = this.state.idleDeviceReaper.getIdleDeviceLivenessStatus(device, iosLiveness);
    if (status === "assignable") {
      return;
    }
    if (status === "stale") {
      // Absence observed before the lock never retires this pool incarnation.
      throw new ActionableError(unavailableMessage);
    }
    const noun = this.state.idleDeviceReaper.iosDeviceNoun(device.id);
    // A failed listing (typically a `simctl list` timeout during a boot burst) says nothing about
    // the device, and the caller already rolled back: it is transient, so retryable (#15289).
    throw new BootedDeviceDiscoveryIncompleteError(
      "ios",
      undefined,
      `Unable to verify iOS ${noun} '${device.id}' is still booted before assignment.\n` +
        `iOS ${noun} discovery failed, so AutoMobile did not assign this pooled UDID; retry shortly.`,
      IOS_LIVENESS_UNVERIFIED_RETRY_AFTER_MS,
    );
  }

  /** Health of the current runtime only; stale incarnations never gate allocation. */
  getDeviceHealthMarker(deviceId: string): DeviceHealthMarker | undefined {
    const incarnation = this.callbacks.getDeviceIncarnation(deviceId);
    return incarnation === undefined
      ? undefined
      : this.state.deviceHealthMarkers.get(deviceId, incarnation);
  }

  assertHealthyAllocationPossible(
    candidates: readonly PooledDevice[],
    selected: PooledDevice | undefined,
  ): void {
    if (selected) {
      return;
    }
    const healthyBusy = candidates.some(
      (device) =>
        !this.callbacks.getDeviceHealthMarker(device.id) &&
        (isBusy(device) || this.callbacks.isReservedForAssignment(device)),
    );
    if (
      !healthyBusy &&
      candidates.some((device) => this.callbacks.getDeviceHealthMarker(device.id))
    ) {
      // Health recovery has its own bounded retry budget. Allocation fails
      // promptly; waiting for a session release cannot clean these devices.
      throw this.unhealthyDevicesError(candidates);
    }
  }

  unhealthyDevicesError(devices: readonly PooledDevice[]): DeviceUnhealthyError {
    const reasons = devices.flatMap((device) => {
      const marker = this.callbacks.getDeviceHealthMarker(device.id);
      return marker ? [`'${device.id}' (${marker.reason}, since ${marker.since})`] : [];
    });
    const appCleanupRecovery = devices
      .filter((device) => this.callbacks.getDeviceHealthMarker(device.id)?.reason === "app-cleanup")
      .map(
        (device) =>
          ` Device '${device.id}' is held for app-cleanup: an executePlan app cleanup did not ` +
          "complete and only three background retries are made, so it can stay unavailable " +
          `until it is replaced. Recovery: call killDevice with device { name: '${device.name}', ` +
          `deviceId: '${device.id}', platform: '${device.platform}' }, then startDevice to ` +
          "bring up a fresh device.",
      );
    const recordingTeardownRecovery = devices
      .filter(
        (device) =>
          this.callbacks.getDeviceHealthMarker(device.id)?.reason === "recording-teardown",
      )
      .map(
        (device) =>
          ` Device '${device.id}' is held for recording-teardown: the previous session's recorder could not be confirmed stopped. ` +
          "Recovery is retried in the background (three attempts); if it stays held, " +
          `call killDevice with device { name: '${device.name}', deviceId: '${device.id}', platform: '${device.platform}' }, then startDevice to bring up a fresh device.`,
      );
    const evidence = devices.flatMap((device) => {
      const incarnation = this.callbacks.getDeviceIncarnation(device.id);
      if (incarnation === undefined) {
        return [];
      }
      const markers = this.state.deviceHealthMarkers.list(device.id, incarnation);
      const oldest = markers[0];
      if (!oldest) {
        return [];
      }
      const recoveries = markers.map((marker) =>
        this.state.sessionManager.getDeviceHealthRecovery(device.id, incarnation, marker.reason),
      );
      const recovering = recoveries.every((recovery) => recovery.recovering);
      const bounds = recoveries.flatMap((recovery) =>
        recovery.retryAfterMs === undefined ? [] : [recovery.retryAfterMs],
      );
      return [
        {
          deviceId: device.id,
          reason: oldest.reason,
          recovering,
          ...(recovering && bounds.length === recoveries.length
            ? { retryAfterMs: Math.max(...bounds) }
            : {}),
        },
      ];
    });
    const error = new DeviceUnhealthyError(
      evidence,
      `Unhealthy devices cannot be assigned: ${reasons.join(", ")}. ` +
        "Session state could not be restored. Retry after restoration succeeds, manually restore the state, " +
        "or use killDevice/startDevice to replace the device. Automatic erase/reboot is not performed." +
        appCleanupRecovery.join("") +
        recordingTeardownRecovery.join(""),
    );
    error.message += error.recovering
      ? error.retryAfterMs === undefined
        ? ` Background recovery is still running with no fixed bound (code ${DEVICE_UNHEALTHY_CODE}); retry later.`
        : ` Background recovery is still running (code ${DEVICE_UNHEALTHY_CODE}); retry in about ${error.retryAfterMs}ms.`
      : ` Background recovery has ended and the marker is held until the device is replaced (code ${DEVICE_UNHEALTHY_CODE}).`;
    return error;
  }

  /** Exact-device acquisition honors cleanup and health; live-owner reuse stays valid. */
  assertDeviceCleanupComplete(deviceId: string): void {
    const device = this.state.devices.get(deviceId);
    if (
      device &&
      this.callbacks.getDeviceHealthMarker(deviceId) &&
      (!holderOf(device) || !this.state.sessionManager.getSession(holderOf(device)!))
    ) {
      throw this.unhealthyDevicesError([device]);
    }
    if (this.state.sessionManager.hasDeviceCleanupInProgress(deviceId)) {
      // Typed and retryable: clients wait on it like a held device (#10960).
      throw new DeviceCleanupInProgressError(
        deviceId,
        this.state.sessionManager.getDeviceCleanupRetryAfterMs(deviceId),
      );
    }
  }
}

export function connectAllocationHealth(
  part: () => DevicePoolAllocationHealth,
  seams: Pick<DevicePoolOperations, "getDeviceHealthMarker" | "assertDeviceCleanupComplete">,
): AllocationHealthOperations {
  return {
    recordCriteriaAssignment: (...args) => part().recordCriteriaAssignment(...args),
    tryAssignDeviceWithCriteria: (...args) => part().tryAssignDeviceWithCriteria(...args),
    isPooledEntryCurrent: (...args) => part().isPooledEntryCurrent(...args),
    isCurrentIdleDeviceAssignable: (...args) => part().isCurrentIdleDeviceAssignable(...args),
    selectAssignableIdleDevice: (...args) => part().selectAssignableIdleDevice(...args),
    isIdleDeviceEligible: (...args) => part().isIdleDeviceEligible(...args),
    selectIdleDevice: (...args) => part().selectIdleDevice(...args),
    getDevicesMatchingAnyRequest: (...args) => part().getDevicesMatchingAnyRequest(...args),
    pruneStaleIdleIosDevices: (...args) => part().pruneStaleIdleIosDevices(...args),
    assertIdleDeviceAssignable: (...args) => part().assertIdleDeviceAssignable(...args),
    notifyTargetDeviceReady: (...args) => part().notifyTargetDeviceReady(...args),
    assertTargetDeviceLiveness: (...args) => part().assertTargetDeviceLiveness(...args),
    getDeviceHealthMarker: (...args) => seams.getDeviceHealthMarker(...args),
    assertHealthyAllocationPossible: (...args) => part().assertHealthyAllocationPossible(...args),
    unhealthyDevicesError: (...args) => part().unhealthyDevicesError(...args),
    assertDeviceCleanupComplete: (...args) => seams.assertDeviceCleanupComplete(...args),
  };
}
