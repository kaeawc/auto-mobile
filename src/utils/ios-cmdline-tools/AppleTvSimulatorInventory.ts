import type { DeviceInfo } from "../../models";
import type {
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimulatorList,
} from "./SimCtlSupport";
import { isTemplateSimName } from "./SimulatorTemplateKey";
import {
  isAppleTvDeviceType,
  isTvOsSimulatorRuntime,
  tvOsVersionFromRuntimeId,
} from "./simulatorRuntimeFamily";

/** The simctl reads the Apple TV inventory needs; `SimCtlClient` implements them. */
export interface AppleTvSimulatorSimctl {
  listSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<SimulatorList>;
  getRuntimesChecked(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]>;
  getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]>;
}

/** Installed tvOS runtimes and Apple TV device types. */
export interface AppleTvSimulatorCatalog {
  runtimes: AppleDeviceRuntime[];
  deviceTypes: AppleDeviceType[];
}

/** Apple TV simulators as tvOS devices. Read failures propagate instead of returning none. */
export class AppleTvSimulatorInventory {
  constructor(
    private readonly simctl: AppleTvSimulatorSimctl,
    private readonly hostArchitecture: string = process.arch,
  ) {}

  async listAppleTvSimulators(signal?: AbortSignal): Promise<DeviceInfo[]> {
    const listing = await this.simctl.listSimulators(undefined, signal);
    return Object.entries(listing.devices)
      .filter(([runtimeId]) => isTvOsSimulatorRuntime(runtimeId))
      .flatMap(([runtimeId, devices]) =>
        devices
          .filter((device) => !isTemplateSimName(device.name))
          .map((device) => this.toDeviceInfo(runtimeId, device)),
      )
      .sort((a, b) => (a.deviceId ?? "").localeCompare(b.deviceId ?? ""));
  }

  async readCatalog(signal?: AbortSignal): Promise<AppleTvSimulatorCatalog> {
    const [runtimes, deviceTypes] = await Promise.all([
      this.simctl.getRuntimesChecked(undefined, signal),
      this.simctl.getDeviceTypesChecked(signal),
    ]);
    return {
      runtimes: runtimes.filter((runtime) => isTvOsSimulatorRuntime(runtime.identifier)),
      deviceTypes: deviceTypes.filter(isAppleTvDeviceType),
    };
  }

  private toDeviceInfo(runtimeId: string, device: AppleDevice): DeviceInfo {
    const osVersion = device.os_version?.trim() || tvOsVersionFromRuntimeId(runtimeId);
    return {
      name: device.name,
      platform: "tvos",
      deviceId: device.udid,
      isRunning: device.state === "Booted",
      state: device.state,
      isAvailable: device.isAvailable,
      ...(device.availabilityError ? { availabilityError: device.availabilityError } : {}),
      ...(osVersion ? { osVersion } : {}),
      formFactor: "tv",
      ...(device.deviceTypeIdentifier ? { deviceType: device.deviceTypeIdentifier } : {}),
      runtimeId,
      runtime: runtimeId,
      ...(device.model ? { model: device.model } : {}),
      // Simulator processes run on the host architecture.
      architecture: this.hostArchitecture,
    };
  }
}
