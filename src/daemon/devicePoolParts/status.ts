import { isProductBrokerDevice } from "../sessionBroker/persistedIdentity";
import { markDeviceError } from "../deviceBinding";
import { deviceHold, genericAvailabilityOf, type GenericAvailability } from "../deviceHold";
import { logger } from "../../utils/logger";
import { ActionableError, DeviceInfo, Platform } from "../../models";
import { type DeviceRecoveryPolicy } from "../poolConfig";
import { DeviceAllocationCriteria } from "../DeviceCriteriaMatcher";
import { discoverySourceFor } from "../../utils/discoverySource";
import { consolePortFromSerial } from "../../utils/android-cmdline-tools/EmulatorConsoleClient";
import { DeviceLostError, deviceLossCancellationReason } from "../emulatorLossIncident";
import { type ManagedDeviceRef } from "../sessionBroker/provisioning/exclusion";
import type { DeviceRecoveryEligibility, PooledDevice } from "../devicePoolTypes";
import { AndroidEmulatorContinuityDevice, IOSSimulatorRecoveryDevice } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface StatusOperations {
  /**
   * Mark device as having an error
   *
   * Track consecutive errors. If errors exceed threshold, mark device as failed.
   */
  recordDeviceError(deviceId: string): void;
  /**
   * Clear error count for device (after successful operation)
   */
  clearDeviceError(deviceId: string): void;
  /**
   * Get device by ID
   */
  getDevice(deviceId: string): PooledDevice | null;
  /**
   * Connection epoch of the pooled device on `deviceId`, or undefined when the
   * serial is not pooled. The canonical answer for every per-device cache that
   * must not survive a same-serial reincarnation; see
   * `utils/deviceIncarnation.ts`.
   */
  getDeviceIncarnation(deviceId: string): number | undefined;
  /** Advance the epoch for an already pooled device after a VM restore. */
  bumpDeviceIncarnation(deviceId: string): boolean;
  /**
   * Get device assigned to session
   */
  getDeviceForSession(sessionId: string): PooledDevice | null;
  bindingOwnershipGate(sessionId: string): "unconfirmed" | "lost" | undefined;
  assertSessionReadyForAutomation(sessionId: string): void;
  /** Read the shutdown fence under the assignment lock used to install it. */
  isShutdownReserved(deviceId: string): Promise<boolean>;
  /** Read only the active shutdown reservation under the assignment lock. */
  isShutdownReservationHeld(deviceId: string): Promise<boolean>;
  /**
   * Get all idle devices (available for assignment)
   */
  getIdleDevices(): PooledDevice[];
  /**
   * Get all devices currently assigned to sessions
   */
  getAssignedDevices(): PooledDevice[];
  /**
   * Get all devices in error state
   */
  getErrorDevices(): PooledDevice[];
  /**
   * Get count of available devices (can be assigned to new sessions)
   */
  getAvailableDeviceCount(): number;
  /**
   * Get total device count
   */
  getTotalDeviceCount(): number;
  /**
   * Get all devices in pool
   */
  getAllDevices(): PooledDevice[];
  /** Effective daemon-startup policy, copied so callers cannot mutate pool state. */
  getRecoveryPolicy(): DeviceRecoveryPolicy;
  getRecoveryEligibility(deviceId: string): DeviceRecoveryEligibility;
  isAndroidEmulatorActiveRelaunchEligible(device: PooledDevice): device is PooledDevice & {
    avdName: string;
    androidImage: DeviceInfo;
  };
  isAndroidEmulatorSessionContinuityDevice(
    device: PooledDevice,
  ): device is AndroidEmulatorContinuityDevice;
  isIOSSimulatorContinuityDevice(device: PooledDevice): device is IOSSimulatorRecoveryDevice;
  getUnownedDevicesMatchingCriteria(criteria?: DeviceAllocationCriteria): PooledDevice[];
  isDrivenByForeignDaemon(device: PooledDevice): boolean;
  /**
   * Whether generic allocation may lend `deviceId`, from the last broker binding snapshot and the
   * live foreign-ownership probe: the same facts allocation filters on. Unknown devices are free
   * unless a broker binding holds `deviceId` or one of `unpooledStableIds`.
   */
  genericAvailability(
    deviceId: string,
    unpooledStableIds?: ReadonlyArray<string | undefined>,
  ): GenericAvailability;
  isHeldOutsideGenericAllocation(device: PooledDevice): boolean;
  getGenericallyAllocatableDevices(platform?: Platform): PooledDevice[];
  managedRefFor(
    deviceId: string,
    platform: Platform,
    extraStableIds?: ReadonlyArray<string | undefined>,
  ): ManagedDeviceRef;
  isBindingDevice(device: PooledDevice): boolean;
  isUnresolvedEmulatorWhileAndroidManaged(device: PooledDevice): boolean;
}
type StatusState = Pick<
  DevicePoolState,
  | "devices"
  | "MAX_DEVICE_ERRORS"
  | "sessionManager"
  | "deviceHealthMarkers"
  | "managedExecutionOwnership"
  | "adbServerResetQuarantinedSessions"
  | "androidRecoveryRecordLedger"
  | "runtimeIdentity"
  | "shutdownReservationCoordinator"
  | "recoveryPolicy"
  | "foreignClaims"
  | "bindingExclusion"
>;
export type StatusCallbacks = Pick<
  DevicePoolOperations,
  | "notifyDeviceStateChanged"
  | "nextDeviceIncarnation"
  | "notifyDeviceFramesInvalidated"
  | "isIdleDeviceEligible"
  | "getIdleDevices"
  | "getRecoveryPolicy"
  | "stableDeviceIdFor"
  | "getDevicesMatchingCriteria"
  | "holdFactsFor"
  | "getDevicesByPlatform"
  | "isPooledAndroidEmulator"
>;

/** Status responsibilities of DevicePool. */
export class DevicePoolStatus {
  constructor(
    private readonly state: StatusState,
    private readonly callbacks: StatusCallbacks,
  ) {}
  /**
   * Mark device as having an error
   *
   * Track consecutive errors. If errors exceed threshold, mark device as failed.
   */
  recordDeviceError(deviceId: string): void {
    const device = this.state.devices.get(deviceId);
    if (!device) {
      return;
    }
    device.errorCount++;
    if (device.errorCount >= this.state.MAX_DEVICE_ERRORS) {
      markDeviceError(device);
      logger.error(
        `Device ${deviceId} marked as error ` + `(${device.errorCount} consecutive errors)`,
      );
      this.callbacks.notifyDeviceStateChanged(device);
    } else {
      logger.warn(
        `Device ${deviceId} error count: ${device.errorCount}/${this.state.MAX_DEVICE_ERRORS}`,
      );
    }
  }

  /**
   * Clear error count for device (after successful operation)
   */
  clearDeviceError(deviceId: string): void {
    const device = this.state.devices.get(deviceId);
    if (device) {
      device.errorCount = 0;
    }
  }

  /**
   * Get device by ID
   */
  getDevice(deviceId: string): PooledDevice | null {
    return this.state.devices.get(deviceId) || null;
  }

  /**
   * Connection epoch of the pooled device on `deviceId`, or undefined when the
   * serial is not pooled. The canonical answer for every per-device cache that
   * must not survive a same-serial reincarnation; see
   * `utils/deviceIncarnation.ts`.
   */
  getDeviceIncarnation(deviceId: string): number | undefined {
    return this.state.devices.get(deviceId)?.incarnation;
  }

  /** Advance the epoch for an already pooled device after a VM restore. */
  bumpDeviceIncarnation(deviceId: string): boolean {
    const device = this.state.devices.get(deviceId);
    if (!device) {
      return false;
    }
    this.state.sessionManager.retireRestorations(deviceId, "incarnation-bump");
    this.state.deviceHealthMarkers.clear(deviceId);
    device.incarnation = this.callbacks.nextDeviceIncarnation();
    // Full: a VM restore can replace the rendered screen even on the same connection/serial.
    this.callbacks.notifyDeviceFramesInvalidated(deviceId);
    return true;
  }

  /**
   * Get device assigned to session
   */
  getDeviceForSession(sessionId: string): PooledDevice | null {
    return this.state.devices.heldBy(sessionId);
  }

  bindingOwnershipGate(sessionId: string): "unconfirmed" | "lost" | undefined {
    return this.state.managedExecutionOwnership?.()?.ownershipState?.(sessionId);
  }

  assertSessionReadyForAutomation(sessionId: string): void {
    const ownershipRefusal = this.state.managedExecutionOwnership?.()?.automationRefusal(sessionId);
    if (ownershipRefusal) {
      throw ownershipRefusal;
    }
    if (this.state.adbServerResetQuarantinedSessions.has(sessionId)) {
      const loss = this.state.androidRecoveryRecordLedger.recoveringSessionLosses.get(sessionId);
      if (loss) {
        throw new DeviceLostError(
          loss.deviceId,
          deviceLossCancellationReason(loss.deviceId, loss.incidentId),
          loss.incidentId,
        );
      }
      throw new ActionableError(
        `Session '${sessionId}' is recovering from a process-wide ADB reset. Retry after device recovery completes.`,
      );
    }
    // Reject admission for a session whose device is being killed. Without this,
    // a session already bound to the device passes the gate during the killDevice
    // window and re-creates a fresh auto-reconnecting AndroidCtrlProxyClient via
    // getInstance, recreating the transport hold the teardown just removed. The
    // shutdown reservation blocks new *allocation* but not an already-bound
    // session; execution cancellation only happens later in retirement, so this
    // is the gate that closes that window (see #5494, follow-up to #5452/#5491).
    const assignedDeviceId = this.state.sessionManager.getSession(sessionId)?.assignedDevice;
    // The session addresses its device BY SERIAL, so this path is just the
    // session-keyed spelling of a device-addressed operation and goes through
    // FUNNEL 2 like every other one (#6863 review).
    if (assignedDeviceId) {
      this.state.runtimeIdentity.assertDeviceActionable(assignedDeviceId, "to run");
    }
    if (
      assignedDeviceId &&
      this.state.shutdownReservationCoordinator.isDeviceUnderShutdown(assignedDeviceId)
    ) {
      throw new ActionableError(
        `Session '${sessionId}' is bound to device '${assignedDeviceId}', which is shutting down. ` +
          `Retry after the device is released or reassigned.`,
      );
    }
  }

  /** Read the shutdown fence under the assignment lock used to install it. */
  isShutdownReserved(deviceId: string): Promise<boolean> {
    return this.state.shutdownReservationCoordinator.isShutdownReserved(deviceId);
  }

  /** Read only the active shutdown reservation under the assignment lock. */
  isShutdownReservationHeld(deviceId: string): Promise<boolean> {
    return this.state.shutdownReservationCoordinator.isShutdownReservationHeld(deviceId);
  }

  /**
   * Get all idle devices (available for assignment)
   */
  getIdleDevices(): PooledDevice[] {
    const allocatable = (device: PooledDevice) =>
      this.callbacks.isIdleDeviceEligible(device) && !this.isHeldOutsideGenericAllocation(device);
    return this.state.devices.all().filter(allocatable);
  }

  /**
   * Get all devices currently assigned to sessions
   */
  getAssignedDevices(): PooledDevice[] {
    return this.state.devices.assigned();
  }

  /**
   * Get all devices in error state
   */
  getErrorDevices(): PooledDevice[] {
    return this.state.devices.errored();
  }

  /**
   * Get count of available devices (can be assigned to new sessions)
   */
  getAvailableDeviceCount(): number {
    return this.callbacks.getIdleDevices().length;
  }

  /**
   * Get total device count
   */
  getTotalDeviceCount(): number {
    return this.state.devices.size;
  }

  /**
   * Get all devices in pool
   */
  getAllDevices(): PooledDevice[] {
    return this.state.devices.all();
  }

  /** Effective daemon-startup policy, copied so callers cannot mutate pool state. */
  getRecoveryPolicy(): DeviceRecoveryPolicy {
    return { ...this.state.recoveryPolicy };
  }

  getRecoveryEligibility(deviceId: string): DeviceRecoveryEligibility {
    const device = this.state.devices.get(deviceId);
    if (!device) {
      return { eligible: false, reason: "not-in-pool" };
    }
    if (!this.callbacks.getRecoveryPolicy().onLoss) {
      return { eligible: false, reason: "disabled" };
    }
    if (device.platform !== "android") {
      return { eligible: false, reason: "unsupported-platform" };
    }
    if (!this.isAndroidEmulatorActiveRelaunchEligible(device)) {
      return { eligible: false, reason: "not-automobile-owned" };
    }
    return { eligible: true, action: "restart" };
  }

  /**
   * True only for an Android emulator with a recorded AVD name *and* its
   * configured image -- the metadata an active relaunch needs to know what to
   * boot back. This is narrower than what passive continuity requires: it
   * reflects "acquired through getAndroid/startDevice with image enrichment,"
   * not "AutoMobile launched this emulator" or "this session may be preserved"
   * (#7546). See `isAndroidEmulatorSessionContinuityDevice` for the passive gate.
   */
  isAndroidEmulatorActiveRelaunchEligible(device: PooledDevice): device is PooledDevice & {
    avdName: string;
    androidImage: DeviceInfo;
  } {
    return (
      device.platform === "android" &&
      consolePortFromSerial(device.id) !== null &&
      typeof device.avdName === "string" &&
      device.androidImage !== undefined
    );
  }

  /**
   * True for any Android emulator serial whose AVD identity discovery has
   * resolved -- via a recorded `avdName` or, absent that, a non-placeholder
   * discovered name (see `stableDeviceIdFor`). Passive continuity (preserve the
   * session, reattach on return) only needs this; it does not need the
   * configured image `isAndroidEmulatorActiveRelaunchEligible` requires (#7546).
   */
  isAndroidEmulatorSessionContinuityDevice(
    device: PooledDevice,
  ): device is AndroidEmulatorContinuityDevice {
    return (
      device.platform === "android" &&
      consolePortFromSerial(device.id) !== null &&
      this.callbacks.stableDeviceIdFor(device) !== undefined
    );
  }

  isIOSSimulatorContinuityDevice(device: PooledDevice): device is IOSSimulatorRecoveryDevice {
    return (
      device.platform === "ios" &&
      typeof device.id === "string" &&
      device.id.length > 0 &&
      discoverySourceFor(device.platform, device.id) === "ios-simulator"
    );
  }

  /** Devices matching `criteria` that no other live daemon drives (mt-0083 D2). */
  getUnownedDevicesMatchingCriteria(criteria?: DeviceAllocationCriteria): PooledDevice[] {
    return this.callbacks
      .getDevicesMatchingCriteria(criteria)
      .filter((device) => !this.isBindingDevice(device) && !this.isDrivenByForeignDaemon(device));
  }

  /**
   * An idle Android device whose CtrlProxy forwarding lease another live AutoMobile process holds
   * is that process's device. On a shared adb server it looks idle here only because this pool
   * holds no session on it, so multi-device allocation must not hand it to a plan.
   */
  isDrivenByForeignDaemon(device: PooledDevice): boolean {
    return this.state.foreignClaims.isDrivenByForeignDaemon(device);
  }

  /**
   * Whether generic allocation may lend `deviceId`, from the last broker binding snapshot and the
   * live foreign-ownership probe: the same facts allocation filters on. A device outside the pool is
   * free unless a broker binding holds it: an iOS simulator an erase reset shut down leaves the pool
   * until the next refresh, yet its binding is still published (#15233). An Android emulator an
   * ADB server reset detached is likewise unpooled until the next refresh re-pools it, and its
   * binding names its AVD, which only the caller's observation (`unpooledStableIds`) knows (#15794).
   */
  genericAvailability(
    deviceId: string,
    unpooledStableIds: ReadonlyArray<string | undefined> = [],
  ): GenericAvailability {
    const device = this.state.devices.get(deviceId);
    if (device) {
      return genericAvailabilityOf(
        deviceHold(this.callbacks.holdFactsFor(device, undefined, "generic")),
      );
    }
    return this.isBoundWhileUnpooled(deviceId, unpooledStableIds) ? "session_broker" : "free";
  }

  /** The id is a broker binding's device on either platform, though the pool does not list it. */
  private isBoundWhileUnpooled(
    deviceId: string,
    stableIds: ReadonlyArray<string | undefined>,
  ): boolean {
    const exclusion = this.state.bindingExclusion;
    return (
      exclusion !== undefined &&
      (["ios", "android"] as const).some(
        (platform) =>
          exclusion.holderOf(this.managedRefFor(deviceId, platform, stableIds)) !== undefined,
      )
    );
  }

  /** A broker binding or another daemon holds the device, so generic allocation never lends it. */
  isHeldOutsideGenericAllocation(device: PooledDevice): boolean {
    return this.isBindingDevice(device) || this.isDrivenByForeignDaemon(device);
  }

  /** Platform devices generic allocation may lend: none a broker binding holds. */
  getGenericallyAllocatableDevices(platform?: Platform): PooledDevice[] {
    return this.callbacks
      .getDevicesByPlatform(platform)
      .filter((device) => !this.isBindingDevice(device));
  }

  /** Every stable identity the pool knows `deviceId` by, plus any the caller supplies. */
  managedRefFor(
    deviceId: string,
    platform: Platform,
    extraStableIds: ReadonlyArray<string | undefined> = [],
  ): ManagedDeviceRef {
    const device = this.state.devices.get(deviceId);
    return {
      platform,
      stableIds: [
        device ? this.callbacks.stableDeviceIdFor(device) : undefined,
        device?.avdName,
        platform === "ios" ? device?.name : undefined,
        deviceId,
        ...extraStableIds,
      ],
    };
  }

  /**
   * A device a broker binding holds is never generic capacity, idle or not (#11174). An Android
   * emulator whose AVD identity is still unresolved cannot be proven free while any Android device
   * is managed, so it is excluded too: unknown identity never frees an assignment.
   */
  isBindingDevice(device: PooledDevice): boolean {
    // Registry loss or an interrupted pre-upgrade create must not lend product inventory.
    if (isProductBrokerDevice(device.avdName ?? device.name)) {
      return true;
    }
    const exclusion = this.state.bindingExclusion;
    if (!exclusion) {
      return false;
    }
    if (exclusion.holderOf(this.managedRefFor(device.id, device.platform))) {
      return true;
    }
    return this.isUnresolvedEmulatorWhileAndroidManaged(device);
  }

  /** An Android emulator whose AVD name is unread while any Android device is managed. */
  isUnresolvedEmulatorWhileAndroidManaged(device: PooledDevice): boolean {
    return (
      device.platform === "android" &&
      this.callbacks.isPooledAndroidEmulator(device.id) &&
      this.callbacks.stableDeviceIdFor(device) === undefined &&
      (this.state.bindingExclusion?.stableIdsFor("android").size ?? 0) > 0
    );
  }
}

export function connectStatus(
  part: () => DevicePoolStatus,
  seams: Pick<
    DevicePoolOperations,
    | "recordDeviceError"
    | "clearDeviceError"
    | "getDevice"
    | "getDeviceIncarnation"
    | "bumpDeviceIncarnation"
    | "getDeviceForSession"
    | "bindingOwnershipGate"
    | "assertSessionReadyForAutomation"
    | "isShutdownReserved"
    | "isShutdownReservationHeld"
    | "getIdleDevices"
    | "getAssignedDevices"
    | "getErrorDevices"
    | "getAvailableDeviceCount"
    | "getTotalDeviceCount"
    | "getAllDevices"
    | "getRecoveryPolicy"
    | "getRecoveryEligibility"
    | "genericAvailability"
  >,
): StatusOperations {
  return {
    recordDeviceError: (...args) => seams.recordDeviceError(...args),
    clearDeviceError: (...args) => seams.clearDeviceError(...args),
    getDevice: (...args) => seams.getDevice(...args),
    getDeviceIncarnation: (...args) => seams.getDeviceIncarnation(...args),
    bumpDeviceIncarnation: (...args) => seams.bumpDeviceIncarnation(...args),
    getDeviceForSession: (...args) => seams.getDeviceForSession(...args),
    bindingOwnershipGate: (...args) => seams.bindingOwnershipGate(...args),
    assertSessionReadyForAutomation: (...args) => seams.assertSessionReadyForAutomation(...args),
    isShutdownReserved: (...args) => seams.isShutdownReserved(...args),
    isShutdownReservationHeld: (...args) => seams.isShutdownReservationHeld(...args),
    getIdleDevices: (...args) => seams.getIdleDevices(...args),
    getAssignedDevices: (...args) => seams.getAssignedDevices(...args),
    getErrorDevices: (...args) => seams.getErrorDevices(...args),
    getAvailableDeviceCount: (...args) => seams.getAvailableDeviceCount(...args),
    getTotalDeviceCount: (...args) => seams.getTotalDeviceCount(...args),
    getAllDevices: (...args) => seams.getAllDevices(...args),
    getRecoveryPolicy: (...args) => seams.getRecoveryPolicy(...args),
    getRecoveryEligibility: (...args) => seams.getRecoveryEligibility(...args),
    isAndroidEmulatorActiveRelaunchEligible(device: PooledDevice): device is PooledDevice & {
      avdName: string;
      androidImage: DeviceInfo;
    } {
      return part().isAndroidEmulatorActiveRelaunchEligible(device);
    },
    isAndroidEmulatorSessionContinuityDevice(
      device: PooledDevice,
    ): device is AndroidEmulatorContinuityDevice {
      return part().isAndroidEmulatorSessionContinuityDevice(device);
    },
    isIOSSimulatorContinuityDevice(device: PooledDevice): device is IOSSimulatorRecoveryDevice {
      return part().isIOSSimulatorContinuityDevice(device);
    },
    getUnownedDevicesMatchingCriteria: (...args) =>
      part().getUnownedDevicesMatchingCriteria(...args),
    isDrivenByForeignDaemon: (...args) => part().isDrivenByForeignDaemon(...args),
    genericAvailability: (...args) => seams.genericAvailability(...args),
    isHeldOutsideGenericAllocation: (...args) => part().isHeldOutsideGenericAllocation(...args),
    getGenericallyAllocatableDevices: (...args) => part().getGenericallyAllocatableDevices(...args),
    managedRefFor: (...args) => part().managedRefFor(...args),
    isBindingDevice: (...args) => part().isBindingDevice(...args),
    isUnresolvedEmulatorWhileAndroidManaged: (...args) =>
      part().isUnresolvedEmulatorWhileAndroidManaged(...args),
  };
}
