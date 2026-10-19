import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import {
  RUNNER_CONNECT_DIAGNOSTIC_TIMEOUT_MS,
  RunnerReadinessService,
  normalizeDiagnostic,
  type AndroidFrameworkReadinessResult,
  type AndroidRunnerHealthDiagnostic,
} from "../ctrlProxy/RunnerReadinessService";
import { errorMessage } from "../utils/describeUnknownError";
import { isAndroidFrameworkUnavailable } from "../utils/android-cmdline-tools/isAndroidFrameworkUnavailable";
import type { BootedDevice } from "../models";
import { checkIosCtrlProxyOverride } from "../utils/iosCtrlProxyOverride";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

async function getDefaultAndroidFrameworkReadiness(
  device: BootedDevice,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<AndroidFrameworkReadinessResult> {
  const adb = defaultAdbClientFactory.create(device);
  const [packageLookup, settingsLookup] = await Promise.allSettled([
    adb.execute(["shell", "cmd", "package", "path", "android"], {
      timeoutMs,
      noRetry: true,
      signal,
    }),
    adb.execute(["shell", "settings", "get", "secure", "accessibility_enabled"], {
      timeoutMs,
      noRetry: true,
      signal,
    }),
  ]);
  signal.throwIfAborted();

  const unavailableResources: string[] = [];
  const diagnostics: string[] = [];
  if (packageLookup.status === "rejected" || !packageLookup.value.stdout.includes("package:")) {
    unavailableResources.push("package");
    diagnostics.push(
      packageLookup.status === "rejected"
        ? `package: ${normalizeDiagnostic(packageLookup.reason)}`
        : `package: ${normalizeDiagnostic(packageLookup.value.stdout || packageLookup.value.stderr)}`,
    );
  }
  if (
    settingsLookup.status === "rejected" ||
    isAndroidFrameworkUnavailable(`${settingsLookup.value.stdout}\n${settingsLookup.value.stderr}`)
  ) {
    unavailableResources.push("settings");
    diagnostics.push(
      settingsLookup.status === "rejected"
        ? `settings: ${normalizeDiagnostic(settingsLookup.reason)}`
        : `settings: ${normalizeDiagnostic(settingsLookup.value.stdout || settingsLookup.value.stderr)}`,
    );
  }
  return {
    ready: unavailableResources.length === 0,
    ...(unavailableResources.length > 0 ? { unavailableResources } : {}),
    ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join("; ") } : {}),
  };
}

function compactDiagnosticValue(value: string): string {
  return normalizeDiagnostic(value).replace(/\s+/g, " ").trim() || "empty";
}

async function getDefaultAndroidRunnerHealthDiagnostic(
  device: BootedDevice,
  signal: AbortSignal,
): Promise<AndroidRunnerHealthDiagnostic> {
  const deviceAdb = defaultAdbClientFactory.create(device);
  // Use an unbound client for `adb devices -l`, which is a server-wide view.
  const adbServer = defaultAdbClientFactory.create();
  const options = {
    timeoutMs: RUNNER_CONNECT_DIAGNOSTIC_TIMEOUT_MS,
    noRetry: true,
    signal,
  };
  const [bootCompleted, adbDevices, emulatorQemuHealth] = await Promise.allSettled([
    deviceAdb.execute(["shell", "getprop", "sys.boot_completed"], options),
    adbServer.execute(["devices", "-l"], options),
    adbServer.execute(["-s", device.deviceId, "get-state"], options),
  ]);

  const output = (result: PromiseSettledResult<{ stdout: string; stderr: string }>): string =>
    result.status === "fulfilled"
      ? compactDiagnosticValue(result.value.stdout || result.value.stderr)
      : `unavailable (${compactDiagnosticValue(errorMessage(result.reason))})`;
  return {
    sysBootCompleted: output(bootCompleted),
    adbDevices: output(adbDevices),
    emulatorQemuHealth: output(emulatorQemuHealth),
  };
}

export function createDefaultRunnerReadinessService(
  timer: Timer = defaultTimer,
): RunnerReadinessService {
  return new RunnerReadinessService({
    timer,
    getAndroidFrameworkReadiness: getDefaultAndroidFrameworkReadiness,
    getAndroidManager: (device) => AndroidCtrlProxyManager.getInstance(device),
    getAndroidClient: (device) => AndroidCtrlProxyClient.getInstance(device),
    getIosManager: (device) => IOSCtrlProxyManager.getInstance(device),
    getIosClient: (device, port) => IOSCtrlProxyClient.getInstance(device, port),
    checkIosOverride: checkIosCtrlProxyOverride,
    awaitIosStartupMaintenance: () => IOSCtrlProxyManager.awaitStartupOrphanRunnerReap(),
    getAndroidRunnerConnectDiagnostic: async (device, signal) => {
      const adb = defaultAdbClientFactory.create(device);
      const [deviceLock, users] = await Promise.all([
        adb.getDeviceLock(signal),
        adb.listUsers(signal),
      ]);
      const primaryUser = users.find((user) => user.profileType === "primary" || user.userId === 0);
      return { deviceLock, primaryUserStartState: primaryUser?.startState };
    },
    getAndroidRunnerHealthDiagnostic: getDefaultAndroidRunnerHealthDiagnostic,
  });
}
