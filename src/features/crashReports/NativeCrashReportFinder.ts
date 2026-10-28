import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import type { Timer } from "../../utils/SystemTimer";
import { AndroidDropboxCrashReportFinder } from "./AndroidDropboxCrashReportFinder";
import {
  IosSimulatorCrashReportFinder,
  type CrashReportFileSystem,
} from "./IosSimulatorCrashReportFinder";
import type {
  NativeCrashReportFinder,
  NativeCrashReportLookup,
  NativeCrashReportQuery,
  NativeCrashReportReader,
} from "./NativeCrashReport";

export type { NativeCrashReportFinder } from "./NativeCrashReport";
export {
  nodeCrashReportFileSystem,
  type CrashReportFileSystem,
} from "./IosSimulatorCrashReportFinder";

export const PHYSICAL_IOS_CRASH_REPORTS_UNSUPPORTED_REASON =
  "Crash reports on physical iOS devices are not collected yet: retrieving the device's " +
  "crash-log domain with devicectl needs device verification (#14103).";

export function unsupportedCrashReportFinder(reason: string): NativeCrashReportFinder {
  return { find: async () => ({ status: "unsupported", reason }) };
}

/** Dropbox entries are written synchronously by system_server; ~2 s covers them. */
export const ANDROID_CRASH_REPORT_POLL_DELAYS_MS: readonly number[] = [500, 500, 500];

/**
 * ReportCrash writes the Simulator `.ips` asynchronously: under host load it
 * lands 4-14 s after the process dies (#14103), so the lookup waits ~20 s.
 * crashApp always sends SIGABRT, which always produces a report, so the full
 * wait is only spent when the report is genuinely slow.
 */
export const IOS_SIMULATOR_CRASH_REPORT_POLL_DELAYS_MS: readonly number[] = [
  500, 500, 1_000, 1_000, 2_000, 3_000, 3_000, 3_000, 3_000, 3_000,
];

/**
 * Retries a lookup on the injected timer, sleeping each delay in turn, before
 * reporting `notFound`. Makes `delaysMs.length + 1` attempts.
 */
export class PollingCrashReportFinder implements NativeCrashReportFinder {
  constructor(
    private readonly inner: NativeCrashReportFinder,
    private readonly timer: Pick<Timer, "sleep">,
    private readonly delaysMs: readonly number[] = ANDROID_CRASH_REPORT_POLL_DELAYS_MS,
  ) {}

  async find(query: NativeCrashReportQuery): Promise<NativeCrashReportLookup> {
    let lookup: NativeCrashReportLookup = { status: "notFound" };
    for (let attempt = 0; attempt <= this.delaysMs.length; attempt += 1) {
      query.signal?.throwIfAborted();
      lookup = await this.inner.find(query);
      if (lookup.status !== "notFound") {
        return lookup;
      }
      const delayMs = this.delaysMs[attempt];
      if (delayMs !== undefined) {
        await this.timer.sleep(delayMs);
      }
    }
    return lookup;
  }
}

export interface NativeCrashReportFinderDependencies {
  adb: Pick<AdbExecutor, "executeCommand">;
  fileSystem: CrashReportFileSystem;
  timer: Pick<Timer, "sleep">;
}

export function createNativeCrashReportFinder(
  device: BootedDevice,
  deps: NativeCrashReportFinderDependencies,
): NativeCrashReportFinder {
  if (device.platform === "android") {
    return new PollingCrashReportFinder(new AndroidDropboxCrashReportFinder(deps.adb), deps.timer);
  }
  if (resolveIosDeviceKind({ deviceId: device.deviceId }) === "physical") {
    return unsupportedCrashReportFinder(PHYSICAL_IOS_CRASH_REPORTS_UNSUPPORTED_REASON);
  }
  return new PollingCrashReportFinder(
    new IosSimulatorCrashReportFinder(device.deviceId, deps.fileSystem),
    deps.timer,
    IOS_SIMULATOR_CRASH_REPORT_POLL_DELAYS_MS,
  );
}

/** Full-report reader for the crash-report resource; physical iOS has none yet. */
export function createNativeCrashReportReader(
  device: BootedDevice,
  deps: Omit<NativeCrashReportFinderDependencies, "timer">,
): NativeCrashReportReader | undefined {
  if (device.platform === "android") {
    return new AndroidDropboxCrashReportFinder(deps.adb);
  }
  if (resolveIosDeviceKind({ deviceId: device.deviceId }) === "physical") {
    return undefined;
  }
  return new IosSimulatorCrashReportFinder(device.deviceId, deps.fileSystem);
}
