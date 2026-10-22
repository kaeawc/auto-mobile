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

/**
 * ReportCrash writes the `.ips` shortly after the process dies, so a lookup
 * retries a few times on the injected timer before reporting `notFound`.
 */
export class PollingCrashReportFinder implements NativeCrashReportFinder {
  constructor(
    private readonly inner: NativeCrashReportFinder,
    private readonly timer: Pick<Timer, "sleep">,
    private readonly attempts = 4,
    private readonly intervalMs = 500,
  ) {}

  async find(query: NativeCrashReportQuery): Promise<NativeCrashReportLookup> {
    let lookup: NativeCrashReportLookup = { status: "notFound" };
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      query.signal?.throwIfAborted();
      lookup = await this.inner.find(query);
      if (lookup.status !== "notFound") {
        return lookup;
      }
      if (attempt + 1 < this.attempts) {
        await this.timer.sleep(this.intervalMs);
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
