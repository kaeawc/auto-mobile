import type { SimCtlClient } from "./SimCtlClient";
import { isIosPhysicalUdid } from "./iosDeviceType";
import { resolveIosLenientAppListBackend, SimulatorIosAppListBackend } from "./IosDeviceBackend";
import { getAppDataContainerPath } from "./iosAppContainerData";
import { terminateAppIfRunning } from "./iosAppContainer";
import { captureIosSettings, restoreIosSettings, type IosSettingsSnapshot } from "./iosSettings";

export interface IosSimulatorSnapshotBackend {
  readonly kind: "simulator";
  getDeviceInfo(): ReturnType<SimCtlClient["getDeviceInfo"]>;
  getRuntimes(): ReturnType<SimCtlClient["getRuntimes"]>;
  captureSettings(): Promise<IosSettingsSnapshot>;
  restoreSettings(settings: IosSettingsSnapshot): Promise<void>;
  getAppDataContainerPath(bundleId: string): Promise<string | null>;
  terminateAppIfRunning(bundleId: string): Promise<void>;
  listAppsOrThrow(): ReturnType<SimCtlClient["listAppsOrThrow"]>;
  listApps(): ReturnType<SimCtlClient["listApps"]>;
}

// Physical devices expose no simulator operations: the actions reject them before execution.
export type IosSnapshotBackend = IosSimulatorSnapshotBackend | { readonly kind: "physical" };

export interface IosSnapshotBackendDeps {
  simctl: Pick<
    SimCtlClient,
    | "getDeviceInfo"
    | "getRuntimes"
    | "executeCommandArgs"
    | "terminateApp"
    | "listAppsOrThrow"
    | "listApps"
  >;
}

export class SimulatorIosSnapshotBackend implements IosSimulatorSnapshotBackend {
  readonly kind = "simulator";

  constructor(private readonly options: IosSnapshotBackendDeps & { deviceId: string }) {}

  getDeviceInfo(): ReturnType<SimCtlClient["getDeviceInfo"]> {
    return this.options.simctl.getDeviceInfo(this.options.deviceId);
  }

  getRuntimes(): ReturnType<SimCtlClient["getRuntimes"]> {
    return this.options.simctl.getRuntimes();
  }

  captureSettings(): Promise<IosSettingsSnapshot> {
    return captureIosSettings(this.options.simctl, this.options.deviceId);
  }

  restoreSettings(settings: IosSettingsSnapshot): Promise<void> {
    return restoreIosSettings(this.options.simctl, this.options.deviceId, settings);
  }

  getAppDataContainerPath(bundleId: string): Promise<string | null> {
    return getAppDataContainerPath(this.options.simctl, this.options.deviceId, bundleId);
  }

  terminateAppIfRunning(bundleId: string): Promise<void> {
    return terminateAppIfRunning(this.options.simctl, this.options.deviceId, bundleId);
  }

  listAppsOrThrow(): ReturnType<SimCtlClient["listAppsOrThrow"]> {
    return new SimulatorIosAppListBackend(this.options.deviceId, this.options.simctl).listApps();
  }

  listApps(): ReturnType<SimCtlClient["listApps"]> {
    return resolveIosLenientAppListBackend(this.options.deviceId, this.options).listApps();
  }
}

/** Reject only positively physical UDIDs; unknown IDs historically keep simctl. */
export function resolveIosSnapshotBackend(
  deviceId: string,
  deps: IosSnapshotBackendDeps,
): IosSnapshotBackend {
  return isIosPhysicalUdid(deviceId)
    ? { kind: "physical" }
    : new SimulatorIosSnapshotBackend({ deviceId, simctl: deps.simctl });
}
