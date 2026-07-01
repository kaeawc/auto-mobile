import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyBuilder } from "../../src/utils/IOSCtrlProxyBuilder";
import { FakeIOSCtrlProxyBundleDownloader } from "../fakes/FakeIOSCtrlProxyBundleDownloader";
import * as fs from "fs/promises";
import * as path from "path";
import os from "os";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { parsePlist } from "../../src/utils/ios-cmdline-tools/XctestrunPlist";

describe("IOSCtrlProxyBuilder", function() {
  let originalProjectRoot: string | undefined;
  let originalDerivedDataPath: string | undefined;
  let originalSkipBuild: string | undefined;
  let originalCacheDir: string | undefined;
  let originalIpaPath: string | undefined;
  let originalBundlePath: string | undefined;
  let originalLaunchCwd: string | undefined;
  let tempDir: string;

  beforeEach(async function() {
    // Save original environment
    originalProjectRoot = process.env.AUTOMOBILE_PROJECT_ROOT;
    originalDerivedDataPath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA;
    originalSkipBuild = process.env.AUTOMOBILE_SKIP_CTRL_PROXY_IOS_BUILD;
    originalCacheDir = process.env.AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR;
    originalIpaPath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH;
    originalBundlePath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];

    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrl-proxy-ios-builder-test-"));

    // Reset singleton instances
    IOSCtrlProxyBuilder.resetInstances();
  });

  afterEach(async function() {
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

    if (originalSkipBuild === undefined) {
      delete process.env.AUTOMOBILE_SKIP_CTRL_PROXY_IOS_BUILD;
    } else {
      process.env.AUTOMOBILE_SKIP_CTRL_PROXY_IOS_BUILD = originalSkipBuild;
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

    // Reset singleton instances
    IOSCtrlProxyBuilder.resetInstances();

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getInstance", function() {
    test("should return same instance for same configuration", function() {
      const instance1 = IOSCtrlProxyBuilder.getInstance();
      const instance2 = IOSCtrlProxyBuilder.getInstance();

      expect(instance1).toBe(instance2);
    });

    test("should return different instances for different configurations", function() {
      const instance1 = IOSCtrlProxyBuilder.getInstance();
      const instance2 = IOSCtrlProxyBuilder.getInstance({ projectRoot: "/different/path" });

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("getConfig", function() {
    test("should return default configuration when no overrides", function() {
      const builder = IOSCtrlProxyBuilder.getInstance();
      const config = builder.getConfig();

      expect(config.scheme).toBe("CtrlProxyApp");
      expect(config.destination).toBe("generic/platform=iOS Simulator");
      expect(config.derivedDataPath).toBe("/tmp/automobile-ctrl-proxy");
      expect(config.bundleCacheDir).toBe(path.join(os.homedir(), ".automobile", "ctrl-proxy-ios"));
    });

    test("should respect environment variable overrides", function() {
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA = "/custom/derived/data";
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR = "/custom/cache";

      // Reset instances to pick up new env
      IOSCtrlProxyBuilder.resetInstances();

      const builder = IOSCtrlProxyBuilder.getInstance();
      const config = builder.getConfig();

      expect(config.derivedDataPath).toBe("/custom/derived/data");
      expect(config.bundleCacheDir).toBe("/custom/cache");
    });

    test("should respect constructor config overrides", function() {
      const builder = IOSCtrlProxyBuilder.getInstance({
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

  describe("needsRebuild", function() {
    test("should return false when AUTOMOBILE_SKIP_CTRL_PROXY_IOS_BUILD is true", async function() {
      process.env.AUTOMOBILE_SKIP_CTRL_PROXY_IOS_BUILD = "true";

      // Reset instances to pick up new env
      IOSCtrlProxyBuilder.resetInstances();

      const builder = IOSCtrlProxyBuilder.getInstance();
      const result = await builder.needsRebuild();

      expect(result).toBe(false);
    });

    test("should return false when AUTOMOBILE_SKIP_CTRL_PROXY_IOS_BUILD is 1", async function() {
      process.env.AUTOMOBILE_SKIP_CTRL_PROXY_IOS_BUILD = "1";

      // Reset instances to pick up new env
      IOSCtrlProxyBuilder.resetInstances();

      const builder = IOSCtrlProxyBuilder.getInstance();
      const result = await builder.needsRebuild();

      expect(result).toBe(false);
    });

    test("should return true when build products don't exist", async function() {
      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath: path.join(tempDir, "nonexistent"),
        projectRoot: tempDir,
      });

      const result = await builder.needsRebuild();

      // Should return true because build products don't exist
      expect(result).toBe(true);
    });

    test("should return false when xctestrun and metadata match", async function() {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const productsDir = path.join(derivedDataPath, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      await fs.writeFile(path.join(productsDir, "CtrlProxyApp_iphonesimulator.xctestrun"), "mock");

      const cacheDir = path.join(tempDir, "cache");
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        path.join(cacheDir, "ctrl-proxy-ios-bundle.json"),
        JSON.stringify({ checksum: "test-checksum", version: "latest", extractedAt: new Date().toISOString() })
      );

      IOSCtrlProxyBuilder.setExpectedChecksumForTesting("test-checksum");
      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath,
        bundleCacheDir: cacheDir
      });

      const result = await builder.needsRebuild("simulator");
      expect(result).toBe(false);
    });

    test("fails closed on an unknown pin instead of reusing a cached bundle (#2746)", async function() {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      try {
        // A cached bundle + metadata exist, so without the guard needsRebuild would
        // return false and setup would silently reuse the cached (wrong-version) runner.
        const derivedDataPath = path.join(tempDir, "DerivedData");
        const productsDir = path.join(derivedDataPath, "Build", "Products");
        await fs.mkdir(productsDir, { recursive: true });
        await fs.writeFile(path.join(productsDir, "CtrlProxyApp_iphonesimulator.xctestrun"), "mock");
        const cacheDir = path.join(tempDir, "cache");
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(
          path.join(cacheDir, "ctrl-proxy-ios-bundle.json"),
          JSON.stringify({ checksum: "stale", version: "latest", extractedAt: new Date().toISOString() })
        );

        IOSCtrlProxyBuilder.resetInstances();
        const builder = IOSCtrlProxyBuilder.getInstance({ derivedDataPath, bundleCacheDir: cacheDir });

        await expect(builder.needsRebuild("simulator")).rejects.toThrow("not in the AutoMobile release");
      } finally {
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
      }
    });

    test("a vendored IPA path exempts the unknown-pin guard (#2746)", async function() {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = path.join(tempDir, "vendored.ipa");
      try {
        IOSCtrlProxyBuilder.resetInstances();
        const builder = IOSCtrlProxyBuilder.getInstance({
          derivedDataPath: path.join(tempDir, "nonexistent"),
          projectRoot: tempDir,
        });

        // No throw: a vendored bundle is the trusted escape hatch. Build products
        // are missing, so it simply reports a rebuild is needed.
        const result = await builder.needsRebuild();
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

  describe("getBuildProductsPath", function() {
    test("should return null when build products don't exist", async function() {
      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath: path.join(tempDir, "nonexistent"),
      });

      const result = await builder.getBuildProductsPath();

      expect(result).toBeNull();
    });

    test("should return path when build products exist", async function() {
      // Create fake build products directory
      const buildDir = path.join(tempDir, "Build", "Products", "Debug-iphonesimulator");
      await fs.mkdir(buildDir, { recursive: true });

      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath: tempDir,
      });

      const result = await builder.getBuildProductsPath();

      expect(result).toBe(buildDir);
    });
  });

  describe("getXctestrunPath", function() {
    test("should return null when xctestrun doesn't exist", async function() {
      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath: path.join(tempDir, "nonexistent"),
      });

      const result = await builder.getXctestrunPath();

      expect(result).toBeNull();
    });

    test("should return path when xctestrun exists", async function() {
      // Create fake build products directory and xctestrun file
      const productsDir = path.join(tempDir, "Build", "Products");
      const buildDir = path.join(productsDir, "Debug-iphonesimulator");
      await fs.mkdir(buildDir, { recursive: true });

      const xctestrunFile = path.join(productsDir, "CtrlProxyApp_iphonesimulator.xctestrun");
      await fs.writeFile(xctestrunFile, "mock xctestrun content");

      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath: tempDir,
      });

      const result = await builder.getXctestrunPath();

      expect(result).toBe(xctestrunFile);
    });

    test("should prefer newest xctestrun file when multiple exist", async function() {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });

      const oldFile = path.join(productsDir, "CtrlProxyApp_iphonesimulator26.0-arm64-x86_64.xctestrun");
      const newFile = path.join(productsDir, "CtrlProxyApp_iphonesimulator26.2-arm64-x86_64.xctestrun");
      await fs.writeFile(oldFile, "old content");
      await fs.utimes(oldFile, new Date("2026-01-01"), new Date("2026-01-01"));
      await fs.writeFile(newFile, "new content");
      await fs.utimes(newFile, new Date("2026-04-01"), new Date("2026-04-01"));

      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath: tempDir,
      });

      const result = await builder.getXctestrunPath("simulator");

      expect(result).toBe(newFile);
    });
  });

  describe("writeRunnerEnvironment", function() {
    const SAMPLE_XCTESTRUN = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\">",
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
      "</plist>"
    ].join("\n");

    async function readUiTestEnv(xctestrunPath: string): Promise<Map<string, unknown>> {
      const xml = await fs.readFile(xctestrunPath, "utf-8");
      const root = await parsePlist(xml) as Map<string, unknown>;
      const uiTarget = root.get("CtrlProxyUITests") as Map<string, unknown>;
      return uiTarget.get("EnvironmentVariables") as Map<string, unknown>;
    }

    test("writes a per-launch copy carrying the injected port without mutating the source (EC3)", async function() {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(productsDir, "CtrlProxyApp_iphonesimulator26.2-arm64-x86_64.xctestrun");
      await fs.writeFile(sourcePath, SAMPLE_XCTESTRUN);

      const builder = IOSCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      const outputPath = await builder.writeRunnerEnvironment(
        sourcePath,
        { CTRL_PROXY_IOS_PORT: "8767", AUTOMOBILE_DEVICE_ID: "SIM-UUID" },
        "SIM-UUID"
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

    test("per-launch copy is excluded from getXctestrunPath candidate globs", async function() {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(productsDir, "CtrlProxyApp_iphonesimulator26.2-arm64-x86_64.xctestrun");
      await fs.writeFile(sourcePath, SAMPLE_XCTESTRUN);

      const builder = IOSCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      await builder.writeRunnerEnvironment(sourcePath, { CTRL_PROXY_IOS_PORT: "8767" }, "SIM-UUID");

      // The runner copy must not be re-selected as the source xctestrun.
      const resolved = await builder.getXctestrunPath("simulator");
      expect(resolved).toBe(sourcePath);
    });

    test("per-launch copy is excluded even from the platform-agnostic getXctestrunPath glob", async function() {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(productsDir, "CtrlProxyApp_iphonesimulator26.2-arm64-x86_64.xctestrun");
      await fs.writeFile(sourcePath, SAMPLE_XCTESTRUN);
      // Make the source older so a naive newest-mtime pick would prefer the copy.
      await fs.utimes(sourcePath, new Date("2026-01-01"), new Date("2026-01-01"));

      const builder = IOSCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      const outputPath = await builder.writeRunnerEnvironment(sourcePath, { CTRL_PROXY_IOS_PORT: "8767" }, "SIM-UUID");
      await fs.utimes(outputPath, new Date("2026-06-01"), new Date("2026-06-01"));

      // No platform argument → no platform filter; the runner copy must still be skipped.
      const resolved = await builder.getXctestrunPath();
      expect(resolved).toBe(sourcePath);
    });

    test("sanitizes the device id used in the copy filename", async function() {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(productsDir, "CtrlProxyApp_iphoneos.xctestrun");
      await fs.writeFile(sourcePath, SAMPLE_XCTESTRUN);

      const builder = IOSCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      const outputPath = await builder.writeRunnerEnvironment(
        sourcePath,
        { CTRL_PROXY_IOS_PORT: "8767" },
        "00008030-001E/28C1 1E"
      );
      expect(path.basename(outputPath)).toBe("automobile-runner-00008030-001E_28C1_1E.xctestrun");
    });

    test("throws an actionable error when the xctestrun has no UI-test bundle (EC4)", async function() {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });
      const sourcePath = path.join(productsDir, "CtrlProxyApp_iphonesimulator.xctestrun");
      await fs.writeFile(sourcePath, [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<plist version=\"1.0\">",
        "<dict>",
        "\t<key>CtrlProxyTests</key>",
        "\t<dict><key>IsUITestBundle</key><false/></dict>",
        "</dict>",
        "</plist>"
      ].join("\n"));

      const builder = IOSCtrlProxyBuilder.getInstance({ derivedDataPath: tempDir });
      await expect(
        builder.writeRunnerEnvironment(sourcePath, { CTRL_PROXY_IOS_PORT: "8767" }, "SIM")
      ).rejects.toThrow("no UI-test bundle");
    });
  });

  describe("cleanStaleXctestrunFiles", function() {
    test("should remove older xctestrun files keeping newest per platform", async function() {
      const productsDir = path.join(tempDir, "Build", "Products");
      await fs.mkdir(productsDir, { recursive: true });

      const oldFile = path.join(productsDir, "CtrlProxyApp_iphonesimulator26.0-arm64-x86_64.xctestrun");
      const newFile = path.join(productsDir, "CtrlProxyApp_iphonesimulator26.2-arm64-x86_64.xctestrun");
      await fs.writeFile(oldFile, "old content");
      await fs.utimes(oldFile, new Date("2026-01-01"), new Date("2026-01-01"));
      await fs.writeFile(newFile, "new content");
      await fs.utimes(newFile, new Date("2026-04-01"), new Date("2026-04-01"));

      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath: tempDir,
      });

      await builder.cleanStaleXctestrunFiles();

      const oldExists = await fs.access(oldFile).then(() => true).catch(() => false);
      const newExists = await fs.access(newFile).then(() => true).catch(() => false);
      expect(oldExists).toBe(false);
      expect(newExists).toBe(true);
    });
  });

  describe("cleanBuildArtifacts", function() {
    test("should remove derived data directory", async function() {
      // Create fake derived data
      const derivedDataPath = path.join(tempDir, "DerivedData");
      await fs.mkdir(derivedDataPath, { recursive: true });
      await fs.writeFile(path.join(derivedDataPath, "test.txt"), "test");

      const builder = IOSCtrlProxyBuilder.getInstance({
        derivedDataPath,
      });

      await builder.cleanBuildArtifacts();

      // Verify directory was removed
      const exists = await fs.access(derivedDataPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe("static prefetch methods", function() {
    test("getPrefetchedResult should return null initially", function() {
      IOSCtrlProxyBuilder.resetInstances();
      const result = IOSCtrlProxyBuilder.getPrefetchedResult();
      expect(result).toBeNull();
    });

    test("getPrefetchError should return null initially", function() {
      IOSCtrlProxyBuilder.resetInstances();
      const error = IOSCtrlProxyBuilder.getPrefetchError();
      expect(error).toBeNull();
    });

    test("waitForPrefetch should return null when no prefetch started", async function() {
      IOSCtrlProxyBuilder.resetInstances();
      const result = await IOSCtrlProxyBuilder.waitForPrefetch();
      expect(result).toBeNull();
    });
  });

  describe("build", function() {
    test("should download and extract bundle using downloader", async function() {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";

      IOSCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IOSCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir
        },
        { downloader }
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(true);
      expect(result.xctestrunPath).toBe(path.join(derivedDataPath, "Build", "Products", "CtrlProxyApp_iphonesimulator.xctestrun"));
      expect(downloader.downloadedUrls.length).toBe(1);
      expect(downloader.extractedPaths[0]).toBe(derivedDataPath);
    });

    test("should normalize nested bundle layouts", async function() {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "expected-checksum";
      downloader.extractedSubdir = "NestedRoot";

      IOSCtrlProxyBuilder.setExpectedChecksumForTesting("expected-checksum");
      const builder = IOSCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir
        },
        { downloader }
      );

      const result = await builder.build("simulator");
      const buildProducts = await builder.getBuildProductsPath("simulator");

      expect(result.success).toBe(true);
      expect(buildProducts).toBe(path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator"));
    });

    test("fails closed when AUTOMOBILE_VERSION is pinned to an unknown version (#2746)", async function() {
      const prev = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      try {
        const derivedDataPath = path.join(tempDir, "DerivedData");
        const cacheDir = path.join(tempDir, "cache");
        const downloader = new FakeIOSCtrlProxyBundleDownloader();
        downloader.checksum = "actual-checksum-from-download";
        // No expected-checksum override and no vendored IPA path: the pinned
        // version has no registry checksum, so the download is unverifiable.
        const builder = IOSCtrlProxyBuilder.getInstance(
          { derivedDataPath, bundleCacheDir: cacheDir },
          { downloader }
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

    test("should reject build when checksum does not match", async function() {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const downloader = new FakeIOSCtrlProxyBundleDownloader();
      downloader.checksum = "actual-checksum-from-download";

      IOSCtrlProxyBuilder.setExpectedChecksumForTesting("different-expected-checksum");
      const builder = IOSCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir
        },
        { downloader }
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(false);
      expect(result.error).toContain("checksum verification failed");
    });

    test("should redownload when checksum changes", async function() {
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      await fs.mkdir(cacheDir, { recursive: true });

      const existingBundle = path.join(cacheDir, "control-proxy.ipa");
      await fs.writeFile(existingBundle, "a".repeat(12000));
      await fs.writeFile(
        path.join(cacheDir, "ctrl-proxy-ios-bundle.json"),
        JSON.stringify({ checksum: "old-checksum", version: "0.0.17", extractedAt: new Date().toISOString() })
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
      IOSCtrlProxyBuilder.setExpectedChecksumForTesting("new-checksum");
      const builder = IOSCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir
        },
        { downloader }
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(true);
      expect(downloader.downloadedUrls.length).toBe(1);
    });

    test.each([
      "AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH",
      "AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH",
    ] as const)("should resolve relative %s from daemon launch cwd", async function(envName) {
      const launchCwd = path.join(tempDir, "launch-cwd");
      const derivedDataPath = path.join(tempDir, "DerivedData");
      const cacheDir = path.join(tempDir, "cache");
      const localBundlePath = path.join(launchCwd, "build", "control-proxy.ipa");
      await fs.mkdir(path.dirname(localBundlePath), { recursive: true });
      await fs.writeFile(localBundlePath, "a".repeat(12000));

      process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
      process.env[envName] = path.join("build", "control-proxy.ipa");

      IOSCtrlProxyBuilder.resetInstances();
      IOSCtrlProxyBuilder.setExpectedChecksumForTesting("");
      const builder = IOSCtrlProxyBuilder.getInstance(
        {
          derivedDataPath,
          bundleCacheDir: cacheDir
        },
        { downloader: new FakeIOSCtrlProxyBundleDownloader() }
      );

      const result = await builder.build("simulator");

      expect(result.success).toBe(true);
      await expect(fs.stat(path.join(cacheDir, "control-proxy.ipa"))).resolves.toMatchObject({
        size: 12000,
      });
    });
  });
});
