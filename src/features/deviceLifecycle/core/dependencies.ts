import type { WatchSimulatorProvisioner } from "../../../utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import type { WatchSimulatorLifecycle } from "../../../utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import { getDefaultSimulatorCreationService } from "../../iosTemplates/defaultSimulatorCreationService";
import { type DevicePool } from "../../../daemon/devicePool";
import { defaultDaemonContext, daemonStateLikeFrom } from "../../../daemon/daemonContext";
import { bindingPoolGate } from "../../../daemon/sessionBroker/provisioning/poolGate";
import { type EmulatorProcessStopper } from "../../../utils/android-cmdline-tools/EmulatorProcessStop";
import { type QrPosterWriter } from "../../../utils/qr/QrPosterWriter";
import {
  type AdbClientFactory,
  unadmittedAdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { type Environment } from "../../../daemon/poolConfig";
import {
  type DeviceResourceController,
  DefaultDeviceResourceController,
} from "../../../utils/deviceResourceController";
import {
  type DeviceResourceObserver,
  DefaultDeviceResourceObserver,
} from "../../../utils/deviceResourceObserver";
import {
  type DeviceResourceReconciler,
  DefaultDeviceResourceReconciler,
} from "../../../utils/deviceResourceReconciler";
import { PlatformDeviceManager } from "../../../devices/deviceUtils";
import { type AvdManager } from "../../../utils/android-cmdline-tools/interfaces/AvdManager";
import { type DeviceMatcher, DefaultDeviceMatcher } from "../../../utils/deviceMatcher";
import {
  type DisplayInventoryProvider,
  defaultDisplayInventoryProvider,
} from "../../../devices/DisplayInventoryProvider";
import {
  type AppResourceDependencies,
  deviceLifecycleServerHost,
} from "../deviceLifecycleServerHost";
import { type RunnerReadinessRequest } from "../../../ctrlProxy/RunnerReadinessService";
import {
  type DeviceCreationGate,
  getDeviceCreationGate,
} from "../../../devices/deviceCreationGate";
import {
  type DeviceProvisioner,
  createDefaultDeviceProvisioner,
} from "../../../devices/deviceProvisioning";
import {
  type ExactDeviceProvisioner,
  createDefaultExactDeviceProvisioner,
} from "../../../devices/exactDeviceProvisioning";
import { Platform, BootedDevice, ActionableError } from "../../../models";
import { type BackoffPolicy } from "../../../utils/Backoff";
import { type BootCapacityReporter } from "../../bootAdmission/BootAdmissionGate";
import { type IdGenerator, defaultIdGenerator } from "../../../utils/IdGenerator";
import { type Timer, defaultTimer } from "../../../utils/SystemTimer";
import type { DaemonStateLike } from "../../../daemon/daemonState";
import {
  type VirtualDeviceLifecycleCoordinator,
  getVirtualDeviceLifecycleCoordinator,
} from "../../../devices/virtualDeviceLifecycleCoordinator";
import { type ProvisionDeviceLifecycleOutcome } from "../../../devices/provisionDeviceLifecycle";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { getInstalledAppsCacheWriteCoordinator } from "../../../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../../../db/dbWriteBarrier";
import { AndroidCtrlProxyClient } from "../../observe/android/AndroidCtrlProxyClient";
import { getHostEmulatorProcessStopper } from "../../../devices/hostEmulatorProcessStopper";
import { DeviceResourceApplicationRepository } from "../../../db/deviceResourceApplicationRepository";
import { IosDeviceResourceReader } from "../../../utils/iosDeviceResourceReader";
import { PlatformDeviceManagerFactory } from "../../../utils/factories/PlatformDeviceManagerFactory";
import { AvdManagerService } from "../../../utils/android-cmdline-tools/AvdManagerService";
import { getPerformanceMonitor } from "../../performance/PerformanceMonitor";
import { DeviceTeardownService } from "../../../devices/deviceTeardownService";
import { mergeDeviceToolsDependencies } from "../deviceLifecycleDependencyOverrides";
import { executionTracker } from "../../../daemon/executionTracker";
import type { ManufacturerProfileApplier } from "../../utility/personaExecutors";

export type { ManufacturerProfileApplier };

export function initializedDevicePool(): DevicePool | undefined {
  return defaultDaemonContext.fullDevicePool();
}

/** Generic provisionDevice never adopts a device a broker binding holds (#11174). */
export async function assertNotBindingDeviceForAdoption(device: {
  platform: "android" | "ios";
  stableId: string;
}): Promise<void> {
  await bindingPoolGate(initializedDevicePool()).assertNotAssignedToBinding?.({
    action: "provisionDevice",
    deviceId: device.stableId,
    platform: device.platform,
  });
}

export interface DeviceToolsDependencies {
  androidEmulatorProcessStopper: EmulatorProcessStopper;
  /** Renders `cameraPosterQr` payloads to a poster image; defaults to a file writer under the data dir. */
  cameraPosterQrWriter?: QrPosterWriter;
  androidAdbFactory: AdbClientFactory;
  env?: Environment;
  deviceResourceControllerFactory: () => DeviceResourceController;
  deviceResourceObserverFactory: () => DeviceResourceObserver;
  deviceResourceReconcilerFactory: () => DeviceResourceReconciler;
  deviceManagerFactory: () => PlatformDeviceManager;
  avdManagerFactory: () => Pick<AvdManager, "listDeviceImages">;
  deviceMatcherFactory: () => DeviceMatcher;
  displayInventory: DisplayInventoryProvider;
  appResourceDependencies?: AppResourceDependencies;
  notifyResourcesChanged: () => Promise<void>;
  notifyDeviceInventoryResourcesChanged: (installedAppResourcesChanged: boolean) => Promise<void>;
  syncInstalledAppResourceRegistry: () => Promise<boolean>;
  ensureCtrlProxyReady?: (request: RunnerReadinessRequest) => Promise<void>;
  /** Apple Watch simulator lookup and boot for startDevice (#14908); defaults to simctl. */
  watchSimulatorLifecycleFactory?: () => Pick<WatchSimulatorLifecycle, "findWatch" | "boot">;
  /** Apple Watch simulator adoption, creation and deletion (#15882); defaults to simctl. */
  watchSimulatorProvisionerFactory?: () => Pick<
    WatchSimulatorProvisioner,
    "provision" | "discardCreated" | "find" | "deleteAndConfirmAbsent"
  >;
  deviceCreationGateFactory: () => DeviceCreationGate;
  deviceProvisionerFactory: () => DeviceProvisioner;
  exactDeviceProvisionerFactory: (
    deviceManager: PlatformDeviceManager,
    deviceCreationGate: DeviceCreationGate,
  ) => ExactDeviceProvisioner;
  /**
   * Read-only boot capacity check run before creating a device that will be booted (#11236);
   * defaults to the process-wide admission gates.
   */
  checkBootCapacity?: (platform: Platform, signal?: AbortSignal) => Promise<void>;
  /** Delay between bounded discovery retries when an existing AVD might already be running. */
  provisionAndroidIdentityBackoff?: BackoffPolicy;
  /**
   * Applies a provisionDevice `deviceProfile` to the bound session's ready device (#14058);
   * defaults to the manufacturerProfile tool's executors.
   */
  manufacturerProfileApplier?: ManufacturerProfileApplier;
  /**
   * Per-platform boot capacity reporters the `listDevices` `capacity` field samples; defaults to
   * the process-wide admission gates, which probe adb/simctl/ps. Injected by the benchmark so the
   * listing runs without spawning host processes.
   */
  bootCapacityReporters?: Partial<Record<Platform, BootCapacityReporter>>;
  clearInstalledAppsForDevice: (deviceId: string) => Promise<void>;
  stopPerformanceMonitoring: (deviceId: string) => void;
  stopAndroidObservers: (device: BootedDevice) => Promise<void>;
  idGenerator: IdGenerator;
  timer: Timer;
  /** The daemon's session and device-pool state; sourced from DaemonContext by default. */
  daemonState: DaemonStateLike;
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  /**
   * Re-resolve an emulator's AVD name from the RUNTIME rather than from any
   * host-side cache (`emu avd name`). Resolves to undefined when the emulator
   * console cannot answer inside `timeoutMs`, which is the caller's REMAINING
   * deadline, not an independent budget. See {@link confirmPooledAvdIdentity}.
   */
  resolveRunningAndroidAvdName: (
    device: BootedDevice,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
}

/**
 * One in-flight provisionDevice request. Every call runs its own lifecycle;
 * nothing is shared between callers (#11065). Concurrent requests for the same
 * exact device are serialized by the device lifecycle lease and refused by the
 * session-ownership checks, not coalesced. `controller` aborts the lifecycle
 * when its caller goes away, so it never keeps booting a device and binding a
 * session that no client owns.
 */
export interface ActiveProvisionDeviceRequest {
  promise: Promise<Record<string, unknown>>;
  controller: AbortController;
  /** Last lifecycle recorded by the running request; feeds recovery evidence. */
  lifecycleEvidence: {
    lifecycle?: ProvisionDeviceLifecycleOutcome;
    /** Whether this request created the device or adopted it; sticky once observed. */
    ownership?: "created_by_request" | "adopted";
  };
}

export const activeProvisionDeviceRequests = new Set<ActiveProvisionDeviceRequest>();

/**
 * Cancel a request whose caller went away. Returns false when its lifecycle
 * had already settled, so there was nothing left to cancel.
 */
export function cancelProvisionDeviceRequest(
  request: ActiveProvisionDeviceRequest,
  cancellationReason?: unknown,
): boolean {
  if (!activeProvisionDeviceRequests.delete(request)) {
    return false;
  }
  request.controller.abort(
    cancellationReason ??
      new ActionableError("provisionDevice request was cancelled: its caller disconnected"),
  );
  return true;
}

/**
 * The CEILING on how long the runtime gets to name itself before a destructive
 * action gives up on verification. Short on purpose: the caller is holding a
 * lifecycle lease and a wedged console must not turn a kill into a hang. It is a
 * ceiling and never a floor — the probe is bounded by whichever is smaller, this
 * or the caller's remaining teardown/kill deadline, and an unanswered probe
 * REFUSES the action (see {@link confirmPooledAvdIdentity}).
 */
export const POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS = 3_000;

/**
 * Exported for tests only: the DEFAULT {@link
 * DeviceToolsDependencies.resolveRunningAndroidAvdName}. Production callers
 * reach it through `getDeviceToolsDependencies()`.
 */
export async function defaultResolveRunningAndroidAvdName(
  device: BootedDevice,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const { AndroidEmulatorClient } =
      await import("../../../utils/android-cmdline-tools/AndroidEmulatorClient");
    return await new AndroidEmulatorClient().resolveRunningAvdName(device, timeoutMs, signal);
  } catch (error) {
    if (signal?.aborted) {
      // Cancellation is not evidence about the runtime's identity, and reporting
      // it as "unresolved" would make killDevice raise an identity refusal --
      // and deleteDevice answer `target_identity_unresolved` -- for an action the
      // CALLER stopped. Propagate the cancellation instead (#6863 review).
      throw signal.reason ?? error;
    }
    // An unreachable console is one of the three expected outcomes of this
    // probe; "could not resolve" makes the caller REFUSE the destructive action,
    // so this is a warn-and-report-unresolved, never a swallow that proceeds.
    logger.warn(
      `[DeviceTools] Could not re-resolve the AVD name for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
}

export async function defaultNotifyDeviceInventoryResourcesChanged(
  installedAppResourcesChanged: boolean,
): Promise<void> {
  await deviceLifecycleServerHost.notifyBootedDeviceResourcesUpdated();
  await deviceLifecycleServerHost.notifyDeviceImageResourcesUpdated();
  if (installedAppResourcesChanged) {
    await deviceLifecycleServerHost.notifyInstalledAppResourceListChanged();
  }
}

export async function defaultClearInstalledAppsForDevice(deviceId: string): Promise<void> {
  const { InstalledAppsRepository } = await import("../../../db/installedAppsRepository");
  const repo = new InstalledAppsRepository();
  await getInstalledAppsCacheWriteCoordinator().invalidate(deviceId, () =>
    getDbWriteBarrier()
      .track(() => repo.clearDeviceSession(deviceId))
      .then(() => undefined),
  );
}

export async function defaultStopAndroidObservers(device: BootedDevice): Promise<void> {
  // Resolve the per-device singleton through the statically-imported class rather
  // than a runtime `import()`. On Windows the dynamic specifier resolved to a
  // second module record with its own empty `instances` registry, so
  // getExistingInstance returned null and the observer was never detached
  // (issue #5452 CI failure). A static import shares one class identity with the
  // observe feature that created the singleton, matching the iOS CtrlProxy path.
  const observer = AndroidCtrlProxyClient.getExistingInstance(device.deviceId);
  if (!observer) {
    return;
  }
  try {
    // Detaching the per-device CtrlProxy singleton disables its auto-reconnect,
    // health-check, screenshot-backoff, and work-profile loops so they stop
    // re-referencing the emulator transport while it shuts down.
    await observer.close();
  } finally {
    // close() disables auto-reconnect permanently, so evict the detached client
    // rather than let a re-booted same-serial emulator reuse a stale one.
    AndroidCtrlProxyClient.removeInstance(device.deviceId);
  }
}

export function createAndroidEmulatorProcessStopper(): EmulatorProcessStopper {
  return getHostEmulatorProcessStopper(getDeviceToolsDependencies().timer);
}

export let moduleDependencies: DeviceToolsDependencies | null = null;

export let androidProcessStopper: EmulatorProcessStopper | undefined;

export function getDeviceToolsDependencies(): DeviceToolsDependencies {
  if (!moduleDependencies) {
    moduleDependencies = {
      androidAdbFactory: unadmittedAdbClientFactory,
      daemonState: daemonStateLikeFrom(defaultDaemonContext),
      deviceResourceControllerFactory: () =>
        new DefaultDeviceResourceController(undefined, undefined, undefined, undefined, undefined, {
          applications: new DeviceResourceApplicationRepository(),
        }),
      deviceResourceObserverFactory: () =>
        new DefaultDeviceResourceObserver({ timer: getDeviceToolsDependencies().timer }),
      deviceResourceReconcilerFactory: () => {
        const deps = getDeviceToolsDependencies();
        return new DefaultDeviceResourceReconciler({
          controller: deps.deviceResourceControllerFactory(),
          observer: deps.deviceResourceObserverFactory(),
          identity: new IosDeviceResourceReader({ timer: deps.timer }),
          store: new DeviceResourceApplicationRepository(),
          timer: deps.timer,
        });
      },
      // The shared manager keeps devicectl caching/coalescing/last-good retention
      // and the Android model/arch caches across calls (#11063).
      deviceManagerFactory: () => PlatformDeviceManagerFactory.getInstance(),
      avdManagerFactory: () => new AvdManagerService(),
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      displayInventory: defaultDisplayInventoryProvider,
      notifyResourcesChanged: defaultNotifyResourcesChanged,
      notifyDeviceInventoryResourcesChanged: defaultNotifyDeviceInventoryResourcesChanged,
      syncInstalledAppResourceRegistry: () =>
        deviceLifecycleServerHost.syncInstalledAppResourceRegistry(
          getDeviceToolsDependencies().appResourceDependencies,
        ),
      deviceCreationGateFactory: () => getDeviceCreationGate(),
      deviceProvisionerFactory: () =>
        createDefaultDeviceProvisioner(undefined, undefined, getDefaultSimulatorCreationService()),
      exactDeviceProvisionerFactory: (deviceManager, deviceCreationGate) =>
        createDefaultExactDeviceProvisioner(deviceManager, deviceCreationGate, {
          assertAdoptable: assertNotBindingDeviceForAdoption,
          simulatorCreation: getDefaultSimulatorCreationService(),
        }),
      clearInstalledAppsForDevice: defaultClearInstalledAppsForDevice,
      stopPerformanceMonitoring: (deviceId) => getPerformanceMonitor().stopMonitoring(deviceId),
      stopAndroidObservers: defaultStopAndroidObservers,
      idGenerator: defaultIdGenerator,
      timer: defaultTimer,
      lifecycleCoordinator: getVirtualDeviceLifecycleCoordinator(),
      get androidEmulatorProcessStopper() {
        return (androidProcessStopper ??= createAndroidEmulatorProcessStopper());
      },
      resolveRunningAndroidAvdName: defaultResolveRunningAndroidAvdName,
    };
  }
  return moduleDependencies;
}

export async function defaultNotifyResourcesChanged(): Promise<void> {
  await defaultNotifyDeviceInventoryResourcesChanged(false);
  await deviceLifecycleServerHost.syncInstalledAppResources(
    getDeviceToolsDependencies().appResourceDependencies,
  );
}

export let deviceTeardownService: DeviceTeardownService | undefined;

export function getDeviceTeardownService(
  dependencies: DeviceToolsDependencies,
): DeviceTeardownService {
  deviceTeardownService ??= new DeviceTeardownService({
    lifecycleCoordinator: dependencies.lifecycleCoordinator,
    timer: dependencies.timer,
  });
  return deviceTeardownService;
}

export function setDeviceToolsDependencies(deps: Partial<DeviceToolsDependencies>): void {
  moduleDependencies = mergeDeviceToolsDependencies(deps, getDeviceToolsDependencies());
}

export function resetDeviceToolsDependencies(): void {
  androidProcessStopper = undefined;
  deviceTeardownService = undefined;
  moduleDependencies = null;
  activeProvisionDeviceRequests.clear();
}

executionTracker.setActiveProvisionDeviceQuery({
  hasActiveProvisionDeviceOperation: () => activeProvisionDeviceRequests.size > 0,
});
