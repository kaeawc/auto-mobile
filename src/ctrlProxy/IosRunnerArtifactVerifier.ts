import * as fs from "fs/promises";
import * as path from "path";
import { CtrlProxyStaleRunnerCacheError } from "./CtrlProxyStaleRunnerCacheError";
import type { CtrlProxyIosBuildResult, IosCtrlProxyBuilderSettings } from "./IosCtrlProxyBuilder";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { ENV, readEnvBool, readEnvRaw, readEnvTrimmed } from "../config/env";
import {
  IOS_CTRL_PROXY_APP_HASH,
  findReleaseByRunnerSha256,
  resolveAssetVersion,
  resolvePinnedVersion,
  resolveRunnerChecksum,
  resolveRunnerChecksumTarget,
  type RunnerSha256Target,
} from "../constants/release";
import type {
  CtrlProxyIosBundleDownloader,
  Sha256Source,
} from "../utils/IOSCtrlProxyBundleDownloader";
import type { CodesignVerificationOutcome } from "../utils/ios-cmdline-tools/CtrlProxyCodesignVerifier";
import { SKIP_CTRL_PROXY_DOWNLOAD_ENV } from "../utils/ctrlProxyDownloadControl";
import { hashAppBundle } from "../utils/ios-cmdline-tools/AppBundleHasher";
import { ensureSecureDir } from "../utils/filesystem/securePermissions";
import { sortedReaddirEntries } from "../utils/io";
import { resolveIpaChecksum } from "../constants/release";
import { shellQuote } from "../utils/shellQuote";

/**
 * When truthy (`1`/`true`), a failed `codesign --verify`, a failed
 * `spctl --assess`, or a Team-ID mismatch turns the default WARNING into a hard
 * refusal to launch the downloaded iOS helper (issue #4760). Off by default so
 * dev / self-built / unsigned local helpers still run — code signing is not
 * OS-enforced on the simulator anyway, so the value here is defense-in-depth on
 * physical devices alongside the #4759 hash re-verification.
 */
export const IOS_HELPER_REQUIRE_CODESIGN_ENV = ENV.IOS_HELPER_REQUIRE_CODESIGN.name;

/**
 * Optional pinned Apple Team ID. When set, the runner bundle's
 * `TeamIdentifier` must match; a mismatch warns (or refuses, under
 * {@link IOS_HELPER_REQUIRE_CODESIGN_ENV}). Unset by default because we ship no
 * canonical Team ID (issue #4760).
 */
export const IOS_HELPER_TEAM_ID_ENV = ENV.IOS_HELPER_TEAM_ID.name;

/**
 * Expected SHA256 for an explicitly supplied or source-built runner. This keeps
 * the pre-launch integrity gate active when the local runner intentionally does
 * not match the published release artifact selected by package.json.
 */
export const IOS_CTRL_PROXY_RUNNER_SHA256_ENV = ENV.CTRL_PROXY_IOS_RUNNER_SHA256.name;

/** Executable represented by {@link IOS_CTRL_PROXY_RUNNER_SHA256_ENV}. */
export const IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV = ENV.CTRL_PROXY_IOS_RUNNER_SHA256_TARGET.name;

/**
 * First-class "serve a locally built runner" switch (issue #5561). When truthy
 * (`1`/`true`) and no explicit {@link IOS_CTRL_PROXY_RUNNER_SHA256_ENV} is set,
 * the pre-launch integrity gate stops comparing against the release-pinned
 * checksum — which a local build can never match — and instead DERIVES the
 * expected hash from the existing local runner binary on first verification,
 * pins it with the file's size and mtime, and re-verifies before launch. A hash
 * change with unchanged identity still fails closed (issue #4759); an identity
 * change accepts a local rebuild and re-derives the pin. Local mode never downloads
 * or extracts a release bundle; missing products require a local rebuild.
 * Off by default so published runs keep the pinned guard.
 * This removes the run-fail-read-`Got:`-sha-rerun dance the manual-test flow
 * previously required.
 */
export const IOS_CTRL_PROXY_USE_LOCAL_BUILD_ENV = ENV.CTRL_PROXY_IOS_USE_LOCAL_BUILD.name;

/**
 * Turn a codesign inspection outcome into a list of human-readable problems,
 * honoring an optional pinned Team ID (issue #4760). An empty list means the
 * runner passed every applicable check.
 */
function collectCodesignProblems(
  outcome: CodesignVerificationOutcome,
  pinnedTeamId: string | null,
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

interface LocalRunnerHashPin {
  sha256: string;
  size: number;
  mtimeMs: number;
}

type IOSCtrlProxyPlatform = "simulator" | "device";

export type IOSCtrlProxyBundleMetadata = {
  checksum: string | null;
  version: string;
  extractedAt: string;
  appHashes?: Partial<Record<IOSCtrlProxyPlatform, string>>;
};

/** Live policy and artifact access; callbacks retain the builder's injected seams. */
export interface IosRunnerArtifactVerifierHost {
  readonly derivedDataPath: string;
  readonly bundleCacheDir: string;
  computeFileSha256: CtrlProxyIosBundleDownloader["computeFileSha256"];
  getSettings(): Pick<
    IosCtrlProxyBuilderSettings,
    | "expectedChecksum"
    | "expectedRunnerChecksum"
    | "expectedRunnerChecksumTarget"
    | "codesignVerifier"
  >;
  isPinnedVersionUnverifiable(): boolean;
  hasPendingPrefetch(): boolean;
  getBuildProductsPath(platform: IOSCtrlProxyPlatform): Promise<string | null>;
  getXctestrunPath(platform: IOSCtrlProxyPlatform): Promise<string | null>;
  getAppBundlePath(platform: IOSCtrlProxyPlatform): Promise<string | null>;
  getAppBundleHash(platform: IOSCtrlProxyPlatform): Promise<string | null>;
  getExpectedAppHash(platform: IOSCtrlProxyPlatform): string;
  findXctestrunFiles(root: string): Promise<string[]>;
  getRunnerBinaryPath(
    platform: IOSCtrlProxyPlatform,
    target: RunnerSha256Target,
  ): Promise<string | null>;
  getRunnerAppPath(platform: IOSCtrlProxyPlatform): Promise<string | null>;
  getBundlePathOverride(): string | null;
  isLocalBuildMode(): boolean;
  verifyPlatformArtifacts(platform: IOSCtrlProxyPlatform): Promise<void>;
  invalidateCachedBundle(): Promise<void>;
  build(
    platform: IOSCtrlProxyPlatform,
  ): Promise<Pick<CtrlProxyIosBuildResult, "success" | "error">>;
}

/** Bundle and runner integrity policy, with per-builder local pins and repair state. */
export class IosRunnerArtifactVerifier {
  private static readonly MIN_BUNDLE_SIZE_BYTES = 10000;

  /**
   * Local-build-mode (#5561) runner hash and identity, pinned per platform.
   * A rebuild changes identity; an unchanged identity retains the tamper guard.
   */
  private derivedLocalRunnerSha256: Map<IOSCtrlProxyPlatform, LocalRunnerHashPin> = new Map();

  /** Platforms whose one-shot pre-launch cache repair ran and has not yet verified. */
  private readonly failedRunnerRepairs = new Set<IOSCtrlProxyPlatform>();

  private static readonly DEFAULT_BUNDLE_FILENAME = "control-proxy.ipa";

  private static readonly METADATA_FILENAME = "ctrl-proxy-ios-bundle.json";

  /**
   * NOT using TTLCache: file-existence validation via fs.access(), not time-based.
   * Hash is computed once per build and cached until next build/extraction.
   */
  private cachedAppBundleHash: Map<IOSCtrlProxyPlatform, string | null> = new Map();
  // Cache successful raw inspections only. Gatekeeper failures can be transient,
  // and exceptions/timeouts must be retried. Live launch policy is always reapplied.
  // A cached spctl success lasts the daemon lifetime: later revocation is unseen.
  // Acceptable for warn-by-default policy; simulators do not enforce signing.
  private readonly codesignOutcomes = new Map<string, CodesignVerificationOutcome>();

  constructor(
    private readonly host: IosRunnerArtifactVerifierHost,
    private readonly hashRunnerBundle = (appPath: string): Promise<string> =>
      hashAppBundle(appPath, undefined, {
        includeSigningMetadata: true,
        lengthPrefixed: true,
        sealLinks: true,
      }),
  ) {}

  /** A replacement extraction invalidates every platform's local integrity pin. */
  public clearLocalRunnerPins(): void {
    this.derivedLocalRunnerSha256.clear();
  }

  /** Get the executable represented by the selected release's runner checksum. */
  public async getRunnerBinaryPath(
    platform: IOSCtrlProxyPlatform = "simulator",
    target: RunnerSha256Target = this.getExpectedRunnerChecksumTarget(),
  ): Promise<string | null> {
    const buildPath = await this.host.getBuildProductsPath(platform);
    if (!buildPath) {
      return null;
    }
    const runnerAppPath = path.join(buildPath, "CtrlProxyUITests-Runner.app");
    const runnerBinaryPath =
      target === "xctest"
        ? path.join(runnerAppPath, "PlugIns", "CtrlProxyUITests.xctest", "CtrlProxyUITests")
        : path.join(runnerAppPath, "CtrlProxyUITests-Runner");
    try {
      await fs.access(runnerBinaryPath);
      return runnerBinaryPath;
    } catch (error) {
      // Runner binary not present in the build products dir; null tells the caller
      // the UI test runner hasn't been built yet rather than throwing.
      logger.debug(`src/ctrlProxy/IosCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  private getExpectedRunnerChecksum(): string {
    const override = this.host.getSettings().expectedRunnerChecksum;
    if (override !== null) {
      return override;
    }
    const environmentOverride = readEnvTrimmed(ENV.CTRL_PROXY_IOS_RUNNER_SHA256);
    if (environmentOverride) {
      if (!/^[a-f0-9]{64}$/i.test(environmentOverride)) {
        throw new ActionableError(
          `${IOS_CTRL_PROXY_RUNNER_SHA256_ENV} must be a 64-character hexadecimal SHA256 checksum`,
        );
      }
      return environmentOverride.toLowerCase();
    }
    return resolveRunnerChecksum();
  }

  public getExpectedRunnerChecksumTarget(): RunnerSha256Target {
    const override = this.host.getSettings().expectedRunnerChecksumTarget;
    if (override !== null) {
      return override;
    }
    const environmentOverride = readEnvTrimmed(ENV.CTRL_PROXY_IOS_RUNNER_SHA256_TARGET);
    if (environmentOverride === "runner" || environmentOverride === "xctest") {
      return environmentOverride;
    }
    if (environmentOverride) {
      throw new ActionableError(
        `${IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV} must be either "runner" or "xctest"`,
      );
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
      const genericOverride = readEnvRaw(ENV.IOS_CTRL_PROXY_APP_HASH);
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

  public async isBundleValid(bundlePath: string, expectedChecksum: string): Promise<boolean> {
    try {
      const stats = await fs.stat(bundlePath);
      if (!stats.isFile() || stats.size < IosRunnerArtifactVerifier.MIN_BUNDLE_SIZE_BYTES) {
        return false;
      }
    } catch (error) {
      // fs.stat failed because the cached bundle file doesn't exist (or isn't
      // readable); treat it as invalid so the caller re-downloads it.
      logger.debug(`src/ctrlProxy/IosCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return false;
    }

    if (!expectedChecksum) {
      return true;
    }

    const { checksum } = await this.host.computeFileSha256(bundlePath);
    return checksum.toLowerCase() === expectedChecksum.toLowerCase();
  }

  public async assertBundleSize(bundlePath: string): Promise<void> {
    const stats = await fs.stat(bundlePath);
    if (stats.size < IosRunnerArtifactVerifier.MIN_BUNDLE_SIZE_BYTES) {
      throw new Error(`Downloaded bundle is too small (${stats.size} bytes), likely invalid`);
    }
  }

  /** Log a verified checksum, or fail closed / warn when none is configured. */
  public reportBundleVerification(checksum: string | null, source: Sha256Source | null): void {
    if (checksum !== null) {
      logger.info("[IOSCtrlProxyBuilder] Bundle checksum verified", { checksum, source });
      return;
    }
    this.assertPinnedVersionVerifiable();
    logger.warn(
      "[IOSCtrlProxyBuilder] Bundle checksum verification skipped (no checksum provided)",
    );
  }

  public async verifyBundle(bundlePath: string): Promise<void> {
    await this.assertBundleSize(bundlePath);

    const expectedChecksum = this.getExpectedChecksum();
    if (expectedChecksum.length > 0) {
      const { checksum, source } = await this.host.computeFileSha256(bundlePath);
      if (checksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
        throw new Error(
          `CtrlProxy checksum verification failed. Expected: ${expectedChecksum}, Got: ${checksum}`,
        );
      }
      this.reportBundleVerification(checksum, source);
      return;
    }
    this.reportBundleVerification(null, null);
  }

  /**
   * Fail closed when a concrete `AUTOMOBILE_VERSION` is pinned to a version absent
   * from the baked checksum registry: the bundle cannot be integrity-verified, so
   * silently downloading or reusing it defeats the point of pinning (#2746). A
   * vendored bundle (`AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`) or an explicit checksum
   * override is the trusted escape hatch.
   */
  public assertPinnedVersionVerifiable(): void {
    if (this.host.isPinnedVersionUnverifiable()) {
      throw new ActionableError(
        `AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the AutoMobile release ` +
          `checksum registry, so the CtrlProxy bundle cannot be integrity-verified. ` +
          `Pin a released version, or vendor a trusted bundle via AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH.`,
      );
    }
  }

  public async verifyExtractedArtifacts(): Promise<void> {
    const simXctestrun = await this.host.getXctestrunPath("simulator");
    const deviceXctestrun = await this.host.getXctestrunPath("device");

    if (!simXctestrun && !deviceXctestrun) {
      throw new Error("Extracted CtrlProxy bundle missing .xctestrun file");
    }

    if (simXctestrun) {
      await this.host.verifyPlatformArtifacts("simulator");
    }

    if (deviceXctestrun) {
      await this.host.verifyPlatformArtifacts("device");
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
  public async assertRunnerBinaryHash(
    platform: IOSCtrlProxyPlatform,
    phase: "post-extract" | "pre-launch",
  ): Promise<void> {
    // First-class local-build mode (#5561): derive and trust the locally built
    // runner's own hash instead of the release-pinned baseline it can never
    // match. An explicit SHA override still wins (checked inside), so published
    // and pinned-SHA runs keep their guard.
    if (this.host.isLocalBuildMode() && !this.hasExplicitRunnerShaOverride()) {
      await this.assertLocalRunnerBinaryHash(platform, phase);
      return;
    }

    const expectedRunnerSha256 = this.getExpectedRunnerChecksum();
    if (!expectedRunnerSha256 || expectedRunnerSha256.length === 0) {
      logger.warn(
        `[IOSCtrlProxyBuilder] Runner binary SHA256 verification skipped for ${platform} (no hash provided)`,
      );
      return;
    }
    const runnerChecksumTarget = this.getExpectedRunnerChecksumTarget();
    const runnerBinaryPath = await this.host.getRunnerBinaryPath(platform, runnerChecksumTarget);
    if (!runnerBinaryPath) {
      throw new ActionableError(`CtrlProxy runner binary missing for ${platform}`);
    }
    const { checksum } = await this.host.computeFileSha256(runnerBinaryPath);
    if (checksum.toLowerCase() !== expectedRunnerSha256.toLowerCase()) {
      if (phase === "pre-launch") {
        const staleCache = this.classifyStaleRunnerCache(checksum);
        if (staleCache) {
          logger.info(
            `[IOSCtrlProxyBuilder] Runner binary SHA256 mismatch (pre-launch) for ${platform} ` +
              `explained by a stale cache: ${staleCache.message}`,
          );
          throw staleCache;
        }
      }
      throw new ActionableError(
        `CtrlProxy runner binary SHA256 mismatch (${phase}) for ${platform}. ` +
          `Expected: ${expectedRunnerSha256}, Got: ${checksum}. Refusing to launch a runner whose ` +
          `binary changed since it was verified (possible TOCTOU tampering).`,
      );
    }
    logger.info(`[IOSCtrlProxyBuilder] Runner binary SHA256 verified (${phase})`, {
      platform,
      checksum,
    });
  }

  /**
   * Explain a pre-launch runner hash mismatch as a stale cache (#7032) when the
   * observed hash is a previous registry entry's `runnerSha256` (the extracted
   * runner is simply one release old), or when the startup prefetch that
   * replaces the extracted runner is still in flight. Returns null when the
   * hash matches no known release and nothing is replacing it, so the caller
   * keeps the fail-closed tampering refusal (issue #4759).
   */
  private classifyStaleRunnerCache(observedSha256: string): CtrlProxyStaleRunnerCacheError | null {
    const expectedVersion = resolveAssetVersion(resolvePinnedVersion());
    const knownRelease = findReleaseByRunnerSha256(observedSha256);
    if (knownRelease && knownRelease.version !== expectedVersion) {
      return new CtrlProxyStaleRunnerCacheError(knownRelease.version, expectedVersion);
    }
    if (this.host.hasPendingPrefetch()) {
      return new CtrlProxyStaleRunnerCacheError(null, expectedVersion);
    }
    return null;
  }

  /** Validate the existing local products without consulting release metadata. */
  public async requireLocalBuildProducts(
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<void> {
    const productsDir = path.join(this.host.derivedDataPath, "Build", "Products");
    const rebuildCommand =
      platform === "device"
        ? `xcodebuild build-for-testing -project ios/control-proxy/CtrlProxy.xcodeproj ` +
          `-scheme AutoMobileTest -destination 'generic/platform=iOS' ` +
          `-derivedDataPath ${shellQuote(this.host.derivedDataPath)} -configuration Debug`
        : `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=${shellQuote(this.host.derivedDataPath)} ` +
          `bash scripts/ios/ctrl-proxy-build-for-testing.sh`;
    const missingBuild = (expectedPath: string, cause?: unknown): ActionableError =>
      new ActionableError(
        `Local CtrlProxy build products missing or invalid at ${expectedPath}. ` +
          `Local-build mode never installs the released bundle. ` +
          (platform === "device"
            ? `Device builds require valid code signing and a provisioning profile. `
            : "") +
          `Build with: ` +
          rebuildCommand,
        { cause },
      );
    const xctestrunPath = await this.host.getXctestrunPath(platform);
    if (!xctestrunPath) {
      const filter = `*${{ device: "iphoneos", simulator: "iphonesimulator" }[platform]}*`;
      throw missingBuild(path.join(productsDir, `${filter}.xctestrun`));
    }
    const buildPath = path.join(
      productsDir,
      platform === "device" ? "Debug-iphoneos" : "Debug-iphonesimulator",
    );
    const runnerApp = path.join(buildPath, "CtrlProxyUITests-Runner.app");
    const files = [
      xctestrunPath,
      path.join(runnerApp, "CtrlProxyUITests-Runner"),
      path.join(runnerApp, "PlugIns", "CtrlProxyUITests.xctest", "CtrlProxyUITests"),
    ];
    for (const file of files) {
      const stat = await fs.stat(file).catch((error: unknown) => {
        throw missingBuild(file, error);
      });
      if (!stat.isFile() || stat.size === 0) {
        throw missingBuild(file);
      }
    }
    const appPath = await this.host.getAppBundlePath(platform);
    if (!appPath) {
      throw missingBuild(path.join(buildPath, "AutoMobileTest.app"));
    }
    const appStat = await fs.stat(appPath).catch((error: unknown) => {
      throw missingBuild(appPath, error);
    });
    if (!appStat.isDirectory()) {
      throw missingBuild(appPath);
    }
  }

  /** Capture fresh integrity pins only when explicitly accepting a local rebuild. */
  public async verifyLocalBuildProducts(platform: IOSCtrlProxyPlatform): Promise<void> {
    await this.assertDerivedDataDirOwnedByCurrentUid();
    // An explicit build() re-captures only the requested platform's pin.
    this.derivedLocalRunnerSha256.delete(platform);
    await this.requireLocalBuildProducts(platform);
    await this.assertRunnerBinaryHash(platform, "post-extract");
  }

  /**
   * Whether the operator hand-supplied a runner SHA256 via
   * {@link IOS_CTRL_PROXY_RUNNER_SHA256_ENV}. That explicit value takes
   * precedence over local-build mode so a pinned hash stays enforced (#5561).
   * Note: the static test override is deliberately excluded — it stands in for
   * the release-pinned baseline, which local-build mode is designed to relax.
   */
  private hasExplicitRunnerShaOverride(): boolean {
    const environmentOverride = readEnvTrimmed(ENV.CTRL_PROXY_IOS_RUNNER_SHA256);
    return environmentOverride !== undefined && environmentOverride.length > 0;
  }

  /**
   * Local-build-mode (#5561) runner integrity check. On the first call for a
   * platform it computes and pins the existing local runner's
   * SHA256, warning loudly that the release-pinned guard is relaxed. Subsequent
   * calls re-hash and compare against that pin while identity is unchanged;
   * a changed size or mtime accepts a rebuild without restarting the daemon.
   */
  private async assertLocalRunnerBinaryHash(
    platform: IOSCtrlProxyPlatform,
    phase: "post-extract" | "pre-launch",
  ): Promise<void> {
    const runnerChecksumTarget = this.getExpectedRunnerChecksumTarget();
    const runnerBinaryPath = await this.host.getRunnerBinaryPath(platform, runnerChecksumTarget);
    if (!runnerBinaryPath) {
      throw new ActionableError(`CtrlProxy runner binary missing for ${platform}`);
    }
    const { size, mtimeMs } = await fs.stat(runnerBinaryPath);
    const { checksum } = await this.host.computeFileSha256(runnerBinaryPath);
    const normalized = checksum.toLowerCase();
    const pinned = this.derivedLocalRunnerSha256.get(platform);
    if (pinned === undefined) {
      this.derivedLocalRunnerSha256.set(platform, { sha256: normalized, size, mtimeMs });
      logger.warn(
        `[IOSCtrlProxyBuilder] Local-build mode (${IOS_CTRL_PROXY_USE_LOCAL_BUILD_ENV}) active for ` +
          `${platform}: captured the existing local runner with derived SHA256 ${normalized}. ` +
          `The release-pinned integrity guard is intentionally bypassed for this run.`,
      );
      return;
    }
    // Local-dev opt-in accepts rebuilds by identity. An attacker who also changes
    // size/mtime within verify→spawn would be accepted; non-local runs retain the
    // release-pinned guard instead of this intentional trade-off.
    if (size !== pinned.size || mtimeMs !== pinned.mtimeMs) {
      this.derivedLocalRunnerSha256.set(platform, { sha256: normalized, size, mtimeMs });
      logger.info("[IOSCtrlProxyBuilder] New local build detected; runner SHA256 re-pinned", {
        platform,
        oldSha: pinned.sha256.slice(0, 12),
        newSha: normalized.slice(0, 12),
      });
      return;
    }
    if (normalized !== pinned.sha256) {
      throw new ActionableError(
        `CtrlProxy runner binary SHA256 changed (${phase}) for ${platform} under local-build mode. ` +
          `Pinned at first verification: ${pinned.sha256}, Got: ${normalized}. Refusing to launch a runner whose ` +
          `binary changed since it was verified (possible TOCTOU tampering).`,
      );
    }
    logger.info(`[IOSCtrlProxyBuilder] Local runner binary SHA256 re-verified (${phase})`, {
      platform,
      checksum: normalized,
    });
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
    if (this.host.isLocalBuildMode()) {
      await this.requireLocalBuildProducts(platform);
    }
    await this.assertDerivedDataDirOwnedByCurrentUid();
    await this.assertRunnerHashOrRepairCache(platform);
    await this.verifyRunnerCodesign(platform);
  }

  /**
   * Pre-launch runner hash gate with a one-shot cache repair (#10650). A
   * mismatch that is not a stale-cache deferral invalidates the cached release
   * entry (IPA, metadata, extracted tree), re-downloads and re-verifies the
   * bundle once, and re-checks the hash. Local builds, vendored bundles, explicit
   * runner SHA overrides and a disabled download have no trusted source to
   * repair from, and a platform whose repair already failed is not retried, so
   * this never loops; those paths fail closed with the recovery step.
   */
  private async assertRunnerHashOrRepairCache(platform: IOSCtrlProxyPlatform): Promise<void> {
    try {
      await this.assertRunnerBinaryHash(platform, "pre-launch");
      this.failedRunnerRepairs.delete(platform);
      return;
    } catch (error) {
      if (!(error instanceof ActionableError) || error instanceof CtrlProxyStaleRunnerCacheError) {
        throw error;
      }
      const noSource = this.describeNoRepairSource();
      if (noSource !== null || this.failedRunnerRepairs.has(platform)) {
        throw this.withCacheRecoveryStep(error, noSource ?? "a previous re-download did not help");
      }
      logger.warn(
        `[IOSCtrlProxyBuilder] Pre-launch runner hash mismatch for ${platform}; invalidating the cached bundle and re-downloading once`,
        error,
      );
      this.failedRunnerRepairs.add(platform);
      await this.host.invalidateCachedBundle();
      const rebuilt = await this.host.build(platform);
      if (!rebuilt.success) {
        throw this.withCacheRecoveryStep(
          error,
          `re-download failed: ${rebuilt.error ?? "unknown"}`,
        );
      }
      try {
        await this.assertRunnerBinaryHash(platform, "pre-launch");
      } catch (retryError) {
        throw this.withCacheRecoveryStep(
          retryError instanceof ActionableError ? retryError : error,
          "the re-downloaded bundle still failed verification",
        );
      }
      this.failedRunnerRepairs.delete(platform);
    }
  }

  /** Why no trusted re-download source exists, or null when one does. */
  private describeNoRepairSource(): string | null {
    if (this.host.isLocalBuildMode()) {
      return `${IOS_CTRL_PROXY_USE_LOCAL_BUILD_ENV} is set, so the products are local builds`;
    }
    if (this.host.getBundlePathOverride() !== null) {
      return "a vendored bundle path override (AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH/BUNDLE_PATH) is in use";
    }
    if (this.hasExplicitRunnerShaOverride()) {
      return `${IOS_CTRL_PROXY_RUNNER_SHA256_ENV} pins a source-built runner`;
    }
    if (readEnvBool(ENV.SKIP_CTRL_PROXY_DOWNLOAD)) {
      return `${SKIP_CTRL_PROXY_DOWNLOAD_ENV} disables downloads`;
    }
    return null;
  }

  private withCacheRecoveryStep(error: ActionableError, reason: string): ActionableError {
    return new ActionableError(
      `${error.message} Not repaired automatically: ${reason}. To recover, delete ` +
        `${this.host.derivedDataPath} and ${this.host.bundleCacheDir} and retry ` +
        `(the bundle is downloaded again).`,
    );
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
      logger.debug(
        `[IOSCtrlProxyBuilder] codesign verification skipped on ${process.platform} (macOS-only)`,
      );
      return;
    }

    const appPath = await this.host.getRunnerAppPath(platform);
    if (!appPath) {
      logger.warn(
        `[IOSCtrlProxyBuilder] Runner app bundle missing for ${platform}; skipping codesign verification`,
      );
      return;
    }

    const requireCodesign = readEnvBool(ENV.IOS_HELPER_REQUIRE_CODESIGN);
    const pinnedTeamId = readEnvTrimmed(ENV.IOS_HELPER_TEAM_ID) ?? null;

    let outcome: CodesignVerificationOutcome;
    try {
      outcome = await this.inspectRunnerCodesign(appPath);
    } catch (error) {
      // The codesign/spctl tools themselves errored (e.g. not installed). Treat
      // as a non-fatal warning by default so a broken toolchain does not block
      // launch; fail closed only when the operator opted in.
      const message =
        `Code-signing verification could not run for the ${platform} runner: ` +
        `${errorMessage(error)}`;
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

    const summary =
      `Code-signing verification issues for the ${platform} runner: ${problems.join("; ")}.` +
      (outcome.detail ? ` (${outcome.detail})` : "");
    this.applyCodesignPolicy(summary, requireCodesign);
  }

  /** Cache an inspection only when the signed tree is stable across the check. */
  private async inspectRunnerCodesign(appPath: string): Promise<CodesignVerificationOutcome> {
    // The preceding gate hashes a selected executable, not the entire signed
    // tree. Include signatures/resources here so changing either invalidates it.
    const digest = await this.hashRunnerBundle(appPath);
    const key = `${appPath}:${digest}`;
    const cached = this.codesignOutcomes.get(key);
    if (cached) {
      return cached;
    }
    const outcome = await this.host.getSettings().codesignVerifier.verifyAppBundle(appPath);
    // Never associate an inspection of a changed tree with the pre-check digest.
    // A change is inconclusive for caching only; launch policy still uses this outcome.
    const verifiedDigest = await this.hashRunnerBundle(appPath);
    if (
      digest === verifiedDigest &&
      outcome.verified &&
      outcome.notarized === true &&
      outcome.cacheable !== false
    ) {
      this.codesignOutcomes.set(key, outcome);
    }
    return outcome;
  }

  /**
   * Apply the warn-vs-refuse policy for a code-signing problem (issue #4760).
   * DEFAULT = warn-and-proceed; refuse (throw {@link ActionableError}) only when
   * {@link IOS_HELPER_REQUIRE_CODESIGN_ENV} opts into fail-closed.
   */
  private applyCodesignPolicy(summary: string, requireCodesign: boolean, cause?: unknown): void {
    if (requireCodesign) {
      throw new ActionableError(
        `${summary} Refusing to launch because ${IOS_HELPER_REQUIRE_CODESIGN_ENV} is set.`,
      );
    }
    const message =
      `[IOSCtrlProxyBuilder] ${summary} Proceeding anyway — code signing is not OS-enforced on the ` +
      `simulator, and the #4759 SHA-256 check already covers integrity. Set ` +
      `${IOS_HELPER_REQUIRE_CODESIGN_ENV}=1 to refuse launch, and ${IOS_HELPER_TEAM_ID_ENV} to pin a Team ID.`;
    if (cause === undefined) {
      logger.warn(message);
      return;
    }
    logger.warn(message, cause);
  }

  /** Path to the extracted runner `.app` bundle codesign verifies (issue #4760). */
  public async getRunnerAppPath(
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<string | null> {
    const buildPath = await this.host.getBuildProductsPath(platform);
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
      logger.debug(`src/ctrlProxy/IosCtrlProxyBuilder.ts fallback failed: ${error}`, error);
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
  public async assertDerivedDataDirOwnedByCurrentUid(): Promise<void> {
    const getuid = process.getuid?.bind(process);
    if (process.platform === "win32" || !getuid) {
      return;
    }
    let stats;
    try {
      stats = await fs.stat(this.host.derivedDataPath);
    } catch (error) {
      // Directory does not exist yet (first extraction) — nothing to refuse. Any
      // other stat error is treated the same: the create step that follows will
      // surface a real failure with a clearer message.
      logger.debug(
        `[IOSCtrlProxyBuilder] derived-data stat failed (treated as absent): ${error}`,
        error,
      );
      return;
    }
    const currentUid = getuid();
    if (stats.uid !== currentUid) {
      throw new ActionableError(
        `Refusing to reuse CtrlProxy derived-data directory ${this.host.derivedDataPath}: it is ` +
          `owned by uid ${stats.uid}, not the current uid ${currentUid}. Another user may have pre-seeded ` +
          `or tampered with it. Delete it, or set AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA to a directory you own.`,
      );
    }
  }

  public needsMetadataRefresh(
    metadata: IOSCtrlProxyBundleMetadata | null,
    expectedChecksum: string,
  ): boolean {
    if (expectedChecksum.length > 0) {
      if (!metadata || metadata.checksum?.toLowerCase() !== expectedChecksum.toLowerCase()) {
        logger.info("[IOSCtrlProxyBuilder] CtrlProxy checksum mismatch, need download");
        return true;
      }
    } else if (!metadata) {
      logger.info("[IOSCtrlProxyBuilder] CtrlProxy metadata missing, need download");
      return true;
    }

    return false;
  }

  public async getAppBundlePath(
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<string | null> {
    const buildPath = await this.host.getBuildProductsPath(platform);
    if (!buildPath) {
      return null;
    }
    // Older published archives retain the fixture app's previous product name.
    for (const appName of ["AutoMobileTest.app", "CtrlProxyApp.app"]) {
      const appPath = path.join(buildPath, appName);
      try {
        await fs.access(appPath);
        return appPath;
      } catch (error) {
        // An absent candidate is expected for legacy bundles; try the next product name.
        logger.debug(`[IOSCtrlProxyBuilder] Fixture app not found at ${appPath}: ${error}`, error);
      }
    }
    return null;
  }

  public async getAppBundleHash(
    platform: IOSCtrlProxyPlatform = "simulator",
  ): Promise<string | null> {
    const cached = this.cachedAppBundleHash.get(platform);
    if (cached) {
      return cached;
    }
    const appPath = await this.host.getAppBundlePath(platform);
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
      logger.debug(`src/ctrlProxy/IosCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  public getBundlePath(): string {
    return path.join(this.host.bundleCacheDir, IosRunnerArtifactVerifier.DEFAULT_BUNDLE_FILENAME);
  }

  public getExpectedChecksum(): string {
    const override = this.host.getSettings().expectedChecksum;
    if (override !== null) {
      return override;
    }
    return resolveIpaChecksum();
  }

  public async readBundleMetadata(): Promise<IOSCtrlProxyBundleMetadata | null> {
    try {
      const raw = await fs.readFile(this.getMetadataPath(), "utf-8");
      return JSON.parse(raw) as IOSCtrlProxyBundleMetadata;
    } catch (error) {
      // Metadata file is missing or its JSON is malformed/stale; null just means
      // "no cached metadata", so the caller recomputes it from the bundle.
      logger.debug(`src/ctrlProxy/IosCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  public getMetadataPath(): string {
    return path.join(this.host.bundleCacheDir, IosRunnerArtifactVerifier.METADATA_FILENAME);
  }

  public async normalizeExtractedBundle(): Promise<void> {
    const xctestrunFiles = await this.host.findXctestrunFiles(this.host.derivedDataPath);
    if (xctestrunFiles.length === 0) {
      throw new Error("No .xctestrun file found in extracted CtrlProxy bundle");
    }

    const derivedRoot = this.resolveDerivedDataRoot(xctestrunFiles[0]);
    if (!derivedRoot) {
      return;
    }

    if (derivedRoot === this.host.derivedDataPath) {
      return;
    }

    const sourceBuildDir = path.join(derivedRoot, "Build");
    const targetBuildDir = path.join(this.host.derivedDataPath, "Build");

    await fs.rm(targetBuildDir, { recursive: true, force: true });
    await ensureSecureDir(this.host.derivedDataPath);

    try {
      await fs.rename(sourceBuildDir, targetBuildDir);
    } catch (error) {
      logger.warn(`CtrlProxy bundle rename failed; copying instead: ${errorMessage(error)}`, error);
      await fs.cp(sourceBuildDir, targetBuildDir, { recursive: true });
      await fs.rm(sourceBuildDir, { recursive: true, force: true });
    }
  }

  public async computeAppHashes(): Promise<Partial<Record<IOSCtrlProxyPlatform, string>>> {
    const hashes: Partial<Record<IOSCtrlProxyPlatform, string>> = {};
    const simulatorHash = await this.host.getAppBundleHash("simulator");
    if (simulatorHash) {
      hashes.simulator = simulatorHash;
    }
    const deviceHash = await this.host.getAppBundleHash("device");
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

  public async findXctestrunFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    const stack: string[] = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = await sortedReaddirEntries(current);
      } catch (error) {
        logger.warn(`CtrlProxy xctestrun directory scan failed: ${errorMessage(error)}`, error);
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

  public clearAppBundleHashes(): void {
    this.cachedAppBundleHash.clear();
  }

  public async needsAppHashRefresh(
    platform: IOSCtrlProxyPlatform | undefined,
    metadata: IOSCtrlProxyBundleMetadata | null,
  ): Promise<boolean> {
    if (platform) {
      const expectedAppHash = this.host.getExpectedAppHash(platform);
      if (expectedAppHash) {
        const localHash = await this.host.getAppBundleHash(platform);
        if (!localHash || localHash.toLowerCase() !== expectedAppHash.toLowerCase()) {
          logger.info("[IOSCtrlProxyBuilder] CtrlProxy app hash mismatch, need download");
          return true;
        }
        if (!metadata?.appHashes?.[platform]) {
          logger.info(
            "[IOSCtrlProxyBuilder] CtrlProxy app hash missing from metadata, need download",
          );
          return true;
        }
      }
    }

    return false;
  }
}
