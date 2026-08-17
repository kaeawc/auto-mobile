import { ActionableError, BootedDevice, Platform, SomePlatform } from "../models";
import { MultiPlatformDeviceManager, waitForDeviceReadyOrCancel } from "./deviceUtils";
import { AdbClientFactory, defaultAdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";
import { Window as WindowImpl } from "../features/observe/Window";
import type { Window } from "../features/observe/interfaces/Window";
import { logger } from "./logger";
import { AndroidCtrlProxyManager, CtrlProxyManager } from "./CtrlProxyManager";
import { IOSCtrlProxyManager, CtrlProxyIosManager } from "./IOSCtrlProxyManager";
import { AndroidEmulatorClient } from "./android-cmdline-tools/AndroidEmulatorClient";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { PlatformDeviceManager } from "./interfaces/DeviceUtils";
import { getDeviceCreationGate } from "./deviceCreationGate";
import { createDefaultDeviceProvisioner } from "./deviceProvisioning";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import type { AndroidCtrlProxy } from "../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import type { IOSCtrlProxy } from "../features/observe/ios/IOSCtrlProxyClient";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { ObserveScreenCache } from "../features/observe/interfaces/ObserveScreenCache";
import { createPerformanceTracker, createGlobalPerformanceTracker } from "./PerformanceTracker";
import { storeSetupTiming } from "../server/ToolExecutionContext";
import { applyAppearanceOnConnect } from "./appearance/applyAppearanceOnConnect";
import { disableStylusHandwriting } from "./disableStylusHandwriting";
import { checkIosCtrlProxyOverride } from "./iosCtrlProxyOverride";
import { RunnerReadinessService } from "./RunnerReadinessService";
import { DEFAULT_RUNNER_READINESS_TIMEOUT_MS } from "./runnerReadinessConfig";
import { defaultTimer, type Timer } from "./SystemTimer";

/**
 * Render a device list for a "not found" error.
 *
 * These messages exist to tell the caller which identifier to use instead, so
 * they must print the identifiers rather than the objects: `BootedDevice[].join()`
 * stringifies each element to "[object Object]" and destroys the only actionable
 * part of the message (#4227).
 *
 * Both identifiers are shown because callers reason in either — a user reads
 * "Pixel_9_Pro" in a device picker but must pass the id. Android currently sets
 * `name === deviceId` (AdbClient.getBootedAndroidDevices), so the redundant
 * "x (x)" form is collapsed to a single value.
 */
function describeDevices(devices: BootedDevice[]): string {
  return devices
    .map(device => (device.name && device.name !== device.deviceId
      ? `${device.name} (${device.deviceId})`
      : device.deviceId))
    .join(", ") || "none";
}

/**
 * Provider interface for device clients - enables dependency injection for testing
 */
export interface DeviceClientProvider {
  getAdb(): AdbExecutor;
  getSimctl(): SimCtlClient | undefined;
  getAndroidEmulator(): AndroidEmulatorClient | undefined;
  getDeviceUtils(): PlatformDeviceManager;
  getAndroidCtrlProxyManager(device: BootedDevice): CtrlProxyManager;
  getAndroidCtrlProxyClient(device: BootedDevice): AndroidCtrlProxy;
  getIOSCtrlProxyManager(device: BootedDevice): CtrlProxyIosManager;
  getIOSCtrlProxyClient(device: BootedDevice, port: number): IOSCtrlProxy;
  getWindow(device: BootedDevice): Window;
  getObserveScreenCache(): ObserveScreenCache;
}

/**
 * Default provider that lazily creates real clients
 */
class DefaultDeviceClientProvider implements DeviceClientProvider {
  private _adb: AdbExecutor | undefined;
  private _adbFactory: AdbClientFactory;
  private _simctl: SimCtlClient | undefined;
  private _androidEmulator: AndroidEmulatorClient | undefined;
  private _deviceUtils: PlatformDeviceManager | undefined;
  // Keyed by device.deviceId so Window's internal active-window cache survives
  // across calls instead of being thrown away on every resolve.
  private readonly _windows: Map<string, Window> = new Map();

  constructor(adbFactory: AdbClientFactory = defaultAdbClientFactory) {
    this._adbFactory = adbFactory;
  }

  getAdb(): AdbExecutor {
    if (!this._adb) {
      this._adb = this._adbFactory.create(null);
    }
    return this._adb;
  }

  getSimctl(): SimCtlClient | undefined {
    if (!this._simctl) {
      this._simctl = new SimCtlClient(null);
    }
    return this._simctl;
  }

  getAndroidEmulator(): AndroidEmulatorClient | undefined {
    if (!this._androidEmulator) {
      this._androidEmulator = new AndroidEmulatorClient();
    }
    return this._androidEmulator;
  }

  getDeviceUtils(): PlatformDeviceManager {
    if (!this._deviceUtils) {
      this._deviceUtils = new MultiPlatformDeviceManager(
        this.getAdb(),
        this.getSimctl()!,
        this.getAndroidEmulator()!
      );
    }
    return this._deviceUtils;
  }

  getAndroidCtrlProxyManager(device: BootedDevice): CtrlProxyManager {
    return AndroidCtrlProxyManager.getInstance(device);
  }

  getAndroidCtrlProxyClient(device: BootedDevice): AndroidCtrlProxy {
    return AndroidCtrlProxyClient.getInstance(device);
  }

  getIOSCtrlProxyManager(device: BootedDevice): CtrlProxyIosManager {
    return IOSCtrlProxyManager.getInstance(device);
  }

  getIOSCtrlProxyClient(device: BootedDevice, port: number): IOSCtrlProxy {
    return IOSCtrlProxyClient.getInstance(device, port);
  }

  getWindow(device: BootedDevice): Window {
    const key = device.deviceId;
    let window = this._windows.get(key);
    if (!window) {
      window = new WindowImpl(device, this._adbFactory);
      this._windows.set(key, window);
    }
    return window;
  }

  getObserveScreenCache(): ObserveScreenCache {
    return RealObserveScreen.defaultObserveScreenCache;
  }
}

/**
 * Interface for device session management
 * Handles device detection, verification, and lifecycle for Android and iOS platforms
 */
export interface DeviceSessionManager {
  /**
   * Get the current device ID
   */
  getCurrentDevice(): BootedDevice | undefined;

  /**
   * Get the current platform
   */
  getCurrentPlatform(): Platform | undefined;

  /**
   * Set the current device ID and platform
   */
  setCurrentDevice(device: BootedDevice, platform: Platform): void;

  /**
   * Ensure a device is ready for the specified platform and return its ID
   * Throws an error if both Android and iOS devices are connected when auto-detecting platform
   */
  ensureDeviceReady(platform: SomePlatform, providedDeviceId?: string, options?: DeviceReadyOptions): Promise<BootedDevice>;

  /**
   * Detect the platform of connected devices
   */
  detectConnectedPlatforms(): Promise<BootedDevice[]>;

  /**
   * Verify a specific device is connected and ready for the given platform
   */
  verifyDevice(deviceId: string, platform: Platform, options?: DeviceReadyOptions): Promise<void>;

  /**
   * Verify an Android device is connected and ready
   */
  verifyAndroidDevice(deviceId: string, options?: DeviceReadyOptions): Promise<void>;

  /**
   * Verify an iOS device is connected and ready
   */
  verifyIosDevice(deviceId: string, options?: DeviceReadyOptions): Promise<void>;

  /**
   * Find an available device or start an emulator for the specified platform
   */
  findOrStartDevice(platform: Platform, options?: DeviceReadyOptions): Promise<BootedDevice>;

  /**
   * Find an available Android device or start an emulator
   */
  findOrStartAndroidDevice(options?: DeviceReadyOptions): Promise<BootedDevice>;

  /**
   * Find an available iOS device or start a simulator
   */
  findOrStartIosDevice(options?: DeviceReadyOptions): Promise<BootedDevice>;
}

export interface DeviceReadyOptions {
  skipCtrlProxyDownload?: boolean;
  /**
   * @deprecated Use skipCtrlProxyDownload instead.
   */
  skipAccessibilityDownload?: boolean;
  /**
   * @deprecated Use skipCtrlProxyDownload instead.
   */
  skipAccessibilitySetup?: boolean;
}

export interface DeviceSessionManagerOptions {
  runnerReadinessTimer?: Timer;
  runnerReadinessTimeoutMs?: number;
}

export class DeviceSessionManager implements DeviceSessionManager {
  private currentDevice: BootedDevice | undefined;
  private currentPlatform: Platform | undefined;
  private static instance: DeviceSessionManager;
  private static defaultProvider: DeviceClientProvider | undefined;
  private readonly provider: DeviceClientProvider;
  private readonly adbFactory: AdbClientFactory;
  private readonly runnerReadinessService: RunnerReadinessService;
  private readonly runnerReadinessTimer: Timer;
  private readonly runnerReadinessTimeoutMs: number;
  private _adb: AdbExecutor | undefined;
  private simulatorAppOpened = false;

  // Track devices that have push update listeners registered
  private static pushUpdateListenersRegistered: Set<string> = new Set();

  private constructor(
    provider: DeviceClientProvider,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    options: DeviceSessionManagerOptions = {},
  ) {
    this.provider = provider;
    this.adbFactory = adbFactory;
    this.runnerReadinessTimer = options.runnerReadinessTimer ?? defaultTimer;
    this.runnerReadinessTimeoutMs =
      options.runnerReadinessTimeoutMs ?? DEFAULT_RUNNER_READINESS_TIMEOUT_MS;
    this.runnerReadinessService = new RunnerReadinessService({
      timer: this.runnerReadinessTimer,
      getAndroidManager: (device) => this.provider.getAndroidCtrlProxyManager(device),
      getAndroidClient: (device) => this.provider.getAndroidCtrlProxyClient(device),
      getIosManager: (device) => this.provider.getIOSCtrlProxyManager(device),
      getIosClient: (device, port) => this.provider.getIOSCtrlProxyClient(device, port),
      checkIosOverride: checkIosCtrlProxyOverride,
      awaitIosStartupMaintenance: () => IOSCtrlProxyManager.awaitStartupOrphanRunnerReap(),
    });
  }

  private get adb(): AdbExecutor {
    if (!this._adb) {
      this._adb = this.provider.getAdb();
    }
    return this._adb;
  }

  private get simctl(): SimCtlClient | undefined {
    return this.provider.getSimctl();
  }

  private get androidEmulator(): AndroidEmulatorClient | undefined {
    return this.provider.getAndroidEmulator();
  }

  private get deviceUtils(): PlatformDeviceManager {
    return this.provider.getDeviceUtils();
  }

  public static getInstance(): DeviceSessionManager {
    if (!DeviceSessionManager.instance) {
      if (!DeviceSessionManager.defaultProvider) {
        DeviceSessionManager.defaultProvider = new DefaultDeviceClientProvider();
      }
      DeviceSessionManager.instance = new DeviceSessionManager(DeviceSessionManager.defaultProvider);
    }
    return DeviceSessionManager.instance;
  }

  public static createInstance(
    provider: DeviceClientProvider,
    adbFactory?: AdbClientFactory,
    options?: DeviceSessionManagerOptions,
  ): DeviceSessionManager {
    return new DeviceSessionManager(provider, adbFactory, options);
  }

  /**
   * Get the current device ID
   */
  public getCurrentDevice(): BootedDevice | undefined {
    return this.currentDevice;
  }

  /**
   * Get the current platform
   */
  public getCurrentPlatform(): Platform | undefined {
    return this.currentPlatform;
  }

  /**
   * Set the current device ID and platform
   */
  public setCurrentDevice(device: BootedDevice, platform: Platform): void {
    this.currentDevice = device;
    this.currentPlatform = platform;

    if (platform === "android") {
      // Update AdbClient with new device ID - need a fresh client for the new device
      this._adb = this.adbFactory.create(device);
    }
  }

  /**
   * Detect the platform of connected devices
   */
  public async detectConnectedPlatforms(): Promise<BootedDevice[]> {
    const devices: BootedDevice[] = [];
    const perf = createGlobalPerformanceTracker();

    try {
      // Check for Android devices via ADB
      perf.startOperation("androidDeviceScan");
      const androidDevices = await this.adb.getBootedAndroidDevices();
      perf.endOperation("androidDeviceScan");
      devices.push(...androidDevices);
    } catch (error) {
      perf.endOperation("androidDeviceScan");
      logger.warn(`Failed to detect Android devices: ${error}`);
    }

    try {
      // Check for iOS devices/simulators via xcrun simctl
      if (this.simctl) {
        perf.startOperation("iosSimulatorScan");
        const iosDevices = await this.simctl.getBootedSimulators();
        perf.endOperation("iosSimulatorScan");
        devices.push(...iosDevices);
      }
    } catch (error) {
      perf.endOperation("iosSimulatorScan");
      logger.warn(`Failed to detect iOS devices: ${error}`);
    }

    return devices;
  }

  /**
   * Ensure a device is ready for the specified platform and return its ID
   * Throws an error if both Android and iOS devices are connected when auto-detecting platform
   */
  public async ensureDeviceReady(
    platform: SomePlatform,
    providedDeviceId?: string,
    options?: DeviceReadyOptions
  ): Promise<BootedDevice> {
    logger.info(`[DeviceSessionManager] ensureDeviceReady called with platform=${platform}, providedDeviceId=${providedDeviceId}`);

    // Detect all connected devices
    const connectedPlatforms = await this.detectConnectedPlatforms();
    logger.info(`Found ${connectedPlatforms.length} connectedPlatform devices`);
    const androidDevices = connectedPlatforms.filter(device => device.platform === "android");
    logger.info(`Found ${androidDevices.length} android devices`);
    const iosDevices = connectedPlatforms.filter(device => device.platform === "ios");
    logger.info(`Found ${iosDevices.length} ios devices`);

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
          // If setActiveDevice was called, use that platform to resolve ambiguity
          if (this.currentDevice && this.currentPlatform) {
            platformDevices = this.currentPlatform === "android" ? androidDevices : iosDevices;
            resolvedPlatform = this.currentPlatform;
            break;
          }
          // If a specific deviceId was provided, find which platform it belongs to
          if (providedDeviceId) {
            const allDevices = [...androidDevices, ...iosDevices];
            const match = allDevices.find(d => d.deviceId === providedDeviceId);
            if (match) {
              platformDevices = match.platform === "android" ? androidDevices : iosDevices;
              resolvedPlatform = match.platform;
              break;
            }
          }
          throw new ActionableError(
            "Both Android and iOS devices are connected. Please disconnect devices from one platform or call setActiveDevice to select a platform."
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

    let selectedDevice: BootedDevice | undefined;
    let deviceVerified = false;
    let deviceSource: "provided" | "current" | "auto" = "auto";

    // If a specific device is provided, verify it exists on the correct platform
    if (providedDeviceId) {
      const providedDevice = platformDevices.find(device => device.deviceId === providedDeviceId);
      if (!providedDevice) {
        throw new ActionableError(
          `Device ${providedDeviceId} not found on ${platform} platform. ` +
          `Available ${platform} devices: ${describeDevices(platformDevices)}`
        );
      }
      selectedDevice = providedDevice;
      deviceSource = "provided";
    }

    // If we have a current device for the requested platform, verify it's still ready
    if (!selectedDevice && this.currentDevice && (this.currentPlatform === platform || this.currentPlatform === resolvedPlatform)) {
      logger.info(`[DeviceSessionManager] Found current device: ${this.currentDevice.deviceId}, verifying readiness`);
      try {
        // Use resolvedPlatform (always "android" | "ios") instead of platform (which may be "either")
        // to ensure verifyDevice dispatches to the correct platform-specific verification
        await this.verifyDevice(this.currentDevice.deviceId, resolvedPlatform, options);
        selectedDevice = this.currentDevice;
        deviceVerified = true;
        deviceSource = "current";
      } catch (error) {
        logger.warn(`Current device ${this.currentDevice} is no longer ready: ${error}`);
        this.currentDevice = undefined;
        this.currentPlatform = undefined;
      }
    }

    // No device set - find or start one for the requested platform
    if (!selectedDevice) {
      logger.info(`[DeviceSessionManager] No current device, finding or starting device for platform ${resolvedPlatform}`);
      selectedDevice = await this.findOrStartDevice(resolvedPlatform, options);
      deviceVerified = true;
      deviceSource = "auto";
    }

    if (!deviceVerified) {
      await this.verifyDevice(selectedDevice.deviceId, resolvedPlatform, options);
    }

    // Safety check: ensure the selected device's platform matches the resolved platform.
    // This guards against cross-platform contamination where an iOS device could be
    // returned when Android was explicitly requested (or vice versa).
    if (selectedDevice.platform !== resolvedPlatform) {
      logger.warn(
        `[DeviceSessionManager] Platform mismatch: selected device ${selectedDevice.deviceId} ` +
        `has platform '${selectedDevice.platform}' but resolved platform is '${resolvedPlatform}'. ` +
        `Discarding and finding correct platform device.`
      );
      selectedDevice = await this.findOrStartDevice(resolvedPlatform, options);
    }

    this.setCurrentDevice(selectedDevice, resolvedPlatform);
    if (deviceSource !== "current") {
      await applyAppearanceOnConnect(selectedDevice);
      await disableStylusHandwriting(selectedDevice, this.adbFactory);
    }
    logger.info(`[DeviceSessionManager] Using ${deviceSource} device: ${selectedDevice.deviceId}`);
    return selectedDevice;
  }

  /**
   * Verify a specific device is connected and ready for the given platform
   */
  public async verifyDevice(deviceId: string, platform: Platform, options?: DeviceReadyOptions): Promise<void> {
    if (platform === "android") {
      await this.verifyAndroidDevice(deviceId, options);
    } else {
      await this.verifyIosDevice(deviceId, options);
    }
  }

  /**
   * Verify an Android device is connected and ready
   */
  public async verifyAndroidDevice(deviceId: string, options?: DeviceReadyOptions): Promise<void> {
    const allDevices = await this.adb.getBootedAndroidDevices();
    const device = allDevices.find(device => device.deviceId === deviceId);

    if (!device) {
      throw new ActionableError(
        `Android device ${deviceId} is not connected. Available devices: ${describeDevices(allDevices)}`
      );
    }

    // Check if we can get an active window from the device
    try {
      logger.info(`[DeviceSessionManager] Verifying Android device ${deviceId} readiness`);

      const window = this.provider.getWindow(device);

      let activeWindow = await window.getActive();
      if (!activeWindow || !activeWindow.appId || !activeWindow.activityName) {
        activeWindow = await window.getActive(true);
        if (!activeWindow || !activeWindow.appId || !activeWindow.activityName) {
          logger.warn(`[DeviceSessionManager] Android device ${deviceId} is not fully ready`);
          if (activeWindow) {
            logger.warn(`[DeviceSessionManager] activeWindow.appId: ${activeWindow.appId} | activeWindow.activityName: ${activeWindow.activityName}`);
          } else {
            logger.warn(`[DeviceSessionManager] activeWindow: ${activeWindow}`);
          }
          throw new ActionableError(
            `Cannot get active window information from Android device ${deviceId}. The device may not be fully booted or is in an unusual state.`
          );
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new ActionableError(
        `Failed to verify Android device ${deviceId} readiness: ${errorMessage}`
      );
    }

    // Always track setup timing (one-time per session, valuable for debugging)
    const perf = createPerformanceTracker(true);
    perf.serial("ensureAccessibilityService");
    let didSetup = false;

    try {
      const skipCtrlProxyDownload = options?.skipCtrlProxyDownload ?? options?.skipAccessibilityDownload ?? options?.skipAccessibilitySetup;
      if (options?.skipAccessibilitySetup !== undefined) {
        if (options?.skipAccessibilityDownload !== undefined) { logger.warn("[DeviceSessionManager] skipAccessibilityDownload is deprecated; use skipCtrlProxyDownload instead."); } else { logger.warn("[DeviceSessionManager] skipAccessibilitySetup is deprecated; use skipCtrlProxyDownload instead."); }
      }

      const accessibilityClient = this.provider.getAndroidCtrlProxyClient(device);
      if (accessibilityClient.isConnected()) {
        // WebSocket appears connected, but verify service is actually responsive
        // This catches cases where service crashed but socket wasn't properly closed
        logger.info(`[DeviceSessionManager] WebSocket connected for ${deviceId}, verifying service is responsive`);
        const isReady = await perf.track("verifyConnectedService", () =>
          accessibilityClient.verifyServiceReady(2, 200, 2000)
        );
        if (isReady) {
          logger.info(`[DeviceSessionManager] Accessibility service verified responsive for ${deviceId}`);
          perf.end();
          return;
        }
        // Service not responsive despite connected socket - fall through to normal flow
        logger.warn(`[DeviceSessionManager] WebSocket connected but service not responsive for ${deviceId}, checking status`);
      }

      const manager = this.provider.getAndroidCtrlProxyManager(device);
      const verifyCompatibilityWhenSkipping = async (): Promise<void> => {
        const isCompatible = await manager.isVersionCompatible();
        if (isCompatible) {
          logger.info(`[DeviceSessionManager] Accessibility service version compatible for ${deviceId}`);
          return;
        }
        const errorMessage = "Accessibility service version mismatch detected. Run without skipCtrlProxyDownload to install a compatible version.";
        logger.warn(`[DeviceSessionManager] ${errorMessage} Device: ${deviceId}`);
        throw new ActionableError(errorMessage);
      };

      const [isInstalled, isEnabled] = await perf.track("checkStatus", () => Promise.all([
        manager.isInstalled(),
        manager.isEnabled()
      ]));

      let needsSetup = false;

      if (isInstalled && isEnabled) {
        logger.info(`[DeviceSessionManager] Accessibility service already enabled for ${deviceId}, verifying WebSocket connection`);
        // Verify the service is actually working by checking WebSocket connection
        const connected = await perf.track("verifyConnection", () => accessibilityClient.waitForConnection(3, 200));
        if (connected) {
          if (skipCtrlProxyDownload) {
            await verifyCompatibilityWhenSkipping();
            return;
          }
          logger.info(`[DeviceSessionManager] Accessibility service enabled and connected for ${deviceId}, verifying version compatibility`);
        } else {
          // Service claims to be installed but WebSocket won't connect - cache is stale
          logger.warn(`[DeviceSessionManager] Accessibility service cache stale for ${deviceId} - marked as installed/enabled but WebSocket failed. Resetting setup state and forcing reinstall.`);
          manager.resetSetupState();
          needsSetup = true;
        }
      }

      if (!isInstalled && skipCtrlProxyDownload) {
        logger.info(`[DeviceSessionManager] Accessibility service not installed for ${deviceId}, skipping download/install`);
        return;
      }

      if (isInstalled && !isEnabled && !needsSetup) {
        logger.info(`[DeviceSessionManager] Accessibility service installed but not enabled for ${deviceId}, enabling now`);
        try {
          await perf.track("enableService", () => manager.enable());
          didSetup = true;
          // Wait for WebSocket to be ready after enabling
          logger.info(`[DeviceSessionManager] Waiting for accessibility WebSocket connection for ${deviceId}`);
          const enableConnected = await perf.track("waitForConnection", () => accessibilityClient.waitForConnection());
          if (!enableConnected) {
            logger.warn(`[DeviceSessionManager] WebSocket connection failed after enabling for ${deviceId}, will attempt full setup`);
            manager.resetSetupState();
            needsSetup = true;
          } else {
            if (skipCtrlProxyDownload) {
              await verifyCompatibilityWhenSkipping();
              return;
            }
            logger.info(`[DeviceSessionManager] Accessibility service enabled for ${deviceId}, verifying version compatibility`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(`[DeviceSessionManager] Failed to enable accessibility service: ${errorMessage}`);
          if (skipCtrlProxyDownload) {
            return;
          }
          needsSetup = true;
        }
      }

      if (skipCtrlProxyDownload && !needsSetup) {
        logger.info(`[DeviceSessionManager] Skipping accessibility service download/install for ${deviceId}`);
        return;
      }

      if (needsSetup || !isInstalled) {
        await manager.setup(false, perf);
        didSetup = true;
        // Wait for WebSocket to be ready after setup (install + enable)
        logger.info(`[DeviceSessionManager] Waiting for accessibility WebSocket connection after setup for ${deviceId}`);
        const connected = await perf.track("waitForConnection", () => accessibilityClient.waitForConnection());
        if (connected) {
          // Verify service is actually ready to respond (not just WebSocket connected)
          logger.info(`[DeviceSessionManager] Verifying accessibility service is responsive for ${deviceId}`);
          const ready = await perf.track("verifyServiceReady", () => accessibilityClient.verifyServiceReady(5, 500, 3000));
          if (!ready) {
            logger.warn(`[DeviceSessionManager] Accessibility service not responsive after setup for ${deviceId}, observe may fall back to UIAutomator`);
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[DeviceSessionManager] Failed to setup accessibility service: ${errorMessage}`);
      // Rethrow ActionableErrors to preserve their specific error messages
      if (error instanceof ActionableError) {
        throw error;
      }
    } finally {
      perf.end();
      // Store timing if we actually did setup work
      if (didSetup) {
        const timings = perf.getTimings();
        if (timings) {
          storeSetupTiming(deviceId, timings);
        }
      }
    }
  }

  /**
   * Verify an iOS device is connected and ready
   */
  public async verifyIosDevice(deviceId: string, options?: DeviceReadyOptions): Promise<void> {
    // An explicit runner override that cannot be used must fail closed before any
    // other path, whatever the simulator/runner state. Every downstream branch
    // (already-connected, already-running, cached-start) skips the builder that
    // would validate it, so otherwise a directory- or typo-valued
    // AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH would silently run the cached released
    // runner and the caller would attribute results to a local build that never
    // loaded (#4221).
    const iosOverride = await checkIosCtrlProxyOverride();
    if (iosOverride.present && !iosOverride.usable) {
      throw new ActionableError(
        `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH / _IPA_PATH is set but unusable: ${iosOverride.reason}`
      );
    }

    if (!this.simctl) {
      throw new ActionableError("iOS simulator tools not available");
    }
    const deviceInfo = await this.simctl.getDeviceInfo(deviceId);

    if (!deviceInfo) {
      throw new ActionableError(
        `iOS simulator ${deviceId} is not available. Please check if it exists and is available.`
      );
    }

    if (!deviceInfo.isAvailable) {
      throw new ActionableError(
        `iOS simulator ${deviceId} is not available (state: ${deviceInfo.state}). Please check simulator availability.`
      );
    }

    // If simulator is not booted, we could boot it, but for now we'll just check
    if (deviceInfo.state !== "Booted") {
      logger.info(`iOS simulator ${deviceId} is not booted (state: ${deviceInfo.state})`);
      // Note: We could auto-boot here if desired, but keeping consistent with current behavior
      return;
    }

    if (!this.simulatorAppOpened) {
      try {
        await this.simctl!.openSimulatorApp();
        this.simulatorAppOpened = true;
      } catch (err) {
        logger.warn(`[DeviceSessionManager] Failed to open Simulator.app: ${err}`);
      }
    }

    // Create a device object for the CtrlProxy iOS clients
    const device: BootedDevice = {
      deviceId,
      name: deviceInfo.name,
      platform: "ios"
    };

    // Pass the tracker through to CtrlProxy setup while keeping the legacy
    // session path subject to the same strict readiness contract as startDevice.
    const perf = createPerformanceTracker(true);
    perf.serial("ensureCtrlProxy iOS");
    let didSetup = false;

    try {
      const totalDeadlineMs =
        this.runnerReadinessTimer.now() + this.runnerReadinessTimeoutMs;
      await this.runnerReadinessService.ensureReady({
        device,
        requestedIdentity: `platform=ios deviceId=${deviceId}`,
        totalDeadlineMs,
        readinessTimeoutMs: this.runnerReadinessTimeoutMs,
        skipCtrlProxyDownload:
          options?.skipCtrlProxyDownload ??
          options?.skipAccessibilityDownload ??
          options?.skipAccessibilitySetup,
        perf,
        onRunnerSetup: () => {
          didSetup = true;
        },
      });
      this.registerPushUpdateListener(device);
    } finally {
      perf.end();
      if (didSetup) {
        const timings = perf.getTimings();
        if (timings) {
          storeSetupTiming(deviceId, timings);
        }
      }
    }
  }

  /**
   * Find an available device or start an emulator for the specified platform
   */
  public async findOrStartDevice(platform: Platform, options?: DeviceReadyOptions): Promise<BootedDevice> {
    if (platform === "android") {
      return await this.findOrStartAndroidDevice(options);
    } else {
      return await this.findOrStartIosDevice(options);
    }
  }

  /**
   * Find an available Android device or start an emulator
   */
  public async findOrStartAndroidDevice(options?: DeviceReadyOptions): Promise<BootedDevice> {
    const perf = createGlobalPerformanceTracker();

    perf.startOperation("listBootedDevices");
    const allDevices = await this.deviceUtils.getBootedDevices("android");
    perf.endOperation("listBootedDevices");

    if (allDevices.length > 0) {
      // Use the first available device
      const device = allDevices[0];
      const deviceId = device.deviceId!;
      perf.startOperation("verifyDevice");
      await this.verifyAndroidDevice(deviceId, options);
      perf.endOperation("verifyDevice");
      return device;
    }

    // No devices - try to start a device from an image
    perf.startOperation("listImages");
    const availableImages = await this.deviceUtils.listDeviceImages("android");
    perf.endOperation("listImages");

    if (availableImages.length === 0) {
      throw new ActionableError(
        "No devices are connected and no device images are available. Please connect a physical device or create a device image first."
      );
    }

    // Start the first available AVD
    const deviceImage = availableImages[0];
    logger.info(`Starting Android emulator ${deviceImage}...`);
    perf.startOperation("startDevice");
    const childProcess = await this.deviceUtils.startDevice(deviceImage);
    perf.endOperation("startDevice");

    // Wait for the emulator to fully boot and get its device ID. Cancel the boot
    // (shut the half-booted emulator back down) if readiness fails (issue #3952).
    perf.startOperation("waitForReady");
    const newDevice = await waitForDeviceReadyOrCancel(this.deviceUtils, deviceImage, childProcess);
    perf.endOperation("waitForReady");

    if (!newDevice) {
      throw new ActionableError(
        `Failed to start Android emulator ${deviceImage}.`
      );
    }

    perf.startOperation("verifyDevice");
    await this.verifyAndroidDevice(newDevice.deviceId!, options);
    perf.endOperation("verifyDevice");
    return newDevice;
  }

  /**
   * Find an available iOS device or start a simulator
   */
  public async findOrStartIosDevice(options?: DeviceReadyOptions): Promise<BootedDevice> {
    if (!this.simctl) {
      throw new ActionableError("iOS simulator tools not available");
    }
    const perf = createGlobalPerformanceTracker();

    perf.startOperation("listSimulators");
    const allDevices = await this.simctl.listSimulatorImages();
    perf.endOperation("listSimulators");
    allDevices.sort((a, b) => (a.deviceId || "").localeCompare(b.deviceId || ""));

    if (allDevices.length === 0) {
      // No CLI flag reaches this path, so the opt-in is env-var only here.
      const gate = getDeviceCreationGate();
      if (gate.isCreationAllowed()) {
        logger.info(
          `[DeviceSessionManager] No iOS simulators found; creating one (gate: ${gate.describeSource()})`
        );
        const provisioner = createDefaultDeviceProvisioner(() => this.simctl);
        const provisioned = await provisioner.provision({ platform: "ios" });
        perf.startOperation("bootSimulator");
        const createdDevice = await this.simctl.bootSimulator(provisioned.deviceId!);
        perf.endOperation("bootSimulator");
        perf.startOperation("verifyDevice");
        await this.verifyIosDevice(provisioned.deviceId!, options);
        perf.endOperation("verifyDevice");
        return createdDevice;
      }

      throw new ActionableError(
        "No iOS simulators are available. Please create an iOS simulator using Xcode or the Simulator app."
      );
    }

    // Check for already booted simulators first
    perf.startOperation("checkBooted");
    const bootedDevices = await this.simctl.getBootedSimulators();
    perf.endOperation("checkBooted");
    bootedDevices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));

    if (bootedDevices.length > 0) {
      // Use the first booted device
      const device = bootedDevices[0];
      logger.info(`[DeviceSessionManager] Selected booted iOS simulator ${device.name} (${device.deviceId})`);
      perf.startOperation("verifyDevice");
      await this.verifyIosDevice(device.deviceId!, options);
      perf.endOperation("verifyDevice");
      return device;
    }

    // No booted devices - boot the first available simulator
    const device = allDevices[0];
    const deviceId = device.deviceId!;
    logger.info(`[DeviceSessionManager] Booting iOS simulator ${device.name} (${deviceId})...`);

    perf.startOperation("bootSimulator");
    const bootedDevice = await this.simctl!.bootSimulator(deviceId);
    perf.endOperation("bootSimulator");
    perf.startOperation("verifyDevice");
    await this.verifyIosDevice(deviceId, options);
    perf.endOperation("verifyDevice");
    return bootedDevice;
  }

  /**
   * Register push update listener for an iOS device to clear ObserveScreen cache when UI changes.
   * This is called when CtrlProxy iOS is successfully connected.
   */
  private registerPushUpdateListener(device: BootedDevice): void {
    const deviceId = device.deviceId;
    if (DeviceSessionManager.pushUpdateListenersRegistered.has(deviceId)) {
      return; // Already registered
    }

    try {
      const manager = this.provider.getIOSCtrlProxyManager(device);
      const xcTestClient = this.provider.getIOSCtrlProxyClient(device, manager.getServicePort());

      const observeCache = this.provider.getObserveScreenCache();
      xcTestClient.onPushUpdate(() => {
        logger.info(`[DeviceSessionManager] Received iOS UI change notification for ${deviceId}, clearing ObserveScreen cache`);
        observeCache.clearForDevice(deviceId);
      });

      DeviceSessionManager.pushUpdateListenersRegistered.add(deviceId);
      logger.info(`[DeviceSessionManager] Registered push update listener for ${deviceId}`);
    } catch (error) {
      logger.warn(`[DeviceSessionManager] Failed to register push update listener for ${deviceId}: ${error}`);
    }
  }
}
