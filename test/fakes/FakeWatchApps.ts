import type {
  WatchAppsSimctl,
  WatchBundleIdReader,
} from "../../src/features/action/watch/WatchAppManager";
import type { ExecResult } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import type { IosInstalledAppRecord } from "../../src/utils/ios-cmdline-tools/iosInstalledApp";
import { simulatorDataContainer } from "../helpers/simulatorContainerFixture";

/** simctl's answer to `terminate` for an app with no running process. */
export const SIMCTL_NOTHING_TO_TERMINATE =
  "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=164):\nfound nothing to terminate";

/**
 * A stateful simctl app host for one or more watches: `installApp` adds the bundle id the paired
 * {@link FakeWatchBundleIds} reads from the artifact, `uninstallApp` removes it, and
 * `listAppsOrThrow` reports what is installed in simctl's record shape. `launchApp` starts an
 * installed app with a pid (a running one keeps its pid), `terminateApp` stops a running one and
 * fails like simctl when nothing runs, and `get_app_container` reports an installed app's data
 * container under the synthetic device set. Every command is logged.
 */
export class FakeWatchAppsSimctl implements WatchAppsSimctl {
  readonly commands: string[] = [];
  listingError: Error | undefined;
  /** When set, `launchApp` reports this simctl failure instead of starting the app. */
  launchError: string | undefined;
  /** When set, `terminateApp` throws this instead of stopping the app. */
  terminateError: Error | undefined;
  private readonly installed = new Map<string, Map<string, IosInstalledAppRecord>>();
  private readonly running = new Map<string, Map<string, number>>();
  private nextPid = 4100;

  constructor(private readonly bundleIds: FakeWatchBundleIds) {}

  /** Preinstall an app record (a system app such as the Watch's Settings). */
  seed(udid: string, record: IosInstalledAppRecord & { CFBundleIdentifier: string }): void {
    this.appsOf(udid).set(record.CFBundleIdentifier, record);
  }

  async installApp(appPath: string, deviceId?: string): Promise<void> {
    const udid = deviceId ?? "";
    this.commands.push(`install ${udid} ${appPath}`);
    const bundleId = this.bundleIds.byPath.get(appPath.replace(/[\\/]+$/, ""));
    if (!bundleId) {
      throw new Error(`simctl install: no app at ${appPath}`);
    }
    this.appsOf(udid).set(bundleId, {
      CFBundleIdentifier: bundleId,
      ApplicationType: "User",
      CFBundleDisplayName: bundleId.split(".").pop(),
    });
  }

  async uninstallApp(bundleId: string, deviceId?: string): Promise<void> {
    const udid = deviceId ?? "";
    this.commands.push(`uninstall ${udid} ${bundleId}`);
    this.appsOf(udid).delete(bundleId);
    this.runningOf(udid).delete(bundleId);
  }

  async launchApp(
    bundleId: string,
    options?: { launchArguments?: string[] },
    deviceId?: string,
  ): Promise<{ success: boolean; pid?: number; error?: string }> {
    const udid = deviceId ?? "";
    this.commands.push(["launch", udid, bundleId, ...(options?.launchArguments ?? [])].join(" "));
    if (this.launchError) {
      return { success: false, error: this.launchError };
    }
    if (!this.appsOf(udid).has(bundleId)) {
      return { success: false, error: `simctl launch: ${bundleId} is not installed` };
    }
    const running = this.runningOf(udid);
    const pid = running.get(bundleId) ?? this.nextPid++;
    running.set(bundleId, pid);
    return { success: true, pid };
  }

  async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
    const udid = deviceId ?? "";
    this.commands.push(`terminate ${udid} ${bundleId}`);
    if (this.terminateError) {
      throw this.terminateError;
    }
    if (!this.runningOf(udid).delete(bundleId)) {
      throw new Error(SIMCTL_NOTHING_TO_TERMINATE);
    }
  }

  async executeCommandArgs(args: string[]): Promise<ExecResult> {
    this.commands.push(args.join(" "));
    const [command, udid = "", bundleId = "", container] = args;
    if (command !== "get_app_container" || container !== "data") {
      throw new Error(`FakeWatchAppsSimctl: unexpected simctl ${args.join(" ")}`);
    }
    // simctl prints nothing useful and fails for an app that is not installed.
    if (!this.appsOf(udid).has(bundleId)) {
      throw new Error(`simctl get_app_container: ${bundleId} is not installed`);
    }
    return createExecResult(`${simulatorDataContainer(udid)}\n`, "");
  }

  /** The pid of a running app, else undefined. */
  pidOf(udid: string, bundleId: string): number | undefined {
    return this.runningOf(udid).get(bundleId);
  }

  async listAppsOrThrow(deviceId?: string): Promise<IosInstalledAppRecord[]> {
    if (this.listingError) {
      throw this.listingError;
    }
    return [...this.appsOf(deviceId ?? "").values()];
  }

  private runningOf(udid: string): Map<string, number> {
    let apps = this.running.get(udid);
    if (!apps) {
      apps = new Map();
      this.running.set(udid, apps);
    }
    return apps;
  }

  private appsOf(udid: string): Map<string, IosInstalledAppRecord> {
    let apps = this.installed.get(udid);
    if (!apps) {
      apps = new Map();
      this.installed.set(udid, apps);
    }
    return apps;
  }
}

/** Info.plist reads keyed by `<app>/Info.plist`; an unknown path fails like plutil does. */
export class FakeWatchBundleIds implements WatchBundleIdReader {
  readonly byPath = new Map<string, string>();
  readonly reads: string[] = [];

  async extractRawFile(key: string, plistPath: string): Promise<string> {
    this.reads.push(`${key} ${plistPath}`);
    const appPath = plistPath.replace(/[\\/]+Info\.plist$/, "");
    const bundleId = this.byPath.get(appPath);
    if (bundleId === undefined) {
      throw new Error(`plutil: ${plistPath}: No such file or directory`);
    }
    return `${bundleId}\n`;
  }
}
