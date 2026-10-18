import type { BootedDevice, LaunchAppResult } from "../../../models";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { logger } from "../../../utils/logger";
import {
  resolveIosColdStartTerminateBackend,
  type IosLaunchBackend,
} from "../../../utils/ios-cmdline-tools/IosDeviceBackend";
import { resolveIosColdAppCheckKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../../observe/ios";
import type { IosClearAppDataRunner, LaunchAppSimctl } from "../LaunchApp";

export interface IosLaunchProcessOptions {
  launchArguments?: string[];
  launchEnvironment?: Record<string, string>;
}

export function needsIosColdStart(
  coldBoot: boolean,
  clearAppData: boolean,
  { launchArguments, launchEnvironment }: IosLaunchProcessOptions,
): boolean {
  return (
    coldBoot || clearAppData || Boolean(launchArguments?.length) || launchEnvironment !== undefined
  );
}

function coldIosLaunchOptions({ launchArguments, launchEnvironment }: IosLaunchProcessOptions) {
  return {
    foregroundIfRunning: false,
    launchArguments,
    ...(launchEnvironment === undefined ? {} : { environment: launchEnvironment }),
  };
}

interface IosAppCheckOptions {
  bundleId: string;
  isSystemBundleId: boolean;
  perf: PerformanceTracker;
  signal?: AbortSignal;
  checkInstalled: (
    bundleId: string,
    perf: PerformanceTracker,
    signal?: AbortSignal,
    coldPrecheck?: boolean,
  ) => Promise<LaunchAppResult | undefined>;
}

export async function checkColdIosAppNotInstalled(
  options: IosAppCheckOptions & { needsColdStart: boolean; device: BootedDevice },
): Promise<LaunchAppResult | undefined> {
  const { needsColdStart, isSystemBundleId, device, checkInstalled, bundleId, perf, signal } =
    options;
  // Unknown IDs cannot safely use the physical lister: its routing differs from launch.
  if (needsColdStart && !isSystemBundleId && resolveIosColdAppCheckKind(device) !== undefined) {
    return checkInstalled(bundleId, perf, signal, true);
  }
  return undefined;
}

type IosProcessResult = Awaited<ReturnType<IosLaunchBackend["launchApp"]>>;
type IosProcessOutcome =
  | { kind: "launched"; result: IosProcessResult }
  | { kind: "failed"; result: LaunchAppResult };

interface ColdIosLaunchOptions {
  device: BootedDevice;
  bundleId: string;
  clearAppData: boolean;
  isSystemBundleId: boolean;
  perf: PerformanceTracker;
  signal?: AbortSignal;
  processOptions: IosLaunchProcessOptions;
  backend: IosLaunchBackend;
  simctl: LaunchAppSimctl;
  ctrlProxyClient: IosCtrlProxy;
  clearAppDataFactory: (device: BootedDevice, simctl: LaunchAppSimctl) => IosClearAppDataRunner;
  terminateBeforeLaunch: (
    terminator: NonNullable<ReturnType<typeof resolveIosColdStartTerminateBackend>>,
    bundleId: string,
  ) => Promise<void>;
}

export async function launchColdIosProcess(
  options: ColdIosLaunchOptions,
): Promise<IosProcessOutcome> {
  const { device, bundleId, perf, signal, simctl, ctrlProxyClient, backend, processOptions } =
    options;
  // Physical devices use --terminate-existing on launch, avoiding a redundant round-trip.
  const terminator = resolveIosColdStartTerminateBackend(device.deviceId, { simctl });
  if (terminator) {
    await perf.track("terminateApp", () => options.terminateBeforeLaunch(terminator, bundleId));
    signal?.throwIfAborted();
  }

  // Keep permission grants; system bundles must never have their containers wiped.
  if (options.clearAppData && !options.isSystemBundleId) {
    const clearResult = await perf.track("clearAppData", () =>
      options.clearAppDataFactory(device, simctl).execute(bundleId),
    );
    signal?.throwIfAborted();
    if (!clearResult.success) {
      const error = `Failed to clear app data: ${clearResult.error ?? "unknown error"}`;
      logger.warn(`[LaunchApp] iOS clearAppData failed for ${bundleId}: ${error}`);
      perf.end();
      return { kind: "failed", result: { success: false, packageName: bundleId, error } };
    }
  } else if (options.clearAppData && options.isSystemBundleId) {
    logger.warn(`[LaunchApp] Ignoring clearAppData for system bundle ${bundleId}`);
  }

  // Drop the hierarchy entirely: invalidateCache can still serve stale pre-wipe data
  // when a refetch fails. The bundle was already retargeted before this preparation.
  ctrlProxyClient.clearCache();
  IOSCtrlProxyClient.getExistingInstance(device.deviceId)?.clearSdkScreenIdentity(bundleId);
  const launchResult = await perf.track("launch", () =>
    backend.launchApp(bundleId, coldIosLaunchOptions(processOptions)),
  );
  signal?.throwIfAborted();
  return { kind: "launched", result: launchResult };
}

export async function launchWarmIosProcess(
  options: IosAppCheckOptions & {
    backend: IosLaunchBackend;
    launchArguments?: string[];
  },
): Promise<IosProcessOutcome> {
  const { bundleId, perf, signal, backend, launchArguments, isSystemBundleId, checkInstalled } =
    options;
  // simctl foregrounds an existing app; devicectl relaunches with --terminate-existing.
  const launchResult = await perf.track("launch", () =>
    backend.launchApp(bundleId, { launchArguments }),
  );
  signal?.throwIfAborted();
  if (!launchResult.success) {
    logger.warn(`[LaunchApp] launch failed: ${launchResult.error ?? "unknown error"}`);
  }

  // Only simulators have a reliable fallback listing; physical launch errors are authoritative.
  if (!launchResult.success && !isSystemBundleId && backend.kind === "simulator") {
    const missingApp = await checkInstalled(bundleId, perf, signal);
    if (missingApp) {
      perf.end();
      return { kind: "failed", result: missingApp };
    }
  }
  return { kind: "launched", result: launchResult };
}
