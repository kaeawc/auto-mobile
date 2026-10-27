import { isBusy } from "../deviceBinding";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { BootedDevice, DeviceInfo, Platform } from "../../models";
import { type DeviceStartResult } from "../../devices/deviceUtils";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import {
  DeviceAllocationCriteria,
  DeviceAllocationRequest,
  type DevicePoolBootedDevice,
} from "../DeviceCriteriaMatcher";
import type { PooledDevice } from "../devicePoolTypes";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface StartupOperations {
  startAdditionalDevices(
    requiredCount: number,
    deadlineMs: number,
    platform?: Platform,
  ): Promise<number>;
  rethrowCapacityRefusal(error: BootCapacityExhaustedError, started: number): Promise<never>;
  startAndPublishAdditionalDevice(
    device: DeviceInfo,
    label: string,
    deadlineMs: number,
    platform: Platform,
  ): Promise<DevicePoolBootedDevice | null>;
  remainingStartDeadline(deadlineMs: number): number;
  runCoordinatedDeviceStart<T>(
    device: DeviceInfo,
    deadlineMs: number,
    operation: "start" | "recovery",
    action: (
      start: DeviceStartResult,
      signal: AbortSignal,
      retainLeaseUntil: (settlement: Promise<unknown>) => void,
    ) => Promise<T>,
  ): Promise<T | undefined>;
  startCoordinatedDeviceProcess(
    device: DeviceInfo,
    deadlineMs: number,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<DeviceStartResult>;
  startDeviceWithOutcome(device: DeviceInfo, deadlineMs: number): Promise<DeviceStartResult>;
  canAdoptUnlaunchedEmulator(
    device: DeviceInfo,
    outcome: DeviceStartResult["outcome"],
  ): Promise<boolean>;
  refusesForeignOwnedEmulator(device: DeviceInfo, deviceId: string): Promise<boolean>;
  cancelCoordinatedDeviceStart(
    device: DeviceInfo,
    childProcess: ChildProcess | null,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<void>;
  startAdditionalDevicesForCriteria(
    requests: DeviceAllocationRequest[],
    deadlineMs: number,
  ): Promise<number>;
  startAdditionalDeviceMatchingCriteria(
    criteria: DeviceAllocationCriteria | undefined,
    excludedImageIds: Set<string>,
    deadlineMs: number,
    rediscover: () => Promise<PooledDevice | undefined>,
  ): Promise<{
    device: PooledDevice;
    started: boolean;
  } | null>;
  listBootedDevicesForStart(platform: Platform): Promise<BootedDevice[]>;
  getStartableDeviceImageCandidates(
    platform: Platform,
    criteria?: DeviceAllocationCriteria,
    excludedImageIds?: Set<string>,
  ): Promise<DeviceInfo[]>;
  isDeviceImageRunningForCandidate(
    image: DeviceInfo,
    bootedIds: Set<string>,
    bootedNames: Set<string>,
  ): Promise<boolean>;
  isExcludedFromAutoStart(image: DeviceInfo): boolean;
  isAutoStartSuppressed(image: DeviceInfo): boolean;
  hasPendingAndroidRecovery(platform?: Platform): boolean;
  hasPendingAndroidRecoveryMatching(criteria?: DeviceAllocationCriteria): boolean;
  isCriteriaUnavailableWithoutPendingRecovery(
    available: boolean,
    criteria?: DeviceAllocationCriteria,
  ): boolean;
  shouldWaitForDevice(busyDevices: number, pendingRecovery: boolean): boolean;
  countBusyDevices(candidates: PooledDevice[]): number;
  ensurePoolRefreshed(): Promise<string | undefined>;
  seedLastUsedAt(now: number): number;
  nextLastUsedAt(): number;
}
type StartupState = Pick<
  DevicePoolState,
  | "deviceAutoStart"
  | "recoveryCoordinator"
  | "adbServerResetRecoveryReservations"
  | "criteriaMatcher"
  | "devices"
  | "lastUsedAtMarker"
  | "timer"
>;
export type StartupCallbacks = Pick<
  DevicePoolOperations,
  "isReservedForAssignment" | "refreshDevicesWithOutcome"
>;

/** Startup responsibilities of DevicePool. */
export class DevicePoolStartup {
  constructor(
    private readonly state: StartupState,
    private readonly callbacks: StartupCallbacks,
  ) {}
  async startAdditionalDevices(
    requiredCount: number,
    deadlineMs: number,
    platform?: Platform,
  ): Promise<number> {
    return this.state.deviceAutoStart.startAdditionalDevices(requiredCount, deadlineMs, platform);
  }

  /**
   * A boot refused at the booted-device limit fails the allocation at once with the typed
   * retryable refusal (#11236) instead of degrading into a generic "not enough devices". Devices
   * this allocation already started stay published; the pool is refreshed so its stats count them.
   */
  async rethrowCapacityRefusal(error: BootCapacityExhaustedError, started: number): Promise<never> {
    return this.state.deviceAutoStart.rethrowCapacityRefusal(error, started);
  }

  /**
   * The shared body of both start-additional variants: start `device` under the
   * coordinated lifecycle lease, cancel it when the deadline elapses before
   * readiness, wait for readiness, then publish it to the pool. Returns the
   * ready device, or null when it was cancelled before readiness or the start
   * was skipped because another start or recovery owns the image (an Android
   * skip rediscovers the winner after the lease is released). Errors propagate
   * to the caller, which owns the failure logging.
   */
  async startAndPublishAdditionalDevice(
    device: DeviceInfo,
    label: string,
    deadlineMs: number,
    platform: Platform,
  ): Promise<DevicePoolBootedDevice | null> {
    return this.state.deviceAutoStart.startAndPublishAdditionalDevice(
      device,
      label,
      deadlineMs,
      platform,
    );
  }

  remainingStartDeadline(deadlineMs: number): number {
    return this.state.deviceAutoStart.remainingStartDeadline(deadlineMs);
  }

  async runCoordinatedDeviceStart<T>(
    device: DeviceInfo,
    deadlineMs: number,
    operation: "start" | "recovery",
    action: (
      start: DeviceStartResult,
      signal: AbortSignal,
      retainLeaseUntil: (settlement: Promise<unknown>) => void,
    ) => Promise<T>,
  ): Promise<T | undefined> {
    return this.state.deviceAutoStart.runCoordinatedDeviceStart<T>(
      device,
      deadlineMs,
      operation,
      action,
    );
  }

  /**
   * Starts the device under the coordinated lease. A launch cancelled after the
   * emulator spawned carries its child on the error; stop it here so the lease is
   * held until the exit is confirmed (#10075), since `action` never runs for it.
   */
  async startCoordinatedDeviceProcess(
    device: DeviceInfo,
    deadlineMs: number,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<DeviceStartResult> {
    return this.state.deviceAutoStart.startCoordinatedDeviceProcess(
      device,
      deadlineMs,
      signal,
      retainLeaseUntil,
    );
  }

  async startDeviceWithOutcome(device: DeviceInfo, deadlineMs: number): Promise<DeviceStartResult> {
    return this.state.deviceAutoStart.startDeviceWithOutcome(device, deadlineMs);
  }

  /**
   * Whether a start that did not launch its emulator may adopt it, checked before readiness so
   * the wait never touches another daemon's device. An already-running emulator (including one
   * the user started by hand) or an in-process launch is adopted unless another live daemon
   * drives it. A launch that exited as a duplicate of an emulator started outside this process
   * is adopted only when this daemon's adb also lists that emulator: one it cannot list (another
   * daemon on its own adb server) never becomes ready here, so waiting for it would only spend
   * the allocation deadline (mt-0083 D2).
   */
  async canAdoptUnlaunchedEmulator(
    device: DeviceInfo,
    outcome: DeviceStartResult["outcome"],
  ): Promise<boolean> {
    return this.state.deviceAutoStart.canAdoptUnlaunchedEmulator(device, outcome);
  }

  /**
   * An emulator this start did not launch is refused only on positive evidence that another
   * live AutoMobile process drives it: that process holds its CtrlProxy forwarding lease. A
   * user-started emulator or a launch joined in this process holds no foreign lease and is
   * adopted.
   */
  async refusesForeignOwnedEmulator(device: DeviceInfo, deviceId: string): Promise<boolean> {
    return this.state.deviceAutoStart.refusesForeignOwnedEmulator(device, deviceId);
  }

  async cancelCoordinatedDeviceStart(
    device: DeviceInfo,
    childProcess: ChildProcess | null,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    return this.state.deviceAutoStart.cancelCoordinatedDeviceStart(
      device,
      childProcess,
      retainLeaseUntil,
    );
  }

  async startAdditionalDevicesForCriteria(
    requests: DeviceAllocationRequest[],
    deadlineMs: number,
  ): Promise<number> {
    return this.state.deviceAutoStart.startAdditionalDevicesForCriteria(requests, deadlineMs);
  }

  /**
   * Cold-boot a device image matching `criteria`. Just before booting, `rediscover` may find a
   * pooled device that can serve the request instead; it is returned unstarted.
   */
  async startAdditionalDeviceMatchingCriteria(
    criteria: DeviceAllocationCriteria | undefined,
    excludedImageIds: Set<string>,
    deadlineMs: number,
    rediscover: () => Promise<PooledDevice | undefined>,
  ): Promise<{
    device: PooledDevice;
    started: boolean;
  } | null> {
    return this.state.deviceAutoStart.startAdditionalDeviceMatchingCriteria(
      criteria,
      excludedImageIds,
      deadlineMs,
      rediscover,
    );
  }

  /**
   * Booted devices for a start decision. A failed listing is not "nothing is
   * booted": starting from it could boot a duplicate beside an attached device,
   * so an incomplete scan refuses with a retryable error (#11103).
   */
  async listBootedDevicesForStart(platform: Platform): Promise<BootedDevice[]> {
    return this.state.deviceAutoStart.listBootedDevicesForStart(platform);
  }

  async getStartableDeviceImageCandidates(
    platform: Platform,
    criteria?: DeviceAllocationCriteria,
    excludedImageIds: Set<string> = new Set(),
  ): Promise<DeviceInfo[]> {
    return this.state.deviceAutoStart.getStartableDeviceImageCandidates(
      platform,
      criteria,
      excludedImageIds,
    );
  }

  async isDeviceImageRunningForCandidate(
    image: DeviceInfo,
    bootedIds: Set<string>,
    bootedNames: Set<string>,
  ): Promise<boolean> {
    return this.state.deviceAutoStart.isDeviceImageRunningForCandidate(
      image,
      bootedIds,
      bootedNames,
    );
  }

  /** Suppressed, or held by a broker binding: generic auto-start never boots a binding's device (#11174). */
  isExcludedFromAutoStart(image: DeviceInfo): boolean {
    return this.state.deviceAutoStart.isExcludedFromAutoStart(image);
  }

  isAutoStartSuppressed(image: DeviceInfo): boolean {
    return this.state.deviceAutoStart.isAutoStartSuppressed(image);
  }

  hasPendingAndroidRecovery(platform?: Platform): boolean {
    return (
      (platform === undefined || platform === "android") &&
      (this.state.recoveryCoordinator.recoveringAndroidImages.size > 0 ||
        this.state.adbServerResetRecoveryReservations.size > 0)
    );
  }

  hasPendingAndroidRecoveryMatching(criteria?: DeviceAllocationCriteria): boolean {
    return (
      this.state.criteriaMatcher.someDeviceImageMatchesCriteria(
        this.state.recoveryCoordinator.recoveringAndroidImages.values(),
        criteria,
      ) ||
      this.state.criteriaMatcher.someDeviceImageMatchesCriteria(
        Array.from(
          this.state.adbServerResetRecoveryReservations.values(),
          (reservation) => reservation.image,
        ),
        criteria,
      )
    );
  }

  isCriteriaUnavailableWithoutPendingRecovery(
    available: boolean,
    criteria?: DeviceAllocationCriteria,
  ): boolean {
    return !available && !this.hasPendingAndroidRecoveryMatching(criteria);
  }

  shouldWaitForDevice(busyDevices: number, pendingRecovery: boolean): boolean {
    return busyDevices > 0 || pendingRecovery;
  }

  countBusyDevices(candidates: PooledDevice[]): number {
    return candidates.filter(
      (device) => isBusy(device) || this.callbacks.isReservedForAssignment(device),
    ).length;
  }

  /**
   * Ensure device pool has been refreshed at least once
   * Return the refresh failure so allocation errors can retain its cause.
   */
  async ensurePoolRefreshed(): Promise<string | undefined> {
    if (this.state.devices.size === 0) {
      logger.info("[DevicePool] Pool is empty, attempting auto-refresh...");
      return (await this.callbacks.refreshDevicesWithOutcome()).failure;
    }
  }

  seedLastUsedAt(now: number): number {
    if (now > this.state.lastUsedAtMarker) {
      this.state.lastUsedAtMarker = now;
    }
    return this.state.lastUsedAtMarker;
  }

  nextLastUsedAt(): number {
    const now = this.state.timer.now();
    if (now <= this.state.lastUsedAtMarker) {
      this.state.lastUsedAtMarker += 1;
      return this.state.lastUsedAtMarker;
    }
    this.state.lastUsedAtMarker = now;
    return now;
  }
}

export function connectStartup(
  part: () => DevicePoolStartup,
  seams: Pick<DevicePoolOperations, never>,
): StartupOperations {
  return {
    startAdditionalDevices: (...args) => part().startAdditionalDevices(...args),
    rethrowCapacityRefusal: (...args) => part().rethrowCapacityRefusal(...args),
    startAndPublishAdditionalDevice: (...args) => part().startAndPublishAdditionalDevice(...args),
    remainingStartDeadline: (...args) => part().remainingStartDeadline(...args),
    runCoordinatedDeviceStart<T>(
      device: DeviceInfo,
      deadlineMs: number,
      operation: "start" | "recovery",
      action: (
        start: DeviceStartResult,
        signal: AbortSignal,
        retainLeaseUntil: (settlement: Promise<unknown>) => void,
      ) => Promise<T>,
    ): Promise<T | undefined> {
      return part().runCoordinatedDeviceStart(device, deadlineMs, operation, action);
    },
    startCoordinatedDeviceProcess: (...args) => part().startCoordinatedDeviceProcess(...args),
    startDeviceWithOutcome: (...args) => part().startDeviceWithOutcome(...args),
    canAdoptUnlaunchedEmulator: (...args) => part().canAdoptUnlaunchedEmulator(...args),
    refusesForeignOwnedEmulator: (...args) => part().refusesForeignOwnedEmulator(...args),
    cancelCoordinatedDeviceStart: (...args) => part().cancelCoordinatedDeviceStart(...args),
    startAdditionalDevicesForCriteria: (...args) =>
      part().startAdditionalDevicesForCriteria(...args),
    startAdditionalDeviceMatchingCriteria: (...args) =>
      part().startAdditionalDeviceMatchingCriteria(...args),
    listBootedDevicesForStart: (...args) => part().listBootedDevicesForStart(...args),
    getStartableDeviceImageCandidates: (...args) =>
      part().getStartableDeviceImageCandidates(...args),
    isDeviceImageRunningForCandidate: (...args) => part().isDeviceImageRunningForCandidate(...args),
    isExcludedFromAutoStart: (...args) => part().isExcludedFromAutoStart(...args),
    isAutoStartSuppressed: (...args) => part().isAutoStartSuppressed(...args),
    hasPendingAndroidRecovery: (...args) => part().hasPendingAndroidRecovery(...args),
    hasPendingAndroidRecoveryMatching: (...args) =>
      part().hasPendingAndroidRecoveryMatching(...args),
    isCriteriaUnavailableWithoutPendingRecovery: (...args) =>
      part().isCriteriaUnavailableWithoutPendingRecovery(...args),
    shouldWaitForDevice: (...args) => part().shouldWaitForDevice(...args),
    countBusyDevices: (...args) => part().countBusyDevices(...args),
    ensurePoolRefreshed: (...args) => part().ensurePoolRefreshed(...args),
    seedLastUsedAt: (...args) => part().seedLastUsedAt(...args),
    nextLastUsedAt: (...args) => part().nextLastUsedAt(...args),
  };
}
