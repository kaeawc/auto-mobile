import type {
  WatchAppsSimctl,
  WatchBundleIdReader,
} from "../../src/features/action/watch/WatchAppManager";
import type { IosInstalledAppRecord } from "../../src/utils/ios-cmdline-tools/iosInstalledApp";

/**
 * A stateful simctl app host for one or more watches: `installApp` adds the bundle id the paired
 * {@link FakeWatchBundleIds} reads from the artifact, `uninstallApp` removes it, and
 * `listAppsOrThrow` reports what is installed in simctl's record shape. Every mutation is logged.
 */
export class FakeWatchAppsSimctl implements WatchAppsSimctl {
  readonly commands: string[] = [];
  listingError: Error | undefined;
  private readonly installed = new Map<string, Map<string, IosInstalledAppRecord>>();

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
  }

  async listAppsOrThrow(deviceId?: string): Promise<IosInstalledAppRecord[]> {
    if (this.listingError) {
      throw this.listingError;
    }
    return [...this.appsOf(deviceId ?? "").values()];
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
