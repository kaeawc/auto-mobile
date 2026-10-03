import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import os from "os";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { ActionableError } from "../../src/models/ActionableError";
import { PortManager } from "../../src/utils/PortManager";
import { DeviceAppManager } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { logger } from "../../src/utils/logger";
import { FakeIOSCtrlProxyBundleDownloader } from "../fakes/FakeIOSCtrlProxyBundleDownloader";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeCtrlProxyCodesignVerifier } from "../fakes/FakeCtrlProxyCodesignVerifier";

describe("authoritative iOS local builds", () => {
  const envKeys = [
    "AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD",
    "AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH",
    "AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH",
    "AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256",
    "AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET",
  ];
  let savedEnv: (string | undefined)[];
  let originalPlatform: PropertyDescriptor | undefined;
  let tempDir: string;
  let derivedDataPath: string;
  let bundleCacheDir: string;
  let productsDir: string;
  let xctestrunPath: string;
  let downloader: FakeIOSCtrlProxyBundleDownloader;
  let builder: IosCtrlProxyBuilder;

  beforeEach(async () => {
    savedEnv = envKeys.map((key) => process.env[key]);
    for (const key of envKeys) {
      delete process.env[key];
    }
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    IosCtrlProxyBuilder.resetInstances();
    IosCtrlProxyBuilder.setUseLocalBuildForTesting(true);
    IosCtrlProxyBuilder.setExpectedChecksumForTesting("release-checksum");
    IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("release-sha", "xctest");
    IosCtrlProxyBuilder.setTimerForTesting(new FakeTimer());
    IosCtrlProxyBuilder.setCodesignVerifierForTesting(new FakeCtrlProxyCodesignVerifier());
    IosCtrlProxyBuilder.setIosPrerequisiteDetectorForTesting({
      hasIosPrerequisites: async () => true,
    });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ios-local-build-"));
    derivedDataPath = path.join(tempDir, "DerivedData");
    bundleCacheDir = path.join(tempDir, "cache");
    productsDir = path.join(derivedDataPath, "Build", "Products");
    xctestrunPath = path.join(productsDir, "AutoMobileTest_iphonesimulator.xctestrun");
    await fs.mkdir(bundleCacheDir);
    downloader = new FakeIOSCtrlProxyBundleDownloader();
    downloader.checksum = "release-checksum";
    downloader.runnerChecksum = "local-sha";
    builder = IosCtrlProxyBuilder.getInstance({ derivedDataPath, bundleCacheDir }, { downloader });
    IosCtrlProxyBuilder.setPrefetchBuilderForTesting(builder);
  });

  afterEach(async () => {
    IosCtrlProxyBuilder.resetInstances();
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    for (const [index, key] of envKeys.entries()) {
      const value = savedEnv[index];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Reuse the existing fake's product fixture writer, independently of the
  // recording downloader injected into the builder under test.
  async function placeLocalProducts(): Promise<void> {
    await new FakeIOSCtrlProxyBundleDownloader().extractBundle("fixture", derivedDataPath);
    await fs.writeFile(xctestrunPath, "local xctestrun");
  }

  test.each(["runner", "xctest"] as const)(
    "a rebuilt %s is re-pinned on the next launch and remains valid on the third launch",
    async (target) => {
      await placeLocalProducts();
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET = target;
      IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting(null);
      downloader.runnerChecksum = downloader.legacyRunnerChecksum = "a".repeat(64);
      const binary = await builder.getRunnerBinaryPath("simulator", target);
      if (!binary) {
        throw new Error("Missing fixture runner binary");
      }
      const info = spyOn(logger, "info").mockImplementation(() => {});
      try {
        await builder.verifyRunnerBinaryBeforeLaunch("simulator");
        const original = await fs.stat(binary);
        await fs.writeFile(binary, "rebuilt runner with a different size");
        await fs.utimes(binary, original.atime, new Date(original.mtimeMs + 1000));
        downloader.runnerChecksum = downloader.legacyRunnerChecksum = "b".repeat(64);
        await builder.verifyRunnerBinaryBeforeLaunch("simulator");
        expect(info).toHaveBeenCalledWith(expect.stringContaining("New local build detected"), {
          platform: "simulator",
          oldSha: "aaaaaaaaaaaa",
          newSha: "bbbbbbbbbbbb",
        });
        await builder.verifyRunnerBinaryBeforeLaunch("simulator");
        expect(
          info.mock.calls.filter(([message]) => message.includes("New local build detected")),
        ).toHaveLength(1);
      } finally {
        info.mockRestore();
      }
    },
  );

  test("mtime alone identifies a new local build", async () => {
    await placeLocalProducts();
    const binary = await builder.getRunnerBinaryPath("simulator", "xctest");
    if (!binary) {
      throw new Error("Missing fixture runner binary");
    }
    await builder.verifyRunnerBinaryBeforeLaunch("simulator");
    const original = await fs.stat(binary);
    await fs.utimes(binary, original.atime, new Date(original.mtimeMs + 1000));
    downloader.runnerChecksum = "rebuilt-sha";
    await builder.verifyRunnerBinaryBeforeLaunch("simulator");
  });

  test("size alone identifies a new local build", async () => {
    await placeLocalProducts();
    const binary = await builder.getRunnerBinaryPath("simulator", "xctest");
    if (!binary) {
      throw new Error("Missing fixture runner binary");
    }
    const timestamp = new Date(1700000000000);
    await fs.utimes(binary, timestamp, timestamp);
    await builder.verifyRunnerBinaryBeforeLaunch("simulator");
    await fs.writeFile(binary, "rebuilt runner with a different size");
    await fs.utimes(binary, timestamp, timestamp);
    downloader.runnerChecksum = "rebuilt-sha";
    await builder.verifyRunnerBinaryBeforeLaunch("simulator");
  });

  test("a hash change with unchanged binary identity still rejects TOCTOU tampering", async () => {
    await placeLocalProducts();
    await builder.verifyRunnerBinaryBeforeLaunch("simulator");
    downloader.runnerChecksum = "tampered-sha";
    await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
      "SHA256 changed (pre-launch)",
    );
    await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
      "possible TOCTOU tampering",
    );
  });

  test("an explicit SHA stays enforced after a local rebuild without re-pinning", async () => {
    await placeLocalProducts();
    IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting(null);
    downloader.runnerChecksum = "a".repeat(64);
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256 = downloader.runnerChecksum;
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET = "xctest";
    await builder.verifyRunnerBinaryBeforeLaunch("simulator");
    const binary = await builder.getRunnerBinaryPath("simulator", "xctest");
    if (!binary) {
      throw new Error("Missing fixture runner binary");
    }
    await fs.writeFile(binary, "rebuilt runner with a different size");
    downloader.runnerChecksum = "rebuilt-sha";
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      await expect(builder.verifyRunnerBinaryBeforeLaunch("simulator")).rejects.toThrow(
        "runner binary SHA256 mismatch",
      );
      expect(
        info.mock.calls.some(([message]) => message.includes("New local build detected")),
      ).toBe(false);
    } finally {
      info.mockRestore();
    }
  });

  test("partial device products do not fail an explicit simulator build or launch", async () => {
    await placeLocalProducts();
    await fs.writeFile(
      path.join(productsDir, "AutoMobileTest_iphoneos.xctestrun"),
      "partial device",
    );
    expect(await builder.needsRebuild("simulator")).toBe(false);
    expect((await builder.build("simulator")).success).toBe(true);
    await builder.verifyRunnerBinaryBeforeLaunch("simulator");
  });

  test("no-platform local discovery and build default to simulator despite newer partial device products", async () => {
    await placeLocalProducts();
    const deviceXctestrun = path.join(productsDir, "AutoMobileTest_iphoneos.xctestrun");
    await fs.writeFile(deviceXctestrun, "partial device");
    const simulator = await fs.stat(xctestrunPath);
    await fs.utimes(deviceXctestrun, simulator.atime, new Date(simulator.mtimeMs + 1000));
    expect(await builder.needsRebuild()).toBe(false);
    const result = await builder.build();
    expect(result.success).toBe(true);
    expect(result.xctestrunPath).toBe(xctestrunPath);
    expect(result.buildPath).toBe(path.join(productsDir, "Debug-iphonesimulator"));
    expect((await IosCtrlProxyBuilder.prefetchBuild())?.xctestrunPath).toBe(xctestrunPath);
    await builder.verifyRunnerBinaryBeforeLaunch("simulator");
  });

  test("fresh release cache cannot replace local products through discovery, build or prefetch", async () => {
    await placeLocalProducts();
    expect(await builder.needsRebuild("simulator")).toBe(false);
    const result = await builder.build("simulator");
    expect(result.success).toBe(true);
    expect(result.xctestrunPath).toBe(xctestrunPath);
    expect(result.buildPath).toBe(path.join(productsDir, "Debug-iphonesimulator"));
    expect((await IosCtrlProxyBuilder.prefetchBuild())?.xctestrunPath).toBe(xctestrunPath);
    expect(downloader.downloadedUrls).toEqual([]);
    expect(downloader.extractedPaths).toEqual([]);
    expect(await fs.readFile(xctestrunPath, "utf8")).toBe("local xctestrun");
    expect(await fs.readdir(bundleCacheDir)).toEqual([]);
  });

  test("missing local products throw actionable discovery and build errors without downloading", async () => {
    for (const operation of [() => builder.needsRebuild(), () => builder.build()]) {
      await expect(operation()).rejects.toBeInstanceOf(ActionableError);
      await expect(operation()).rejects.toThrow(productsDir);
      await expect(operation()).rejects.toThrow(".xctestrun");
      await expect(operation()).rejects.toThrow("AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=");
      await expect(operation()).rejects.toThrow("bash scripts/ios/ctrl-proxy-build-for-testing.sh");
    }
    expect(downloader.downloadedUrls).toEqual([]);
    expect(downloader.extractedPaths).toEqual([]);
  });

  test("startup prefetch alone uses local products with an empty release cache", async () => {
    await placeLocalProducts();
    expect((await IosCtrlProxyBuilder.prefetchBuild())?.xctestrunPath).toBe(xctestrunPath);
    expect(downloader.downloadedUrls).toEqual([]);
    expect(downloader.extractedPaths).toEqual([]);
    expect(await fs.readFile(xctestrunPath, "utf8")).toBe("local xctestrun");
  });

  test("direct build cannot download, including with an explicit SHA guard", async () => {
    await placeLocalProducts();
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256 = "explicit-sha";
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET = "xctest";
    const result = await builder.build("simulator");
    expect(result.success).toBe(false);
    expect(result.error).toContain("runner binary SHA256 mismatch");
    expect(downloader.downloadedUrls).toEqual([]);
    expect(downloader.extractedPaths).toEqual([]);
  });

  test("empty xctestrun is invalid and never replaced by a release", async () => {
    await placeLocalProducts();
    await fs.writeFile(xctestrunPath, "");
    await expect(builder.needsRebuild()).rejects.toThrow(xctestrunPath);
    await expect(builder.build()).rejects.toThrow(
      "bash scripts/ios/ctrl-proxy-build-for-testing.sh",
    );
    expect(downloader.downloadedUrls).toEqual([]);
    expect(downloader.extractedPaths).toEqual([]);
  });

  test("missing local products are recorded as a prefetch error without rejecting", async () => {
    expect(await IosCtrlProxyBuilder.prefetchBuild()).toBeNull();
    const error = IosCtrlProxyBuilder.getPrefetchError();
    expect(error).toBeInstanceOf(ActionableError);
    expect(error?.message).toContain(productsDir);
    expect(error?.message).toContain("bash scripts/ios/ctrl-proxy-build-for-testing.sh");
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test("stale release metadata, bundle checksum and app hash cannot replace local products", async () => {
    await placeLocalProducts();
    await fs.writeFile(path.join(bundleCacheDir, "control-proxy.ipa"), "stale release");
    await fs.writeFile(
      path.join(bundleCacheDir, "ctrl-proxy-ios-bundle.json"),
      JSON.stringify({ checksum: "stale", version: "old", appHashes: { simulator: "stale" } }),
    );
    const releaseHash = spyOn(builder, "getExpectedAppHash").mockReturnValue("release-app-hash");
    try {
      expect(await builder.needsRebuild("simulator")).toBe(false);
      expect((await builder.build("simulator")).success).toBe(true);
      expect((await IosCtrlProxyBuilder.prefetchBuild())?.success).toBe(true);
      expect(downloader.downloadedUrls).toEqual([]);
      expect(downloader.extractedPaths).toEqual([]);
      expect(await fs.readFile(xctestrunPath, "utf8")).toBe("local xctestrun");
      expect(releaseHash).not.toHaveBeenCalled();
    } finally {
      releaseHash.mockRestore();
    }
  });

  test("vendored bundle overrides cannot replace a local build", async () => {
    await placeLocalProducts();
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH = path.join(tempDir, "absent-vendored.ipa");
    expect(await builder.needsRebuild()).toBe(false);
    expect((await builder.build()).success).toBe(true);
    expect(downloader.downloadedUrls).toEqual([]);
    expect(downloader.extractedPaths).toEqual([]);
  });

  test("an xctestrun with a missing runner binary fails with build instructions", async () => {
    await placeLocalProducts();
    const binary = path.join(
      productsDir,
      "Debug-iphonesimulator",
      "CtrlProxyUITests-Runner.app",
      "PlugIns",
      "CtrlProxyUITests.xctest",
      "CtrlProxyUITests",
    );
    await fs.rm(binary);
    await expect(builder.needsRebuild("simulator")).rejects.toThrow(derivedDataPath);
    await expect(builder.build("simulator")).rejects.toThrow(
      "bash scripts/ios/ctrl-proxy-build-for-testing.sh",
    );
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test("manager setup surfaces the missing local build instead of downloading", async () => {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    const deviceApps = new DeviceAppManager();
    const installed = spyOn(deviceApps, "getInstalledAppBundleHash").mockResolvedValue(null);
    const manager = IOSCtrlProxyManager.createForTestingWithDeps(
      { deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", platform: "ios", name: "fake simulator" },
      new FakeTimer(),
      builder,
      new FakeProcessExecutor(),
      undefined,
      deviceApps,
    );
    const running = spyOn(manager, "isRunning").mockResolvedValue(false);
    try {
      const result = await manager.setup();
      expect(result.success).toBe(false);
      expect(result.error).toContain(productsDir);
      expect(result.error).toContain("bash scripts/ios/ctrl-proxy-build-for-testing.sh");
      expect(downloader.downloadedUrls).toEqual([]);
    } finally {
      running.mockRestore();
      installed.mockRestore();
    }
  });

  test("SKIP retains priority even when local products are absent", async () => {
    process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD = "true";
    expect(await builder.needsRebuild()).toBe(false);
    expect((await builder.build()).message).toBe("CtrlProxy download skipped");
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test("released mode still downloads and extracts once with an empty cache", async () => {
    IosCtrlProxyBuilder.setUseLocalBuildForTesting(false);
    IosCtrlProxyBuilder.setExpectedRunnerChecksumForTesting("");
    expect(await builder.needsRebuild()).toBe(true);
    expect((await builder.build("simulator")).success).toBe(true);
    expect(downloader.downloadedUrls).toHaveLength(1);
    expect(downloader.extractedPaths).toEqual([derivedDataPath]);
  });
});
