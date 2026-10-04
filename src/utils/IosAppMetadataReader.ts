import type { AppMetadataResult } from "../models/AppMetadataResult";
import type { IosAppMetadataSource } from "../models/IosAppMetadataSource";
import type { BootedDevice } from "../models";
import { resolveIosAppInfoBackend } from "./ios-cmdline-tools/IosDeviceBackend";
import { logger } from "./logger";

export interface AppMetadataReader {
  execute(appId: string): Promise<Pick<AppMetadataResult, "installPath"> | null>;
}

export class IosAppMetadataReader implements AppMetadataReader {
  constructor(
    private readonly device: BootedDevice,
    private readonly iosSource: IosAppMetadataSource | null = null,
    private readonly iosAppInfoBackendResolver = resolveIosAppInfoBackend,
  ) {}

  async execute(bundleId: string): Promise<AppMetadataResult | null> {
    if (!this.iosSource) {
      logger.warn("[GetAppMetadata] No iOS metadata source configured");
      return null;
    }

    const app = await this.iosAppInfoBackendResolver(this.device.deviceId, {
      iosSource: this.iosSource,
      findAppByBundleId,
    }).getAppInfo(bundleId);
    if (!app) {
      return null;
    }
    return iosRecordToMetadata(bundleId, app);
  }
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
