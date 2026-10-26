import type { SimulatorContainerOwnershipOptions } from "./simulatorOwnContainer";
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
import { type IosInstalledAppRecord } from "./iosInstalledApp";
import type { IosAppMetadataSource } from "../../models/IosAppMetadataSource";
import { promises as fs } from "fs";
import { type ClearAppDataResult } from "../../models";
import { PhysicalIosDeviceBackend } from "./PhysicalIosDeviceBackend";
import { SimulatorIosLaunchBackend } from "./SimulatorIosLaunchBackend";
import { PhysicalIosLaunchBackend } from "./PhysicalIosLaunchBackend";
import { SimulatorIosTerminateBackend } from "./SimulatorIosTerminateBackend";
import { PhysicalIosTerminateBackend } from "./PhysicalIosTerminateBackend";
import { SimulatorIosAppListBackend } from "./SimulatorIosAppListBackend";
import { PhysicalIosAppListBackend } from "./PhysicalIosAppListBackend";
import { SimulatorIosAppInfoBackend } from "./SimulatorIosAppInfoBackend";
import { PhysicalIosAppInfoBackend } from "./PhysicalIosAppInfoBackend";
import { PhysicalIosClearDataBackend } from "./PhysicalIosClearDataBackend";
import { SimulatorIosInstallBackend } from "./SimulatorIosInstallBackend";
import { PhysicalIosInstallBackend } from "./PhysicalIosInstallBackend";
import { SimulatorIosOpenUrlBackend } from "./SimulatorIosOpenUrlBackend";
import { PhysicalIosOpenUrlBackend } from "./PhysicalIosOpenUrlBackend";
import { SimulatorIosClearDataBackend } from "./SimulatorIosClearDataBackend";
export {
  SimulatorIosClearDataBackend,
  resolveIosLenientTerminateBackend,
} from "./SimulatorIosClearDataBackend";
export { PhysicalIosDeviceBackend } from "./PhysicalIosDeviceBackend";
export { SimulatorIosTerminateBackend } from "./SimulatorIosTerminateBackend";
export { PhysicalIosTerminateBackend } from "./PhysicalIosTerminateBackend";
export { SimulatorIosAppListBackend } from "./SimulatorIosAppListBackend";
export { PhysicalIosAppListBackend } from "./PhysicalIosAppListBackend";
export { SimulatorIosAppInfoBackend } from "./SimulatorIosAppInfoBackend";
export { PhysicalIosAppInfoBackend } from "./PhysicalIosAppInfoBackend";
export { PhysicalIosClearDataBackend } from "./PhysicalIosClearDataBackend";
export { SimulatorIosInstallBackend } from "./SimulatorIosInstallBackend";
export { PhysicalIosInstallBackend } from "./PhysicalIosInstallBackend";
export { SimulatorIosOpenUrlBackend } from "./SimulatorIosOpenUrlBackend";
export { PhysicalIosOpenUrlBackend } from "./PhysicalIosOpenUrlBackend";

/** The iOS operation currently shared by simulator and physical-device actions. */
export interface IosDeviceBackend {
  readonly kind: "simulator" | "physical";
  /**
   * `signal` is the request's cancellation signal; the ambient request signal is
   * always honoured as well. A cancellation seen before the uninstall is
   * dispatched rejects without removing the app.
   * `terminateFirst` defaults to true for simulator best-effort termination.
   * Physical-device uninstall has no pre-termination step.
   */
  uninstallApp(
    bundleId: string,
    signal?: AbortSignal,
    options?: { terminateFirst?: boolean },
  ): Promise<void>;
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

  async uninstallApp(
    bundleId: string,
    signal?: AbortSignal,
    options: { terminateFirst?: boolean } = {},
  ): Promise<void> {
    const requestSignal = combineWithAmbientAbort(signal);
    requestSignal?.throwIfAborted();
    if (options.terminateFirst !== false) {
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

export function resolveIosDeviceBackend(
  deviceId: string,
  deps: IosDeviceBackendDeps,
): IosDeviceBackend {
  return resolveIosDeviceKind({ deviceId }) === "simulator"
    ? new SimulatorIosDeviceBackend(deviceId, deps)
    : new PhysicalIosDeviceBackend(deviceId, deps);
}

export type LaunchResult = { success: boolean; pid?: number; error?: string };
export type LaunchOptions = Parameters<SimCtlClient["launchApp"]>[1];

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

export type TerminateResult = { wasInstalled: boolean; wasRunning: boolean };

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
  containerOwnership?: SimulatorContainerOwnershipOptions;
  simctl: Pick<SimCtlClient, "terminateApp" | "executeCommandArgs" | "listAppsOrThrow">;
  createReinstaller: () => IosClearDataReinstaller;
  rm?: typeof fs.rm;
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
  installApp(
    artifactPath: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;
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
