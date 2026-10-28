import { getDefaultSimulatorCreationService } from "../../features/iosTemplates/defaultSimulatorCreationService";
import type { BootedDeviceDiscoveryOptions } from "../../devices/deviceDiscoveryContracts";
import { AsyncLocalStorage } from "node:async_hooks";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { RunnerReadinessService } from "../../ctrlProxy/RunnerReadinessService";
import { ActiveDeviceSelection } from "../../devices/ActiveDeviceSelection";
import { BootedDeviceDiscoveryIncompleteError } from "../../devices/deviceBootService";
import { getDeviceCreationGate } from "../../devices/deviceCreationGate";
import {
  createDefaultDeviceProvisioner,
  type ProvisionedDevice,
} from "../../devices/deviceProvisioning";
import {
  assertAndroidImageRunningStateKnown,
  PHYSICAL_IOS_SCAN_BUDGET_MS,
  waitForDeviceReadyOrCancel,
} from "../../devices/deviceUtils";
import { describeDevices } from "../../devices/runningReadTarget";
import {
  getVirtualDeviceLifecycleCoordinator,
  type StableVirtualDeviceIdentity,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleIdentity,
  type VirtualDeviceLifecycleLease,
} from "../../devices/virtualDeviceLifecycleCoordinator";
import { getSharedBootAdmissionGates } from "../../features/bootAdmission/sharedBootAdmissionGates";
import type { IosBootInstrumentation } from "../../features/iosSimFleet/IosBootInstrumentation";
import { createDefaultIosBootInstrumentation } from "../../features/iosSimFleet/defaultIosBootInstrumentation";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import { CtrlProxyForwardOwnershipUnreadableError } from "../../features/observe/android/foreignCtrlProxyForwardEvidence";
import { ctrlProxyClientLifecycle } from "../../features/observe/ctrlProxyClientLifecycle";
import { IOSCtrlProxyClient } from "../../features/observe/ios";
import type { IosCtrlProxy } from "../../features/observe/ios/IOSCtrlProxyClient";
import {
  ActionableError,
  type AndroidOrIosPlatform,
  BootedDevice,
  DeviceInfo,
  isAndroidOrIosPlatform,
  Platform,
  SomePlatform,
  toActionableError,
} from "../../models";
import { DeviceOwnedByOtherDaemonError } from "../../models/deviceAcquisitionRefusals";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { trackProcess, waitForExit } from "../../utils/ChildProcessTracker";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import {
  createGlobalPerformanceTracker,
  createPerformanceTracker,
} from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { daemonDeviceAdmissionGate, DeviceAdmissionGate } from "../../utils/deviceAdmissionGate";
import {
  ambientDeviceExecutionBinding,
  type DeviceExecutionBinding,
} from "../../utils/deviceExecutionBinding";
import { deviceReadinessLockKey, withDeviceReadinessLock } from "../../utils/deviceReadinessLock";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { PlatformDeviceManager } from "../../utils/interfaces/DeviceUtils";
import { isIosPhysicalUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { checkIosCtrlProxyOverride } from "../../utils/iosCtrlProxyOverride";
import { logger } from "../../utils/logger";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../../utils/runnerReadinessConfig";
import { resolveAppearanceSessionKey } from "../appearanceSessionKey";
import {
  applyAppearanceOnConnect,
  type AppearanceOnConnectDependencies,
} from "../applyAppearanceOnConnect";
import { storeSetupTiming } from "../setupTiming";
import { createDefaultBindingExclusion } from "../sessionBroker/provisioning/exclusion";
import { selectReadinessAutoStartImage } from "./readinessAutoStart";
import { AndroidCtrlProxyReadiness } from "./AndroidCtrlProxyReadiness";
import { rollBackCreatedIosSimulator } from "./CreatedIosSimulatorRollback";
import {
  type ConnectedPlatformScan,
  type ConnectedPlatformScanOptions,
  createDefaultDeviceClientProvider,
  type DeviceClientProvider,
  type DeviceClientSimctl,
  type DeviceReadinessContract,
  type DeviceReadinessLevel,
  type DeviceReadinessOptions,
  type DeviceReadyOptions,
  type ResolvedDeviceIdentity,
} from "./DeviceReadinessContracts";
import { ReadinessSelection } from "./ReadinessSelection";
import { lifecycleIdentityForDevice, type LifecycleStartHold } from "./readinessLifecycleIdentity";
import {
  assertReadBootNotStoppedWhileWaiting,
  iosReadNotBootedMessage,
  runWithLifecycleLease,
  startDeviceOwningCancelledLaunch,
} from "./readinessLifecycleStart";
import {
  assertIosDeviceAvailable,
  assertUsableIosOverride,
  verifyAndroidWindow,
} from "./readinessValidation";
export {
  type ConnectedPlatformScan,
  type ConnectedPlatformScanOptions,
  createDefaultDeviceClientProvider,
  type DeviceClientProvider,
  type DeviceClientSimctl,
  type DeviceReadinessLevel,
  type DeviceReadinessOptions,
  deviceReadinessRank,
  type DeviceReadyOptions,
  type ResolvedDeviceIdentity,
} from "./DeviceReadinessContracts";
export { isScanAuthoritativeFor } from "./readinessLifecycleIdentity";

export { PHYSICAL_IOS_SCAN_BUDGET_MS };

export class DeviceReadiness implements DeviceReadinessContract {
  private readonly selection = new ActiveDeviceSelection();
  private readonly admissionGate: DeviceAdmissionGate;
  private readonly executionBinding: DeviceExecutionBinding;
  private readonly readinessSelection: ReadinessSelection;
  private readonly provider: DeviceClientProvider;
  private readonly adbFactory: AdbClientFactory;
  private readonly runnerReadinessService: RunnerReadinessService;
  private readonly runnerReadinessTimer: Timer;
  private readonly bindingExclusion;
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
  private static pushUpdateListenersRegistered: WeakSet<IosCtrlProxy> = new WeakSet();

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
    this.bindingExclusion =
      options.bindingExclusion ?? createDefaultBindingExclusion(this.runnerReadinessTimer);
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
      applyAppearanceOnConnect: (device, sessionId) =>
        applyAppearanceOnConnect(
          device,
          this.appearanceOnConnectDependencies,
          resolveAppearanceSessionKey(sessionId),
        ),
      resumeAfterDeviceStart: (platform, deviceId) =>
        ctrlProxyClientLifecycle.resumeAfterDeviceStart(platform, deviceId),
      resumeReadBootClient: (platform, deviceId) => {
        // A watch has no CtrlProxy client to resume.
        if (!isAndroidOrIosPlatform(platform)) {
          return;
        }
        const clients: Record<
          AndroidOrIosPlatform,
          typeof AndroidCtrlProxyClient | typeof IOSCtrlProxyClient
        > = { android: AndroidCtrlProxyClient, ios: IOSCtrlProxyClient };
        clients[platform].resumeAfterDeviceStart(deviceId);
      },
      adbFactory: this.adbFactory,
      checkedAndroidOwnership: this.checkedAndroidOwnership,
      findOrStartDevice: (...args) => this.findOrStartDevice(...args),
      get deviceUtils() {
        return owner.deviceUtils;
      },
      bootAndroidReadinessImage: (...args) => this.bootAndroidReadinessImage(...args),
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
    reason: "create" | "restart" = "restart",
  ): Promise<BootedDevice> {
    return await this.iosBootInstrumentation.run(
      {
        udid,
        reason,
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

  public static createInstance(
    provider: DeviceClientProvider = createDefaultDeviceClientProvider(),
    adbFactory?: AdbClientFactory,
    options?: DeviceReadinessOptions,
  ): DeviceReadiness {
    return new DeviceReadiness(provider, adbFactory, options);
  }

  /**
   * Get the platform-aware device discovery manager shared by this session manager.
   */
  public getPlatformDeviceManager(): PlatformDeviceManager {
    return this.deviceUtils;
  }

  public getExplicitDevicePin(connectionId?: string): BootedDevice | undefined {
    return this.selection.getPin(connectionId);
  }

  public setExplicitDevicePin(device: BootedDevice, connectionId?: string): void {
    this.selection.setPin(device, connectionId);
  }

  public clearConnectionDevicePin(connectionId: string): void {
    this.selection.clearConnection(connectionId);
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

  public listBootedAndroidDevices(
    options?: Pick<
      BootedDeviceDiscoveryOptions,
      "signal" | "androidTargetDeviceId" | "skipAndroidProfileEnrichment"
    >,
  ): Promise<BootedDevice[]> {
    return this.readinessSelection.listBootedAndroidDevicesForSelection({
      ...options,
      bypassAndroidDeviceListCache: true,
    });
  }

  public verifyAndroidCtrlProxyServiceReady(
    device: BootedDevice,
    options?: { signal?: AbortSignal; timeoutMs?: number; noRetry?: boolean },
  ): Promise<boolean> {
    const verify = () =>
      this.provider
        .getAndroidCtrlProxyClient(device)
        .verifyServiceReady(options?.noRetry ? 1 : 2, 200, options?.timeoutMs ?? 2000);
    return options?.signal ? runWithAbortSignal(options.signal, verify) : verify();
  }

  public async readAndroidCtrlProxySnapshotIdentity(
    device: BootedDevice,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const manager = this.provider.getAndroidCtrlProxyManager(device);
    if (!manager.readSnapshotIdentity) {
      throw new ActionableError("Android snapshot CtrlProxy identity provider is unavailable");
    }
    return manager.readSnapshotIdentity(signal);
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
    await verifyAndroidWindow(
      { getWindow: (target) => this.provider.getWindow(target), adbFactory: this.adbFactory },
      device,
      resolvedIdentity,
      options,
    );

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
      if (options?.intent === "read") {
        throw new ActionableError(
          iosReadNotBootedMessage(deviceInfo.name, deviceId, deviceInfo.state),
        );
      }
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
    const deviceImage = await selectReadinessAutoStartImage(availableImages, this.bindingExclusion);
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
        assertReadBootNotStoppedWhileWaiting(deviceImage, options, hold.lease);
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
  private async rollBackCreatedIosSimulator(
    created: { name: string; deviceId?: string },
    failure: unknown,
  ): Promise<void> {
    return rollBackCreatedIosSimulator(
      {
        simctl: () => this.simctl,
        provider: this.provider,
        runnerReadinessTimer: this.runnerReadinessTimer,
      },
      created,
      failure,
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
          `[DeviceReadiness] No available iOS simulators found; creating one (gate: ${gate.describeSource()})`,
        );
        const deadlineMs = this.runnerReadinessTimer.now() + 300_000;
        let lifecycleLease: VirtualDeviceLifecycleLease | undefined;
        let created: ProvisionedDevice | undefined;
        try {
          const provisioner = createDefaultDeviceProvisioner(
            () => this.simctl,
            {
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
            },
            getDefaultSimulatorCreationService(() => this.simctl),
          );
          // simctl may already have created it: a failed identity bind must not orphan it (#11100).
          const { provisioned, lease } = await this.rollBackCreatedIosOnFailure(
            () => created,
            async () => {
              const device = await provisioner.provision({ platform: "ios" }, options?.signal);
              this.assertCreatedIosReservation(lifecycleLease, device);
              return { provisioned: device, lease: lifecycleLease };
            },
          );
          return await runWithLifecycleLease(lease, options, async (signal) => {
            perf.startOperation("bootSimulator");
            const createdDevice = await this.bootIosSimulatorAdmitted(
              this.simctl!,
              provisioned,
              provisioned.deviceId!,
              signal,
              "create",
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
    const device = await selectReadinessAutoStartImage(availableDevices, this.bindingExclusion);
    return await this.bootIosReadinessImage(device, options, perf);
  }

  /** Boot an exact image for acquisition or explicit start. */
  private async bootIosReadinessImage(
    device: DeviceInfo,
    options?: DeviceReadyOptions,
    perf = createGlobalPerformanceTracker(),
  ): Promise<BootedDevice> {
    const deviceId = device.deviceId!;
    if (options?.intent === "read") {
      throw new ActionableError(iosReadNotBootedMessage(device.name, deviceId));
    }
    logger.info(`[DeviceReadiness] Booting iOS simulator ${device.name} (${deviceId})...`);

    return await this.withLifecycleStart(
      { platform: "ios", stableId: deviceId },
      options,
      async (signal) => {
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
      return await runWithLifecycleLease(lifecycleLease, options, (signal) =>
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
  private async startDeviceOwningCancelledLaunch(
    image: DeviceInfo,
    hold: LifecycleStartHold,
  ): Promise<ChildProcess | null> {
    return startDeviceOwningCancelledLaunch(
      { deviceUtils: () => this.deviceUtils, runnerReadinessTimer: this.runnerReadinessTimer },
      image,
      hold,
    );
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
