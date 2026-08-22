/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { CheckResult } from "../types";
import type { DoctorOptions } from "../types";
import { platform as getHostPlatform } from "node:os";
import { DaemonManager } from "../../daemon/manager";
import { getDaemonHealthReport } from "../../daemon/debugTools";
import type { DaemonHealthReport } from "../../daemon/debugTools";
import type { DaemonStatus } from "../../daemon/types";
import {
  buildIdentitiesMatch,
  buildIdentityFromStatus,
  describeBuildIdentity,
  getCurrentBuildIdentity,
} from "../../daemon/buildIdentity";
import type { BuildIdentity } from "../../daemon/buildIdentity";
import {
  isExplicitPin,
  LATEST_RELEASE_VERSION,
  resolveApkUrl,
  resolveAssetVersion,
  resolveDaemonInstallSpecifier,
  resolveIpaUrl,
  resolvePinnedVersion,
} from "../../constants/release";
import { getMcpServerVersion } from "../../utils/mcpVersion";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyManager } from "../../utils/CtrlProxyManager";
import { loadSharp, type SharpFactory } from "../../utils/image/loadSharp";
import { WebpBinaryResolver, type ResolvedWebpBinaries } from "../../utils/image/webp/WebpBinaryResolver";
import { logger } from "../../utils/logger";
import type { Logger } from "../../utils/logger";
import { ActionableError } from "../../models/ActionableError";

const RELEASES_URL = "https://github.com/kaeawc/auto-mobile/releases";

interface DaemonStatusManager {
  status(): Promise<DaemonStatus>;
}

export interface DaemonStatusDependencies {
  daemonManager?: DaemonStatusManager;
  getDaemonHealthReport?: () => Promise<DaemonHealthReport>;
}

export interface DaemonBuildIdentityDependencies {
  daemonManager?: DaemonStatusManager;
  getClientBuildIdentity?: () => BuildIdentity;
}

export interface CtrlProxyDoctorDependencies {
  logger?: Logger;
}

export interface AutoMobileCheckDependencies {
  checkImageBackend?: () => Promise<CheckResult>;
  checkDaemonStatus?: () => Promise<CheckResult>;
  checkDaemonConnectivity?: () => Promise<CheckResult>;
  checkDaemonBuildIdentity?: () => Promise<CheckResult>;
  /** Android-branch seams so unit tests avoid real CtrlProxy/ADB I/O. */
  checkCtrlProxy?: () => Promise<CheckResult>;
  checkWorkProfileAccessibility?: () => Promise<CheckResult>;
}

export interface ImageBackendDoctorLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface ImageBackendDoctorDependencies {
  platform?: NodeJS.Platform;
  hostPlatform?: NodeJS.Platform;
  sharpLoader?: () => Promise<SharpFactory>;
  webpBinaryResolver?: { resolve(): Promise<ResolvedWebpBinaries> };
  logger?: ImageBackendDoctorLogger;
}

/**
 * Report the daemon JS package version, sourced from package.json.
 */
export function checkDaemonVersion(): CheckResult {
  const version = getMcpServerVersion();
  return {
    name: "AutoMobile Daemon Version",
    status: "pass",
    message: `Version ${version}`,
    value: version,
  };
}

/**
 * Report the on-device CtrlProxy release version. Distinct from the daemon
 * version: the daemon ships its own JS via npm, but the on-device APK/IPA
 * comes from the release registry.
 */
export function checkCtrlProxyVersion(): CheckResult {
  const pinned = resolvePinnedVersion();
  const resolved = resolveAssetVersion(pinned);
  return {
    name: "CtrlProxy Release Version",
    status: "pass",
    message: `Version ${resolved}${pinned === LATEST_RELEASE_VERSION ? " (latest)" : ""}`,
    value: resolved,
  };
}

/**
 * Report the active image backend and the platform-specific provisioning that
 * makes it usable without doing real image work.
 */
export async function checkImageBackend(
  dependencies: ImageBackendDoctorDependencies = {}
): Promise<CheckResult> {
  const platform = dependencies.platform ?? process.platform;
  const hostPlatform = dependencies.hostPlatform ?? getHostPlatform();
  const log = dependencies.logger ?? logger;

  if (platform === "win32") {
    try {
      const binaries = await (dependencies.webpBinaryResolver ?? new WebpBinaryResolver()).resolve();
      return {
        name: "Image Backend",
        status: "pass",
        message: `active=jimp-cli; cwebp=${binaries.cwebp}; dwebp=${binaries.dwebp}`,
      };
    } catch (error) {
      const message = errorMessage(error);
      log.warn(`Image backend doctor check failed: ${message}`, error);
      return {
        name: "Image Backend",
        status: "fail",
        message: `active=jimp-cli; cwebp=unavailable; dwebp=unavailable; error=${message}`,
        recommendation:
          "Ensure bundled vendor/libwebp/win32-x64/cwebp.exe and dwebp.exe are present, " +
          "or set AUTOMOBILE_CWEBP_PATH and AUTOMOBILE_DWEBP_PATH to executable libwebp binaries.",
      };
    }
  }

  if (platform === "darwin" || platform === "linux") {
    if (!dependencies.sharpLoader && platform !== hostPlatform) {
      return {
        name: "Image Backend",
        status: "skip",
        message: `active=sharp; sharp=not checked; platform=${platform}; host=${hostPlatform}`,
      };
    }

    try {
      await (dependencies.sharpLoader ?? loadSharp)();
      return {
        name: "Image Backend",
        status: "pass",
        message: "active=sharp; sharp=loaded",
      };
    } catch (error) {
      const message = errorMessage(error);
      log.warn(`Image backend doctor check failed: ${message}`, error);
      return {
        name: "Image Backend",
        status: "fail",
        message: `active=sharp; sharp=unavailable; webp=unavailable; error=${message}`,
        recommendation:
          "Reinstall dependencies from the lockfile and re-run doctor. " +
          "Navigation screenshots require sharp-backed WebP support on macOS/Linux.",
      };
    }
  }

  return {
    name: "Image Backend",
    status: "pass",
    message: "active=jimp",
  };
}

/**
 * Check daemon status
 */
export async function checkDaemonStatus(
  dependencies: DaemonStatusDependencies = {}
): Promise<CheckResult> {
  try {
    const report = await (dependencies.getDaemonHealthReport ?? getDaemonHealthReport)();
    if (report.socketConnectable) {
      return {
        name: "Daemon Status",
        status: "pass",
        message: "Running (serving via socket)",
        ...(report.daemonPid !== undefined ? { value: report.daemonPid } : {}),
      };
    }

    const manager = dependencies.daemonManager ?? new DaemonManager();
    const status = await manager.status();

    if (status.running) {
      return {
        name: "Daemon Status",
        status: "pass",
        message: `Running (PID ${status.pid})`,
        value: status.pid,
      };
    }

    return {
      name: "Daemon Status",
      status: "warn",
      message: "Daemon is not running",
      recommendation: `Start the daemon with: bunx ${resolveDaemonInstallSpecifier()} --daemon start`,
    };
  } catch (error) {
    logger.warn(`Daemon status check failed: ${errorMessage(error)}`, error);
    return {
      name: "Daemon Status",
      status: "warn",
      message: `Could not check daemon: ${errorMessage(error)}`,
      recommendation: `Try: bunx ${resolveDaemonInstallSpecifier()} --daemon start`,
    };
  }
}

/**
 * Check daemon connectivity
 */
export async function checkDaemonConnectivity(
  getHealthReport: () => Promise<DaemonHealthReport> = getDaemonHealthReport
): Promise<CheckResult> {
  try {
    const report = await getHealthReport();

    if (report.socketConnectable) {
      return {
        name: "Daemon Connectivity",
        status: "pass",
        message: "Daemon is responsive",
      };
    }

    if (!report.daemonRunning) {
      return {
        name: "Daemon Connectivity",
        status: "skip",
        message: "Daemon is not running",
      };
    }

    return {
      name: "Daemon Connectivity",
      status: "warn",
      message: "Daemon running but not responding",
      recommendation: report.recommendations.join("; ") || `Try: bunx ${resolveDaemonInstallSpecifier()} --daemon restart`,
    };
  } catch (error) {
    logger.warn(`Daemon connectivity check failed: ${errorMessage(error)}`, error);
    return {
      name: "Daemon Connectivity",
      status: "warn",
      message: `Connectivity check failed: ${errorMessage(error)}`,
    };
  }
}

/**
 * Surface the running daemon's build identity (`buildId` + `entryScript`) and
 * flag wrong-build skew.
 *
 * Two checkouts on one machine share a single per-uid daemon socket, so the
 * daemon serving this frontend can be from a *different* build (see #2732). The
 * build-identity content hash recorded in the PID file (#2733) lets `doctor`
 * make that visible *before* a tool call fails — rather than after.
 */
export async function checkDaemonBuildIdentity(
  dependencies: DaemonBuildIdentityDependencies = {}
): Promise<CheckResult> {
  try {
    const manager = dependencies.daemonManager ?? new DaemonManager();
    const status = await manager.status();

    if (!status.running) {
      return {
        name: "Daemon Build Identity",
        status: "skip",
        message: "Daemon is not running",
      };
    }

    const daemon = buildIdentityFromStatus(status);
    const client = (dependencies.getClientBuildIdentity ?? getCurrentBuildIdentity)();

    if (buildIdentitiesMatch(client, daemon)) {
      // No `value`: the console formatter renders `value` *instead of* `message`,
      // and we want both the buildId and the entryScript visible — so carry them
      // in the message.
      return {
        name: "Daemon Build Identity",
        status: "pass",
        message: `Build ${describeBuildIdentity(daemon)}`,
      };
    }

    return {
      name: "Daemon Build Identity",
      status: "warn",
      message: `Build skew: daemon ${describeBuildIdentity(daemon)}, client ${describeBuildIdentity(client)}`,
      recommendation:
        "The running daemon is a different build than this checkout. Restart the daemon " +
        "from THIS checkout so it matches — run `--daemon restart` with the same auto-mobile " +
        "CLI you invoked here. Avoid `@latest`, which starts the published build and may not " +
        "match this checkout.",
    };
  } catch (error) {
    // Diagnostic path: log the underlying error before returning a typed failure
    // so there is a trace even though the user only sees the summarized message
    // (CLAUDE.md error-handling convention #2).
    logger.warn(
      `Daemon build identity check failed: ${errorMessage(error)}`,
      error
    );
    return {
      name: "Daemon Build Identity",
      status: "warn",
      message: `Could not check daemon build identity: ${errorMessage(error)}`,
    };
  }
}

/**
 * Check CtrlProxy status on connected devices
 */
export async function checkCtrlProxy(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  dependencies: CtrlProxyDoctorDependencies = {}
): Promise<CheckResult> {
  const log = dependencies.logger ?? logger;
  try {
    const adb = adbFactory.create();
    // Validate hermetic asset configuration before device-dependent shortcuts so
    // a malformed mirror fails the doctor gate even on hosts with no Android device.
    resolveApkUrl();
    resolveIpaUrl();
    const devices = await adb.getBootedAndroidDevices();

    if (devices.length === 0) {
      return {
        name: "CtrlProxy",
        status: "skip",
        message: "No Android devices connected",
      };
    }

    // Check first connected device
    const device = devices[0];

    // An unverifiable explicit pin is a hard configuration failure — surface it as
    // `fail` (not the `skip` the thrown guard would otherwise become in the catch),
    // so the documented `--cli doctor` CI gate actually blocks (#2746).
    if (AndroidCtrlProxyManager.isPinnedVersionUnverifiable()) {
      return {
        name: "CtrlProxy",
        status: "fail",
        message: `platform=${device.platform}; device=${device.deviceId}; AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the release checksum registry`,
        recommendation: "The pinned CtrlProxy APK cannot be integrity-verified. Pin a released version, or set AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1 to override.",
      };
    }

    // Reset cached instances to ensure fresh ADB reads for doctor diagnostics
    // (getInstance memoizes isInstalled/isEnabled for 30 minutes which can report stale state)
    AndroidCtrlProxyManager.resetInstances();
    const serviceManager = AndroidCtrlProxyManager.getInstance(device, adbFactory);

    const versionResult = await serviceManager.ensureCompatibleVersion();
    const isInstalled = await serviceManager.isInstalled();
    const isEnabled = await serviceManager.isEnabled();

    const diagnostics: string[] = [
      `platform=${device.platform}`,
      `device=${device.deviceId}`,
      `installed=${isInstalled}`,
      `enabled=${isEnabled}`
    ];

    if (versionResult.expectedSha256 !== undefined) {
      diagnostics.push(`expectedSha256=${versionResult.expectedSha256 || "n/a"}`);
    }

    if (versionResult.installedSha256 !== undefined) {
      const source = versionResult.installedShaSource || "unknown";
      diagnostics.push(`installedSha256=${versionResult.installedSha256 || "unknown"} (${source})`);
    }

    diagnostics.push(`versionStatus=${versionResult.status}`);

    if (versionResult.error || versionResult.upgradeError || versionResult.reinstallError) {
      diagnostics.push(`versionError=${versionResult.error || versionResult.upgradeError || versionResult.reinstallError}`);
    }

    const attemptedDownloadOrInstall = Boolean(
      versionResult.attemptedDownload || versionResult.attemptedInstall || versionResult.attemptedReinstall
    );
    const downloadUnavailable = Boolean(versionResult.downloadUnavailable);
    if (downloadUnavailable) {
      diagnostics.push("downloadUnavailable=offline");
    }

    if (versionResult.acceptedPreinstalled) {
      diagnostics.push("acceptedPreinstalled=true");
    }

    if (versionResult.status === "failed" && isExplicitPin()) {
      return {
        name: "CtrlProxy",
        status: "fail",
        message: diagnostics.join("; "),
        recommendation: "CtrlProxy APK provisioning failed for an explicit AutoMobile version pin. Fix the pinned asset source, checksum, or mirror configuration and re-run doctor."
      };
    }

    if (downloadUnavailable) {
      return {
        name: "CtrlProxy",
        status: "warn",
        message: diagnostics.join("; "),
        recommendation: "Newer CtrlProxy APK unavailable while offline. Connect to the internet and re-run doctor."
      };
    }

    if (versionResult.acceptedPreinstalled && isInstalled && isEnabled) {
      return {
        name: "CtrlProxy",
        status: "warn",
        message: diagnostics.join("; "),
        recommendation: "CtrlProxy is installed and enabled, but its APK SHA differs from the expected release. Re-run doctor after the background APK refresh completes or update CtrlProxy from the latest release."
      };
    }

    if (isInstalled && isEnabled && (versionResult.status === "compatible" || versionResult.status === "upgraded" || versionResult.status === "installed" || versionResult.status === "reinstalled" || versionResult.status === "skipped")) {
      return {
        name: "CtrlProxy",
        status: "pass",
        message: diagnostics.join("; "),
        recommendation: attemptedDownloadOrInstall
          ? `If you need the latest APK, download from ${RELEASES_URL}`
          : undefined,
      };
    }

    if (isInstalled && !isEnabled) {
      return {
        name: "CtrlProxy",
        status: "warn",
        message: diagnostics.join("; "),
        recommendation: attemptedDownloadOrInstall
          ? `Enable CtrlProxy in device settings. If you need the latest APK, download from ${RELEASES_URL}`
          : "Enable CtrlProxy in device settings",
      };
    }

    if (!isInstalled) {
      return {
        name: "CtrlProxy",
        status: "warn",
        message: diagnostics.join("; "),
        recommendation: "CtrlProxy will be installed automatically when needed",
      };
    }

    return {
      name: "CtrlProxy",
      status: "warn",
      message: diagnostics.join("; "),
      recommendation: attemptedDownloadOrInstall
        ? `If you need the latest APK, download from ${RELEASES_URL}`
        : "Review CtrlProxy installation status",
    };
  } catch (error) {
    if (error instanceof ActionableError) {
      log.warn(`CtrlProxy check failed: ${error.message}`, error);
      return {
        name: "CtrlProxy",
        status: "fail",
        message: error.message,
      };
    }
    log.warn(`CtrlProxy check failed: ${errorMessage(error)}`, error);
    return {
      name: "CtrlProxy",
      status: "skip",
      message: `Could not check: ${errorMessage(error)}`,
    };
  }
}

/**
 * Check work profile accessibility service status
 * Warns if work profiles exist but accessibility service is not enabled for them
 */
export async function checkWorkProfileAccessibility(
  adbFactory: AdbClientFactory = defaultAdbClientFactory
): Promise<CheckResult> {
  try {
    const adb = adbFactory.create();
    const devices = await adb.getBootedAndroidDevices();

    if (devices.length === 0) {
      return {
        name: "Work Profile Accessibility",
        status: "skip",
        message: "No Android devices connected",
      };
    }

    // Check first connected device
    const device = devices[0];
    const deviceAdb = adbFactory.create(device);
    const users = await deviceAdb.listUsers();

    // Filter to work profiles: userId > 0, running, and flags indicate managed profile (0x30 = 48)
    // Work profiles have FLAG_MANAGED_PROFILE (0x20) in their flags
    const workProfiles = users.filter(
      user => user.userId > 0 && user.running && (user.flags & 0x20) !== 0
    );

    if (workProfiles.length === 0) {
      return {
        name: "Work Profile Accessibility",
        status: "pass",
        message: "No work profiles detected",
      };
    }

    // Check accessibility service status for each work profile
    const profilesWithoutService: { userId: number; name: string }[] = [];

    for (const profile of workProfiles) {
      // Why: kept on ADB because Settings APIs from the accessibility service run as
      // the service user only; the multi-user --user flag is required to query
      // settings in each work profile, which the WebSocket settings_get API can't do.
      const result = await deviceAdb.executeCommand(
        `shell settings --user ${profile.userId} get secure enabled_accessibility_services`,
        undefined,
        undefined,
        true
      );
      const isEnabled = result.stdout.includes(AndroidCtrlProxyManager.PACKAGE);
      if (!isEnabled) {
        profilesWithoutService.push({ userId: profile.userId, name: profile.name });
      }
    }

    if (profilesWithoutService.length === 0) {
      return {
        name: "Work Profile Accessibility",
        status: "pass",
        message: `Accessibility service enabled for ${workProfiles.length} work profile(s)`,
      };
    }

    const profileList = profilesWithoutService
      .map(p => `${p.name} (user ${p.userId})`)
      .join(", ");

    return {
      name: "Work Profile Accessibility",
      status: "warn",
      message: `Accessibility service not enabled for work profile(s): ${profileList}`,
      recommendation: `The accessibility service needs to be enabled in each work profile for full app install tracking. Run bunx ${resolveDaemonInstallSpecifier()} --cli doctor or enable manually in Settings > Accessibility.`,
    };
  } catch (error) {
    logger.warn(`Work profile accessibility check failed: ${errorMessage(error)}`, error);
    return {
      name: "Work Profile Accessibility",
      status: "skip",
      message: `Could not check: ${errorMessage(error)}`,
    };
  }
}

/**
 * Run all AutoMobile checks
 */
export async function runAutoMobileChecks(
  options: DoctorOptions = {},
  dependencies: AutoMobileCheckDependencies = {}
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(checkDaemonVersion());
  results.push(checkCtrlProxyVersion());
  results.push(await (dependencies.checkImageBackend ?? (() => checkImageBackend()))());
  results.push(await (dependencies.checkDaemonStatus ?? (() => checkDaemonStatus()))());
  results.push(await (dependencies.checkDaemonConnectivity ?? (() => checkDaemonConnectivity()))());
  results.push(await (dependencies.checkDaemonBuildIdentity ?? (() => checkDaemonBuildIdentity()))());

  if (options.ios === true && options.android !== true) {
    results.push({
      name: "CtrlProxy",
      status: "skip",
      message: "Skipped for iOS-only doctor run",
    });
    results.push({
      name: "Work Profile Accessibility",
      status: "skip",
      message: "Skipped for iOS-only doctor run",
    });
  } else {
    results.push(await (dependencies.checkCtrlProxy ?? (() => checkCtrlProxy()))());
    results.push(await (dependencies.checkWorkProfileAccessibility ?? (() => checkWorkProfileAccessibility()))());
  }

  return results;
}
