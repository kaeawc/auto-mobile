import { defaultDisposableAppManager } from "../../server/prototypeTools/disposableApps";
import type { DisposableAppListEntry } from "../../features/prototype/disposableApp/DisposableAppManager";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { awaitDoctorProbe, remainingDoctorProbe } from "../deadline";
import type { CheckResult, DoctorProbeOptions } from "../types";
import type { DoctorAdbFactory } from "./android";

interface DisposableAppLister {
  list(
    deviceId: string,
    platform: "android",
  ): Promise<Pick<DisposableAppListEntry, "appId" | "expired" | "installed">[]>;
}

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
  deviceId: string,
  lister: DisposableAppLister,
  probe: DoctorProbeOptions,
): Promise<CheckResult> {
  const name = `${CHECK_NAME} (${deviceId})`;
  try {
    const entries = await awaitDoctorProbe(probe, () =>
      runWithAbortSignal(probe.signal, () => lister.list(deviceId, "android")),
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
    lister: {
      list: (deviceId, platform) =>
        defaultDisposableAppManager({ timer: probe.timer }).list(deviceId, platform),
    },
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
    return await Promise.all(devices.map(({ deviceId }) => checkDevice(deviceId, lister, probe)));
  } catch (error) {
    remainingDoctorProbe(probe);
    return [checkFailure(CHECK_NAME, error)];
  }
}
