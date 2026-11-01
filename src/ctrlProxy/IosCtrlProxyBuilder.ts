import { Mutex } from "async-mutex";
import { IosRunnerArtifactVerifier } from "./IosRunnerArtifactVerifier";
import { extractIosCtrlProxyBundle } from "./IosCtrlProxyBundleExtraction";
import { errorMessage } from "../utils/describeUnknownError";
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { SingleFlight } from "../utils/cache/SingleFlight";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../utils/PerformanceTracker";
import {
  LATEST_RELEASE_VERSION,
  assertHttpsAssetUrl,
  isExplicitPin,
  isPinnedVersionKnown,
  resolveIpaUrl,
  resolvePinnedVersion,
  type RunnerSha256Target,
} from "../constants/release";
import {
  DefaultIOSCtrlProxyBundleDownloader,
  type CtrlProxyIosBundleDownloader,
} from "../utils/IOSCtrlProxyBundleDownloader";
import { defaultIdGenerator } from "../utils/IdGenerator";
import { IosCtrlProxyPrefetcher } from "./IosCtrlProxyPrefetcher";
import { VerifiedArtifactCache } from "../utils/VerifiedArtifactCache";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { getSharedAutoMobileDir, getTempDir } from "../utils/tempDir";
import { ensureSecureDir } from "../utils/filesystem/securePermissions";
import {
  buildPlist,
  injectUITestEnvironment,
  parsePlist,
  type PlistValue,
} from "../utils/ios-cmdline-tools/XctestrunPlist";
import { toActionableError } from "../models/ActionableError";
import { SKIP_CTRL_PROXY_DOWNLOAD_ENV } from "../utils/ctrlProxyDownloadControl";
import {
  type IosPrerequisiteDetector,
  DefaultIosPrerequisiteDetector,
} from "../utils/ios-cmdline-tools/IosPrerequisiteDetector";
import {
  type CtrlProxyCodesignVerifier,
  DefaultCtrlProxyCodesignVerifier,
} from "../utils/ios-cmdline-tools/CtrlProxyCodesignVerifier";
import { sortedReaddir } from "../utils/io";
import { ENV, readEnvBool, readEnvRaw, readEnvTrimmed } from "../config/env";

export {
  IOS_CTRL_PROXY_RUNNER_SHA256_ENV,
  IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV,
} from "./IosRunnerArtifactVerifier";

/**
 * Result of CtrlProxy download/install
 */
export interface CtrlProxyIosBuildResult {
  success: boolean;
  message: string;
  buildPath?: string; // Path to build products
  xctestrunPath?: string; // Path to .xctestrun file
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

/** Process-wide collaborators and overrides; see {@link IosCtrlProxyBuilder.configure}. */
export interface IosCtrlProxyBuilderSettings {
  /** Expected IPA checksum; null resolves it from the release registry. */
  expectedChecksum: string | null;
  /** Expected runner checksum; null resolves it from the environment or registry. */
  expectedRunnerChecksum: string | null;
  expectedRunnerChecksumTarget: RunnerSha256Target | null;
  /** Local-build switch (#5561); null reads the environment variable. */
  useLocalBuild: boolean | null;
  /** Pre-launch codesign/notarization gate (#4760). */
  codesignVerifier: CtrlProxyCodesignVerifier;
  timer: Timer;
  /** Gate that skips the startup prefetch without a usable Xcode toolchain (#4407). */
  prerequisiteDetector: IosPrerequisiteDetector;
  /** Builder the startup prefetch drives; null uses `getInstance()`. */
  prefetchBuilder: PrefetchBuilder | null;
}

/**
 * The narrow builder surface {@link IosCtrlProxyPrefetcher} drives.
 * Exposed so the prefetch gate can be tested without a real build/download
 * (issue #4407); grow it only when the prefetch needs another method.
 */
export type PrefetchBuilder = Pick<
  IosCtrlProxyBuilder,
  "needsRebuild" | "getBuildProductsPath" | "getXctestrunPath" | "build"
>;

type IOSCtrlProxyPlatform = "simulator" | "device";

/**
 * CtrlProxy Builder
 * Handles release bundle download and extraction for CtrlProxy
 */
export class IosCtrlProxyBuilder {
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
  private static readonly DEFAULT_SCHEME = "AutoMobileTest";
  private static readonly DEFAULT_DESTINATION = "generic/platform=iOS Simulator";
  private static readonly DEFAULT_BUNDLE_CACHE_SUBDIR = "ctrl-proxy-ios";

  // Process-wide collaborators and policy overrides, injected as one settings object (tests,
  // or a host that owns its lifecycle) instead of one mutable static per seam. Read lazily at
  // each use so `configure()` always applies.
  private static settings: IosCtrlProxyBuilderSettings = IosCtrlProxyBuilder.defaultSettings();

  // The process-wide startup prefetch (single flight, result, error). Its collaborators are
  // read from `settings` lazily, so overrides keep applying.
  private static readonly prefetcher = new IosCtrlProxyPrefetcher({
    timer: { now: () => IosCtrlProxyBuilder.settings.timer.now() },
    prerequisiteDetector: {
      hasIosPrerequisites: () =>
        IosCtrlProxyBuilder.settings.prerequisiteDetector.hasIosPrerequisites(),
    },
    builder: () =>
      IosCtrlProxyBuilder.settings.prefetchBuilder ?? IosCtrlProxyBuilder.getInstance(),
  });

  // Singleton instances per configuration
  private static instances: Map<string, IosCtrlProxyBuilder> = new Map();

  private readonly config: CtrlProxyIosBuildConfig;
  private readonly downloader: CtrlProxyIosBundleDownloader;
  private readonly artifactCache: VerifiedArtifactCache;
  private readonly artifactVerifier: IosRunnerArtifactVerifier;
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
   * Single-flight guard for {@link build}. `IosCtrlProxyBuilder` is a
   * process-wide singleton shared by every `IOSCtrlProxyManager` device
   * instance (issue #6417): with no in-flight guard, two devices whose
   * `needsRebuild()` both observe `true` before either has finished would
   * each independently download-then-extract into the same
   * `derivedDataPath`, and the second extraction's destructive
   * `fs.rm(destination, { recursive: true, force: true })` (see
   * `IOSCtrlProxyBundleDownloader.extractBundle`) would wipe out the tree the
   * first just populated. Mirrors the existing static `prefetchPromise` idiom
   * below, but scoped per-instance since `build()` is an instance method.
   *
   * The flight is owned by the builder, not by the first caller (#10200): it runs
   * under a flight-scoped signal that aborts only when no waiter is left, and each
   * waiter stops waiting on its own signal without cancelling the download for the
   * others. `buildInFlight` is the flight's own promise, retained after it settles
   * until every waiter has resolved its platform paths.
   */
  private buildInFlight: Promise<CtrlProxyIosBuildResult> | null = null;
  private buildWaiters = 0;
  private readonly derivedDataLock = new Mutex();
  private readonly buildFlights = new SingleFlight<"build", CtrlProxyIosBuildResult>();
  // Settles when the latest flight has wound down, so a flight started after every
  // waiter abandoned its predecessor never overlaps that one's remaining work.
  private buildSettled: Promise<void> = Promise.resolve();

  private constructor(
    config: Partial<CtrlProxyIosBuildConfig> = {},
    dependencies: CtrlProxyIosBuilderDependencies = {},
  ) {
    this.config = {
      projectRoot:
        config.projectRoot ||
        readEnvRaw(ENV.PROJECT_ROOT) ||
        IosCtrlProxyBuilder.DEFAULT_PROJECT_ROOT,
      derivedDataPath:
        config.derivedDataPath ||
        readEnvRaw(ENV.CTRL_PROXY_IOS_DERIVED_DATA) ||
        getTempDir(IosCtrlProxyBuilder.DEFAULT_DERIVED_DATA_SUBDIR),
      scheme: config.scheme || IosCtrlProxyBuilder.DEFAULT_SCHEME,
      destination: config.destination || IosCtrlProxyBuilder.DEFAULT_DESTINATION,
      bundleCacheDir:
        config.bundleCacheDir ||
        readEnvRaw(ENV.CTRL_PROXY_IOS_CACHE_DIR) ||
        // Shared downloaded bundle cache stays coordinated across data dirs.
        // AUTOMOBILE_COORDINATION_DIR relocates it; the cache-specific variable
        // above can relocate it independently.
        getSharedAutoMobileDir(IosCtrlProxyBuilder.DEFAULT_BUNDLE_CACHE_SUBDIR),
    };
    this.downloader = dependencies.downloader ?? new DefaultIOSCtrlProxyBundleDownloader();
    // Adapters read `this.downloader` lazily so the cache always uses the injected seam.
    this.artifactCache = new VerifiedArtifactCache({
      downloader: { download: (url, destination) => this.downloader.download(url, destination) },
      checksumCalculator: {
        computeFileSha256: (filePath) => this.downloader.computeFileSha256(filePath),
      },
    });
    this.artifactVerifier = new IosRunnerArtifactVerifier({
      derivedDataPath: this.config.derivedDataPath,
      bundleCacheDir: this.config.bundleCacheDir,
      computeFileSha256: (filePath) => this.downloader.computeFileSha256(filePath),
      getSettings: () => IosCtrlProxyBuilder.settings,
      isPinnedVersionUnverifiable: () => IosCtrlProxyBuilder.isPinnedVersionUnverifiable(),
      hasPendingPrefetch: () => IosCtrlProxyBuilder.pendingPrefetch() !== null,
      getBuildProductsPath: (platform) => this.getBuildProductsPath(platform),
      getXctestrunPath: (platform) => this.getXctestrunPath(platform),
      getAppBundlePath: (platform) => this.getAppBundlePath(platform),
      getAppBundleHash: (platform) => this.getAppBundleHash(platform),
      getExpectedAppHash: (platform) => this.getExpectedAppHash(platform),
      findXctestrunFiles: (root) => this.findXctestrunFiles(root),
      getRunnerBinaryPath: (platform, target) => this.getRunnerBinaryPath(platform, target),
      getRunnerAppPath: (platform) => this.getRunnerAppPath(platform),
      getBundlePathOverride: () => this.getBundlePathOverride(),
      isLocalBuildMode: () => this.isLocalBuildMode(),
      verifyPlatformArtifacts: (platform) => this.verifyPlatformArtifacts(platform),
      invalidateCachedBundle: () => this.invalidateCachedBundle(),
      build: (platform) => this.build(platform),
    });
  }

  /**
   * Get singleton instance for default configuration
   */
  public static getInstance(
    config?: Partial<CtrlProxyIosBuildConfig>,
    dependencies?: CtrlProxyIosBuilderDependencies,
  ): IosCtrlProxyBuilder {
    const key = JSON.stringify({
      config: config || {},
      deps: dependencies?.downloader ? "custom" : "default",
    });
    if (!IosCtrlProxyBuilder.instances.has(key)) {
      IosCtrlProxyBuilder.instances.set(key, new IosCtrlProxyBuilder(config, dependencies));
    }
    return IosCtrlProxyBuilder.instances.get(key)!;
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    IosCtrlProxyBuilder.instances.clear();
    IosCtrlProxyBuilder.prefetcher.reset();
    IosCtrlProxyBuilder.settings = IosCtrlProxyBuilder.defaultSettings();
  }

  /** Fresh defaults: no overrides, real timer, real detector and codesign verifier. */
  private static defaultSettings(): IosCtrlProxyBuilderSettings {
    return {
      expectedChecksum: null,
      expectedRunnerChecksum: null,
      expectedRunnerChecksumTarget: null,
      useLocalBuild: null,
      codesignVerifier: new DefaultCtrlProxyCodesignVerifier(),
      timer: defaultTimer,
      prerequisiteDetector: new DefaultIosPrerequisiteDetector(),
      prefetchBuilder: null,
    };
  }

  /**
   * Inject collaborators and policy overrides for every builder in this process. Only the
   * given keys change (they merge over the current settings); `null` restores the defaults,
   * as does {@link resetInstances}. Because it merges, setting `expectedRunnerChecksum` alone
   * keeps any earlier `expectedRunnerChecksumTarget`; pass the target explicitly to change it.
   * Replaces one static `…ForTesting` setter per seam.
   */
  public static configure(overrides: Partial<IosCtrlProxyBuilderSettings> | null): void {
    IosCtrlProxyBuilder.settings =
      overrides === null
        ? IosCtrlProxyBuilder.defaultSettings()
        : { ...IosCtrlProxyBuilder.settings, ...overrides };
  }

  /**
   * Get the build products directory path
   */
  public async getBuildProductsPath(
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<string | null> {
    const cachedPath = this.cachedBuildProductsPath.get(platform);
    if (cachedPath) {
      try {
        await fs.access(cachedPath);
        return cachedPath;
      } catch (error) {
        // Cached artifacts may have been removed; rediscovery safely replaces the stale path.
        logger.debug(`Cached build products probe failed: ${errorMessage(error)}`, error);
        this.cachedBuildProductsPath.set(platform, null);
      }
    }

    const buildDir = path.join(
      this.config.derivedDataPath,
      "Build",
      "Products",
      platform === "device" ? "Debug-iphoneos" : "Debug-iphonesimulator",
    );

    try {
      await fs.access(buildDir);
      this.cachedBuildProductsPath.set(platform, buildDir);
      return buildDir;
    } catch (error) {
      // Build products directory doesn't exist yet (no build has run); null tells the
      // caller to trigger a build rather than treating this as a hard failure.
      logger.debug(`src/ctrlProxy/IosCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  /**
   * Get the .xctestrun file path
   */
  public async getXctestrunPath(
    platform?: IOSCtrlProxyPlatform | "watchSimulator",
  ): Promise<string | null> {
    // Local discovery/prefetch follows the simulator default of build-product paths.
    platform ??= this.isLocalBuildMode() ? "simulator" : undefined;
    const cacheKey = platform || "any";
    const cachedPath = this.cachedXctestrunPath.get(cacheKey);
    // Local rebuilds can leave the old xctestrun alongside a newer filename.
    if (cachedPath && !this.isLocalBuildMode()) {
      try {
        await fs.access(cachedPath);
        return cachedPath;
      } catch (error) {
        // Cached artifacts may have been removed; rediscovery safely replaces the stale path.
        logger.debug(`Cached xctestrun probe failed: ${errorMessage(error)}`, error);
        this.cachedXctestrunPath.set(cacheKey, null);
      }
    }

    const productsDir = path.join(this.config.derivedDataPath, "Build", "Products");
    try {
      const files = await sortedReaddir(productsDir);
      const xctestrunFiles = files.filter(
        (file) =>
          file.endsWith(".xctestrun") &&
          !file.startsWith(IosCtrlProxyBuilder.RUNNER_XCTESTRUN_PREFIX),
      );
      if (xctestrunFiles.length === 0) {
        return null;
      }

      // The release-mode default remains iOS-only even when local watch products share this dir.
      const platformFilter = {
        device: "iphoneos",
        simulator: "iphonesimulator",
        watchSimulator: "watchsimulator",
        any: "",
      }[cacheKey];
      const candidates = xctestrunFiles.filter(
        (file) =>
          file.includes(platformFilter) &&
          (platform === "watchSimulator" || !file.includes("watchsimulator")),
      );

      if (candidates.length === 0) {
        return null;
      }

      // When multiple xctestrun files exist, prefer the newest by modification time
      let selected: string;
      if (candidates.length === 1) {
        selected = candidates[0];
      } else {
        const withStats = await Promise.all(
          candidates.map(async (file) => {
            const filePath = path.join(productsDir, file);
            const stat = await fs.stat(filePath);
            return { file, mtime: stat.mtimeMs };
          }),
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
      logger.debug(`src/ctrlProxy/IosCtrlProxyBuilder.ts fallback failed: ${error}`, error);
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
    deviceId: string,
  ): Promise<string> {
    try {
      const xml = await fs.readFile(xctestrunPath, "utf-8");
      const root = await parsePlist(xml);
      if (!(root instanceof Map)) {
        throw new Error("xctestrun root is not a plist dictionary");
      }

      const injected = injectUITestEnvironment(root as Map<string, PlistValue>, env);
      if (injected === 0) {
        const metadata = (root as Map<string, PlistValue>).get("__xctestrun_metadata__");
        const formatVersion = metadata instanceof Map ? metadata.get("FormatVersion") : undefined;
        const observedFormat = formatVersion === undefined ? "unknown" : String(formatVersion);
        throw new Error(
          `xctestrun contains no UI-test bundle (IsUITestBundle) to receive the runner ` +
            `environment (observed __xctestrun_metadata__.FormatVersion: ${observedFormat})`,
        );
      }

      const safeDeviceId = deviceId.replace(/[^A-Za-z0-9._-]/g, "_") || "device";
      const outputPath = path.join(
        path.dirname(xctestrunPath),
        `${IosCtrlProxyBuilder.RUNNER_XCTESTRUN_PREFIX}${safeDeviceId}.xctestrun`,
      );
      await fs.writeFile(outputPath, buildPlist(root), "utf-8");
      logger.info(
        `[IOSCtrlProxyBuilder] Wrote runner xctestrun with injected environment to ${outputPath}`,
      );
      return outputPath;
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to inject runner environment into xctestrun at ${xctestrunPath}`,
      );
    }
  }

  /**
   * Remove stale xctestrun files, keeping only the newest per platform.
   */
  public async cleanStaleXctestrunFiles(): Promise<void> {
    const productsDir = path.join(this.config.derivedDataPath, "Build", "Products");
    try {
      const files = await sortedReaddir(productsDir);
      const xctestrunFiles = files.filter(
        (file) =>
          file.endsWith(".xctestrun") &&
          !file.startsWith(IosCtrlProxyBuilder.RUNNER_XCTESTRUN_PREFIX),
      );
      if (xctestrunFiles.length <= 1) {
        return;
      }

      for (const platformFilter of ["iphonesimulator", "iphoneos"]) {
        const platformFiles = xctestrunFiles.filter((file) => file.includes(platformFilter));
        if (platformFiles.length <= 1) {
          continue;
        }

        const withStats = await Promise.all(
          platformFiles.map(async (file) => {
            const filePath = path.join(productsDir, file);
            const stat = await fs.stat(filePath);
            return { file, filePath, mtime: stat.mtimeMs };
          }),
        );
        withStats.sort((a, b) => b.mtime - a.mtime);

        // Delete all but the newest
        for (const stale of withStats.slice(1)) {
          logger.info(`[IOSCtrlProxyBuilder] Removing stale xctestrun file: ${stale.file}`);
          await fs.rm(stale.filePath);
        }
      }
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyBuilder] Failed to clean stale xctestrun files: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Check if a download/extract is needed
   */
  public async needsRebuild(platform?: IOSCtrlProxyPlatform): Promise<boolean> {
    if (readEnvBool(ENV.SKIP_CTRL_PROXY_DOWNLOAD)) {
      logger.info(`[IOSCtrlProxyBuilder] Download skipped via ${SKIP_CTRL_PROXY_DOWNLOAD_ENV}`);
      return false;
    }

    // Local products are authoritative, even with a fresh/stale release cache
    // or a vendored bundle override. Never turn missing products into a download.
    if (this.isLocalBuildMode()) {
      await this.artifactVerifier.requireLocalBuildProducts(platform);
      return false;
    }

    // Fail closed here too: without this, an unknown explicit pin with a cached
    // bundle + metadata would return false and silently reuse the cached (possibly
    // wrong-version) runner without ever reaching verifyBundle's guard (#2746).
    this.artifactVerifier.assertPinnedVersionVerifiable();

    // A vendored bundle override must always be (re)consumed: otherwise, on a
    // reused host with an existing xctestrun + metadata, needsRebuild() would
    // return false and silently keep the stale cached runner instead of the
    // vendored IPA — the documented escape hatch would be a no-op (#2746).
    if (this.getBundlePathOverride() !== null) {
      logger.info(
        "[IOSCtrlProxyBuilder] CtrlProxy bundle path override set, forcing extraction of the vendored bundle",
      );
      return true;
    }

    const xctestrunPath = await this.getXctestrunPath(platform);
    if (!xctestrunPath) {
      logger.info("[IOSCtrlProxyBuilder] CtrlProxy artifacts missing, need download");
      return true;
    }

    const metadata = await this.artifactVerifier.readBundleMetadata();
    const expectedChecksum = this.artifactVerifier.getExpectedChecksum();
    if (this.artifactVerifier.needsMetadataRefresh(metadata, expectedChecksum)) {
      return true;
    }

    if (await this.artifactVerifier.needsAppHashRefresh(platform, metadata)) {
      return true;
    }

    logger.info("[IOSCtrlProxyBuilder] CtrlProxy artifacts are up to date");
    return false;
  }

  /** Returns the persisted release identity of the currently extracted runner bundle. */
  public async getInstalledBundleVersion(): Promise<string | null> {
    const metadata = await this.artifactVerifier.readBundleMetadata();
    return metadata?.version ?? null;
  }

  /**
   * Download and extract CtrlProxy release bundle
   */
  public async build(
    platform?: IOSCtrlProxyPlatform,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<CtrlProxyIosBuildResult> {
    // Throw the actionable missing-build error before the download result's
    // catch boundary; SKIP retains its existing short-circuit/result semantics.
    if (this.isLocalBuildMode() && !readEnvBool(ENV.SKIP_CTRL_PROXY_DOWNLOAD)) {
      await this.artifactVerifier.requireLocalBuildProducts(platform);
    }
    // Keep the shared artifact flight alive until every waiter has resolved
    // its platform paths, so another extraction cannot race those reads.
    this.buildWaiters++;
    // Local validation is platform-specific and does not extract shared artifacts.
    const build = this.isLocalBuildMode()
      ? this.doBuild(perf, platform)
      : this.joinBuildFlight(perf, platform);
    try {
      const shared = await build;
      if (!shared.success) {
        return shared;
      }
      const buildPath = await this.getBuildProductsPath(platform ?? "simulator");
      const xctestrunPath = await this.getXctestrunPath(platform);
      if (!xctestrunPath) {
        return {
          success: false,
          message: "Downloaded CtrlProxy bundle missing xctestrun",
          error: "No .xctestrun file found after extraction",
        };
      }
      return { ...shared, buildPath: buildPath || undefined, xctestrunPath };
    } catch (error) {
      logger.warn(`CtrlProxy artifact discovery failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        message: "CtrlProxy artifact discovery failed",
        error: errorMessage(error),
      };
    } finally {
      if (--this.buildWaiters === 0) {
        this.buildInFlight = null;
      }
    }
  }

  /**
   * Wait for the shared bundle flight under THIS caller's own signal, starting the
   * flight when none is running. A flight that has settled but is still retained for
   * the remaining waiters' path resolution is reused as-is.
   */
  private joinBuildFlight(
    perf: PerformanceTracker,
    platform?: IOSCtrlProxyPlatform,
  ): Promise<CtrlProxyIosBuildResult> {
    if (this.buildInFlight && !this.buildFlights.has("build")) {
      return this.buildInFlight;
    }
    return this.buildFlights.run(
      "build",
      (flightSignal) => this.startBuildFlight(perf, platform, flightSignal),
      getAbortSignal(),
      { cancelWhenAllWaitersAbort: true },
    );
  }

  private startBuildFlight(
    perf: PerformanceTracker,
    platform: IOSCtrlProxyPlatform | undefined,
    flightSignal?: AbortSignal,
  ): Promise<CtrlProxyIosBuildResult> {
    const previous = this.buildSettled;
    const flight = (async () => {
      await previous;
      // Created inside the first caller's async context; detach from that caller's
      // signal so the download (which binds to the ambient signal) runs under the
      // flight-scoped one.
      return runWithAbortSignal(flightSignal, () => this.doBuild(perf, platform));
    })();
    this.buildInFlight = flight;
    this.buildSettled = flight.then(
      () => undefined,
      () => undefined,
    );
    // An abandoned flight must not be handed to a later caller as the shared result.
    flightSignal?.addEventListener(
      "abort",
      () => {
        if (this.buildInFlight === flight) {
          this.buildInFlight = null;
        }
      },
      { once: true },
    );
    return flight;
  }

  private async doBuild(
    perf: PerformanceTracker,
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<CtrlProxyIosBuildResult> {
    perf.serial("xcTestServiceDownload");

    if (readEnvBool(ENV.SKIP_CTRL_PROXY_DOWNLOAD)) {
      perf.end();
      return {
        success: false,
        message: "CtrlProxy download skipped",
        error: `${SKIP_CTRL_PROXY_DOWNLOAD_ENV} is set`,
      };
    }

    try {
      if (this.isLocalBuildMode()) {
        await this.artifactVerifier.verifyLocalBuildProducts(platform);
        perf.end();
        return { success: true, message: "Using locally built CtrlProxy products" };
      }

      const { bundlePath, usedCachedFallback, localOverridePath } = await perf.track(
        "downloadBundle",
        () => this.ensureBundleDownloaded(),
      );
      if (!usedCachedFallback) {
        await perf.track("extractBundle", () => this.extractBundle(bundlePath, localOverridePath));
      }

      // Clear cached paths to force rediscovery
      this.cachedBuildProductsPath.clear();
      this.cachedXctestrunPath.clear();
      this.artifactVerifier.clearAppBundleHashes();

      await this.cleanStaleXctestrunFiles();

      perf.end();
      return {
        success: true,
        message: "CtrlProxy downloaded and extracted successfully",
      };
    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.warn(`[IOSCtrlProxyBuilder] Download failed: ${errorMsg}`, error);

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
    return IosCtrlProxyBuilder.prefetcher.prefetch();
  }

  /**
   * The in-flight startup prefetch, or null when none was started or it has
   * already settled (#7032). Startup iOS init awaits this under its per-device
   * budget so it never verifies the runner the prefetch is concurrently
   * replacing; the pre-launch hash gate uses it to classify a mismatch as a
   * stale cache. Always resolves (never rejects): `prefetchBuild` records
   * failures via {@link getPrefetchError} and resolves null.
   */
  public static pendingPrefetch(): Promise<CtrlProxyIosBuildResult | null> | null {
    return IosCtrlProxyBuilder.prefetcher.pending();
  }

  /**
   * Wait for prefetch to complete
   */
  public static waitForPrefetch(): Promise<CtrlProxyIosBuildResult | null> {
    return IosCtrlProxyBuilder.prefetcher.wait();
  }

  /**
   * Get the prefetched build result (non-blocking)
   */
  public static getPrefetchedResult(): CtrlProxyIosBuildResult | null {
    return IosCtrlProxyBuilder.prefetcher.getResult();
  }

  /**
   * Check if prefetch had an error
   */
  public static getPrefetchError(): Error | null {
    return IosCtrlProxyBuilder.prefetcher.getError();
  }

  /** Serializes shared derived-data mutations; callers must not acquire it recursively. */
  public async runExclusiveOnDerivedData<T>(task: () => Promise<T>): Promise<T> {
    return this.derivedDataLock.runExclusive(task);
  }

  /**
   * Clean up build artifacts
   */
  public async cleanBuildArtifacts(): Promise<void> {
    await this.runExclusiveOnDerivedData(async () => {
      try {
        await fs.rm(this.config.derivedDataPath, { recursive: true, force: true });
        this.cachedBuildProductsPath.clear();
        this.cachedXctestrunPath.clear();
        this.artifactVerifier.clearAppBundleHashes();
        logger.info("[IOSCtrlProxyBuilder] Build artifacts cleaned up");
      } catch (error) {
        logger.warn("[IOSCtrlProxyBuilder] Failed to clean build artifacts:", error);
      }
    });
  }

  /**
   * Get configuration for inspection
   */
  public getConfig(): CtrlProxyIosBuildConfig {
    return { ...this.config };
  }

  public async getAppBundlePath(
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<string | null> {
    return this.artifactVerifier.getAppBundlePath(platform);
  }

  public async getAppBundleHash(
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<string | null> {
    return this.artifactVerifier.getAppBundleHash(platform);
  }

  /** Get the executable represented by the selected release's runner checksum. */
  public async getRunnerBinaryPath(
    platform: IOSCtrlProxyPlatform = "simulator",
    target: RunnerSha256Target = this.artifactVerifier.getExpectedRunnerChecksumTarget(),
  ): Promise<string | null> {
    return this.artifactVerifier.getRunnerBinaryPath(platform, target);
  }

  private getBundleUrl(): string {
    const override = readEnvRaw(ENV.CTRL_PROXY_IOS_BUNDLE_URL)?.trim();
    if (override) {
      // Reject a plaintext http:// bundle override unless the opt-out is set
      // (issue #4761); resolveIpaUrl already enforces https on the mirror knob.
      assertHttpsAssetUrl(override, ENV.CTRL_PROXY_IOS_BUNDLE_URL.name);
      return override;
    }
    return resolveIpaUrl();
  }

  private getBundlePathOverride(): string | null {
    const override =
      readEnvTrimmed(ENV.CTRL_PROXY_IOS_IPA_PATH) || readEnvTrimmed(ENV.CTRL_PROXY_IOS_BUNDLE_PATH);
    return override && override.length > 0
      ? resolvePathFromDaemonLaunchWorkingDirectory(override)
      : null;
  }

  public getExpectedAppHash(platform: IOSCtrlProxyPlatform): string {
    return this.artifactVerifier.getExpectedAppHash(platform);
  }

  private async ensureBundleDownloaded(): Promise<{
    bundlePath: string;
    usedCachedFallback: boolean;
    localOverridePath: string | null;
  }> {
    await ensureSecureDir(this.config.bundleCacheDir);
    const bundlePath = this.artifactVerifier.getBundlePath();

    const overridePath = this.getBundlePathOverride();
    if (overridePath) {
      logger.info("[IOSCtrlProxyBuilder] Using local CtrlProxy bundle override", {
        path: overridePath,
      });
      const stats = await fs.stat(overridePath);
      if (!stats.isFile()) {
        throw new Error(`CtrlProxy bundle override is not a file: ${overridePath}`);
      }
      await fs.copyFile(overridePath, bundlePath);
      await this.artifactVerifier.verifyBundle(bundlePath);
      return { bundlePath, usedCachedFallback: false, localOverridePath: overridePath };
    }

    const expectedChecksum = this.artifactVerifier.getExpectedChecksum();
    const bundleReady = await this.artifactVerifier.isBundleValid(bundlePath, expectedChecksum);

    if (!bundleReady) {
      // When a version is pinned (AUTOMOBILE_VERSION), hermetic mode disables the
      // silent cached-bundle fallback so a failed download fails hard (#2746).
      // resolvePinnedVersion already normalizes the `latest` sentinel.
      const isLatest = resolvePinnedVersion() === LATEST_RELEASE_VERSION;
      const cachedBundleExists = await this.artifactVerifier.isBundleValid(bundlePath, "");
      // Set once the download itself succeeded: a later size/checksum failure must fail closed
      // and never fall back to the cached bundle (only a failed download may).
      let downloaded = false;
      try {
        logger.info("[IOSCtrlProxyBuilder] Downloading CtrlProxy bundle", {
          url: this.getBundleUrl(),
          destination: bundlePath,
          reason: "checksum-mismatch-or-missing",
        });
        // Download to a sibling temp file and rename on success, so a failed download or
        // verification never replaces (or deletes) the cached bundle.
        await this.artifactCache.fetch({
          label: "[IOSCtrlProxyBuilder]",
          expectedSha256: expectedChecksum.length > 0 ? expectedChecksum : null,
          url: this.getBundleUrl(),
          // Unique per attempt: builders (and daemons) share this cache directory, and a shared
          // temp name would let one attempt hash, rename or delete another's file.
          archivePath: `${bundlePath}.${defaultIdGenerator.next()}.download`,
          finalPath: bundlePath,
          afterDownload: async (downloadedPath) => {
            downloaded = true;
            await this.artifactVerifier.assertBundleSize(downloadedPath);
          },
          mismatchError: (want, actual) =>
            new Error(`CtrlProxy checksum verification failed. Expected: ${want}, Got: ${actual}`),
          publish: async (_downloadedPath, checksum, source) => {
            this.artifactVerifier.reportBundleVerification(checksum, source);
          },
        });
        return { bundlePath, usedCachedFallback: false, localOverridePath: overridePath };
      } catch (error) {
        if (!downloaded && isLatest && cachedBundleExists) {
          logger.warn(
            `[IOSCtrlProxyBuilder] Download failed, using cached bundle: ${errorMessage(error)}`,
          );
          // `cachedBundleExists` only proves the cached IPA is size-valid — NOT
          // that its checksum matches. build() skips extractBundle+verifyBundle
          // for the fallback path, so checksum-verify here before reuse instead
          // of trusting a size-valid-but-unverified cached IPA (issue #4761).
          // A mismatch throws and fails closed rather than reusing it silently.
          await this.artifactVerifier.verifyBundle(bundlePath);
          return { bundlePath, usedCachedFallback: true, localOverridePath: null };
        }
        throw error;
      }
    }

    await this.artifactVerifier.verifyBundle(bundlePath);
    return { bundlePath, usedCachedFallback: false, localOverridePath: overridePath };
  }

  /**
   * Single source of truth for the iOS fail-closed decision: `AUTOMOBILE_VERSION`
   * names a concrete version absent from the checksum registry, with no escape hatch
   * (local-build mode, vendored IPA/bundle path or explicit checksum override),
   * so the CtrlProxy bundle cannot be integrity-verified (#2746). Reused by the build/reuse guards,
   * `IOSCtrlProxyManager.setup()`, `doctor --ios`, and the booted-device compat check.
   */
  static isPinnedVersionUnverifiable(): boolean {
    if (
      IosCtrlProxyBuilder.settings.expectedChecksum !== null ||
      IosCtrlProxyBuilder.isLocalBuildModeEnabled()
    ) {
      return false;
    }
    const ipaPath = readEnvTrimmed(ENV.CTRL_PROXY_IOS_IPA_PATH);
    const bundlePath = readEnvTrimmed(ENV.CTRL_PROXY_IOS_BUNDLE_PATH);
    if ((ipaPath && ipaPath.length > 0) || (bundlePath && bundlePath.length > 0)) {
      return false;
    }
    return isExplicitPin() && !isPinnedVersionKnown();
  }

  private async extractBundle(bundlePath: string, localOverridePath: string | null): Promise<void> {
    await this.runExclusiveOnDerivedData(() =>
      extractIosCtrlProxyBundle(bundlePath, localOverridePath, {
        derivedDataPath: this.config.derivedDataPath,
        downloader: this.downloader,
        artifactVerifier: this.artifactVerifier,
        normalizeExtractedBundle: () => this.normalizeExtractedBundle(),
      }),
    );
  }

  private async normalizeExtractedBundle(): Promise<void> {
    return this.artifactVerifier.normalizeExtractedBundle();
  }

  private async verifyPlatformArtifacts(platform: IOSCtrlProxyPlatform): Promise<void> {
    const buildDir = await this.getBuildProductsPath(platform);
    if (!buildDir) {
      throw new Error(`CtrlProxy build products missing for ${platform}`);
    }

    const requiredPaths = [
      (await this.getAppBundlePath(platform)) ?? path.join(buildDir, "AutoMobileTest.app"),
      path.join(buildDir, "CtrlProxyUITests-Runner.app"),
      // The reference `CtrlProxyTests` unit-test target was retired in Phase 7E, so the
      // re-cut archive no longer carries a top-level CtrlProxyTests.xctest. The sole test
      // bundle is now CtrlProxyUITests.xctest, embedded in the runner app's PlugIns dir.
      path.join(buildDir, "CtrlProxyUITests-Runner.app", "PlugIns", "CtrlProxyUITests.xctest"),
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
        throw new Error(
          `CtrlProxy app hash mismatch for ${platform}. Expected: ${expectedAppHash}, Got: ${localHash}`,
        );
      }
      logger.info("[IOSCtrlProxyBuilder] App bundle hash verified", { platform, hash: localHash });
    } else {
      logger.warn(
        `[IOSCtrlProxyBuilder] App bundle hash verification skipped for ${platform} (no hash provided)`,
      );
    }

    // Verify the release-selected runner executable SHA256 for BOTH simulator
    // and device (issue #4761). On device the app-bundle hash check above is
    // skipped because IOS_CTRL_PROXY_APP_HASH ships empty, so re-hashing the
    // runner executable is the only independent post-extract integrity signal
    // there — previously it ran for simulator only. `assertRunnerBinaryHash`
    // still no-ops with a warning when no runner checksum is configured.
    await this.artifactVerifier.assertRunnerBinaryHash(platform, "post-extract");
  }

  /** Whether the {@link IOS_CTRL_PROXY_USE_LOCAL_BUILD_ENV} switch is active (#5561). */
  static isLocalBuildModeEnabled(): boolean {
    const override = IosCtrlProxyBuilder.settings.useLocalBuild;
    if (override !== null) {
      return override;
    }
    return readEnvBool(ENV.CTRL_PROXY_IOS_USE_LOCAL_BUILD);
  }

  private isLocalBuildMode(): boolean {
    return IosCtrlProxyBuilder.isLocalBuildModeEnabled();
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
    return this.artifactVerifier.verifyRunnerBinaryBeforeLaunch(platform);
  }

  private async invalidateCachedBundle(): Promise<void> {
    await fs.rm(this.artifactVerifier.getBundlePath(), { force: true });
    await fs.rm(this.artifactVerifier.getMetadataPath(), { force: true });
    await this.cleanBuildArtifacts();
    this.artifactVerifier.clearLocalRunnerPins();
  }

  /** Path to the extracted runner `.app` bundle codesign verifies (issue #4760). */
  public async getRunnerAppPath(
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<string | null> {
    return this.artifactVerifier.getRunnerAppPath(platform);
  }

  private async findXctestrunFiles(root: string): Promise<string[]> {
    return this.artifactVerifier.findXctestrunFiles(root);
  }
}
