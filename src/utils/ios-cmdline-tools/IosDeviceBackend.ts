import { logger } from "../logger";
import { isIosPhysicalUdid, isIosSimulatorUdid } from "./iosDeviceType";
import type { SimCtlClient } from "./SimCtlClient";
import type { IosInstalledAppRecord } from "./iosInstalledApp";
import type { IosAppMetadataSource } from "../../models/IosAppMetadataSource";
import { promises as fs } from "fs";
import * as path from "path";
import type { ClearAppDataResult } from "../../models";
import { errorMessage } from "../describeUnknownError";
import {
  getAppDataContainerPath,
  IOS_APP_DATA_FOLDERS,
  terminateAppIfRunning,
} from "./iosAppContainer";

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

/**
 * Physical-device app terminator. `DeviceAppManager` satisfies this
 * structurally (via `xcrun devicectl device process terminate --kill`); tests
 * inject a fake so the physical path is exercised without a real device. Mirrors
 * the `DeviceAppUninstaller`/`DeviceAppLauncher` injection in the sibling tools.
 */
export interface DeviceAppTerminator {
  terminateApp(
    deviceUdid: string,
    bundleId: string,
  ): Promise<{ wasInstalled: boolean; wasRunning: boolean }>;
}

type TerminateResult = { wasInstalled: boolean; wasRunning: boolean };

export interface IosTerminateBackend {
  /** simctl needs the action's live listing pre-check; devicectl checks internally. */
  readonly requiresInstalledAppCheck: boolean;
  terminateApp(bundleId: string): Promise<TerminateResult>;
}

export interface IosTerminateBackendDeps {
  simctl: Pick<SimCtlClient, "terminateApp">;
  deviceAppTerminator: DeviceAppTerminator;
}

export class SimulatorIosTerminateBackend implements IosTerminateBackend {
  readonly requiresInstalledAppCheck = true;

  constructor(
    private readonly deviceId: string,
    private readonly simctl: Pick<SimCtlClient, "terminateApp">,
  ) {}

  async terminateApp(bundleId: string): Promise<TerminateResult> {
    await this.simctl.terminateApp(bundleId, this.deviceId);
    return { wasInstalled: true, wasRunning: true };
  }
}

export class PhysicalIosTerminateBackend implements IosTerminateBackend {
  readonly requiresInstalledAppCheck = false;

  constructor(
    private readonly deviceId: string,
    private readonly deviceAppTerminator: DeviceAppTerminator,
  ) {}

  terminateApp(bundleId: string): Promise<TerminateResult> {
    return this.deviceAppTerminator.terminateApp(this.deviceId, bundleId);
  }
}

export function resolveIosTerminateBackend(
  deviceId: string,
  deps: IosTerminateBackendDeps,
): IosTerminateBackend {
  return isIosSimulatorUdid(deviceId)
    ? new SimulatorIosTerminateBackend(deviceId, deps.simctl)
    : new PhysicalIosTerminateBackend(deviceId, deps.deviceAppTerminator);
}

export interface IosAppListBackend {
  listApps(): Promise<IosInstalledAppRecord[]>;
}

export interface IosAppListBackendDeps {
  simctl: Pick<SimCtlClient, "listAppsOrThrow">;
  getPhysicalAppLister: () => {
    listInstalledApps(deviceId: string): Promise<IosInstalledAppRecord[]>;
  };
}

export class SimulatorIosAppListBackend implements IosAppListBackend {
  constructor(
    private readonly deviceId: string,
    private readonly simctl: IosAppListBackendDeps["simctl"],
  ) {}

  listApps(): Promise<IosInstalledAppRecord[]> {
    return this.simctl.listAppsOrThrow(this.deviceId);
  }
}

export class PhysicalIosAppListBackend implements IosAppListBackend {
  constructor(
    private readonly deviceId: string,
    private readonly getPhysicalAppLister: IosAppListBackendDeps["getPhysicalAppLister"],
  ) {}

  listApps(): Promise<IosInstalledAppRecord[]> {
    return this.getPhysicalAppLister().listInstalledApps(this.deviceId);
  }
}

export function resolveIosAppListBackend(
  deviceId: string,
  deps: IosAppListBackendDeps,
): IosAppListBackend {
  // Listing historically sends only positively physical UDIDs to devicectl;
  // unknown IDs keep simctl. Metadata below instead sends non-simulator IDs to physical.
  return isIosPhysicalUdid(deviceId)
    ? new PhysicalIosAppListBackend(deviceId, deps.getPhysicalAppLister)
    : new SimulatorIosAppListBackend(deviceId, deps.simctl);
}

export interface IosAppInfoBackend {
  getAppInfo(bundleId: string): Promise<Record<string, unknown> | null>;
}

export interface IosAppInfoBackendDeps {
  iosSource: IosAppMetadataSource;
  findAppByBundleId: (
    apps: Record<string, unknown>[],
    bundleId: string,
  ) => Record<string, unknown> | null;
}

export class SimulatorIosAppInfoBackend implements IosAppInfoBackend {
  constructor(
    private readonly deviceId: string,
    private readonly deps: IosAppInfoBackendDeps,
  ) {}

  async getAppInfo(bundleId: string): Promise<Record<string, unknown> | null> {
    let apps: Record<string, unknown>[];
    try {
      apps = await this.deps.iosSource.listApps(this.deviceId);
    } catch (error) {
      logger.warn(`[GetAppMetadata] Failed to list iOS apps: ${error}`);
      return null;
    }
    return this.deps.findAppByBundleId(apps, bundleId);
  }
}

export class PhysicalIosAppInfoBackend implements IosAppInfoBackend {
  constructor(
    private readonly deviceId: string,
    private readonly iosSource: Pick<IosAppMetadataSource, "getPhysicalDeviceAppInfo">,
  ) {}

  async getAppInfo(bundleId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.iosSource.getPhysicalDeviceAppInfo(this.deviceId, bundleId);
    } catch (error) {
      logger.warn(`[GetAppMetadata] Failed to get physical device app info: ${error}`);
      return null;
    }
  }
}

export function resolveIosAppInfoBackend(
  deviceId: string,
  deps: IosAppInfoBackendDeps,
): IosAppInfoBackend {
  // Preserve metadata's simulator-only predicate, unlike the list resolver above.
  return isIosSimulatorUdid(deviceId)
    ? new SimulatorIosAppInfoBackend(deviceId, deps)
    : new PhysicalIosAppInfoBackend(deviceId, deps.iosSource);
}

export interface IosClearDataBackend {
  clearAppData(bundleId: string): Promise<ClearAppDataResult>;
}

export interface IosClearDataReinstaller {
  clearAppDataViaReinstall(deviceUdid: string, bundleId: string): Promise<void>;
}

export interface IosClearDataBackendDeps {
  simctl: Pick<SimCtlClient, "terminateApp" | "executeCommandArgs">;
  createReinstaller: () => IosClearDataReinstaller;
  rm?: typeof fs.rm;
}

export class SimulatorIosClearDataBackend implements IosClearDataBackend {
  constructor(
    private readonly deviceId: string,
    private readonly deps: Pick<IosClearDataBackendDeps, "simctl" | "rm">,
  ) {}

  async clearAppData(bundleId: string): Promise<ClearAppDataResult> {
    logger.info(`[iOS] Clearing app data for ${bundleId} on simulator ${this.deviceId}`);

    // The container can't be safely wiped while the app holds open file handles.
    await terminateAppIfRunning(this.deps.simctl, this.deviceId, bundleId);

    const containerPath = await getAppDataContainerPath(this.deps.simctl, this.deviceId, bundleId);
    if (!containerPath) {
      return {
        success: false,
        packageName: bundleId,
        error: `Could not resolve data container for ${bundleId} (is it installed?)`,
      };
    }

    try {
      // Folders are independent — wipe them concurrently. force:true so a missing
      // folder (e.g. an app that never wrote Documents) is a no-op, not an error.
      await Promise.all(
        IOS_APP_DATA_FOLDERS.map((folder) =>
          (this.deps.rm ?? fs.rm)(path.join(containerPath, folder), {
            recursive: true,
            force: true,
          }),
        ),
      );
      logger.info(`[iOS] Cleared app data for ${bundleId}`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      logger.warn(`[iOS] Failed to clear app data for ${bundleId}: ${errorMessage(error)}`);
      return { success: false, packageName: bundleId, error: errorMessage(error) };
    }
  }
}

export class PhysicalIosClearDataBackend implements IosClearDataBackend {
  constructor(
    private readonly deviceId: string,
    private readonly createReinstaller: () => IosClearDataReinstaller,
  ) {}

  async clearAppData(bundleId: string): Promise<ClearAppDataResult> {
    logger.info(
      `[iOS] Clearing app data for ${bundleId} via devicectl uninstall+reinstall on ${this.deviceId}`,
    );
    const reinstaller = this.createReinstaller();
    try {
      await reinstaller.clearAppDataViaReinstall(this.deviceId, bundleId);
      logger.info(`[iOS] Cleared app data for ${bundleId} (reinstalled)`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      logger.warn(
        `[iOS] Failed to clear app data for ${bundleId} via reinstall: ${errorMessage(error)}`,
      );
      return { success: false, packageName: bundleId, error: errorMessage(error) };
    }
  }
}

export function resolveIosClearDataBackend(
  deviceId: string,
  deps: IosClearDataBackendDeps,
  isSimulatorFn: () => boolean = () => isIosSimulatorUdid(deviceId),
): IosClearDataBackend {
  return isSimulatorFn()
    ? new SimulatorIosClearDataBackend(deviceId, deps)
    : new PhysicalIosClearDataBackend(deviceId, deps.createReinstaller);
}

export function resolveIosColdStartTerminateBackend(
  deviceId: string,
  deps: { simctl: Pick<SimCtlClient, "terminateApp"> },
): IosTerminateBackend | null {
  const backend = resolveIosTerminateBackend(deviceId, {
    // Cold-start termination historically omits the device argument; keep that
    // contract while routing through the shared terminate backend.
    simctl: { terminateApp: (bundleId) => deps.simctl.terminateApp(bundleId) },
    // The resolver requires both transports, but this helper deliberately
    // exposes only the simulator backend, so physical termination is unreachable.
    deviceAppTerminator: {
      terminateApp: async () => {
        throw new Error("Cold-start termination is not supported for physical devices");
      },
    },
  });
  return backend.requiresInstalledAppCheck ? backend : null;
}
