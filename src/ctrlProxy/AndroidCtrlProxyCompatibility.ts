import { classifySetupError } from "./classifySetupError";
import type { CtrlProxySetupResult } from "./CtrlProxyManager";
import { type SavedPrototypeService } from "./ctrlProxyManagerHost";
import type { SavedPrototypeRestoreReport } from "../models/SavedPrototypeRestoreReport";
import { combineWithAmbientAbort, runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import * as fs from "fs/promises";
import * as path from "path";
import { ActionableError, BootedDevice, ExecResult } from "../models";
import os from "os";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../utils/PerformanceTracker";
import { Timer } from "../utils/SystemTimer";
import { CTRL_PROXY_PACKAGE } from "./constants";
import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import { CtrlProxyForwardOwnershipUnreadableError } from "../models/CtrlProxyForwardOwnershipUnreadableError";
import { CtrlProxyApkStageError } from "./CtrlProxyApkStageError";
import { CtrlProxyApkInstallError } from "./CtrlProxyApkInstallError";
import type {
  AccessibilityVersionCheckResult,
  AccessibilityVersionCheckOptions,
  InstalledApkSha256Result,
} from "./AndroidCtrlProxyManagerTypes";
import { REBIND_BIND_WAIT_BUDGET_MS } from "./AndroidCtrlProxyRebind";
import type { CtrlProxyCompatibilityInspection } from "./CtrlProxyManager";

import {
  extractInstallFailureCode,
  SIGNATURE_MISMATCH_FAILURE_CODES,
} from "./androidInstallFailure";

/** Live manager dependencies; callbacks preserve manager overrides and test spies. */
export interface AndroidCtrlProxyCompatibilityHost {
  getInstalledApkSha256WithDetails(signal?: AbortSignal): Promise<InstalledApkSha256Result>;
  getExpectedChecksum(useSharedCache?: boolean): Promise<string>;
  getInstalledApkSha256(): Promise<string | null>;
  assertPinnedVersionVerifiable(): void;
  isInstalled(): Promise<boolean>;
  shouldSkipDownloadIfInstalled(): boolean;
  isKnownExplicitPinConfigured(): boolean;
  isKnownPinUnverified(status: CtrlProxyCompatibilityInspection["status"]): boolean;
  clearServiceAvailabilityCache(): void;
  uninstallLegacyPackageIfPresent(guardOwnership?: boolean): Promise<void>;
  downloadApk(): Promise<string>;
  installDownloadedApk(
    apkPath: string,
    result: AccessibilityVersionCheckResult,
    isInstalled: boolean,
    needsReinstallDueToUnknownSha: boolean,
    perf: PerformanceTracker,
  ): Promise<AccessibilityVersionCheckResult>;
  statusInspectionDeviceError(error: unknown): Error | undefined;
  cleanupApk(apkPath: string): Promise<void>;
  createKnownPinMismatchError(
    expectedSha: string,
    installedSha: string | null | undefined,
  ): ActionableError;
  queueBackgroundApkRefresh(): void;
  getApkPathOverride(): string | null;
  completedPrefetchPath(): string | null;
  consumeCompletedPrefetchedApk(destinationPath: string): Promise<boolean>;
  clearAvailabilityCache(): void;
  executeApkStage(command: string, stage: string): Promise<ExecResult>;
  grantLocalNetworkAfterInstall(): Promise<void>;
  install(apkPath: string): Promise<void>;
  enable(): Promise<void>;
  readonly savedPrototypes: SavedPrototypeService;
  readonly device: BootedDevice;
  waitForAccessibilityServiceBinding(): Promise<"already-bound" | "recovered" | "unhealthy">;
  readonly timer: Timer;
}

/** Version compatibility decisions, upgrade/reinstall and saved prototype restoration. */
export class AndroidCtrlProxyCompatibility {
  private cachedVersionCheck: {
    result: AccessibilityVersionCheckResult;
    timestamp: number;
  } | null = null;

  private static readonly VERSION_CHECK_CACHE_TTL = 60 * 1000; // 1 minute
  constructor(private readonly host: AndroidCtrlProxyCompatibilityHost) {}
  clearCache(): void {
    this.cachedVersionCheck = null;
  }

  /**
   * Get SHA256 of installed accessibility service APK.
   */
  async getInstalledApkSha256(): Promise<string | null> {
    const result = await this.host.getInstalledApkSha256WithDetails();
    return result.sha256;
  }

  /**
   * Check if installed APK SHA256 matches expected release checksum.
   */
  async isVersionCompatible(): Promise<boolean> {
    const expectedSha = await this.host.getExpectedChecksum();
    if (expectedSha.length === 0) {
      logger.warn("[CTRL_PROXY] Version check skipped (no checksum provided)");
      return true;
    }

    const installedSha = await this.host.getInstalledApkSha256();
    if (!installedSha) {
      return false;
    }

    return installedSha.toLowerCase() === expectedSha.toLowerCase();
  }

  /** Inspect integrity without provisioning, invalidating caches, or consuming prefetches. */
  async inspectCompatibility(signal?: AbortSignal): Promise<CtrlProxyCompatibilityInspection> {
    const readSignal = combineWithAmbientAbort(signal);
    return runWithAbortSignal(readSignal, async () => {
      readSignal?.throwIfAborted();
      this.host.assertPinnedVersionVerifiable();
      const expectedSha256 = await this.host.getExpectedChecksum(false);
      readSignal?.throwIfAborted();
      const installed = await this.host.isInstalled();
      readSignal?.throwIfAborted();
      const reading: CtrlProxyCompatibilityInspection = {
        status: "not_installed",
        expectedSha256,
        installedSha256: null,
        installedShaSource: "none",
        knownPinMismatch: false,
      };
      if (!installed) {
        return reading;
      }
      if (
        !expectedSha256 ||
        (this.host.shouldSkipDownloadIfInstalled() && !this.host.isKnownExplicitPinConfigured())
      ) {
        return { ...reading, status: "skipped" };
      }
      const sha = await this.host.getInstalledApkSha256WithDetails(readSignal);
      readSignal?.throwIfAborted();
      const status = !sha.sha256
        ? "unverifiable"
        : sha.sha256.toLowerCase() === expectedSha256.toLowerCase()
          ? "compatible"
          : "mismatch";
      return {
        ...reading,
        status,
        installedSha256: sha.sha256,
        installedShaSource: sha.source,
        knownPinMismatch: this.host.isKnownPinUnverified(status),
      };
    });
  }

  /**
   * Ensure installed accessibility service version matches expected checksum.
   */
  async ensureCompatibleVersion(
    options: AccessibilityVersionCheckOptions = {},
  ): Promise<AccessibilityVersionCheckResult> {
    const perf = createGlobalPerformanceTracker();

    // Fail closed before any readiness shortcut (skipped/acceptedPreinstalled) can
    // accept an unverifiable APK for an unknown explicit pin (#2746).
    this.host.assertPinnedVersionVerifiable();

    const cachedResult = this.getCachedCompatibilityResult(options);
    if (cachedResult) {
      return cachedResult;
    }

    this.host.clearServiceAvailabilityCache();
    perf.startOperation("uninstallLegacy");
    // Legacy uninstall and a later APK write are separate boundaries: checksum
    // reads or a download may run between them, so the later write rechecks.
    await this.host.uninstallLegacyPackageIfPresent(true);
    perf.endOperation("uninstallLegacy");

    const expectedSha = await this.host.getExpectedChecksum();
    if (expectedSha.length === 0) {
      if (options.allowDownloadWhenInstalled) {
        logger.warn(
          "[CTRL_PROXY] Version checksum unavailable; explicit update will install APK without checksum comparison",
        );
      } else {
        return this.cacheVersionCheckResult({
          status: "skipped",
          expectedSha256: expectedSha,
        });
      }
    }

    perf.startOperation("checkInstalled");
    const isInstalled = await this.host.isInstalled();
    perf.endOperation("checkInstalled");

    if (
      isInstalled &&
      this.host.shouldSkipDownloadIfInstalled() &&
      !this.host.isKnownExplicitPinConfigured() &&
      !options.allowDownloadWhenInstalled
    ) {
      logger.warn("[CTRL_PROXY] Skipping APK download/version check (preinstalled APK allowed)");
      return this.cacheVersionCheckResult({
        status: "skipped",
        expectedSha256: expectedSha,
      });
    }

    const result: AccessibilityVersionCheckResult = {
      status: "compatible",
      expectedSha256: expectedSha,
    };

    let needsReinstallDueToUnknownSha = false;

    if (isInstalled) {
      const installedCheck = await this.checkInstalledCompatibility(
        result,
        expectedSha,
        options,
        perf,
      );
      needsReinstallDueToUnknownSha = installedCheck.needsReinstallDueToUnknownSha;
      if (installedCheck.completed) {
        return installedCheck.completed;
      }
    } else {
      logger.info("[CTRL_PROXY] Service not installed, downloading and installing");
    }

    return this.downloadCompatibleApk(
      result,
      isInstalled,
      needsReinstallDueToUnknownSha,
      perf,
      options,
    );
  }

  private getCachedCompatibilityResult(
    options: AccessibilityVersionCheckOptions,
  ): AccessibilityVersionCheckResult | null {
    if (!options.bypassVersionCheckCache && !options.allowDownloadWhenInstalled) {
      const cachedResult = this.getCachedVersionCheckResult();
      if (cachedResult) {
        return cachedResult;
      }
    }

    return null;
  }

  private async downloadCompatibleApk(
    result: AccessibilityVersionCheckResult,
    isInstalled: boolean,
    needsReinstallDueToUnknownSha: boolean,
    perf: PerformanceTracker,
    options: AccessibilityVersionCheckOptions,
  ): Promise<AccessibilityVersionCheckResult> {
    let apkPath: string | null = null;
    try {
      result.attemptedDownload = true;
      perf.startOperation("downloadApk");
      apkPath = await this.host.downloadApk();
      perf.endOperation("downloadApk");

      return await this.host.installDownloadedApk(
        apkPath,
        result,
        isInstalled,
        needsReinstallDueToUnknownSha,
        perf,
      );
    } catch (error) {
      if (
        error instanceof DeviceOwnedByOtherDaemonError ||
        error instanceof CtrlProxyForwardOwnershipUnreadableError
      ) {
        throw error;
      }
      if (error instanceof CtrlProxyApkStageError) {
        throw error;
      }
      const deviceError = this.host.statusInspectionDeviceError(error);
      if (deviceError) {
        throw deviceError;
      }
      const message = errorMessage(error);
      const downloadUnavailable = this.isNetworkError(message);
      const failedResult: AccessibilityVersionCheckResult = {
        ...result,
        status: "failed",
        downloadUnavailable,
        error: downloadUnavailable
          ? "Unable to download the latest accessibility service APK while offline. Connect to the internet and retry."
          : message,
        cause: error,
      };
      return options.allowDownloadWhenInstalled
        ? failedResult
        : this.cacheVersionCheckResult(failedResult);
    } finally {
      if (apkPath) {
        await this.host.cleanupApk(apkPath);
      }
    }
  }

  private warnMissingInstalledChecksum(
    expectedSha: string,
    installedSha: string | null,
    error: string | undefined,
  ): void {
    if (expectedSha.length > 0 && !installedSha && error) {
      logger.warn("[CTRL_PROXY] Unable to determine installed APK checksum, forcing reinstall", {
        error: error,
      });
    }
  }

  private async acceptPreinstalledOrPrefetched(
    result: AccessibilityVersionCheckResult,
    perf: PerformanceTracker,
    expectedSha: string,
    installedSha: string | null,
  ): Promise<AccessibilityVersionCheckResult> {
    const prefetchedUpgradeResult = await this.tryUpgradeFromCompletedPrefetch(result, perf);
    if (prefetchedUpgradeResult) {
      return this.cacheVersionCheckResult(prefetchedUpgradeResult);
    }

    if (this.host.isKnownExplicitPinConfigured()) {
      throw this.host.createKnownPinMismatchError(expectedSha, installedSha);
    }

    logger.warn(
      "[CTRL_PROXY] Installed APK SHA differs from expected release; accepting preinstalled CtrlProxy for nonblocking readiness",
      {
        expected: expectedSha,
        actual: installedSha,
      },
    );
    this.host.queueBackgroundApkRefresh();
    return this.cacheVersionCheckResult({
      ...result,
      status: "skipped",
      attemptedDownload: false,
      acceptedPreinstalled: true,
    });
  }

  private async checkInstalledCompatibility(
    result: AccessibilityVersionCheckResult,
    expectedSha: string,
    options: AccessibilityVersionCheckOptions,
    perf: PerformanceTracker,
  ): Promise<{
    completed?: AccessibilityVersionCheckResult;
    needsReinstallDueToUnknownSha: boolean;
  }> {
    perf.startOperation("getChecksum");
    const installedShaResult = await this.host.getInstalledApkSha256WithDetails();
    perf.endOperation("getChecksum");
    result.installedSha256 = installedShaResult.sha256;
    result.installedShaSource = installedShaResult.source;
    result.installedApkPath = installedShaResult.apkPath;

    const installedSha = installedShaResult.sha256;
    const needsReinstallDueToUnknownSha = expectedSha.length > 0 && !installedSha;

    this.warnMissingInstalledChecksum(expectedSha, installedSha, installedShaResult.error);

    if (
      expectedSha.length > 0 &&
      installedSha &&
      installedSha.toLowerCase() === expectedSha.toLowerCase()
    ) {
      return { completed: this.cacheVersionCheckResult(result), needsReinstallDueToUnknownSha };
    }

    if (
      expectedSha.length > 0 &&
      !options.allowDownloadWhenInstalled &&
      !this.host.getApkPathOverride()
    ) {
      return {
        completed: await this.acceptPreinstalledOrPrefetched(
          result,
          perf,
          expectedSha,
          installedSha,
        ),
        needsReinstallDueToUnknownSha,
      };
    }

    if (needsReinstallDueToUnknownSha) {
      logger.warn("[CTRL_PROXY] Installed APK checksum unavailable, forcing reinstall");
    } else {
      logger.info("[CTRL_PROXY] Installed APK SHA mismatch, attempting upgrade", {
        expected: expectedSha,
        actual: installedSha,
      });
    }

    return { needsReinstallDueToUnknownSha };
  }

  private async tryUpgradeFromCompletedPrefetch(
    result: AccessibilityVersionCheckResult,
    perf: PerformanceTracker,
  ): Promise<AccessibilityVersionCheckResult | null> {
    if (!this.host.completedPrefetchPath()) {
      return null;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-prefetch-upgrade-"));
    const apkPath = path.join(tempDir, "control-proxy.apk");

    try {
      const usedPrefetch = await this.host.consumeCompletedPrefetchedApk(apkPath);
      if (!usedPrefetch) {
        return null;
      }

      const upgradeResult = await this.host.installDownloadedApk(
        apkPath,
        {
          ...result,
          attemptedDownload: false,
        },
        true,
        false,
        perf,
      );

      if (upgradeResult.status !== "failed") {
        return upgradeResult;
      }

      this.host.clearServiceAvailabilityCache();
      const stillInstalled = await this.host.isInstalled();
      if (!stillInstalled) {
        logger.warn(
          "[CTRL_PROXY] Completed prefetched APK install failed and existing CtrlProxy is no longer installed",
          {
            error:
              upgradeResult.error || upgradeResult.upgradeError || upgradeResult.reinstallError,
          },
        );
        return upgradeResult;
      }

      logger.warn(
        "[CTRL_PROXY] Completed prefetched APK install failed; verified existing CtrlProxy remains installed for readiness",
        {
          error: upgradeResult.error || upgradeResult.upgradeError || upgradeResult.reinstallError,
        },
      );
      if (this.host.isKnownExplicitPinConfigured()) {
        throw this.host.createKnownPinMismatchError(
          result.expectedSha256 ?? "",
          result.installedSha256,
        );
      }
      return {
        ...upgradeResult,
        status: "skipped",
        acceptedPreinstalled: true,
      };
    } finally {
      await this.host.cleanupApk(apkPath);
    }
  }

  /**
   * Uninstalling cannot fix a non-signature failure (USER_RESTRICTED, Play Protect,
   * INSUFFICIENT_STORAGE, transport drop) and would strand the device without CtrlProxy.
   */
  private keepInstalledAfterUpgradeFailure(
    result: AccessibilityVersionCheckResult,
    failureCode: string | undefined,
    upgradeError: unknown,
  ): AccessibilityVersionCheckResult {
    const upgradeMessage = errorMessage(upgradeError);
    logger.warn(
      `[CTRL_PROXY] Upgrade failed (${failureCode ?? "unknown failure"}); keeping installed CtrlProxy`,
      { error: upgradeMessage },
    );
    this.host.clearAvailabilityCache();
    const typed = new CtrlProxyApkInstallError(
      `CtrlProxy APK upgrade failed with ${failureCode ?? "an unrecognized adb failure"}; ` +
        `the installed CtrlProxy was left in place (no uninstall attempted): ${upgradeMessage}`,
      failureCode,
      { cause: upgradeError },
    );
    return { ...result, status: "failed", error: typed.message, cause: typed };
  }

  /**
   * Tries `install -r -d`. Returns the outcome, or undefined when a signature mismatch means the
   * caller should fall back to uninstall + reinstall.
   */
  private async tryInPlaceUpgrade(
    apkPath: string,
    result: AccessibilityVersionCheckResult,
    perf: PerformanceTracker,
  ): Promise<AccessibilityVersionCheckResult | undefined> {
    try {
      result.attemptedInstall = true;
      perf.startOperation("installApk");
      await this.host.executeApkStage(`install -r -d "${apkPath}"`, "CtrlProxy APK upgrade");
      perf.endOperation("installApk");
      logger.info("[CTRL_PROXY] APK upgraded successfully");
      this.host.clearAvailabilityCache();
      await this.host.grantLocalNetworkAfterInstall();
      return {
        ...result,
        status: "upgraded",
      };
    } catch (upgradeError) {
      perf.endOperation("installApk");
      if (upgradeError instanceof CtrlProxyApkStageError) {
        this.host.clearAvailabilityCache();
        throw upgradeError;
      }
      const deviceError = this.host.statusInspectionDeviceError(upgradeError);
      if (deviceError) {
        throw deviceError;
      }
      const upgradeMessage = errorMessage(upgradeError);
      const failureCode = extractInstallFailureCode(upgradeMessage);
      result.upgradeError = upgradeMessage;
      if (!failureCode || !SIGNATURE_MISMATCH_FAILURE_CODES.has(failureCode)) {
        return this.keepInstalledAfterUpgradeFailure(result, failureCode, upgradeError);
      }
      logger.warn(`[CTRL_PROXY] Upgrade failed with ${failureCode}, attempting reinstall`, {
        error: upgradeMessage,
      });
    }
    return undefined;
  }

  /** Appends whether CtrlProxy survived a failed uninstall+reinstall. */
  private async describeReinstallFailure(reinstallMessage: string): Promise<string> {
    let stillInstalled = false;
    try {
      stillInstalled = await this.host.isInstalled();
    } catch (verifyError) {
      logger.warn(
        `[CTRL_PROXY] Could not verify CtrlProxy after failed reinstall: ${errorMessage(verifyError)}`,
        verifyError,
      );
    }
    return `${reinstallMessage} (CtrlProxy is ${stillInstalled ? "still installed" : "no longer installed"} after the failed reinstall)`;
  }

  /** Public so install-ordering tests can drive the guarded install step directly. */
  async installDownloadedApkGuarded(
    apkPath: string,
    result: AccessibilityVersionCheckResult,
    isInstalled: boolean,
    needsReinstallDueToUnknownSha: boolean,
    perf: PerformanceTracker,
  ): Promise<AccessibilityVersionCheckResult> {
    if (isInstalled && !needsReinstallDueToUnknownSha) {
      const upgraded = await this.tryInPlaceUpgrade(apkPath, result, perf);
      if (upgraded) {
        return upgraded;
      }
    }

    try {
      result.attemptedReinstall = true;
      const hasMirroredPrototypes = isInstalled && (await this.warnBeforePrototypeUninstall());
      if (isInstalled) {
        await this.host.executeApkStage(
          `shell pm uninstall ${CTRL_PROXY_PACKAGE}`,
          "CtrlProxy APK uninstall for reinstall",
        );
      }
      perf.startOperation("installApk");
      await this.host.install(apkPath);
      perf.endOperation("installApk");
      await this.host.enable();
      // Restore saved storage only; re-pinning shortcuts would show a confirmation dialog.
      const savedPrototypeRestore = hasMirroredPrototypes
        ? await this.restoreAfterReinstall()
        : undefined;
      logger.info(
        `[CTRL_PROXY] APK ${isInstalled ? "reinstalled" : "installed"} and service enabled`,
      );
      this.host.clearAvailabilityCache();
      return {
        ...result,
        status: isInstalled ? "reinstalled" : "installed",
        savedPrototypeRestore,
      };
    } catch (reinstallError) {
      if (reinstallError instanceof CtrlProxyApkStageError) {
        this.host.clearAvailabilityCache();
        throw reinstallError;
      }
      const reinstallMessage = errorMessage(reinstallError);
      logger.warn(`[CTRL_PROXY] APK reinstall failed: ${reinstallMessage}`, reinstallError);
      this.host.clearAvailabilityCache();
      return {
        ...result,
        status: "failed",
        reinstallError: isInstalled
          ? await this.describeReinstallFailure(reinstallMessage)
          : reinstallMessage,
        cause: reinstallError,
      };
    }
  }

  private async warnBeforePrototypeUninstall(): Promise<boolean> {
    try {
      const entries = await this.host.savedPrototypes.list(this.host.device.deviceId);
      if (entries.length === 0) {
        return false;
      }
      logger.warn(
        `[CTRL_PROXY] Uninstall will delete saved prototypes from ${this.host.device.deviceId}; restoring from host mirror: ${entries.map((entry) => `${entry.id} (${entry.label})`).join(", ")}`,
      );
      return true;
    } catch (error) {
      logger.warn("[CTRL_PROXY] Cannot inspect saved prototype mirror before uninstall", error);
      return false;
    }
  }

  private async restoreAfterReinstall(): Promise<SavedPrototypeRestoreReport> {
    try {
      const binding = await raceWithDeadline(() => this.host.waitForAccessibilityServiceBinding(), {
        timer: this.host.timer,
        timeoutMs: REBIND_BIND_WAIT_BUDGET_MS,
        label: "Saved prototype restore accessibility service binding",
      });
      if (binding === "unhealthy") {
        logger.warn(
          "[CTRL_PROXY] Accessibility service binding unavailable before prototype restore; attempting restore",
        );
      }
    } catch (error) {
      logger.warn(
        "[CTRL_PROXY] Accessibility service binding wait failed before prototype restore; attempting restore",
        error,
      );
    }
    let report: SavedPrototypeRestoreReport;
    try {
      report = await this.host.savedPrototypes.restore(this.host.device, this.host.timer);
    } catch (error) {
      logger.warn("[CTRL_PROXY] Saved prototype restore after reinstall failed", error);
      report = {
        restored: [],
        skipped: [],
        failed: [{ id: "*", code: "restore_failed", reason: errorMessage(error) }],
      };
    }
    if (report.failed.length > 0) {
      logger.warn(
        `[CTRL_PROXY] Saved prototype restore failed for: ${report.failed.map((failure) => failure.id).join(", ")}`,
        report,
      );
    }
    return report;
  }

  private getCachedVersionCheckResult(): AccessibilityVersionCheckResult | null {
    if (!this.cachedVersionCheck) {
      return null;
    }

    const cacheAge = this.host.timer.now() - this.cachedVersionCheck.timestamp;
    if (cacheAge >= AndroidCtrlProxyCompatibility.VERSION_CHECK_CACHE_TTL) {
      this.cachedVersionCheck = null;
      return null;
    }

    logger.debug(
      `[CTRL_PROXY] Using cached version check result (age: ${cacheAge}ms): ${this.cachedVersionCheck.result.status}`,
    );
    return { ...this.cachedVersionCheck.result };
  }

  private cacheVersionCheckResult(
    result: AccessibilityVersionCheckResult,
  ): AccessibilityVersionCheckResult {
    this.cachedVersionCheck = {
      result: { ...result },
      timestamp: this.host.timer.now(),
    };
    return result;
  }

  private isNetworkError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("could not resolve host") ||
      normalized.includes("failed to connect") ||
      normalized.includes("network is unreachable") ||
      normalized.includes("connection timed out") ||
      normalized.includes("timed out") ||
      normalized.includes("name lookup timed out") ||
      normalized.includes("temporary failure in name resolution") ||
      normalized.includes("enotfound") ||
      normalized.includes("econnrefused") ||
      normalized.includes("ehostunreach") ||
      normalized.includes("enetunreach") ||
      normalized.includes("etimedout")
    );
  }

  setupCompatibilityResult(
    compatibilityResult: AccessibilityVersionCheckResult,
    perf: PerformanceTracker,
  ): CtrlProxySetupResult | null {
    if (compatibilityResult.status === "failed") {
      perf.end();
      const error =
        compatibilityResult.error ||
        compatibilityResult.upgradeError ||
        compatibilityResult.reinstallError;
      return {
        success: false,
        message: "Failed to ensure compatible Accessibility Service version",
        error,
        cause: compatibilityResult.cause,
        category: classifySetupError(error ?? "", this.host.device.deviceId).category,
        perfTiming: perf.getTimings(),
      };
    }
    if (
      compatibilityResult.status === "upgraded" ||
      compatibilityResult.status === "installed" ||
      compatibilityResult.status === "reinstalled"
    ) {
      perf.end();
      return {
        success: true,
        message: "Accessibility Service upgraded to a compatible version",
        perfTiming: perf.getTimings(),
        ...(compatibilityResult.savedPrototypeRestore === undefined
          ? {}
          : { savedPrototypeRestore: compatibilityResult.savedPrototypeRestore }),
      };
    }

    return null;
  }
}
