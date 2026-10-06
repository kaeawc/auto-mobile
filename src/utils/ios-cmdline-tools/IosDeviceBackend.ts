import type { DeviceUrlLauncher } from "./DeviceAppManager";
import { logger } from "../logger";
import { combineWithAmbientAbort } from "../AbortContext";
import { throwIfAborted } from "../toolUtils";
import { isIosPhysicalUdid } from "./iosDeviceType";
import { resolveIosDeviceKind } from "./IosDeviceKind";
import type { SimCtlClient } from "./SimCtlClient";
import { SimctlCommandTimeoutError } from "./SimctlCommandTimeoutError";
import {
  indeterminateSimulatorUninstallError,
  SIMULATOR_UNINSTALL_TIMEOUT_MS,
} from "./simulatorUninstallBound";
import { getIosInstalledAppBundleId, type IosInstalledAppRecord } from "./iosInstalledApp";
import type { IosAppMetadataSource } from "../../models/IosAppMetadataSource";
import { promises as fs } from "fs";
import * as path from "path";
import { AppNotInstalledError, type ClearAppDataResult } from "../../models";
import { errorMessage } from "../describeUnknownError";
import { getAppDataContainerPath, IOS_APP_DATA_FOLDERS } from "./iosAppContainerData";

/** The iOS operation currently shared by simulator and physical-device actions. */
export interface IosDeviceBackend {
  readonly kind: "simulator" | "physical";
  /**
   * `signal` is the request's cancellation signal; the ambient request signal is
   * always honoured as well. A cancellation seen before the uninstall is
   * dispatched rejects without removing the app.
   */
  uninstallApp(bundleId: string, signal?: AbortSignal): Promise<void>;
}

export interface DeviceAppUninstaller {
  uninstallApp(
    deviceUdid: string,
    bundleId: string,
    isSimulator?: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

/** The pre-uninstall terminate is best-effort, so it gets a short bound of its own. */
const SIMULATOR_PRE_UNINSTALL_TERMINATE_TIMEOUT_MS = 15_000;

export interface IosDeviceBackendDeps {
  simctl: Pick<SimCtlClient, "terminateApp">;
  deviceAppUninstaller: DeviceAppUninstaller;
}

export class SimulatorIosDeviceBackend implements IosDeviceBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly deps: IosDeviceBackendDeps,
  ) {}

  async uninstallApp(bundleId: string, signal?: AbortSignal): Promise<void> {
    const requestSignal = combineWithAmbientAbort(signal);
    requestSignal?.throwIfAborted();
    try {
      await this.deps.simctl.terminateApp(bundleId, this.deviceId, {
        timeoutMs: SIMULATOR_PRE_UNINSTALL_TERMINATE_TIMEOUT_MS,
        ...(requestSignal ? { signal: requestSignal } : {}),
      });
    } catch (error) {
      // A cancellation is not a terminate failure to shrug off: continuing would
      // remove the app for a request the caller already abandoned (issue #10077).
      requestSignal?.throwIfAborted();
      logger.warn(`[UninstallApp] Failed to terminate iOS app before uninstall: ${error}`);
    }
    // The terminate may have succeeded just as the request was cancelled; fence
    // the destructive step so it is never dispatched for a cancelled request.
    requestSignal?.throwIfAborted();
    await this.deps.deviceAppUninstaller.uninstallApp(
      this.deviceId,
      bundleId,
      true,
      requestSignal ? { signal: requestSignal } : undefined,
    );
  }
}

export class PhysicalIosDeviceBackend implements IosDeviceBackend {
  readonly kind = "physical";

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
  return resolveIosDeviceKind({ deviceId }) === "simulator"
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
  readonly kind: "simulator" | "physical";
  launchApp(bundleId: string, options?: LaunchOptions): Promise<LaunchResult>;
}

export interface IosLaunchBackendDeps {
  simctl: Pick<SimCtlClient, "launchApp">;
  deviceAppLauncher: DeviceAppLauncher;
}

export class SimulatorIosLaunchBackend implements IosLaunchBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: Pick<SimCtlClient, "launchApp">,
  ) {}

  launchApp(bundleId: string, options?: LaunchOptions): Promise<LaunchResult> {
    return this.simctl.launchApp(bundleId, options, this.deviceId);
  }
}

export class PhysicalIosLaunchBackend implements IosLaunchBackend {
  readonly kind = "physical";

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
  return resolveIosDeviceKind({ deviceId }) === "simulator"
    ? new SimulatorIosLaunchBackend(deviceId, deps.simctl)
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
  readonly kind: "simulator" | "physical";
  /** simctl needs the action's live listing pre-check; devicectl checks internally. */
  readonly requiresInstalledAppCheck: boolean;
  terminateApp(bundleId: string): Promise<TerminateResult>;
}

export interface IosTerminateBackendDeps {
  simctl: Pick<SimCtlClient, "terminateApp">;
  deviceAppTerminator: DeviceAppTerminator;
}

export class SimulatorIosTerminateBackend implements IosTerminateBackend {
  readonly kind = "simulator";

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
  readonly kind = "physical";

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
  return resolveIosDeviceKind({ deviceId }) === "simulator"
    ? new SimulatorIosTerminateBackend(deviceId, deps.simctl)
    : new PhysicalIosTerminateBackend(deviceId, deps.deviceAppTerminator);
}

export interface IosAppListBackend {
  readonly kind: "simulator" | "physical";
  listApps(): Promise<IosInstalledAppRecord[]>;
}

export interface IosAppListBackendDeps {
  simctl: Pick<SimCtlClient, "listAppsOrThrow">;
  getPhysicalAppLister: () => {
    listInstalledApps(deviceId: string): Promise<IosInstalledAppRecord[]>;
  };
}

export class SimulatorIosAppListBackend implements IosAppListBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: IosAppListBackendDeps["simctl"],
  ) {}

  listApps(): Promise<IosInstalledAppRecord[]> {
    return this.simctl.listAppsOrThrow(this.deviceId);
  }
}

export class PhysicalIosAppListBackend implements IosAppListBackend {
  readonly kind = "physical";

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
  readonly kind: "simulator" | "physical";
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
  readonly kind = "simulator";

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
  readonly kind = "physical";

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
  return resolveIosDeviceKind({ deviceId }) === "simulator"
    ? new SimulatorIosAppInfoBackend(deviceId, deps)
    : new PhysicalIosAppInfoBackend(deviceId, deps.iosSource);
}

export interface IosClearDataBackend {
  readonly kind: "simulator" | "physical";
  clearAppData(bundleId: string): Promise<ClearAppDataResult>;
}

export interface IosClearDataReinstaller {
  clearAppDataViaReinstall(deviceUdid: string, bundleId: string): Promise<void>;
}

export interface IosClearDataBackendDeps {
  simctl: Pick<SimCtlClient, "terminateApp" | "executeCommandArgs" | "listAppsOrThrow">;
  createReinstaller: () => IosClearDataReinstaller;
  rm?: typeof fs.rm;
}

export class SimulatorIosClearDataBackend implements IosClearDataBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly deps: Pick<IosClearDataBackendDeps, "simctl" | "rm">,
  ) {}

  async clearAppData(bundleId: string): Promise<ClearAppDataResult> {
    logger.info(`[iOS] Clearing app data for ${bundleId} on simulator ${this.deviceId}`);

    // The container can't be safely wiped while the app holds open file handles.
    await resolveIosLenientTerminateBackend(this.deviceId, this.deps).terminateApp(bundleId);

    const containerPath = await getAppDataContainerPath(this.deps.simctl, this.deviceId, bundleId);
    if (!containerPath) {
      // Only a successful listing that lacks the bundle proves "not installed"; any other
      // container miss (or an unreadable listing) stays a retryable failure.
      if (await this.isConfirmedNotInstalled(bundleId)) {
        throw new AppNotInstalledError(
          `App ${bundleId} is not installed on iOS simulator ${this.deviceId}; install the app first`,
        );
      }
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

  private async isConfirmedNotInstalled(bundleId: string): Promise<boolean> {
    try {
      const apps = await this.deps.simctl.listAppsOrThrow(this.deviceId);
      return !apps.some((app) => getIosInstalledAppBundleId(app) === bundleId);
    } catch (error) {
      logger.warn(`[iOS] Could not list installed apps to classify ${bundleId}: ${error}`);
      return false;
    }
  }
}

export class PhysicalIosClearDataBackend implements IosClearDataBackend {
  readonly kind = "physical";

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
  isSimulatorFn: () => boolean = () => resolveIosDeviceKind({ deviceId }) === "simulator",
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
    simctl: deps.simctl,
    // The resolver requires both transports, but this helper deliberately
    // exposes only the simulator backend, so physical termination is unreachable.
    deviceAppTerminator: {
      terminateApp: async () => {
        throw new Error("Cold-start termination is not supported for physical devices");
      },
    },
  });
  return backend.kind === "simulator" ? backend : null;
}

/** Recovery keeps SimCtlClient's executor for both simulator lifecycle operations. */
export interface IosDowngradeRecoveryBackend {
  readonly kind: "simulator";
  terminateApp(bundleId: string): Promise<void>;
  /**
   * Removes the installed (newer) app. Bounded by the simulator uninstall budget and cancellable
   * through `signal` plus the ambient request signal; a cancellation seen before the uninstall is
   * dispatched rejects with the app still installed. A timeout rejects with an indeterminate
   * outcome, never as a plain failure.
   */
  uninstallApp(bundleId: string, signal?: AbortSignal): Promise<void>;
}

export function resolveIosDowngradeRecoveryBackend(
  deviceId: string,
  deps: { simctl: Pick<SimCtlClient, "terminateApp" | "uninstallApp"> },
): IosDowngradeRecoveryBackend | null {
  if (resolveIosDeviceKind({ deviceId }) === "physical") {
    return null;
  }
  return {
    kind: "simulator",
    terminateApp: (bundleId) =>
      deps.simctl.terminateApp(bundleId, deviceId, {
        timeoutMs: SIMULATOR_PRE_UNINSTALL_TERMINATE_TIMEOUT_MS,
      }),
    uninstallApp: (bundleId, signal) =>
      uninstallSimulatorAppBounded(deps.simctl, deviceId, bundleId, signal),
  };
}

async function uninstallSimulatorAppBounded(
  simctl: Pick<SimCtlClient, "uninstallApp">,
  deviceId: string,
  bundleId: string,
  signal?: AbortSignal,
): Promise<void> {
  const requestSignal = combineWithAmbientAbort(signal);
  // Nothing destructive has been dispatched yet: a cancelled request stops with the app installed.
  throwIfAborted(requestSignal);
  try {
    await simctl.uninstallApp(bundleId, deviceId, {
      timeoutMs: SIMULATOR_UNINSTALL_TIMEOUT_MS,
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
  } catch (error) {
    // Cancellation is the caller's own decision; it propagates unchanged, but the killed
    // uninstall was already dispatched, so leave a trace that the app's state is unknown.
    if (requestSignal?.aborted) {
      logger.warn(
        `[IosDowngradeRecovery] Uninstall of ${bundleId} was cancelled after it was dispatched; the app may or may not be uninstalled`,
      );
    }
    throwIfAborted(requestSignal);
    if (!(error instanceof SimctlCommandTimeoutError)) {
      throw error;
    }
    const indeterminate = indeterminateSimulatorUninstallError(bundleId, error);
    logger.warn(indeterminate.message);
    throw indeterminate;
  }
}

/** Snapshot capture rejects physical devices; unknown IDs historically keep simctl. */
export function resolveIosSnapshotAppListBackend(
  deviceId: string,
  deps: Pick<IosAppListBackendDeps, "simctl">,
): IosAppListBackend | null {
  return isIosPhysicalUdid(deviceId) ? null : new SimulatorIosAppListBackend(deviceId, deps.simctl);
}

/** Install transport and strict app listings used to verify the installed bundle. */
export interface IosInstallBackend {
  readonly kind: "simulator" | "physical";
  /** `timeoutMs` bounds a simulator install at the transport (it kills the child); physical ignores it. */
  installApp(artifactPath: string, options?: { timeoutMs?: number }): Promise<void>;
  listApps(): Promise<Record<string, unknown>[]>;
}

export interface IosInstallBackendDeps {
  simctl: Pick<SimCtlClient, "installApp" | "listAppsOrThrow">;
  deviceAppInstaller: {
    installApp(deviceUdid: string, artifactPath: string): Promise<void>;
  };
  physicalAppLister: {
    listInstalledApps(deviceUdid: string): Promise<Record<string, unknown>[]>;
  };
}

export class SimulatorIosInstallBackend implements IosInstallBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: IosInstallBackendDeps["simctl"],
  ) {}

  installApp(artifactPath: string, options?: { timeoutMs?: number }): Promise<void> {
    return this.simctl.installApp(
      artifactPath,
      this.deviceId,
      options?.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
  }

  listApps(): Promise<Record<string, unknown>[]> {
    return this.simctl.listAppsOrThrow(this.deviceId);
  }
}

export class PhysicalIosInstallBackend implements IosInstallBackend {
  readonly kind = "physical";

  constructor(
    private readonly deviceId: string,
    private readonly deps: Pick<IosInstallBackendDeps, "deviceAppInstaller" | "physicalAppLister">,
  ) {}

  installApp(artifactPath: string): Promise<void> {
    return this.deps.deviceAppInstaller.installApp(this.deviceId, artifactPath);
  }

  listApps(): Promise<Record<string, unknown>[]> {
    return this.deps.physicalAppLister.listInstalledApps(this.deviceId);
  }
}

export function resolveIosInstallBackend(
  deviceId: string,
  deps: IosInstallBackendDeps,
): IosInstallBackend {
  return resolveIosDeviceKind({ deviceId }) === "simulator"
    ? new SimulatorIosInstallBackend(deviceId, deps.simctl)
    : new PhysicalIosInstallBackend(deviceId, deps);
}

/** URL transport only; action-level resolution, cancellation and observation stay with OpenURL. */
export interface IosOpenUrlBackend {
  readonly kind: "simulator" | "physical";
  isUrlLaunchAvailable(): Promise<boolean>;
  openUrl(url: string, options: { bundleId: string; signal?: AbortSignal }): Promise<void>;
}

export interface IosOpenUrlBackendDeps {
  createSimctl: () => Pick<SimCtlClient, "executeCommandArgs">;
  createDeviceUrlLauncher: () => DeviceUrlLauncher;
}

export class SimulatorIosOpenUrlBackend implements IosOpenUrlBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly createSimctl: IosOpenUrlBackendDeps["createSimctl"],
  ) {}

  async isUrlLaunchAvailable(): Promise<boolean> {
    return true;
  }

  async openUrl(url: string): Promise<void> {
    // Preserve argv forwarding: simctl's string command path re-splits URL bytes.
    await this.createSimctl().executeCommandArgs(["openurl", this.deviceId, url]);
  }
}

export class PhysicalIosOpenUrlBackend implements IosOpenUrlBackend {
  readonly kind = "physical";
  private launcher?: DeviceUrlLauncher;

  constructor(
    private readonly deviceId: string,
    private readonly createDeviceUrlLauncher: IosOpenUrlBackendDeps["createDeviceUrlLauncher"],
  ) {}

  private get deviceUrlLauncher(): DeviceUrlLauncher {
    return (this.launcher ??= this.createDeviceUrlLauncher());
  }

  isUrlLaunchAvailable(): Promise<boolean> {
    return this.deviceUrlLauncher.isUrlLaunchAvailable();
  }

  openUrl(url: string, options: { bundleId: string; signal?: AbortSignal }): Promise<void> {
    return this.deviceUrlLauncher.launchWithPayloadUrl(
      this.deviceId,
      options.bundleId,
      url,
      options.signal,
    );
  }
}

export function resolveIosOpenUrlBackend(
  deviceId: string,
  deps: IosOpenUrlBackendDeps,
): IosOpenUrlBackend {
  return resolveIosDeviceKind({ deviceId }) === "simulator"
    ? new SimulatorIosOpenUrlBackend(deviceId, deps.createSimctl)
    : new PhysicalIosOpenUrlBackend(deviceId, deps.createDeviceUrlLauncher);
}

/** Legacy simulator listings preserve SimCtlClient's warning and empty-array fallback. */
export interface IosLenientAppListBackend {
  readonly kind: "simulator";
  listApps(): Promise<Record<string, unknown>[]>;
}

export interface IosLenientAppListBackendDeps {
  simctl: Pick<SimCtlClient, "listApps">;
}

export function resolveIosLenientAppListBackend(
  deviceId: string | undefined,
  deps: IosLenientAppListBackendDeps,
): IosLenientAppListBackend {
  // These callers always used simctl, including unknown IDs. Forward undefined
  // unchanged so the bound SimCtlClient remains responsible for its fallback.
  return {
    kind: "simulator",
    listApps: () => deps.simctl.listApps(deviceId),
  };
}

export interface IosLenientTerminateBackend {
  readonly kind: "simulator";
  terminateApp(bundleId: string): Promise<void>;
}

export function resolveIosLenientTerminateBackend(
  deviceId: string,
  deps: Pick<IosTerminateBackendDeps, "simctl">,
): IosLenientTerminateBackend {
  const backend = new SimulatorIosTerminateBackend(deviceId, deps.simctl);
  return {
    kind: "simulator",
    async terminateApp(bundleId) {
      try {
        await backend.terminateApp(bundleId);
      } catch (error) {
        // A not-running app is expected here; preserve the legacy warn-and-continue contract.
        logger.warn(`[iOS] Failed to terminate ${bundleId}: ${error}`);
      }
    },
  };
}

export interface IosMetadataBackendDeps extends IosLenientAppListBackendDeps {
  deviceAppManager: {
    getInstalledAppInfo(
      deviceId: string,
      bundleId: string,
    ): Promise<Record<string, unknown> | null>;
  };
}

/** Metadata consumers retain their existing simulator/physical selection policy. */
export function resolveIosMetadataBackend(deps: IosMetadataBackendDeps): IosAppMetadataSource {
  return {
    listApps: (deviceId) => resolveIosLenientAppListBackend(deviceId, deps).listApps(),
    getPhysicalDeviceAppInfo: (deviceId, bundleId) =>
      deps.deviceAppManager.getInstalledAppInfo(deviceId, bundleId),
  };
}
