import { getAbortSignal } from "../utils/AbortContext";
import { runPhaseWithSettlement } from "../utils/runPhaseWithSettlement";
import { errorMessage } from "../utils/describeUnknownError";
import { toActionableError } from "../models/ActionableError";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../utils/logger";
import { grantLocalNetworkPermission } from "./grantLocalNetworkPermission";
import { VerifiedArtifactCache } from "../utils/VerifiedArtifactCache";
import { isPathInside } from "../utils/filesystem/pathContainment";
import { packageListingContains } from "../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../utils/shellQuote";
import * as fs from "fs/promises";
import * as path from "path";
import { BootedDevice, ExecResult } from "../models";
import { resolveApkUrl } from "../constants/release";
import AdmZip from "adm-zip";
import crypto from "crypto";
import os from "os";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { Timer } from "../utils/SystemTimer";
import { type FileDownloader } from "../utils/FileDownloader";
import { type ChecksumCalculator } from "../utils/ChecksumCalculator";
import { CTRL_PROXY_PACKAGE } from "./constants";
import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import { CtrlProxyForwardOwnershipUnreadableError } from "../models/CtrlProxyForwardOwnershipUnreadableError";
import { CtrlProxyApkStageError } from "./CtrlProxyApkStageError";
import type { InstalledApkSha256Result } from "./AndroidCtrlProxyManagerTypes";

const CTRL_PROXY_INSTALL_TIMEOUT_MS = 120_000;
const CTRL_PROXY_PULL_TIMEOUT_MS = 120_000;

/** Live manager dependencies; callbacks preserve manager overrides and test spies. */
export interface AndroidCtrlProxyApkInstallerHost {
  assertPinnedVersionVerifiable(): void;
  getApkPathOverride(): string | null;
  consumePrefetchedApk(destinationPath: string): Promise<boolean>;
  getExpectedChecksum(useSharedCache?: boolean): Promise<string>;
  cleanupApk(apkPath: string): Promise<void>;
  readonly fileDownloader: FileDownloader;
  readonly checksumCalculator: ChecksumCalculator;
  readonly adb: AdbExecutor;
  assertNotDrivenByOtherDaemon(signal?: AbortSignal): Promise<void>;
  clearAvailabilityCache(): void;
  readonly timer: Timer;
  executeApkStage(command: string, stage: string): Promise<ExecResult>;
  grantLocalNetworkAfterInstall(): Promise<void>;
  statusInspectionDeviceError(error: unknown): Error | undefined;
  getApiLevel(): Promise<[number | null, boolean]>;
  readonly device: BootedDevice;
}

/** APK download, verification, staging, installation and installed digest reads. */
export class AndroidCtrlProxyApkInstaller {
  /** Package name used before the rename to CtrlProxy — uninstalled opportunistically on device setup */
  private static readonly LEGACY_PACKAGE = "dev.jasonpearson.automobile.accessibilityservice";
  constructor(private readonly host: AndroidCtrlProxyApkInstallerHost) {}

  /**
   * Download APK
   */
  async downloadApk(): Promise<string> {
    // Defense-in-depth for direct callers: fail closed on an unverifiable pin
    // before touching the filesystem or network (#2746).
    this.host.assertPinnedVersionVerifiable();
    const perf = createGlobalPerformanceTracker();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-"));
    const apkPath = path.join(tempDir, "control-proxy.apk");

    try {
      const overridePath = this.host.getApkPathOverride();
      // Set when the shared cache downloaded and fully verified the APK itself; holds the
      // checksum it was verified against ("" when none was configured).
      let cacheVerifiedAgainst: string | null = null;
      perf.startOperation("httpDownload");
      if (overridePath) {
        logger.info("Using local accessibility service APK", { path: overridePath });
        const stats = await fs.stat(overridePath);
        if (!stats.isFile()) {
          throw new Error(`Accessibility APK override is not a file: ${overridePath}`);
        }
        await fs.copyFile(overridePath, apkPath);
      } else {
        // Try to use prefetched APK first (already downloaded and validated at server startup)
        const usedPrefetch = await this.host.consumePrefetchedApk(apkPath);
        if (usedPrefetch) {
          logger.info("Using prefetched accessibility service APK", { path: apkPath });
        } else {
          cacheVerifiedAgainst = await this.downloadAndVerifyApk(apkPath);
        }
      }
      perf.endOperation("httpDownload");

      const stats = await fs.stat(apkPath);
      if (cacheVerifiedAgainst === null) {
        await this.assertApkSizeAndStructure(apkPath);
        const expectedChecksum = await this.host.getExpectedChecksum();
        // Perform checksum verification (only if checksum is provided)
        if (expectedChecksum.length > 0) {
          perf.startOperation("checksumVerify");
          await this.verifyApkChecksum(apkPath, expectedChecksum);
          perf.endOperation("checksumVerify");
        } else {
          this.warnApkChecksumSkipped();
        }
      } else if (cacheVerifiedAgainst.length === 0) {
        this.warnApkChecksumSkipped();
      }

      logger.info("APK downloaded successfully", { path: apkPath, size: stats.size });
      return apkPath;
    } catch (error) {
      // Clean up failed download
      try {
        await this.host.cleanupApk(apkPath);
      } catch (cleanupError) {
        // Failed-download cleanup is best-effort; the original download error still surfaces below.
        logger.debug(
          `[CTRL_PROXY] Failed to clean up incomplete APK download: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }

      throw new Error(`Failed to download APK: ${errorMessage(error)}`);
    }
  }

  /** Download the release APK via the shared cache; returns the checksum it was verified against. */
  private async downloadAndVerifyApk(apkPath: string): Promise<string> {
    const apkUrl = resolveApkUrl();
    logger.info("Downloading APK", { url: apkUrl, destination: apkPath });
    const expected = await this.host.getExpectedChecksum();
    await new VerifiedArtifactCache({
      downloader: this.host.fileDownloader,
      checksumCalculator: this.host.checksumCalculator,
    }).fetch({
      label: "[CTRL_PROXY]",
      expectedSha256: expected.length > 0 ? expected.toLowerCase() : null,
      url: apkUrl,
      archivePath: `${apkPath}.download`,
      finalPath: apkPath,
      // Size and structure are checked before the hash, as for override/prefetched APKs.
      afterDownload: async (downloaded) => {
        await this.assertApkSizeAndStructure(downloaded);
      },
      mismatchError: (want, actual) => {
        logger.warn("APK checksum verification failed", {
          expected: want,
          actual: actual.toLowerCase(),
        });
        return new Error(
          `APK checksum verification failed. Expected: ${want}, Got: ${actual.toLowerCase()}`,
        );
      },
      publish: async (_downloaded, checksum, source) => {
        if (checksum !== null) {
          logger.info("APK checksum verified successfully", {
            checksum: checksum.toLowerCase(),
            source,
          });
        }
      },
    });
    return expected;
  }

  private async verifyApkChecksum(apkPath: string, expectedChecksum: string): Promise<void> {
    const { checksum: actualChecksum, source } =
      await this.host.checksumCalculator.computeFileSha256(apkPath);
    const normalizedActual = actualChecksum.toLowerCase();
    const normalizedExpected = expectedChecksum.toLowerCase();

    if (normalizedActual !== normalizedExpected) {
      logger.warn("APK checksum verification failed", {
        expected: normalizedExpected,
        actual: normalizedActual,
      });
      throw new Error(
        `APK checksum verification failed. Expected: ${normalizedExpected}, Got: ${normalizedActual}`,
      );
    }

    logger.info("APK checksum verified successfully", { checksum: normalizedActual, source });
  }

  /** Reject an implausibly small or structurally invalid APK before it is hashed or installed. */
  private async assertApkSizeAndStructure(apkPath: string): Promise<void> {
    // Verify the file exists and has reasonable size (should be > 10KB)
    const stats = await fs.stat(apkPath);
    if (stats.size < 10000) {
      throw new Error(`Downloaded APK is too small (${stats.size} bytes), likely invalid`);
    }
    this.verifyApkIntegrity(apkPath);
  }

  private warnApkChecksumSkipped(): void {
    logger.warn("APK checksum verification SKIPPED - no checksum provided (development mode)", {
      apkUrl: resolveApkUrl(),
    });
  }

  private verifyApkIntegrity(apkPath: string): void {
    try {
      const zip = new AdmZip(apkPath);
      const entries = zip.getEntries();
      const hasManifest = entries.some((entry) => entry.entryName === "AndroidManifest.xml");
      if (!hasManifest) {
        throw new Error("AndroidManifest.xml missing");
      }
    } catch (error) {
      throw new Error(`APK integrity check failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Uninstall the legacy accessibility service package if still present on the device.
   * This cleans up the old package name left over from before the rename to CtrlProxy.
   */
  async uninstallLegacyPackageIfPresent(guardOwnership = false): Promise<void> {
    let uninstallAttempted = false;
    try {
      const result = await this.host.adb.executeCommand(
        `shell pm list packages ${AndroidCtrlProxyApkInstaller.LEGACY_PACKAGE}`,
        { noRetry: true },
      );
      if (!packageListingContains(result.stdout, AndroidCtrlProxyApkInstaller.LEGACY_PACKAGE)) {
        return;
      }
      if (guardOwnership) {
        await this.host.assertNotDrivenByOtherDaemon();
      }
      logger.info(
        `[CTRL_PROXY] Found legacy package ${AndroidCtrlProxyApkInstaller.LEGACY_PACKAGE}, uninstalling`,
      );
      uninstallAttempted = true;
      await this.host.adb.executeCommand(
        `shell pm uninstall ${AndroidCtrlProxyApkInstaller.LEGACY_PACKAGE}`,
        { timeoutMs: CTRL_PROXY_INSTALL_TIMEOUT_MS },
      );
      logger.info(`[CTRL_PROXY] Legacy package uninstalled`);
    } catch (error) {
      if (
        error instanceof DeviceOwnedByOtherDaemonError ||
        error instanceof CtrlProxyForwardOwnershipUnreadableError
      ) {
        throw error;
      }
      // Legacy cleanup is best-effort; failure must not block setup of the current package.
      logger.warn(
        `[CTRL_PROXY] Failed to check/uninstall legacy package: ${errorMessage(error)}`,
        error,
      );
    } finally {
      if (uninstallAttempted) {
        this.host.clearAvailabilityCache();
      }
    }
  }

  /**
   * Install APK
   */
  async executeApkStage(command: string, stage: string): Promise<ExecResult> {
    return await runPhaseWithSettlement(
      {
        timer: this.host.timer,
        timeoutMs: CTRL_PROXY_INSTALL_TIMEOUT_MS,
        signal: getAbortSignal(),
        graceMs: 0,
        label: stage,
        timeoutError: () =>
          new CtrlProxyApkStageError(
            `${stage} timed out after ${CTRL_PROXY_INSTALL_TIMEOUT_MS}ms. Retry device acquisition.`,
          ),
        defaultAbortError: () =>
          new CtrlProxyApkStageError(`${stage} cancelled. Retry device acquisition.`),
        explicitAbortError: (reason) =>
          new CtrlProxyApkStageError(`${stage} cancelled: ${errorMessage(reason)}`, {
            cause: reason,
          }),
      },
      async (signal) => {
        const result = await this.host.adb.executeCommand(command, {
          timeoutMs: CTRL_PROXY_INSTALL_TIMEOUT_MS,
          signal,
        });
        signal.throwIfAborted();
        return result;
      },
    );
  }

  async install(apkPath: string): Promise<void> {
    await this.host.assertNotDrivenByOtherDaemon();
    try {
      logger.info("Installing APK", { path: apkPath });

      const result = await this.host.executeApkStage(
        `install "${apkPath}"`,
        "CtrlProxy APK install",
      );
      const resultString = result.toString().toLowerCase();

      if (resultString.includes("failure") || resultString.includes("error")) {
        throw new Error(`Installation failed: ${result.toString()}`);
      }

      if (!resultString.includes("success")) {
        logger.warn("Installation result unclear", { result: result.toString() });
      }

      logger.info("APK installed successfully");
      this.host.clearAvailabilityCache();
      await this.host.grantLocalNetworkAfterInstall();
    } catch (error) {
      // A failed adb install can still have changed package state before the
      // command reported an error.
      this.host.clearAvailabilityCache();
      if (error instanceof CtrlProxyApkStageError) {
        throw error;
      }
      const deviceError = this.host.statusInspectionDeviceError(error);
      if (deviceError) {
        throw deviceError;
      }
      throw toActionableError(error, "Failed to install APK");
    }
  }

  async grantLocalNetworkAfterInstall(): Promise<void> {
    const [apiLevel] = await this.host.getApiLevel();
    await grantLocalNetworkPermission(this.host.adb, CTRL_PROXY_PACKAGE, apiLevel);
  }

  /**
   * Clean up temporary APK file
   */
  async cleanupApk(apkPath: string): Promise<void> {
    try {
      const tempRoot = path.resolve(os.tmpdir());
      const tempDir = path.resolve(path.dirname(apkPath));
      const tempBase = path.basename(tempDir);
      const isTempDir =
        isPathInside(tempRoot, tempDir, { allowEqual: false }) &&
        tempBase.startsWith("auto-mobile-");

      await fs.rm(apkPath, { force: true });
      if (isTempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
        logger.info("Temporary APK directory cleaned up", { path: tempDir });
      } else {
        logger.info("Temporary APK file cleaned up", { path: apkPath });
      }
    } catch (error) {
      logger.warn("Failed to clean up temporary APK file", {
        path: apkPath,
        error: errorMessage(error),
      });
    }
  }

  /** Installed-APK digest plus where it was read from; public for diagnostics and tests. */
  async getInstalledApkSha256WithDetails(signal?: AbortSignal): Promise<InstalledApkSha256Result> {
    const throwIfAborted = () => signal?.throwIfAborted();
    throwIfAborted();
    const apkPath = await this.getInstalledApkPath();
    throwIfAborted();
    if (!apkPath) {
      return {
        sha256: null,
        source: "none",
        error: "Installed APK path not found",
      };
    }

    try {
      const shaResult = await this.host.adb.executeCommand(
        `shell sha256sum ${shellQuote(apkPath)}`,
      );
      throwIfAborted();
      const sha256 = shaResult.stdout.trim().split(/\s+/)[0];
      if (sha256) {
        return {
          sha256,
          source: "device",
          apkPath,
        };
      }
    } catch (error) {
      throwIfAborted();
      const deviceError = this.host.statusInspectionDeviceError(error);
      if (deviceError) {
        throw deviceError;
      }
      logger.warn("[CTRL_PROXY] sha256sum unavailable or failed, falling back to host hash", {
        error: errorMessage(error),
      });
    }

    throwIfAborted();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-apk-"));
    const safeDeviceId = (this.host.device.deviceId || "device").replace(/[^a-zA-Z0-9_.-]/g, "_");
    const localApkPath = path.join(tempDir, `control-proxy-installed-${safeDeviceId}.apk`);

    try {
      throwIfAborted();
      await this.host.adb.executeCommand(`pull "${apkPath}" "${localApkPath}"`, {
        timeoutMs: CTRL_PROXY_PULL_TIMEOUT_MS,
      });
      const apkBuffer = await fs.readFile(localApkPath);
      const sha256 = crypto.createHash("sha256").update(apkBuffer).digest("hex");
      return {
        sha256,
        source: "host",
        apkPath,
      };
    } catch (error) {
      throwIfAborted();
      const deviceError = this.host.statusInspectionDeviceError(error);
      if (deviceError) {
        throw deviceError;
      }
      logger.warn("[CTRL_PROXY] Failed to compute installed APK hash via host fallback", {
        error: errorMessage(error),
      });
      return {
        sha256: null,
        source: "none",
        apkPath,
        error: errorMessage(error),
      };
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // Temp-dir cleanup is best-effort; checksum fallback already completed or returned.
        logger.debug(
          `[CTRL_PROXY] Failed to remove temporary APK hash directory: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
    }
  }

  private async getInstalledApkPath(): Promise<string | null> {
    try {
      const pathResult = await this.host.adb.executeCommand(`shell pm path ${CTRL_PROXY_PACKAGE}`, {
        noRetry: true,
      });
      const line = pathResult.stdout
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith("package:"));

      if (!line) {
        return null;
      }

      return line.replace("package:", "").trim() || null;
    } catch (error) {
      const deviceError = this.host.statusInspectionDeviceError(error);
      if (deviceError) {
        throw deviceError;
      }
      logger.warn("[CTRL_PROXY] Failed to resolve installed APK path", {
        error: errorMessage(error),
      });
      return null;
    }
  }
}
