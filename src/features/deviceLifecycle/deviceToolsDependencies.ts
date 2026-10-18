/**
 * Dependency bag for the device tools plus narrow per-handler-family views of it (#11827).
 * Type-only leaf module so handler modules can name exactly what they read without importing
 * the lifecycle core.
 */
import type { BootedDevice, Platform } from "../../models";
import type { PlatformDeviceManager } from "../../devices/deviceUtils";
import type { Timer } from "../../utils/SystemTimer";
import type { EmulatorProcessStopper } from "../../utils/android-cmdline-tools/EmulatorProcessStop";
import type { QrPosterWriter } from "../../utils/qr/QrPosterWriter";
import type { DeviceResourceObserver } from "../../utils/deviceResourceObserver";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { DeviceResourceController } from "../../utils/deviceResourceController";
import type { DeviceResourceReconciler } from "../../utils/deviceResourceReconciler";
import type { AvdManager } from "../../utils/android-cmdline-tools/interfaces/AvdManager";
import type { AppResourceDependencies } from "../../server/appResources";
import type { BootCapacityReporter } from "../bootAdmission/BootAdmissionGate";
import type { DeviceMatcher } from "../../utils/deviceMatcher";
import type { DisplayInventoryProvider } from "../../devices/DisplayInventoryProvider";
import type { Environment } from "../../daemon/poolConfig";
import type { DeviceCreationGate } from "../../devices/deviceCreationGate";
import type { DeviceProvisioner } from "../../devices/deviceProvisioning";
import type { RunnerReadinessRequest } from "../../ctrlProxy/RunnerReadinessService";
import type { ExactDeviceProvisioner } from "../../devices/exactDeviceProvisioning";
import type { VirtualDeviceLifecycleCoordinator } from "../../devices/virtualDeviceLifecycleCoordinator";

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
 * Narrow views of {@link DeviceToolsDependencies}: each handler family names
 * exactly the members it reads, so a function signature documents (and a test
 * fake only has to supply) what that family actually uses (#11827). Type-level
 * only; the runtime bag is unchanged.
 */
export type LifecycleOwnershipDependencies = Pick<
  DeviceToolsDependencies,
  "timer" | "resolveRunningAndroidAvdName"
>;
export type TeardownDependencies = Pick<
  DeviceToolsDependencies,
  | "timer"
  | "deviceManagerFactory"
  | "androidEmulatorProcessStopper"
  | "stopAndroidObservers"
  | "resolveRunningAndroidAvdName"
  | "clearInstalledAppsForDevice"
  | "notifyResourcesChanged"
  | "avdManagerFactory"
  | "stopPerformanceMonitoring"
  | "lifecycleCoordinator"
>;
export type DeviceLifecycleToolsDependencies = TeardownDependencies;
export type AcquisitionDependencies = Pick<
  DeviceToolsDependencies,
  "timer" | "lifecycleCoordinator" | "env" | "deviceMatcherFactory" | "deviceManagerFactory"
>;
export type StartDeviceDependencies = Pick<
  DeviceToolsDependencies,
  | "timer"
  | "lifecycleCoordinator"
  | "notifyDeviceInventoryResourcesChanged"
  | "ensureCtrlProxyReady"
  | "displayInventory"
  | "deviceProvisionerFactory"
  | "deviceCreationGateFactory"
  | "checkBootCapacity"
  | "syncInstalledAppResourceRegistry"
>;
export type ProvisioningDependencies = Pick<
  DeviceToolsDependencies,
  | "timer"
  | "lifecycleCoordinator"
  | "deviceManagerFactory"
  | "checkBootCapacity"
  | "notifyResourcesChanged"
  | "notifyDeviceInventoryResourcesChanged"
  | "exactDeviceProvisionerFactory"
  | "ensureCtrlProxyReady"
  | "displayInventory"
  | "deviceResourceControllerFactory"
  | "deviceProvisionerFactory"
  | "deviceMatcherFactory"
  | "deviceCreationGateFactory"
  | "deviceResourceObserverFactory"
> &
  TeardownDependencies;
