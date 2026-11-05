import type { DeviceInfo } from "../../models";
import type {
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimulatorList,
} from "./SimCtlSupport";
import { isTemplateSimName } from "./SimulatorTemplateKey";
import {
  isAppleVisionDeviceType,
  isVisionOsSimulatorRuntime,
  visionOsVersionFromRuntimeId,
} from "./simulatorRuntimeFamily";

/** The simctl reads the Apple Vision Pro inventory needs; `SimCtlClient` implements them. */
export interface AppleVisionSimulatorSimctl {
  listSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<SimulatorList>;
  getRuntimesChecked(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]>;
  getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]>;
}

/** Installed visionOS runtimes and Apple Vision Pro device types. */
export interface AppleVisionSimulatorCatalog {
  runtimes: AppleDeviceRuntime[];
  deviceTypes: AppleDeviceType[];
}

/** Apple Vision Pro simulators as visionOS devices. Read failures propagate instead of returning none. */
export class AppleVisionSimulatorInventory {
  constructor(
    private readonly simctl: AppleVisionSimulatorSimctl,
    private readonly hostArchitecture: string = process.arch,
  ) {}

  async listAppleVisionSimulators(signal?: AbortSignal): Promise<DeviceInfo[]> {
    const listing = await this.simctl.listSimulators(undefined, signal);
    return Object.entries(listing.devices)
      .filter(([runtimeId]) => isVisionOsSimulatorRuntime(runtimeId))
      .flatMap(([runtimeId, devices]) =>
        devices
          .filter((device) => !isTemplateSimName(device.name))
          .map((device) => this.toDeviceInfo(runtimeId, device)),
      )
      .sort((a, b) => (a.deviceId ?? "").localeCompare(b.deviceId ?? ""));
  }

  async readCatalog(signal?: AbortSignal): Promise<AppleVisionSimulatorCatalog> {
    const [runtimes, deviceTypes] = await Promise.all([
      this.simctl.getRuntimesChecked(undefined, signal),
      this.simctl.getDeviceTypesChecked(signal),
    ]);
    return {
      runtimes: runtimes.filter((runtime) => isVisionOsSimulatorRuntime(runtime.identifier)),
      deviceTypes: deviceTypes.filter(isAppleVisionDeviceType),
    };
  }

  private toDeviceInfo(runtimeId: string, device: AppleDevice): DeviceInfo {
    const osVersion = device.os_version?.trim() || visionOsVersionFromRuntimeId(runtimeId);
    return {
      name: device.name,
      platform: "visionos",
      deviceId: device.udid,
      isRunning: device.state === "Booted",
      state: device.state,
      isAvailable: device.isAvailable,
      ...(device.availabilityError ? { availabilityError: device.availabilityError } : {}),
      ...(osVersion ? { osVersion } : {}),
      formFactor: "xr-headset",
      ...(device.deviceTypeIdentifier ? { deviceType: device.deviceTypeIdentifier } : {}),
      runtimeId,
      runtime: runtimeId,
      ...(device.model ? { model: device.model } : {}),
      // Simulator processes run on the host architecture.
      architecture: this.hostArchitecture,
    };
  }
}
