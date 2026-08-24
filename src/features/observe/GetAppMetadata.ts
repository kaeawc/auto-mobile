import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AppMetadataResult } from "../../models/AppMetadataResult";
import type { BootedDevice, ExecResult } from "../../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "./android";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

/**
 * Source of iOS app metadata — injectable for testing.
 */
export interface IosAppMetadataSource {
  listApps(deviceId?: string): Promise<Record<string, unknown>[]>;
  getPhysicalDeviceAppInfo(
    deviceId: string,
    bundleId: string,
  ): Promise<Record<string, unknown> | null>;
}

export class GetAppMetadata {
  private readonly device: BootedDevice;
  private readonly adb: AdbExecutor;
  private readonly iosSource: IosAppMetadataSource | null;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    iosSource: IosAppMetadataSource | null = null,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.iosSource = iosSource;
  }

  async execute(appId: string): Promise<AppMetadataResult | null> {
    if (this.device.platform === "android") {
      return this.getAndroidMetadata(appId);
    }
    return this.getIosMetadata(appId);
  }

  private async getAndroidMetadata(packageName: string): Promise<AppMetadataResult | null> {
    // Prefer WebSocket-backed PackageManager call; fall back to ADB dumpsys.
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const info = await a11y.requestPackageInfo(packageName, { includePermissions: false }, 4000);
      if (info.success) {
        const versionName = info.versionName ?? "";
        const buildNumber =
          info.versionCode !== undefined && info.versionCode !== null
            ? String(info.versionCode)
            : "";
        const firstInstallTime = info.firstInstallTime
          ? new Date(info.firstInstallTime).toString()
          : undefined;
        const lastUpdateTime = info.lastUpdateTime
          ? new Date(info.lastUpdateTime).toString()
          : undefined;
        if (!versionName && !buildNumber) {
          return null;
        }
        return {
          appId: packageName,
          platform: "android",
          versionName,
          buildNumber,
          installPath: "",
          ...(firstInstallTime ? { firstInstallTime } : {}),
          ...(lastUpdateTime ? { lastUpdateTime } : {}),
        };
      }
      logger.debug(`[GetAppMetadata] a11y package info failed: ${info.error}`);
    } catch (error) {
      logger.debug(`[GetAppMetadata] a11y package info threw: ${error}`);
    }

    let result: ExecResult;
    try {
      result = await this.adb.executeCommand(`shell dumpsys package ${packageName}`);
    } catch (error) {
      logger.warn(`[GetAppMetadata] Failed to run dumpsys package for ${packageName}: ${error}`);
      return null;
    }

    const output = result.stdout;
    if (!output || output.includes("Unable to find package")) {
      return null;
    }

    const versionName = extractField(output, /versionName=(\S+)/);
    const versionCode = extractField(output, /versionCode=(\d+)/);
    const codePath = extractField(output, /codePath=(\S+)/);
    const firstInstallTime = extractTimestamp(output, /firstInstallTime=(.+)/);
    const lastUpdateTime = extractTimestamp(output, /lastUpdateTime=(.+)/);

    if (!versionName && !versionCode && !codePath) {
      return null;
    }

    return {
      appId: packageName,
      platform: "android",
      versionName: versionName ?? "",
      buildNumber: versionCode ?? "",
      installPath: codePath ?? "",
      ...(firstInstallTime ? { firstInstallTime } : {}),
      ...(lastUpdateTime ? { lastUpdateTime } : {}),
    };
  }

  private async getIosMetadata(bundleId: string): Promise<AppMetadataResult | null> {
    if (!this.iosSource) {
      logger.warn("[GetAppMetadata] No iOS metadata source configured");
      return null;
    }

    const isSimulator = isIosSimulatorUdid(this.device.deviceId);

    if (isSimulator) {
      return this.getSimulatorMetadata(bundleId);
    }

    return this.getPhysicalDeviceMetadata(bundleId);
  }

  private async getSimulatorMetadata(bundleId: string): Promise<AppMetadataResult | null> {
    let apps: Record<string, unknown>[];
    try {
      apps = await this.iosSource!.listApps(this.device.deviceId);
    } catch (error) {
      logger.warn(`[GetAppMetadata] Failed to list iOS apps: ${error}`);
      return null;
    }
    const app = findAppByBundleId(apps, bundleId);
    if (!app) {
      return null;
    }
    return iosRecordToMetadata(bundleId, app);
  }

  private async getPhysicalDeviceMetadata(bundleId: string): Promise<AppMetadataResult | null> {
    let app: Record<string, unknown> | null;
    try {
      app = await this.iosSource!.getPhysicalDeviceAppInfo(this.device.deviceId, bundleId);
    } catch (error) {
      logger.warn(`[GetAppMetadata] Failed to get physical device app info: ${error}`);
      return null;
    }
    if (!app) {
      return null;
    }
    return iosRecordToMetadata(bundleId, app);
  }
}

// --- Parsing helpers ---

function extractField(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function extractTimestamp(text: string, pattern: RegExp): string | undefined {
  const raw = extractField(text, pattern);
  if (!raw) {
    return undefined;
  }
  // Return raw device-local timestamp as-is — dumpsys emits without timezone
  // offset, so Date.parse would silently apply host timezone and skew the value.
  return raw;
}

function readStringField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readAppField(app: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readStringField(app[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function findAppByBundleId(
  apps: Record<string, unknown>[],
  bundleId: string,
): Record<string, unknown> | null {
  for (const app of apps) {
    const id = readAppField(app, [
      "bundleId",
      "bundleIdentifier",
      "bundleID",
      "CFBundleIdentifier",
    ]);
    if (id === bundleId) {
      return app;
    }
  }
  return null;
}

export function iosRecordToMetadata(
  bundleId: string,
  app: Record<string, unknown>,
): AppMetadataResult {
  const versionName =
    readAppField(app, [
      "bundleShortVersionString",
      "CFBundleShortVersionString",
      "BundleShortVersionString",
      "version",
    ]) ?? "";

  const buildNumber =
    readAppField(app, ["bundleVersion", "CFBundleVersion", "BundleVersion"]) ?? "";

  const installPath =
    readAppField(app, ["bundlePath", "bundleURL", "bundleContainer", "path", "Path", "url"]) ?? "";

  return {
    appId: bundleId,
    platform: "ios",
    versionName,
    buildNumber,
    installPath,
  };
}
