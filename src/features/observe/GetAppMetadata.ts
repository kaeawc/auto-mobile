import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AppMetadataResult } from "../../models/AppMetadataResult";
import type { BootedDevice, ExecResult } from "../../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "./android";
import { resolveIosAppInfoBackend } from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { shellQuote } from "../../utils/shellQuote";
import type { IosAppMetadataSource } from "../../models/IosAppMetadataSource";
import { outputReportsMissingPackage } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";

export type { IosAppMetadataSource };
import { IosAppMetadataReader } from "../../utils/IosAppMetadataReader";
export { findAppByBundleId, iosRecordToMetadata } from "../../utils/IosAppMetadataReader";

export class GetAppMetadata {
  private readonly device: BootedDevice;
  private readonly adb: AdbExecutor;
  private readonly iosSource: IosAppMetadataSource | null;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    iosSource: IosAppMetadataSource | null = null,
    private readonly iosAppInfoBackendResolver = resolveIosAppInfoBackend,
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

    return getAndroidAppMetadataFromAdb(this.adb, packageName);
  }

  private async getIosMetadata(bundleId: string): Promise<AppMetadataResult | null> {
    return new IosAppMetadataReader(
      this.device,
      this.iosSource,
      this.iosAppInfoBackendResolver,
    ).execute(bundleId);
  }
}

/**
 * Reads Android package metadata through ADB only. Unlike {@link GetAppMetadata.execute},
 * this deliberately does not construct an AndroidCtrlProxyClient.
 */
export async function getAndroidAppMetadataViaAdb(
  device: BootedDevice,
  packageName: string,
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  options: AndroidAppMetadataAdbOptions = {},
): Promise<AppMetadataResult | null> {
  return getAndroidAppMetadataFromAdb(adbFactory.create(device), packageName, options);
}

export interface AndroidAppMetadataAdbOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Treat lookup failure as expected best-effort enrichment. */
  optional?: boolean;
}

export async function getAndroidAppMetadataFromAdb(
  adb: AdbExecutor,
  packageName: string,
  options: AndroidAppMetadataAdbOptions = {},
): Promise<AppMetadataResult | null> {
  let result: ExecResult;
  try {
    result = await adb.executeCommand(
      `shell dumpsys package ${shellQuote(packageName)}`,
      options.timeoutMs,
      DUMPSYS_MAX_BUFFER,
      undefined,
      options.signal,
    );
  } catch (error) {
    if (options.optional) {
      // Optional version enrichment may be unavailable without failing the resource read.
      logger.debug(
        `[GetAppMetadata] Failed to run dumpsys package for ${packageName}: ${errorMessage(error)}`,
      );
      return null;
    }
    throw toActionableError(error, `Failed to run dumpsys package for ${packageName}`);
  }

  const output = result.stdout;
  if (!output || outputReportsMissingPackage(output)) {
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
