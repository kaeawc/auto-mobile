import { isDeviceIdentityQuarantinedError } from "../models/DeviceIdentityQuarantinedError";
import { daemonDeviceAdmissionGate, type DeviceAdmissionGate } from "../daemon/deviceAdmissionGate";
import {
  ambientDeviceExecutionBinding,
  type DeviceExecutionBinding,
} from "../server/deviceExecutionBinding";
import { errorMessage } from "../utils/describeUnknownError";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import {
  ActionableError,
  BootedDevice,
  DeviceInfo,
  Platform,
  SomePlatform,
  toActionableError,
} from "../models";
import {
  assertAndroidImageRunningStateKnown,
  MultiPlatformDeviceManager,
  waitForDeviceReadyOrCancel,
} from "./deviceUtils";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { isIosPhysicalUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import {
  getSharedDevicectlDeviceLister,
  type IosPhysicalDeviceLister,
} from "../utils/ios-cmdline-tools/DevicectlDeviceLister";
import { type DiscoverySource, discoverySourceFor } from "../utils/discoverySource";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { Window as WindowImpl } from "../features/observe/Window";
import type { Window } from "../features/observe/interfaces/Window";
import { logger } from "../utils/logger";
import { AndroidCtrlProxyManager, CtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager, CtrlProxyIosManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { AndroidEmulatorClient } from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { PlatformDeviceManager } from "../utils/interfaces/DeviceUtils";
import { getDeviceCreationGate } from "./deviceCreationGate";
import { createDefaultDeviceProvisioner } from "./deviceProvisioning";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import type { AndroidCtrlProxy } from "../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import type { IOSCtrlProxy } from "../features/observe/ios/IOSCtrlProxyClient";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { ObserveScreenCache } from "../features/observe/interfaces/ObserveScreenCache";
import {
  createPerformanceTracker,
  createGlobalPerformanceTracker,
} from "../utils/PerformanceTracker";
import { storeSetupTiming } from "../server/ToolExecutionContext";
import {
  applyAppearanceOnConnect,
  type AppearanceOnConnectDependencies,
} from "../server/applyAppearanceOnConnect";
import { resolveAppearanceSessionKey } from "../server/appearanceSessionKey";
import { disableStylusHandwriting } from "../utils/disableStylusHandwriting";
import { checkIosCtrlProxyOverride } from "../utils/iosCtrlProxyOverride";
import { RunnerReadinessError, RunnerReadinessService } from "../ctrlProxy/RunnerReadinessService";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { serverConfig } from "../utils/ServerConfig";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../utils/runnerReadinessConfig";
import { trackProcess, waitForExit } from "../utils/ChildProcessTracker";
import {
  getVirtualDeviceLifecycleCoordinator,
  type StableVirtualDeviceIdentity,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleIdentity,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";
import { runWithAbortSignal } from "../utils/AbortContext";
import { isEmulatorLaunchCancelledError } from "../models/EmulatorLaunchCancelledError";
import { terminateOwnedEmulatorProcess } from "./coldBootProcessTermination";
import {
  compareIdentityEvidence,
  deriveEvidenceFromBootedDevice,
  type IdentityEvidence,
  isUnresolvedAndroidEmulatorName,
} from "./deviceIdentityEvidence";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { throwIfProvisionedDeviceTransportRetired } from "../utils/provisionedDeviceTransportFence";
import { deviceReadinessLockKey, withDeviceReadinessLock } from "../utils/deviceReadinessLock";

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
  return (
    devices
      .map((device) =>
        device.name && device.name !== device.deviceId
          ? `${device.name} (${device.deviceId})`
          : device.deviceId,
      )
      .join(", ") || "none"
  );
}

function lifecycleIdentityForDevice(
  device: BootedDevice,
): StableVirtualDeviceIdentity | VirtualDeviceLifecycleIdentity {
  if (device.platform === "ios") {
    return { platform: "ios", stableId: device.deviceId };
  }

  return isAndroidEmulatorSerial(device.deviceId) && !isUnresolvedAndroidEmulatorName(device)
    ? { platform: "android", stableId: device.name }
    : { kind: "selector", platform: "android", selector: device.deviceId };
}

/**
 * Provider interface for device clients - enables dependency injection for testing
 */
export interface DeviceClientProvider {
  getAdb(): AdbExecutor;
  getSimctl(): SimCtlClient | undefined;
  getAndroidEmulator(): AndroidEmulatorClient | undefined;
  getDeviceUtils(): PlatformDeviceManager;
  /**
   * Connected physical iOS device discovery for readiness scans (#11063).
   * Optional: a provider without one leaves the `ios-physical` source unscanned.
   */
  getIosPhysicalDeviceLister?(): IosPhysicalDeviceLister | undefined;
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
export class DefaultDeviceClientProvider implements DeviceClientProvider {
  private _adb: AdbExecutor | undefined;
  private _adbFactory: AdbClientFactory;
  private _simctl: SimCtlClient | undefined;
  private _androidEmulator: AndroidEmulatorClient | undefined;
  private _deviceUtils: PlatformDeviceManager | undefined;
  // Keyed by serial plus the most recent resolved runtime identity. An
  // unresolved/raw-serial listing cannot evict a known-good client, while a
  // different resolved AVD name must not retain clients bound to its predecessor.
  private readonly _windows: Map<string, { window: Window; evidence: IdentityEvidence }> =
    new Map();

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
        this.getAndroidEmulator()!,
      );
    }
    return this._deviceUtils;
  }

  getIosPhysicalDeviceLister(): IosPhysicalDeviceLister {
    // Shared with every MultiPlatformDeviceManager so readiness scans reuse the
    // devicectl cache and last-good retention instead of spawning their own.
    return getSharedDevicectlDeviceLister();
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
    const incoming = deriveEvidenceFromBootedDevice(
      device,
      isUnresolvedAndroidEmulatorName(device),
    );
    const cached = this._windows.get(key);
    if (!cached) {
      return this.cacheWindow(key, device, incoming);
    }
    // Raw-serial evidence cannot name an AVD, so it never replaces (or
    // re-stamps) a cached Window.
    if (incoming.unresolved) {
      return cached.window;
    }
    const comparison = compareIdentityEvidence(cached.evidence, incoming);
    if (incoming.stableId === cached.evidence.stableId) {
      if (comparison === "newer") {
        cached.evidence = incoming;
      }
      return cached.window;
    }
    // Overlapping readiness calls for two AVDs on a reused serial complete out
    // of order: an older resolved observation must not evict the Window the
    // newer AVD already cached (#7031). Unstamped observations stay
    // permissive, matching the pool.
    if (comparison !== "newer") {
      return cached.window;
    }
    return this.cacheWindow(key, device, incoming);
  }

  private cacheWindow(key: string, device: BootedDevice, evidence: IdentityEvidence): Window {
    const window = new WindowImpl(device, this._adbFactory);
    this._windows.set(key, { window, evidence });
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

  /** Explicit selection made by the legacy setActiveDevice tool. */
  getExplicitDevicePin(): BootedDevice | undefined;
  setExplicitDevicePin(device: BootedDevice): void;
  clearExplicitDevicePin(deviceId: string): void;

  /**
   * Ensure a device is ready for the specified platform and return its ID
   * Throws an error if both Android and iOS devices are connected when auto-detecting platform
   */
  ensureDeviceReady(
    platform: SomePlatform,
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice>;

  /**
   * Detect the platform of connected devices
   */
  detectConnectedPlatforms(signal?: AbortSignal): Promise<BootedDevice[]>;
  detectConnectedPlatformsWithStatus(
    signal?: AbortSignal,
    options?: ConnectedPlatformScanOptions,
  ): Promise<ConnectedPlatformScan>;

  /**
   * Verify a specific device is connected and ready for the given platform.
   * `resolvedIdentity` carries the AVD-resolved discovery entry for an Android
   * emulator so readiness caches key on the runtime, not the reused serial.
   */
  verifyDevice(
    deviceId: string,
    platform: Platform,
    options?: DeviceReadyOptions,
    resolvedIdentity?: ResolvedDeviceIdentity,
  ): Promise<void>;

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

export interface ConnectedPlatformScan {
  devices: BootedDevice[];
  /** A platform is scanned when at least one of its discovery sources completed. */
  scanned: Record<Platform, boolean>;
  /**
   * Per-source completeness (#11063). iOS has two independent sources, so a
   * pinned device's absence is authoritative only when its own source
   * completed. Absent for producers that report platforms only.
   */
  scannedSources?: Partial<Record<DiscoverySource, boolean>>;
}

/**
 * True when `scan` completed the discovery source that would have observed
 * `device`, so the device's absence from `scan.devices` proves it is gone.
 */
export function isScanAuthoritativeFor(scan: ConnectedPlatformScan, device: BootedDevice): boolean {
  if (!scan.scannedSources) {
    return scan.scanned[device.platform];
  }
  return scan.scannedSources[discoverySourceFor(device.platform, device.deviceId)] === true;
}

export type DeviceReadinessLevel = "booted" | "automationReady";

/**
 * Ordering of {@link DeviceReadinessLevel} by how much setup each represents
 * having achieved. `SessionManager.setDeviceReadiness` (#6227 round 7) uses
 * this to keep the recorded level monotonic — a session's readiness record
 * may only be raised, never silently downgraded by a later, less-demanding
 * acquisition of the same session.
 */
const DEVICE_READINESS_RANK: Readonly<Record<DeviceReadinessLevel, number>> = {
  booted: 0,
  automationReady: 1,
};

export function deviceReadinessRank(level: DeviceReadinessLevel): number {
  return DEVICE_READINESS_RANK[level];
}

/** The discovery entry that resolved an Android runtime's identity for a serial. */
export type ResolvedDeviceIdentity = Pick<BootedDevice, "deviceId" | "name" | "observedAt">;

export interface DeviceReadyOptions {
  sessionId?: string;
  skipCtrlProxyDownload?: boolean;
  signal?: AbortSignal;
  /** Reuses device discovery already started by the current target resolution. */
  getConnectedPlatforms?: () => Promise<ConnectedPlatformScan | BootedDevice[]>;
  /**
   * `booted` verifies only that the target is connected and booted.
   * `automationReady` additionally prepares CtrlProxy. Defaults to
   * `automationReady` for existing device-aware tools.
   */
  readiness?: DeviceReadinessLevel;
  /**
   * @deprecated Use skipCtrlProxyDownload instead.
   */
  skipAccessibilityDownload?: boolean;
  /**
   * @deprecated Use skipCtrlProxyDownload instead.
   */
  skipAccessibilitySetup?: boolean;
}

export interface ConnectedPlatformScanOptions {
  /** An Android-only caller never waits on (or scans) the physical iOS lister (#11077). */
  platform?: SomePlatform;
}

/** Readiness budget for the shared devicectl sweep; a wedged CoreDevice must not stall callers (#11077). */
export const PHYSICAL_IOS_SCAN_BUDGET_MS = 3_000;

export interface DeviceSessionManagerOptions {
  /** Overrides {@link PHYSICAL_IOS_SCAN_BUDGET_MS}. */
  physicalIosScanBudgetMs?: number;
  appearanceOnConnectDependencies?: Partial<AppearanceOnConnectDependencies>;
  admissionGate?: DeviceAdmissionGate;
  executionBinding?: DeviceExecutionBinding;
  runnerReadinessTimer?: Timer;
  runnerReadinessTimeoutMs?: number;
  /**
   * Boot-class budget for one-time runner provisioning (cold CtrlProxy launch)
   * on the session auto-start path, which owns no separate device-boot deadline.
   * Defaults to {@link DEFAULT_RUNNER_PROVISION_TIMEOUT_MS} (#5376).
   */
  runnerProvisionTimeoutMs?: number;
  lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator;
  idGenerator?: IdGenerator;
}

/** What a lifecycle-start operation may do to keep its AVD lease past its own return. */
interface LifecycleStartHold {
  lease: VirtualDeviceLifecycleLease;
  /** Keeps the lease held until `settlement` settles, though the operation has already returned. */
  holdLeaseUntil: (settlement: Promise<unknown>) => void;
}

export class DeviceSessionManager implements DeviceSessionManager {
  private currentDevice: BootedDevice | undefined;
  private currentPlatform: Platform | undefined;
  private explicitDevicePin: BootedDevice | undefined;
  private static instance: DeviceSessionManager;
  private static defaultProvider: DeviceClientProvider | undefined;
  private readonly admissionGate: DeviceAdmissionGate;
  private readonly executionBinding: DeviceExecutionBinding;
  private readonly provider: DeviceClientProvider;
  private readonly adbFactory: AdbClientFactory;
  private readonly runnerReadinessService: RunnerReadinessService;
  private readonly runnerReadinessTimer: Timer;
  private readonly physicalIosScanBudgetMs: number;
  private readonly runnerReadinessTimeoutMs: number | undefined;
  private readonly runnerProvisionTimeoutMs: number | undefined;
  private readonly lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  private _adb: AdbExecutor | undefined;
  private readonly idGenerator: IdGenerator;
  private readonly appearanceOnConnectDependencies:
    | Partial<AppearanceOnConnectDependencies>
    | undefined;

  // Client recreation after an iOS device restart needs a fresh callback.
  private static pushUpdateListenersRegistered: WeakSet<IOSCtrlProxy> = new WeakSet();

  private constructor(
    provider: DeviceClientProvider,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    options: DeviceSessionManagerOptions = {},
  ) {
    this.admissionGate = options.admissionGate ?? daemonDeviceAdmissionGate;
    this.executionBinding = options.executionBinding ?? ambientDeviceExecutionBinding;
    this.provider = provider;
    this.adbFactory = adbFactory;
    this.runnerReadinessTimer = options.runnerReadinessTimer ?? defaultTimer;
    this.physicalIosScanBudgetMs = options.physicalIosScanBudgetMs ?? PHYSICAL_IOS_SCAN_BUDGET_MS;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.appearanceOnConnectDependencies = options.appearanceOnConnectDependencies;
    this.runnerReadinessTimeoutMs = options.runnerReadinessTimeoutMs;
    this.runnerProvisionTimeoutMs = options.runnerProvisionTimeoutMs;
    this.lifecycleCoordinator =
      options.lifecycleCoordinator ?? getVirtualDeviceLifecycleCoordinator();
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
      DeviceSessionManager.instance = new DeviceSessionManager(
        DeviceSessionManager.defaultProvider,
      );
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
   * Get the platform-aware device discovery manager shared by this session manager.
   */
  public getPlatformDeviceManager(): PlatformDeviceManager {
    return this.deviceUtils;
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

  public getExplicitDevicePin(): BootedDevice | undefined {
    return this.explicitDevicePin;
  }

  public setExplicitDevicePin(device: BootedDevice): void {
    this.explicitDevicePin = device;
  }

  public clearExplicitDevicePin(deviceId: string): void {
    if (this.explicitDevicePin?.deviceId === deviceId) {
      this.explicitDevicePin = undefined;
    }
  }

  /**
   * Detect the platform of connected devices
   */
  public async detectConnectedPlatforms(signal?: AbortSignal): Promise<BootedDevice[]> {
    return (await this.detectConnectedPlatformsWithStatus(signal)).devices;
  }

  public async detectConnectedPlatformsWithStatus(
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
      const androidDevices = await this.adb.getBootedAndroidDevices({ signal });
      perf.endOperation("androidDeviceScan");
      devices.push(...androidDevices);
      scannedSources.android = true;
    } catch (error) {
      perf.endOperation("androidDeviceScan");
      signal?.throwIfAborted();
      logger.warn(`Failed to detect Android devices: ${error}`);
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
    if (!this.simctl) {
      return { devices: [], complete: false };
    }
    perf.startOperation("iosSimulatorScan");
    try {
      const devices = await this.simctl.getBootedSimulatorsChecked(undefined, signal);
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
    const lister = this.provider.getIosPhysicalDeviceLister?.();
    if (!lister || platform === "android") {
      return { devices: [], complete: false };
    }
    try {
      // The lister run is shared and uncancellable; losing the race leaves it running.
      const discovery = await raceWithDeadline(() => lister.listConnectedDevices(), {
        timer: this.runnerReadinessTimer,
        timeoutMs: this.physicalIosScanBudgetMs,
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

  /**
   * Ensure a device is ready for the specified platform and return its ID
   * Throws an error if both Android and iOS devices are connected when auto-detecting platform
   */
  public async ensureDeviceReady(
    platform: SomePlatform,
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice> {
    logger.info(
      `[DeviceSessionManager] ensureDeviceReady called with platform=${platform}, providedDeviceId=${providedDeviceId}`,
    );
    if (providedDeviceId) {
      await throwIfProvisionedDeviceTransportRetired(providedDeviceId);
    }

    // Detect all connected devices
    const result = await this.getReadinessScan(platform, options);
    const scan = this.normalizeReadinessScan(result);
    const connectedPlatforms = scan.devices;
    this.reconcileReadinessPin(scan);
    logger.info(`Found ${connectedPlatforms.length} connectedPlatform devices`);
    const androidDevices = connectedPlatforms.filter((device) => device.platform === "android");
    logger.info(`Found ${androidDevices.length} android devices`);
    const iosDevices = connectedPlatforms.filter((device) => device.platform === "ios");
    logger.info(`Found ${iosDevices.length} ios devices`);

    const { platformDevices, resolvedPlatform } = this.resolveReadinessPlatform(
      platform,
      androidDevices,
      iosDevices,
      providedDeviceId,
    );

    let selectedDevice: BootedDevice | undefined;
    let deviceVerified = false;
    let deviceSource: "provided" | "current" | "auto" = "auto";

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
    const selectedPin = this.findPinnedReadinessDevice(platformDevices);
    if (this.shouldResolveReadinessPin(selectedDevice, providedDeviceId, selectedPin)) {
      selectedDevice = await this.resolveAndroidReadinessIdentity(selectedPin, options?.signal);
      deviceSource = "provided";
    }

    // If we have a current device for the requested platform, verify it's still ready
    if (!selectedDevice && this.hasCurrentReadinessDevice(platform, resolvedPlatform)) {
      selectedDevice = await this.verifyCurrentReadinessDevice(
        platformDevices,
        resolvedPlatform,
        options,
      );
      if (selectedDevice) {
        deviceVerified = true;
        deviceSource = "current";
      }
    }

    // No device set - find or start one for the requested platform
    if (!selectedDevice) {
      logger.info(
        `[DeviceSessionManager] No current device, finding or starting device for platform ${resolvedPlatform}`,
      );
      selectedDevice = await this.findOrStartDevice(resolvedPlatform, options);
      deviceVerified = true;
      deviceSource = "auto";
    }

    if (!deviceVerified) {
      if (!selectedDevice) {
        throw new ActionableError("No device was selected for readiness verification");
      }
      const deviceForVerification = selectedDevice;
      await this.withLifecycleStart(
        lifecycleIdentityForDevice(deviceForVerification),
        options,
        async (signal) =>
          await this.verifyDevice(
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
      options,
    );
  }

  private assertUsableIosOverride(
    iosOverride: Awaited<ReturnType<typeof checkIosCtrlProxyOverride>>,
  ): void {
    if (iosOverride.present && !iosOverride.usable) {
      throw new ActionableError(
        `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH / _IPA_PATH is set but unusable: ${iosOverride.reason}`,
      );
    }
  }

  private async finishReadinessSelection(
    selectedDevice: BootedDevice,
    resolvedPlatform: Platform,
    deviceSource: "provided" | "current" | "auto",
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice> {
    // Safety check: ensure the selected device's platform matches the resolved platform.
    // This guards against cross-platform contamination where an iOS device could be
    // returned when Android was explicitly requested (or vice versa).
    if (selectedDevice.platform !== resolvedPlatform) {
      logger.warn(
        `[DeviceSessionManager] Platform mismatch: selected device ${selectedDevice.deviceId} ` +
          `has platform '${selectedDevice.platform}' but resolved platform is '${resolvedPlatform}'. ` +
          `Discarding and finding correct platform device.`,
      );
      selectedDevice = await this.findOrStartDevice(resolvedPlatform, options);
    }

    // A cancelled call (e.g. another session acquired the device, #10905) stops before each
    // device-mutating step: the current-device pin and the settings writes.
    options?.signal?.throwIfAborted();
    this.setCurrentDevice(selectedDevice, resolvedPlatform);
    if (deviceSource !== "current") {
      await applyAppearanceOnConnect(
        selectedDevice,
        this.appearanceOnConnectDependencies,
        resolveAppearanceSessionKey(options?.sessionId),
      );
      options?.signal?.throwIfAborted();
      await disableStylusHandwriting(selectedDevice, this.adbFactory);
    }
    logger.info(`[DeviceSessionManager] Using ${deviceSource} device: ${selectedDevice.deviceId}`);
    return selectedDevice;
  }

  private assertCreatedIosReservation(
    lifecycleLease: VirtualDeviceLifecycleLease | undefined,
    provisioned: { name: string; deviceId?: string },
  ): asserts lifecycleLease is VirtualDeviceLifecycleLease {
    if (!lifecycleLease || !provisioned.deviceId) {
      throw new ActionableError(
        `Created iOS simulator '${provisioned.name}' has no lifecycle reservation.`,
      );
    }
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
      throw new ActionableError(
        `Device ${providedDeviceId} not found on ${platform} platform. ` +
          `Available ${platform} devices: ${describeDevices(platformDevices)}`,
      );
    }
    return providedDevice;
  }

  private findPinnedReadinessDevice(platformDevices: BootedDevice[]): BootedDevice | undefined {
    return platformDevices.find((device) => device.deviceId === this.explicitDevicePin?.deviceId);
  }

  private getReadinessScan(
    platform: SomePlatform,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice[] | ConnectedPlatformScan> {
    return options?.getConnectedPlatforms
      ? options.getConnectedPlatforms()
      : this.detectConnectedPlatformsWithStatus(options?.signal, { platform });
  }

  private reconcileReadinessPin(scan: ConnectedPlatformScan): void {
    const pinnedDevice = this.explicitDevicePin;
    if (
      pinnedDevice &&
      isScanAuthoritativeFor(scan, pinnedDevice) &&
      !scan.devices.some(
        (device) =>
          device.deviceId === pinnedDevice.deviceId && device.platform === pinnedDevice.platform,
      )
    ) {
      this.clearExplicitDevicePin(pinnedDevice.deviceId);
    }
  }

  private resolveReadinessPlatform(
    platform: SomePlatform,
    androidDevices: BootedDevice[],
    iosDevices: BootedDevice[],
    providedDeviceId?: string,
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
          return this.resolveMixedReadinessPlatform(androidDevices, iosDevices, providedDeviceId);
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
    const selectedPlatform = this.explicitDevicePin?.platform ?? this.currentPlatform;
    if (selectedPlatform && (this.explicitDevicePin || this.currentDevice)) {
      return {
        platformDevices: selectedPlatform === "android" ? androidDevices : iosDevices,
        resolvedPlatform: selectedPlatform,
      };
    }
    throw new ActionableError(
      "Both Android and iOS devices are connected. For a device tool call, pass sessionUuid (from getAndroid/getApple), platform, or a bound device label on this call to select the target. Alternatively, call setActiveDevice to select an active device.",
    );
  }

  private async verifyCurrentReadinessDevice(
    platformDevices: BootedDevice[],
    resolvedPlatform: Platform,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice | undefined> {
    logger.info(
      `[DeviceSessionManager] Found current device: ${this.currentDevice!.deviceId}, verifying readiness`,
    );
    try {
      // Prefer the current discovery over the cached selection, resolved to
      // its stable AVD name so an Android emulator is keyed by the runtime on
      // the serial rather than by the serial itself.
      const currentDevice = await this.resolveAndroidReadinessIdentity(
        platformDevices.find((device) => device.deviceId === this.currentDevice?.deviceId) ??
          this.currentDevice!,
        options?.signal,
      );
      // Use resolvedPlatform (always "android" | "ios") instead of platform (which may be "either")
      // to ensure verifyDevice dispatches to the correct platform-specific verification
      await this.withLifecycleStart(
        lifecycleIdentityForDevice(currentDevice),
        options,
        async (signal) =>
          await this.verifyDevice(
            currentDevice.deviceId,
            resolvedPlatform,
            { ...options, signal },
            currentDevice,
          ),
      );
      return currentDevice;
    } catch (error) {
      // Request cancellation does not make the selected device stale. Preserve
      // the user's explicit selection so a later platform-implicit call does
      // not become ambiguous merely because this caller disconnected.
      options?.signal?.throwIfAborted();
      if (error instanceof RunnerReadinessError || isDeviceIdentityQuarantinedError(error)) {
        throw error;
      }
      logger.warn(`Current device ${this.currentDevice} is no longer ready: ${error}`);
      this.currentDevice = undefined;
      this.currentPlatform = undefined;
    }
    return undefined;
  }

  /**
   * Verify a specific device is connected and ready for the given platform
   */
  public async verifyDevice(
    deviceId: string,
    platform: Platform,
    options?: DeviceReadyOptions,
    resolvedIdentity?: ResolvedDeviceIdentity,
  ): Promise<void> {
    if (platform === "android") {
      await this.verifyAndroidDevice(deviceId, options, resolvedIdentity);
    } else {
      await this.verifyIosDevice(deviceId, options);
    }
  }

  /**
   * Production discovery lists Android devices from raw `adb devices`, so the
   * provided-device and current-device readiness paths only see
   * `name === serial`. Resolve the AVD identity from the enriched discovery
   * (the same source `findOrStartAndroidDevice` uses) so those paths also
   * rebuild the cached Window when another AVD takes over the serial (#7031).
   * Falls back to the raw entry when the runtime cannot be resolved.
   */
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
      enriched = (await this.deviceUtils.getBootedDevices("android")).find(
        (candidate) => candidate.deviceId === device.deviceId,
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[DeviceSessionManager] Could not resolve the AVD identity for ${device.deviceId}; ` +
          `keeping the raw serial identity: ${errorMessage(error)}`,
        error,
      );
      return device;
    }
    return enriched && !isUnresolvedAndroidEmulatorName(enriched) ? enriched : device;
  }

  /**
   * Verify an Android device is connected and ready
   */
  public async verifyAndroidDevice(
    deviceId: string,
    options?: DeviceReadyOptions,
    resolvedIdentity?: ResolvedDeviceIdentity,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    // Gate before discovery or a cached Window can use its pre-quarantine executor.
    // Identity reconciliation/lifting uses discovery directly, never readiness.
    this.admissionGate.assertDeviceActionable(deviceId, "to verify Android device readiness");
    this.executionBinding.bindDeviceExecution(deviceId);
    const allDevices = await this.adb.getBootedAndroidDevices();
    const device = allDevices.find((device) => device.deviceId === deviceId);

    if (!device) {
      throw new ActionableError(
        `Android device ${deviceId} is not connected. Available devices: ${describeDevices(allDevices)}`,
      );
    }
    // Check if we can get an active window from the device
    try {
      logger.info(`[DeviceSessionManager] Verifying Android device ${deviceId} readiness`);

      const deviceForWindow = this.androidReadinessWindowDevice(device, resolvedIdentity);
      const window = this.provider.getWindow(deviceForWindow);

      const activeWindow = await window.getActive(true);
      this.assertAndroidActiveWindow(deviceId, activeWindow);
    } catch (error) {
      const errorMsg = errorMessage(error);
      throw new ActionableError(
        `Failed to verify Android device ${deviceId} readiness: ${errorMsg}`,
      );
    }

    options?.signal?.throwIfAborted();
    if (options?.readiness === "booted") {
      return;
    }

    await withDeviceReadinessLock(
      deviceReadinessLockKey("android", deviceId),
      () => this.ensureAndroidCtrlProxyReady(deviceId, device, options),
      { signal: options?.signal },
    );
  }

  private androidReadinessWindowDevice(
    device: BootedDevice,
    resolvedIdentity?: ResolvedDeviceIdentity,
  ): BootedDevice {
    return resolvedIdentity?.deviceId === device.deviceId
      ? {
          ...device,
          name: resolvedIdentity.name,
          ...(resolvedIdentity.observedAt === undefined
            ? {}
            : { observedAt: resolvedIdentity.observedAt }),
        }
      : device;
  }

  private assertAndroidActiveWindow(
    deviceId: string,
    activeWindow: Awaited<ReturnType<Window["getActive"]>>,
  ): void {
    if (!activeWindow || !activeWindow.appId || !activeWindow.activityName) {
      logger.warn(`[DeviceSessionManager] Android device ${deviceId} is not fully ready`);
      if (activeWindow) {
        logger.warn(
          `[DeviceSessionManager] activeWindow.appId: ${activeWindow.appId} | activeWindow.activityName: ${activeWindow.activityName}`,
        );
      } else {
        logger.warn(`[DeviceSessionManager] activeWindow: ${activeWindow}`);
      }
      throw new ActionableError(
        `Cannot get active window information from Android device ${deviceId}. The device may not be fully booted or is in an unusual state.`,
      );
    }
  }

  // Existing CtrlProxy state machine moved intact so the readiness lock covers it.
  // oxlint-disable-next-line eslint/complexity
  private async ensureAndroidCtrlProxyReady(
    deviceId: string,
    device: BootedDevice,
    options?: DeviceReadyOptions,
  ): Promise<void> {
    // Always track setup timing (one-time per session, valuable for debugging)
    const perf = createPerformanceTracker(true);
    perf.serial("ensureAccessibilityService");
    const state = { didSetup: false, needsSetup: false };

    try {
      const skipCtrlProxyDownload = this.skipCtrlProxyDownload(options);
      this.warnDeprecatedAccessibilityOptions(options);

      const accessibilityClient = this.provider.getAndroidCtrlProxyClient(device);
      if (accessibilityClient.isConnected()) {
        if (await this.verifyConnectedAndroidService(deviceId, accessibilityClient, perf)) {
          return;
        }
      }

      const manager = this.provider.getAndroidCtrlProxyManager(device);
      const verifyCompatibilityWhenSkipping = async (): Promise<void> => {
        const isCompatible = await manager.isVersionCompatible();
        if (isCompatible) {
          logger.info(
            `[DeviceSessionManager] Accessibility service version compatible for ${deviceId}`,
          );
          return;
        }
        const errorMsg =
          "Accessibility service version mismatch detected. Run without skipCtrlProxyDownload to install a compatible version.";
        logger.warn(`[DeviceSessionManager] ${errorMsg} Device: ${deviceId}`);
        throw new ActionableError(errorMsg);
      };

      const [isInstalled, isEnabled] = await perf.track("checkStatus", () =>
        Promise.all([manager.isInstalled(), manager.isEnabled()]),
      );
      // Enabling or installing CtrlProxy mutates the device; a cancelled call stops here (#10905).
      options?.signal?.throwIfAborted();

      state.needsSetup = false;

      if (isInstalled && isEnabled) {
        if (
          await this.verifyEnabledAndroidService(
            deviceId,
            manager,
            accessibilityClient,
            perf,
            state,
            {
              skipCtrlProxyDownload,
              verifyCompatibilityWhenSkipping,
            },
          )
        ) {
          return;
        }
      }

      if (!isInstalled && skipCtrlProxyDownload) {
        logger.info(
          `[DeviceSessionManager] Accessibility service not installed for ${deviceId}, skipping download/install`,
        );
        return;
      }

      if (isInstalled && !isEnabled && !state.needsSetup) {
        if (
          await this.enableInstalledAndroidService(
            deviceId,
            manager,
            accessibilityClient,
            perf,
            state,
            {
              skipCtrlProxyDownload,
              verifyCompatibilityWhenSkipping,
            },
          )
        ) {
          return;
        }
      }

      if (skipCtrlProxyDownload && !state.needsSetup) {
        logger.info(
          `[DeviceSessionManager] Skipping accessibility service download/install for ${deviceId}`,
        );
        return;
      }

      if (state.needsSetup || !isInstalled) {
        options?.signal?.throwIfAborted();
        await this.setupAndroidService(deviceId, manager, accessibilityClient, perf, state);
      }
    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.error(`[DeviceSessionManager] Failed to setup accessibility service: ${errorMsg}`);
      // Rethrow ActionableErrors to preserve their specific error messages, and cancellation so
      // readiness does not go on to pin and configure the device (#10905).
      if (error instanceof ActionableError || options?.signal?.aborted) {
        throw error;
      }
    } finally {
      perf.end();
      // Store timing if we actually did setup work
      if (state.didSetup) {
        const timings = perf.getTimings();
        if (timings) {
          storeSetupTiming(deviceId, timings, options?.sessionId);
        }
      }
    }
  }

  private skipCtrlProxyDownload(options?: DeviceReadyOptions): boolean | undefined {
    return (
      options?.skipCtrlProxyDownload ??
      options?.skipAccessibilityDownload ??
      options?.skipAccessibilitySetup
    );
  }

  private warnDeprecatedAccessibilityOptions(options?: DeviceReadyOptions): void {
    if (options?.skipAccessibilitySetup !== undefined) {
      if (options?.skipAccessibilityDownload !== undefined) {
        logger.warn(
          "[DeviceSessionManager] skipAccessibilityDownload is deprecated; use skipCtrlProxyDownload instead.",
        );
      } else {
        logger.warn(
          "[DeviceSessionManager] skipAccessibilitySetup is deprecated; use skipCtrlProxyDownload instead.",
        );
      }
    }
  }

  private async verifyConnectedAndroidService(
    deviceId: string,
    accessibilityClient: AndroidCtrlProxy,
    perf: ReturnType<typeof createPerformanceTracker>,
  ): Promise<boolean> {
    // WebSocket appears connected, but verify service is actually responsive
    // This catches cases where service crashed but socket wasn't properly closed
    logger.info(
      `[DeviceSessionManager] WebSocket connected for ${deviceId}, verifying service is responsive`,
    );
    const isReady = await perf.track("verifyConnectedService", () =>
      accessibilityClient.verifyServiceReady(2, 200, 2000),
    );
    if (isReady) {
      logger.info(
        `[DeviceSessionManager] Accessibility service verified responsive for ${deviceId}`,
      );
      perf.end();
      return true;
    }
    // Service not responsive despite a connected socket: the socket itself
    // is suspect (issue #7554 — readyState stays OPEN across a half-open
    // connection to a wedged or unreachable peer). Terminate it so the
    // normal flow below reconnects with a fresh socket, rather than
    // falling through to a waitForConnection() that would just reuse the
    // same half-open one and report success immediately. Unlike close(),
    // terminateStaleConnection() does not disable auto-reconnect for the
    // rest of this client's lifetime — it drives the same was-open close
    // path a real network failure would.
    logger.warn(
      `[DeviceSessionManager] WebSocket connected but service not responsive for ${deviceId}, terminating stale connection and checking status`,
    );
    accessibilityClient.terminateStaleConnection();
    return false;
  }

  private async verifyEnabledAndroidService(
    deviceId: string,
    manager: CtrlProxyManager,
    accessibilityClient: AndroidCtrlProxy,
    perf: ReturnType<typeof createPerformanceTracker>,
    setupState: { didSetup: boolean; needsSetup: boolean },
    compatibility: {
      skipCtrlProxyDownload: boolean | undefined;
      verifyCompatibilityWhenSkipping: () => Promise<void>;
    },
  ): Promise<boolean> {
    const { skipCtrlProxyDownload, verifyCompatibilityWhenSkipping } = compatibility;
    logger.info(
      `[DeviceSessionManager] Accessibility service already enabled for ${deviceId}, verifying WebSocket connection`,
    );
    // Verify the service is actually working by checking WebSocket connection
    const connected = await perf.track("verifyConnection", () =>
      accessibilityClient.waitForConnection(3, 200),
    );
    if (connected) {
      if (skipCtrlProxyDownload) {
        await verifyCompatibilityWhenSkipping();
        return true;
      }
      logger.info(
        `[DeviceSessionManager] Accessibility service enabled and connected for ${deviceId}, verifying version compatibility`,
      );
    } else {
      // Service claims to be installed but WebSocket won't connect - cache is stale
      logger.warn(
        `[DeviceSessionManager] Accessibility service cache stale for ${deviceId} - marked as installed/enabled but WebSocket failed. Resetting setup state and forcing reinstall.`,
      );
      manager.resetSetupState();
      setupState.needsSetup = true;
    }
    return false;
  }

  private async enableInstalledAndroidService(
    deviceId: string,
    manager: CtrlProxyManager,
    accessibilityClient: AndroidCtrlProxy,
    perf: ReturnType<typeof createPerformanceTracker>,
    setupState: { didSetup: boolean; needsSetup: boolean },
    compatibility: {
      skipCtrlProxyDownload: boolean | undefined;
      verifyCompatibilityWhenSkipping: () => Promise<void>;
    },
  ): Promise<boolean> {
    const { skipCtrlProxyDownload, verifyCompatibilityWhenSkipping } = compatibility;
    logger.info(
      `[DeviceSessionManager] Accessibility service installed but not enabled for ${deviceId}, enabling now`,
    );
    try {
      await perf.track("enableService", () => manager.enable());
      setupState.didSetup = true;
      // enable() just changed the endpoint's state; failures recorded
      // before this point must not cool down the connect that follows
      // (issue #7538).
      accessibilityClient.resetConnectionBudget();
      // Wait for WebSocket to be ready after enabling
      logger.info(
        `[DeviceSessionManager] Waiting for accessibility WebSocket connection for ${deviceId}`,
      );
      const enableConnected = await perf.track("waitForConnection", () =>
        accessibilityClient.waitForConnection(),
      );
      if (!enableConnected) {
        logger.warn(
          `[DeviceSessionManager] WebSocket connection failed after enabling for ${deviceId}, will attempt full setup`,
        );
        manager.resetSetupState();
        setupState.needsSetup = true;
      } else {
        if (skipCtrlProxyDownload) {
          await verifyCompatibilityWhenSkipping();
          return true;
        }
        logger.info(
          `[DeviceSessionManager] Accessibility service enabled for ${deviceId}, verifying version compatibility`,
        );
      }
    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.warn(`[DeviceSessionManager] Failed to enable accessibility service: ${errorMsg}`);
      if (skipCtrlProxyDownload) {
        return true;
      }
      setupState.needsSetup = true;
    }
    return false;
  }

  private async setupAndroidService(
    deviceId: string,
    manager: CtrlProxyManager,
    accessibilityClient: AndroidCtrlProxy,
    perf: ReturnType<typeof createPerformanceTracker>,
    state: { didSetup: boolean },
  ): Promise<void> {
    const setup = await manager.setup(false, perf);
    if (!setup.success) {
      throw new ActionableError(setup.error ?? setup.message);
    }
    state.didSetup = true;
    // setup() just changed the endpoint's state (fresh install/enable);
    // failures recorded before this point must not cool down the connect
    // that follows (issue #7538).
    accessibilityClient.resetConnectionBudget();
    // Wait for WebSocket to be ready after setup (install + enable)
    logger.info(
      `[DeviceSessionManager] Waiting for accessibility WebSocket connection after setup for ${deviceId}`,
    );
    const connected = await perf.track("waitForConnection", () =>
      accessibilityClient.waitForConnection(),
    );
    if (connected) {
      // Verify service is actually ready to respond (not just WebSocket connected)
      logger.info(
        `[DeviceSessionManager] Verifying accessibility service is responsive for ${deviceId}`,
      );
      const ready = await perf.track("verifyServiceReady", () =>
        accessibilityClient.verifyServiceReady(5, 500, 3000),
      );
      if (!ready) {
        logger.warn(
          `[DeviceSessionManager] Accessibility service not responsive after setup for ${deviceId}, observe may fall back to UIAutomator`,
        );
      }
    }
  }

  private hasCurrentReadinessDevice(platform: SomePlatform, resolvedPlatform: Platform): boolean {
    return !!(
      this.currentDevice &&
      (this.currentPlatform === platform || this.currentPlatform === resolvedPlatform)
    );
  }

  private normalizeReadinessScan(
    result: BootedDevice[] | ConnectedPlatformScan,
  ): ConnectedPlatformScan {
    return Array.isArray(result)
      ? { devices: result, scanned: { android: true, ios: true } }
      : result;
  }

  /**
   * Verify an iOS device is connected and ready
   */
  public async verifyIosDevice(deviceId: string, options?: DeviceReadyOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    if (isIosPhysicalUdid(deviceId)) {
      return await this.verifyPhysicalIosDevice(
        deviceId,
        options?.readiness ?? "automationReady",
        options,
      );
    }
    return await this.verifySimulatorIosDevice(deviceId, options);
  }

  private async verifySimulatorIosDevice(
    deviceId: string,
    options?: DeviceReadyOptions,
  ): Promise<void> {
    const readiness = options?.readiness ?? "automationReady";
    // An explicit runner override that cannot be used must fail closed before any
    // other path, whatever the simulator/runner state. Every downstream branch
    // (already-connected, already-running, cached-start) skips the builder that
    // would validate it, so otherwise a directory- or typo-valued
    // AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH would silently run the cached released
    // runner and the caller would attribute results to a local build that never
    // loaded (#4221).
    if (readiness === "automationReady") {
      const iosOverride = await checkIosCtrlProxyOverride();
      this.assertUsableIosOverride(iosOverride);
    }

    if (!this.simctl) {
      throw new ActionableError("iOS simulator tools not available");
    }
    const deviceInfo = await this.simctl.getDeviceInfo(deviceId);
    options?.signal?.throwIfAborted();

    this.assertIosDeviceAvailable(deviceId, deviceInfo);

    // If simulator is not booted, we could boot it, but for now we'll just check
    if (deviceInfo.state !== "Booted") {
      logger.info(`iOS simulator ${deviceId} is not booted (state: ${deviceInfo.state})`);
      // Note: We could auto-boot here if desired, but keeping consistent with current behavior
      return;
    }

    if (readiness === "booted") {
      return;
    }

    // Create a device object for the CtrlProxy iOS clients
    const device: BootedDevice = {
      deviceId,
      name: deviceInfo.name,
      platform: "ios",
    };

    await this.ensureIosRunnerReady(deviceId, device, options);
  }

  /**
   * Readiness for a physical iPhone UDID (#11075). The simulator checks do not
   * apply: connection is proven by the shared devicectl listing, and automation
   * readiness needs the signed on-device runner, whose setup belongs to a session
   * acquired through getApple.
   */
  private async verifyPhysicalIosDevice(
    deviceId: string,
    readiness: DeviceReadinessLevel,
    options?: DeviceReadyOptions,
  ): Promise<void> {
    const device = await this.findConnectedPhysicalIosDevice(deviceId, options?.signal);
    if (readiness === "automationReady" && !options?.sessionId) {
      throw new ActionableError(
        `Physical iPhone ${deviceId} is connected but has no prepared CtrlProxy runner. ` +
          "Acquire the iPhone with getApple first; signed-runner setup cannot run on a sessionless call.",
      );
    }
    if (readiness === "booted") {
      return;
    }
    this.assertUsableIosOverride(await checkIosCtrlProxyOverride());
    await this.ensureIosRunnerReady(deviceId, device, options);
  }

  private async findConnectedPhysicalIosDevice(
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<BootedDevice> {
    const discovery = await this.provider.getIosPhysicalDeviceLister?.()?.listConnectedDevices();
    signal?.throwIfAborted();
    const device = discovery?.devices.find((candidate) => candidate.deviceId === deviceId);
    if (device) {
      return device;
    }
    const incomplete =
      discovery && !discovery.complete ? ` (devicectl: ${discovery.error.message})` : "";
    throw new ActionableError(
      `Physical iPhone ${deviceId} is not connected or not reachable through devicectl${incomplete}. ` +
        "Connect, unlock, and trust the device, then acquire it with getApple.",
    );
  }

  private assertIosDeviceAvailable(
    deviceId: string,
    deviceInfo: Awaited<ReturnType<SimCtlClient["getDeviceInfo"]>>,
  ): asserts deviceInfo is NonNullable<Awaited<ReturnType<SimCtlClient["getDeviceInfo"]>>> {
    if (!deviceInfo) {
      throw new ActionableError(
        `iOS simulator ${deviceId} is not available. Please check if it exists and is available.`,
      );
    }

    if (!deviceInfo.isAvailable) {
      throw new ActionableError(
        `iOS simulator ${deviceId} is not available (state: ${deviceInfo.state}). Please check simulator availability.`,
      );
    }
  }

  private async ensureIosRunnerReady(
    deviceId: string,
    device: BootedDevice,
    options?: DeviceReadyOptions,
  ): Promise<void> {
    // Pass the tracker through to CtrlProxy setup while keeping the legacy
    // session path subject to the same strict readiness contract as startDevice.
    const perf = createPerformanceTracker(true);
    perf.serial("ensureCtrlProxy iOS");
    let didSetup = false;
    const runnerReadinessTimeoutMs =
      this.runnerReadinessTimeoutMs ?? serverConfig.getRunnerReadinessTimeoutMs();
    // Session auto-start owns no separate device-boot deadline, so a genuine cold
    // first call must fit the one-time CtrlProxy provisioning (~90-115s launch)
    // in the total deadline. Size it to the provision budget while keeping
    // `readinessTimeoutMs` as the fast-fail steady-state health window; the
    // service bounds setup by the total and opens the health window only after
    // provisioning completes (#5376).
    const runnerProvisionTimeoutMs =
      this.runnerProvisionTimeoutMs ?? DEFAULT_RUNNER_PROVISION_TIMEOUT_MS;

    try {
      const totalDeadlineMs =
        this.runnerReadinessTimer.now() +
        Math.max(runnerProvisionTimeoutMs, runnerReadinessTimeoutMs);
      await this.runnerReadinessService.ensureReady({
        device,
        requestedIdentity: `platform=ios deviceId=${deviceId}`,
        operationName: "legacy iOS session auto-start",
        totalDeadlineMs,
        readinessTimeoutMs: runnerReadinessTimeoutMs,
        skipCtrlProxyDownload: this.skipCtrlProxyDownload(options),
        perf,
        signal: options?.signal,
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
          storeSetupTiming(deviceId, timings, options?.sessionId);
        }
      }
    }
  }

  /**
   * Find an available device or start an emulator for the specified platform
   */
  public async findOrStartDevice(
    platform: Platform,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice> {
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
      return await this.withLifecycleStart(
        lifecycleIdentityForDevice(device),
        options,
        async (signal) => {
          AndroidCtrlProxyClient.resumeAfterDeviceStart(deviceId);
          perf.startOperation("verifyDevice");
          await this.verifyAndroidDevice(deviceId, { ...options, signal }, device);
          perf.endOperation("verifyDevice");
          return device;
        },
      );
    }

    // No devices - try to start a device from an image
    perf.startOperation("listImages");
    const availableImages = await this.deviceUtils.listDeviceImages("android");
    perf.endOperation("listImages");

    if (availableImages.length === 0) {
      throw new ActionableError(
        "No devices are connected and no device images are available. Please connect a physical device or create a device image first.",
      );
    }

    // Start the first available AVD
    const deviceImage = availableImages[0];
    assertAndroidImageRunningStateKnown(deviceImage);
    logger.info(`Starting Android emulator ${deviceImage}...`);
    return await this.withLifecycleStart(
      { platform: "android", stableId: deviceImage.name },
      options,
      async (signal, hold) => {
        perf.startOperation("startDevice");
        const childProcess = await runWithAbortSignal(
          signal,
          async () => await this.startDeviceOwningCancelledLaunch(deviceImage, hold),
        );
        const processTracker = childProcess ? trackProcess(childProcess) : undefined;
        perf.endOperation("startDevice");

        // Wait for the emulator to fully boot and get its device ID. Cancel the boot
        // (shut the half-booted emulator back down) if readiness fails (issue #3952).
        perf.startOperation("waitForReady");
        const newDevice = await waitForDeviceReadyOrCancel(
          this.deviceUtils,
          deviceImage,
          childProcess,
          undefined,
          signal,
          this.runnerReadinessTimer,
          processTracker
            ? async () =>
                await waitForExit(processTracker.process, processTracker.exitPromise, {
                  signal: "SIGTERM",
                  timer: this.runnerReadinessTimer,
                })
            : undefined,
        );
        perf.endOperation("waitForReady");

        if (!newDevice) {
          throw new ActionableError(`Failed to start Android emulator ${deviceImage}.`);
        }

        AndroidCtrlProxyClient.resumeAfterDeviceStart(newDevice.deviceId!);
        perf.startOperation("verifyDevice");
        await this.verifyAndroidDevice(newDevice.deviceId!, { ...options, signal }, newDevice);
        perf.endOperation("verifyDevice");
        return newDevice;
      },
    );
  }

  private async bindCreatedIosReadinessIdentity(
    lifecycleLease: VirtualDeviceLifecycleLease | undefined,
    device: { name: string; deviceId?: string },
  ): Promise<void> {
    if (!lifecycleLease || !device.deviceId) {
      throw new ActionableError(
        `Created iOS simulator '${device.name}' has no lifecycle identity.`,
      );
    }
    const stableId = device.deviceId;
    await lifecycleLease.bindCanonicalIdentity({ platform: "ios", stableId }, async () =>
      this.revalidateCreatedIosDevice(stableId),
    );
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
    const simulatorImages = await this.simctl.listSimulatorImages();
    perf.endOperation("listSimulators");
    const unavailableDevices = simulatorImages.filter((device) => device.isAvailable === false);
    const availableDevices = simulatorImages
      .filter((device) => device.isAvailable !== false)
      .sort((a, b) => (a.deviceId || "").localeCompare(b.deviceId || ""));

    if (availableDevices.length === 0) {
      // No CLI flag reaches this path, so the opt-in is env-var only here.
      const gate = getDeviceCreationGate();
      if (gate.isCreationAllowed()) {
        logger.info(
          `[DeviceSessionManager] No available iOS simulators found; creating one (gate: ${gate.describeSource()})`,
        );
        const deadlineMs = this.runnerReadinessTimer.now() + 300_000;
        let lifecycleLease: VirtualDeviceLifecycleLease | undefined;
        try {
          const provisioner = createDefaultDeviceProvisioner(() => this.simctl, {
            reserveBeforeCreate: async (identity) => {
              lifecycleLease = await this.lifecycleCoordinator.reserve(
                { kind: "selector", platform: "ios", selector: identity.name },
                { operation: "start", deadlineMs, signal: options?.signal },
              );
              return lifecycleLease.signal;
            },
            bindAfterCreate: async (device) => {
              await this.bindCreatedIosReadinessIdentity(lifecycleLease, device);
            },
          });
          const provisioned = await provisioner.provision({ platform: "ios" }, options?.signal);
          this.assertCreatedIosReservation(lifecycleLease, provisioned);
          return await this.runWithLifecycleLease(lifecycleLease, options, async (signal) => {
            perf.startOperation("bootSimulator");
            const createdDevice = await runWithAbortSignal(
              signal,
              async () => await this.simctl!.bootSimulator(provisioned.deviceId!),
            );
            perf.endOperation("bootSimulator");
            if (createdDevice.deviceId === provisioned.deviceId) {
              await this.simctl!.presentSimulatorAfterStart(
                provisioned.deviceId,
                this.idGenerator.next(),
                signal,
              );
            }
            IOSCtrlProxyClient.resumeAfterDeviceStart(provisioned.deviceId!);
            perf.startOperation("verifyDevice");
            await this.verifyIosDevice(provisioned.deviceId!, { ...options, signal });
            perf.endOperation("verifyDevice");
            return createdDevice;
          }).catch(async (error) => {
            logger.warn(
              `[DeviceSessionManager] Rolling back created iOS simulator '${provisioned.name}' ` +
                `(${provisioned.deviceId}) after boot/verify failure: ${errorMessage(error)}`,
            );
            // Cancellation cleanup must not inherit an already-aborted request signal.
            const cleanupSignal = new AbortController().signal;
            await this.simctl!.deleteSimulator(provisioned.deviceId!, {
              signal: cleanupSignal,
            }).catch((deleteError) => {
              logger.warn(
                `[DeviceSessionManager] Failed to roll back created iOS simulator ` +
                  `'${provisioned.name}' (${provisioned.deviceId}): ${errorMessage(deleteError)}`,
              );
            });
            throw toActionableError(
              error,
              `Failed to boot/verify created iOS simulator '${provisioned.name}' (${provisioned.deviceId})`,
            );
          });
        } finally {
          lifecycleLease?.release();
        }
      }

      if (unavailableDevices.length > 0) {
        const diagnostics = unavailableDevices
          .map(
            (device) =>
              `${device.name} (${device.deviceId ?? "unknown ID"}): ${device.availabilityError ?? "unavailable"}`,
          )
          .join("; ");
        throw new ActionableError(
          `No available iOS simulators. Unavailable simulators: ${diagnostics}.`,
        );
      }

      throw new ActionableError(
        "No iOS simulators are available. Please create an iOS simulator using Xcode or the Simulator app.",
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
      logger.info(
        `[DeviceSessionManager] Selected booted iOS simulator ${device.name} (${device.deviceId})`,
      );
      return await this.withLifecycleStart(
        { platform: "ios", stableId: device.deviceId! },
        options,
        async (signal) => {
          IOSCtrlProxyClient.resumeAfterDeviceStart(device.deviceId!);
          perf.startOperation("verifyDevice");
          await this.verifyIosDevice(device.deviceId!, { ...options, signal });
          perf.endOperation("verifyDevice");
          return device;
        },
      );
    }

    // No booted devices - boot the first available simulator
    const device = availableDevices[0];
    const deviceId = device.deviceId!;
    logger.info(`[DeviceSessionManager] Booting iOS simulator ${device.name} (${deviceId})...`);

    return await this.withLifecycleStart(
      { platform: "ios", stableId: deviceId },
      options,
      async (signal) => {
        perf.startOperation("bootSimulator");
        const bootedDevice = await runWithAbortSignal(
          signal,
          async () => await this.simctl!.bootSimulator(deviceId),
        );
        perf.endOperation("bootSimulator");
        if (bootedDevice.deviceId === deviceId) {
          await this.simctl!.presentSimulatorAfterStart(deviceId, this.idGenerator.next(), signal);
        }
        IOSCtrlProxyClient.resumeAfterDeviceStart(deviceId);
        perf.startOperation("verifyDevice");
        await this.verifyIosDevice(deviceId, { ...options, signal });
        perf.endOperation("verifyDevice");
        return bootedDevice;
      },
    );
  }

  private async revalidateCreatedIosDevice(deviceId: string): Promise<StableVirtualDeviceIdentity> {
    const images = await this.simctl!.listSimulatorImages();
    const current = images.find((image) => image.deviceId === deviceId);
    if (!current) {
      throw new ActionableError(
        `Created iOS simulator '${deviceId}' disappeared during lifecycle wait`,
      );
    }
    return { platform: "ios", stableId: deviceId };
  }

  private async withLifecycleStart<T>(
    identity: StableVirtualDeviceIdentity | VirtualDeviceLifecycleIdentity,
    options: DeviceReadyOptions | undefined,
    operation: (signal: AbortSignal, hold: LifecycleStartHold) => Promise<T>,
  ): Promise<T> {
    const lifecycleLease = await this.lifecycleCoordinator.reserve(
      "kind" in identity ? identity : { kind: "stable", ...identity },
      {
        operation: "start",
        deadlineMs: this.runnerReadinessTimer.now() + 300_000,
        signal: options?.signal,
      },
    );
    const held: Promise<unknown>[] = [];
    try {
      return await this.runWithLifecycleLease(lifecycleLease, options, (signal) =>
        operation(signal, {
          lease: lifecycleLease,
          holdLeaseUntil: (settlement) => {
            held.push(settlement);
          },
        }),
      );
    } finally {
      if (held.length === 0) {
        lifecycleLease.release();
      } else {
        // An emulator this start spawned is still shutting down and holds its AVD
        // lock files: the stable key is not free until it is confirmed gone (#10075).
        void Promise.allSettled(held).then(() => lifecycleLease.release());
      }
    }
  }

  /**
   * Starts the device, and when the launch is cancelled after the emulator was
   * spawned, takes the child from the cancellation error and terminates it with the
   * shared SIGTERM -> bounded wait -> SIGKILL escalation, holding the AVD lease until
   * its exit is confirmed. The launch rejects the moment the request aborts, so
   * without this the lease would be released while the child is still shutting down
   * and a following start of the same AVD could spawn a second emulator (#10075).
   */
  private async startDeviceOwningCancelledLaunch(
    image: DeviceInfo,
    hold: LifecycleStartHold,
  ): Promise<ChildProcess | null> {
    try {
      return await this.deviceUtils.startDevice(image);
    } catch (error) {
      if (isEmulatorLaunchCancelledError(error) && error.process) {
        hold.holdLeaseUntil(
          terminateOwnedEmulatorProcess(error.process, image.name, this.runnerReadinessTimer, {
            markHeldByUnkillableProcess: (pid) => hold.lease.markHeldByUnkillableProcess?.(pid),
          }).then((outcome) => (outcome.state === "survived" ? outcome.gone : undefined)),
        );
      }
      throw error;
    }
  }

  private async runWithLifecycleLease<T>(
    lifecycleLease: VirtualDeviceLifecycleLease,
    options: DeviceReadyOptions | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signals = [options?.signal, lifecycleLease.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    return await operation(signals.length === 1 ? signals[0] : AbortSignal.any(signals));
  }

  /**
   * Register push update listener for an iOS device to clear ObserveScreen cache when UI changes.
   * This is called when CtrlProxy iOS is successfully connected.
   */
  private registerPushUpdateListener(device: BootedDevice): void {
    const deviceId = device.deviceId;
    try {
      const manager = this.provider.getIOSCtrlProxyManager(device);
      const xcTestClient = this.provider.getIOSCtrlProxyClient(device, manager.getServicePort());
      if (DeviceSessionManager.pushUpdateListenersRegistered.has(xcTestClient)) {
        return;
      }

      const observeCache = this.provider.getObserveScreenCache();
      xcTestClient.onPushUpdate(() => {
        logger.info(
          `[DeviceSessionManager] Received iOS UI change notification for ${deviceId}, clearing ObserveScreen cache`,
        );
        observeCache.clearForDevice(deviceId);
      });

      DeviceSessionManager.pushUpdateListenersRegistered.add(xcTestClient);
      logger.info(`[DeviceSessionManager] Registered push update listener for ${deviceId}`);
    } catch (error) {
      logger.warn(
        `[DeviceSessionManager] Failed to register push update listener for ${deviceId}: ${error}`,
      );
    }
  }
}
