export {
  CtrlProxyApkInstallError,
  CtrlProxyInspectionError,
  MAX_STALE_PREFETCH_DIRS_PER_STARTUP,
  REBIND_BIND_WAIT_BUDGET_MS,
  REBIND_MUTATION_COMMAND_TIMEOUT_MS,
  REBIND_MUTATION_COMMAND_TIMEOUT_MAX_MS,
  STALE_PREFETCH_SWEEP_DEADLINE_MS,
  type CtrlProxyCompatibilityInspection,
  type CtrlProxyManager,
  type CtrlProxySetupResult,
} from "./CtrlProxyManagerContracts";
import { resolveSetupUser } from "./setupUser";
import * as fs from "fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { ENV, readEnvBool, readEnvRaw } from "../config/env";
import {
  isExplicitPin,
  isPinnedVersionKnown,
  resolveApkChecksum,
  resolveApkUrl,
  resolvePinnedVersion,
} from "../constants/release";
import { requireBootedDevice } from "../devices/requireBootedDevice";
import { ActionableError, BootedDevice, ExecResult } from "../models";
import { CtrlProxyForwardOwnershipUnreadableError } from "../models/CtrlProxyForwardOwnershipUnreadableError";
import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import { DeviceLostError } from "../models/DeviceLostError";
import type { ForeignCtrlProxyForwardEvidence } from "../models/ForeignCtrlProxyForwardEvidence";
import { getAbortSignal } from "../utils/AbortContext";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  AdbDeviceOfflineError,
  isAdbDeviceOfflineError,
  isAdbMissingDeviceError,
} from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { findDeviceTransportUnavailable } from "../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { DefaultAndroidPrerequisiteDetector } from "../utils/android-cmdline-tools/AndroidPrerequisiteDetector";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DefaultChecksumCalculator, type ChecksumCalculator } from "../utils/ChecksumCalculator";
import { errorMessage } from "../utils/describeUnknownError";
import { registerDeviceIncarnationListener } from "../utils/deviceIncarnation";
import { DefaultFileDownloader, type FileDownloader } from "../utils/FileDownloader";
import { logger } from "../utils/logger";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { accessibilityDetector } from "./accessibility/AccessibilityDetector";
import type { AccessibilityDetector } from "./accessibility/interfaces/AccessibilityDetector";
import { AndroidCtrlProxyAccessibility } from "./AndroidCtrlProxyAccessibility";
import { AndroidCtrlProxyApkInstaller } from "./AndroidCtrlProxyApkInstaller";
import { AndroidCtrlProxyCompatibility } from "./AndroidCtrlProxyCompatibility";
import type {
  AccessibilityVersionCheckOptions,
  AccessibilityVersionCheckResult,
  InstalledApkSha256Result,
  ToggleCapabilities,
} from "./AndroidCtrlProxyManagerTypes";
import { AndroidCtrlProxyRebind } from "./AndroidCtrlProxyRebind";
import { classifySetupError } from "./classifySetupError";
import { CTRL_PROXY_PACKAGE } from "./constants";
import {
  DefaultCtrlProxyApkPrefetcher,
  type CtrlProxyApkPrefetcher,
  type CtrlProxyApkPrefetcherDeps,
} from "./CtrlProxyApkPrefetcher";
import {
  type ApkOverrideChecksumEntry,
  type CtrlProxyCompatibilityInspection,
  type CtrlProxyManager,
  type CtrlProxySetupResult,
} from "./CtrlProxyManagerContracts";
import { ctrlProxyManagerHost, type SavedPrototypeService } from "./ctrlProxyManagerHost";
import { MapDeviceClientRegistry, type DeviceClientRegistry } from "./deviceClientRegistry";
import { AndroidDeviceTraitsReader } from "../utils/android-cmdline-tools/deviceTraits";

export class AndroidCtrlProxyManager implements CtrlProxyManager {
  // Kept on the manager for the observe availability-invalidation test seam.
  private cachedAvailability: { isAvailable: boolean; timestamp: number } | null = null;
  private readonly accessibility: AndroidCtrlProxyAccessibility;
  private readonly deviceTraits: AndroidDeviceTraitsReader;
  private readonly rebind: AndroidCtrlProxyRebind;
  private readonly compatibility: AndroidCtrlProxyCompatibility;
  private readonly apkInstaller: AndroidCtrlProxyApkInstaller;
  /**
   * The user CtrlProxy is set up for: the foreground user on a headless-system-user automotive
   * device, otherwise undefined and every command stays exactly as it was (#14918).
   */
  private async setupUser(): Promise<number | undefined> {
    return resolveSetupUser(this.adb, this.device);
  }

  private createAndroidCtrlProxyAccessibility(): AndroidCtrlProxyAccessibility {
    const manager = this;
    return new AndroidCtrlProxyAccessibility({
      get cachedAvailability() {
        return manager.cachedAvailability;
      },
      set cachedAvailability(value) {
        manager.cachedAvailability = value;
      },
      get timer() {
        return manager.timer;
      },
      get adb() {
        return manager.adb;
      },
      readDeviceTraits: () => this.deviceTraits.read(this.adb, this.device.deviceId),
      statusInspectionDeviceError: (error) => this.statusInspectionDeviceError(error),
      isInstalled: () => this.isInstalled(),
      isEnabled: (_signal, options) => this.isEnabled(_signal, options),
      assertNotDrivenByOtherDaemon: (signal) => this.assertNotDrivenByOtherDaemon(signal),
      getToggleCapabilities: () => this.getToggleCapabilities(),
      clearAvailabilityCache: () => this.clearAvailabilityCache(),
      enableViaSettings: () => this.enableViaSettings(),
      getApiLevel: () => this.getApiLevel(),
      setupUser: () => this.setupUser(),
    });
  }

  private createAndroidCtrlProxyRebind(): AndroidCtrlProxyRebind {
    const manager = this;
    return new AndroidCtrlProxyRebind({
      get adb() {
        return manager.adb;
      },
      get timer() {
        return manager.timer;
      },
      assertNotDrivenByOtherDaemon: (signal) => this.assertNotDrivenByOtherDaemon(signal),
      get device() {
        return manager.device;
      },
      isAccessibilityServiceHealthy: () => this.isAccessibilityServiceHealthy(),
      clearAvailabilityCache: () => this.clearAvailabilityCache(),
      setupUser: () => this.setupUser(),
    });
  }

  private createAndroidCtrlProxyCompatibility(): AndroidCtrlProxyCompatibility {
    const manager = this;
    return new AndroidCtrlProxyCompatibility({
      getInstalledApkSha256WithDetails: (signal) => this.getInstalledApkSha256WithDetails(signal),
      getExpectedChecksum: (useSharedCache) => this.getExpectedChecksum(useSharedCache),
      getInstalledApkSha256: () => this.getInstalledApkSha256(),
      assertPinnedVersionVerifiable: () => this.assertPinnedVersionVerifiable(),
      isInstalled: () => this.isInstalled(),
      shouldSkipDownloadIfInstalled: () => this.shouldSkipDownloadIfInstalled(),
      isKnownExplicitPinConfigured: () => AndroidCtrlProxyManager.isKnownExplicitPinConfigured(),
      isKnownPinUnverified: (status) => AndroidCtrlProxyManager.isKnownPinUnverified(status),
      clearServiceAvailabilityCache: () => this.clearServiceAvailabilityCache(),
      uninstallLegacyPackageIfPresent: (guardOwnership) =>
        this.uninstallLegacyPackageIfPresent(guardOwnership),
      downloadApk: () => this.downloadApk(),
      installDownloadedApk: (apkPath, result, isInstalled, needsReinstallDueToUnknownSha, perf) =>
        this.installDownloadedApk(
          apkPath,
          result,
          isInstalled,
          needsReinstallDueToUnknownSha,
          perf,
        ),
      statusInspectionDeviceError: (error) => this.statusInspectionDeviceError(error),
      cleanupApk: (apkPath) => this.cleanupApk(apkPath),
      createKnownPinMismatchError: (expectedSha, installedSha) =>
        AndroidCtrlProxyManager.createKnownPinMismatchError(expectedSha, installedSha),
      queueBackgroundApkRefresh: () => this.queueBackgroundApkRefresh(),
      getApkPathOverride: () => this.getApkPathOverride(),
      completedPrefetchPath: () => AndroidCtrlProxyManager.prefetcher.completedPath(),
      consumeCompletedPrefetchedApk: (destinationPath) =>
        AndroidCtrlProxyManager.consumeCompletedPrefetchedApk(destinationPath),
      clearAvailabilityCache: () => this.clearAvailabilityCache(),
      executeApkStage: (command, stage) => this.executeApkStage(command, stage),
      grantLocalNetworkAfterInstall: () => this.grantLocalNetworkAfterInstall(),
      install: (apkPath) => this.install(apkPath),
      enable: () => this.enable(),
      get savedPrototypes() {
        return manager.savedPrototypes;
      },
      get device() {
        return manager.device;
      },
      waitForAccessibilityServiceBinding: () => this.waitForAccessibilityServiceBinding(),
      get timer() {
        return manager.timer;
      },
    });
  }

  private createAndroidCtrlProxyApkInstaller(): AndroidCtrlProxyApkInstaller {
    const manager = this;
    return new AndroidCtrlProxyApkInstaller({
      assertPinnedVersionVerifiable: () => this.assertPinnedVersionVerifiable(),
      getApkPathOverride: () => this.getApkPathOverride(),
      consumePrefetchedApk: (destinationPath) =>
        AndroidCtrlProxyManager.consumePrefetchedApk(destinationPath),
      getExpectedChecksum: (useSharedCache) => this.getExpectedChecksum(useSharedCache),
      cleanupApk: (apkPath) => this.cleanupApk(apkPath),
      get fileDownloader() {
        return manager.fileDownloader;
      },
      get checksumCalculator() {
        return manager.checksumCalculator;
      },
      get adb() {
        return manager.adb;
      },
      assertNotDrivenByOtherDaemon: (signal) => this.assertNotDrivenByOtherDaemon(signal),
      clearAvailabilityCache: () => this.clearAvailabilityCache(),
      get timer() {
        return manager.timer;
      },
      executeApkStage: (command, stage) => this.executeApkStage(command, stage),
      grantLocalNetworkAfterInstall: () => this.grantLocalNetworkAfterInstall(),
      statusInspectionDeviceError: (error) => this.statusInspectionDeviceError(error),
      getApiLevel: () => this.getApiLevel(),
      setupUser: () => this.setupUser(),
      get device() {
        return manager.device;
      },
    });
  }

  private readonly device: BootedDevice;
  private adb: AdbExecutor;
  public static readonly PACKAGE = CTRL_PROXY_PACKAGE;
  public static readonly ACTIVITY = "dev.jasonpearson.automobile.ctrlproxy.MainActivity";

  private attemptedAutomatedSetup: boolean = false;
  /** Per-device instance lifecycle (#11847). */
  public static readonly registry: DeviceClientRegistry<AndroidCtrlProxyManager> =
    new MapDeviceClientRegistry<AndroidCtrlProxyManager>();
  private static expectedChecksumOverride: string | null = null;
  private static readonly apkOverrideChecksums = new Map<string, ApkOverrideChecksumEntry>();
  private static accessibilityDetectorOverride: AccessibilityDetector | null = null;
  private static foreignForwardEvidenceOverride: ForeignCtrlProxyForwardEvidence | null = null;
  private readonly foreignForwardGuardContext = new AsyncLocalStorage<boolean>();

  private timer: Timer;
  private savedPrototypeServiceOverride: SavedPrototypeService | undefined;

  public setSavedPrototypeServiceForTesting(service: SavedPrototypeService | undefined): void {
    this.savedPrototypeServiceOverride = service;
  }

  private get savedPrototypes(): SavedPrototypeService {
    return this.savedPrototypeServiceOverride ?? ctrlProxyManagerHost.savedPrototypes();
  }

  // Shared utilities for download and checksum
  private fileDownloader: FileDownloader;
  private checksumCalculator: ChecksumCalculator;

  /** Swap the download or checksum collaborator on a live manager (tests that vary them mid-flight). */
  public setDownloadUtilitiesForTesting(deps: {
    fileDownloader?: FileDownloader;
    checksumCalculator?: ChecksumCalculator;
  }): void {
    this.fileDownloader = deps.fileDownloader ?? this.fileDownloader;
    this.checksumCalculator = deps.checksumCalculator ?? this.checksumCalculator;
  }
  private static readonly defaultFileDownloader: FileDownloader = new DefaultFileDownloader();
  private static readonly defaultChecksumCalculator: ChecksumCalculator =
    new DefaultChecksumCalculator();

  // Process-wide prefetch state lives in the prefetcher. Production uses the default one;
  // tests (or a daemon that owns its lifecycle) swap in their own with `useApkPrefetcher`.
  private static prefetcher: CtrlProxyApkPrefetcher = AndroidCtrlProxyManager.createApkPrefetcher();

  /**
   * Build a prefetcher wired to the real release resolvers. Pass `overrides` to inject a
   * downloader, cache directory, prerequisite detector or checksum source (fakes in tests).
   */
  public static createApkPrefetcher(
    overrides: Partial<CtrlProxyApkPrefetcherDeps> = {},
  ): CtrlProxyApkPrefetcher {
    const prerequisiteDetector = new DefaultAndroidPrerequisiteDetector();
    return new DefaultCtrlProxyApkPrefetcher({
      downloader: () => AndroidCtrlProxyManager.defaultFileDownloader,
      checksumCalculator: () => AndroidCtrlProxyManager.defaultChecksumCalculator,
      prerequisiteDetector: () => prerequisiteDetector,
      cacheDirOverride: () => null,
      expectedChecksumOverride: () => AndroidCtrlProxyManager.expectedChecksumOverride,
      isPinnedVersionUnverifiable: () => AndroidCtrlProxyManager.isPinnedVersionUnverifiable(),
      describePinnedVersion: () => resolvePinnedVersion(),
      resolveApkUrl: () => resolveApkUrl(),
      resolveApkChecksum: () => resolveApkChecksum(),
      localApkPathOverride: () => readEnvRaw(ENV.CTRL_PROXY_APK_PATH),
      ...overrides,
    });
  }

  /** Use `prefetcher` for every manager in this process; null restores a default one. */
  public static useApkPrefetcher(prefetcher: CtrlProxyApkPrefetcher | null): void {
    AndroidCtrlProxyManager.prefetcher =
      prefetcher ?? AndroidCtrlProxyManager.createApkPrefetcher();
  }

  private constructor(
    device: BootedDevice,
    adb: AdbExecutor,
    timer: Timer = defaultTimer,
    fileDownloader: FileDownloader = AndroidCtrlProxyManager.defaultFileDownloader,
    checksumCalculator: ChecksumCalculator = AndroidCtrlProxyManager.defaultChecksumCalculator,
  ) {
    this.device = device;
    this.adb = adb;
    this.timer = timer;
    this.fileDownloader = fileDownloader;
    this.checksumCalculator = checksumCalculator;
    // One manager per device, so a per-manager reader reads each device's traits once per TTL.
    this.deviceTraits = new AndroidDeviceTraitsReader(timer);
    this.accessibility = this.createAndroidCtrlProxyAccessibility();
    this.rebind = this.createAndroidCtrlProxyRebind();
    this.compatibility = this.createAndroidCtrlProxyCompatibility();
    this.apkInstaller = this.createAndroidCtrlProxyApkInstaller();
  }

  public static getInstance(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
  ): import("./AndroidCtrlProxyManagerHandle").AndroidCtrlProxyManagerHandle {
    requireBootedDevice(device, "AndroidCtrlProxyManager.getInstance");
    return AndroidCtrlProxyManager.getRegisteredInstance(device, adbFactory);
  }

  /** The concrete manager behind the registry entry {@link getInstance} returns. */
  public static getInstanceForTesting(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
  ): AndroidCtrlProxyManager {
    requireBootedDevice(device, "AndroidCtrlProxyManager.getInstanceForTesting");
    return AndroidCtrlProxyManager.getRegisteredInstance(device, adbFactory);
  }

  private static getRegisteredInstance(
    device: BootedDevice,
    adbFactory: AdbClientFactory,
  ): AndroidCtrlProxyManager {
    return AndroidCtrlProxyManager.registry.get(
      device.deviceId,
      () => new AndroidCtrlProxyManager(device, adbFactory.create(device)),
    );
  }

  /** Fresh diagnostic reads without registering or replacing live session dependencies. */
  public static createDetached(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor = defaultAdbClientFactory,
  ): AndroidCtrlProxyManager {
    requireBootedDevice(device, "AndroidCtrlProxyManager.createDetached");
    const adb =
      "create" in adbFactoryOrExecutor ? adbFactoryOrExecutor.create(device) : adbFactoryOrExecutor;
    return new AndroidCtrlProxyManager(device, adb);
  }

  public static createForTestingWithDeps(
    device: BootedDevice,
    adb: AdbExecutor,
    timer: Timer = defaultTimer,
    fileDownloader: FileDownloader = AndroidCtrlProxyManager.defaultFileDownloader,
    checksumCalculator: ChecksumCalculator = AndroidCtrlProxyManager.defaultChecksumCalculator,
  ): AndroidCtrlProxyManager {
    requireBootedDevice(device, "AndroidCtrlProxyManager.createForTestingWithDeps");
    return new AndroidCtrlProxyManager(device, adb, timer, fileDownloader, checksumCalculator);
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    AndroidCtrlProxyManager.registry.closeAll();
    AndroidCtrlProxyManager.apkOverrideChecksums.clear();
  }

  public static setForeignForwardEvidenceForTesting(
    evidence: ForeignCtrlProxyForwardEvidence | null,
  ): void {
    AndroidCtrlProxyManager.foreignForwardEvidenceOverride = evidence;
  }

  /** Fail closed when an existing CtrlProxy forward could belong to another daemon. */
  public async assertNotDrivenByOtherDaemon(signal?: AbortSignal): Promise<void> {
    const activeSignal = signal ?? getAbortSignal();
    activeSignal?.throwIfAborted();
    if (this.foreignForwardGuardContext.getStore()) {
      return;
    }
    const evidence =
      AndroidCtrlProxyManager.foreignForwardEvidenceOverride ??
      ctrlProxyManagerHost.createForeignForwardEvidence({ create: () => this.adb });
    const finding = await evidence.read(this.device.deviceId, activeSignal);
    activeSignal?.throwIfAborted();
    if (finding.kind === "none") {
      return;
    }
    const ports = finding.ports.join(", ");
    if (finding.kind === "foreign") {
      throw new DeviceOwnedByOtherDaemonError(
        this.device.deviceId,
        finding.clientPids[0],
        `CtrlProxy adb forward on port${finding.ports.length === 1 ? "" : "s"} ${ports} ` +
          `is owned by another process. ${finding.message} Stop the owning daemon or use ` +
          "another device.",
      );
    }
    if (finding.ports.length === 0) {
      throw new CtrlProxyForwardOwnershipUnreadableError(this.device.deviceId, finding.reason);
    }
    const remedy = finding.ports
      .map((port) => `\`adb -s ${this.device.deviceId} forward --remove tcp:${port}\``)
      .join(", ");
    throw new DeviceOwnedByOtherDaemonError(
      this.device.deviceId,
      undefined,
      `CtrlProxy forward ownership could not be established (${finding.reason}); ` +
        `${finding.message} If no other daemon uses this device, remove the stale forward with ` +
        `${remedy} and retry.`,
    );
  }

  /**
   * Evict a single device's manager instance. Mirrors
   * `IOSCtrlProxyManager.evict` so both platforms share the same per-device
   * teardown seam (issue #6580) — call this from device teardown/destroy so a
   * deleted device does not retain a manager for the daemon's lifetime.
   * `AndroidCtrlProxyManager` holds no `PortManager` reservation, so deleting
   * the map entry is the entire eviction.
   */
  public static getExistingInstance(deviceId: string): AndroidCtrlProxyManager | undefined {
    return AndroidCtrlProxyManager.registry.peek(deviceId);
  }

  public static evictInstance(instance: AndroidCtrlProxyManager): void {
    AndroidCtrlProxyManager.registry.invalidate(instance.device.deviceId, instance);
  }

  public static evict(deviceId: string, avdName?: string): void {
    if (!avdName) {
      AndroidCtrlProxyManager.registry.invalidate(deviceId);
    }
    if (avdName) {
      // The stopped AVD inventory lacks an ADB serial. The manager retains
      // the booted incarnation's name and runtime ID, including direct sessions.
      for (const [runtimeId, manager] of AndroidCtrlProxyManager.registry.entries()) {
        if (runtimeId.startsWith("emulator-") && manager.device.name === avdName) {
          AndroidCtrlProxyManager.registry.invalidate(runtimeId);
        }
      }
    }
  }

  /** Drop every serial-scoped readiness cache after a guest snapshot restore. */
  public static invalidateForDeviceIncarnation(deviceId: string): void {
    AndroidCtrlProxyManager.getExistingInstance(deviceId)?.resetSetupState();
    AndroidCtrlProxyManager.evict(deviceId);
  }

  /**
   * Prefetch the accessibility service APK asynchronously.
   * Call this at server startup to warm the cache before first device connection.
   * This is a no-op if prefetch is already in progress or completed.
   */
  public static prefetchApk(): Promise<string | null> {
    return AndroidCtrlProxyManager.prefetcher.prefetch();
  }

  /**
   * Get the prefetched APK path, waiting for prefetch to complete if in progress.
   * Returns null if prefetch failed or was not initiated.
   */
  public static getPrefetchedApkPath(): Promise<string | null> {
    return AndroidCtrlProxyManager.prefetcher.getPrefetchedPath();
  }

  /**
   * Consume the prefetched APK path by copying it to a new location.
   * This allows multiple devices to use the prefetched APK.
   * Returns false if no prefetched APK is available.
   */
  public static consumePrefetchedApk(destinationPath: string): Promise<boolean> {
    return AndroidCtrlProxyManager.prefetcher.consume(destinationPath);
  }

  /**
   * Consume only an already-completed prefetch. Unlike consumePrefetchedApk(),
   * this never waits for an in-progress network download.
   */
  private static consumeCompletedPrefetchedApk(destinationPath: string): Promise<boolean> {
    return AndroidCtrlProxyManager.prefetcher.consumeCompleted(destinationPath);
  }

  /** Clean up the prefetched APK file */
  public static cleanupPrefetchedApk(): Promise<void> {
    return AndroidCtrlProxyManager.prefetcher.cleanup();
  }

  /** Best-effort startup sweep for orphaned `auto-mobile-prefetch-*` scratch directories (#4334). */
  public static sweepStalePrefetchDirsOnStartup(tempRoot?: string, timer?: Timer): Promise<void> {
    return AndroidCtrlProxyManager.prefetcher.sweepStaleDirs(tempRoot, timer);
  }

  public static setExpectedChecksumForTesting(checksum: string | null): void {
    AndroidCtrlProxyManager.expectedChecksumOverride = checksum;
  }

  public static setAccessibilityDetectorForTesting(detector: AccessibilityDetector | null): void {
    AndroidCtrlProxyManager.accessibilityDetectorOverride = detector;
  }

  private getAccessibilityDetector(): AccessibilityDetector {
    return AndroidCtrlProxyManager.accessibilityDetectorOverride || accessibilityDetector;
  }

  /**
   * Clear the cached availability status.
   *
   * Issue #4192: this is the single choke point for "our cached view of the
   * accessibility service is stale". It also invalidates the AccessibilityDetector
   * cache, so `observe` cannot keep reporting the pre-mutation state. Every
   * mutation path (enable/disable/enableForUser, install/upgrade, setup reset)
   * routes through here — do not re-add per-call-site invalidation.
   */
  public clearAvailabilityCache(): void {
    this.clearServiceAvailabilityCache();
    this.accessibility.clearToggleCache();
    this.compatibility.clearCache();
    logger.info("[CTRL_PROXY] Cleared all availability caches");
  }

  /**
   * Reset the setup state to allow a fresh setup attempt.
   * Call this when observe detects accessibilityState.enabled: false
   * to force a full re-setup on the next attempt.
   */
  public resetSetupState(): void {
    this.attemptedAutomatedSetup = false;
    this.clearAvailabilityCache();
    logger.info("[CTRL_PROXY] Reset setup state - next setup will be a full attempt");
  }

  /** Allow another automated setup attempt while preserving fresh availability caches. */
  public reopenSetupGate(): void {
    this.attemptedAutomatedSetup = false;
  }

  /**
   * Check if Accessibility Service is installed on the device
   */
  async isInstalled(): Promise<boolean> {
    return this.accessibility.isInstalled();
  }

  /**
   * Check if Accessibility Service is enabled as an input method
   */
  async isEnabled(
    _signal?: AbortSignal,
    options: { bypassCache?: boolean } = {},
  ): Promise<boolean> {
    return this.accessibility.isEnabled(_signal, options);
  }

  private statusInspectionDeviceError(error: unknown): Error | undefined {
    const transport = findDeviceTransportUnavailable(error);
    if (transport) {
      return transport;
    }
    const message = errorMessage(error);
    if (isAdbMissingDeviceError(error, this.device.deviceId)) {
      return new DeviceLostError(this.device.deviceId, message);
    }
    if (isAdbDeviceOfflineError(error)) {
      return new AdbDeviceOfflineError(this.device.deviceId, message);
    }
    return undefined;
  }

  /**
   * Check the framework's binding state separately from the secure-setting
   * configuration. A configured service can remain listed after Android moves
   * it to "Crashed services", so isEnabled() alone cannot establish health.
   */
  async isAccessibilityServiceHealthy(): Promise<boolean> {
    return this.rebind.isAccessibilityServiceHealthy();
  }

  /** Distinguish an already-bound service from a bind completed during this wait. */
  async waitForAccessibilityServiceBinding(): Promise<"already-bound" | "recovered" | "unhealthy"> {
    return this.rebind.waitForAccessibilityServiceBinding();
  }

  /**
   * Remove CtrlProxy from the configured service list and add it back when
   * Android reports it crashed or unbound. Writing the intermediate list keeps
   * every other enabled accessibility service intact while forcing a rebind.
   *
   * Concurrent callers (the #7534 readiness path and a client's own
   * connection-failure recovery, issue #7532) share a single in-flight rebind
   * rather than interleaving their own force-stop/settings sequences against
   * the same on-device service.
   */
  async rebindIfUnhealthy(): Promise<boolean> {
    return this.rebind.rebindIfUnhealthy();
  }

  /**
   * Force-stop and re-add the accessibility service unconditionally — see the
   * {@link CtrlProxyManager.forceRestartProcess} doc for why this is distinct
   * from {@link rebindIfUnhealthy} (issue #7533). Shares `rebindIfUnhealthy`'s
   * single-flight guard (#7532) so the two recovery paths never interleave
   * force-stop/settings writes against the same device, and refuses to run
   * against a device adb no longer lists as present so a caller cannot turn
   * this into a restart loop.
   */
  async forceRestartProcess(): Promise<boolean> {
    return this.rebind.forceRestartProcess();
  }

  /**
   * Check if Accessibility Service is enabled for a specific user profile
   * @param userId - The Android user ID to check (e.g., 10 for work profile)
   */
  async isEnabledForUser(userId: number): Promise<boolean> {
    return this.accessibility.isEnabledForUser(userId);
  }

  /**
   * Check if the accessibility service is both installed and enabled
   * @returns Promise<boolean> - True if available for use, false otherwise
   */
  async isAvailable(): Promise<boolean> {
    return this.accessibility.isAvailable();
  }

  /**
   * Get SHA256 of installed accessibility service APK.
   */
  async getInstalledApkSha256(): Promise<string | null> {
    return this.compatibility.getInstalledApkSha256();
  }

  async readSnapshotIdentity(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const installed = await this.getInstalledApkSha256WithDetails(signal);
    signal.throwIfAborted();
    const expected = await this.getExpectedChecksum(false);
    signal.throwIfAborted();
    if (!expected || installed.sha256 !== expected) {
      throw new ActionableError(
        "Android snapshot requires the current verified CtrlProxy artifact",
      );
    }
    return expected;
  }

  /**
   * Check if installed APK SHA256 matches expected release checksum.
   */
  async isVersionCompatible(): Promise<boolean> {
    return this.compatibility.isVersionCompatible();
  }

  /** Inspect integrity without provisioning, invalidating caches, or consuming prefetches. */
  async inspectCompatibility(signal?: AbortSignal): Promise<CtrlProxyCompatibilityInspection> {
    return this.compatibility.inspectCompatibility(signal);
  }

  /**
   * Ensure installed accessibility service version matches expected checksum.
   */
  async ensureCompatibleVersion(
    options: AccessibilityVersionCheckOptions = {},
  ): Promise<AccessibilityVersionCheckResult> {
    return this.compatibility.ensureCompatibleVersion(options);
  }

  private async installDownloadedApk(
    apkPath: string,
    result: AccessibilityVersionCheckResult,
    isInstalled: boolean,
    needsReinstallDueToUnknownSha: boolean,
    perf: PerformanceTracker,
  ): Promise<AccessibilityVersionCheckResult> {
    await this.foreignForwardGuardContext.run(false, () => this.assertNotDrivenByOtherDaemon());
    return this.foreignForwardGuardContext.run(true, () =>
      this.installDownloadedApkGuarded(
        apkPath,
        result,
        isInstalled,
        needsReinstallDueToUnknownSha,
        perf,
      ),
    );
  }

  /** Public so install-ordering tests can drive the guarded install step directly. */
  async installDownloadedApkGuarded(
    apkPath: string,
    result: AccessibilityVersionCheckResult,
    isInstalled: boolean,
    needsReinstallDueToUnknownSha: boolean,
    perf: PerformanceTracker,
  ): Promise<AccessibilityVersionCheckResult> {
    return this.compatibility.installDownloadedApkGuarded(
      apkPath,
      result,
      isInstalled,
      needsReinstallDueToUnknownSha,
      perf,
    );
  }

  /**
   * Download APK
   */
  async downloadApk(): Promise<string> {
    return this.apkInstaller.downloadApk();
  }

  /**
   * Uninstall the legacy accessibility service package if still present on the device.
   * This cleans up the old package name left over from before the rename to CtrlProxy.
   */
  async uninstallLegacyPackageIfPresent(guardOwnership = false): Promise<void> {
    return this.apkInstaller.uninstallLegacyPackageIfPresent(guardOwnership);
  }

  private async executeApkStage(command: string, stage: string): Promise<ExecResult> {
    return this.apkInstaller.executeApkStage(command, stage);
  }

  async install(apkPath: string): Promise<void> {
    return this.apkInstaller.install(apkPath);
  }

  private async grantLocalNetworkAfterInstall(): Promise<void> {
    return this.apkInstaller.grantLocalNetworkAfterInstall();
  }

  /**
   * Enable Accessibility Service via adb settings commands
   */
  async enableViaSettings(): Promise<void> {
    return this.accessibility.enableViaSettings();
  }

  /**
   * Disable Accessibility Service via adb settings commands
   */
  async disableViaSettings(): Promise<void> {
    return this.accessibility.disableViaSettings();
  }

  /**
   * Enable Accessibility Service
   */
  async enable(): Promise<void> {
    return this.accessibility.enable();
  }

  /**
   * Enable Accessibility Service for a specific user profile via adb settings commands
   * @param userId - The Android user ID to enable for (e.g., 10 for work profile)
   */
  async enableForUser(userId: number): Promise<void> {
    return this.accessibility.enableForUser(userId);
  }

  /**
   * Clean up temporary APK file
   */
  async cleanupApk(apkPath: string): Promise<void> {
    return this.apkInstaller.cleanupApk(apkPath);
  }

  private async recheckSetup(perf: PerformanceTracker): Promise<CtrlProxySetupResult> {
    try {
      const [installed, enabled] = await perf.track("recheckStatus", async () => {
        return Promise.all([this.isInstalled(), this.isEnabled()]);
      });
      if (installed && enabled) {
        perf.end();
        return {
          success: true,
          message: "Accessibility Service was already installed and has been activated",
          perfTiming: perf.getTimings(),
        };
      }
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to re-check service status: ${error}`);
      const errorMsg = errorMessage(error);
      const { message, category } = classifySetupError(errorMsg, this.device.deviceId);
      perf.end();
      return {
        success: false,
        message,
        error: errorMsg,
        cause: error,
        category,
        perfTiming: perf.getTimings(),
      };
    }
    perf.end();
    return {
      success: false,
      message: "Setup already attempted",
      perfTiming: perf.getTimings(),
    };
  }

  private alreadyActiveSetupResult(
    force: boolean,
    isAlreadyInstalled: boolean,
    isAlreadyEnabled: boolean,
    perf: PerformanceTracker,
  ): CtrlProxySetupResult | null {
    if (!force && isAlreadyInstalled && isAlreadyEnabled) {
      perf.end();
      return {
        success: true,
        message: "Accessibility Service was already installed and has been activated",
        perfTiming: perf.getTimings(),
      };
    }

    return null;
  }

  /**
   * Complete setup process for Accessibility Service
   */
  async setup(
    force: boolean = false,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<CtrlProxySetupResult> {
    if (this.attemptedAutomatedSetup) {
      return this.recheckSetup(perf);
    }
    await this.assertNotDrivenByOtherDaemon();
    return this.foreignForwardGuardContext.run(true, () =>
      this.setupAfterForeignForwardGuard(force, perf),
    );
  }

  private async setupAfterForeignForwardGuard(
    force: boolean,
    perf: PerformanceTracker,
  ): Promise<CtrlProxySetupResult> {
    perf.serial("a11yServiceSetup");
    let apkPath: string | null = null;

    try {
      const compatibilityResult = await perf.track("ensureCompatibleVersion", () =>
        this.ensureCompatibleVersion(),
      );
      const completed = this.compatibility.setupCompatibilityResult(compatibilityResult, perf);
      if (completed) {
        return completed;
      }

      // Check if already installed and setup (unless force is true)
      const isAlreadyInstalled = await perf.track("checkInstalled", () => this.isInstalled());
      const isAlreadyEnabled = await perf.track("checkEnabled", () => this.isEnabled());
      const activated = this.alreadyActiveSetupResult(
        force,
        isAlreadyInstalled,
        isAlreadyEnabled,
        perf,
      );
      if (activated) {
        return activated;
      }

      this.attemptedAutomatedSetup = true;
      // Download APK if not installed or force is true
      if (force || !isAlreadyInstalled) {
        apkPath = await perf.track("downloadApk", () => this.downloadApk());
        await this.foreignForwardGuardContext.run(false, () => this.assertNotDrivenByOtherDaemon());
        await perf.track("installApk", () => this.install(apkPath!));
      }

      // Enable if not enabled
      if (!isAlreadyEnabled) {
        await perf.track("enableService", () => this.enable());
      }

      perf.end();
      return {
        success: true,
        message: "Accessibility Service installed and activated successfully",
        perfTiming: perf.getTimings(),
      };
    } catch (error) {
      if (
        error instanceof DeviceOwnedByOtherDaemonError ||
        error instanceof CtrlProxyForwardOwnershipUnreadableError
      ) {
        throw error;
      }
      logger.warn(`[CTRL_PROXY] Setup failed: ${errorMessage(error)}`, error);
      const errorMsg = errorMessage(error);
      const { message, category } = classifySetupError(errorMsg, this.device.deviceId);

      perf.end();
      return {
        success: false,
        message,
        error: errorMsg,
        cause: error,
        category,
        perfTiming: perf.getTimings(),
      };
    } finally {
      // Clean up APK file if it was downloaded
      if (apkPath) {
        await this.cleanupApk(apkPath);
      }
    }
  }

  private async getApiLevel(): Promise<[number | null, boolean]> {
    return this.accessibility.getApiLevel();
  }

  /**
   * Check if the device supports programmatic accessibility toggle via settings commands
   * @returns Promise<boolean> - True if settings-based toggle is supported
   */
  async canUseSettingsToggle(): Promise<boolean> {
    return this.accessibility.canUseSettingsToggle();
  }

  /**
   * Get detailed capabilities for accessibility service toggling
   * @returns Promise<ToggleCapabilities> - Capability information including device type and reason if unavailable
   */
  async getToggleCapabilities(): Promise<ToggleCapabilities> {
    return this.accessibility.getToggleCapabilities();
  }

  /** Installed-APK digest plus where it was read from; public for diagnostics and tests. */
  async getInstalledApkSha256WithDetails(signal?: AbortSignal): Promise<InstalledApkSha256Result> {
    return this.apkInstaller.getInstalledApkSha256WithDetails(signal);
  }

  public async getExpectedChecksum(useSharedCache = true): Promise<string> {
    if (this.shouldSkipChecksum()) {
      return "";
    }
    if (AndroidCtrlProxyManager.expectedChecksumOverride !== null) {
      return AndroidCtrlProxyManager.expectedChecksumOverride;
    }

    const overridePath = this.getApkPathOverride();
    if (!overridePath) {
      return resolveApkChecksum();
    }

    let entry: ApkOverrideChecksumEntry | undefined;
    try {
      if (!useSharedCache) {
        return (
          await this.checksumCalculator.computeFileSha256(overridePath)
        ).checksum.toLowerCase();
      }
      const { mtimeMs, size } = await fs.stat(overridePath);
      entry = AndroidCtrlProxyManager.apkOverrideChecksums.get(overridePath);
      if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) {
        const checksumPromise = this.checksumCalculator
          .computeFileSha256(overridePath)
          .then(({ checksum }) => checksum.toLowerCase());
        entry = { mtimeMs, size, checksumPromise };
        AndroidCtrlProxyManager.apkOverrideChecksums.set(overridePath, entry);
      }
      return await entry.checksumPromise;
    } catch (error) {
      if (
        useSharedCache &&
        entry === AndroidCtrlProxyManager.apkOverrideChecksums.get(overridePath)
      ) {
        AndroidCtrlProxyManager.apkOverrideChecksums.delete(overridePath);
      }
      logger.warn("[CTRL_PROXY] Unable to hash local APK override; skipping checksum comparison", {
        path: overridePath,
        error: errorMessage(error),
      });
      return "";
    }
  }

  /**
   * Fail closed when a concrete `AUTOMOBILE_VERSION` is pinned to a version absent
   * from the baked checksum registry: the APK cannot be integrity-verified, so
   * silently downloading it — or accepting an already-installed APK of unknown
   * provenance — defeats the point of pinning (#2746). `AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM`
   * (or a local APK path override) is the explicit escape hatch.
   */
  private assertPinnedVersionVerifiable(): void {
    if (AndroidCtrlProxyManager.isPinnedVersionUnverifiable()) {
      throw new ActionableError(
        `AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the AutoMobile release ` +
          `checksum registry, so the CtrlProxy APK cannot be integrity-verified. ` +
          `Pin a released version, or set AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1 to override.`,
      );
    }
  }

  private clearServiceAvailabilityCache(): void {
    this.accessibility.clearStatusCache();
    // Issue #4192: the detector answers "is accessibility available on this device"
    // from its own cache, so it goes stale for exactly the same reasons these fields
    // do. Invalidating here keeps the two views from diverging silently.
    this.getAccessibilityDetector().invalidateCache(this.device.deviceId);
  }

  private queueBackgroundApkRefresh(): void {
    if (this.fileDownloader !== AndroidCtrlProxyManager.defaultFileDownloader) {
      return;
    }
    void AndroidCtrlProxyManager.prefetchApk();
  }

  private getApkPathOverride(): string | null {
    const override = readEnvRaw(ENV.CTRL_PROXY_APK_PATH);
    if (!override) {
      return null;
    }
    const trimmed = override.trim();
    return trimmed.length > 0 ? resolvePathFromDaemonLaunchWorkingDirectory(trimmed) : null;
  }

  private shouldSkipChecksum(): boolean {
    // @deprecated AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK - use AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM instead
    return readEnvBool(ENV.SKIP_ACCESSIBILITY_CHECKSUM);
  }

  /**
   * Env-only view of the checksum-skip and local APK pin escape hatches,
   * usable from the static prefetch path (which has no instance).
   */
  private static isChecksumSkipConfigured(): boolean {
    // @deprecated AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK - use AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM instead
    if (readEnvBool(ENV.SKIP_ACCESSIBILITY_CHECKSUM)) {
      return true;
    }
    const apkPathOverride = readEnvRaw(ENV.CTRL_PROXY_APK_PATH)?.trim();
    return Boolean(apkPathOverride && apkPathOverride.length > 0);
  }

  /**
   * Single source of truth for the fail-closed decision: `AUTOMOBILE_VERSION` names
   * a concrete version absent from the checksum registry, with no escape hatch set,
   * so the APK cannot be integrity-verified (#2746). Consumed by the download/readiness
   * guards, the startup prefetch, `doctor`, and the booted-device compatibility check
   * so they can't drift apart.
   */
  static isPinnedVersionUnverifiable(): boolean {
    if (AndroidCtrlProxyManager.expectedChecksumOverride !== null) {
      return false;
    }
    if (AndroidCtrlProxyManager.isChecksumSkipConfigured()) {
      return false;
    }
    return isExplicitPin() && !isPinnedVersionKnown();
  }

  private static isKnownExplicitPinConfigured(): boolean {
    if (AndroidCtrlProxyManager.isChecksumSkipConfigured()) {
      return false;
    }
    return isExplicitPin() && isPinnedVersionKnown();
  }

  private static isKnownPinUnverified(status: CtrlProxyCompatibilityInspection["status"]): boolean {
    return (
      (status === "mismatch" || status === "unverifiable") &&
      AndroidCtrlProxyManager.isKnownExplicitPinConfigured()
    );
  }

  private static createKnownPinMismatchError(
    expectedSha: string,
    installedSha: string | null | undefined,
  ): ActionableError {
    return new ActionableError(
      `Installed CtrlProxy APK SHA differs from expected release checksum for ` +
        `AUTOMOBILE_VERSION=${resolvePinnedVersion()}. Expected: ${expectedSha}, Got: ${installedSha ?? "unknown"}. ` +
        `Install the pinned CtrlProxy APK, restart with a matching daemon, or set ` +
        `AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1 to override.`,
    );
  }

  private shouldSkipDownloadIfInstalled(): boolean {
    return readEnvBool(ENV.SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED);
  }
}

registerDeviceIncarnationListener({
  name: "ctrlproxy-manager",
  onDeviceIncarnationChanged: (deviceId) =>
    AndroidCtrlProxyManager.invalidateForDeviceIncarnation(deviceId),
});
