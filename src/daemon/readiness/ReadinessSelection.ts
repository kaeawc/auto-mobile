import {
  type AppearanceMode,
  ActionableError,
  BootedDevice,
  DeviceInfo,
  Platform,
  SomePlatform,
} from "../../models";
import { AsyncLocalStorage } from "node:async_hooks";
import { AmbiguousDeviceTargetError } from "../ambiguousDeviceTargetRefusal";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { type Timer } from "../../utils/SystemTimer";
import { AdbUnavailableError } from "../../utils/android-cmdline-tools/AdbClient";
import { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { errorMessage } from "../../utils/describeUnknownError";
import { type DeviceAdmissionGate } from "../../utils/deviceAdmissionGate";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { disableStylusHandwriting } from "../../utils/disableStylusHandwriting";
import { type DiscoverySource } from "../../utils/discoverySource";
import { PlatformDeviceManager } from "../../utils/interfaces/DeviceUtils";
import { logger } from "../../utils/logger";
import { throwIfProvisionedDeviceTransportRetired } from "../../utils/provisionedDeviceTransportFence";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { ActiveDeviceSelection } from "../../devices/ActiveDeviceSelection";
import type {
  ConnectedPlatformScan,
  ConnectedPlatformScanOptions,
  DeviceClientProvider,
  DeviceClientSimctl,
  DeviceReadyOptions,
  ResolvedDeviceIdentity,
} from "./DeviceReadiness";
import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../../devices/deviceBootService";
import { isUnresolvedAndroidEmulatorName } from "../../devices/deviceIdentityEvidence";
import {
  assertAndroidImageRunningStateKnown,
  type BootedDeviceDiscoveryOptions,
} from "../../devices/deviceUtils";
import {
  type LifecycleStartHold,
  isScanAuthoritativeFor,
  lifecycleIdentityForDevice,
} from "./readinessLifecycleIdentity";
import {
  explicitReadTargetPlatform,
  matchRunningReadTarget,
  providedReadTargetNotFound,
} from "../../devices/runningReadTarget";
import {
  type StableVirtualDeviceIdentity,
  type VirtualDeviceLifecycleIdentity,
} from "../../devices/virtualDeviceLifecycleCoordinator";

interface ReadinessSelectionDependencies {
  applyAppearanceOnConnect(
    device: BootedDevice,
    sessionId?: string,
  ): Promise<AppearanceMode | null>;
  resumeAfterDeviceStart(platform: Platform, deviceId: string): void;
  resumeReadBootClient(platform: Platform, deviceId: string): void;
  detectConnectedPlatformsWithStatus(
    signal?: AbortSignal,
    options?: ConnectedPlatformScanOptions,
  ): Promise<ConnectedPlatformScan>;
  findProvidedReadinessImage(
    platform: SomePlatform,
    providedDeviceId: string,
    scan: ConnectedPlatformScan,
    options: DeviceReadyOptions,
  ): Promise<DeviceInfo | undefined>;
  readonly adb: AdbExecutor;
  readonly simctl: DeviceClientSimctl | undefined;
  readonly provider: DeviceClientProvider;
  readonly runnerReadinessTimer: Timer;
  readonly physicalIosScanBudgetMs: number;
  readonly selection: ActiveDeviceSelection;
  withLifecycleStart<T>(
    identity: StableVirtualDeviceIdentity | VirtualDeviceLifecycleIdentity,
    options: DeviceReadyOptions | undefined,
    operation: (signal: AbortSignal, hold: LifecycleStartHold) => Promise<T>,
  ): Promise<T>;
  verifyDevice(
    deviceId: string,
    platform: Platform,
    options?: DeviceReadyOptions,
    resolvedIdentity?: ResolvedDeviceIdentity,
  ): Promise<void>;
  readonly adbFactory: AdbClientFactory;
  readonly checkedAndroidOwnership: AsyncLocalStorage<Set<string>>;
  findOrStartDevice(platform: Platform, options?: DeviceReadyOptions): Promise<BootedDevice>;
  readonly deviceUtils: PlatformDeviceManager;
  bootAndroidReadinessImage(
    deviceImage: DeviceInfo,
    options?: DeviceReadyOptions,
    perf?: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<BootedDevice>;
  bootIosReadinessImage(
    device: DeviceInfo,
    options?: DeviceReadyOptions,
    perf?: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<BootedDevice>;
  clearExplicitDevicePin(deviceId: string): void;
  readonly admissionGate: DeviceAdmissionGate;
}
/** Selects and verifies readiness targets without owning boot or runner setup. */
export class ReadinessSelection {
  constructor(private readonly dependencies: ReadinessSelectionDependencies) {}

  async detectConnectedPlatformsWithStatus(
    signal?: AbortSignal,
    options?: ConnectedPlatformScanOptions,
  ): Promise<ConnectedPlatformScan> {
    const devices: BootedDevice[] = [];
    const scannedSources: Record<DiscoverySource, boolean> = {
      android: false,
      "ios-simulator": false,
      "ios-physical": false,
    };
    const perf = createGlobalPerformanceTracker();

    try {
      // Check for Android devices via ADB
      perf.startOperation("androidDeviceScan");
      // A missing adb binary (or its cooldown) must not read as a complete,
      // empty scan: that would let reconciliation clear a pinned Android device.
      const androidDevices = this.mapAndroidReadinessRows(
        await this.dependencies.adb.getBootedAndroidDevices({
          signal,
          throwOnMissingAdb: true,
        }),
      );
      perf.endOperation("androidDeviceScan");
      devices.push(...androidDevices);
      scannedSources.android = true;
    } catch (error) {
      perf.endOperation("androidDeviceScan");
      signal?.throwIfAborted();
      if (error instanceof AdbUnavailableError) {
        // Expected on hosts without the Android SDK; the scan stays non-authoritative.
        logger.debug(`Android scan skipped: ${error.message}`);
      } else {
        logger.warn(`Failed to detect Android devices: ${error}`);
      }
    }

    const [simulators, physical] = await Promise.all([
      this.scanBootedSimulators(perf, signal),
      this.scanPhysicalIosDevices(options?.platform, signal),
    ]);
    signal?.throwIfAborted();
    // Simulator entries win on overlap: they carry richer runtime metadata.
    const seen = new Set(simulators.devices.map((device) => device.deviceId));
    devices.push(
      ...simulators.devices,
      ...physical.devices.filter((device) => !seen.has(device.deviceId)),
    );
    scannedSources["ios-simulator"] = simulators.complete;
    scannedSources["ios-physical"] = physical.complete;

    return {
      devices,
      scanned: {
        android: scannedSources.android,
        ios: scannedSources["ios-simulator"] || scannedSources["ios-physical"],
      },
      scannedSources,
    };
  }

  /**
   * Booted simulators via the checked listing: a failed `simctl` call leaves
   * the source unscanned rather than reading as "no simulators" (#11063).
   */
  private async scanBootedSimulators(
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    signal?: AbortSignal,
  ): Promise<{ devices: BootedDevice[]; complete: boolean }> {
    if (!this.dependencies.simctl) {
      return { devices: [], complete: false };
    }
    perf.startOperation("iosSimulatorScan");
    try {
      const devices = await this.dependencies.simctl.getBootedSimulatorsChecked(undefined, signal);
      return { devices, complete: true };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`Failed to detect iOS simulators: ${error}`);
      return { devices: [], complete: false };
    } finally {
      perf.endOperation("iosSimulatorScan");
    }
  }

  /**
   * Connected physical iOS devices via the shared devicectl lister. Retained
   * devices from an incomplete listing still resolve, but the source counts as
   * scanned only when devicectl reported a complete listing (#11063).
   */
  private async scanPhysicalIosDevices(
    platform?: SomePlatform,
    signal?: AbortSignal,
  ): Promise<{ devices: BootedDevice[]; complete: boolean }> {
    const lister = this.dependencies.provider.getIosPhysicalDeviceLister?.();
    if (!lister || platform === "android") {
      return { devices: [], complete: false };
    }
    try {
      // The lister run is shared and uncancellable; losing the race leaves it running.
      const discovery = await raceWithDeadline(() => lister.listConnectedDevices(), {
        timer: this.dependencies.runnerReadinessTimer,
        timeoutMs: this.dependencies.physicalIosScanBudgetMs,
        signal,
        label: "Physical iOS device scan",
      });
      return { devices: discovery.devices, complete: discovery.complete };
    } catch (error) {
      signal?.throwIfAborted();
      // The lister contract is non-throwing; a misbehaving one must not fail the scan.
      logger.warn(`Failed to detect physical iOS devices: ${errorMessage(error)}`);
      return { devices: [], complete: false };
    }
  }

  async ensureDeviceReadyInCall(
    platform: SomePlatform,
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice> {
    logger.info(
      `[DeviceReadiness] ensureDeviceReady called with platform=${platform}, providedDeviceId=${providedDeviceId}`,
    );
    providedDeviceId = await this.resolveProvidedReadinessId(providedDeviceId);

    // Detect all connected devices
    const result = await this.getReadinessScan(platform, options);
    const scan = this.normalizeReadinessScan(result);
    const connectedPlatforms = scan.devices;
    this.reconcileReadinessPin(scan, options);
    logger.info(`Found ${connectedPlatforms.length} connectedPlatform devices`);
    const androidDevices = connectedPlatforms.filter((device) => device.platform === "android");
    logger.info(`Found ${androidDevices.length} android devices`);
    const iosDevices = connectedPlatforms.filter((device) => device.platform === "ios");
    logger.info(`Found ${iosDevices.length} ios devices`);

    const readTarget = await this.resolveReadinessReadTarget(
      platform,
      providedDeviceId,
      scan,
      options,
    );
    if (readTarget.bootedDevice) {
      return await this.finishReadinessSelection(
        readTarget.bootedDevice,
        readTarget.bootedDevice.platform,
        "provided",
        scan,
        options,
      );
    }

    // A running read name is judged and verified by its serial/UDID from here on.
    providedDeviceId = readTarget.providedDeviceId;
    const { platformDevices, resolvedPlatform } = this.resolveReadinessPlatform(
      platform,
      androidDevices,
      iosDevices,
      providedDeviceId,
      options,
    );

    let selectedDevice: BootedDevice | undefined;
    let deviceVerified = false;
    let deviceSource: "provided" | "auto" = "auto";

    // If a specific device is provided, verify it exists on the correct platform
    if (providedDeviceId) {
      const providedDevice = this.requireProvidedReadinessDevice(
        platform,
        platformDevices,
        providedDeviceId,
      );
      selectedDevice = await this.resolveAndroidReadinessIdentity(providedDevice, options?.signal);
      deviceSource = "provided";
    }

    // Explicit selection takes precedence over ambient resolution by another call.
    const selectedPin = this.findPinnedReadinessDevice(platformDevices, options);
    if (this.shouldResolveReadinessPin(selectedDevice, providedDeviceId, selectedPin)) {
      selectedDevice = await this.resolveAndroidReadinessIdentity(selectedPin, options?.signal);
      deviceSource = "provided";
    }

    // No device set - find or start one for the requested platform
    if (!selectedDevice) {
      logger.info(`[DeviceReadiness] Finding or starting device for platform ${resolvedPlatform}`);
      selectedDevice = await this.findOrStartReadinessDevice(resolvedPlatform, scan, options);
      deviceVerified = true;
      deviceSource = "auto";
    }

    if (!deviceVerified) {
      if (!selectedDevice) {
        throw new ActionableError("No device was selected for readiness verification");
      }
      const deviceForVerification = selectedDevice;
      await this.dependencies.withLifecycleStart(
        lifecycleIdentityForDevice(deviceForVerification),
        options,
        async (signal) =>
          await this.dependencies.verifyDevice(
            deviceForVerification.deviceId,
            resolvedPlatform,
            { ...options, signal },
            deviceForVerification,
          ),
      );
    }

    return await this.finishReadinessSelection(
      selectedDevice,
      resolvedPlatform,
      deviceSource,
      scan,
      options,
    );
  }

  private async finishReadinessSelection(
    selectedDevice: BootedDevice,
    resolvedPlatform: Platform,
    deviceSource: "provided" | "auto",
    scan: ConnectedPlatformScan,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice> {
    // Safety check: ensure the selected device's platform matches the resolved platform.
    // This guards against cross-platform contamination where an iOS device could be
    // returned when Android was explicitly requested (or vice versa).
    if (selectedDevice.platform !== resolvedPlatform) {
      logger.warn(
        `[DeviceReadiness] Platform mismatch: selected device ${selectedDevice.deviceId} ` +
          `has platform '${selectedDevice.platform}' but resolved platform is '${resolvedPlatform}'. ` +
          `Discarding and finding correct platform device.`,
      );
      selectedDevice = await this.findOrStartReadinessDevice(resolvedPlatform, scan, options);
    }

    // A cancelled call (e.g. another session acquired the device, #10905) stops before each
    // control-only step: appearance and stylus settings writes.
    // A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
    // (owner decision 2026-10-12, #11964). CtrlProxy accessibility settings are part of readiness above.
    options?.signal?.throwIfAborted();
    if (options?.intent !== "read") {
      await this.assertAndroidSelectionAvailable(selectedDevice, options?.signal);
      await this.dependencies.applyAppearanceOnConnect(selectedDevice, options?.sessionId);
      options?.signal?.throwIfAborted();
      await disableStylusHandwriting(selectedDevice, this.dependencies.adbFactory);
    }
    logger.info(`[DeviceReadiness] Using ${deviceSource} device: ${selectedDevice.deviceId}`);
    return selectedDevice;
  }

  private async assertAndroidSelectionAvailable(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      device.platform !== "android" ||
      this.dependencies.checkedAndroidOwnership.getStore()?.has(device.deviceId)
    ) {
      return;
    }
    await this.dependencies.provider
      .getAndroidCtrlProxyManager(device)
      .assertNotDrivenByOtherDaemon?.(signal);
    signal?.throwIfAborted();
  }

  private shouldResolveReadinessPin(
    selectedDevice: BootedDevice | undefined,
    providedDeviceId: string | undefined,
    selectedPin: BootedDevice | undefined,
  ): selectedPin is BootedDevice {
    return !selectedDevice && !providedDeviceId && !!selectedPin;
  }

  private requireProvidedReadinessDevice(
    platform: SomePlatform,
    platformDevices: BootedDevice[],
    providedDeviceId: string,
  ): BootedDevice {
    const providedDevice = platformDevices.find((device) => device.deviceId === providedDeviceId);
    if (!providedDevice) {
      throw providedReadTargetNotFound(providedDeviceId, platform, platformDevices);
    }
    return providedDevice;
  }

  private assertReadinessDiscoveryComplete(
    platform: SomePlatform,
    scan: ConnectedPlatformScan,
  ): void {
    const platforms: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    for (const candidate of platforms) {
      if (!scan.scanned[candidate]) {
        throw new BootedDeviceDiscoveryIncompleteError(candidate, undefined);
      }
    }
  }

  private async resolveReadinessReadTarget(
    platform: SomePlatform,
    providedDeviceId: string | undefined,
    scan: ConnectedPlatformScan,
    options?: DeviceReadyOptions,
  ): Promise<{ providedDeviceId: string | undefined; bootedDevice?: BootedDevice }> {
    if (options?.intent !== "read") {
      return { providedDeviceId };
    }
    if (!providedDeviceId) {
      // Stop before readiness can reserve a lifecycle lease for an undiscovered target.
      this.requireRunningReadinessDevice(platform, scan);
      return { providedDeviceId };
    }
    const running = matchRunningReadTarget(scan.devices, providedDeviceId, platform);
    if (running) {
      return { providedDeviceId: running.deviceId };
    }
    // Resolve a stopped image before mixed-platform ambiguity: the call names its own platform.
    return {
      providedDeviceId,
      bootedDevice: await this.bootProvidedReadinessImage(
        platform,
        providedDeviceId,
        scan,
        options,
      ),
    };
  }

  private requireRunningReadinessDevice(
    platform: SomePlatform,
    scan: ConnectedPlatformScan,
  ): BootedDevice {
    const devices = scan.devices.filter(
      (candidate) => platform === "either" || candidate.platform === platform,
    );
    // Preserve findOrStartIosDevice's deterministic first-running selection.
    if (platform === "ios") {
      devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    }
    const device = devices[0];
    if (device) {
      return device;
    }
    // An either-platform read can establish absence on any completed platform.
    if (platform !== "either" || !Object.values(scan.scanned).some(Boolean)) {
      this.assertReadinessDiscoveryComplete(platform, scan);
    }
    const label =
      platform === "either" ? "Android or iOS" : platform === "android" ? "Android" : "iOS";
    throw new ActionableError(
      `No ${label} device is running, so there is nothing to read. ` +
        "Start one with startDevice or provisionDevice, or pass a deviceId.",
    );
  }

  /** Every readiness fallback, including platform mismatch, observes the read's no-implicit-boot rule. */
  private async findOrStartReadinessDevice(
    platform: Platform,
    scan: ConnectedPlatformScan,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice> {
    const candidates = scan.devices.filter((device) => device.platform === platform);
    if (candidates.length > 1) {
      throw new AmbiguousDeviceTargetError(
        `Multiple ${platform} devices connected. Specify deviceId or select a device for this connection.`,
        candidates,
      );
    }
    if (options?.intent !== "read") {
      return await this.dependencies.findOrStartDevice(platform, options);
    }
    const device = await this.resolveAndroidReadinessIdentity(
      this.requireRunningReadinessDevice(platform, scan),
      options.signal,
    );
    await this.dependencies.withLifecycleStart(
      lifecycleIdentityForDevice(device),
      options,
      async (signal) => {
        this.dependencies.resumeAfterDeviceStart(platform, device.deviceId);
        await this.dependencies.verifyDevice(
          device.deviceId,
          platform,
          { ...options, signal },
          device,
        );
      },
    );
    return device;
  }

  private async listProvidedReadinessImages(
    platform: Platform,
    options: DeviceReadyOptions,
  ): Promise<DeviceInfo[]> {
    if (platform === "ios" && !this.dependencies.simctl) {
      throw new BootedDeviceDiscoveryIncompleteError("ios", {
        code: "unavailable",
        message: "iOS simulator tools not available",
        retryable: true,
      });
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timeoutError = new BootedDeviceDiscoveryIncompleteError(platform, {
      code: "timeout",
      message: "Named device image discovery timed out",
      retryable: true,
    });
    try {
      return await raceWithDeadline(
        () =>
          platform === "android"
            ? this.dependencies.deviceUtils.listDeviceImages("android", signal)
            : this.dependencies.simctl!.listSimulatorImages(undefined, {
                bypassCache: true,
                signal,
              }),
        {
          timer: this.dependencies.runnerReadinessTimer,
          timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
          signal: options.signal,
          label: "Named device image discovery",
          timeoutError: () => timeoutError,
          onTimeout: () => controller.abort(timeoutError),
        },
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new BootedDeviceDiscoveryIncompleteError(platform, {
        code: "failed",
        message: errorMessage(error),
        retryable: true,
      });
    }
  }

  /** Read-only inventory lookup, also used to prove a target before read discovery retries. */
  async findProvidedReadinessImage(
    platform: SomePlatform,
    providedDeviceId: string,
    scan: ConnectedPlatformScan,
    options: DeviceReadyOptions,
  ): Promise<DeviceInfo | undefined> {
    platform = explicitReadTargetPlatform(providedDeviceId, platform);
    if (platform !== "either") {
      this.assertReadinessDiscoveryComplete(platform, scan);
    }
    const platforms: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    const inventories = await Promise.allSettled(
      platforms.map((p) => this.listProvidedReadinessImages(p, options)),
    );
    options.signal?.throwIfAborted();
    const images = inventories.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const matches = images.filter((image) =>
      image.platform === "android"
        ? image.name === providedDeviceId
        : image.deviceId === providedDeviceId,
    );
    const image = matches.length === 1 ? matches[0] : undefined;
    // A match needs authoritative discovery only for its own platform. Without
    // a match, an incomplete in-scope scan still cannot establish not-found.
    this.assertReadinessDiscoveryComplete(image?.platform ?? platform, scan);
    for (const [index, result] of inventories.entries()) {
      if (result.status === "rejected" && scan.scanned[platforms[index]]) {
        // Completed discovery with failed inventory cannot rule out an ambiguous ID.
        throw result.reason;
      }
    }
    return image;
  }

  private async bootProvidedReadinessImage(
    platform: SomePlatform,
    providedDeviceId: string,
    scan: ConnectedPlatformScan,
    options: DeviceReadyOptions,
  ): Promise<BootedDevice> {
    const image = await this.dependencies.findProvidedReadinessImage(
      platform,
      providedDeviceId,
      scan,
      options,
    );
    if (image?.platform === "android" && image.isRunning === true) {
      throw new AndroidBootedDeviceDiscoveryIncompleteError(
        undefined,
        `Android AVD '${image.name}' is running but its serial could not be resolved yet.`,
      );
    }
    if (
      !image ||
      image.isRunning !== false ||
      (image.platform === "ios" && image.isAvailable === false)
    ) {
      // Keep the existing not-found text, even when ambient devices span both platforms.
      return this.requireProvidedReadinessDevice(
        platform,
        scan.devices.filter((device) => platform === "either" || device.platform === platform),
        providedDeviceId,
      );
    }
    if (image.platform === "android") {
      if (image.isRunningStateKnown === false) {
        throw new AndroidBootedDeviceDiscoveryIncompleteError(
          undefined,
          `Cannot safely cold-boot Android AVD '${image.name}': its running state is unknown.`,
        );
      }
      await options.beforeReadBoot?.(image);
      return await this.dependencies.bootAndroidReadinessImage(image, options);
    }
    await options.beforeReadBoot?.(image);
    return await this.dependencies.bootIosReadinessImage(image, options);
  }

  private findPinnedReadinessDevice(
    platformDevices: BootedDevice[],
    options?: DeviceReadyOptions,
  ): BootedDevice | undefined {
    const pin = this.dependencies.selection.getPin(options?.connectionId);
    return platformDevices.find((device) => device.deviceId === pin?.deviceId);
  }

  /** Ownership has been rechecked; now observe boot state while holding the image lease. */
  async recheckReadBootImage(
    image: DeviceInfo,
    options: DeviceReadyOptions | undefined,
  ): Promise<BootedDevice | undefined> {
    if (options?.intent !== "read") {
      return undefined;
    }
    let running: BootedDevice | undefined;
    if (image.platform === "android") {
      running = await this.recheckAndroidReadBootImage(image, options);
    } else {
      const images = await this.listProvidedReadinessImages("ios", options);
      const matches = images.filter((candidate) => candidate.deviceId === image.deviceId);
      const current = matches.length === 1 ? matches[0] : undefined;
      if (!current || current.isAvailable === false) {
        throw providedReadTargetNotFound(image.deviceId!, "ios", []);
      }
      if (current.isRunning === true) {
        running = { ...current, deviceId: image.deviceId! };
      } else if (current.isRunning !== false) {
        throw providedReadTargetNotFound(image.deviceId!, "ios", []);
      }
    }
    if (running) {
      await options.beforeReadReadiness?.(running);
      options.signal?.throwIfAborted();
      this.dependencies.resumeReadBootClient(image.platform, running.deviceId);
      await this.dependencies.verifyDevice(running.deviceId, image.platform, options, running);
    }
    return running;
  }

  private async recheckAndroidReadBootImage(
    image: DeviceInfo,
    options: DeviceReadyOptions,
  ): Promise<BootedDevice | undefined> {
    // Do not reuse the caller's discovery memo or Android's short device-list cache.
    const bootedDevices = await this.listBootedAndroidDevicesForSelection({
      bypassAndroidDeviceListCache: true,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    const images = await this.listProvidedReadinessImages("android", options);
    const matches = images.filter((candidate) => candidate.name === image.name);
    const current = matches.length === 1 ? matches[0] : undefined;
    if (!current) {
      throw providedReadTargetNotFound(image.name, "android", []);
    }
    const running = matchRunningReadTarget(
      bootedDevices.filter(
        (device) => isAndroidEmulatorSerial(device.deviceId) && device.name === image.name,
      ),
      image.name,
      "android",
    );
    if (running) {
      return running;
    }
    if (current.isRunning === true) {
      throw new AndroidBootedDeviceDiscoveryIncompleteError(
        undefined,
        `Android AVD '${image.name}' is running but its serial could not be resolved yet.`,
      );
    }
    assertAndroidImageRunningStateKnown(current);
    if (current.isRunning !== false) {
      throw new AndroidBootedDeviceDiscoveryIncompleteError(
        undefined,
        `Cannot safely cold-boot Android AVD '${image.name}': its running state is unknown.`,
      );
    }
    return undefined;
  }

  async listBootedAndroidDevicesForSelection(
    options?: BootedDeviceDiscoveryOptions,
  ): Promise<BootedDevice[]> {
    const discovery = await this.dependencies.deviceUtils.getBootedDevicesDetailed(
      "android",
      options,
    );
    options?.signal?.throwIfAborted();
    // Failed discovery cannot establish absence and admit a cold boot (#11103).
    if (!discovery.succeededPlatforms.has("android")) {
      throw new AndroidBootedDeviceDiscoveryIncompleteError(discovery.discoveryErrors?.android);
    }
    return discovery.devices;
  }

  private getReadinessScan(
    platform: SomePlatform,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice[] | ConnectedPlatformScan> {
    return options?.getConnectedPlatforms
      ? options.getConnectedPlatforms()
      : this.dependencies.detectConnectedPlatformsWithStatus(options?.signal, { platform });
  }

  private reconcileReadinessPin(scan: ConnectedPlatformScan, options?: DeviceReadyOptions): void {
    const pinnedDevice = this.dependencies.selection.getPin(options?.connectionId);
    if (
      pinnedDevice &&
      isScanAuthoritativeFor(scan, pinnedDevice) &&
      !scan.devices.some(
        (device) =>
          device.deviceId === pinnedDevice.deviceId && device.platform === pinnedDevice.platform,
      )
    ) {
      // Proven device absence invalidates that device's pins on every connection.
      this.dependencies.clearExplicitDevicePin(pinnedDevice.deviceId);
    }
  }

  private resolveReadinessPlatform(
    platform: SomePlatform,
    androidDevices: BootedDevice[],
    iosDevices: BootedDevice[],
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): { platformDevices: BootedDevice[]; resolvedPlatform: Platform } {
    // Get devices for the requested platform
    let platformDevices: BootedDevice[] = [];
    let resolvedPlatform: Platform;
    switch (platform) {
      case "android":
        platformDevices = androidDevices;
        resolvedPlatform = "android";
        break;
      case "ios":
        platformDevices = iosDevices;
        resolvedPlatform = "ios";
        break;
      default:
        // Only check for mixed platforms when auto-detecting (not explicitly specified)
        if (androidDevices.length > 0 && iosDevices.length > 0) {
          return this.resolveMixedReadinessPlatform(
            androidDevices,
            iosDevices,
            providedDeviceId,
            options,
          );
        }

        if (androidDevices.length > 0) {
          platformDevices = androidDevices;
          resolvedPlatform = "android";
        } else if (iosDevices.length > 0) {
          platformDevices = iosDevices;
          resolvedPlatform = "ios";
        } else {
          platformDevices = [];
          resolvedPlatform = "android";
        }
    }

    return { platformDevices, resolvedPlatform };
  }

  private resolveMixedReadinessPlatform(
    androidDevices: BootedDevice[],
    iosDevices: BootedDevice[],
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): { platformDevices: BootedDevice[]; resolvedPlatform: Platform } {
    // An explicit deviceId names the target unambiguously, so it resolves
    // the platform ahead of the ambient one — otherwise switching to a
    // device on the other platform by id would be pinned to whatever
    // setActiveDevice last selected and fail (issue #5870).
    if (providedDeviceId) {
      const allDevices = [...androidDevices, ...iosDevices];
      const match = allDevices.find((d) => d.deviceId === providedDeviceId);
      if (match) {
        return {
          platformDevices: match.platform === "android" ? androidDevices : iosDevices,
          resolvedPlatform: match.platform,
        };
      }
    }
    // With no matching deviceId, fall back to the platform setActiveDevice selected.
    const pin = this.dependencies.selection.getPin(options?.connectionId);
    const selectedPlatform = pin?.platform;
    if (selectedPlatform) {
      return {
        platformDevices: selectedPlatform === "android" ? androidDevices : iosDevices,
        resolvedPlatform: selectedPlatform,
      };
    }
    // #15020: typed, so a client branches on the code and reads the candidates it may choose from.
    throw new AmbiguousDeviceTargetError(
      "Both Android and iOS devices are connected. For a device tool call, pass sessionUuid (from getAndroid/getApple), platform, or a bound device label on this call to select the target. Alternatively, call setActiveDevice to select an active device.",
      [...androidDevices, ...iosDevices],
    );
  }

  /**
   * Production discovery lists Android devices from raw `adb devices`, so the
   * explicitly targeted readiness paths only see
   * `name === serial`. Resolve the AVD identity from the enriched discovery
   * (the same source `findOrStartAndroidDevice` uses) so those paths also
   * rebuild the cached Window when another AVD takes over the serial (#7031).
   * Falls back to the raw entry when the runtime cannot be resolved.
   */
  private async findLiveAndroidDevice(deviceId: string): Promise<BootedDevice | undefined> {
    return (await this.dependencies.deviceUtils.getBootedDevices("android")).find(
      (candidate) => candidate.deviceId === deviceId,
    );
  }

  /** AVD name currently attached to `deviceId`, or undefined when not resolvable. */
  private async resolveCurrentAndroidIdentity(deviceId: string): Promise<string | undefined> {
    try {
      const live = await this.findLiveAndroidDevice(deviceId);
      return live && !isUnresolvedAndroidEmulatorName(live) ? live.name : undefined;
    } catch (error) {
      logger.warn(
        `[DeviceReadiness] Could not resolve the live identity of ${deviceId} for the retired-transport check: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  private async resolveAndroidReadinessIdentity(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<BootedDevice> {
    if (!isUnresolvedAndroidEmulatorName(device)) {
      return device;
    }
    signal?.throwIfAborted();
    let enriched: BootedDevice | undefined;
    try {
      enriched = await this.findLiveAndroidDevice(device.deviceId);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[DeviceReadiness] Could not resolve the AVD identity for ${device.deviceId}; ` +
          `keeping the raw serial identity: ${errorMessage(error)}`,
        error,
      );
      return device;
    }
    return enriched && !isUnresolvedAndroidEmulatorName(enriched) ? enriched : device;
  }

  /**
   * Raw adb rows name transports, while pooled sessions hold a canonical id. A
   * USB+Wi-Fi phone keeps its USB serial after the cable is pulled, so map
   * through the pool's alias groups before matching readiness ids (#11133).
   */
  /**
   * Readiness rows are keyed by the pooled canonical id, so a caller naming a
   * known transport alias (e.g. the Wi-Fi `ip:port`) must resolve to it (#11133).
   */
  private async resolveProvidedReadinessId(
    providedDeviceId: string | undefined,
  ): Promise<string | undefined> {
    if (!providedDeviceId) {
      return undefined;
    }
    await throwIfProvisionedDeviceTransportRetired(providedDeviceId, {
      currentIdentity: () => this.resolveCurrentAndroidIdentity(providedDeviceId),
    });
    return this.canonicalAndroidId(providedDeviceId);
  }

  canonicalAndroidId(deviceId: string): string {
    return this.dependencies.admissionGate.resolveAndroidCanonicalId?.(deviceId) ?? deviceId;
  }

  mapAndroidReadinessRows(devices: BootedDevice[]): BootedDevice[] {
    return this.dependencies.admissionGate.mapAndroidReadinessDiscovery?.(devices) ?? devices;
  }

  private normalizeReadinessScan(
    result: BootedDevice[] | ConnectedPlatformScan,
  ): ConnectedPlatformScan {
    return Array.isArray(result)
      ? { devices: result, scanned: { android: true, ios: true } }
      : result;
  }
}
