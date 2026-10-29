import { isErrored } from "./deviceBinding";
import { isExcludedFromAutoStart } from "./deviceAutoStartExclusion";
import type { Mutex } from "async-mutex";
import { ActionableError, type BootedDevice, type DeviceInfo, type Platform } from "../models";
import { BootCapacityExhaustedError } from "../models/BootCapacityExhaustedError";
import { isEmulatorLaunchCancelledError } from "../utils/android-cmdline-tools/EmulatorLaunchCancelledError";
import { BootedDeviceDiscoveryIncompleteError } from "../devices/deviceBootService";
import type { DeviceStartResult, PlatformDeviceManager } from "../devices/deviceUtils";
import type { VirtualDeviceLifecycleCoordinator } from "../devices/virtualDeviceLifecycleCoordinator";
import { runWithAbortSignal } from "../utils/AbortContext";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import type {
  DeviceCriteriaMatcher,
  DeviceAllocationCriteria,
  DeviceAllocationRequest,
  DevicePoolBootedDevice,
} from "./DeviceCriteriaMatcher";
import type { DeviceAutolockChildProcess as ChildProcess, PooledDevice } from "./devicePool";
import type { DevicePoolRefreshResult } from "./devicePoolRefresh";
import type { DeviceRuntimeIdentity } from "./deviceRuntimeIdentity";
import type { IdentityEvidence } from "../devices/deviceIdentityEvidence";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";
import {
  refreshAllocationBindingExclusion,
  type BindingExclusion,
} from "./sessionBroker/provisioning/exclusion";

export interface DeviceAutoStartPort {
  readonly criteriaMatcher: Pick<
    DeviceCriteriaMatcher,
    | "withDeviceImageMetadata"
    | "getDeviceImageKey"
    | "formatCriteriaSummary"
    | "deviceImageMatchesCriteria"
    | "isStartableDeviceImage"
  >;
  readonly deviceManager: Pick<
    PlatformDeviceManager,
    | "startDeviceWithOutcome"
    | "startDevice"
    | "getBootedDevicesDetailed"
    | "listDeviceImages"
    | "isDeviceImageRunning"
  >;
  readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  readonly foreignDeviceOwnership:
    | Pick<ForeignDeviceOwnership, "refresh" | "foreignOwnerPid" | "foreignClaimUnreadable">
    | undefined;
  readonly bindingExclusion: Pick<BindingExclusion, "refresh" | "holderOf"> | undefined;
  readonly runtimeIdentity: Pick<DeviceRuntimeIdentity, "identityEvidenceForBootedDevice">;
  readonly lifecycleCoordinator: Pick<VirtualDeviceLifecycleCoordinator, "reserve">;
  readonly recoveringAndroidImages: Pick<ReadonlyMap<string, DeviceInfo>, "has">;
  readonly assignmentMutex: Pick<Mutex, "runExclusive">;
  readonly adbServerResetRecoveryReservations: Pick<ReadonlyMap<string, unknown>, "has">;
  refreshDevicesWithOutcome(): Promise<DevicePoolRefreshResult>;
  refreshDevices(): Promise<number>;
  refreshForeignOwnership(): Promise<void>;
  trackStartedDeviceProcess(device: BootedDevice, childProcess: ChildProcess | null): Promise<void>;
  stopEmulatorProcess(
    childProcess: ChildProcess | null,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<void>;
  getUnownedDevicesMatchingCriteria(criteria?: DeviceAllocationCriteria): readonly PooledDevice[];
  getDevicesByPlatform(
    platform: Platform,
  ): readonly Pick<PooledDevice, "id" | "avdName" | "name">[];
  getDevice(deviceId: string): PooledDevice | undefined;
  deviceHeldByExistingSession(sessionId: string): Pick<PooledDevice, "id"> | undefined;
  addDevice(
    device: BootedDevice,
    sourceImage: DeviceInfo,
    awaitSessionTracking: boolean,
    identityEvidence: IdentityEvidence,
  ): Promise<void>;
  waitForDeviceReadyOrCancel(
    device: DeviceInfo,
    childProcess: ChildProcess | null,
    timeoutMs: number,
    signal: AbortSignal,
    timer: Pick<Timer, "setTimeout" | "clearTimeout">,
    cancelOwnedBoot: () => Promise<void>,
  ): Promise<BootedDevice>;
}

export class DeviceAutoStart {
  private readonly suppressedAutoStartDeviceImageKeys: Set<string> = new Set();
  private readonly suppressedAutoStartImageKeyByDeviceId: Map<string, string> = new Map();

  constructor(private readonly port: DeviceAutoStartPort) {}

  async startAdditionalDevices(
    requiredCount: number,
    deadlineMs: number,
    platform?: Platform,
  ): Promise<number> {
    // Watches start only through an explicit startDevice, never as pool capacity (#14908).
    if (!platform || platform === "watchos" || requiredCount <= 0) {
      return 0;
    }

    let started = 0;
    try {
      const candidates = await this.getStartableDeviceImageCandidates(platform);
      if (candidates.length === 0) {
        return 0;
      }

      const toStart = candidates.slice(0, requiredCount);

      for (const device of toStart) {
        const label = device.deviceId ?? device.name;
        logger.info(`[DevicePool] Starting additional ${device.platform} device ${label}`);
        const remainingTimeoutMs = this.remainingStartDeadline(deadlineMs);
        if (remainingTimeoutMs <= 0) {
          break;
        }
        const ready = await this.startAndPublishAdditionalDevice(
          device,
          label,
          deadlineMs,
          device.platform,
        );
        if (ready) {
          started++;
        }
      }

      return started;
    } catch (error) {
      if (error instanceof BootCapacityExhaustedError) {
        await this.rethrowCapacityRefusal(error, started);
      }
      logger.warn(`[DevicePool] Failed to start additional devices: ${error}`);
      return started;
    }
  }

  /**
   * A boot refused at the booted-device limit fails the allocation at once with the typed
   * retryable refusal (#11236) instead of degrading into a generic "not enough devices". Devices
   * this allocation already started stay published; the pool is refreshed so its stats count them.
   */
  async rethrowCapacityRefusal(error: BootCapacityExhaustedError, started: number): Promise<never> {
    logger.warn(
      `[DevicePool] Boot capacity exhausted after starting ${started} device(s): ${error.message}`,
    );
    if (started > 0) {
      await this.port.refreshDevicesWithOutcome();
    }
    throw error;
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
    const startResult = await this.runCoordinatedDeviceStart(
      device,
      deadlineMs,
      "start",
      async ({ process: childProcess, outcome }, signal, retainLeaseUntil) => {
        if (
          device.platform === "android" &&
          outcome !== "launched" &&
          !(await this.canAdoptUnlaunchedEmulator(device, outcome))
        ) {
          return null;
        }
        const readinessTimeoutMs = this.remainingStartDeadline(deadlineMs);
        if (readinessTimeoutMs <= 0) {
          logger.warn(`[DevicePool] Start deadline elapsed; cancelling ${label} before readiness`);
          await this.cancelCoordinatedDeviceStart(device, childProcess, retainLeaseUntil);
          return null;
        }
        const ready = this.port.criteriaMatcher.withDeviceImageMetadata(
          await this.port.waitForDeviceReadyOrCancel(
            device,
            childProcess,
            readinessTimeoutMs,
            signal,
            this.port.timer,
            () => this.cancelCoordinatedDeviceStart(device, childProcess, retainLeaseUntil),
          ),
          device,
        );
        if (
          device.platform === "android" &&
          outcome !== "launched" &&
          (await this.refusesForeignOwnedEmulator(device, ready.deviceId))
        ) {
          return null;
        }
        return { ready, childProcess };
      },
    );
    if (!startResult) {
      if (startResult === undefined && platform === "android") {
        // Rediscover the winner after releasing the lifecycle lease.
        await this.port.refreshDevices();
      }
      return null;
    }
    // Start readiness and the lifecycle lease settle before assignmentMutex: never
    // acquire the pool assignment lock while holding a start lease. The pool
    // publish and process association share one assignment turn.
    await this.port.assignmentMutex.runExclusive(async () => {
      await this.port.addDevice(
        startResult.ready,
        device,
        false,
        this.port.runtimeIdentity.identityEvidenceForBootedDevice(startResult.ready),
      );
      await this.port.trackStartedDeviceProcess(startResult.ready, startResult.childProcess);
    });
    return startResult.ready;
  }

  remainingStartDeadline(deadlineMs: number): number {
    return Math.max(0, deadlineMs - this.port.timer.now());
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
    const timeoutMs = this.remainingStartDeadline(deadlineMs);
    const controller = new AbortController();
    const timeoutError = new ActionableError(
      `Device pool start deadline elapsed for ${device.deviceId ?? device.name}`,
    );
    const timeoutHandle = this.port.timer.setTimeout(() => {
      controller.abort(timeoutError);
    }, timeoutMs);
    const identity =
      device.platform === "ios" && !device.deviceId
        ? { kind: "selector" as const, platform: "ios" as const, selector: device.name }
        : {
            kind: "stable" as const,
            platform: device.platform,
            stableId: device.platform === "android" ? device.name : device.deviceId!,
          };
    const lifecycleLease = await this.port.lifecycleCoordinator
      .reserve(identity, { operation, deadlineMs, signal: controller.signal })
      .catch((error: unknown) => {
        // The finally below only owns the timer once the lease is held (#11123).
        this.port.timer.clearTimeout(timeoutHandle);
        throw error;
      });
    const signal = AbortSignal.any([controller.signal, lifecycleLease.signal]);
    let retainedLeaseSettlement: Promise<unknown> | undefined;
    const retainLeaseUntil = (settlement: Promise<unknown>): void => {
      retainedLeaseSettlement = retainedLeaseSettlement
        ? Promise.all([retainedLeaseSettlement, settlement])
        : settlement;
    };
    try {
      // Recovery claimed before candidate selection is suppressed there. When
      // recovery or another start claims after selection, acquisition waits for
      // its lease; revalidate under that lease to join the winner's boot instead
      // of launching the same AVD again (#8381).
      // Every Android start, including uncontended starts, re-runs the existing
      // candidate path: one listDeviceImages and (when images exist) one
      // getBootedDevices. Android images with unknown running state are excluded.
      // Keep the funnelled post-skip refresh outside the lifecycle lease.
      if (device.platform === "android" && operation === "start") {
        const candidates = await this.getStartableDeviceImageCandidates("android");
        const pooled = this.port.getDevicesByPlatform("android");
        if (
          !candidates.some(
            (candidate) =>
              this.port.criteriaMatcher.getDeviceImageKey(candidate) ===
              this.port.criteriaMatcher.getDeviceImageKey(device),
          ) ||
          this.isAutoStartSuppressed(device) ||
          pooled.some(
            (entry) =>
              entry.id === device.deviceId || (entry.avdName ?? entry.name) === device.name,
          )
        ) {
          return undefined;
        }
      }
      const start = await this.startCoordinatedDeviceProcess(
        device,
        deadlineMs,
        signal,
        retainLeaseUntil,
      );
      return await action(start, signal, retainLeaseUntil);
    } finally {
      if (retainedLeaseSettlement) {
        void retainedLeaseSettlement.then(
          () => lifecycleLease.release(),
          () => lifecycleLease.release(),
        );
      } else {
        lifecycleLease.release();
      }
      this.port.timer.clearTimeout(timeoutHandle);
    }
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
    try {
      return await runWithAbortSignal(signal, () =>
        this.startDeviceWithOutcome(device, deadlineMs),
      );
    } catch (error) {
      if (isEmulatorLaunchCancelledError(error) && error.process) {
        await this.cancelCoordinatedDeviceStart(device, error.process, retainLeaseUntil);
      }
      throw error;
    }
  }

  async startDeviceWithOutcome(device: DeviceInfo, deadlineMs: number): Promise<DeviceStartResult> {
    const timeoutMs = this.remainingStartDeadline(deadlineMs);
    if (this.port.deviceManager.startDeviceWithOutcome) {
      return this.port.deviceManager.startDeviceWithOutcome(device, timeoutMs);
    }
    const process = await this.port.deviceManager.startDevice(device, timeoutMs);
    return { process, outcome: process ? "launched" : "already-running" };
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
    const discovery = await this.port.deviceManager.getBootedDevicesDetailed("android");
    if (!discovery.succeededPlatforms.has("android")) {
      // An incomplete adb listing cannot prove the emulator is ours to adopt (or
      // free of a foreign lease); refuse rather than wait on it (#11103).
      logger.warn(
        `[DevicePool] Android discovery was incomplete; not adopting AVD '${device.name}' for allocation`,
      );
      return false;
    }
    const visible = discovery.devices.find((booted) => booted.name === device.name);
    if (visible) {
      return !(await this.refusesForeignOwnedEmulator(device, visible.deviceId));
    }
    if (outcome === "duplicate-of-external") {
      logger.warn(
        `[DevicePool] AVD '${device.name}' is running in another process that this daemon's adb cannot see; not adopting it for allocation`,
      );
      return false;
    }
    // Still booting, or booting in this process: readiness names it, then the lease is checked.
    return true;
  }

  /**
   * An emulator this start did not launch is refused only on positive evidence that another
   * live AutoMobile process drives it: that process holds its CtrlProxy forwarding lease. A
   * user-started emulator or a launch joined in this process holds no foreign lease and is
   * adopted.
   */
  async refusesForeignOwnedEmulator(device: DeviceInfo, deviceId: string): Promise<boolean> {
    if (!this.port.foreignDeviceOwnership) {
      return false;
    }
    await this.port.foreignDeviceOwnership.refresh([deviceId]);
    const ownerPid = this.port.foreignDeviceOwnership.foreignOwnerPid(deviceId);
    if (
      ownerPid === undefined &&
      !this.port.foreignDeviceOwnership.foreignClaimUnreadable?.(deviceId)
    ) {
      return false;
    }
    logger.warn(
      `[DevicePool] AVD '${device.name}' (${deviceId}) is driven by another AutoMobile process${ownerPid === undefined ? "" : ` (PID ${ownerPid})`}; not adopting it for allocation`,
    );
    return true;
  }

  async cancelCoordinatedDeviceStart(
    device: DeviceInfo,
    childProcess: ChildProcess | null,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    if (device.platform === "android") {
      await this.port.stopEmulatorProcess(childProcess, retainLeaseUntil);
      return;
    }
    childProcess?.kill();
  }

  async startAdditionalDevicesForCriteria(
    requests: DeviceAllocationRequest[],
    deadlineMs: number,
  ): Promise<number> {
    const reservedDeviceIds = new Set<string>();
    const excludedImageIds = new Set<string>();
    let started = 0;
    let refreshed = false;

    // A session that already holds a device (an executePlan base session) uses that device, so
    // it can never stand in for another label's request.
    const unheldRequests = requests.filter((request) => {
      const held = this.port.deviceHeldByExistingSession(request.sessionId);
      if (held) {
        reservedDeviceIds.add(held.id);
      }
      return !held;
    });
    const findExisting = (request: DeviceAllocationRequest) =>
      this.port
        .getUnownedDevicesMatchingCriteria(request.criteria)
        .find((device) => !isErrored(device) && !reservedDeviceIds.has(device.id));

    for (const request of unheldRequests) {
      const existing = findExisting(request);
      if (existing) {
        reservedDeviceIds.add(existing.id);
        continue;
      }

      const outcome = await this.startAdditionalDeviceMatchingCriteria(
        request.criteria,
        excludedImageIds,
        deadlineMs,
        async () => {
          if (refreshed) {
            return undefined;
          }
          // A booted device can be missing from the pool, e.g. dropped after a reboot until
          // something acquires it. Re-discover once before cold-booting an AVD (mt-0083 D2).
          refreshed = true;
          await this.port.refreshDevicesWithOutcome();
          await this.port.refreshForeignOwnership();
          return findExisting(request);
        },
      ).catch((error: unknown) =>
        error instanceof BootCapacityExhaustedError
          ? this.rethrowCapacityRefusal(error, started)
          : Promise.reject(error),
      );
      if (outcome) {
        reservedDeviceIds.add(outcome.device.id);
        if (outcome.started) {
          started++;
        }
      }
    }

    return started;
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
  ): Promise<{ device: PooledDevice; started: boolean } | null> {
    if (!criteria?.platform) {
      return null;
    }

    try {
      const candidates = await this.getStartableDeviceImageCandidates(
        criteria.platform,
        criteria,
        excludedImageIds,
      );
      const device = candidates[0];
      if (!device) {
        return null;
      }
      const rediscovered = await rediscover();
      if (rediscovered) {
        return { device: rediscovered, started: false };
      }

      const label = device.deviceId ?? device.name;
      logger.info(
        `[DevicePool] Starting ${device.platform} device ${label} for criteria ${this.port.criteriaMatcher.formatCriteriaSummary(criteria)}`,
      );
      excludedImageIds.add(this.port.criteriaMatcher.getDeviceImageKey(device));
      const remainingTimeoutMs = this.remainingStartDeadline(deadlineMs);
      if (remainingTimeoutMs <= 0) {
        return null;
      }
      const ready = await this.startAndPublishAdditionalDevice(
        device,
        label,
        deadlineMs,
        criteria.platform,
      );
      const pooled = ready ? this.port.getDevice(ready.deviceId) : undefined;
      return pooled ? { device: pooled, started: true } : null;
    } catch (error) {
      if (error instanceof BootCapacityExhaustedError) {
        // The caller fails the allocation with the typed refusal (#11236).
        throw error;
      }
      logger.warn(
        `[DevicePool] Failed to start device for criteria ${this.port.criteriaMatcher.formatCriteriaSummary(criteria)}: ${error}`,
      );
      return null;
    }
  }

  /**
   * Booted devices for a start decision. A failed listing is not "nothing is
   * booted": starting from it could boot a duplicate beside an attached device,
   * so an incomplete scan refuses with a retryable error (#11103).
   */
  async listBootedDevicesForStart(platform: Platform): Promise<BootedDevice[]> {
    const discovery = await this.port.deviceManager.getBootedDevicesDetailed(platform);
    if (!discovery.succeededPlatforms.has(platform)) {
      throw new BootedDeviceDiscoveryIncompleteError(
        platform,
        discovery.discoveryErrors?.[platform],
      );
    }
    return discovery.devices;
  }

  async getStartableDeviceImageCandidates(
    platform: Platform,
    criteria?: DeviceAllocationCriteria,
    excludedImageIds: Set<string> = new Set(),
  ): Promise<DeviceInfo[]> {
    if (this.port.bindingExclusion) {
      await refreshAllocationBindingExclusion(this.port.bindingExclusion);
    }
    const availableImages = await this.port.deviceManager.listDeviceImages(platform);
    if (availableImages.length === 0) {
      return [];
    }

    const bootedDevices = await this.listBootedDevicesForStart(platform);
    const bootedIds = new Set(bootedDevices.map((device) => device.deviceId));
    const bootedNames = new Set(bootedDevices.map((device) => device.name));
    const candidates: DeviceInfo[] = [];

    for (const image of availableImages) {
      if (!this.port.criteriaMatcher.deviceImageMatchesCriteria(image, criteria)) {
        continue;
      }
      if (!this.port.criteriaMatcher.isStartableDeviceImage(image)) {
        continue;
      }
      if (excludedImageIds.has(this.port.criteriaMatcher.getDeviceImageKey(image))) {
        continue;
      }
      if (this.isExcludedFromAutoStart(image)) {
        continue;
      }
      if (image.deviceId && bootedIds.has(image.deviceId)) {
        continue;
      }
      const running = await this.isDeviceImageRunningForCandidate(image, bootedIds, bootedNames);
      if (running) {
        continue;
      }
      candidates.push(image);
    }

    return candidates;
  }

  async isDeviceImageRunningForCandidate(
    image: DeviceInfo,
    bootedIds: Set<string>,
    bootedNames: Set<string>,
  ): Promise<boolean> {
    if (
      image.platform === "android" &&
      ((image.deviceId !== undefined && bootedIds.has(image.deviceId)) ||
        bootedNames.has(image.name))
    ) {
      return true;
    }
    if (image.isRunning === true) {
      return true;
    }
    if (image.isRunningStateKnown !== false) {
      return image.deviceId ? bootedIds.has(image.deviceId) : bootedNames.has(image.name);
    }
    return await this.port.deviceManager.isDeviceImageRunning(image);
  }

  /** Suppressed, or held by a broker binding: generic auto-start never boots a binding's device (#11174). */
  isExcludedFromAutoStart(image: DeviceInfo): boolean {
    return (
      this.isAutoStartSuppressed(image) ||
      isExcludedFromAutoStart(image, this.port.bindingExclusion)
    );
  }

  isAutoStartSuppressed(image: DeviceInfo): boolean {
    return (
      this.suppressedAutoStartDeviceImageKeys.has(
        this.port.criteriaMatcher.getDeviceImageKey(image),
      ) ||
      this.suppressedAutoStartDeviceImageKeys.has(`${image.platform}:${image.name}`) ||
      (image.platform === "android" &&
        (this.port.recoveringAndroidImages.has(image.name) ||
          this.port.adbServerResetRecoveryReservations.has(image.name)))
    );
  }

  suppressAutoStartForDevice(device: PooledDevice): void {
    const imageKey = `${device.platform}:${device.avdName ?? device.name}`;
    this.suppressedAutoStartDeviceImageKeys.add(device.id);
    this.suppressedAutoStartDeviceImageKeys.add(imageKey);
    this.suppressedAutoStartImageKeyByDeviceId.set(device.id, imageKey);
  }

  clearAutoStartSuppressionForBootedDevice(device: BootedDevice, sourceImage?: DeviceInfo): void {
    const rememberedImageKey = this.suppressedAutoStartImageKeyByDeviceId.get(device.deviceId);
    const observedImageKey = `${device.platform}:${device.name}`;
    const authoritativeImageKey =
      sourceImage?.platform === device.platform
        ? `${sourceImage.platform}:${sourceImage.name}`
        : observedImageKey;
    this.suppressedAutoStartDeviceImageKeys.delete(device.deviceId);
    this.suppressedAutoStartDeviceImageKeys.delete(observedImageKey);
    this.suppressedAutoStartDeviceImageKeys.delete(authoritativeImageKey);
    if (rememberedImageKey === authoritativeImageKey) {
      this.suppressedAutoStartDeviceImageKeys.delete(rememberedImageKey);
      this.suppressedAutoStartImageKeyByDeviceId.delete(device.deviceId);
    }
  }
}
