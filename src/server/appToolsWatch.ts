import { InstallApp } from "../features/action/InstallApp";
import { UninstallApp } from "../features/action/UninstallApp";
import type { InstallAppCall } from "../features/action/InstallAppTypes";
import type { UninstallAppCall } from "../features/action/UninstallApp";
import { WatchAppManager } from "../features/action/watch/WatchAppManager";
import type { BootedDevice, InstallAppResult } from "../models";
import type { UninstallAppResult } from "../models/UninstallAppResult";
import { queryInstalledApps, type AppsQueryResourceContent } from "./appResources";
import { normalizeIosApps } from "./appResourcesNormalization";
import { filterAppsByQuery, isLaunchabilityUnknown } from "./appResourcesQuery";
import type { AppsQueryOptions, AppsQueryType } from "./appResourcesTypes";

/** Builds the app manager for a watch; tests pass a factory over a fake simctl. */
export type WatchAppManagerFactory = (device: BootedDevice) => WatchAppManager;

const defaultWatchAppManager: WatchAppManagerFactory = (device) => new WatchAppManager(device);

/** installApp's executor: a watch goes to simctl, every other device keeps InstallApp. */
export function createPlatformInstallApp(
  device: BootedDevice,
  watchApps: WatchAppManagerFactory = defaultWatchAppManager,
): { execute(artifactPath: string, call?: InstallAppCall): Promise<InstallAppResult> } {
  if (device.platform !== "watchos") {
    return new InstallApp(device);
  }
  const manager = watchApps(device);
  return { execute: (artifactPath, call) => manager.install(artifactPath, call) };
}

/** uninstallApp's executor: a watch goes to simctl, every other device keeps UninstallApp. */
export function createPlatformUninstallApp(
  device: BootedDevice,
  watchApps: WatchAppManagerFactory = defaultWatchAppManager,
): { execute(appId: string, call?: UninstallAppCall): Promise<UninstallAppResult> } {
  if (device.platform !== "watchos") {
    return new UninstallApp(device);
  }
  const manager = watchApps(device);
  return { execute: (appId, call) => manager.uninstall(appId, call) };
}

/** listApps' query: a watch is listed straight from simctl, every other device keeps the cache. */
export function createPlatformQueryInstalledApps(
  watchApps: WatchAppManagerFactory = defaultWatchAppManager,
): typeof queryInstalledApps {
  return (options, signal, deps) => {
    const deviceId = options.deviceId;
    if (options.platform !== "watchos" || !deviceId) {
      return queryInstalledApps(options, signal, deps);
    }
    const device: BootedDevice = { deviceId, name: deviceId, platform: "watchos" };
    return queryWatchApps(watchApps(device), { ...options, deviceId }, signal);
  };
}

/**
 * The listApps result for a watch, in the same shape as Android and iOS. simctl's records carry
 * the same ApplicationType field as an iPhone simulator's, so the iOS normalization applies; an
 * omitted type degrades from launchable to user when no record reports launchability.
 */
async function queryWatchApps(
  manager: WatchAppManager,
  options: AppsQueryOptions & { deviceId: string },
  signal?: AbortSignal,
): Promise<AppsQueryResourceContent> {
  const { queryApps } = normalizeIosApps(await manager.listRecords(signal), false);
  signal?.throwIfAborted();
  const launchabilityUnknown = isLaunchabilityUnknown(queryApps);
  if (options.type === "launchable" && launchabilityUnknown) {
    throw new Error(
      `Cannot filter by type=launchable for watch ${options.deviceId}: simctl's app listing ` +
        "reported no ApplicationType, so launchability is unknown. Use type=user, type=system or type=all.",
    );
  }
  const type: AppsQueryType = options.type ?? (launchabilityUnknown ? "user" : "launchable");
  const query: AppsQueryOptions = { ...options, type };
  const apps = filterAppsByQuery(queryApps, query);
  const lastUpdated = new Date().toISOString();
  return {
    query,
    observationComplete: true,
    totalCount: apps.length,
    installedCount: queryApps.length,
    deviceCount: 1,
    lastUpdated,
    devices: [
      {
        deviceId: options.deviceId,
        platform: "watchos",
        totalCount: apps.length,
        lastUpdated,
        apps,
      },
    ],
  };
}
