import type { DeviceInfo } from "../../models";
import type {
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimulatorList,
} from "./SimCtlSupport";
import { isTemplateSimName } from "./SimulatorTemplateKey";
import {
  isAppleWatchDeviceType,
  isWatchOsSimulatorRuntime,
  watchOsVersionFromRuntimeId,
} from "./simulatorRuntimeFamily";

/** The simctl reads the watch inventory needs; `SimCtlClient` implements them. */
export interface WatchSimulatorSimctl {
  listSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<SimulatorList>;
  getRuntimesChecked(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]>;
  getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]>;
}

/** Installed watchOS runtimes and Apple Watch device types. */
export interface WatchSimulatorCatalog {
  runtimes: AppleDeviceRuntime[];
  deviceTypes: AppleDeviceType[];
}

/**
 * Apple Watch simulators, published as `platform: "watchos"`. The iOS simulator listing skips
 * watchOS runtimes, so a watch is listed here and only here (docs/decisions/watchos-platform.md).
 * Read failures propagate: an empty result always means "no watch simulators".
 */
export class WatchSimulatorInventory {
  constructor(
    private readonly simctl: WatchSimulatorSimctl,
    private readonly hostArchitecture: string = process.arch,
  ) {}

  async listWatchSimulators(signal?: AbortSignal): Promise<DeviceInfo[]> {
    const listing = await this.simctl.listSimulators(undefined, signal);
    return Object.entries(listing.devices)
      .filter(([runtimeId]) => isWatchOsSimulatorRuntime(runtimeId))
      .flatMap(([runtimeId, devices]) =>
        devices
          .filter((device) => !isTemplateSimName(device.name))
          .map((device) => this.toDeviceInfo(runtimeId, device)),
      )
      .sort((a, b) => (a.deviceId ?? "").localeCompare(b.deviceId ?? ""));
  }

  async readCatalog(signal?: AbortSignal): Promise<WatchSimulatorCatalog> {
    const [runtimes, deviceTypes] = await Promise.all([
      this.simctl.getRuntimesChecked(undefined, signal),
      this.simctl.getDeviceTypesChecked(signal),
    ]);
    return {
      runtimes: runtimes.filter((runtime) => isWatchOsSimulatorRuntime(runtime.identifier)),
      deviceTypes: deviceTypes.filter(isAppleWatchDeviceType),
    };
  }

  private toDeviceInfo(runtimeId: string, device: AppleDevice): DeviceInfo {
    const osVersion = device.os_version?.trim() || watchOsVersionFromRuntimeId(runtimeId);
    return {
      name: device.name,
      platform: "watchos",
      deviceId: device.udid,
      isRunning: device.state === "Booted",
      state: device.state,
      isAvailable: device.isAvailable,
      ...(device.availabilityError ? { availabilityError: device.availabilityError } : {}),
      ...(osVersion ? { osVersion } : {}),
      formFactor: "watch",
      ...(device.deviceTypeIdentifier ? { deviceType: device.deviceTypeIdentifier } : {}),
      runtimeId,
      runtime: runtimeId,
      ...(device.model ? { model: device.model } : {}),
      // Simulator processes run on the host architecture.
      architecture: this.hostArchitecture,
    };
  }
}
