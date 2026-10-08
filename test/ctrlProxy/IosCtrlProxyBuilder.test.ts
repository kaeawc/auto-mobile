import { promises as fsPromises } from "node:fs";
import { ActionableError } from "../../src/models/ActionableError";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  CtrlProxyStaleRunnerCacheError,
  IOS_CTRL_PROXY_RUNNER_SHA256_ENV,
  IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV,
  IosCtrlProxyBuilder,
} from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import {
  RELEASE_CHECKSUM_REGISTRY,
  resolveAssetVersion,
  resolvePinnedVersion,
} from "../../src/constants/release";
import { FakeIOSCtrlProxyBundleDownloader } from "../fakes/FakeIOSCtrlProxyBundleDownloader";
import { FakeCtrlProxyCodesignVerifier } from "../fakes/FakeCtrlProxyCodesignVerifier";
import { getSharedAutoMobileDir, getTempDir } from "../../src/utils/tempDir";
import * as fs from "fs/promises";
import * as path from "path";
import os from "os";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { parsePlist } from "../../src/utils/ios-cmdline-tools/XctestrunPlist";
import { logger } from "../../src/utils/logger";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";

describe("IosCtrlProxyBuilder", function () {
  let originalProjectRoot: string | undefined;
  let originalDerivedDataPath: string | undefined;
  let originalSkipDownload: string | undefined;
  let originalCacheDir: string | undefined;
  let originalIpaPath: string | undefined;
  let originalBundlePath: string | undefined;
  let originalLaunchCwd: string | undefined;
  let originalRunnerSha256: string | undefined;
  let originalRunnerSha256Target: string | undefined;
  let tempDir: string;

  test("finds legacy fixture bundles and prefers the renamed product", async () => {
    const builder = IosCtrlProxyBuilder.getInstance();
    const products = spyOn(builder, "getBuildProductsPath").mockResolvedValue(tempDir);
    try {
      const legacy = path.join(tempDir, "CtrlProxyApp.app");
      const renamed = path.join(tempDir, "AutoMobileTest.app");
      await fs.mkdir(legacy);
      expect(await builder.getAppBundlePath()).toBe(legacy);
      await fs.mkdir(renamed);
      expect(await builder.getAppBundlePath()).toBe(renamed);
    } finally {
      products.mockRestore();
    }
  });

  test("stale build-products cache is cleared and rediscovered", async () => {
    const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
    const cached = path.join(tempDir, "stale");
    builder["cachedBuildProductsPath"].set("simulator", cached);
    const access = spyOn(fs, "access").mockImplementation(async (file) => {
      if (file === cached) {
        throw new Error("removed");
      }
    });
    const log = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      expect(await builder.getBuildProductsPath()).toBe(
        path.join(tempDir, "Build", "Products", "Debug-iphonesimulator"),
      );
      expect(log).toHaveBeenCalledWith(
        "Cached build products probe failed: removed",
        expect.any(Error),
      );
    } finally {
      access.mockRestore();
      log.mockRestore();
    }
  });

  test("stale xctestrun cache is cleared and rediscovered", async () => {
    const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
    const cached = path.join(tempDir, "stale.xctestrun");
    builder["cachedXctestrunPath"].set("any", cached);
    const access = spyOn(fs, "access").mockRejectedValue(new Error("removed"));
    const listing = spyOn(fsPromises, "readdir").mockResolvedValue(["fresh.xctestrun"]);
    const log = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      expect(await builder.getXctestrunPath()).toBe(
        path.join(tempDir, "Build", "Products", "fresh.xctestrun"),
      );
      expect(log).toHaveBeenCalledWith("Cached xctestrun probe failed: removed", expect.any(Error));
    } finally {
      access.mockRestore();
      listing.mockRestore();
      log.mockRestore();
    }
  });

  test("artifact discovery rejection retains its typed failure and warns", async () => {
    const builder = IosCtrlProxyBuilder.getInstance();
    const original = builder["doBuild"];
    builder["doBuild"] = async () => ({ success: true, message: "ready" });
    const discovery = spyOn(builder, "getBuildProductsPath").mockRejectedValue(
      new Error("discovery failed"),
    );
    const log = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await builder.build()).toEqual({
        success: false,
        message: "CtrlProxy artifact discovery failed",
        error: "discovery failed",
      });
      expect(log).toHaveBeenCalledWith(
        "CtrlProxy artifact discovery failed: discovery failed",
        expect.any(Error),
      );
    } finally {
      builder["doBuild"] = original;
      discovery.mockRestore();
      log.mockRestore();
    }
  });

  test("download rejection retains its typed failure and warns", async () => {
    const builder = IosCtrlProxyBuilder.getInstance();
    const original = builder["ensureBundleDownloaded"];
    builder["ensureBundleDownloaded"] = async () => {
      throw new Error("download unavailable");
    };
    const log = spyOn(logger, "warn").mockImplementation(() => {});
    delete process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD;
    try {
      expect(await builder.build()).toEqual({
        success: false,
        message: "CtrlProxy download failed",
        error: "download unavailable",
      });
      expect(log).toHaveBeenCalledWith(
        "[IOSCtrlProxyBuilder] Download failed: download unavailable",
        expect.any(Error),
      );
    } finally {
      builder["ensureBundleDownloaded"] = original;
      log.mockRestore();
    }
  });

  test("failed bundle rename copies and removes the source tree", async () => {
    const builder = IosCtrlProxyBuilder.getInstance({
      derivedDataPath: path.join(tempDir, "target"),
    });
    const original = builder["findXctestrunFiles"];
    builder["findXctestrunFiles"] = async () => [
      path.join(tempDir, "source", "Build", "Products", "runner.xctestrun"),
    ];
    const rename = spyOn(fs, "rename").mockRejectedValue(new Error("cross-device"));
    const copy = spyOn(fs, "cp").mockResolvedValue(undefined);
    const remove = spyOn(fs, "rm").mockResolvedValue(undefined);
    const log = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await builder["normalizeExtractedBundle"]()).toBeUndefined();
      expect(copy).toHaveBeenCalledWith(
        path.join(tempDir, "source", "Build"),
        path.join(tempDir, "target", "Build"),
        { recursive: true },
      );
      expect(remove).toHaveBeenCalledWith(path.join(tempDir, "source", "Build"), {
        recursive: true,
        force: true,
      });
      expect(log).toHaveBeenCalledWith(
        "CtrlProxy bundle rename failed; copying instead: cross-device",
        expect.any(Error),
      );
    } finally {
      builder["findXctestrunFiles"] = original;
      rename.mockRestore();
      copy.mockRestore();
      remove.mockRestore();
      log.mockRestore();
    }
  });

  test("unreadable xctestrun scan retains an empty result and warns", async () => {
    const builder = IosCtrlProxyBuilder.getInstance();
    const listing = spyOn(fsPromises, "readdir").mockRejectedValue(new Error("permission denied"));
    const log = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await builder["findXctestrunFiles"]("unreadable")).toEqual([]);
      expect(log).toHaveBeenCalledWith(
        "CtrlProxy xctestrun directory scan failed: permission denied",
        expect.any(Error),
      );
    } finally {
      listing.mockRestore();
      log.mockRestore();
    }
  });

  beforeEach(async function () {
    // Save original environment
    originalProjectRoot = process.env.AUTOMOBILE_PROJECT_ROOT;
    originalDerivedDataPath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA;
    originalSkipDownload = process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD;
    originalCacheDir = process.env.AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR;
    originalIpaPath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH;
    originalBundlePath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
    originalRunnerSha256 = process.env[IOS_CTRL_PROXY_RUNNER_SHA256_ENV];
    originalRunnerSha256Target = process.env[IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV];

    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrl-proxy-ios-builder-test-"));

    // Reset singleton instances
    IosCtrlProxyBuilder.resetInstances();
    IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("");
    // Default to a passing, in-process codesign verifier so pre-launch tests
    // never spawn a real `codesign`/`spctl` (issue #4760).
    IosCtrlProxyBuilder.setCodesignVerifierForTesting(new FakeCtrlProxyCodesignVerifier());
    delete process.env.AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN;
    delete process.env.AUTOMOBILE_IOS_HELPER_TEAM_ID;
  });

  afterEach(async function () {
    // Restore original environment
    if (originalProjectRoot === undefined) {
      delete process.env.AUTOMOBILE_PROJECT_ROOT;
    } else {
      process.env.AUTOMOBILE_PROJECT_ROOT = originalProjectRoot;
    }

    if (originalDerivedDataPath === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA = originalDerivedDataPath;
    }

    if (originalSkipDownload === undefined) {
      delete process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD;
    } else {
      process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD = originalSkipDownload;
    }

    if (originalCacheDir === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR = originalCacheDir;
    }

    if (originalIpaPath === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = originalIpaPath;
    }

    if (originalBundlePath === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = originalBundlePath;
    }

    if (originalLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
    }

    if (originalRunnerSha256 === undefined) {
      delete process.env[IOS_CTRL_PROXY_RUNNER_SHA256_ENV];
    } else {
      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_ENV] = originalRunnerSha256;
    }

    if (originalRunnerSha256Target === undefined) {
      delete process.env[IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV];
    } else {
      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV] = originalRunnerSha256Target;
    }

    delete process.env.AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN;
    delete process.env.AUTOMOBILE_IOS_HELPER_TEAM_ID;

    // Reset singleton instances
    IosCtrlProxyBuilder.resetInstances();

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getInstance", function () {
    test("should return same instance for same configuration", function () {
      const instance1 = IosCtrlProxyBuilder.getInstance();
      const instance2 = IosCtrlProxyBuilder.getInstance();

      expect(instance1).toBe(instance2);
    });

    test("should return different instances for different configurations", function () {
      const instance1 = IosCtrlProxyBuilder.getInstance();
      const instance2 = IosCtrlProxyBuilder.getInstance({ projectRoot: "/different/path" });

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("getInstalledBundleVersion", function () {
    test("invalidates the previous version when re-extraction fails after replacing the tree", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const bundleCacheDir = path.join(tempDir, "cache");
      const overridePath = path.join(tempDir, "replacement.ipa");
      await fs.mkdir(bundleCacheDir);
      await fs.writeFile(
        path.join(bundleCacheDir, "ctrl-proxy-ios-bundle.json"),
        JSON.stringify({ version: "previous-release", checksum: null, extractedAt: "old" }),
      );
      await fs.writeFile(overridePath, "a".repeat(12000));
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = overridePath;
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "replacement-checksum";
      downloader.runnerChecksum = "wrong-runner-checksum";
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("replacement-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("expected-runner-checksum", "xctest");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir },
        { downloader },
      );

      const result = await builder.build("simulator");
      expect(downloader.extractedPaths).toEqual([derivedDataPath]);
      expect(result.success).toBe(false);
      expect(result.error).toContain("runner binary SHA256 mismatch (post-extract)");
      expect(await builder.getInstalledBundleVersion()).toBeNull();
    });

    test("returns the persisted extracted bundle version", async function () {
      const cacheDir = path.join(tempDir, "bundle-cache");
      await fs.mkdir(cacheDir);
      await fs.writeFile(
        path.join(cacheDir, "ctrl-proxy-ios-bundle.json"),
        JSON.stringify({
          checksum: null,
          version: "2026.9.13",
          extractedAt: "2026-09-13T00:00:00Z",
        }),
      );

      const builder = IosCtrlProxyBuilder.getInstance({ bundleCacheDir: cacheDir });

      expect(await builder.getInstalledBundleVersion()).toBe("2026.9.13");
    });

    test("returns null when no extracted bundle metadata exists", async function () {
      const builder = IosCtrlProxyBuilder.getInstance({
        bundleCacheDir: path.join(tempDir, "missing-bundle-cache"),
      });

      expect(await builder.getInstalledBundleVersion()).toBeNull();
    });
  });

  describe("getConfig", function () {
    test("should return default configuration when no overrides", function () {
      const builder = IosCtrlProxyBuilder.getInstance();
      const config = builder.getConfig();

      expect(config.scheme).toBe("AutoMobileTest");
      expect(config.destination).toBe("generic/platform=iOS Simulator");
      // getTempDir() uses the uid-private default and honors the explicit
      // AUTOMOBILE_DATA_DIR override used by CI.
      expect(config.derivedDataPath).toBe(getTempDir("derived-data"));
      expect(config.bundleCacheDir).toBe(getSharedAutoMobileDir("ctrl-proxy-ios"));
    });

    test("should respect environment variable overrides", function () {
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA = "/custom/derived/data";
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR = "/custom/cache";

      // Reset instances to pick up new env
      IosCtrlProxyBuilder.resetInstances();

      const builder = IosCtrlProxyBuilder.getInstance();
      const config = builder.getConfig();

      expect(config.derivedDataPath).toBe("/custom/derived/data");
      expect(config.bundleCacheDir).toBe("/custom/cache");
    });

    test("should respect constructor config overrides", function () {
      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath: "/override/path",
        scheme: "CustomScheme",
        bundleCacheDir: "/override/cache",
      });
      const config = builder.getConfig();

      expect(config.derivedDataPath).toBe("/override/path");
      expect(config.scheme).toBe("CustomScheme");
      expect(config.bundleCacheDir).toBe("/override/cache");
    });
  });

  describe("isPinnedVersionUnverifiable", function () {
    const withVersion = (value: string | undefined, fn: () => void) => {
      const prev = process.env.AUTOMOBILE_VERSION;
      if (value === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = value;
      }
      try {
        fn();
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prev;
        }
      }
    };

    test("false when no explicit pin (latest)", function () {
      withVersion(undefined, () =>
        expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(false),
      );
    });

    test("false for a known explicit pin", function () {
      withVersion("0.0.18", () =>
        expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(false),
      );
    });

    test("true for an unknown explicit pin", function () {
      withVersion("99.99.99", () =>
        expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(true),
      );
    });

    test("false for an unknown pin when a vendored IPA path is set", function () {
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = "/opt/automobile/control-proxy.ipa";
      withVersion("99.99.99", () =>
        expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(false),
      );
    });
  });

  describe("needsRebuild", function () {
    test.each([
      {
        checksum: "wrong",
        expectedChecksum: "expected",
        localHash: "expected-app",
        storedHash: "expected-app",
        result: true,
        message: "checksum mismatch",
      },
      {
        checksum: "expected",
        expectedChecksum: "expected",
        localHash: "wrong",
        storedHash: "expected-app",
        result: true,
        message: "app hash mismatch",
      },
      {
        checksum: "expected",
        expectedChecksum: "expected",
        localHash: null,
        storedHash: "expected-app",
        result: true,
        message: "app hash mismatch",
      },
      {
        checksum: "expected",
        expectedChecksum: "expected",
        localHash: "expected-app",
        storedHash: undefined,
        result: true,
        message: "app hash missing from metadata",
      },
      {
        checksum: "EXPECTED",
        expectedChecksum: "expected",
        localHash: "EXPECTED-APP",
        storedHash: "expected-app",
        result: false,
        message: "up to date",
      },
    ])(
      "checks cached identity $message",
      async ({ checksum, expectedChecksum, localHash, storedHash, result, message }) => {
        const builder = IosCtrlProxyBuilder.getInstance({ bundleCacheDir: tempDir });
        await fs.writeFile(
          path.join(tempDir, "ctrl-proxy-ios-bundle.json"),
          JSON.stringify({ checksum, appHashes: { simulator: storedHash } }),
        );
        IosCtrlProxyBuilder.setExpectedChecksumForTesting(expectedChecksum);
        const artifacts = spyOn(builder, "getXctestrunPath").mockResolvedValue("cached.xctestrun");
        const expected = spyOn(builder, "getExpectedAppHash").mockReturnValue("expected-app");
        const actual = spyOn(builder, "getAppBundleHash").mockResolvedValue(localHash);
        const info = spyOn(logger, "info").mockImplementation(() => {});
        try {
          expect(await builder.needsRebuild("simulator")).toBe(result);
          expect(info.mock.calls.at(-1)?.[0]).toContain(message);
        } finally {
          artifacts.mockRestore();
          expected.mockRestore();
          actual.mockRestore();
          info.mockRestore();
        }
      },
    );

    test("should return false when AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD is true", async function () {
      process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD = "true";

      // Reset instances to pick up new env
      IosCtrlProxyBuilder.resetInstances();

      const builder = IosCtrlProxyBuilder.getInstance();
      const result = await builder.needsRebuild();

      expect(result).toBe(false);
    });

    test("should return false when AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD is 1", async function () {
      process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD = "1";

      // Reset instances to pick up new env
      IosCtrlProxyBuilder.resetInstances();

      const builder = IosCtrlProxyBuilder.getInstance();
      const result = await builder.needsRebuild();

      expect(result).toBe(false);
    });

    test("should return true when build products don't exist", async function () {
      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath: path.join(tempDir, "nonexistent"),
        projectRoot: tempDir,
      });

      const result = await builder.needsRebuild();

      // Should return true because build products don't exist
      expect(result).toBe(true);
    });

    test("should return false when xctestrun and metadata match", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const productsDir = path.join(derivedDataPath, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      await fs.writeFile(
        path.join(productsDir, "AutoMobileTest_iphonesimulator.xctestrun"),
        "mock",
      );

      const cacheDir = path.join(tempDir, "cache");
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        path.join(cacheDir, "ctrl-proxy-ios-bundle.json"),
        JSON.stringify({
          checksum: "test-checksum",
          version: "latest",
          extractedAt: new Date().toISOString(),
        }),
      );

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("test-checksum");
      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath,
        bundleCacheDir: cacheDir,
      });

      const result = await builder.needsRebuild("simulator");
      expect(result).toBe(false);
    });

    test("fails closed on an unknown pin instead of reusing a cached bundle (#2746)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      try {
        // A cached bundle + metadata exist, so without the guard needsRebuild would
        // return false and setup would silently reuse the cached (wrong-version) runner.
        const derivedDataPath = path.join(tempDir, "DerivedData");
        const productsDir = path.join(derivedDataPath, "Build", "Products");
        await fs.mkdir(productsDir, { recursive: true });
        await fs.writeFile(
          path.join(productsDir, "AutoMobileTest_iphonesimulator.xctestrun"),
          "mock",
        );
        const cacheDir = path.join(tempDir, "cache");
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(
          path.join(cacheDir, "ctrl-proxy-ios-bundle.json"),
          JSON.stringify({
            checksum: "stale",
            version: "latest",
            extractedAt: new Date().toISOString(),
          }),
        );

        IosCtrlProxyBuilder.resetInstances();
        const builder = IosCtrlProxyBuilder.getInstance({
          derivedDataPath,
          bundleCacheDir: cacheDir,
        });

        await expect(builder.needsRebuild("simulator")).rejects.toThrow(
          "not in the AutoMobile release",
        );
      } finally {
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
      }
    });

    test("a vendored IPA path forces extraction even with a cached bundle on an unknown pin (#2746)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = path.join(tempDir, "vendored.ipa");
      try {
        // A cached bundle + metadata already exist (reused CI host): without the
        // override-forces-rebuild rule, needsRebuild() would return false and the
        // vendored IPA would be silently ignored in favor of the stale runner.
        const derivedDataPath = path.join(tempDir, "DerivedData");
        const productsDir = path.join(derivedDataPath, "Build", "Products");
        await fs.mkdir(productsDir, { recursive: true });
        await fs.writeFile(
          path.join(productsDir, "AutoMobileTest_iphonesimulator.xctestrun"),
          "mock",
        );
        const cacheDir = path.join(tempDir, "cache");
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(
          path.join(cacheDir, "ctrl-proxy-ios-bundle.json"),
          JSON.stringify({
            checksum: "stale",
            version: "latest",
            extractedAt: new Date().toISOString(),
          }),
        );

        IosCtrlProxyBuilder.resetInstances();
        const builder = IosCtrlProxyBuilder.getInstance({
          derivedDataPath,
          bundleCacheDir: cacheDir,
        });

        // No throw (vendored is the trusted escape hatch) AND forces a rebuild so
        // the vendored IPA is actually consumed.
        const result = await builder.needsRebuild("simulator");
        expect(result).toBe(true);
      } finally {
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
      }
    });
  });

  describe("getBuildProductsPath", function () {
    test("should return null when build products don't exist", async function () {
      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath: path.join(tempDir, "nonexistent"),
      });

      const result = await builder.getBuildProductsPath();

      expect(result).toBeNull();
    });

    test("should return path when build products exist", async function () {
      // Create fake build products directory
      const buildDir = path.join(tempDir, "Build", "Products", "Debug-iphonesimulator");
      await fs.mkdir(buildDir, { recursive: true });

      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath: tempDir,
      });

      const result = await builder.getBuildProductsPath();

      expect(result).toBe(buildDir);
    });
  });

  describe("getRunnerBinaryPath", function () {
    test("returns the CtrlProxy xctest executable rather than the XCTRunner stub", async function () {
      const buildDir = path.join(tempDir, "Build", "Products", "Debug-iphonesimulator");
      const runnerDir = path.join(buildDir, "CtrlProxyUITests-Runner.app");
      const xctestBinary = path.join(
        runnerDir,
        "PlugIns",
        "CtrlProxyUITests.xctest",
        "CtrlProxyUITests",
      );
      await fs.mkdir(path.dirname(xctestBinary), { recursive: true });
      await fs.writeFile(path.join(runnerDir, "CtrlProxyUITests-Runner"), "xctrunner-stub");
      await fs.writeFile(xctestBinary, "ctrl-proxy-code");

      const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });

      expect(await builder.getRunnerBinaryPath("simulator", "xctest")).toBe(xctestBinary);
      expect(await builder.getRunnerBinaryPath("simulator", "runner")).toBe(
        path.join(runnerDir, "CtrlProxyUITests-Runner"),
      );
    });
  });

  describe("getXctestrunPath", function () {
    test("should return null when xctestrun doesn't exist", async function () {
      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath: path.join(tempDir, "nonexistent"),
      });

      const result = await builder.getXctestrunPath();

      expect(result).toBeNull();
    });

    test("should return path when xctestrun exists", async function () {
      // Create fake build products directory and xctestrun file
      const productsDir = path.join(tempDir, "Build", "Products");
      const buildDir = path.join(productsDir, "Debug-iphonesimulator");
      await fs.mkdir(buildDir, { recursive: true });

      const xctestrunFile = path.join(productsDir, "AutoMobileTest_iphonesimulator.xctestrun");
      await fs.writeFile(xctestrunFile, "mock xctestrun content");

      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath: tempDir,
      });

      const result = await builder.getXctestrunPath();

      expect(result).toBe(xctestrunFile);
    });

    test("should prefer newest xctestrun file when multiple exist", async function () {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });

      const oldFile = path.join(
        productsDir,
        "AutoMobileTest_iphonesimulator26.0-arm64-x86_64.xctestrun",
      );
      const newFile = path.join(
        productsDir,
        "AutoMobileTest_iphonesimulator26.2-arm64-x86_64.xctestrun",
      );
      await fs.writeFile(oldFile, "old content");
      await fs.utimes(oldFile, new Date("2026-01-01"), new Date("2026-01-01"));
      await fs.writeFile(newFile, "new content");
      await fs.utimes(newFile, new Date("2026-04-01"), new Date("2026-04-01"));

      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath: tempDir,
      });

      const result = await builder.getXctestrunPath("simulator");

      expect(result).toBe(newFile);
    });
  });

  describe("writeRunnerEnvironment", function () {
    const SAMPLE_XCTESTRUN = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "\t<key>CtrlProxyUITests</key>",
      "\t<dict>",
      "\t\t<key>EnvironmentVariables</key>",
      "\t\t<dict>",
      "\t\t\t<key>TERM</key>",
      "\t\t\t<string>dumb</string>",
      "\t\t</dict>",
      "\t\t<key>IsUITestBundle</key>",
      "\t\t<true/>",
      "\t</dict>",
      "</dict>",
      "</plist>",
    ].join("\n");

    async function readUiTestEnv(xctestrunPath: string): Promise<Map<string, unknown>> {
      const xml = await fs.readFile(xctestrunPath, "utf-8");
      const root = (await parsePlist(xml)) as Map<string, unknown>;
      const uiTarget = root.get("CtrlProxyUITests") as Map<string, unknown>;
      return uiTarget.get("EnvironmentVariables") as Map<string, unknown>;
    }

    test("writes a per-launch copy carrying the injected port without mutating the source (EC3)", async function () {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(
        productsDir,
        "AutoMobileTest_iphonesimulator26.2-arm64-x86_64.xctestrun",
      );
      await fs.writeFile(sourcePath, SAMPLE_XCTESTRUN);

      const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      const outputPath = await builder.writeRunnerEnvironment(
        sourcePath,
        { CTRL_PROXY_IOS_PORT: "8767", AUTOMOBILE_DEVICE_ID: "SIM-UUID" },
        "SIM-UUID",
      );

      // New file, same directory, platform-token-free name.
      expect(outputPath).not.toBe(sourcePath);
      expect(path.dirname(outputPath)).toBe(productsDir);
      const baseName = path.basename(outputPath);
      expect(baseName).toBe("automobile-runner-SIM-UUID.xctestrun");
      expect(baseName.includes("iphonesimulator")).toBe(false);

      // Source untouched.
      expect(await fs.readFile(sourcePath, "utf-8")).toBe(SAMPLE_XCTESTRUN);

      // Per-launch copy carries the injected env plus the original entries.
      const env = await readUiTestEnv(outputPath);
      expect(env.get("CTRL_PROXY_IOS_PORT")).toBe("8767");
      expect(env.get("AUTOMOBILE_DEVICE_ID")).toBe("SIM-UUID");
      expect(env.get("TERM")).toBe("dumb");
    });

    test("per-launch copy is excluded from getXctestrunPath candidate globs", async function () {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(
        productsDir,
        "AutoMobileTest_iphonesimulator26.2-arm64-x86_64.xctestrun",
      );
      await fs.writeFile(sourcePath, SAMPLE_XCTESTRUN);

      const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      await builder.writeRunnerEnvironment(sourcePath, { CTRL_PROXY_IOS_PORT: "8767" }, "SIM-UUID");

      // The runner copy must not be re-selected as the source xctestrun.
      const resolved = await builder.getXctestrunPath("simulator");
      expect(resolved).toBe(sourcePath);
    });

    test("per-launch copy is excluded even from the platform-agnostic getXctestrunPath glob", async function () {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(
        productsDir,
        "AutoMobileTest_iphonesimulator26.2-arm64-x86_64.xctestrun",
      );
      await fs.writeFile(sourcePath, SAMPLE_XCTESTRUN);
      // Make the source older so a naive newest-mtime pick would prefer the copy.
      await fs.utimes(sourcePath, new Date("2026-01-01"), new Date("2026-01-01"));

      const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      const outputPath = await builder.writeRunnerEnvironment(
        sourcePath,
        { CTRL_PROXY_IOS_PORT: "8767" },
        "SIM-UUID",
      );
      await fs.utimes(outputPath, new Date("2026-06-01"), new Date("2026-06-01"));

      // No platform argument → no platform filter; the runner copy must still be skipped.
      const resolved = await builder.getXctestrunPath();
      expect(resolved).toBe(sourcePath);
    });

    test("sanitizes the device id used in the copy filename", async function () {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(productsDir, "AutoMobileTest_iphoneos.xctestrun");
      await fs.writeFile(sourcePath, SAMPLE_XCTESTRUN);

      const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      const outputPath = await builder.writeRunnerEnvironment(
        sourcePath,
        { CTRL_PROXY_IOS_PORT: "8767" },
        "00008030-001E/28C1 1E",
      );
      expect(path.basename(outputPath)).toBe("automobile-runner-00008030-001E_28C1_1E.xctestrun");
    });

    test("throws an actionable error naming the observed FormatVersion when the xctestrun has no UI-test bundle (EC4)", async function () {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(productsDir, "AutoMobileTest_iphonesimulator.xctestrun");
      await fs.writeFile(
        sourcePath,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<plist version="1.0">',
          "<dict>",
          "\t<key>CtrlProxyTests</key>",
          "\t<dict><key>IsUITestBundle</key><false/></dict>",
          "\t<key>__xctestrun_metadata__</key>",
          "\t<dict><key>FormatVersion</key><integer>1</integer></dict>",
          "</dict>",
          "</plist>",
        ].join("\n"),
      );

      const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      await expect(
        builder.writeRunnerEnvironment(sourcePath, { CTRL_PROXY_IOS_PORT: "8767" }, "SIM"),
      ).rejects.toThrow("no UI-test bundle");
      await expect(
        builder.writeRunnerEnvironment(sourcePath, { CTRL_PROXY_IOS_PORT: "8767" }, "SIM"),
      ).rejects.toThrow("FormatVersion: 1");
    });

    test("injects into a FormatVersion 2 (TestConfigurations[].TestTargets[]) xctestrun", async function () {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(
        productsDir,
        "CtrlProxyApp_iphonesimulator26.2-arm64-x86_64.xctestrun",
      );
      const V2_XCTESTRUN = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        "<dict>",
        "\t<key>TestConfigurations</key>",
        "\t<array>",
        "\t\t<dict>",
        "\t\t\t<key>TestTargets</key>",
        "\t\t\t<array>",
        "\t\t\t\t<dict>",
        "\t\t\t\t\t<key>BlueprintName</key>",
        "\t\t\t\t\t<string>CtrlProxyUITests</string>",
        "\t\t\t\t\t<key>IsUITestBundle</key>",
        "\t\t\t\t\t<true/>",
        "\t\t\t\t\t<key>EnvironmentVariables</key>",
        "\t\t\t\t\t<dict><key>TERM</key><string>dumb</string></dict>",
        "\t\t\t\t</dict>",
        "\t\t\t</array>",
        "\t\t</dict>",
        "\t</array>",
        "\t<key>__xctestrun_metadata__</key>",
        "\t<dict><key>FormatVersion</key><integer>2</integer></dict>",
        "</dict>",
        "</plist>",
      ].join("\n");
      await fs.writeFile(sourcePath, V2_XCTESTRUN);

      const builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      const outputPath = await builder.writeRunnerEnvironment(
        sourcePath,
        { CTRL_PROXY_IOS_PORT: "8767" },
        "SIM-UUID",
      );

      const xml = await fs.readFile(outputPath, "utf-8");
      const root = (await parsePlist(xml)) as Map<string, unknown>;
      const configurations = root.get("TestConfigurations") as unknown[];
      const configuration = configurations[0] as Map<string, unknown>;
      const testTargets = configuration.get("TestTargets") as unknown[];
      const uiTarget = testTargets[0] as Map<string, unknown>;
      const env = uiTarget.get("EnvironmentVariables") as Map<string, unknown>;
      expect(env.get("CTRL_PROXY_IOS_PORT")).toBe("8767");
      expect(env.get("TERM")).toBe("dumb");
    });
  });

  describe("cleanStaleXctestrunFiles", function () {
    test("should remove older xctestrun files keeping newest per platform", async function () {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });

      const oldFile = path.join(
        productsDir,
        "AutoMobileTest_iphonesimulator26.0-arm64-x86_64.xctestrun",
      );
      const newFile = path.join(
        productsDir,
        "AutoMobileTest_iphonesimulator26.2-arm64-x86_64.xctestrun",
      );
      await fs.writeFile(oldFile, "old content");
      await fs.utimes(oldFile, new Date("2026-01-01"), new Date("2026-01-01"));
      await fs.writeFile(newFile, "new content");
      await fs.utimes(newFile, new Date("2026-04-01"), new Date("2026-04-01"));

      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath: tempDir,
      });

      await builder.cleanStaleXctestrunFiles();

      const oldExists = await fs
        .access(oldFile)
        .then(() => true)
        .catch(() => false);
      const newExists = await fs
        .access(newFile)
        .then(() => true)
        .catch(() => false);
      expect(oldExists).toBe(false);
      expect(newExists).toBe(true);
    });
  });

  describe("cleanBuildArtifacts", function () {
    test("should remove derived data directory", async function () {
      // Create fake derived data
      const derivedDataPath = path.join(tempDir, "DerivedData");
      await fs.mkdir(derivedDataPath, { recursive: true });
      await fs.writeFile(path.join(derivedDataPath, "test.txt"), "test");

      const builder = IosCtrlProxyBuilder.getInstance({
        derivedDataPath,
      });

      await builder.cleanBuildArtifacts();

      // Verify directory was removed
      const exists = await fs
        .access(derivedDataPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe("static prefetch methods", function () {
    test("getPrefetchedResult should return null initially", function () {
      IosCtrlProxyBuilder.resetInstances();
      const result = IosCtrlProxyBuilder.getPrefetchedResult();
      expect(result).toBeNull();
    });

    test("getPrefetchError should return null initially", function () {
      IosCtrlProxyBuilder.resetInstances();
      const error = IosCtrlProxyBuilder.getPrefetchError();
      expect(error).toBeNull();
    });

    test("waitForPrefetch should return null when no prefetch started", async function () {
      IosCtrlProxyBuilder.resetInstances();
      const result = await IosCtrlProxyBuilder.waitForPrefetch();
      expect(result).toBeNull();
    });
  });

  describe("pre-launch stale runner cache classification (#7032)", function () {
    let originalPlatform: PropertyDescriptor | undefined;

    beforeEach(function () {
      // prefetchBuild() early-returns off macOS; force darwin so the in-flight
      // prefetch is observable on every CI host.
      originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      IosCtrlProxyBuilder.setIosPrerequisiteDetectorForTesting({
        hasIosPrerequisites: async () => true,
      });
    });

    afterEach(function () {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    });

    async function buildWithRunner(
      downloader: FakeIOSCtrlProxyBundleDownloader,
    ): Promise<IosCtrlProxyBuilder> {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );
      expect((await builder.build("simulator")).success).toBe(true);
      return builder;
    }

    test("a cached runner hashing to a previous release's runnerSha256 is stale-cache, not tampering", async function () {
      const previousRelease = RELEASE_CHECKSUM_REGISTRY[1];
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "new-release-runner-sha";
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("new-release-runner-sha", "xctest");
      const builder = await buildWithRunner(downloader);

      // The registry moved to a new release but the extracted runner on disk is
      // still the previous release's binary (no prefetch has replaced it yet).
      downloader.runnerChecksum = previousRelease.runnerSha256;

      const error = await builder.verifyRunnerBinaryBeforeLaunch("simulator").catch((e) => e);
      expect(error).toBeInstanceOf(CtrlProxyStaleRunnerCacheError);
      expect(error.message).toContain(
        `cached CtrlProxy runner is from ${previousRelease.version}; waiting for the ${resolveAssetVersion(resolvePinnedVersion())} bundle`,
      );
      expect(error.message).not.toContain("TOCTOU");
      expect(error.message).not.toContain("tampering");
    });

    test("a mismatch while the prefetch is in flight is stale-cache even for an unregistered hash", async function () {
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "new-release-runner-sha";
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("new-release-runner-sha", "xctest");
      const builder = await buildWithRunner(downloader);
      downloader.runnerChecksum = "nightly-runner-not-in-registry";

      const release = Promise.withResolvers<void>();
      IosCtrlProxyBuilder.setPrefetchBuilderForTesting({
        needsRebuild: async () => true,
        build: async () => {
          await release.promise;
          return { success: true, message: "prefetched" };
        },
        getBuildProductsPath: async () => null,
        getXctestrunPath: async () => null,
      });
      const first = IosCtrlProxyBuilder.prefetchBuild();
      expect(IosCtrlProxyBuilder.prefetchBuild()).toBe(first);
      expect(IosCtrlProxyBuilder.pendingPrefetch()).toBe(first);

      const error = await builder.verifyRunnerBinaryBeforeLaunch("simulator").catch((e) => e);
      expect(error).toBeInstanceOf(CtrlProxyStaleRunnerCacheError);
      expect(error.message).not.toContain("tampering");

      release.resolve();
      await first;
      expect(IosCtrlProxyBuilder.pendingPrefetch()).toBeNull();

      // Once the prefetch has landed the new runner, the pre-launch gate passes.
      downloader.runnerChecksum = "new-release-runner-sha";
      await builder.verifyRunnerBinaryBeforeLaunch("simulator");
    });

    test("a hash matching no known release with no prefetch in flight keeps the tampering refusal", async function () {
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "new-release-runner-sha";
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("new-release-runner-sha", "xctest");
      const builder = await buildWithRunner(downloader);
      downloader.runnerChecksum = "swapped-attacker-checksum";

      const error = await builder.verifyRunnerBinaryBeforeLaunch("simulator").catch((e) => e);
      expect(error).not.toBeInstanceOf(CtrlProxyStaleRunnerCacheError);
      expect(error.message).toContain("runner binary SHA256 mismatch (pre-launch)");
      expect(error.message).toContain("possible TOCTOU tampering");
    });

    test("post-extract mismatch against a previous release stays an integrity failure", async function () {
      const previousRelease = RELEASE_CHECKSUM_REGISTRY[1];
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = previousRelease.runnerSha256;
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("new-release-runner-sha", "xctest");
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath: path.join(tempDir, "DerivedData"),
          bundleCacheDir: path.join(tempDir, "cache"),
        },
        { downloader },
      );

      const result = await builder.build("simulator");
      expect(result.success).toBe(false);
      expect(result.error).toContain("runner binary SHA256 mismatch (post-extract)");
    });
  });

  describe("build", function () {
    test("records local override provenance instead of the pinned release version", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const overridePath = path.join(tempDir, "local-runner.ipa");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "local-override-checksum";
      await fs.writeFile(overridePath, "a".repeat(12000));
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = overridePath;
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("local-override-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      expect((await builder.build("simulator")).success).toBe(true);
      expect(await builder.getInstalledBundleVersion()).toBe(
        `local-override:${"local-override-checksum".slice(0, 12)}`,
      );
    });

    test("records a local override basename when no checksum is available", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const overridePath = path.join(tempDir, "runner-without-checksum.ipa");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      await fs.writeFile(overridePath, "a".repeat(12000));
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = overridePath;
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      expect((await builder.build("simulator")).success).toBe(true);
      expect(await builder.getInstalledBundleVersion()).toBe(
        `local-override:${path.basename(overridePath)}`,
      );
    });

    test("should download and extract bundle using downloader", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir,
        },
        { downloader },
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(true);
      expect(result.xctestrunPath).toBe(
        path.join(derivedDataPath, "Build", "Products", "AutoMobileTest_iphonesimulator.xctestrun"),
      );
      expect(downloader.downloadedUrls.length).toBe(1);
      expect(downloader.extractedPaths[0]).toBe(derivedDataPath);
    });

    test("should normalize nested bundle layouts", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.extractedSubdir = "NestedRoot";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir,
        },
        { downloader },
      );

      const result = await builder.build("simulator");
      const buildProducts = await builder.getBuildProductsPath("simulator");

      expect(result.success).toBe(true);
      expect(buildProducts).toBe(
        path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator"),
      );
    });

    test("verifies the xctest executable for releases that record an xctest checksum", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "xctest-checksum";
      downloader.legacyRunnerChecksum = "xctrunner-stub-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("xctest-checksum", "xctest");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(true);
      expect(downloader.checksummedFilePaths).toContain(
        path.join(
          derivedDataPath,
          "Build",
          "Products",
          "Debug-iphonesimulator",
          "CtrlProxyUITests-Runner.app",
          "PlugIns",
          "CtrlProxyUITests.xctest",
          "CtrlProxyUITests",
        ),
      );
    });

    test("fails when the xctest executable checksum differs", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "wrong-xctest-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("expected-xctest-checksum", "xctest");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(false);
      expect(result.error).toContain("runner binary SHA256 mismatch");
    });

    test("extracts the runner into a uid-private 0o700 directory, not /tmp (#4759)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      const result = await builder.build("simulator");
      expect(result.success).toBe(true);

      // Windows has no POSIX mode bits (fs.chmod only toggles read-only), so the
      // 0o700 assertion is POSIX-only.
      if (process.platform !== "win32") {
        const stats = await fs.stat(derivedDataPath);
        expect(stats.mode & 0o777).toBe(0o700);
      }
    });

    test("verifyRunnerBinaryBeforeLaunch re-verifies the hash and passes when unchanged (#4759)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "xctest-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("xctest-checksum", "xctest");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      await builder.build("simulator");
      const before = downloader.checksummedFilePaths.length;

      // Must not throw, and must re-hash the runner binary (a second computeFileSha256).
      await builder.verifyRunnerBinaryBeforeLaunch("simulator");
      expect(downloader.checksummedFilePaths.length).toBeGreaterThan(before);
    });

    test("source-built runner checksum override remains enforced before launch (#4966)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const sourceBuiltChecksum = "a".repeat(64);
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = sourceBuiltChecksum;

      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_ENV] = sourceBuiltChecksum;
      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV] = "xctest";
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting(null);
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      expect((await builder.build("simulator")).success).toBe(true);

      downloader.runnerChecksum = "b".repeat(64);
      await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
        "runner binary SHA256 mismatch (pre-launch)",
      );
    });

    test("rejects a malformed source-built runner checksum override (#4966)", async function () {
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";

      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_ENV] = "not-a-sha256";
      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV] = "xctest";
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting(null);
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath: path.join(tempDir, "DerivedData"),
          bundleCacheDir: path.join(tempDir, "cache"),
        },
        { downloader },
      );

      const result = await builder.build("simulator");
      expect(result.success).toBe(false);
      expect(result.error).toContain(`${IOS_CTRL_PROXY_RUNNER_SHA256_ENV} must be a 64-character`);
    });

    test("rejects an invalid source-built runner checksum target (#4966)", async function () {
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";

      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_ENV] = "a".repeat(64);
      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV] = "app";
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting(null);
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath: path.join(tempDir, "DerivedData"),
          bundleCacheDir: path.join(tempDir, "cache"),
        },
        { downloader },
      );

      const result = await builder.build("simulator");
      expect(result.success).toBe(false);
      expect(result.error).toContain(`${IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV} must be either`);
    });

    test("verifyRunnerBinaryBeforeLaunch refuses launch when the runner binary changed after extraction (#4759)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "xctest-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("xctest-checksum", "xctest");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      await builder.build("simulator");

      // Simulate a TOCTOU swap: the on-disk runner binary now hashes differently
      // than it did at extraction time.
      downloader.runnerChecksum = "swapped-attacker-checksum";

      await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
        "runner binary SHA256 mismatch (pre-launch)",
      );
    });

    describe("corrupted cached bundle repair (#10650)", function () {
      async function builtBuilder(): Promise<{
        builder: IosCtrlProxyBuilder;
        downloader: FakeIOSCtrlProxyBundleDownloader;
        derivedDataPath: string;
        cacheDir: string;
      }> {
        const derivedDataPath = path.join(tempDir, "DerivedData");
        const cacheDir = path.join(tempDir, "cache");
        const downloader = new FakeIOSCtrlProxyBundleDownloader();
        downloader.checksum = "expected-checksum";
        downloader.runnerChecksum = "xctest-checksum";
        IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
        IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("xctest-checksum", "xctest");
        const builder = IosCtrlProxyBuilder.getInstance(
          { derivedDataPath, bundleCacheDir: cacheDir },
          { downloader },
        );
        expect((await builder.build("simulator")).success).toBe(true);
        return { builder, downloader, derivedDataPath, cacheDir };
      }

      test("a corrupted cached runner is invalidated, re-downloaded once and launches", async function () {
        const { builder, downloader } = await builtBuilder();
        const downloadsBefore = downloader.downloadedUrls.length;
        let corrupted = true;
        const original = downloader.computeFileSha256.bind(downloader);
        downloader.computeFileSha256 = async (filePath: string) => {
          if (corrupted && path.basename(filePath) === "CtrlProxyUITests") {
            // Corruption is cleared once the extracted tree is replaced.
            corrupted = downloader.downloadedUrls.length === downloadsBefore;
            if (corrupted) {
              return { checksum: "corrupted", source: downloader.checksumSource };
            }
          }
          return original(filePath);
        };

        await builder.verifyRunnerBinaryBeforeLaunch("simulator");
        expect(downloader.downloadedUrls.length).toBe(downloadsBefore + 1);
      });

      test("a second mismatch fails with the cache directories to delete and does not loop", async function () {
        const { builder, downloader, derivedDataPath, cacheDir } = await builtBuilder();
        const downloadsBefore = downloader.downloadedUrls.length;
        downloader.runnerChecksum = "still-corrupted";

        const error = await builder.verifyRunnerBinaryBeforeLaunch("simulator").catch((e) => e);
        expect(error).toBeInstanceOf(ActionableError);
        expect(error.message).toContain("runner binary SHA256 mismatch (pre-launch)");
        expect(error.message).toContain(derivedDataPath);
        expect(error.message).toContain(cacheDir);
        expect(downloader.downloadedUrls.length).toBe(downloadsBefore + 1);

        // A later launch must not trigger another download.
        await builder.verifyRunnerBinaryBeforeLaunch("simulator").catch(() => {});
        expect(downloader.downloadedUrls.length).toBe(downloadsBefore + 1);
      });

      test("a vendored bundle override is never re-downloaded and the error names the override", async function () {
        const { builder, downloader, cacheDir } = await builtBuilder();
        const downloadsBefore = downloader.downloadedUrls.length;
        process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = path.join(tempDir, "vendored.ipa");
        downloader.runnerChecksum = "swapped";

        const error = await builder.verifyRunnerBinaryBeforeLaunch("simulator").catch((e) => e);
        expect(error).toBeInstanceOf(ActionableError);
        expect(error.message).toContain("AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH");
        expect(error.message).toContain(cacheDir);
        expect(downloader.downloadedUrls.length).toBe(downloadsBefore);
      });

      test("an explicit runner SHA override mismatch names the env and skips download", async function () {
        const { builder, downloader } = await builtBuilder();
        const downloadsBefore = downloader.downloadedUrls.length;
        process.env[IOS_CTRL_PROXY_RUNNER_SHA256_ENV] = "a".repeat(64);
        IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting(null);
        downloader.runnerChecksum = "b".repeat(64);

        const error = await builder.verifyRunnerBinaryBeforeLaunch("simulator").catch((e) => e);
        expect(error).toBeInstanceOf(ActionableError);
        expect(error.message).toContain(IOS_CTRL_PROXY_RUNNER_SHA256_ENV);
        expect(downloader.downloadedUrls.length).toBe(downloadsBefore);
      });
    });

    test("local-build mode trusts the freshly built runner even when its SHA differs from the release-pinned checksum (#5561)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "c".repeat(64);

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      // Release-pinned checksum the local build can never match.
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("a".repeat(64), "xctest");
      IosCtrlProxyBuilder.setUseLocalBuildForTesting(true);
      await new FakeIOSCtrlProxyBundleDownloader().extractBundle("fixture", derivedDataPath);
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      // Local verification must not reject on the release-pinned mismatch; it derives
      // and pins the local runner's hash instead.
      expect((await builder.build("simulator")).success).toBe(true);

      // Pre-launch re-verifies against the derived hash — unchanged, so it passes.
      await builder.verifyRunnerBinaryBeforeLaunch("simulator");
    });

    test("local-build mode still fails closed if the runner binary changes after verification (TOCTOU) (#5561)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "c".repeat(64);

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("a".repeat(64), "xctest");
      IosCtrlProxyBuilder.setUseLocalBuildForTesting(true);
      await new FakeIOSCtrlProxyBundleDownloader().extractBundle("fixture", derivedDataPath);
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      expect((await builder.build("simulator")).success).toBe(true);

      // Swap the on-disk binary after it was pinned at local verification.
      downloader.runnerChecksum = "d".repeat(64);

      await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
        "SHA256 changed",
      );
    });

    test("local-build mode re-derives the pin on an in-process rebuild (#5561)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "c".repeat(64);

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("a".repeat(64), "xctest");
      IosCtrlProxyBuilder.setUseLocalBuildForTesting(true);
      await new FakeIOSCtrlProxyBundleDownloader().extractBundle("fixture", derivedDataPath);
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      expect((await builder.build("simulator")).success).toBe(true);

      // A legitimate rebuild produces a different local binary. Explicit build() must
      // drop the stale pin so this is NOT rejected as a TOCTOU swap.
      downloader.runnerChecksum = "d".repeat(64);
      expect((await builder.build("simulator")).success).toBe(true);
      await builder.verifyRunnerBinaryBeforeLaunch("simulator");
    });

    test("explicit RUNNER_SHA256 override still wins over local-build mode (#5561)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "f".repeat(64);

      // Local-build mode is on, but an explicit SHA override is also set: the
      // explicit value must remain enforced (mismatch => hard refusal).
      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_ENV] = "e".repeat(64);
      process.env[IOS_CTRL_PROXY_RUNNER_SHA256_TARGET_ENV] = "xctest";
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting(null);
      IosCtrlProxyBuilder.setUseLocalBuildForTesting(true);
      await new FakeIOSCtrlProxyBundleDownloader().extractBundle("fixture", derivedDataPath);
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      const result = await builder.build("simulator");
      expect(result.success).toBe(false);
      expect(result.error).toContain("runner binary SHA256 mismatch");
    });

    test("refuses to reuse a derived-data directory owned by another uid (#4759)", async function () {
      if (process.platform === "win32" || typeof process.getuid !== "function") {
        // st_uid/getuid are POSIX-only; ownership refusal no-ops on win32.
        return;
      }

      const derivedDataPath = path.join(tempDir, "ForeignDerivedData");
      const cacheDir = path.join(tempDir, "cache");
      await fs.mkdir(derivedDataPath, { recursive: true });

      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader: new FakeIOSCtrlProxyBundleDownloader() },
      );

      const foreignUid = process.getuid()! + 1;
      const statSpy = spyOn(fs, "stat").mockResolvedValue({ uid: foreignUid } as Awaited<
        ReturnType<typeof fs.stat>
      >);
      try {
        await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
          `owned by uid ${foreignUid}`,
        );
      } finally {
        statSpy.mockRestore();
      }
    });

    async function buildForCodesign(): Promise<{
      builder: IosCtrlProxyBuilder;
      verifier: FakeCtrlProxyCodesignVerifier;
    }> {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.runnerChecksum = "xctest-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("xctest-checksum", "xctest");
      const verifier = new FakeCtrlProxyCodesignVerifier();
      IosCtrlProxyBuilder.setCodesignVerifierForTesting(verifier);

      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );
      await builder.build("simulator");
      return { builder, verifier };
    }

    test("verifyRunnerBinaryBeforeLaunch runs codesign against the runner app before launch (#4760)", async function () {
      if (process.platform !== "darwin") {
        // codesign/spctl are macOS-only; the check no-ops off darwin.
        return;
      }
      const { builder, verifier } = await buildForCodesign();

      await builder.verifyRunnerBinaryBeforeLaunch("simulator");

      expect(verifier.verifiedPaths).toHaveLength(1);
      expect(verifier.verifiedPaths[0].endsWith(path.join("CtrlProxyUITests-Runner.app"))).toBe(
        true,
      );
    });

    test("codesign verification is skipped (exec seam never invoked) on non-darwin (#4760)", async function () {
      if (process.platform === "darwin") {
        return;
      }
      const { builder, verifier } = await buildForCodesign();

      await builder.verifyRunnerBinaryBeforeLaunch("simulator");

      expect(verifier.verifiedPaths).toHaveLength(0);
    });

    test("codesign --verify failure warns and proceeds by default (#4760)", async function () {
      if (process.platform !== "darwin") {
        return;
      }
      const { builder, verifier } = await buildForCodesign();
      verifier.outcome = {
        verified: false,
        notarized: true,
        teamId: "ABCDE12345",
        detail: "bad seal",
      };

      const warn = spyOn(logger, "warn");
      try {
        // DEFAULT = warn-and-proceed: no throw.
        await builder.verifyRunnerBinaryBeforeLaunch("simulator");

        expect(verifier.verifiedPaths).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Code-signing verification issues"),
        );
      } finally {
        warn.mockRestore();
      }
    });

    test("codesign --verify failure refuses launch when require flag is set (#4760)", async function () {
      if (process.platform !== "darwin") {
        return;
      }
      const { builder, verifier } = await buildForCodesign();
      verifier.outcome = {
        verified: false,
        notarized: true,
        teamId: "ABCDE12345",
        detail: "bad seal",
      };
      process.env.AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN = "1";

      await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
        "Refusing to launch",
      );
    });

    test("Team-ID mismatch warns by default and refuses under the require flag (#4760)", async function () {
      if (process.platform !== "darwin") {
        return;
      }
      const { builder, verifier } = await buildForCodesign();
      verifier.outcome = { verified: true, notarized: true, teamId: "REALTEAMID", detail: "" };
      process.env.AUTOMOBILE_IOS_HELPER_TEAM_ID = "PINNEDTEAMID";

      // Mismatch alone warns and proceeds.
      await builder.verifyRunnerBinaryBeforeLaunch("simulator");

      // With the require flag it becomes a refusal.
      process.env.AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN = "1";
      await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
        "Team ID mismatch",
      );
    });

    test("matching pinned Team ID passes without warning (#4760)", async function () {
      if (process.platform !== "darwin") {
        return;
      }
      const { builder, verifier } = await buildForCodesign();
      verifier.outcome = { verified: true, notarized: true, teamId: "PINNEDTEAMID", detail: "" };
      process.env.AUTOMOBILE_IOS_HELPER_TEAM_ID = "PINNEDTEAMID";
      process.env.AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN = "1";

      // Fail-closed mode, but a matching Team ID and verified signature pass.
      await builder.verifyRunnerBinaryBeforeLaunch("simulator");
      expect(verifier.verifiedPaths).toHaveLength(1);
    });

    test("a broken codesign toolchain warns by default and refuses under the require flag (#4760)", async function () {
      if (process.platform !== "darwin") {
        return;
      }
      const { builder, verifier } = await buildForCodesign();
      verifier.throwError = new Error("codesign: command not found");

      // Tool error warns and proceeds by default.
      await builder.verifyRunnerBinaryBeforeLaunch("simulator");

      process.env.AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN = "1";
      await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
        "Refusing to launch",
      );
    });

    test.each(["0.0.83-dev", "0.0.83-nightly", "99.99.99"])(
      "an unregistered version %s is exempt only in local-build mode",
      (version) => {
        const previousVersion = process.env.AUTOMOBILE_VERSION;
        const previousLocalMode = process.env.AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD;
        process.env.AUTOMOBILE_VERSION = version;
        delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH;
        delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
        IosCtrlProxyBuilder.setExpectedChecksumForTesting(null);
        try {
          process.env.AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD = "true";
          expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(false);
          process.env.AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD = "false";
          expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(true);
          IosCtrlProxyBuilder.setUseLocalBuildForTesting(true);
          expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(false);
          process.env.AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD = "true";
          IosCtrlProxyBuilder.setUseLocalBuildForTesting(false);
          expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(true);
        } finally {
          IosCtrlProxyBuilder.setUseLocalBuildForTesting(null);
          if (previousVersion === undefined) {
            delete process.env.AUTOMOBILE_VERSION;
          } else {
            process.env.AUTOMOBILE_VERSION = previousVersion;
          }
          if (previousLocalMode === undefined) {
            delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD;
          } else {
            process.env.AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD = previousLocalMode;
          }
        }
      },
    );

    test("fails closed when AUTOMOBILE_VERSION is pinned to an unknown version (#2746)", async function () {
      const prev = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      try {
        const derivedDataPath = path.join(tempDir, "DerivedData");
        const cacheDir = path.join(tempDir, "cache");
        const downloader = new FakeIOSCtrlProxyBundleDownloader();
        downloader.checksum = "actual-checksum-from-download";
        // No expected-checksum override and no vendored IPA path: the pinned
        // version has no registry checksum, so the download is unverifiable.
        const builder = IosCtrlProxyBuilder.getInstance(
          { derivedDataPath, bundleCacheDir: cacheDir },
          { downloader },
        );

        const result = await builder.build("simulator");

        expect(result.success).toBe(false);
        expect(result.error).toContain("not in the AutoMobile release");
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prev;
        }
      }
    });

    test("should reject build when checksum does not match", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "actual-checksum-from-download";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("different-expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir,
        },
        { downloader },
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(false);
      expect(result.error).toContain("checksum verification failed");
    });

    test("should redownload when checksum changes", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      await fs.mkdir(cacheDir, { recursive: true });

      const existingBundle = path.join(cacheDir, "control-proxy.ipa");
      await fs.writeFile(existingBundle, "a".repeat(12000));
      await fs.writeFile(
        path.join(cacheDir, "ctrl-proxy-ios-bundle.json"),
        JSON.stringify({
          checksum: "old-checksum",
          version: "0.0.17",
          extractedAt: new Date().toISOString(),
        }),
      );

      let callCount = 0;
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      const origComputeSha = downloader.computeFileSha256.bind(downloader);
      downloader.computeFileSha256 = async (filePath: string) => {
        callCount++;
        if (callCount === 1) {
          return { checksum: "old-checksum", source: "node" as const };
        }
        return origComputeSha(filePath);
      };
      downloader.checksum = "new-checksum";
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("new-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir,
        },
        { downloader },
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(true);
      expect(downloader.downloadedUrls.length).toBe(1);
    });

    test.each([
      "AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH",
      "AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH",
    ] as const)("should resolve relative %s from daemon launch cwd", async function (envName) {
      const launchCwd = path.join(tempDir, "launch-cwd");
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const localBundlePath = path.join(launchCwd, "build", "control-proxy.ipa");
      await fs.mkdir(path.dirname(localBundlePath), { recursive: true });
      await fs.writeFile(localBundlePath, "a".repeat(12000));

      process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
      process.env[envName] = path.join("build", "control-proxy.ipa");

      IosCtrlProxyBuilder.resetInstances();
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("");
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir,
        },
        { downloader: new FakeIOSCtrlProxyBundleDownloader() },
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(true);
      await expect(fs.stat(path.join(cacheDir, "control-proxy.ipa"))).resolves.toMatchObject({
        size: 12000,
      });
    });

    test("refuses a checksum-mismatched cached bundle on the download-failed fallback (#4761)", async function () {
      // A size-valid but checksum-mismatched cached IPA already exists. Previously,
      // when the latest-mode download failed, build() reused it WITHOUT any checksum
      // check (usedCachedFallback skips extract+verify). Now verifyBundle runs on the
      // fallback bundle before reuse, so the stale/tampered cache is rejected.
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, "control-proxy.ipa"), "a".repeat(12000));

      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "cached-different-checksum";
      downloader.download = async () => {
        throw new Error("network unreachable");
      };

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(false);
      expect(result.error).toContain("checksum verification failed");
    });

    test("verifies then reuses a checksum-valid cached bundle on the download-failed fallback (#4761)", async function () {
      // Pre-existing extracted artifacts + a cached IPA. The latest-mode download
      // fails; the cached IPA is checksum-verified and only then reused (extraction
      // is skipped for the fallback path, so the downloader never re-extracts).
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const productsDir = path.join(derivedDataPath, "Build", "Products");
      await fs.mkdir(path.join(productsDir, "Debug-iphonesimulator"), { recursive: true });
      await fs.writeFile(
        path.join(productsDir, "AutoMobileTest_iphonesimulator.xctestrun"),
        "mock",
      );

      const cacheDir = path.join(tempDir, "cache");
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, "control-proxy.ipa"), "a".repeat(12000));

      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.download = async () => {
        throw new Error("network unreachable");
      };
      // First hash (pre-download validity probe) mismatches to force the download
      // attempt; the verifyBundle re-hash on the fallback path matches and passes.
      let shaCalls = 0;
      downloader.computeFileSha256 = async () => {
        shaCalls++;
        return {
          checksum: shaCalls === 1 ? "stale-checksum" : "expected-checksum",
          source: "node" as const,
        };
      };

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(true);
      // verifyBundle re-hashed the cached bundle (a second computeFileSha256 call).
      expect(shaCalls).toBeGreaterThanOrEqual(2);
      // Fallback path skips extraction entirely.
      expect(downloader.extractedPaths).toHaveLength(0);
    });

    test("rejects a plaintext http:// bundle URL override by default (#4761)", async function () {
      const prevUrl = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_URL;
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_URL = "http://mirror.test/control-proxy.ipa";
      try {
        const derivedDataPath = path.join(tempDir, "DerivedData");
        const cacheDir = path.join(tempDir, "cache");
        const downloader = new FakeIOSCtrlProxyBundleDownloader();
        downloader.checksum = "expected-checksum";
        IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
        const builder = IosCtrlProxyBuilder.getInstance(
          { derivedDataPath, bundleCacheDir: cacheDir },
          { downloader },
        );

        const result = await builder.build("simulator");

        expect(result.success).toBe(false);
        expect(result.error).toContain("must use https://");
      } finally {
        if (prevUrl === undefined) {
          delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_URL;
        } else {
          process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_URL = prevUrl;
        }
      }
    });

    test("re-hashes the device runner executable post-extract, not just simulator (#4761)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.includeDeviceProducts = true;
      downloader.runnerChecksum = "xctest-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("xctest-checksum", "xctest");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      const result = await builder.build("device");

      expect(result.success).toBe(true);
      // The device runner executable under Debug-iphoneos was independently hashed.
      expect(downloader.checksummedFilePaths).toContain(
        path.join(
          derivedDataPath,
          "Build",
          "Products",
          "Debug-iphoneos",
          "CtrlProxyUITests-Runner.app",
          "PlugIns",
          "CtrlProxyUITests.xctest",
          "CtrlProxyUITests",
        ),
      );
    });

    test("fails closed when the device runner executable hash differs (#4761)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.includeDeviceProducts = true;
      // Only the device runner executable is tampered; the simulator one matches.
      downloader.computeFileSha256 = async (filePath: string) => {
        if (path.basename(filePath) === "CtrlProxyUITests") {
          return {
            checksum: filePath.includes("Debug-iphoneos")
              ? "tampered-device-checksum"
              : "xctest-checksum",
            source: "node" as const,
          };
        }
        return { checksum: "expected-checksum", source: "node" as const };
      };

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("xctest-checksum", "xctest");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      const result = await builder.build("device");

      expect(result.success).toBe(false);
      expect(result.error).toContain("runner binary SHA256 mismatch");
    });

    test("concurrent build() calls single-flight: only one download/extract happens (#6417)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");

      let resolveDownload: (() => void) | undefined;
      const downloadGate = new Promise<void>((resolve) => {
        resolveDownload = resolve;
      });

      class DeferredDownloader extends FakeIOSCtrlProxyBundleDownloader {
        public override async download(url: string, destination: string): Promise<void> {
          await downloadGate;
          await super.download(url, destination);
        }
      }

      const downloader = new DeferredDownloader();
      downloader.checksum = "expected-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      // Both calls start before either has resolved the download, so the
      // second call must observe (and reuse) the first call's in-flight promise.
      const firstBuild = builder.build("simulator");
      const secondBuild = builder.build("simulator");

      resolveDownload!();

      const [firstResult, secondResult] = await Promise.all([firstBuild, secondBuild]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(secondResult).toEqual(firstResult);
      expect(downloader.downloadedUrls.length).toBe(1);
      expect(downloader.extractedPaths.length).toBe(1);
    });

    test.each([false, true])(
      "mixed platform callers resolve independently (device products: %s)",
      async function (includeDeviceProducts) {
        const derivedDataPath = path.join(tempDir, "DerivedData");
        const cacheDir = path.join(tempDir, "cache");

        let resolveDownload: (() => void) | undefined;
        const downloadGate = new Promise<void>((resolve) => {
          resolveDownload = resolve;
        });

        class DeferredDownloader extends FakeIOSCtrlProxyBundleDownloader {
          public override async download(url: string, destination: string): Promise<void> {
            await downloadGate;
            await super.download(url, destination);
          }
        }

        const downloader = new DeferredDownloader();
        downloader.checksum = "expected-checksum";
        downloader.includeDeviceProducts = includeDeviceProducts;

        IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
        const builder = IosCtrlProxyBuilder.getInstance(
          { derivedDataPath, bundleCacheDir: cacheDir },
          { downloader },
        );

        // Both calls start before either has resolved the download, so the
        // second call must observe (and reuse) the first call's in-flight promise.
        const firstBuild = builder.build("device");
        const secondBuild = builder.build("simulator");

        resolveDownload!();

        const [firstResult, secondResult] = await Promise.all([firstBuild, secondBuild]);

        expect(firstResult.success).toBe(includeDeviceProducts);
        expect(secondResult.success).toBe(true);
        expect(secondResult.buildPath).toContain("Debug-iphonesimulator");
        if (includeDeviceProducts) {
          expect(firstResult.buildPath).toContain("Debug-iphoneos");
        }
        expect(downloader.downloadedUrls.length).toBe(1);
        expect(downloader.extractedPaths.length).toBe(1);
      },
    );

    test("a second concurrent build() call never invokes the downloader's destructive extractBundle a second time (#6417)", async function () {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");

      let resolveDownload: (() => void) | undefined;
      const downloadGate = new Promise<void>((resolve) => {
        resolveDownload = resolve;
      });

      // Mirrors the real DefaultIOSCtrlProxyBundleDownloader's destructive
      // `fs.rm(destination, { recursive: true, force: true })` before
      // extracting (src/utils/IOSCtrlProxyBundleDownloader.ts:67-68). Counting
      // invocations proves the shared derived-data tree is torn down and
      // rebuilt at most once for a pair of overlapping build() calls, which is
      // the property that protects a live runner's on-disk bundle and any
      // per-device runner-<deviceId>.xctestrun another caller wrote in between.
      class DestructiveDeferredDownloader extends FakeIOSCtrlProxyBundleDownloader {
        public rmCount = 0;

        public override async download(url: string, destination: string): Promise<void> {
          await downloadGate;
          await super.download(url, destination);
        }

        public override async extractBundle(
          bundlePath: string,
          destination: string,
        ): Promise<void> {
          this.rmCount += 1;
          await fs.rm(destination, { recursive: true, force: true });
          await super.extractBundle(bundlePath, destination);
        }
      }

      const downloader = new DestructiveDeferredDownloader();
      downloader.checksum = "expected-checksum";

      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        { derivedDataPath, bundleCacheDir: cacheDir },
        { downloader },
      );

      // Both calls start before either has resolved the download, so the
      // second call must observe (and reuse) the first call's in-flight promise
      // instead of running its own independent rm-rf + re-extract.
      const firstBuild = builder.build("simulator");
      const secondBuild = builder.build("simulator");

      resolveDownload!();
      const [firstResult, secondResult] = await Promise.all([firstBuild, secondBuild]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(downloader.rmCount).toBe(1);
      expect(downloader.extractedPaths.length).toBe(1);
    });
    test("a failed shared download allows a subsequent build", async function () {
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      const download = downloader.download.bind(downloader);
      downloader.download = async () => {
        throw new Error("download unavailable");
      };
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath: path.join(tempDir, "DerivedData"),
          bundleCacheDir: path.join(tempDir, "cache"),
        },
        { downloader },
      );
      const [first, second] = await Promise.all([
        builder.build("device"),
        builder.build("simulator"),
      ]);
      expect(first.success).toBe(false);
      expect(second.success).toBe(false);
      downloader.download = download;
      expect((await builder.build("simulator")).success).toBe(true);
      expect(downloader.extractedPaths).toHaveLength(1);
    });
  });

  // Issue #10200: the shared bundle flight belongs to the builder, not to whichever
  // request created it. The fake binds to the ambient signal like
  // DefaultFileDownloader (`signal ??= getAbortSignal()`) and captures it.
  describe("shared bundle flight ownership (#10200)", function () {
    class SignalBoundDownloader extends FakeIOSCtrlProxyBundleDownloader {
      public readonly signals: Array<AbortSignal | undefined> = [];
      public gate = Promise.withResolvers<void>();
      public started = Promise.withResolvers<void>();

      public override async download(url: string, destination: string): Promise<void> {
        const signal = getAbortSignal();
        this.signals.push(signal);
        this.started.resolve();
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Download aborted")), {
            once: true,
          });
          void this.gate.promise.then(resolve);
        });
        // Like DefaultFileDownloader, nothing reaches `destination` unless the
        // transfer completed (temp file + rename).
        await super.download(url, destination);
      }
    }

    function createBuilder(downloader: SignalBoundDownloader) {
      downloader.checksum = "expected-checksum";
      IosCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      return IosCtrlProxyBuilder.getInstance(
        {
          derivedDataPath: path.join(tempDir, "DerivedData"),
          bundleCacheDir: path.join(tempDir, "cache"),
        },
        { downloader },
      );
    }

    test("a cancelled first caller does not fail or restart the download for a waiting second caller", async function () {
      const downloader = new SignalBoundDownloader();
      const builder = createBuilder(downloader);
      const first = new AbortController();

      const cancelled = runWithAbortSignal(first.signal, () => builder.build("simulator"));
      const survivor = runWithAbortSignal(undefined, () => builder.build("simulator"));
      first.abort(new Error("first caller cancelled"));

      // The cancelled caller stops waiting at once, before the download finishes.
      expect((await cancelled).success).toBe(false);
      await downloader.started.promise;
      expect(downloader.signals[0]?.aborted).toBe(false);

      downloader.gate.resolve();
      const result = await survivor;
      expect(result.success).toBe(true);
      expect(downloader.signals).toHaveLength(1);
      expect(downloader.extractedPaths).toHaveLength(1);
    });

    test("the download is cancelled once no waiter is left and leaves no bundle behind", async function () {
      const downloader = new SignalBoundDownloader();
      const builder = createBuilder(downloader);
      const first = new AbortController();
      const second = new AbortController();

      const results = Promise.all([
        runWithAbortSignal(first.signal, () => builder.build("simulator")),
        runWithAbortSignal(second.signal, () => builder.build("simulator")),
      ]);
      await downloader.started.promise;
      first.abort(new Error("first caller cancelled"));
      second.abort(new Error("second caller cancelled"));

      expect((await results).map((result) => result.success)).toEqual([false, false]);
      expect(downloader.signals[0]?.aborted).toBe(true);
      expect(await fs.readdir(path.join(tempDir, "cache"))).toEqual([]);
      expect(downloader.extractedPaths).toHaveLength(0);

      // A fresh call after the abandoned flight starts a new download and succeeds.
      downloader.gate.resolve();
      expect((await builder.build("simulator")).success).toBe(true);
      expect(downloader.signals).toHaveLength(2);
      expect(downloader.signals[1]?.aborted).toBe(false);
      expect(downloader.extractedPaths).toHaveLength(1);
    });
  });
});
