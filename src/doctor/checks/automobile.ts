/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { errorMessage } from "../../utils/describeUnknownError";
import type { BootedDevice } from "../../models";
import { CheckResult } from "../types";
import type { DoctorOptions, DoctorProbeOptions } from "../types";
import { awaitDoctorProbe, DoctorDeadlineError, remainingDoctorProbe } from "../deadline";
import { runWithAbortSignal } from "../../utils/AbortContext";
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
import { AndroidCtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { loadSharp, type SharpFactory } from "../../utils/image/loadSharp";
import {
  WebpBinaryResolver,
  type ResolvedWebpBinaries,
} from "../../utils/image/webp/WebpBinaryResolver";
import { logger } from "../../utils/logger";
import type { Logger } from "../../utils/logger";
import { ActionableError } from "../../models/ActionableError";

export const MAX_CTRL_PROXY_DOCTOR_DEVICES = 8;

interface DaemonStatusManager {
  status(recoverIdentity?: boolean): Promise<DaemonStatus>;
}

export interface DaemonStatusDependencies {
  daemonManager?: DaemonStatusManager;
  getDaemonHealthReport?: (probe?: DoctorProbeOptions) => Promise<DaemonHealthReport>;
}

export interface DaemonBuildIdentityDependencies {
  daemonManager?: DaemonStatusManager;
  getClientBuildIdentity?: () => BuildIdentity;
}

export interface CtrlProxyDoctorDependencies {
  logger?: Logger;
}

export interface AutoMobileCheckDependencies {
  checkImageBackend?: (probe?: DoctorProbeOptions) => Promise<CheckResult>;
  checkDaemonStatus?: (probe?: DoctorProbeOptions) => Promise<CheckResult>;
  checkDaemonConnectivity?: (probe?: DoctorProbeOptions) => Promise<CheckResult>;
  checkDaemonBuildIdentity?: (probe?: DoctorProbeOptions) => Promise<CheckResult>;
  /** Android-branch seams so unit tests avoid real CtrlProxy/ADB I/O. */
  checkCtrlProxy?: (probe?: DoctorProbeOptions) => Promise<CheckResult>;
  checkWorkProfileAccessibility?: (probe?: DoctorProbeOptions) => Promise<CheckResult>;
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

function usesSharpImageBackend(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function shouldSkipSharpProbe(
  dependencies: ImageBackendDoctorDependencies,
  platform: NodeJS.Platform,
  hostPlatform: NodeJS.Platform,
): boolean {
  return !dependencies.sharpLoader && platform !== hostPlatform;
}

/**
 * Report the active image backend and the platform-specific provisioning that
 * makes it usable without doing real image work.
 */
export async function checkImageBackend(
  dependencies: ImageBackendDoctorDependencies = {},
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  const platform = dependencies.platform ?? process.platform;
  const hostPlatform = dependencies.hostPlatform ?? getHostPlatform();
  const log = dependencies.logger ?? logger;

  if (platform === "win32") {
    try {
      const binaries = await awaitDoctorProbe(probe, async () =>
        (dependencies.webpBinaryResolver ?? new WebpBinaryResolver()).resolve(),
      );
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

  if (usesSharpImageBackend(platform)) {
    if (shouldSkipSharpProbe(dependencies, platform, hostPlatform)) {
      return {
        name: "Image Backend",
        status: "skip",
        message: `active=sharp; sharp=not checked; platform=${platform}; host=${hostPlatform}`,
      };
    }

    try {
      await awaitDoctorProbe(probe, dependencies.sharpLoader ?? loadSharp);
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
  dependencies: DaemonStatusDependencies = {},
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    const report = await (
      dependencies.getDaemonHealthReport ??
      ((options?: DoctorProbeOptions) =>
        getDaemonHealthReport(options?.timer, {
          signal: options?.signal,
          timeoutMs: options?.timeoutMs,
        }))
    )(currentProbe);
    if (report.socketConnectable) {
      return {
        name: "Daemon Status",
        status: "pass",
        message: "Running (serving via socket)",
        ...(report.daemonPid !== undefined ? { value: report.daemonPid } : {}),
      };
    }

    const manager = dependencies.daemonManager ?? new DaemonManager();
    const status = await awaitDoctorProbe(currentProbe, async () => await manager.status(false));

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
  getHealthReport: (probe?: DoctorProbeOptions) => Promise<DaemonHealthReport> = (probe) =>
    getDaemonHealthReport(probe?.timer, {
      signal: probe?.signal,
      timeoutMs: probe?.timeoutMs,
    }),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  try {
    const report = await getHealthReport(remainingDoctorProbe(probe));

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
      recommendation:
        report.recommendations.join("; ") ||
        `Try: bunx ${resolveDaemonInstallSpecifier()} --daemon restart`,
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
  dependencies: DaemonBuildIdentityDependencies = {},
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  try {
    const manager = dependencies.daemonManager ?? new DaemonManager();
    const status = await awaitDoctorProbe(probe, () => manager.status(false));

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
    logger.warn(`Daemon build identity check failed: ${errorMessage(error)}`, error);
    return {
      name: "Daemon Build Identity",
      status: "warn",
      message: `Could not check daemon build identity: ${errorMessage(error)}`,
    };
  }
}

/** Combine the bounded device entries without hiding failures or omitted devices. */
function aggregateAndroidDoctorResults(
  name: string,
  results: CheckResult[],
  deviceCount: number,
): CheckResult {
  const unchecked = deviceCount - results.length;
  const messages = results.map((result) => result.message);
  if (unchecked) {
    messages.push(
      `${unchecked} Android devices not checked (limit=${MAX_CTRL_PROXY_DOCTOR_DEVICES})`,
    );
  }
  const recommendations = [
    ...new Set(results.flatMap((result) => (result.recommendation ? [result.recommendation] : []))),
  ];
  return {
    name,
    status: results.some((result) => result.status === "fail")
      ? "fail"
      : unchecked || results.some((result) => result.status === "warn")
        ? "warn"
        : "pass",
    message: messages.join(" | "),
    recommendation: recommendations.length ? recommendations.join(" | ") : undefined,
  };
}

async function checkDeviceCtrlProxy(
  device: BootedDevice,
  adbFactory: AdbClientFactory,
  deviceProbe: DoctorProbeOptions,
): Promise<CheckResult> {
  const manager = AndroidCtrlProxyManager.createDetached(device, adbFactory);
  const installed = await manager.isInstalled();
  deviceProbe.signal?.throwIfAborted();
  const enabled = await manager.isEnabled();
  deviceProbe.signal?.throwIfAborted();
  const version = await manager.inspectCompatibility(deviceProbe.signal);
  deviceProbe.signal?.throwIfAborted();
  return describeDeviceCtrlProxy(device, installed, enabled, version);
}

type CtrlProxyCompatibility = Awaited<ReturnType<AndroidCtrlProxyManager["inspectCompatibility"]>>;

function ctrlProxyDoctorStatus(
  installed: boolean,
  enabled: boolean,
  version: CtrlProxyCompatibility,
) {
  return version.knownPinMismatch
    ? "fail"
    : installed && enabled && (version.status === "compatible" || version.status === "skipped")
      ? "pass"
      : "warn";
}

function describeDeviceCtrlProxy(
  device: BootedDevice,
  installed: boolean,
  enabled: boolean,
  version: CtrlProxyCompatibility,
): CheckResult {
  const diagnostics = [
    `platform=${device.platform}`,
    `device=${device.deviceId}`,
    `installed=${installed}`,
    `enabled=${enabled}`,
    `expectedSha256=${version.expectedSha256 || "n/a"}`,
    `installedSha256=${version.installedSha256 || "unknown"} (${version.installedShaSource})`,
    `versionStatus=${version.status}`,
  ];
  if (version.status === "mismatch") {
    diagnostics.push("Installed CtrlProxy APK SHA differs from expected release checksum");
    if (version.knownPinMismatch) {
      diagnostics.push(`AUTOMOBILE_VERSION=${resolvePinnedVersion()}`);
    }
  } else if (version.status === "unverifiable" && version.knownPinMismatch) {
    diagnostics.push(
      "Installed CtrlProxy APK SHA could not be read; cannot verify the pinned release",
    );
    diagnostics.push(`AUTOMOBILE_VERSION=${resolvePinnedVersion()}`);
  }
  const status = ctrlProxyDoctorStatus(installed, enabled, version);
  return {
    name: "CtrlProxy",
    status,
    message: diagnostics.join("; "),
    recommendation:
      status === "pass"
        ? undefined
        : `${installed && !enabled ? "Enable CtrlProxy in device settings. " : ""}` +
          `doctor does not install, update or enable CtrlProxy and does not reset running session state; run an AutoMobile device tool (for example observe) against ${device.deviceId} so readiness installs/updates it, or use the IDE plugin's update-service action.`,
  };
}

function androidDoctorDeviceFailure(
  name: string,
  device: BootedDevice,
  probe: DoctorProbeOptions,
  log: Logger,
  error: unknown,
): CheckResult {
  if (probe.signal?.aborted || error instanceof DoctorDeadlineError) {
    throw error;
  }
  const description = name === "CtrlProxy" ? "CtrlProxy" : "Work profile accessibility";
  log.warn(`${description} check failed for ${device.deviceId}: ${errorMessage(error)}`, error);
  return {
    name,
    status: error instanceof ActionableError ? "fail" : "warn",
    message: `Could not check device=${device.deviceId}: ${errorMessage(error)}`,
    recommendation:
      "Re-run doctor and verify adb access to that device; doctor only reports status.",
  };
}

/**
 * Check CtrlProxy status on connected devices
 */
export async function checkCtrlProxy(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  dependencies: CtrlProxyDoctorDependencies = {},
  probe: DoctorProbeOptions = {},
  targetDeviceId?: string,
): Promise<CheckResult> {
  const log = dependencies.logger ?? logger;
  try {
    const currentProbe = remainingDoctorProbe(probe);
    return await runWithAbortSignal(currentProbe.signal, async () => {
      currentProbe.signal?.throwIfAborted();
      resolveApkUrl();
      resolveIpaUrl();
      const devices = await adbFactory.create().getBootedAndroidDevices({
        signal: currentProbe.signal,
        timeoutMs: currentProbe.timeoutMs,
      });
      currentProbe.signal?.throwIfAborted();
      const selected =
        targetDeviceId === undefined
          ? devices
          : devices.filter((device) => device.deviceId === targetDeviceId);
      if (selected.length === 0) {
        return {
          name: "CtrlProxy",
          status: targetDeviceId === undefined ? "skip" : "fail",
          message:
            targetDeviceId === undefined
              ? "No Android devices connected"
              : `Requested device is not booted: ${targetDeviceId}`,
        };
      }
      // Keep #2746's deterministic first/targeted-device diagnostic and recommendation.
      const device = selected[0];
      if (AndroidCtrlProxyManager.isPinnedVersionUnverifiable()) {
        return {
          name: "CtrlProxy",
          status: "fail",
          message: `platform=${device.platform}; device=${device.deviceId}; AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the release checksum registry`,
          recommendation:
            "The pinned CtrlProxy APK cannot be integrity-verified. Pin a released version, or set AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1 to override.",
        };
      }
      const results: CheckResult[] = [];
      for (const device of selected.slice(0, MAX_CTRL_PROXY_DOCTOR_DEVICES)) {
        currentProbe.signal?.throwIfAborted();
        const deviceProbe = remainingDoctorProbe(currentProbe);
        try {
          results.push(await checkDeviceCtrlProxy(device, adbFactory, deviceProbe));
        } catch (error) {
          results.push(androidDoctorDeviceFailure("CtrlProxy", device, currentProbe, log, error));
        }
        remainingDoctorProbe(currentProbe);
      }
      return aggregateAndroidDoctorResults("CtrlProxy", results, selected.length);
    });
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

async function checkDeviceWorkProfileAccessibility(
  device: BootedDevice,
  adbFactory: AdbClientFactory,
  currentProbe: DoctorProbeOptions,
): Promise<CheckResult> {
  const deviceAdb = adbFactory.create(device);
  currentProbe.signal?.throwIfAborted();
  const users = await deviceAdb.listUsers(currentProbe.signal);
  remainingDoctorProbe(currentProbe);

  if (users.length === 0) {
    return {
      name: "Work Profile Accessibility",
      status: "warn",
      message: `device=${device.deviceId}; Could not list Android users`,
      recommendation:
        "Re-run doctor and verify adb access to that device; doctor only reports status.",
    };
  }

  // Filter to work profiles: userId > 0, running, and flags indicate managed profile (0x30 = 48)
  // Work profiles have FLAG_MANAGED_PROFILE (0x20) in their flags
  const workProfiles = users.filter(
    (user) => user.userId > 0 && user.running && (user.flags & 0x20) !== 0,
  );

  if (workProfiles.length === 0) {
    return {
      name: "Work Profile Accessibility",
      status: "pass",
      message: `device=${device.deviceId}; No work profiles detected`,
    };
  }

  // Check accessibility service status for each work profile
  const profilesWithoutService: { userId: number; name: string }[] = [];

  for (const profile of workProfiles) {
    // Why: kept on ADB because Settings APIs from the accessibility service run as
    // the service user only; the multi-user --user flag is required to query
    // settings in each work profile, which the WebSocket settings_get API can't do.
    const profileProbe = remainingDoctorProbe(currentProbe);
    const result = await deviceAdb.executeCommand(
      `shell settings --user ${profile.userId} get secure enabled_accessibility_services`,
      profileProbe.timeoutMs,
      undefined,
      true,
      profileProbe.signal,
    );
    remainingDoctorProbe(currentProbe);
    const isEnabled = result.stdout.includes(AndroidCtrlProxyManager.PACKAGE);
    if (!isEnabled) {
      profilesWithoutService.push({ userId: profile.userId, name: profile.name });
    }
  }

  if (profilesWithoutService.length === 0) {
    return {
      name: "Work Profile Accessibility",
      status: "pass",
      message: `device=${device.deviceId}; Accessibility service enabled for ${workProfiles.length} work profile(s)`,
    };
  }

  const profileList = profilesWithoutService.map((p) => `${p.name} (user ${p.userId})`).join(", ");

  return {
    name: "Work Profile Accessibility",
    status: "warn",
    message: `device=${device.deviceId}; Accessibility service not enabled for work profile(s): ${profileList}`,
    recommendation: `The accessibility service needs to be enabled in each work profile for full app install tracking. Enable manually in Settings > Accessibility; doctor only reports status.`,
  };
}

/**
 * Check work profile accessibility service status
 * Warns if work profiles exist but accessibility service is not enabled for them
 */
export async function checkWorkProfileAccessibility(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    const adb = adbFactory.create();
    const devices = await adb.getBootedAndroidDevices({
      signal: currentProbe.signal,
      timeoutMs: currentProbe.timeoutMs,
    });

    if (devices.length === 0) {
      return {
        name: "Work Profile Accessibility",
        status: "skip",
        message: "No Android devices connected",
      };
    }

    currentProbe.signal?.throwIfAborted();
    const results: CheckResult[] = [];
    for (const device of devices.slice(0, MAX_CTRL_PROXY_DOCTOR_DEVICES)) {
      currentProbe.signal?.throwIfAborted();
      const deviceProbe = remainingDoctorProbe(currentProbe);
      try {
        results.push(await checkDeviceWorkProfileAccessibility(device, adbFactory, deviceProbe));
      } catch (error) {
        results.push(
          androidDoctorDeviceFailure(
            "Work Profile Accessibility",
            device,
            currentProbe,
            logger,
            error,
          ),
        );
      }
      remainingDoctorProbe(currentProbe);
    }
    return aggregateAndroidDoctorResults("Work Profile Accessibility", results, devices.length);
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
  dependencies: AutoMobileCheckDependencies = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const run = async (check: () => Promise<CheckResult>): Promise<void> => {
    remainingDoctorProbe(options);
    results.push(await check());
    remainingDoctorProbe(options);
  };

  results.push(checkDaemonVersion());
  results.push(checkCtrlProxyVersion());
  await run(() =>
    (dependencies.checkImageBackend ?? ((probe) => checkImageBackend({}, probe)))(options),
  );
  await run(() =>
    (dependencies.checkDaemonStatus ?? ((probe) => checkDaemonStatus({}, probe)))(options),
  );
  await run(() =>
    (
      dependencies.checkDaemonConnectivity ?? ((probe) => checkDaemonConnectivity(undefined, probe))
    )(options),
  );
  await run(() =>
    (dependencies.checkDaemonBuildIdentity ?? ((probe) => checkDaemonBuildIdentity({}, probe)))(
      options,
    ),
  );

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
    await run(() =>
      (
        dependencies.checkCtrlProxy ??
        ((probe) => checkCtrlProxy(defaultAdbClientFactory, {}, probe))
      )(options),
    );
    await run(() =>
      (
        dependencies.checkWorkProfileAccessibility ??
        ((probe) => checkWorkProfileAccessibility(defaultAdbClientFactory, probe))
      )(options),
    );
  }

  return results;
}

/** Run only host-wide daemon-health checks after repair. */
export async function runPostRepairAutoMobileChecks(
  options: DoctorOptions = {},
  dependencies: AutoMobileCheckDependencies = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const run = async (check: () => Promise<CheckResult>): Promise<void> => {
    remainingDoctorProbe(options);
    results.push(await check());
    remainingDoctorProbe(options);
  };

  results.push(checkDaemonVersion());
  await run(() =>
    (dependencies.checkDaemonStatus ?? ((probe) => checkDaemonStatus({}, probe)))(options),
  );
  await run(() =>
    (
      dependencies.checkDaemonConnectivity ?? ((probe) => checkDaemonConnectivity(undefined, probe))
    )(options),
  );
  await run(() =>
    (dependencies.checkDaemonBuildIdentity ?? ((probe) => checkDaemonBuildIdentity({}, probe)))(
      options,
    ),
  );
  return results;
}
