import { AsyncLocalStorage } from "node:async_hooks";
import { ActiveDeviceSelection } from "../../devices/ActiveDeviceSelection";
import { ctrlProxyClientLifecycle } from "../../features/observe/ctrlProxyClientLifecycle";
import { CtrlProxyForwardOwnershipUnreadableError } from "../../features/observe/android/foreignCtrlProxyForwardEvidence";
import { describeDevices } from "../../devices/runningReadTarget";
import { daemonDeviceAdmissionGate, DeviceAdmissionGate } from "../../utils/deviceAdmissionGate";
import {
  ambientDeviceExecutionBinding,
  type DeviceExecutionBinding,
} from "../../utils/deviceExecutionBinding";
import { errorMessage } from "../../utils/describeUnknownError";
import { isIosSimulatorAlreadyStoppedError } from "../../utils/ios-cmdline-tools/simulatorStateErrors";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import {
  ActionableError,
  BootedDevice,
  DeviceInfo,
  Platform,
  SomePlatform,
  toActionableError,
} from "../../models";
import {
  assertAndroidImageRunningStateKnown,
  type DeviceManagerSimCtl,
  PHYSICAL_IOS_SCAN_BUDGET_MS,
  waitForDeviceReadyOrCancel,
} from "../../devices/deviceUtils";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosPhysicalUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import type { IosPhysicalDeviceLister } from "../../utils/ios-cmdline-tools/DevicectlDeviceLister";
import { type DiscoverySource } from "../../utils/discoverySource";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { Window as WindowImpl } from "../../features/observe/Window";
import type { Window } from "../../features/observe/interfaces/Window";
import { logger } from "../../utils/logger";
import type { CtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager, CtrlProxyIosManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { BootedDeviceDiscoveryIncompleteError } from "../../devices/deviceBootService";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { PlatformDeviceManager } from "../../utils/interfaces/DeviceUtils";
import { getDeviceCreationGate } from "../../devices/deviceCreationGate";
import {
  createDefaultDeviceProvisioner,
  type IosSimulatorCreator,
  type ProvisionedDevice,
} from "../../devices/deviceProvisioning";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import type { AndroidCtrlProxy } from "../../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../features/observe/ios";
import type { IOSCtrlProxy } from "../../features/observe/ios/IOSCtrlProxyClient";
import { RealObserveScreen } from "../../features/observe/ObserveScreen";
import type { ObserveScreenCache } from "../../models/ObserveScreenCache";
import {
  createPerformanceTracker,
  createGlobalPerformanceTracker,
} from "../../utils/PerformanceTracker";
import { storeSetupTiming } from "../setupTiming";
import {
  applyAppearanceOnConnect,
  type AppearanceOnConnectDependencies,
} from "../applyAppearanceOnConnect";
import { resolveAppearanceSessionKey } from "../appearanceSessionKey";
import { checkIosCtrlProxyOverride } from "../../utils/iosCtrlProxyOverride";
import { RunnerReadinessService } from "../../ctrlProxy/RunnerReadinessService";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { getSharedBootAdmissionGates } from "../../features/bootAdmission/sharedBootAdmissionGates";
import { createDefaultIosBootInstrumentation } from "../../features/iosSimFleet/defaultIosBootInstrumentation";
import type { IosBootInstrumentation } from "../../features/iosSimFleet/IosBootInstrumentation";
import { serverConfig } from "../../utils/ServerConfig";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../../utils/runnerReadinessConfig";
import { trackProcess, waitForExit } from "../../utils/ChildProcessTracker";
import {
  getVirtualDeviceLifecycleCoordinator,
  type StableVirtualDeviceIdentity,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleIdentity,
  type VirtualDeviceLifecycleLease,
} from "../../devices/virtualDeviceLifecycleCoordinator";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { isEmulatorLaunchCancelledError } from "../../utils/android-cmdline-tools/EmulatorLaunchCancelledError";
import { terminateOwnedEmulatorProcess } from "../../devices/coldBootProcessTermination";
import { DeviceOwnedByOtherDaemonError } from "../../models/deviceAcquisitionRefusals";
import { deviceReadinessLockKey, withDeviceReadinessLock } from "../../utils/deviceReadinessLock";
import {
  DefaultDeviceClientProvider,
  type ObserveClientFactories,
} from "./DefaultDeviceClientProvider";
import { type LifecycleStartHold, lifecycleIdentityForDevice } from "./readinessLifecycleIdentity";
import { AndroidCtrlProxyReadiness } from "./AndroidCtrlProxyReadiness";
import { ReadinessSelection } from "./ReadinessSelection";
import {
  androidReadinessWindowDevice,
  assertAndroidActiveWindow,
  assertIosDeviceAvailable,
  assertUsableIosOverride,
} from "./readinessValidation";
/**
 * The simctl surface the session manager drives, plus what the device manager built from it
 * needs. Exactly what consumers use, so a fake (`FakeSimctl`) satisfies it without a cast.
 */
export type DeviceClientSimctl = DeviceManagerSimCtl &
  IosSimulatorCreator &
  Pick<SimCtl, "bootSimulator" | "getDeviceInfo" | "presentSimulatorAfterStart">;

/**
 * Provider interface for device clients - enables dependency injection for testing
 */
export interface DeviceClientProvider {
  getAdb(): AdbExecutor;
  getSimctl(): DeviceClientSimctl | undefined;
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

/** Observe-layer clients wired at the composition root, so the provider imports none of them. */
const defaultObserveClientFactories: ObserveClientFactories = {
  androidCtrlProxyClient: (device) => AndroidCtrlProxyClient.getInstance(device),
  iosCtrlProxyClient: (device, port) => IOSCtrlProxyClient.getInstance(device, port),
  createWindow: (device, adbFactory) => new WindowImpl(device, adbFactory),
  observeScreenCache: () => RealObserveScreen.defaultObserveScreenCache,
};

/** The production provider, with the observe-layer clients injected. */
export function createDefaultDeviceClientProvider(
  adbFactory?: AdbClientFactory,
): DefaultDeviceClientProvider {
  return new DefaultDeviceClientProvider(defaultObserveClientFactories, adbFactory);
}

/**
 * Interface for device session management
 * Handles device detection, verification, and lifecycle for Android and iOS platforms
 */
export interface DeviceReadiness {
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
export { isScanAuthoritativeFor } from "./readinessLifecycleIdentity";

export type DeviceReadinessLevel = "booted" | "automationReady";

/** Same cadence as the deleteDevice absence verification (DEVICE_SHUTDOWN_POLL_INTERVAL_MS). */
const CREATED_IOS_ABSENCE_POLL_MS = 1_000;
const CREATED_IOS_ABSENCE_TIMEOUT_MS = 10_000;

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
  /**
   * What the caller will do with the device. A `read` gets only the readiness reading needs: no
   * current-device pin or appearance write (#11641). Defaults to `control`.
   * A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
   * (owner decision 2026-10-12, #11964). Android readiness may write CtrlProxy accessibility settings.
   * A read may boot only the `deviceId` supplied on this call, after alias resolution.
   * Platform-only selection, a setActiveDevice pin, and a cached current device are not
   * explicit IDs. Session-bound calls keep control readiness (toolRegistry does not mark them read).
   */
  intent?: "read" | "control";
  /** Last read ownership check after image discovery, before any lifecycle or boot work. */
  beforeReadBoot?: (image: DeviceInfo) => Promise<void>;
  /** Resolved read identity check before runner resume or verification. */
  beforeReadReadiness?: (device: BootedDevice) => Promise<void>;
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

export { PHYSICAL_IOS_SCAN_BUDGET_MS };

export interface DeviceReadinessOptions {
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
  /**
   * Capacity gating and boot-duration recording for simulator boots this manager starts itself
   * (`findOrStartIosDevice`). Defaults to the process-wide iOS gate (#11236).
   */
  iosBootInstrumentation?: IosBootInstrumentation;
}

export class DeviceReadiness implements DeviceReadiness {
  private readonly selection = new ActiveDeviceSelection();
  private static instance: DeviceReadiness;
  private static defaultProvider: DeviceClientProvider | undefined;
  private readonly admissionGate: DeviceAdmissionGate;
  private readonly executionBinding: DeviceExecutionBinding;
  private readonly readinessSelection: ReadinessSelection;
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
  private iosBootInstrumentationInstance: IosBootInstrumentation | undefined;
  private readonly appearanceOnConnectDependencies:
    | Partial<AppearanceOnConnectDependencies>
    | undefined;

  // Client recreation after an iOS device restart needs a fresh callback.
  private static pushUpdateListenersRegistered: WeakSet<IOSCtrlProxy> = new WeakSet();

  private constructor(
    provider: DeviceClientProvider,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    options: DeviceReadinessOptions = {},
  ) {
    this.admissionGate = options.admissionGate ?? daemonDeviceAdmissionGate;
    this.executionBinding = options.executionBinding ?? ambientDeviceExecutionBinding;
    this.provider = provider;
    this.androidCtrlProxyReadiness = new AndroidCtrlProxyReadiness({
      provider,
      checkedAndroidOwnership: this.checkedAndroidOwnership,
      errors: { DeviceOwnedByOtherDaemonError, CtrlProxyForwardOwnershipUnreadableError },
      storeSetupTiming,
    });
    this.adbFactory = adbFactory;
    this.runnerReadinessTimer = options.runnerReadinessTimer ?? defaultTimer;
    this.physicalIosScanBudgetMs = options.physicalIosScanBudgetMs ?? PHYSICAL_IOS_SCAN_BUDGET_MS;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.iosBootInstrumentationInstance = options.iosBootInstrumentation;
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
    const owner = this;
    this.readinessSelection = new ReadinessSelection({
      detectConnectedPlatformsWithStatus: (...args) =>
        this.detectConnectedPlatformsWithStatus(...args),
      findProvidedReadinessImage: (...args) => this.findProvidedReadinessImage(...args),
      get adb() {
        return owner.adb;
      },
      get simctl() {
        return owner.simctl;
      },
      provider: this.provider,
      runnerReadinessTimer: this.runnerReadinessTimer,
      physicalIosScanBudgetMs: this.physicalIosScanBudgetMs,
      selection: this.selection,
      withLifecycleStart: (...args) => this.withLifecycleStart(...args),
      verifyDevice: (...args) => this.verifyDevice(...args),
      setCurrentDevice: (...args) => this.setCurrentDevice(...args),
      applyAppearanceOnConnect: (device, sessionId) =>
        applyAppearanceOnConnect(
          device,
          this.appearanceOnConnectDependencies,
          resolveAppearanceSessionKey(sessionId),
        ),
      resumeAfterDeviceStart: (platform, deviceId) =>
        ctrlProxyClientLifecycle.resumeAfterDeviceStart(platform, deviceId),
      resumeReadBootClient: (platform, deviceId) =>
        ({ android: AndroidCtrlProxyClient, ios: IOSCtrlProxyClient })[
          platform
        ].resumeAfterDeviceStart(deviceId),
      adbFactory: this.adbFactory,
      checkedAndroidOwnership: this.checkedAndroidOwnership,
      findOrStartDevice: (...args) => this.findOrStartDevice(...args),
      get deviceUtils() {
        return owner.deviceUtils;
      },
      bootAndroidReadinessImage: (...args) => this.bootAndroidReadinessImage(...args),
      bootIosReadinessImage: (...args) => this.bootIosReadinessImage(...args),
      clearExplicitDevicePin: (...args) => this.clearExplicitDevicePin(...args),
      admissionGate: this.admissionGate,
    });
  }

  private get adb(): AdbExecutor {
    if (!this._adb) {
      this._adb = this.provider.getAdb();
    }
    return this._adb;
  }

  private get simctl(): DeviceClientSimctl | undefined {
    return this.provider.getSimctl();
  }

  /** The process-wide iOS capacity gate unless overridden, built on first boot. */
  private get iosBootInstrumentation(): IosBootInstrumentation {
    if (!this.iosBootInstrumentationInstance) {
      const gates = getSharedBootAdmissionGates();
      this.iosBootInstrumentationInstance = createDefaultIosBootInstrumentation({
        timer: defaultTimer,
        history: gates.iosBootHistory,
        gate: gates.ios,
      });
    }
    return this.iosBootInstrumentationInstance;
  }

  /**
   * Boots a simulator through the shared iOS admission gate, so at the derived limit the boot
   * fails at once with the typed retryable `capacity_exhausted` refusal (#11236).
   */
  private async bootIosSimulatorAdmitted(
    simctl: Pick<DeviceClientSimctl, "bootSimulator">,
    device: { runtimeId?: string },
    udid: string,
    signal: AbortSignal,
  ): Promise<BootedDevice> {
    return await this.iosBootInstrumentation.run(
      {
        udid,
        runtime: device.runtimeId,
        timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
        signal,
      },
      async () => await runWithAbortSignal(signal, async () => await simctl.bootSimulator(udid)),
    );
  }

  private get androidEmulator(): AndroidEmulatorClient | undefined {
    return this.provider.getAndroidEmulator();
  }

  private get deviceUtils(): PlatformDeviceManager {
    return this.provider.getDeviceUtils();
  }

  public static getInstance(): DeviceReadiness {
    if (!DeviceReadiness.instance) {
      if (!DeviceReadiness.defaultProvider) {
        DeviceReadiness.defaultProvider = createDefaultDeviceClientProvider();
      }
      DeviceReadiness.instance = new DeviceReadiness(DeviceReadiness.defaultProvider);
    }
    return DeviceReadiness.instance;
  }

  public static createInstance(
    provider: DeviceClientProvider,
    adbFactory?: AdbClientFactory,
    options?: DeviceReadinessOptions,
  ): DeviceReadiness {
    return new DeviceReadiness(provider, adbFactory, options);
  }

  /**
   * Get the current device ID
   */
  public getCurrentDevice(): BootedDevice | undefined {
    return this.selection.currentDevice;
  }

  /**
   * Get the current platform
   */
  public getCurrentPlatform(): Platform | undefined {
    return this.selection.currentPlatform;
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
    this.selection.currentDevice = device;
    this.selection.currentPlatform = platform;

    if (platform === "android") {
      // Update AdbClient with new device ID - need a fresh client for the new device
      this._adb = this.adbFactory.create(device);
    }
  }

  public getExplicitDevicePin(): BootedDevice | undefined {
    return this.selection.explicitDevicePin;
  }

  public setExplicitDevicePin(device: BootedDevice): void {
    this.selection.explicitDevicePin = device;
  }

  public clearExplicitDevicePin(deviceId: string): void {
    this.selection.clearPinFor(deviceId);
  }

  /**
   * Detect the platform of connected devices
   */
  public async detectConnectedPlatforms(signal?: AbortSignal): Promise<BootedDevice[]> {
    return (await this.detectConnectedPlatformsWithStatus(signal)).devices;
  }
  public detectConnectedPlatformsWithStatus(
    signal?: AbortSignal,
    options?: ConnectedPlatformScanOptions,
  ): Promise<ConnectedPlatformScan> {
    return this.readinessSelection.detectConnectedPlatformsWithStatus(signal, options);
  }

  private readonly checkedAndroidOwnership = new AsyncLocalStorage<Set<string>>();
  private readonly androidCtrlProxyReadiness: AndroidCtrlProxyReadiness;

  /**
   * Ensure a device is ready for the specified platform and return its ID
   * Throws an error if both Android and iOS devices are connected when auto-detecting platform
   */
  public async ensureDeviceReady(
    platform: SomePlatform,
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice> {
    return this.checkedAndroidOwnership.run(new Set(), () =>
      this.readinessSelection.ensureDeviceReadyInCall(platform, providedDeviceId, options),
    );
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

  findProvidedReadinessImage(
    platform: SomePlatform,
    providedDeviceId: string,
    scan: ConnectedPlatformScan,
    options: DeviceReadyOptions,
  ): Promise<DeviceInfo | undefined> {
    return this.readinessSelection.findProvidedReadinessImage(
      platform,
      providedDeviceId,
      scan,
      options,
    );
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
   * Verify an Android device is connected and ready
   */
  public async verifyAndroidDevice(
    deviceId: string,
    options?: DeviceReadyOptions,
    resolvedIdentity?: ResolvedDeviceIdentity,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    deviceId = this.readinessSelection.canonicalAndroidId(deviceId);
    // Gate before discovery or a cached Window can use its pre-quarantine executor.
    // Identity reconciliation/lifting uses discovery directly, never readiness.
    this.admissionGate.assertDeviceActionable(deviceId, "to verify Android device readiness");
    this.executionBinding.bindDeviceExecution(deviceId);
    const allDevices = this.readinessSelection.mapAndroidReadinessRows(
      await this.adb.getBootedAndroidDevices(),
    );
    const device = allDevices.find((device) => device.deviceId === deviceId);

    if (!device) {
      throw new ActionableError(
        `Android device ${deviceId} is not connected. Available devices: ${describeDevices(allDevices)}`,
      );
    }
    // Check if we can get an active window from the device
    try {
      logger.info(`[DeviceReadiness] Verifying Android device ${deviceId} readiness`);

      const deviceForWindow = androidReadinessWindowDevice(device, resolvedIdentity);
      const window = this.provider.getWindow(deviceForWindow);

      const activeWindow = await window.getActive(true);
      assertAndroidActiveWindow(deviceId, activeWindow);
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
      () => this.androidCtrlProxyReadiness.ensureReady(deviceId, device, options),
      { signal: options?.signal },
    );
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
      assertUsableIosOverride(iosOverride);
    }

    if (!this.simctl) {
      throw new ActionableError("iOS simulator tools not available");
    }
    const deviceInfo = await this.simctl.getDeviceInfo(deviceId);
    options?.signal?.throwIfAborted();

    assertIosDeviceAvailable(deviceId, deviceInfo);

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
    assertUsableIosOverride(await checkIosCtrlProxyOverride());
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
        skipCtrlProxyDownload: this.androidCtrlProxyReadiness.skipCtrlProxyDownload(options),
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
    const allDevices = await this.readinessSelection.listBootedAndroidDevicesForSelection();
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
    return await this.bootAndroidReadinessImage(deviceImage, options, perf);
  }

  /** Shared exact-image launch; reads never substitute another AVD. */
  private async bootAndroidReadinessImage(
    deviceImage: DeviceInfo,
    options?: DeviceReadyOptions,
    perf = createGlobalPerformanceTracker(),
  ): Promise<BootedDevice> {
    assertAndroidImageRunningStateKnown(deviceImage);
    logger.info(`Starting Android emulator ${deviceImage}...`);
    return await this.withLifecycleStart(
      { platform: "android", stableId: deviceImage.name },
      options,
      async (signal, hold) => {
        if (options?.beforeReadBoot) {
          await options.beforeReadBoot(deviceImage);
          signal.throwIfAborted();
        }
        const running = await this.readinessSelection.recheckReadBootImage(deviceImage, {
          ...options,
          signal,
        });
        if (running) {
          return running;
        }
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
          {
            signal,
            timer: this.runnerReadinessTimer,
            cancelOwnedBoot: processTracker
              ? async () =>
                  await waitForExit(processTracker.process, processTracker.exitPromise, {
                    signal: "SIGTERM",
                    timer: this.runnerReadinessTimer,
                  })
              : undefined,
          },
        );
        perf.endOperation("waitForReady");

        if (!newDevice) {
          throw new ActionableError(`Failed to start Android emulator ${deviceImage}.`);
        }

        if (options?.intent === "read") {
          await options.beforeReadReadiness?.(newDevice);
          signal.throwIfAborted();
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

  private async rollBackCreatedIosOnFailure<T>(
    getCreated: () => ProvisionedDevice | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const created = getCreated();
      if (created) {
        await this.rollBackCreatedIosSimulator(created, error);
      }
      throw error;
    }
  }

  /** Deletes a simulator this request created and then failed to bind, boot or verify. */
  private async rollBackCreatedIosSimulator(
    created: { name: string; deviceId?: string },
    failure: unknown,
  ): Promise<void> {
    if (!created.deviceId) {
      logger.warn(
        `[DeviceReadiness] Cannot roll back created iOS simulator '${created.name}': no UDID.`,
      );
      return;
    }
    logger.warn(
      `[DeviceReadiness] Rolling back created iOS simulator '${created.name}' ` +
        `(${created.deviceId}) after failure: ${errorMessage(failure)}`,
    );
    // Cancellation cleanup must not inherit an already-aborted request signal.
    const cleanupSignal = new AbortController().signal;
    const device: BootedDevice = {
      name: created.name,
      platform: "ios",
      deviceId: created.deviceId,
    };
    let step = "retire runner";
    try {
      // Same order as the deleteDevice teardown: runner, shutdown, delete, verify absence.
      await this.retireCreatedIosRunner(device);
      step = "shut down";
      await this.shutDownCreatedIosSimulator(device, cleanupSignal);
      step = "delete";
      await this.simctl!.deleteSimulator(created.deviceId, { signal: cleanupSignal });
      step = "verify absence of";
      await this.verifyCreatedIosSimulatorAbsent(created.deviceId, cleanupSignal);
    } catch (cleanupError) {
      // The caller's failure is what explains the request; a rollback error never replaces it.
      const state = await this.readCreatedIosSimulatorState(created.deviceId, cleanupSignal);
      logger.warn(
        `[DeviceReadiness] Failed to ${step} created iOS simulator ` +
          `'${created.name}' (${created.deviceId}, state: ${state}); it may be left behind: ` +
          errorMessage(cleanupError),
        cleanupError,
      );
    }
  }

  /** Mirrors the teardown's pre-shutdown runner stop; a failure is logged, not fatal. */
  private async retireCreatedIosRunner(device: BootedDevice): Promise<void> {
    try {
      // Fence the observer first so the runner's socket close cannot reconnect and reboot the simulator.
      await IOSCtrlProxyClient.retireInstance(device.deviceId);
      await this.provider.getIOSCtrlProxyManager(device).stop();
    } catch (error) {
      logger.warn(
        `[DeviceReadiness] Failed to stop CtrlProxy iOS for created simulator ` +
          `${device.deviceId} before rollback: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async shutDownCreatedIosSimulator(
    device: BootedDevice,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.simctl!.killSimulator(device, { signal });
    } catch (error) {
      if (!isIosSimulatorAlreadyStoppedError(error)) {
        throw error;
      }
      // simctl reports the simulator is already Shutdown: the state the delete needs.
      logger.debug(
        `[DeviceReadiness] ${device.deviceId} was already shut down: ${errorMessage(error)}`,
      );
    }
  }

  private async verifyCreatedIosSimulatorAbsent(udid: string, signal: AbortSignal): Promise<void> {
    const deadlineMs = this.runnerReadinessTimer.now() + CREATED_IOS_ABSENCE_TIMEOUT_MS;
    for (;;) {
      const images = await this.simctl!.listSimulatorImages(undefined, {
        bypassCache: true,
        signal,
      });
      if (!images.some((image) => image.deviceId === udid)) {
        return;
      }
      if (this.runnerReadinessTimer.now() >= deadlineMs) {
        throw new ActionableError(`iOS simulator ${udid} is still listed after delete.`);
      }
      await this.runnerReadinessTimer.sleep(CREATED_IOS_ABSENCE_POLL_MS);
    }
  }

  private async readCreatedIosSimulatorState(udid: string, signal: AbortSignal): Promise<string> {
    try {
      const images = await this.simctl!.listSimulatorImages(undefined, {
        bypassCache: true,
        signal,
      });
      const image = images.find((candidate) => candidate.deviceId === udid);
      return image ? (image.state ?? "unknown") : "absent";
    } catch (error) {
      logger.debug(`[DeviceReadiness] Could not read state of ${udid}: ${errorMessage(error)}`);
      return "unknown";
    }
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
          `[DeviceReadiness] No available iOS simulators found; creating one (gate: ${gate.describeSource()})`,
        );
        const deadlineMs = this.runnerReadinessTimer.now() + 300_000;
        let lifecycleLease: VirtualDeviceLifecycleLease | undefined;
        let created: ProvisionedDevice | undefined;
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
              created = device;
              await this.bindCreatedIosReadinessIdentity(lifecycleLease, device);
            },
          });
          // simctl may already have created it: a failed identity bind must not orphan it (#11100).
          const { provisioned, lease } = await this.rollBackCreatedIosOnFailure(
            () => created,
            async () => {
              const device = await provisioner.provision({ platform: "ios" }, options?.signal);
              this.assertCreatedIosReservation(lifecycleLease, device);
              return { provisioned: device, lease: lifecycleLease };
            },
          );
          return await this.runWithLifecycleLease(lease, options, async (signal) => {
            perf.startOperation("bootSimulator");
            const createdDevice = await this.bootIosSimulatorAdmitted(
              this.simctl!,
              provisioned,
              provisioned.deviceId!,
              signal,
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
            await this.rollBackCreatedIosSimulator(provisioned, error);
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
    // The checked listing rethrows simctl failures: a timeout must refuse
    // rather than boot availableDevices[0] beside an already-booted one (#11103).
    const bootedDevices = await this.listBootedSimulatorsForSelection();
    perf.endOperation("checkBooted");
    bootedDevices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));

    if (bootedDevices.length > 0) {
      // Use the first booted device
      const device = bootedDevices[0];
      logger.info(
        `[DeviceReadiness] Selected booted iOS simulator ${device.name} (${device.deviceId})`,
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
    return await this.bootIosReadinessImage(device, options, perf);
  }

  /** Shared exact-image boot; a named read never reaches simulator creation. */
  private async bootIosReadinessImage(
    device: DeviceInfo,
    options?: DeviceReadyOptions,
    perf = createGlobalPerformanceTracker(),
  ): Promise<BootedDevice> {
    const deviceId = device.deviceId!;
    logger.info(`[DeviceReadiness] Booting iOS simulator ${device.name} (${deviceId})...`);

    return await this.withLifecycleStart(
      { platform: "ios", stableId: deviceId },
      options,
      async (signal) => {
        if (options?.beforeReadBoot) {
          await options.beforeReadBoot(device);
          signal.throwIfAborted();
        }
        const running = await this.readinessSelection.recheckReadBootImage(device, {
          ...options,
          signal,
        });
        if (running) {
          return running;
        }
        perf.startOperation("bootSimulator");
        const bootedDevice = await this.bootIosSimulatorAdmitted(
          this.simctl!,
          device,
          deviceId,
          signal,
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

  private async listBootedSimulatorsForSelection(): Promise<BootedDevice[]> {
    try {
      return await this.simctl!.getBootedSimulatorsChecked();
    } catch (error) {
      throw new BootedDeviceDiscoveryIncompleteError("ios", {
        code: "failed",
        message: errorMessage(error),
        retryable: true,
      });
    }
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
      if (DeviceReadiness.pushUpdateListenersRegistered.has(xcTestClient)) {
        return;
      }

      const observeCache = this.provider.getObserveScreenCache();
      xcTestClient.onPushUpdate(() => {
        logger.info(
          `[DeviceReadiness] Received iOS UI change notification for ${deviceId}, clearing ObserveScreen cache`,
        );
        observeCache.clearForDevice(deviceId);
      });

      DeviceReadiness.pushUpdateListenersRegistered.add(xcTestClient);
      logger.info(`[DeviceReadiness] Registered push update listener for ${deviceId}`);
    } catch (error) {
      logger.warn(
        `[DeviceReadiness] Failed to register push update listener for ${deviceId}: ${error}`,
      );
    }
  }
}
