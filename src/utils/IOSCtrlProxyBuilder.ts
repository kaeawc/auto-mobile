import * as fs from "fs/promises";
import * as path from "path";
import os from "os";
import { logger } from "./logger";
import { defaultTimer, type Timer } from "./SystemTimer";
import { NoOpPerformanceTracker, type PerformanceTracker } from "./PerformanceTracker";
import {
  IOS_CTRL_PROXY_APP_HASH,
  LATEST_RELEASE_VERSION,
  isExplicitPin,
  isPinnedVersionKnown,
  resolveAssetVersion,
  resolveIpaChecksum,
  resolveIpaUrl,
  resolvePinnedVersion,
  resolveRunnerChecksum,
  resolveRunnerChecksumTarget,
  type RunnerSha256Target
} from "../constants/release";
import {
  DefaultIOSCtrlProxyBundleDownloader,
  type CtrlProxyIosBundleDownloader
} from "./IOSCtrlProxyBundleDownloader";
import { hashAppBundle } from "./ios-cmdline-tools/AppBundleHasher";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "./workingDirectory";
import { getTempDir } from "./tempDir";
import { ensureSecureDir } from "./filesystem/securePermissions";
import {
  buildPlist,
  injectUITestEnvironment,
  parsePlist,
  type PlistValue
} from "./ios-cmdline-tools/XctestrunPlist";
import { ActionableError, toActionableError } from "../models/ActionableError";
import {
  SKIP_CTRL_PROXY_DOWNLOAD_ENV,
  isTruthyEnvValue,
} from "./ctrlProxyDownloadControl";
import {
  type IosPrerequisiteDetector,
  DefaultIosPrerequisiteDetector
} from "./ios-cmdline-tools/IosPrerequisiteDetector";
import {
  type CodesignVerificationOutcome,
  type CtrlProxyCodesignVerifier,
  DefaultCtrlProxyCodesignVerifier
} from "./ios-cmdline-tools/CtrlProxyCodesignVerifier";

/**
 * When truthy (`1`/`true`), a failed `codesign --verify`, a failed
 * `spctl --assess`, or a Team-ID mismatch turns the default WARNING into a hard
 * refusal to launch the downloaded iOS helper (issue #4760). Off by default so
 * dev / self-built / unsigned local helpers still run — code signing is not
 * OS-enforced on the simulator anyway, so the value here is defense-in-depth on
 * physical devices alongside the #4759 hash re-verification.
 */
export const IOS_HELPER_REQUIRE_CODESIGN_ENV = "AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN";
/**
 * Optional pinned Apple Team ID. When set, the runner bundle's
 * `TeamIdentifier` must match; a mismatch warns (or refuses, under
 * {@link IOS_HELPER_REQUIRE_CODESIGN_ENV}). Unset by default because we ship no
 * canonical Team ID (issue #4760).
 */
export const IOS_HELPER_TEAM_ID_ENV = "AUTOMOBILE_IOS_HELPER_TEAM_ID";

/**
 * Turn a codesign inspection outcome into a list of human-readable problems,
 * honoring an optional pinned Team ID (issue #4760). An empty list means the
 * runner passed every applicable check.
 */
function collectCodesignProblems(
  outcome: CodesignVerificationOutcome,
  pinnedTeamId: string | null
): string[] {
  const problems: string[] = [];
  if (!outcome.verified) {
    problems.push("codesign --verify --deep --strict failed");
  }
  if (outcome.notarized === false) {
    problems.push("spctl --assess (notarization/Gatekeeper) failed");
  }
  if (pinnedTeamId && outcome.teamId && outcome.teamId !== pinnedTeamId) {
    problems.push(`Team ID mismatch (pinned ${pinnedTeamId}, bundle ${outcome.teamId})`);
  }
  if (pinnedTeamId && !outcome.teamId) {
    problems.push(`Team ID pin ${pinnedTeamId} set but the bundle is unsigned / has no Team ID`);
  }
  return problems;
}

/**
 * Result of CtrlProxy download/install
 */
export interface CtrlProxyIosBuildResult {
  success: boolean;
  message: string;
  buildPath?: string;      // Path to build products
  xctestrunPath?: string;  // Path to .xctestrun file
  error?: string;
}

/**
 * CtrlProxy Build Configuration
 */
interface CtrlProxyIosBuildConfig {
  projectRoot: string;
  derivedDataPath: string;
  scheme: string;
  destination: string;
  bundleCacheDir: string;
}

interface CtrlProxyIosBuilderDependencies {
  downloader?: CtrlProxyIosBundleDownloader;
}

/**
 * The narrow builder surface {@link IOSCtrlProxyBuilder.doPrefetch} drives.
 * Exposed so the prefetch gate can be tested without a real build/download
 * (issue #4407); grow it only when the prefetch needs another method.
 */
export type PrefetchBuilder = Pick<
  IOSCtrlProxyBuilder,
  "needsRebuild" | "getBuildProductsPath" | "getXctestrunPath" | "build"
>;

type IOSCtrlProxyPlatform = "simulator" | "device";

type IOSCtrlProxyBundleMetadata = {
  checksum: string | null;
  version: string;
  extractedAt: string;
  appHashes?: Partial<Record<IOSCtrlProxyPlatform, string>>;
};

/**
 * CtrlProxy Builder
 * Handles release bundle download and extraction for CtrlProxy
 */
export class IOSCtrlProxyBuilder {
  /**
   * Filename prefix for the per-launch xctestrun copies written by
   * {@link writeRunnerEnvironment}. Distinct from the build-products xctestrun so
   * the copies are excluded from source discovery/cleanup globs.
   */
  private static readonly RUNNER_XCTESTRUN_PREFIX = "automobile-runner-";
  private static readonly DEFAULT_PROJECT_ROOT = process.cwd();
  /**
   * Subdirectory under the uid-private auto-mobile base (`~/.auto-mobile`) where
   * the runner bundle is extracted and later launched from. Replaces the former
   * world-writable, predictable `/tmp/automobile-ctrl-proxy` default: on a shared
   * host any other uid could pre-seed that path or swap the runner/xctest binary
   * between the integrity check and launch (TOCTOU, issue #4759). Resolved lazily
   * via {@link getTempDir} so an `AUTOMOBILE_DATA_DIR` override set after module
   * load is honored.
   */
  private static readonly DEFAULT_DERIVED_DATA_SUBDIR = "derived-data";
  private static readonly DEFAULT_SCHEME = "CtrlProxyApp";
  private static readonly DEFAULT_DESTINATION = "generic/platform=iOS Simulator";
  private static readonly DEFAULT_BUNDLE_CACHE_DIR = path.join(os.homedir(), ".automobile", "ctrl-proxy-ios");
  private static readonly DEFAULT_BUNDLE_FILENAME = "control-proxy.ipa";
  private static readonly METADATA_FILENAME = "ctrl-proxy-ios-bundle.json";
  private static readonly MIN_BUNDLE_SIZE_BYTES = 10000;

  // Build state
  private static prefetchPromise: Promise<CtrlProxyIosBuildResult | null> | null = null;
  private static prefetchResult: CtrlProxyIosBuildResult | null = null;
  private static prefetchError: Error | null = null;
  private static expectedChecksumOverride: string | null = null;
  private static expectedRunnerChecksumOverride: string | null = null;
  private static expectedRunnerChecksumTargetOverride: RunnerSha256Target | null = null;
  private static timer: Timer = defaultTimer;

  // Gate that decides whether the startup runner-bundle prefetch should run at
  // all (issue #4407). Skips cleanly on hosts without a usable Xcode toolchain.
  private static iosPrerequisiteDetector: IosPrerequisiteDetector = new DefaultIosPrerequisiteDetector();
  // Test seam for the builder the static prefetch drives; null uses getInstance().
  private static prefetchBuilderOverride: PrefetchBuilder | null = null;

  // Pre-launch codesign/notarization gate (issue #4760). Static seam mirrors
  // `timer` so tests inject a fake and never spawn a real `codesign`/`spctl`.
  private static codesignVerifier: CtrlProxyCodesignVerifier = new DefaultCtrlProxyCodesignVerifier();

  // Singleton instances per configuration
  private static instances: Map<string, IOSCtrlProxyBuilder> = new Map();

  private readonly config: CtrlProxyIosBuildConfig;
  private readonly downloader: CtrlProxyIosBundleDownloader;
  /**
   * NOT using TTLCache: file-existence validation via fs.access(), not time-based.
   * Cache is invalidated when files are re-extracted, not after a TTL.
   */
  private cachedBuildProductsPath: Map<IOSCtrlProxyPlatform, string | null> = new Map();
  /**
   * NOT using TTLCache: file-existence validation via fs.access(), not time-based.
   * Cache is invalidated when files are re-extracted, not after a TTL.
   */
  private cachedXctestrunPath: Map<string, string | null> = new Map();
  /**
   * NOT using TTLCache: file-existence validation via fs.access(), not time-based.
   * Hash is computed once per build and cached until next build/extraction.
   */
  private cachedAppBundleHash: Map<IOSCtrlProxyPlatform, string | null> = new Map();

  private constructor(
    config: Partial<CtrlProxyIosBuildConfig> = {},
    dependencies: CtrlProxyIosBuilderDependencies = {}
  ) {
    this.config = {
      projectRoot: config.projectRoot || process.env.AUTOMOBILE_PROJECT_ROOT || IOSCtrlProxyBuilder.DEFAULT_PROJECT_ROOT,
      derivedDataPath: config.derivedDataPath || process.env.AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA || getTempDir(IOSCtrlProxyBuilder.DEFAULT_DERIVED_DATA_SUBDIR),
      scheme: config.scheme || IOSCtrlProxyBuilder.DEFAULT_SCHEME,
      destination: config.destination || IOSCtrlProxyBuilder.DEFAULT_DESTINATION,
      bundleCacheDir: config.bundleCacheDir || process.env.AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR || IOSCtrlProxyBuilder.DEFAULT_BUNDLE_CACHE_DIR,
    };
    this.downloader = dependencies.downloader ?? new DefaultIOSCtrlProxyBundleDownloader();
  }

  /**
   * Get singleton instance for default configuration
   */
  public static getInstance(
    config?: Partial<CtrlProxyIosBuildConfig>,
    dependencies?: CtrlProxyIosBuilderDependencies
  ): IOSCtrlProxyBuilder {
    const key = JSON.stringify({
      config: config || {},
      deps: dependencies?.downloader ? "custom" : "default"
    });
    if (!IOSCtrlProxyBuilder.instances.has(key)) {
      IOSCtrlProxyBuilder.instances.set(key, new IOSCtrlProxyBuilder(config, dependencies));
    }
    return IOSCtrlProxyBuilder.instances.get(key)!;
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    IOSCtrlProxyBuilder.instances.clear();
    IOSCtrlProxyBuilder.prefetchPromise = null;
    IOSCtrlProxyBuilder.prefetchResult = null;
    IOSCtrlProxyBuilder.prefetchError = null;
    IOSCtrlProxyBuilder.expectedChecksumOverride = null;
    IOSCtrlProxyBuilder.expectedRunnerChecksumOverride = null;
    IOSCtrlProxyBuilder.expectedRunnerChecksumTargetOverride = null;
    IOSCtrlProxyBuilder.timer = defaultTimer;
    IOSCtrlProxyBuilder.iosPrerequisiteDetector = new DefaultIosPrerequisiteDetector();
    IOSCtrlProxyBuilder.prefetchBuilderOverride = null;
    IOSCtrlProxyBuilder.codesignVerifier = new DefaultCtrlProxyCodesignVerifier();
  }

  /**
   * Override the codesign/notarization verifier for testing (issue #4760). Null
   * restores the default `codesign`/`spctl`-backed verifier.
   */
  public static setCodesignVerifierForTesting(verifier: CtrlProxyCodesignVerifier | null): void {
    IOSCtrlProxyBuilder.codesignVerifier = verifier ?? new DefaultCtrlProxyCodesignVerifier();
  }

  /**
   * Override the timer for testing
   */
  public static setTimerForTesting(timer: Timer): void {
    IOSCtrlProxyBuilder.timer = timer;
  }

  /**
   * Override checksum for tests
   */
  public static setExpectedChecksumForTesting(checksum: string | null): void {
    IOSCtrlProxyBuilder.expectedChecksumOverride = checksum;
  }

  /** Override the iOS-prerequisite gate for the prefetch (issue #4407). Null restores the default detector. */
  public static setIosPrerequisiteDetectorForTesting(detector: IosPrerequisiteDetector | null): void {
    IOSCtrlProxyBuilder.iosPrerequisiteDetector = detector ?? new DefaultIosPrerequisiteDetector();
  }

  /** Override the builder driven by the static prefetch (issue #4407). Null restores getInstance(). */
  public static setPrefetchBuilderForTesting(builder: PrefetchBuilder | null): void {
    IOSCtrlProxyBuilder.prefetchBuilderOverride = builder;
  }

  public static setExpectedRunnerChecksumForTesting(
    checksum: string | null,
    target: RunnerSha256Target | null = null
  ): void {
    IOSCtrlProxyBuilder.expectedRunnerChecksumOverride = checksum;
    IOSCtrlProxyBuilder.expectedRunnerChecksumTargetOverride = target;
  }

  /**
   * Get the build products directory path
   */
  public async getBuildProductsPath(platform: IOSCtrlProxyPlatform = "simulator"): Promise<string | null> {
    const cachedPath = this.cachedBuildProductsPath.get(platform);
    if (cachedPath) {
      try {
        await fs.access(cachedPath);
        return cachedPath;
      } catch {
        this.cachedBuildProductsPath.set(platform, null);
      }
    }

    const buildDir = path.join(
      this.config.derivedDataPath,
      "Build",
      "Products",
      platform === "device" ? "Debug-iphoneos" : "Debug-iphonesimulator"
    );

    try {
      await fs.access(buildDir);
      this.cachedBuildProductsPath.set(platform, buildDir);
      return buildDir;
    } catch (error) {
      // Build products directory doesn't exist yet (no build has run); null tells the
      // caller to trigger a build rather than treating this as a hard failure.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  /**
   * Get the .xctestrun file path
   */
  public async getXctestrunPath(platform?: IOSCtrlProxyPlatform): Promise<string | null> {
    const cacheKey = platform || "any";
    const cachedPath = this.cachedXctestrunPath.get(cacheKey);
    if (cachedPath) {
      try {
        await fs.access(cachedPath);
        return cachedPath;
      } catch {
        this.cachedXctestrunPath.set(cacheKey, null);
      }
    }

    const productsDir = path.join(this.config.derivedDataPath, "Build", "Products");
    try {
      const files = await fs.readdir(productsDir);
      const xctestrunFiles = files.filter(
        file => file.endsWith(".xctestrun") &&
          !file.startsWith(IOSCtrlProxyBuilder.RUNNER_XCTESTRUN_PREFIX)
      );
      if (xctestrunFiles.length === 0) {
        return null;
      }

      const platformFilter = platform === "device" ? "iphoneos" : "iphonesimulator";
      const candidates = platform
        ? xctestrunFiles.filter(file => file.includes(platformFilter))
        : xctestrunFiles;

      if (candidates.length === 0) {
        return null;
      }

      // When multiple xctestrun files exist, prefer the newest by modification time
      let selected: string;
      if (candidates.length === 1) {
        selected = candidates[0];
      } else {
        const withStats = await Promise.all(
          candidates.map(async file => {
            const filePath = path.join(productsDir, file);
            const stat = await fs.stat(filePath);
            return { file, mtime: stat.mtimeMs };
          })
        );
        withStats.sort((a, b) => b.mtime - a.mtime);
        selected = withStats[0].file;
      }

      const fullPath = path.join(productsDir, selected);
      this.cachedXctestrunPath.set(cacheKey, fullPath);
      return fullPath;
    } catch (error) {
      // Products directory listing/stat failed (e.g. not built yet); reporting no
      // xctestrun path lets the caller fall back to triggering a build.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  /**
   * Inject runner environment variables into a copy of the xctestrun so they
   * reach the in-simulator / on-device XCUITest runner process.
   *
   * `xcodebuild test-without-building` does NOT forward the host process
   * environment (or `SIMCTL_CHILD_*`) into the runner — the only channel that
   * reaches it is the xctestrun's per-target `EnvironmentVariables` dict, which
   * xcodebuild injects into the test host (the runner app). Without this the
   * runner never sees the allocated `CTRL_PROXY_IOS_PORT` and falls back to its
   * hardcoded `defaultPort` (8765), breaking multi-device setups where the
   * daemon allocated a non-default port (issue #2731).
   *
   * The injected variables are written to a per-launch copy in the SAME
   * directory as the source xctestrun (so `__TESTROOT__` still resolves to the
   * build products dir). The copy's name intentionally omits the platform token
   * so it is ignored by {@link getXctestrunPath}/{@link cleanStaleXctestrunFiles}
   * and so concurrent devices don't race on a shared file.
   *
   * @returns the path to the per-launch xctestrun copy to pass to `xcodebuild`.
   */
  public async writeRunnerEnvironment(
    xctestrunPath: string,
    env: Record<string, string>,
    deviceId: string
  ): Promise<string> {
    try {
      const xml = await fs.readFile(xctestrunPath, "utf-8");
      const root = await parsePlist(xml);
      if (!(root instanceof Map)) {
        throw new Error("xctestrun root is not a plist dictionary");
      }

      const injected = injectUITestEnvironment(root as Map<string, PlistValue>, env);
      if (injected === 0) {
        throw new Error(
          "xctestrun contains no UI-test bundle (IsUITestBundle) to receive the runner environment"
        );
      }

      const safeDeviceId = deviceId.replace(/[^A-Za-z0-9._-]/g, "_") || "device";
      const outputPath = path.join(
        path.dirname(xctestrunPath),
        `${IOSCtrlProxyBuilder.RUNNER_XCTESTRUN_PREFIX}${safeDeviceId}.xctestrun`
      );
      await fs.writeFile(outputPath, buildPlist(root), "utf-8");
      logger.info(
        `[IOSCtrlProxyBuilder] Wrote runner xctestrun with injected environment to ${outputPath}`
      );
      return outputPath;
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to inject runner environment into xctestrun at ${xctestrunPath}`
      );
    }
  }

  /**
   * Remove stale xctestrun files, keeping only the newest per platform.
   */
  public async cleanStaleXctestrunFiles(): Promise<void> {
    const productsDir = path.join(this.config.derivedDataPath, "Build", "Products");
    try {
      const files = await fs.readdir(productsDir);
      const xctestrunFiles = files.filter(
        file => file.endsWith(".xctestrun") &&
          !file.startsWith(IOSCtrlProxyBuilder.RUNNER_XCTESTRUN_PREFIX)
      );
      if (xctestrunFiles.length <= 1) {
        return;
      }

      for (const platformFilter of ["iphonesimulator", "iphoneos"]) {
        const platformFiles = xctestrunFiles.filter(file => file.includes(platformFilter));
        if (platformFiles.length <= 1) {
          continue;
        }

        const withStats = await Promise.all(
          platformFiles.map(async file => {
            const filePath = path.join(productsDir, file);
            const stat = await fs.stat(filePath);
            return { file, filePath, mtime: stat.mtimeMs };
          })
        );
        withStats.sort((a, b) => b.mtime - a.mtime);

        // Delete all but the newest
        for (const stale of withStats.slice(1)) {
          logger.info(`[IOSCtrlProxyBuilder] Removing stale xctestrun file: ${stale.file}`);
          await fs.rm(stale.filePath);
        }
      }
    } catch (error) {
      logger.warn(`[IOSCtrlProxyBuilder] Failed to clean stale xctestrun files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if a download/extract is needed
   */
  public async needsRebuild(platform?: IOSCtrlProxyPlatform): Promise<boolean> {
    if (isTruthyEnvValue(process.env[SKIP_CTRL_PROXY_DOWNLOAD_ENV])) {
      logger.info(`[IOSCtrlProxyBuilder] Download skipped via ${SKIP_CTRL_PROXY_DOWNLOAD_ENV}`);
      return false;
    }

    // Fail closed here too: without this, an unknown explicit pin with a cached
    // bundle + metadata would return false and silently reuse the cached (possibly
    // wrong-version) runner without ever reaching verifyBundle's guard (#2746).
    this.assertPinnedVersionVerifiable();

    // A vendored bundle override must always be (re)consumed: otherwise, on a
    // reused host with an existing xctestrun + metadata, needsRebuild() would
    // return false and silently keep the stale cached runner instead of the
    // vendored IPA — the documented escape hatch would be a no-op (#2746).
    if (this.getBundlePathOverride() !== null) {
      logger.info("[IOSCtrlProxyBuilder] CtrlProxy bundle path override set, forcing extraction of the vendored bundle");
      return true;
    }

    const xctestrunPath = await this.getXctestrunPath(platform);
    if (!xctestrunPath) {
      logger.info("[IOSCtrlProxyBuilder] CtrlProxy artifacts missing, need download");
      return true;
    }

    const metadata = await this.readBundleMetadata();
    const expectedChecksum = this.getExpectedChecksum();
    if (expectedChecksum.length > 0) {
      if (!metadata || metadata.checksum?.toLowerCase() !== expectedChecksum.toLowerCase()) {
        logger.info("[IOSCtrlProxyBuilder] CtrlProxy checksum mismatch, need download");
        return true;
      }
    } else if (!metadata) {
      logger.info("[IOSCtrlProxyBuilder] CtrlProxy metadata missing, need download");
      return true;
    }

    if (platform) {
      const expectedAppHash = this.getExpectedAppHash(platform);
      if (expectedAppHash) {
        const localHash = await this.getAppBundleHash(platform);
        if (!localHash || localHash.toLowerCase() !== expectedAppHash.toLowerCase()) {
          logger.info("[IOSCtrlProxyBuilder] CtrlProxy app hash mismatch, need download");
          return true;
        }
        if (!metadata?.appHashes?.[platform]) {
          logger.info("[IOSCtrlProxyBuilder] CtrlProxy app hash missing from metadata, need download");
          return true;
        }
      }
    }

    logger.info("[IOSCtrlProxyBuilder] CtrlProxy artifacts are up to date");
    return false;
  }

  /**
   * Download and extract CtrlProxy release bundle
   */
  public async build(
    platform?: IOSCtrlProxyPlatform,
    perf: PerformanceTracker = new NoOpPerformanceTracker()
  ): Promise<CtrlProxyIosBuildResult> {
    perf.serial("xcTestServiceDownload");

    if (isTruthyEnvValue(process.env[SKIP_CTRL_PROXY_DOWNLOAD_ENV])) {
      perf.end();
      return {
        success: false,
        message: "CtrlProxy download skipped",
        error: `${SKIP_CTRL_PROXY_DOWNLOAD_ENV} is set`
      };
    }

    try {
      const { bundlePath, usedCachedFallback } = await perf.track("downloadBundle", () => this.ensureBundleDownloaded());
      if (!usedCachedFallback) {
        await perf.track("extractBundle", () => this.extractBundle(bundlePath));
      }

      // Clear cached paths to force rediscovery
      this.cachedBuildProductsPath.clear();
      this.cachedXctestrunPath.clear();
      this.cachedAppBundleHash.clear();

      await this.cleanStaleXctestrunFiles();

      const buildPath = await this.getBuildProductsPath(platform ?? "simulator");
      const xctestrunPath = await this.getXctestrunPath(platform);

      if (!xctestrunPath) {
        perf.end();
        return {
          success: false,
          message: "Downloaded CtrlProxy bundle missing xctestrun",
          error: "No .xctestrun file found after extraction"
        };
      }

      perf.end();
      return {
        success: true,
        message: "CtrlProxy downloaded and extracted successfully",
        buildPath: buildPath || undefined,
        xctestrunPath: xctestrunPath || undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[IOSCtrlProxyBuilder] Download failed:", errorMsg);

      perf.end();
      return {
        success: false,
        message: "CtrlProxy download failed",
        error: errorMsg,
      };
    }
  }

  /**
   * Prefetch download at startup (background, non-blocking)
   */
  public static prefetchBuild(): Promise<CtrlProxyIosBuildResult | null> {
    // Only run on macOS
    if (process.platform !== "darwin") {
      logger.info("[IOSCtrlProxyBuilder] Prefetch skipped (not macOS)");
      return Promise.resolve(null);
    }

    if (IOSCtrlProxyBuilder.prefetchPromise !== null) {
      logger.info("[IOSCtrlProxyBuilder] Prefetch already initiated, skipping");
      return IOSCtrlProxyBuilder.prefetchPromise;
    }

    logger.info("[IOSCtrlProxyBuilder] Starting download prefetch");
    const startTime = IOSCtrlProxyBuilder.timer.now();

    IOSCtrlProxyBuilder.prefetchPromise = IOSCtrlProxyBuilder.doPrefetch()
      .then(result => {
        const duration = IOSCtrlProxyBuilder.timer.now() - startTime;
        if (result && result.success) {
          IOSCtrlProxyBuilder.prefetchResult = result;
          logger.info(`[IOSCtrlProxyBuilder] Prefetch completed in ${duration}ms`, {
            buildPath: result.buildPath,
          });
        } else {
          logger.info(`[IOSCtrlProxyBuilder] Prefetch skipped or failed in ${duration}ms`, {
            message: result?.message,
          });
        }
        return result;
      })
      .catch(error => {
        const duration = IOSCtrlProxyBuilder.timer.now() - startTime;
        IOSCtrlProxyBuilder.prefetchError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`[IOSCtrlProxyBuilder] Prefetch failed after ${duration}ms`, {
          error: IOSCtrlProxyBuilder.prefetchError.message,
        });
        return null;
      });
    return IOSCtrlProxyBuilder.prefetchPromise;
  }

  /**
   * Internal prefetch implementation
   */
  private static async doPrefetch(): Promise<CtrlProxyIosBuildResult | null> {
    // Skip cleanly on hosts that cannot consume the runner. Without the Xcode
    // toolchain (xcrun/xcodebuild) the bundle can never be installed or run, so
    // there is no reason to download and extract it at startup (issue #4407).
    // Returning null (not throwing) keeps the daemon healthy and non-iOS
    // workflows intact; the on-demand build path still runs when a device connects.
    if (!(await IOSCtrlProxyBuilder.iosPrerequisiteDetector.hasIosPrerequisites())) {
      logger.info(
        "[IOSCtrlProxyBuilder] Prefetch skipped: iOS prerequisites (xcrun/xcodebuild) not detected; " +
        "the runner bundle is only needed for iOS device work"
      );
      return null;
    }

    const builder: PrefetchBuilder = IOSCtrlProxyBuilder.prefetchBuilderOverride ?? IOSCtrlProxyBuilder.getInstance();
    const needsDownload = await builder.needsRebuild();
    if (!needsDownload) {
      const buildPath = await builder.getBuildProductsPath();
      const xctestrunPath = await builder.getXctestrunPath();
      return {
        success: true,
        message: "CtrlProxy artifacts are up to date",
        buildPath: buildPath || undefined,
        xctestrunPath: xctestrunPath || undefined,
      };
    }

    return builder.build();
  }

  /**
   * Wait for prefetch to complete
   */
  public static async waitForPrefetch(): Promise<CtrlProxyIosBuildResult | null> {
    if (IOSCtrlProxyBuilder.prefetchPromise === null) {
      return null;
    }

    try {
      await IOSCtrlProxyBuilder.prefetchPromise;
      return IOSCtrlProxyBuilder.prefetchResult;
    } catch (error) {
      // Background prefetch already failed and recorded its error via getPrefetchError();
      // returning null here just means "no prefetched result", callers build on demand.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  /**
   * Get the prefetched build result (non-blocking)
   */
  public static getPrefetchedResult(): CtrlProxyIosBuildResult | null {
    return IOSCtrlProxyBuilder.prefetchResult;
  }

  /**
   * Check if prefetch had an error
   */
  public static getPrefetchError(): Error | null {
    return IOSCtrlProxyBuilder.prefetchError;
  }

  /**
   * Clean up build artifacts
   */
  public async cleanBuildArtifacts(): Promise<void> {
    try {
      await fs.rm(this.config.derivedDataPath, { recursive: true, force: true });
      this.cachedBuildProductsPath.clear();
      this.cachedXctestrunPath.clear();
      this.cachedAppBundleHash.clear();
      logger.info("[IOSCtrlProxyBuilder] Build artifacts cleaned up");
    } catch (error) {
      logger.warn("[IOSCtrlProxyBuilder] Failed to clean build artifacts:", error);
    }
  }

  /**
   * Get configuration for inspection
   */
  public getConfig(): CtrlProxyIosBuildConfig {
    return { ...this.config };
  }

  public async getAppBundlePath(platform: IOSCtrlProxyPlatform = "simulator"): Promise<string | null> {
    const buildPath = await this.getBuildProductsPath(platform);
    if (!buildPath) {
      return null;
    }
    const appPath = path.join(buildPath, "CtrlProxyApp.app");
    try {
      await fs.access(appPath);
      return appPath;
    } catch (error) {
      // App bundle isn't present in the build products dir; null signals "not built"
      // so callers can decide to (re)build instead of treating this as fatal.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  public async getAppBundleHash(platform: IOSCtrlProxyPlatform = "simulator"): Promise<string | null> {
    const cached = this.cachedAppBundleHash.get(platform);
    if (cached) {
      return cached;
    }
    const appPath = await this.getAppBundlePath(platform);
    if (!appPath) {
      return null;
    }
    try {
      const hash = await hashAppBundle(appPath);
      this.cachedAppBundleHash.set(platform, hash);
      return hash;
    } catch (error) {
      // Hashing the app bundle failed (e.g. bundle missing/unreadable); hash is only
      // used for compat checks, so null just skips that optimization.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  /** Get the executable represented by the selected release's runner checksum. */
  public async getRunnerBinaryPath(
    platform: IOSCtrlProxyPlatform = "simulator",
    target: RunnerSha256Target = this.getExpectedRunnerChecksumTarget()
  ): Promise<string | null> {
    const buildPath = await this.getBuildProductsPath(platform);
    if (!buildPath) {
      return null;
    }
    const runnerAppPath = path.join(buildPath, "CtrlProxyUITests-Runner.app");
    const runnerBinaryPath = target === "xctest"
      ? path.join(runnerAppPath, "PlugIns", "CtrlProxyUITests.xctest", "CtrlProxyUITests")
      : path.join(runnerAppPath, "CtrlProxyUITests-Runner");
    try {
      await fs.access(runnerBinaryPath);
      return runnerBinaryPath;
    } catch (error) {
      // Runner binary not present in the build products dir; null tells the caller
      // the UI test runner hasn't been built yet rather than throwing.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  private getBundlePath(): string {
    return path.join(this.config.bundleCacheDir, IOSCtrlProxyBuilder.DEFAULT_BUNDLE_FILENAME);
  }

  private getBundleUrl(): string {
    const override = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_URL?.trim();
    if (override) {
      return override;
    }
    return resolveIpaUrl();
  }

  private getBundlePathOverride(): string | null {
    const override = process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH?.trim()
      || process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH?.trim();
    return override && override.length > 0
      ? resolvePathFromDaemonLaunchWorkingDirectory(override)
      : null;
  }

  private getExpectedChecksum(): string {
    const override = IOSCtrlProxyBuilder.expectedChecksumOverride;
    if (override !== null) {
      return override;
    }
    return resolveIpaChecksum();
  }

  private getExpectedRunnerChecksum(): string {
    const override = IOSCtrlProxyBuilder.expectedRunnerChecksumOverride;
    if (override !== null) {
      return override;
    }
    return resolveRunnerChecksum();
  }

  private getExpectedRunnerChecksumTarget(): RunnerSha256Target {
    const override = IOSCtrlProxyBuilder.expectedRunnerChecksumTargetOverride;
    if (override !== null) {
      return override;
    }
    return resolveRunnerChecksumTarget();
  }

  public getExpectedAppHash(platform: IOSCtrlProxyPlatform): string {
    const envPlatform = platform.toUpperCase();
    // Check for platform-specific override first
    const platformOverride = process.env[`AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_${envPlatform}`];
    if (platformOverride && platformOverride.trim().length > 0) {
      return platformOverride.trim();
    }
    // For device platform, check generic overrides and the release constant (device build hash)
    if (platform === "device") {
      const genericOverride = process.env.AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH
        ?? process.env.AUTOMOBILE_IOS_IOS_CTRL_PROXY_APP_HASH;
      if (genericOverride && genericOverride.trim().length > 0) {
        return genericOverride.trim();
      }
      // IOS_CTRL_PROXY_APP_HASH is documented as the device build hash
      return IOS_CTRL_PROXY_APP_HASH;
    }
    // For simulator, only use platform-specific override (already checked above)
    // Skip verification if no simulator-specific hash is provided
    return "";
  }

  private async ensureBundleDownloaded(): Promise<{ bundlePath: string; usedCachedFallback: boolean }> {
    await ensureSecureDir(this.config.bundleCacheDir);
    const bundlePath = this.getBundlePath();

    const overridePath = this.getBundlePathOverride();
    if (overridePath) {
      logger.info("[IOSCtrlProxyBuilder] Using local CtrlProxy bundle override", { path: overridePath });
      const stats = await fs.stat(overridePath);
      if (!stats.isFile()) {
        throw new Error(`CtrlProxy bundle override is not a file: ${overridePath}`);
      }
      await fs.copyFile(overridePath, bundlePath);
    } else {
      const expectedChecksum = this.getExpectedChecksum();
      const bundleReady = await this.isBundleValid(bundlePath, expectedChecksum);

      if (!bundleReady) {
        // When a version is pinned (AUTOMOBILE_VERSION), hermetic mode disables the
        // silent cached-bundle fallback so a failed download fails hard (#2746).
        // resolvePinnedVersion already normalizes the `latest` sentinel.
        const isLatest = resolvePinnedVersion() === LATEST_RELEASE_VERSION;
        const cachedBundleExists = await this.isBundleValid(bundlePath, "");
        try {
          logger.info("[IOSCtrlProxyBuilder] Downloading CtrlProxy bundle", {
            url: this.getBundleUrl(),
            destination: bundlePath,
            reason: "checksum-mismatch-or-missing"
          });
          await this.downloader.download(this.getBundleUrl(), bundlePath);
        } catch (error) {
          if (isLatest && cachedBundleExists) {
            logger.warn(`[IOSCtrlProxyBuilder] Download failed, using cached bundle: ${error instanceof Error ? error.message : String(error)}`);
            return { bundlePath, usedCachedFallback: true };
          }
          throw error;
        }
      }
    }

    await this.verifyBundle(bundlePath);
    return { bundlePath, usedCachedFallback: false };
  }

  private async isBundleValid(bundlePath: string, expectedChecksum: string): Promise<boolean> {
    try {
      const stats = await fs.stat(bundlePath);
      if (!stats.isFile() || stats.size < IOSCtrlProxyBuilder.MIN_BUNDLE_SIZE_BYTES) {
        return false;
      }
    } catch (error) {
      // fs.stat failed because the cached bundle file doesn't exist (or isn't
      // readable); treat it as invalid so the caller re-downloads it.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return false;
    }

    if (!expectedChecksum) {
      return true;
    }

    const { checksum } = await this.downloader.computeFileSha256(bundlePath);
    return checksum.toLowerCase() === expectedChecksum.toLowerCase();
  }

  private async verifyBundle(bundlePath: string): Promise<void> {
    const stats = await fs.stat(bundlePath);
    if (stats.size < IOSCtrlProxyBuilder.MIN_BUNDLE_SIZE_BYTES) {
      throw new Error(`Downloaded bundle is too small (${stats.size} bytes), likely invalid`);
    }

    const expectedChecksum = this.getExpectedChecksum();
    if (expectedChecksum.length > 0) {
      const { checksum, source } = await this.downloader.computeFileSha256(bundlePath);
      if (checksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
        throw new Error(`CtrlProxy checksum verification failed. Expected: ${expectedChecksum}, Got: ${checksum}`);
      }
      logger.info("[IOSCtrlProxyBuilder] Bundle checksum verified", { checksum, source });
    } else {
      this.assertPinnedVersionVerifiable();
      logger.warn("[IOSCtrlProxyBuilder] Bundle checksum verification skipped (no checksum provided)");
    }
  }

  /**
   * Fail closed when a concrete `AUTOMOBILE_VERSION` is pinned to a version absent
   * from the baked checksum registry: the bundle cannot be integrity-verified, so
   * silently downloading or reusing it defeats the point of pinning (#2746). A
   * vendored bundle (`AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`) or an explicit checksum
   * override is the trusted escape hatch.
   */
  private assertPinnedVersionVerifiable(): void {
    if (IOSCtrlProxyBuilder.isPinnedVersionUnverifiable()) {
      throw new ActionableError(
        `AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the AutoMobile release ` +
        `checksum registry, so the CtrlProxy bundle cannot be integrity-verified. ` +
        `Pin a released version, or vendor a trusted bundle via AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH.`
      );
    }
  }

  /**
   * Single source of truth for the iOS fail-closed decision: `AUTOMOBILE_VERSION`
   * names a concrete version absent from the checksum registry, with no escape hatch
   * (vendored IPA/bundle path or explicit checksum override), so the CtrlProxy bundle
   * cannot be integrity-verified (#2746). Reused by the build/reuse guards,
   * `IOSCtrlProxyManager.setup()`, `doctor --ios`, and the booted-device compat check.
   */
  static isPinnedVersionUnverifiable(): boolean {
    if (IOSCtrlProxyBuilder.expectedChecksumOverride !== null) {
      return false;
    }
    const ipaPath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH?.trim();
    const bundlePath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH?.trim();
    if ((ipaPath && ipaPath.length > 0) || (bundlePath && bundlePath.length > 0)) {
      return false;
    }
    return isExplicitPin() && !isPinnedVersionKnown();
  }

  private async extractBundle(bundlePath: string): Promise<void> {
    // Fail closed before wiping/repopulating the tree if it is owned by another
    // uid — extracting into a directory we do not own reopens the TOCTOU window
    // this hardening closes (issue #4759).
    await this.assertDerivedDataDirOwnedByCurrentUid();
    await this.downloader.extractBundle(bundlePath, this.config.derivedDataPath);
    // Authoritatively restrict the extraction tree to owner-only (0o700),
    // independent of the downloader implementation: the runner is launched from
    // here, so other uids must not be able to read or swap its binaries (#4759).
    await ensureSecureDir(this.config.derivedDataPath);
    await this.normalizeExtractedBundle();
    await this.verifyExtractedArtifacts();

    const appHashes = await this.computeAppHashes();
    const metadata: IOSCtrlProxyBundleMetadata = {
      checksum: this.getExpectedChecksum() || null,
      version: resolveAssetVersion(resolvePinnedVersion()),
      extractedAt: new Date().toISOString(),
      appHashes
    };
    await fs.writeFile(this.getMetadataPath(), JSON.stringify(metadata, null, 2), "utf-8");
  }

  private async readBundleMetadata(): Promise<IOSCtrlProxyBundleMetadata | null> {
    try {
      const raw = await fs.readFile(this.getMetadataPath(), "utf-8");
      return JSON.parse(raw) as IOSCtrlProxyBundleMetadata;
    } catch (error) {
      // Metadata file is missing or its JSON is malformed/stale; null just means
      // "no cached metadata", so the caller recomputes it from the bundle.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  private getMetadataPath(): string {
    return path.join(this.config.bundleCacheDir, IOSCtrlProxyBuilder.METADATA_FILENAME);
  }

  private async normalizeExtractedBundle(): Promise<void> {
    const xctestrunFiles = await this.findXctestrunFiles(this.config.derivedDataPath);
    if (xctestrunFiles.length === 0) {
      throw new Error("No .xctestrun file found in extracted CtrlProxy bundle");
    }

    const derivedRoot = this.resolveDerivedDataRoot(xctestrunFiles[0]);
    if (!derivedRoot) {
      return;
    }

    if (derivedRoot === this.config.derivedDataPath) {
      return;
    }

    const sourceBuildDir = path.join(derivedRoot, "Build");
    const targetBuildDir = path.join(this.config.derivedDataPath, "Build");

    await fs.rm(targetBuildDir, { recursive: true, force: true });
    await ensureSecureDir(this.config.derivedDataPath);

    try {
      await fs.rename(sourceBuildDir, targetBuildDir);
    } catch {
      await fs.cp(sourceBuildDir, targetBuildDir, { recursive: true });
      await fs.rm(sourceBuildDir, { recursive: true, force: true });
    }
  }

  private async verifyExtractedArtifacts(): Promise<void> {
    const simXctestrun = await this.getXctestrunPath("simulator");
    const deviceXctestrun = await this.getXctestrunPath("device");

    if (!simXctestrun && !deviceXctestrun) {
      throw new Error("Extracted CtrlProxy bundle missing .xctestrun file");
    }

    if (simXctestrun) {
      await this.verifyPlatformArtifacts("simulator");
    }

    if (deviceXctestrun) {
      await this.verifyPlatformArtifacts("device");
    }
  }

  private async verifyPlatformArtifacts(platform: IOSCtrlProxyPlatform): Promise<void> {
    const buildDir = await this.getBuildProductsPath(platform);
    if (!buildDir) {
      throw new Error(`CtrlProxy build products missing for ${platform}`);
    }

    const requiredPaths = [
      path.join(buildDir, "CtrlProxyApp.app"),
      path.join(buildDir, "CtrlProxyUITests-Runner.app"),
      path.join(buildDir, "CtrlProxyTests.xctest")
    ];

    for (const requiredPath of requiredPaths) {
      try {
        await fs.access(requiredPath);
      } catch {
        throw new Error(`CtrlProxy bundle missing required artifact: ${requiredPath}`);
      }
    }

    const expectedAppHash = this.getExpectedAppHash(platform);
    if (expectedAppHash) {
      const localHash = await this.getAppBundleHash(platform);
      if (!localHash) {
        throw new Error(`CtrlProxy app hash unavailable for ${platform}`);
      }
      if (localHash.toLowerCase() !== expectedAppHash.toLowerCase()) {
        throw new Error(`CtrlProxy app hash mismatch for ${platform}. Expected: ${expectedAppHash}, Got: ${localHash}`);
      }
      logger.info("[IOSCtrlProxyBuilder] App bundle hash verified", { platform, hash: localHash });
    } else {
      logger.warn(`[IOSCtrlProxyBuilder] App bundle hash verification skipped for ${platform} (no hash provided)`);
    }

    // Verify the release-selected runner executable SHA256 for simulator.
    if (platform === "simulator") {
      await this.assertRunnerBinaryHash(platform, "post-extract");
    }
  }

  /**
   * Verify the runner executable's SHA256 against the release-selected expected
   * hash. Shared by the post-extract check and the pre-launch re-verification
   * (issue #4759). A no-op when no expected hash is configured (mirrors the prior
   * skip-with-warning behavior); throws {@link ActionableError} on mismatch so the
   * caller fails closed rather than launching a tampered binary.
   *
   * @param phase - which verification window this is, for log/error context.
   */
  private async assertRunnerBinaryHash(
    platform: IOSCtrlProxyPlatform,
    phase: "post-extract" | "pre-launch"
  ): Promise<void> {
    const expectedRunnerSha256 = this.getExpectedRunnerChecksum();
    if (!expectedRunnerSha256 || expectedRunnerSha256.length === 0) {
      logger.warn(`[IOSCtrlProxyBuilder] Runner binary SHA256 verification skipped for ${platform} (no hash provided)`);
      return;
    }
    const runnerChecksumTarget = this.getExpectedRunnerChecksumTarget();
    const runnerBinaryPath = await this.getRunnerBinaryPath(platform, runnerChecksumTarget);
    if (!runnerBinaryPath) {
      throw new ActionableError(`CtrlProxy runner binary missing for ${platform}`);
    }
    const { checksum } = await this.downloader.computeFileSha256(runnerBinaryPath);
    if (checksum.toLowerCase() !== expectedRunnerSha256.toLowerCase()) {
      throw new ActionableError(
        `CtrlProxy runner binary SHA256 mismatch (${phase}) for ${platform}. ` +
        `Expected: ${expectedRunnerSha256}, Got: ${checksum}. Refusing to launch a runner whose ` +
        `binary changed since it was verified (possible TOCTOU tampering).`
      );
    }
    logger.info(`[IOSCtrlProxyBuilder] Runner binary SHA256 verified (${phase})`, { platform, checksum });
  }

  /**
   * Re-verify the runner binary hash and derived-data ownership IMMEDIATELY
   * before launch (issue #4759). Post-extract verification alone leaves a
   * verify→execute window in which a local attacker on a shared host can swap the
   * runner/xctest binary before `xcodebuild test-without-building` runs it.
   * {@link IOSCtrlProxyManager} calls this right before spawning the runner to
   * close that window. Fails closed (throws {@link ActionableError}) on a foreign
   * uid or a hash mismatch.
   */
  public async verifyRunnerBinaryBeforeLaunch(platform: IOSCtrlProxyPlatform): Promise<void> {
    await this.assertDerivedDataDirOwnedByCurrentUid();
    await this.assertRunnerBinaryHash(platform, "pre-launch");
    await this.verifyRunnerCodesign(platform);
  }

  /**
   * Second integrity control before launching the downloaded helper (issue
   * #4760): run `codesign --verify --deep --strict` (and `spctl --assess` for
   * notarization) against the extracted runner app, composing with — not
   * replacing — the #4759 SHA-256 re-verification above.
   *
   * DEFAULT = WARN: a verify failure, a failed notarization assess, or a
   * Team-ID mismatch is logged at WARN and launch proceeds. Hard-refusing by
   * default would break dev / self-built / unsigned local helpers and requires a
   * pinned Apple Team ID we do not ship. Flip to fail-closed with
   * {@link IOS_HELPER_REQUIRE_CODESIGN_ENV}=1; pin a Team ID with
   * {@link IOS_HELPER_TEAM_ID_ENV}.
   *
   * macOS-only: `codesign`/`spctl` do not exist on other platforms and the
   * simulator does not OS-enforce signing, so this no-ops off darwin (the exec
   * seam is never invoked) — mirroring {@link assertDerivedDataDirOwnedByCurrentUid}.
   */
  private async verifyRunnerCodesign(platform: IOSCtrlProxyPlatform): Promise<void> {
    if (process.platform !== "darwin") {
      logger.debug(`[IOSCtrlProxyBuilder] codesign verification skipped on ${process.platform} (macOS-only)`);
      return;
    }

    const appPath = await this.getRunnerAppPath(platform);
    if (!appPath) {
      logger.warn(`[IOSCtrlProxyBuilder] Runner app bundle missing for ${platform}; skipping codesign verification`);
      return;
    }

    const requireCodesign = isTruthyEnvValue(process.env[IOS_HELPER_REQUIRE_CODESIGN_ENV]);
    const pinnedTeamId = process.env[IOS_HELPER_TEAM_ID_ENV]?.trim() || null;

    let outcome: CodesignVerificationOutcome;
    try {
      outcome = await IOSCtrlProxyBuilder.codesignVerifier.verifyAppBundle(appPath);
    } catch (error) {
      // The codesign/spctl tools themselves errored (e.g. not installed). Treat
      // as a non-fatal warning by default so a broken toolchain does not block
      // launch; fail closed only when the operator opted in.
      const message = `Code-signing verification could not run for the ${platform} runner: ` +
        `${error instanceof Error ? error.message : String(error)}`;
      this.applyCodesignPolicy(message, requireCodesign, error);
      return;
    }

    const problems = collectCodesignProblems(outcome, pinnedTeamId);
    if (problems.length === 0) {
      logger.info("[IOSCtrlProxyBuilder] Runner codesign verified", {
        platform,
        teamId: outcome.teamId,
        notarized: outcome.notarized,
      });
      return;
    }

    const summary = `Code-signing verification issues for the ${platform} runner: ${problems.join("; ")}.` +
      (outcome.detail ? ` (${outcome.detail})` : "");
    this.applyCodesignPolicy(summary, requireCodesign);
  }

  /**
   * Apply the warn-vs-refuse policy for a code-signing problem (issue #4760).
   * DEFAULT = warn-and-proceed; refuse (throw {@link ActionableError}) only when
   * {@link IOS_HELPER_REQUIRE_CODESIGN_ENV} opts into fail-closed.
   */
  private applyCodesignPolicy(summary: string, requireCodesign: boolean, cause?: unknown): void {
    if (requireCodesign) {
      throw new ActionableError(
        `${summary} Refusing to launch because ${IOS_HELPER_REQUIRE_CODESIGN_ENV} is set.`
      );
    }
    logger.warn(
      `[IOSCtrlProxyBuilder] ${summary} Proceeding anyway — code signing is not OS-enforced on the ` +
      `simulator, and the #4759 SHA-256 check already covers integrity. Set ` +
      `${IOS_HELPER_REQUIRE_CODESIGN_ENV}=1 to refuse launch, and ${IOS_HELPER_TEAM_ID_ENV} to pin a Team ID.`,
      cause
    );
  }

  /** Path to the extracted runner `.app` bundle codesign verifies (issue #4760). */
  public async getRunnerAppPath(platform: IOSCtrlProxyPlatform = "simulator"): Promise<string | null> {
    const buildPath = await this.getBuildProductsPath(platform);
    if (!buildPath) {
      return null;
    }
    const runnerAppPath = path.join(buildPath, "CtrlProxyUITests-Runner.app");
    try {
      await fs.access(runnerAppPath);
      return runnerAppPath;
    } catch (error) {
      // Runner app not present yet (not built/extracted); null lets the caller
      // skip codesign rather than treating a missing bundle as a hard failure.
      logger.debug(`src/utils/IOSCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  /**
   * Fail closed (issue #4759) when the derived-data directory already exists but
   * is owned by a different uid. On a shared host another user could pre-seed the
   * directory (the old `/tmp` default was world-writable and predictable) and swap
   * the runner/xctest binaries out from under our integrity check. Reusing a
   * directory we do not own reopens that TOCTOU window, so we refuse to extract
   * into or launch from it.
   *
   * POSIX-only: Windows has no `st_uid`/`process.getuid`, so the check no-ops
   * there — access control on Windows is via ACLs, outside the scope of these
   * bits (matching {@link ensureSecureDir}'s cross-platform contract).
   */
  private async assertDerivedDataDirOwnedByCurrentUid(): Promise<void> {
    const getuid = process.getuid?.bind(process);
    if (process.platform === "win32" || !getuid) {
      return;
    }
    let stats;
    try {
      stats = await fs.stat(this.config.derivedDataPath);
    } catch (error) {
      // Directory does not exist yet (first extraction) — nothing to refuse. Any
      // other stat error is treated the same: the create step that follows will
      // surface a real failure with a clearer message.
      logger.debug(`[IOSCtrlProxyBuilder] derived-data stat failed (treated as absent): ${error}`, error);
      return;
    }
    const currentUid = getuid();
    if (stats.uid !== currentUid) {
      throw new ActionableError(
        `Refusing to reuse CtrlProxy derived-data directory ${this.config.derivedDataPath}: it is ` +
        `owned by uid ${stats.uid}, not the current uid ${currentUid}. Another user may have pre-seeded ` +
        `or tampered with it. Delete it, or set AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA to a directory you own.`
      );
    }
  }

  private async computeAppHashes(): Promise<Partial<Record<IOSCtrlProxyPlatform, string>>> {
    const hashes: Partial<Record<IOSCtrlProxyPlatform, string>> = {};
    const simulatorHash = await this.getAppBundleHash("simulator");
    if (simulatorHash) {
      hashes.simulator = simulatorHash;
    }
    const deviceHash = await this.getAppBundleHash("device");
    if (deviceHash) {
      hashes.device = deviceHash;
    }
    return hashes;
  }

  private resolveDerivedDataRoot(xctestrunPath: string): string | null {
    const segments = path.resolve(xctestrunPath).split(path.sep);
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i] === "Build" && segments[i + 1] === "Products") {
        return segments.slice(0, i).join(path.sep);
      }
    }
    return null;
  }

  private async findXctestrunFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    const stack: string[] = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".xctestrun")) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }
}
