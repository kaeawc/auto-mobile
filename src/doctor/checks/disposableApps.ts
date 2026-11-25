import { defaultDisposableAppManager } from "../../server/prototypeTools/disposableApps";
import type { DisposableAppListEntry } from "../../features/prototype/disposableApp/DisposableAppManager";
import type { DisposableAppPlatform } from "../../features/prototype/disposableApp/disposableAppId";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { awaitDoctorProbe, remainingDoctorProbe } from "../deadline";
import type { CheckResult, DoctorProbeOptions } from "../types";
import type { DoctorAdbFactory } from "./android";

export interface DisposableAppLister {
  list(
    deviceId: string,
    platform: DisposableAppPlatform,
  ): Promise<Pick<DisposableAppListEntry, "appId" | "expired" | "installed">[]>;
}

/** Lists this host's disposable-app registry, reading the device only for apps it recorded. */
export const defaultDisposableAppLister = (
  timer?: DoctorProbeOptions["timer"],
): DisposableAppLister => ({
  list: (deviceId, platform) => defaultDisposableAppManager({ timer }).list(deviceId, platform),
});

export interface DisposableAppDoctorDependencies {
  adbFactory: DoctorAdbFactory<"getBootedAndroidDevices">;
  lister: DisposableAppLister;
}

const CHECK_NAME = "Expired Disposable Apps";

function checkFailure(name: string, error: unknown): CheckResult {
  const message = `Could not check for expired disposable apps: ${errorMessage(error)}`;
  logger.warn(`${name}: ${message}`, error);
  return { name, status: "warn", message };
}

async function checkDevice(
  { deviceId, platform }: { deviceId: string; platform: DisposableAppPlatform },
  lister: DisposableAppLister,
  probe: DoctorProbeOptions,
): Promise<CheckResult> {
  const name = `${CHECK_NAME} (${deviceId})`;
  try {
    const entries = await awaitDoctorProbe(probe, () =>
      runWithAbortSignal(probe.signal, () => lister.list(deviceId, platform)),
    );
    const expired = entries.filter((entry) => entry.expired).map((entry) => entry.appId);
    if (expired.length === 0) {
      return { name, status: "pass", message: "No expired disposable apps" };
    }
    const ids = expired.join(", ");
    return {
      name,
      status: "warn",
      message: `Expired disposable apps still installed or registered: ${ids}`,
      recommendation: `Run uninstallApp {expired:true} on ${deviceId} to remove ${ids}.`,
    };
  } catch (error) {
    remainingDoctorProbe(probe);
    return checkFailure(name, error);
  }
}

export async function checkExpiredDisposableApps(
  probe: DoctorProbeOptions = {},
  { adbFactory, lister }: DisposableAppDoctorDependencies = {
    adbFactory: defaultAdbClientFactory,
    lister: defaultDisposableAppLister(probe.timer),
  },
): Promise<CheckResult[]> {
  const current = remainingDoctorProbe(probe);
  try {
    const devices = await awaitDoctorProbe(probe, () =>
      adbFactory.create().getBootedAndroidDevices({
        signal: current.signal,
        timeoutMs: current.timeoutMs,
      }),
    );
    if (devices.length === 0) {
      return [{ name: CHECK_NAME, status: "skip", message: "No Android devices connected" }];
    }
    return await Promise.all(
      devices.map(({ deviceId }) => checkDevice({ deviceId, platform: "android" }, lister, probe)),
    );
  } catch (error) {
    remainingDoctorProbe(probe);
    return [checkFailure(CHECK_NAME, error)];
  }
}

export interface IosDisposableAppDoctorDependencies {
  platform: () => NodeJS.Platform;
  simctl: Pick<SimCtl, "isAvailable" | "getBootedSimulatorsChecked">;
  lister: DisposableAppLister;
}

/** The iOS counterpart: expired disposable apps on each booted simulator (#14184). */
export async function checkExpiredIosDisposableApps(
  probe: DoctorProbeOptions,
  { platform, simctl, lister }: IosDisposableAppDoctorDependencies,
): Promise<CheckResult[]> {
  const name = `${CHECK_NAME} (iOS)`;
  if (platform() !== "darwin") {
    return [{ name, status: "skip", message: "iOS simulators only available on macOS" }];
  }
  const current = remainingDoctorProbe(probe);
  try {
    const available = await awaitDoctorProbe(probe, () =>
      simctl.isAvailable({ signal: current.signal, timeoutMs: current.timeoutMs }),
    );
    if (!available) {
      return [{ name, status: "skip", message: "simctl not available" }];
    }
    const simulators = await awaitDoctorProbe(probe, () =>
      simctl.getBootedSimulatorsChecked(current.timeoutMs, current.signal),
    );
    if (simulators.length === 0) {
      return [{ name, status: "skip", message: "No iOS simulators booted" }];
    }
    return await Promise.all(
      simulators.map(({ deviceId }) => checkDevice({ deviceId, platform: "ios" }, lister, probe)),
    );
  } catch (error) {
    remainingDoctorProbe(probe);
    return [checkFailure(name, error)];
  }
}
