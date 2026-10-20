import type { BootedDevice } from "../models";
import type { Timer } from "../utils/SystemTimer";
import type { IosCtrlProxyBuilderSurface } from "./IosCtrlProxyBuilderSurface";
import type { HostProcessExecutor } from "../utils/HostCommandExecutor";
import type { XcodeSigningManager } from "../utils/ios-cmdline-tools/XcodeSigning";
import type { DeviceAppManager } from "../utils/ios-cmdline-tools/DeviceAppManager";
import type { RemoteCtrlProxyIOSRunner } from "./IOSCtrlProxyManager";
import type { HostPortAvailabilityChecker } from "./ios/IOSHostPortAvailabilityChecker";
import type { Xcodebuild } from "../utils/ios-cmdline-tools/XcodebuildClient";
import type { IosCtrlProxyProcessClient } from "./ios/IosCtrlProxyProcessClient";
import type { IosTunnelClient } from "./ios/IosTunnelClient";
import type { IosPhysicalDeviceLister } from "../utils/ios-cmdline-tools/DevicectlDeviceLister";
import type { IosCtrlProxyStepOverrides } from "./ios/IosCtrlProxyLifecycleSteps";
import type { IosDeviceDetector } from "./ios/IosDeviceDetector";
import type { IosAppBundleGuard } from "./ios/IosAppBundleGuard";
import type { ProcessSupervisor, ProcessSupervisorOptions } from "../utils/ProcessSupervisor";

export interface IosCtrlProxyManagerOptions {
  device: BootedDevice;
  timer?: Timer;
  builder?: IosCtrlProxyBuilderSurface;
  processExecutor?: HostProcessExecutor;
  signingManager?: XcodeSigningManager;
  deviceAppManager?: DeviceAppManager;
  remoteRunner?: RemoteCtrlProxyIOSRunner;
  hostPortAvailabilityChecker?: HostPortAvailabilityChecker;
  xcodebuild?: Xcodebuild;
  processClient?: IosCtrlProxyProcessClient;
  tunnelClient?: IosTunnelClient;
  /** Authoritative physical-device inventory (devicectl); defaults to the shared lister. */
  physicalDeviceLister?: IosPhysicalDeviceLister;
  /**
   * Replaces individual runner-lifecycle steps; each omitted step keeps the manager's own.
   * A function receives the manager's own steps so a test can decorate one and call through.
   */
  steps?: IosCtrlProxyStepOverrides;
  deviceDetector?: IosDeviceDetector;
  appBundleGuard?: IosAppBundleGuard;
  /** Builds the runner supervisor; a test wraps the default to drive it directly. */
  processSupervisorFactory?: (options: ProcessSupervisorOptions) => ProcessSupervisor;
}

/** The dependencies a unit test may supply; omitted ones get the same defaults as `getInstance`. */
export type IosCtrlProxyManagerTestOptions = Omit<
  IosCtrlProxyManagerOptions,
  "timer" | "processExecutor"
> & { timer: Timer; processExecutor: HostProcessExecutor };

/** Positional compatibility for callers predating the dependency options object. */
export type IosCtrlProxyManagerTestArguments = [
  device: BootedDevice,
  timer: Timer,
  builder: IosCtrlProxyBuilderSurface | undefined,
  processExecutor: HostProcessExecutor,
  signingManager?: XcodeSigningManager,
  deviceAppManager?: DeviceAppManager,
  remoteRunner?: RemoteCtrlProxyIOSRunner,
  hostPortAvailabilityChecker?: HostPortAvailabilityChecker,
  xcodebuild?: Xcodebuild,
  processClient?: IosCtrlProxyProcessClient,
  physicalDeviceLister?: IosPhysicalDeviceLister,
];
