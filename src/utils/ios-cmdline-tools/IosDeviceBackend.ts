import { logger } from "../logger";
import { isIosSimulatorUdid } from "./iosDeviceType";
import type { SimCtlClient } from "./SimCtlClient";

/** The iOS operation currently shared by simulator and physical-device actions. */
export interface IosDeviceBackend {
  uninstallApp(bundleId: string): Promise<void>;
}

export interface DeviceAppUninstaller {
  uninstallApp(deviceUdid: string, bundleId: string, isSimulator?: boolean): Promise<void>;
}

export interface IosDeviceBackendDeps {
  simctl: Pick<SimCtlClient, "terminateApp">;
  deviceAppUninstaller: DeviceAppUninstaller;
}

export class SimulatorIosDeviceBackend implements IosDeviceBackend {
  constructor(
    private readonly deviceId: string,
    private readonly deps: IosDeviceBackendDeps,
  ) {}

  async uninstallApp(bundleId: string): Promise<void> {
    try {
      await this.deps.simctl.terminateApp(bundleId, this.deviceId);
    } catch (error) {
      logger.warn(`[UninstallApp] Failed to terminate iOS app before uninstall: ${error}`);
    }
    await this.deps.deviceAppUninstaller.uninstallApp(this.deviceId, bundleId, true);
  }
}

export class PhysicalIosDeviceBackend implements IosDeviceBackend {
  constructor(
    private readonly deviceId: string,
    private readonly deps: Pick<IosDeviceBackendDeps, "deviceAppUninstaller">,
  ) {}

  uninstallApp(bundleId: string): Promise<void> {
    return this.deps.deviceAppUninstaller.uninstallApp(this.deviceId, bundleId, false);
  }
}

export function resolveIosDeviceBackend(
  deviceId: string,
  deps: IosDeviceBackendDeps,
): IosDeviceBackend {
  return isIosSimulatorUdid(deviceId)
    ? new SimulatorIosDeviceBackend(deviceId, deps)
    : new PhysicalIosDeviceBackend(deviceId, deps);
}

type LaunchResult = { success: boolean; pid?: number; error?: string };
type LaunchOptions = Parameters<SimCtlClient["launchApp"]>[1];

export interface DeviceAppLauncher {
  launchApp(
    deviceUdid: string,
    bundleId: string,
    options?: { terminateExisting?: boolean; launchArguments?: string[] },
  ): Promise<LaunchResult>;
}

export interface IosLaunchBackend {
  launchApp(bundleId: string, options?: LaunchOptions): Promise<LaunchResult>;
}

export interface IosLaunchBackendDeps {
  simctl: Pick<SimCtlClient, "launchApp">;
  deviceAppLauncher: DeviceAppLauncher;
}

export class SimulatorIosLaunchBackend implements IosLaunchBackend {
  constructor(private readonly simctl: Pick<SimCtlClient, "launchApp">) {}

  launchApp(bundleId: string, options?: LaunchOptions): Promise<LaunchResult> {
    return this.simctl.launchApp(bundleId, options);
  }
}

export class PhysicalIosLaunchBackend implements IosLaunchBackend {
  constructor(
    private readonly deviceId: string,
    private readonly deviceAppLauncher: DeviceAppLauncher,
  ) {}

  launchApp(bundleId: string, options?: LaunchOptions): Promise<LaunchResult> {
    return this.deviceAppLauncher.launchApp(this.deviceId, bundleId, {
      terminateExisting: true,
      ...(options?.launchArguments === undefined
        ? {}
        : { launchArguments: options.launchArguments }),
    });
  }
}

export function resolveIosLaunchBackend(
  deviceId: string,
  deps: IosLaunchBackendDeps,
): IosLaunchBackend {
  return isIosSimulatorUdid(deviceId)
    ? new SimulatorIosLaunchBackend(deps.simctl)
    : new PhysicalIosLaunchBackend(deviceId, deps.deviceAppLauncher);
}
