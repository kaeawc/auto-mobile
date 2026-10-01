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
