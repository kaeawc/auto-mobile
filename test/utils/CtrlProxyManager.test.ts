import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  AndroidCtrlProxyManager,
  MAX_STALE_PREFETCH_DIRS_PER_STARTUP,
  STALE_PREFETCH_SWEEP_DEADLINE_MS,
} from "../../src/utils/CtrlProxyManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { BootedDevice } from "../../src/models";
import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import crypto from "crypto";
import os from "os";
import AdmZip from "adm-zip";

import { FakeAccessibilityDetector } from "../fakes/FakeAccessibilityDetector";
import { FakeTimer } from "../fakes/FakeTimer";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { logger } from "../../src/utils/logger";

describe("CtrlProxyManager", function () {
  let accessibilityServiceClient: AndroidCtrlProxyManager;
  let fakeAdb: FakeAdbExecutor;
  let fakeAdbFactory: AdbClientFactory;
  let testDevice: BootedDevice;
  let originalApkPathEnv: string | undefined;
  let originalSkipChecksumEnv: string | undefined;
  let originalSkipDownloadEnv: string | undefined;
  let originalSkipShaEnv: string | undefined;
  let originalLaunchCwdEnv: string | undefined;
  let prefetchCacheDir: string;

  beforeEach(async function () {
    originalApkPathEnv = process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH;
    originalSkipChecksumEnv = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM;
    originalSkipDownloadEnv = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
    originalSkipShaEnv = process.env.AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK;
    originalLaunchCwdEnv = process.env[DAEMON_LAUNCH_CWD_ENV];
    // Create fake ADB instance
    fakeAdb = new FakeAdbExecutor();
    fakeAdbFactory = { create: () => fakeAdb };

    // Create test device
    testDevice = {
      deviceId: "test-device",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };

    // Reset singleton instances
    AndroidCtrlProxyManager.resetInstances();

    // These tests exercise download/checksum/retry behavior, not the prefetch
    // prerequisite gate (#4404). Neutralize the gate so the default detector
    // doesn't skip the prefetch on CI hosts without Android tooling (e.g. Windows).
    AndroidCtrlProxyManager.setAndroidPrerequisiteDetectorForTesting({
      hasAndroidPrerequisites: async () => true,
    });
    prefetchCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlproxy-cache-"));
    AndroidCtrlProxyManager.setPrefetchCacheDirForTesting(prefetchCacheDir);

    accessibilityServiceClient = AndroidCtrlProxyManager.getInstance(testDevice, fakeAdbFactory);
    accessibilityServiceClient.clearAvailabilityCache();
  });

  afterEach(async function () {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
    AndroidCtrlProxyManager.setAccessibilityDetectorForTesting(null);
    AndroidCtrlProxyManager.setAndroidPrerequisiteDetectorForTesting(null);
    await AndroidCtrlProxyManager.cleanupPrefetchedApk();
    AndroidCtrlProxyManager.setPrefetchCacheDirForTesting(null);
    await fs.rm(prefetchCacheDir, { recursive: true, force: true });
    if (originalApkPathEnv === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH = originalApkPathEnv;
    }
    if (originalSkipChecksumEnv === undefined) {
      delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM;
    } else {
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = originalSkipChecksumEnv;
    }
    if (originalSkipDownloadEnv === undefined) {
      delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
    } else {
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = originalSkipDownloadEnv;
    }
    if (originalSkipShaEnv === undefined) {
      delete process.env.AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK;
    } else {
      process.env.AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK = originalSkipShaEnv;
    }
    if (originalLaunchCwdEnv === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwdEnv;
    }
  });
  describe("isInstalled", function () {
    test("should return true when accessibility service package is installed", async function () {
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );

      const result = await accessibilityServiceClient.isInstalled();
      expect(result).toBe(true);
    });

    test("should return false when accessibility service package is not installed", async function () {
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: "",
          stderr: "",
        },
      );

      const result = await accessibilityServiceClient.isInstalled();
      expect(result).toBe(false);
    });

    test("returns false when the ADB command throws", async function () {
      // ADD-10: exercise the catch path for real. Setting stderr on a resolved
      // response never entered the catch (isInstalled reads stdout only), so it
      // could not distinguish "return false" from any other catch behavior.
      fakeAdb.setCommandError(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        new Error("adb: device offline"),
      );

      const result = await accessibilityServiceClient.isInstalled();
      expect(result).toBe(false);
    });
  });

  describe("isEnabled", function () {
    test("should return true when accessibility service is enabled", async function () {
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.AutomobileAccessibilityService:other.service/SomeService`,
        stderr: "",
      });

      const result = await accessibilityServiceClient.isEnabled();
      expect(result).toBe(true);
    });

    test("should return false when accessibility service is not enabled", async function () {
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: "other.service/SomeService",
        stderr: "",
      });

      const result = await accessibilityServiceClient.isEnabled();
      expect(result).toBe(false);
    });

    test("returns false when the ADB command fails", async function () {
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: "",
        stderr: "Error",
      });

      const result = await accessibilityServiceClient.isEnabled();
      expect(result).toBe(false);
    });
  });

  describe("isAvailable", function () {
    test("should return true when service is both installed and enabled", async function () {
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`,
        stderr: "",
      });

      const result = await accessibilityServiceClient.isAvailable();
      expect(result).toBe(true);
      // REWRITE-2: assert the exact command set, not merely "at least two ran".
      // isAvailable resolves installed + enabled, so exactly these two commands
      // must be issued; a count check could not catch a wrong probe command.
      expect(fakeAdb.getExecutedCommands().sort()).toEqual(
        [
          `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
          "shell settings get secure enabled_accessibility_services",
        ].sort(),
      );
    });

    test("should return false when service is installed but not enabled", async function () {
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: "other.service/SomeService",
        stderr: "",
      });

      const result = await accessibilityServiceClient.isAvailable();
      expect(result).toBe(false);
      expect(fakeAdb.getExecutedCommands().length).toBeGreaterThanOrEqual(2);
    });

    test("should return false when service is not installed", async function () {
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`,
        stderr: "",
      });

      const result = await accessibilityServiceClient.isAvailable();
      expect(result).toBe(false);
      expect(fakeAdb.getExecutedCommands().length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getInstalledApkSha256", function () {
    test("should return SHA256 from device when sha256sum is available", async function () {
      fakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "abc123 /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });

      const result = await accessibilityServiceClient.getInstalledApkSha256();
      expect(result).toBe("abc123");
    });

    test("should fall back to host hashing when sha256sum fails", async function () {
      const expectedApkPath = "/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk";
      const apkContent = Buffer.from("fake-apk-content");
      const expectedSha = crypto.createHash("sha256").update(apkContent).digest("hex");

      const createExecResult = (stdout: string, stderr: string) => ({
        stdout,
        stderr,
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (searchString: string) => stdout.includes(searchString),
      });

      const localFakeAdb: any = {
        executeCommand: async (command: string) => {
          if (command.includes("shell pm path")) {
            return createExecResult(`package:${expectedApkPath}\n`, "");
          }

          if (command.includes("shell sha256sum")) {
            throw new Error("sha256sum not available");
          }

          if (command.includes("pull")) {
            const match = command.match(/pull\s+(".*?"|\S+)\s+(".*?"|\S+)/);
            const localPathRaw = match?.[2]?.replace(/^"(.*)"$/, "$1");
            if (localPathRaw) {
              await fs.mkdir(path.dirname(localPathRaw), { recursive: true });
              await fs.writeFile(localPathRaw, apkContent);
            }
            return createExecResult("", "");
          }

          return createExecResult("", "");
        },
      };

      AndroidCtrlProxyManager.resetInstances();
      const fallbackClient = AndroidCtrlProxyManager.getInstance(testDevice, {
        create: () => localFakeAdb,
      });

      const result = await fallbackClient.getInstalledApkSha256();
      expect(result).toBe(expectedSha);
    });
  });

  describe("ensureCompatibleVersion", function () {
    const createExecResult = (stdout: string, stderr: string) => ({
      stdout,
      stderr,
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (searchString: string) => stdout.includes(searchString),
    });

    test("fails closed on an unknown pin even when CtrlProxy is already installed (#2746)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      try {
        // Device already has CtrlProxy installed + enabled: the readiness path
        // would otherwise accept it (status "skipped") without ever downloading.
        const localFakeAdb = new FakeAdbExecutor();
        localFakeAdb.setCommandResponse(
          `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
          {
            stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
            stderr: "",
          },
        );

        AndroidCtrlProxyManager.resetInstances();
        const manager = AndroidCtrlProxyManager.getInstance(testDevice, {
          create: () => localFakeAdb,
        });

        await expect(manager.ensureCompatibleVersion()).rejects.toThrow(
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

    test("accepts a preinstalled CtrlProxy on an unknown pin when checksum skip is set (#2746)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = "true";
      try {
        const localFakeAdb = new FakeAdbExecutor();
        localFakeAdb.setCommandResponse(
          `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
          {
            stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
            stderr: "",
          },
        );

        AndroidCtrlProxyManager.resetInstances();
        const manager = AndroidCtrlProxyManager.getInstance(testDevice, {
          create: () => localFakeAdb,
        });

        const result = await manager.ensureCompatibleVersion();
        expect(result.status).toBe("skipped");
      } finally {
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
      }
    });

    test("should report compatible when installed SHA matches expected", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "expected-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.getInstance(testDevice, {
        create: () => localFakeAdb,
      });

      const result = await manager.ensureCompatibleVersion();
      expect(result.status).toBe("compatible");
      expect(localFakeAdb.wasCommandExecuted("install -r -d")).toBe(false);
    });

    test("should accept preinstalled APK when installed SHA mismatches expected by default", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });

      let downloadCalls = 0;
      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        localFakeAdb,
        new FakeTimer(),
        {
          download: async () => {
            downloadCalls++;
            throw new Error("download should not be called for readiness");
          },
        },
      );

      const result = await manager.ensureCompatibleVersion();
      expect(result.status).toBe("skipped");
      expect(result.installedSha256).toBe("different-sha");
      expect(result.attemptedDownload).toBe(false);
      expect(downloadCalls).toBe(0);
      expect(localFakeAdb.wasCommandExecuted("install -r -d")).toBe(false);
    });

    test("fails closed on an installed APK SHA mismatch when a concrete version is pinned (#2815)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "0.0.18";
      try {
        const localFakeAdb = new FakeAdbExecutor();
        localFakeAdb.setCommandResponse(
          `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
          {
            stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
            stderr: "",
          },
        );
        localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
          stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
          stderr: "",
        });
        localFakeAdb.setCommandResponse("shell sha256sum", {
          stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
          stderr: "",
        });

        let downloadCalls = 0;
        AndroidCtrlProxyManager.resetInstances();
        const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          localFakeAdb,
          new FakeTimer(),
          {
            download: async () => {
              downloadCalls++;
              throw new Error("download should not be called for a hermetic mismatch");
            },
          },
        );

        await expect(manager.ensureCompatibleVersion()).rejects.toThrow(
          "Installed CtrlProxy APK SHA differs from expected release checksum",
        );
        expect(downloadCalls).toBe(0);
        expect(localFakeAdb.wasCommandExecuted("install -r -d")).toBe(false);
      } finally {
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
      }
    });

    test("fails closed on a pinned mismatch even when preinstalled download skip is set (#2815)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      const prevSkipDownload = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
      process.env.AUTOMOBILE_VERSION = "0.0.18";
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = "true";
      try {
        const localFakeAdb = new FakeAdbExecutor();
        localFakeAdb.setCommandResponse(
          `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
          {
            stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
            stderr: "",
          },
        );
        localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
          stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
          stderr: "",
        });
        localFakeAdb.setCommandResponse("shell sha256sum", {
          stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
          stderr: "",
        });

        AndroidCtrlProxyManager.resetInstances();
        const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          localFakeAdb,
          new FakeTimer(),
          {
            download: async () => {
              throw new Error("download should not be called for a hermetic mismatch");
            },
          },
        );

        await expect(manager.ensureCompatibleVersion()).rejects.toThrow(
          "Installed CtrlProxy APK SHA differs from expected release checksum",
        );
        expect(localFakeAdb.wasCommandExecuted("shell sha256sum")).toBe(true);
        expect(localFakeAdb.wasCommandExecuted("install -r -d")).toBe(false);
      } finally {
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
        if (prevSkipDownload === undefined) {
          delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
        } else {
          process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = prevSkipDownload;
        }
      }
    });

    test("should upgrade when installed SHA mismatches expected and installed download is explicitly allowed", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("install -r -d", createExecResult("Success", ""));

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.getInstance(testDevice, {
        create: () => localFakeAdb,
      });
      (manager as any).downloadApk = async () => "/tmp/fake-accessibility.apk";
      (manager as any).cleanupApk = async () => undefined;

      const result = await manager.ensureCompatibleVersion({ allowDownloadWhenInstalled: true });
      expect(result.status).toBe("upgraded");
      expect(localFakeAdb.wasCommandExecuted("install -r -d")).toBe(true);
    });

    test("should install local APK override when explicit update is requested", async function () {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-local-update-"));
      const localApkPath = path.join(tempDir, "control-proxy-debug.apk");
      const zip = new AdmZip();
      zip.addFile(
        "AndroidManifest.xml",
        Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest></manifest>', "utf8"),
      );
      zip.addFile("classes.dex", crypto.randomBytes(15000));
      zip.writeZip(localApkPath);

      process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH = localApkPath;
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = "true";

      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "local-dev-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("install -r -d", createExecResult("Success", ""));

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.getInstance(testDevice, {
        create: () => localFakeAdb,
      });

      const result = await manager.ensureCompatibleVersion({ allowDownloadWhenInstalled: true });
      expect(result.status).toBe("upgraded");
      expect(localFakeAdb.wasCommandExecuted("install -r -d")).toBe(true);

      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("should install completed background prefetch on later readiness check without downloading", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-prefetch-source-"));
      const prefetchedApkPath = path.join(tempDir, "control-proxy.apk");
      await fs.writeFile(prefetchedApkPath, Buffer.from("prefetched-apk"));
      (AndroidCtrlProxyManager as any).prefetchedApkPath = prefetchedApkPath;

      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("install -r -d", createExecResult("Success", ""));

      let downloadCalls = 0;
      const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        localFakeAdb,
        new FakeTimer(),
        {
          download: async () => {
            downloadCalls++;
            throw new Error("download should not be called for completed prefetch");
          },
        },
      );

      const result = await manager.ensureCompatibleVersion();
      expect(result.status).toBe("upgraded");
      expect(result.attemptedDownload).toBe(false);
      expect(result.attemptedInstall).toBe(true);
      expect(downloadCalls).toBe(0);
      expect(localFakeAdb.wasCommandExecuted("install -r -d")).toBe(true);
    });

    test("should keep completed prefetch install failure failed after fallback uninstall removes service", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-prefetch-source-"));
      const prefetchedApkPath = path.join(tempDir, "control-proxy.apk");
      await fs.writeFile(prefetchedApkPath, Buffer.from("prefetched-apk"));
      (AndroidCtrlProxyManager as any).prefetchedApkPath = prefetchedApkPath;

      const packageCheckCommand = `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`;
      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponseSequence(packageCheckCommand, [
        createExecResult(`package:${AndroidCtrlProxyManager.PACKAGE}\n`, ""),
        createExecResult("", ""),
      ]);
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandError(
        "install -r -d",
        new Error("INSTALL_FAILED_UPDATE_INCOMPATIBLE"),
      );
      localFakeAdb.setCommandResponse(
        `shell pm uninstall ${AndroidCtrlProxyManager.PACKAGE}`,
        createExecResult("Success", ""),
      );
      localFakeAdb.setCommandError('install "', new Error("INSTALL_FAILED_ABORTED"));

      const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        localFakeAdb,
        new FakeTimer(),
        {
          download: async () => {
            throw new Error("download should not be called for completed prefetch");
          },
        },
      );

      const result = await manager.ensureCompatibleVersion();
      const packageCheckCalls = localFakeAdb
        .getExecutedCommands()
        .filter((command) => command.includes(packageCheckCommand));

      expect(result.status).toBe("failed");
      expect(result.acceptedPreinstalled).toBeUndefined();
      expect(result.attemptedInstall).toBe(true);
      expect(result.attemptedReinstall).toBe(true);
      expect(packageCheckCalls.length).toBe(2);
      expect(
        localFakeAdb.wasCommandExecuted(`shell pm uninstall ${AndroidCtrlProxyManager.PACKAGE}`),
      ).toBe(true);
    });

    test("fails closed on a pinned mismatch when completed prefetch install fails and old APK remains (#2815)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "0.0.18";
      try {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-prefetch-source-"));
        const prefetchedApkPath = path.join(tempDir, "control-proxy.apk");
        await fs.writeFile(prefetchedApkPath, Buffer.from("prefetched-apk"));
        (AndroidCtrlProxyManager as any).prefetchedApkPath = prefetchedApkPath;

        const packageCheckCommand = `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`;
        const localFakeAdb = new FakeAdbExecutor();
        localFakeAdb.setCommandResponseSequence(packageCheckCommand, [
          createExecResult(`package:${AndroidCtrlProxyManager.PACKAGE}\n`, ""),
          createExecResult(`package:${AndroidCtrlProxyManager.PACKAGE}\n`, ""),
        ]);
        localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
          stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
          stderr: "",
        });
        localFakeAdb.setCommandResponse("shell sha256sum", {
          stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
          stderr: "",
        });
        localFakeAdb.setCommandError(
          "install -r -d",
          new Error("INSTALL_FAILED_UPDATE_INCOMPATIBLE"),
        );
        localFakeAdb.setCommandResponse(
          `shell pm uninstall ${AndroidCtrlProxyManager.PACKAGE}`,
          createExecResult("Success", ""),
        );
        localFakeAdb.setCommandError('install "', new Error("INSTALL_FAILED_ABORTED"));

        const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          localFakeAdb,
          new FakeTimer(),
          {
            download: async () => {
              throw new Error("download should not be called for completed prefetch");
            },
          },
        );

        await expect(manager.ensureCompatibleVersion()).rejects.toThrow(
          "Installed CtrlProxy APK SHA differs from expected release checksum",
        );
      } finally {
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
      }
    });

    test("prefetch is skipped (no network) for an unknown pin (#2746)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      const originalDefaultDownloader = (AndroidCtrlProxyManager as any).defaultFileDownloader;
      let downloadCalls = 0;
      try {
        (AndroidCtrlProxyManager as any).defaultFileDownloader = {
          download: async () => {
            downloadCalls++;
            throw new Error("download must not run for an unverifiable pin");
          },
        };

        AndroidCtrlProxyManager.prefetchApk();
        expect(await AndroidCtrlProxyManager.getPrefetchedApkPath()).toBeNull();
        expect(downloadCalls).toBe(0);
      } finally {
        (AndroidCtrlProxyManager as any).defaultFileDownloader = originalDefaultDownloader;
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
      }
    });

    test("should allow background refresh to retry failed prefetches", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("");
      const zip = new AdmZip();
      zip.addFile(
        "AndroidManifest.xml",
        Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest></manifest>', "utf8"),
      );
      zip.addFile("classes.dex", crypto.randomBytes(15000));
      const payload = zip.toBuffer();
      const originalDefaultDownloader = (AndroidCtrlProxyManager as any).defaultFileDownloader;
      let downloadCalls = 0;
      let failedDestination: string | null = null;

      try {
        (AndroidCtrlProxyManager as any).defaultFileDownloader = {
          download: async (_url: string, destination: string) => {
            downloadCalls++;
            if (downloadCalls === 1) {
              failedDestination = destination;
              throw new Error("network is unreachable");
            }
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, payload);
          },
        };

        AndroidCtrlProxyManager.prefetchApk();
        expect(await AndroidCtrlProxyManager.getPrefetchedApkPath()).toBeNull();
        expect(failedDestination).not.toBeNull();
        // REWRITE-3: a bare rejects.toThrow() passes for ANY stat error. Pin the
        // reason to ENOENT to prove the partial prefetch dir was actually removed
        // (not, say, an EACCES that would also "throw").
        const statError = await fs.stat(path.dirname(failedDestination!)).then(
          () => null,
          (error: NodeJS.ErrnoException) => error,
        );
        expect(statError?.code).toBe("ENOENT");

        AndroidCtrlProxyManager.prefetchApk();
        const retriedPath = await AndroidCtrlProxyManager.getPrefetchedApkPath();

        expect(downloadCalls).toBe(2);
        expect(retriedPath).not.toBeNull();
      } finally {
        (AndroidCtrlProxyManager as any).defaultFileDownloader = originalDefaultDownloader;
      }
    });

    test("reuses a verified cache asset and reaps stale staging directories across daemon lifecycles", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("");
      const zip = new AdmZip();
      zip.addFile(
        "AndroidManifest.xml",
        Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest></manifest>', "utf8"),
      );
      zip.addFile("classes.dex", crypto.randomBytes(15000));
      const payload = zip.toBuffer();
      const originalDefaultDownloader = (AndroidCtrlProxyManager as any).defaultFileDownloader;
      let downloadCalls = 0;

      try {
        (AndroidCtrlProxyManager as any).defaultFileDownloader = {
          download: async (_url: string, destination: string) => {
            downloadCalls++;
            await fs.writeFile(destination, payload);
          },
        };

        const firstPath = await AndroidCtrlProxyManager.prefetchApk();
        await AndroidCtrlProxyManager.cleanupPrefetchedApk();
        const staleStagingDir = path.join(prefetchCacheDir, "auto-mobile-prefetch-orphan");
        await fs.mkdir(staleStagingDir);
        const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await fs.utimes(staleStagingDir, staleTime, staleTime);
        const secondPath = await AndroidCtrlProxyManager.prefetchApk();

        expect(firstPath).not.toBeNull();
        expect(secondPath).toBe(firstPath);
        expect(downloadCalls).toBe(1);
        expect(await fs.stat(firstPath!)).toBeDefined();
        const staleStatError = await fs.stat(staleStagingDir).then(
          () => null,
          (error: NodeJS.ErrnoException) => error,
        );
        expect(staleStatError?.code).toBe("ENOENT");
      } finally {
        (AndroidCtrlProxyManager as any).defaultFileDownloader = originalDefaultDownloader;
      }
    });

    test("removes the successful prefetch staging directory after publishing the cache", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("");
      const zip = new AdmZip();
      zip.addFile(
        "AndroidManifest.xml",
        Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest></manifest>', "utf8"),
      );
      zip.addFile("classes.dex", crypto.randomBytes(15000));
      const payload = zip.toBuffer();
      const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlproxy-stage-root-"));
      const stageDir = path.join(stageRoot, "auto-mobile-prefetch-stage");
      await fs.mkdir(stageDir);
      const mkdtempSpy = spyOn(fs, "mkdtemp").mockResolvedValue(stageDir);
      const originalDefaultDownloader = (AndroidCtrlProxyManager as any).defaultFileDownloader;

      try {
        (AndroidCtrlProxyManager as any).defaultFileDownloader = {
          download: async (_url: string, destination: string) => {
            await fs.writeFile(destination, payload);
          },
        };

        await expect(AndroidCtrlProxyManager.prefetchApk()).resolves.not.toBeNull();
        const statError = await fs.stat(stageDir).then(
          () => null,
          (error: NodeJS.ErrnoException) => error,
        );
        expect(statError?.code).toBe("ENOENT");
      } finally {
        (AndroidCtrlProxyManager as any).defaultFileDownloader = originalDefaultDownloader;
        mkdtempSpy.mockRestore();
        await fs.rm(stageRoot, { recursive: true, force: true });
      }
    });

    test("should cache failed download result briefly instead of retrying every call", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const fakeTimer = new FakeTimer();
      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: "",
          stderr: "",
        },
      );

      let downloadCalls = 0;
      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        localFakeAdb,
        fakeTimer,
        {
          download: async () => {
            downloadCalls++;
            throw new Error("Could not resolve host");
          },
        },
      );

      const firstResult = await manager.ensureCompatibleVersion();
      const secondResult = await manager.ensureCompatibleVersion();
      expect(firstResult.status).toBe("failed");
      expect(firstResult.downloadUnavailable).toBe(true);
      expect(secondResult.status).toBe("failed");
      expect(downloadCalls).toBe(1);

      fakeTimer.advanceTime(61_000);
      await manager.ensureCompatibleVersion();
      expect(downloadCalls).toBe(2);
    });

    test("should reinstall when upgrade install fails", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse(
        `shell pm uninstall ${AndroidCtrlProxyManager.PACKAGE}`,
        createExecResult("Success", ""),
      );

      const localExecAsync = async (command: string, maxBuffer?: number) => {
        const prefix = "adb -s test-device ";
        const strippedCommand = command.startsWith(prefix) ? command.slice(prefix.length) : command;
        if (strippedCommand.includes("install -r -d")) {
          throw new Error("INSTALL_FAILED");
        }
        return localFakeAdb.executeCommand(strippedCommand, undefined, maxBuffer);
      };

      // Create AdbClient with custom executor that throws on install, wrap in factory
      const localAdbClient = new AdbClient(testDevice, localExecAsync);
      const localFactory: AdbClientFactory = { create: () => localAdbClient };

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.getInstance(testDevice, localFactory);
      (manager as any).downloadApk = async () => "/tmp/fake-accessibility.apk";
      (manager as any).cleanupApk = async () => undefined;
      (manager as any).install = async () => undefined;
      (manager as any).enable = async () => undefined;

      const result = await manager.ensureCompatibleVersion({ allowDownloadWhenInstalled: true });
      expect(result.status).toBe("reinstalled");
      expect(localFakeAdb.wasCommandExecuted("shell pm uninstall")).toBe(true);
    });

    test("should skip version check when local APK override is set", async function () {
      process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH = "/tmp/local-accessibility.apk";

      const result = await accessibilityServiceClient.ensureCompatibleVersion();
      expect(result.status).toBe("skipped");
    });

    test("should skip version check when SHA skip flag is true", async function () {
      process.env.AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK = "true";

      const result = await accessibilityServiceClient.ensureCompatibleVersion();
      expect(result.status).toBe("skipped");
    });

    test("should skip download when preinstalled APK is allowed", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = "true";

      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.getInstance(testDevice, {
        create: () => localFakeAdb,
      });
      (manager as any).downloadApk = async () => {
        throw new Error("download should not be called");
      };

      const result = await manager.ensureCompatibleVersion();
      expect(result.status).toBe("skipped");
      expect(result.acceptedPreinstalled).toBeUndefined();
    });

    test("should reinstall when installed SHA cannot be determined", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const executedCommands: string[] = [];
      const apkPath = "/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk";

      const localExecAsync = async (command: string) => {
        const prefix = "adb -s test-device ";
        const strippedCommand = command.startsWith(prefix) ? command.slice(prefix.length) : command;
        executedCommands.push(strippedCommand);

        if (strippedCommand.includes("shell pm list packages")) {
          return createExecResult(`package:${AndroidCtrlProxyManager.PACKAGE}\n`, "");
        }

        if (strippedCommand.includes("shell pm path")) {
          return createExecResult(`package:${apkPath}\n`, "");
        }

        if (strippedCommand.includes("shell sha256sum")) {
          throw new Error("sha256sum not available");
        }

        if (strippedCommand.includes("pull")) {
          throw new Error("pull failed");
        }

        if (strippedCommand.includes("shell pm uninstall")) {
          return createExecResult("Success", "");
        }

        if (strippedCommand.includes("install -r -d")) {
          throw new Error("Unexpected upgrade call");
        }

        return createExecResult("", "");
      };

      // Create AdbClient with custom executor, wrap in factory
      const localAdbClient = new AdbClient(testDevice, localExecAsync);
      const localFactory: AdbClientFactory = { create: () => localAdbClient };

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.getInstance(testDevice, localFactory);
      (manager as any).downloadApk = async () => "/tmp/fake-accessibility.apk";
      (manager as any).cleanupApk = async () => undefined;
      (manager as any).install = async () => undefined;
      (manager as any).enable = async () => undefined;

      const result = await manager.ensureCompatibleVersion({ allowDownloadWhenInstalled: true });
      expect(result.status).toBe("reinstalled");
      expect(executedCommands.some((command) => command.includes("install -r -d"))).toBe(false);
      expect(executedCommands.some((command) => command.includes("shell pm uninstall"))).toBe(true);
    });

    test("should mark download unavailable when offline", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        localFakeAdb,
        new FakeTimer(),
        {
          download: async () => {
            throw new Error("Could not resolve host");
          },
        },
      );

      const result = await manager.ensureCompatibleVersion({ allowDownloadWhenInstalled: true });
      expect(result.status).toBe("failed");
      expect(result.downloadUnavailable).toBe(true);
      expect(result.error).toContain("offline");
    });

    test("should not let forced update failures poison nonblocking readiness cache", async function () {
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      const localFakeAdb = new FakeAdbExecutor();
      localFakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      localFakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      localFakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        localFakeAdb,
        new FakeTimer(),
        {
          download: async () => {
            throw new Error("Could not resolve host");
          },
        },
      );

      const forcedResult = await manager.ensureCompatibleVersion({
        allowDownloadWhenInstalled: true,
      });
      const readinessResult = await manager.ensureCompatibleVersion();

      expect(forcedResult.status).toBe("failed");
      expect(readinessResult.status).toBe("skipped");
      expect(readinessResult.downloadUnavailable).toBeUndefined();
    });
  });

  describe("isPinnedVersionUnverifiable", () => {
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

    test("false when no explicit pin (latest)", () => {
      withVersion(undefined, () =>
        expect(AndroidCtrlProxyManager.isPinnedVersionUnverifiable()).toBe(false),
      );
    });

    test("false for a known explicit pin", () => {
      withVersion("0.0.18", () =>
        expect(AndroidCtrlProxyManager.isPinnedVersionUnverifiable()).toBe(false),
      );
    });

    test("true for an unknown explicit pin", () => {
      withVersion("99.99.99", () =>
        expect(AndroidCtrlProxyManager.isPinnedVersionUnverifiable()).toBe(true),
      );
    });

    test("false for an unknown pin when checksum skip is configured", () => {
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = "true";
      withVersion("99.99.99", () =>
        expect(AndroidCtrlProxyManager.isPinnedVersionUnverifiable()).toBe(false),
      );
    });
  });

  describe("downloadApk", () => {
    test("should copy from local APK override when provided", async function () {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-test-apk-"));
      const localApkPath = path.join(tempDir, "control-proxy-debug.apk");

      // Create a valid APK structure (ZIP with AndroidManifest.xml)
      const zip = new AdmZip();
      const manifestContent = '<?xml version="1.0" encoding="utf-8"?><manifest></manifest>';
      zip.addFile("AndroidManifest.xml", Buffer.from(manifestContent, "utf8"));
      // Add padding to ensure size > 10KB
      // Using random data to prevent compression from reducing size too much
      const paddingData = crypto.randomBytes(15000);
      zip.addFile("classes.dex", paddingData);
      zip.writeZip(localApkPath);

      process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH = localApkPath;
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = "true";

      const apkPath = await accessibilityServiceClient.downloadApk();
      const stats = await fs.stat(apkPath);
      expect(stats.size).toBeGreaterThan(10000);
    });

    test("should resolve relative local APK override from daemon launch cwd", async function () {
      const launchCwd = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-launch-cwd-"));
      const localApkPath = path.join(launchCwd, "build", "control-proxy-debug.apk");
      await fs.mkdir(path.dirname(localApkPath), { recursive: true });

      const zip = new AdmZip();
      zip.addFile(
        "AndroidManifest.xml",
        Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest></manifest>', "utf8"),
      );
      zip.addFile("classes.dex", crypto.randomBytes(15000));
      zip.writeZip(localApkPath);

      process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
      process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH = path.join("build", "control-proxy-debug.apk");
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = "true";

      const apkPath = await accessibilityServiceClient.downloadApk();
      const stats = await fs.stat(apkPath);
      expect(stats.size).toBeGreaterThan(10000);

      await accessibilityServiceClient.cleanupApk(apkPath);
      await fs.rm(launchCwd, { recursive: true, force: true });
    });

    test("should download remote APK and verify checksum via injected utilities", async function () {
      // Create a valid APK structure (ZIP with AndroidManifest.xml)
      const zip = new AdmZip();
      const manifestContent = '<?xml version="1.0" encoding="utf-8"?><manifest></manifest>';
      zip.addFile("AndroidManifest.xml", Buffer.from(manifestContent, "utf8"));
      const paddingData = crypto.randomBytes(15000);
      zip.addFile("classes.dex", paddingData);
      const payload = zip.toBuffer();
      const expectedChecksum = crypto.createHash("sha256").update(payload).digest("hex");
      AndroidCtrlProxyManager.setExpectedChecksumForTesting(expectedChecksum);

      // Inject fake FileDownloader that writes the APK payload
      let downloadedPath: string | null = null;
      (accessibilityServiceClient as any).fileDownloader = {
        download: async (_url: string, destination: string) => {
          downloadedPath = destination;
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, payload);
        },
      };

      // Inject fake ChecksumCalculator that returns the expected checksum
      (accessibilityServiceClient as any).checksumCalculator = {
        computeFileSha256: async () => ({
          checksum: expectedChecksum,
          source: "node" as const,
        }),
      };

      const apkPath = await accessibilityServiceClient.downloadApk();
      const stats = await fs.stat(apkPath);
      expect(stats.size).toBe(payload.length);
      expect(apkPath).toBe(downloadedPath);
      await accessibilityServiceClient.cleanupApk(apkPath);
    });

    test("fails closed when AUTOMOBILE_VERSION is pinned to an unknown version (#2746)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      try {
        const zip = new AdmZip();
        zip.addFile(
          "AndroidManifest.xml",
          Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest></manifest>', "utf8"),
        );
        zip.addFile("classes.dex", crypto.randomBytes(15000));
        const payload = zip.toBuffer();

        // No expected-checksum override and no APK-path/skip override: the pinned
        // version has no registry checksum, so the download is unverifiable and
        // must fail closed rather than install an unchecked APK (esp. from a mirror).
        (accessibilityServiceClient as any).fileDownloader = {
          download: async (_url: string, destination: string) => {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, payload);
          },
        };

        await expect(accessibilityServiceClient.downloadApk()).rejects.toThrow(
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

    test("installs when the pinned version's checksum override is set (skip escape hatch, #2746)", async function () {
      const prevVersion = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = "true";
      try {
        const zip = new AdmZip();
        zip.addFile(
          "AndroidManifest.xml",
          Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest></manifest>', "utf8"),
        );
        zip.addFile("classes.dex", crypto.randomBytes(15000));
        const payload = zip.toBuffer();

        (accessibilityServiceClient as any).fileDownloader = {
          download: async (_url: string, destination: string) => {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, payload);
          },
        };

        const apkPath = await accessibilityServiceClient.downloadApk();
        const stats = await fs.stat(apkPath);
        expect(stats.size).toBe(payload.length);
        await accessibilityServiceClient.cleanupApk(apkPath);
      } finally {
        if (prevVersion === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prevVersion;
        }
      }
    });

    test("should fail when checksum does not match", async function () {
      // Create a valid APK structure (ZIP with AndroidManifest.xml)
      const zip = new AdmZip();
      const manifestContent = '<?xml version="1.0" encoding="utf-8"?><manifest></manifest>';
      zip.addFile("AndroidManifest.xml", Buffer.from(manifestContent, "utf8"));
      const paddingData = crypto.randomBytes(15000);
      zip.addFile("classes.dex", paddingData);
      const payload = zip.toBuffer();
      const expectedChecksum = crypto.createHash("sha256").update(payload).digest("hex");
      AndroidCtrlProxyManager.setExpectedChecksumForTesting(expectedChecksum);

      // Inject fake FileDownloader that writes the APK payload
      (accessibilityServiceClient as any).fileDownloader = {
        download: async (_url: string, destination: string) => {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, payload);
        },
      };

      // Inject fake ChecksumCalculator that returns a mismatched checksum
      (accessibilityServiceClient as any).checksumCalculator = {
        computeFileSha256: async () => ({
          checksum: "mismatched-checksum",
          source: "node" as const,
        }),
      };

      await expect(accessibilityServiceClient.downloadApk()).rejects.toThrow(
        "APK checksum verification failed",
      );
    });

    test("should fail when downloaded APK is too small", async function () {
      const payload = Buffer.alloc(250, 5);

      // Inject fake FileDownloader that writes a tiny payload
      (accessibilityServiceClient as any).fileDownloader = {
        download: async (_url: string, destination: string) => {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, payload);
        },
      };

      await expect(accessibilityServiceClient.downloadApk()).rejects.toThrow(
        "Downloaded APK is too small",
      );
    });

    test("should fail when download errors", async function () {
      // Inject fake FileDownloader that throws
      (accessibilityServiceClient as any).fileDownloader = {
        download: async () => {
          throw new Error("download failed");
        },
      };

      await expect(accessibilityServiceClient.downloadApk()).rejects.toThrow(
        "Failed to download APK: download failed",
      );
    });
  });

  describe("setup", function () {
    test("should allow repeated setup when service is already available", async function () {
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = "true";
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`,
        stderr: "",
      });

      const firstResult = await accessibilityServiceClient.setup();
      expect(firstResult.success).toBe(true);

      const secondResult = await accessibilityServiceClient.setup();
      expect(secondResult.success).toBe(true);
    });
  });

  describe("enableViaSettings", function () {
    test("should enable service when no services are currently enabled (null)", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: "null",
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${serviceComponent}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableViaSettings();

      expect(
        fakeAdb.wasCommandExecuted("shell settings get secure enabled_accessibility_services"),
      ).toBe(true);
      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings put secure enabled_accessibility_services "${serviceComponent}"`,
        ),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 1")).toBe(
        true,
      );
    });

    test("should enable service when no services are currently enabled (empty string)", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${serviceComponent}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableViaSettings();

      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings put secure enabled_accessibility_services "${serviceComponent}"`,
        ),
      ).toBe(true);
    });

    test("should append service to existing services list", async function () {
      const existingServices = "com.example.other/com.example.other.Service";
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
      const expectedServices = `${existingServices}:${serviceComponent}`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: existingServices,
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${expectedServices}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableViaSettings();

      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings put secure enabled_accessibility_services "${expectedServices}"`,
        ),
      ).toBe(true);
    });

    test("should not re-enable service if already enabled", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: serviceComponent,
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableViaSettings();

      // Should still enable accessibility globally but not modify the services list
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 1")).toBe(
        true,
      );
      expect(
        fakeAdb.wasCommandExecuted(`shell settings put secure enabled_accessibility_services`),
      ).toBe(false);
    });

    test("should preserve other services when enabling in middle of list", async function () {
      const existingServices =
        "com.example.first/com.example.First:com.example.second/com.example.Second";
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
      const expectedServices = `${existingServices}:${serviceComponent}`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: existingServices,
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${expectedServices}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableViaSettings();

      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings put secure enabled_accessibility_services "${expectedServices}"`,
        ),
      ).toBe(true);
    });

    test("should invalidate accessibility detector cache after enabling service", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
      const fakeDetector = new FakeAccessibilityDetector();
      AndroidCtrlProxyManager.setAccessibilityDetectorForTesting(fakeDetector);

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: "null",
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${serviceComponent}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      // Verify cache is empty before
      expect(fakeDetector.getInvalidatedDevices()).toEqual([]);

      await accessibilityServiceClient.enableViaSettings();

      // Verify cache was invalidated for our device
      expect(fakeDetector.getInvalidatedDevices()).toEqual(["test-device"]);
    });

    test("should invalidate accessibility detector cache with correct device ID when appending to existing services", async function () {
      const existingServices = "com.example.other/com.example.other.Service";
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
      const expectedServices = `${existingServices}:${serviceComponent}`;
      const fakeDetector = new FakeAccessibilityDetector();
      AndroidCtrlProxyManager.setAccessibilityDetectorForTesting(fakeDetector);

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: existingServices,
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${expectedServices}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableViaSettings();

      // Verify cache was invalidated for our device
      expect(fakeDetector.getInvalidatedDevices()).toEqual(["test-device"]);
    });

    test("should invalidate accessibility detector cache even when service already enabled", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
      const fakeDetector = new FakeAccessibilityDetector();
      AndroidCtrlProxyManager.setAccessibilityDetectorForTesting(fakeDetector);

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: serviceComponent,
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableViaSettings();

      // Verify cache was still invalidated (even though service was already in list)
      expect(fakeDetector.getInvalidatedDevices()).toEqual(["test-device"]);
    });
  });

  describe("getToggleCapabilities", function () {
    test("should detect emulator and support settings toggle", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });

      const capabilities = await accessibilityServiceClient.getToggleCapabilities();

      expect(capabilities.supportsSettingsToggle).toBe(true);
      expect(capabilities.deviceType).toBe("emulator");
      expect(capabilities.apiLevel).toBe(29);
      expect(capabilities.reason).toBeUndefined();
    });

    test("should not cache capabilities when detection errors occur", async function () {
      let callCount = 0;
      const transientFakeAdb: any = {
        executeCommand: async (command: string) => {
          callCount++;
          // First call fails, second call succeeds
          if (callCount <= 2) {
            throw new Error("ADB transient error");
          }

          if (command.includes("ro.kernel.qemu")) {
            return { stdout: "1", stderr: "" };
          }
          if (command.includes("ro.build.version.sdk")) {
            return { stdout: "29", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      };

      AndroidCtrlProxyManager.resetInstances();
      const manager = AndroidCtrlProxyManager.getInstance(testDevice, {
        create: () => transientFakeAdb,
      });

      // First call - should fail with error and NOT cache
      const capabilities1 = await manager.getToggleCapabilities();
      expect(capabilities1.supportsSettingsToggle).toBe(false);
      expect(capabilities1.reason).toContain("transient error");

      // Second call - should retry and succeed
      const capabilities2 = await manager.getToggleCapabilities();
      expect(capabilities2.supportsSettingsToggle).toBe(true);
      expect(capabilities2.deviceType).toBe("emulator");
      expect(capabilities2.apiLevel).toBe(29);
    });

    test("should detect physical device and not support settings toggle", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.product.model", {
        stdout: "Pixel 6",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "33",
        stderr: "",
      });

      const capabilities = await accessibilityServiceClient.getToggleCapabilities();

      expect(capabilities.supportsSettingsToggle).toBe(false);
      expect(capabilities.deviceType).toBe("physical");
      expect(capabilities.apiLevel).toBe(33);
      expect(capabilities.reason).toContain("Physical devices may require");
    });

    test("should fallback to model detection when qemu prop is unavailable", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.product.model", {
        stdout: "sdk_gphone64_arm64",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "35",
        stderr: "",
      });

      const capabilities = await accessibilityServiceClient.getToggleCapabilities();

      expect(capabilities.supportsSettingsToggle).toBe(true);
      expect(capabilities.deviceType).toBe("emulator");
      expect(capabilities.apiLevel).toBe(35);
    });

    test("should reject devices with API level below 16", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "15",
        stderr: "",
      });

      const capabilities = await accessibilityServiceClient.getToggleCapabilities();

      expect(capabilities.supportsSettingsToggle).toBe(false);
      expect(capabilities.deviceType).toBe("emulator");
      expect(capabilities.apiLevel).toBe(15);
      expect(capabilities.reason).toContain("API level 15 is too old");
    });

    test("should handle API level parsing errors gracefully", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "invalid",
        stderr: "",
      });

      const capabilities = await accessibilityServiceClient.getToggleCapabilities();

      expect(capabilities.supportsSettingsToggle).toBe(true);
      expect(capabilities.deviceType).toBe("emulator");
      expect(capabilities.apiLevel).toBe(null);
    });

    test("should cache capabilities result", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });

      // First call
      const capabilities1 = await accessibilityServiceClient.getToggleCapabilities();
      const commandCount1 = fakeAdb.getExecutedCommands().length;

      // Second call should use cache
      const capabilities2 = await accessibilityServiceClient.getToggleCapabilities();
      const commandCount2 = fakeAdb.getExecutedCommands().length;

      expect(capabilities1).toEqual(capabilities2);
      expect(commandCount2).toBe(commandCount1); // No new commands executed
    });

    test("should clear cache when clearAvailabilityCache is called", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });

      // First call
      await accessibilityServiceClient.getToggleCapabilities();
      const commandCount1 = fakeAdb.getExecutedCommands().length;

      // Clear cache
      accessibilityServiceClient.clearAvailabilityCache();

      // Second call should execute commands again
      await accessibilityServiceClient.getToggleCapabilities();
      const commandCount2 = fakeAdb.getExecutedCommands().length;

      expect(commandCount2).toBeGreaterThan(commandCount1);
    });
  });

  describe("canUseSettingsToggle", function () {
    test("should return true for emulator", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });

      const canUse = await accessibilityServiceClient.canUseSettingsToggle();
      expect(canUse).toBe(true);
    });

    test("should return false for physical device", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.product.model", {
        stdout: "Pixel 6",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "33",
        stderr: "",
      });

      const canUse = await accessibilityServiceClient.canUseSettingsToggle();
      expect(canUse).toBe(false);
    });
  });

  describe("enableViaSettings with capability check", function () {
    test("should throw error when settings toggle is not supported", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.product.model", {
        stdout: "Pixel 6",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "33",
        stderr: "",
      });

      await expect(accessibilityServiceClient.enableViaSettings()).rejects.toThrow(
        "Settings-based accessibility toggle is not supported",
      );
    });

    test("should succeed when settings toggle is supported", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: "null",
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${serviceComponent}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableViaSettings();

      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 1")).toBe(
        true,
      );
    });
  });

  describe("disableViaSettings with capability check", function () {
    test("should throw error when settings toggle is not supported", async function () {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.product.model", {
        stdout: "Pixel 6",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "33",
        stderr: "",
      });

      await expect(accessibilityServiceClient.disableViaSettings()).rejects.toThrow(
        "Settings-based accessibility toggle is not supported",
      );
    });

    test("should succeed when settings toggle is supported", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: serviceComponent,
        stderr: "",
      });
      fakeAdb.setCommandResponse('shell settings put secure enabled_accessibility_services ""', {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 0", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.disableViaSettings();

      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        true,
      );
    });
  });

  describe("disableViaSettings", function () {
    test("should handle null services gracefully", async function () {
      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: "null",
        stderr: "",
      });

      await accessibilityServiceClient.disableViaSettings();

      // Should not execute any put commands
      expect(fakeAdb.wasCommandExecuted("shell settings put secure")).toBe(false);
    });

    test("should handle empty string gracefully", async function () {
      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.disableViaSettings();

      // Should not execute any put commands
      expect(fakeAdb.wasCommandExecuted("shell settings put secure")).toBe(false);
    });

    test("should remove service when it's the only enabled service", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: serviceComponent,
        stderr: "",
      });
      fakeAdb.setCommandResponse('shell settings put secure enabled_accessibility_services ""', {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 0", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.disableViaSettings();

      expect(
        fakeAdb.wasCommandExecuted('shell settings put secure enabled_accessibility_services ""'),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        true,
      );
    });

    test("should remove service from start of list and preserve others", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
      const otherService = "com.example.other/com.example.other.Service";
      const currentServices = `${serviceComponent}:${otherService}`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: currentServices,
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${otherService}"`,
        {
          stdout: "",
          stderr: "",
        },
      );

      await accessibilityServiceClient.disableViaSettings();

      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings put secure enabled_accessibility_services "${otherService}"`,
        ),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        false,
      );
    });

    test("should remove service from middle of list and preserve others", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
      const firstService = "com.example.first/com.example.First";
      const lastService = "com.example.last/com.example.Last";
      const currentServices = `${firstService}:${serviceComponent}:${lastService}`;
      const expectedServices = `${firstService}:${lastService}`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: currentServices,
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${expectedServices}"`,
        {
          stdout: "",
          stderr: "",
        },
      );

      await accessibilityServiceClient.disableViaSettings();

      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings put secure enabled_accessibility_services "${expectedServices}"`,
        ),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        false,
      );
    });

    test("should remove service from end of list and preserve others", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
      const otherService = "com.example.other/com.example.other.Service";
      const currentServices = `${otherService}:${serviceComponent}`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: currentServices,
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${otherService}"`,
        {
          stdout: "",
          stderr: "",
        },
      );

      await accessibilityServiceClient.disableViaSettings();

      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings put secure enabled_accessibility_services "${otherService}"`,
        ),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        false,
      );
    });

    test("should handle case when service is not in the list", async function () {
      const otherService = "com.example.other/com.example.other.Service";

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: otherService,
        stderr: "",
      });

      await accessibilityServiceClient.disableViaSettings();

      // Should not execute any put commands since service was not enabled
      expect(
        fakeAdb.wasCommandExecuted("shell settings put secure enabled_accessibility_services"),
      ).toBe(false);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled")).toBe(
        false,
      );
    });

    test("should disable accessibility globally when removing last service", async function () {
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      // Mock emulator detection
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", {
        stdout: "1",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: serviceComponent,
        stderr: "",
      });
      fakeAdb.setCommandResponse('shell settings put secure enabled_accessibility_services ""', {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 0", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.disableViaSettings();

      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        true,
      );
    });

    // PARAM-9: the split(":")/filter/join surgery has two shapes the start/middle/
    // end/last-service tests never exercise — a trailing separator and a duplicated
    // entry. Assert the whole put command array for each.
    const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
    const otherService = "com.example.other/com.example.other.Service";

    function stubToggleSupported(): void {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", { stdout: "1", stderr: "" });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
    }

    function enabledServicesPutCommands(): string[] {
      return fakeAdb
        .getExecutedCommands()
        .filter((command) => command.includes("put secure enabled_accessibility_services"));
    }

    test("preserves a trailing separator left by another surviving service", async function () {
      // "other:ours:" -> split ["other","ours",""] -> filter ["other",""] -> "other:"
      stubToggleSupported();
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: `${otherService}:${serviceComponent}:`,
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${otherService}:"`,
        {
          stdout: "",
          stderr: "",
        },
      );

      await accessibilityServiceClient.disableViaSettings();

      expect(enabledServicesPutCommands()).toEqual([
        `shell settings put secure enabled_accessibility_services "${otherService}:"`,
      ]);
      // Another service survives, so the global toggle stays on.
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        false,
      );
    });

    test("removes every duplicate of our service in one pass", async function () {
      // "ours:other:ours" -> split -> filter drops BOTH ours -> "other"
      stubToggleSupported();
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: `${serviceComponent}:${otherService}:${serviceComponent}`,
        stderr: "",
      });
      fakeAdb.setCommandResponse(
        `shell settings put secure enabled_accessibility_services "${otherService}"`,
        {
          stdout: "",
          stderr: "",
        },
      );

      await accessibilityServiceClient.disableViaSettings();

      expect(enabledServicesPutCommands()).toEqual([
        `shell settings put secure enabled_accessibility_services "${otherService}"`,
      ]);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        false,
      );
    });
  });

  // Issue #4192: every path that mutates accessibility state must also invalidate the
  // AccessibilityDetector cache, otherwise `observe` keeps reporting the pre-mutation
  // state. The invariant is enforced at a single choke point (clearAvailabilityCache),
  // so a future fourth mutation method inherits it instead of having to remember.
  describe("accessibility detector cache invalidation", function () {
    const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
    let fakeDetector: FakeAccessibilityDetector;

    function stubSettingsToggleSupported(): void {
      // Emulator + API 29 => settings-based toggle is supported.
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", { stdout: "1", stderr: "" });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
    }

    beforeEach(function () {
      fakeDetector = new FakeAccessibilityDetector();
      AndroidCtrlProxyManager.setAccessibilityDetectorForTesting(fakeDetector);
      stubSettingsToggleSupported();
    });

    test("clearAvailabilityCache invalidates the detector cache (the shared choke point)", function () {
      expect(fakeDetector.getInvalidatedDevices()).toEqual([]);

      accessibilityServiceClient.clearAvailabilityCache();

      expect(fakeDetector.getInvalidatedDevices()).toEqual([testDevice.deviceId]);
    });

    test("disableViaSettings invalidates the detector cache", async function () {
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: serviceComponent,
        stderr: "",
      });
      fakeAdb.setCommandResponse('shell settings put secure enabled_accessibility_services ""', {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell settings put secure accessibility_enabled 0", {
        stdout: "",
        stderr: "",
      });

      expect(fakeDetector.getInvalidatedDevices()).toEqual([]);

      await accessibilityServiceClient.disableViaSettings();

      expect(fakeDetector.getInvalidatedDevices()).toContain(testDevice.deviceId);
    });

    test("disableViaSettings invalidates the detector cache when no services are enabled", async function () {
      // Early-return path: the device reports no enabled services, so nothing is written.
      // A detector cache still claiming "available" is exactly the divergence in #4192.
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: "null",
        stderr: "",
      });

      await accessibilityServiceClient.disableViaSettings();

      expect(fakeAdb.wasCommandExecuted("shell settings put secure")).toBe(false);
      expect(fakeDetector.getInvalidatedDevices()).toContain(testDevice.deviceId);
    });

    test("disableViaSettings invalidates the detector cache when the write fails", async function () {
      // A partial failure leaves the device state uncertain, so a cached
      // "available" answer is exactly as wrong as it is after a clean disable.
      fakeAdb.setCommandResponse("shell settings get secure enabled_accessibility_services", {
        stdout: serviceComponent,
        stderr: "",
      });
      fakeAdb.setCommandError(
        'shell settings put secure enabled_accessibility_services ""',
        new Error("device offline"),
      );

      await expect(accessibilityServiceClient.disableViaSettings()).rejects.toThrow();

      expect(fakeDetector.getInvalidatedDevices()).toContain(testDevice.deviceId);
    });

    describe("symmetry across every accessibility mutation method", function () {
      const mutations: Array<{ name: string; run: () => Promise<void> }> = [
        {
          name: "enableViaSettings",
          run: () => accessibilityServiceClient.enableViaSettings(),
        },
        {
          name: "disableViaSettings",
          run: () => accessibilityServiceClient.disableViaSettings(),
        },
        {
          name: "enableForUser",
          run: () => accessibilityServiceClient.enableForUser(10),
        },
      ];

      for (const mutation of mutations) {
        test(`${mutation.name} invalidates the detector cache for the target device`, async function () {
          // Respond to both the default-user and --user forms so one table drives all three.
          for (const prefix of ["shell settings", "shell settings --user 10"]) {
            fakeAdb.setCommandResponse(`${prefix} get secure enabled_accessibility_services`, {
              stdout: serviceComponent,
              stderr: "",
            });
            fakeAdb.setCommandResponse(
              `${prefix} put secure enabled_accessibility_services "${serviceComponent}"`,
              {
                stdout: "",
                stderr: "",
              },
            );
            fakeAdb.setCommandResponse(`${prefix} put secure enabled_accessibility_services ""`, {
              stdout: "",
              stderr: "",
            });
            fakeAdb.setCommandResponse(`${prefix} put secure accessibility_enabled 1`, {
              stdout: "",
              stderr: "",
            });
            fakeAdb.setCommandResponse(`${prefix} put secure accessibility_enabled 0`, {
              stdout: "",
              stderr: "",
            });
          }

          expect(fakeDetector.getInvalidatedDevices()).toEqual([]);

          await mutation.run();

          expect(fakeDetector.getInvalidatedDevices()).toContain(testDevice.deviceId);
        });
      }
    });
  });

  // ADD-4: work-profile (per-user) enable/disable must target `--user <id>`; a
  // dropped `--user` writes to user 0 and leaves the work profile broken.
  describe("per-user accessibility writes", function () {
    const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

    function stubSettingsToggleSupported(): void {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", { stdout: "1", stderr: "" });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
    }

    test("enableForUser writes the service and the global toggle scoped to the target user", async function () {
      stubSettingsToggleSupported();
      fakeAdb.setCommandResponse(
        "shell settings --user 10 get secure enabled_accessibility_services",
        {
          stdout: "null",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse(
        `shell settings --user 10 put secure enabled_accessibility_services "${serviceComponent}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings --user 10 put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableForUser(10);

      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings --user 10 put secure enabled_accessibility_services "${serviceComponent}"`,
        ),
      ).toBe(true);
      expect(
        fakeAdb.wasCommandExecuted("shell settings --user 10 put secure accessibility_enabled 1"),
      ).toBe(true);
      // A user-0 write would mean the `--user 10` scope was dropped.
      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings put secure enabled_accessibility_services "${serviceComponent}"`,
        ),
      ).toBe(false);
    });

    test("enableForUser appends to the target user's existing services without overwriting them", async function () {
      const existing = "com.example.other/com.example.other.Service";
      stubSettingsToggleSupported();
      fakeAdb.setCommandResponse(
        "shell settings --user 10 get secure enabled_accessibility_services",
        {
          stdout: existing,
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse(
        `shell settings --user 10 put secure enabled_accessibility_services "${existing}:${serviceComponent}"`,
        {
          stdout: "",
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse("shell settings --user 10 put secure accessibility_enabled 1", {
        stdout: "",
        stderr: "",
      });

      await accessibilityServiceClient.enableForUser(10);

      expect(
        fakeAdb.wasCommandExecuted(
          `shell settings --user 10 put secure enabled_accessibility_services "${existing}:${serviceComponent}"`,
        ),
      ).toBe(true);
    });

    test("isEnabledForUser reads the target user's service list", async function () {
      fakeAdb.setCommandResponse(
        "shell settings --user 10 get secure enabled_accessibility_services",
        {
          stdout: serviceComponent,
          stderr: "",
        },
      );

      expect(await accessibilityServiceClient.isEnabledForUser(10)).toBe(true);
    });

    test("isEnabledForUser reports disabled when the target user's list omits the service", async function () {
      fakeAdb.setCommandResponse(
        "shell settings --user 10 get secure enabled_accessibility_services",
        {
          stdout: "com.example.other/com.example.other.Service",
          stderr: "",
        },
      );

      expect(await accessibilityServiceClient.isEnabledForUser(10)).toBe(false);
    });
  });

  // Rank 6 / item 6: each enable/disable/enableForUser catch categorizes the
  // failure into one of four diagnoses. Without coverage, permission/offline/
  // timeout all collapse into the generic message.
  describe("enable/disable failure diagnoses", function () {
    function stubSettingsToggleSupported(): void {
      fakeAdb.setCommandResponse("shell getprop ro.kernel.qemu", { stdout: "1", stderr: "" });
      fakeAdb.setCommandResponse("shell getprop ro.build.version.sdk", {
        stdout: "29",
        stderr: "",
      });
    }

    type Diagnosis = { trigger: string; expected: string };
    const diagnoses: Diagnosis[] = [
      { trigger: "permission denied", expected: "Permission denied while" },
      { trigger: "device is offline", expected: "Device connection lost while" },
      { trigger: "operation timed out", expected: "Timeout while" },
      { trigger: "something unexpected happened", expected: "Failed to" },
    ];

    type Method = { name: string; readCommand: string; run: () => Promise<unknown> };
    const methods: Method[] = [
      {
        name: "enableViaSettings",
        readCommand: "shell settings get secure enabled_accessibility_services",
        run: () => accessibilityServiceClient.enableViaSettings(),
      },
      {
        name: "disableViaSettings",
        readCommand: "shell settings get secure enabled_accessibility_services",
        run: () => accessibilityServiceClient.disableViaSettings(),
      },
      {
        name: "enableForUser",
        readCommand: "shell settings --user 10 get secure enabled_accessibility_services",
        run: () => accessibilityServiceClient.enableForUser(10),
      },
    ];

    for (const method of methods) {
      for (const diagnosis of diagnoses) {
        test(`${method.name} maps "${diagnosis.trigger}" to a "${diagnosis.expected}" diagnosis`, async function () {
          stubSettingsToggleSupported();
          fakeAdb.setCommandError(method.readCommand, new Error(diagnosis.trigger));

          await expect(method.run()).rejects.toThrow(diagnosis.expected);
        });
      }
    }
  });

  describe("sweepStalePrefetchDirsOnStartup", function () {
    // Fixed reference "now" used to age fixtures deterministically.
    const NOW_MS = 1_700_000_000_000;
    const HOUR_MS = 60 * 60 * 1000;

    let scratchRoot: string;
    let sweepTimer: FakeTimer;

    async function makeAgedDir(name: string, ageMs: number): Promise<string> {
      const dir = path.join(scratchRoot, name);
      await fs.mkdir(dir, { recursive: true });
      // Put a payload file inside so it mirrors a real prefetch dir.
      await fs.writeFile(path.join(dir, "control-proxy.apk"), Buffer.from("x"));
      const when = new Date(NOW_MS - ageMs);
      await fs.utimes(dir, when, when);
      return dir;
    }

    beforeEach(async function () {
      scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-sweep-root-"));
      sweepTimer = new FakeTimer();
      sweepTimer.setCurrentTime(NOW_MS);
    });

    afterEach(async function () {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    });

    async function exists(target: string): Promise<boolean> {
      try {
        await fs.stat(target);
        return true;
      } catch {
        return false;
      }
    }

    test("removes stale prefetch dirs older than the 60-minute threshold", async function () {
      const stale = await makeAgedDir("auto-mobile-prefetch-zzP8qH", 2 * HOUR_MS);

      await AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(scratchRoot, sweepTimer);

      expect(await exists(stale)).toBe(false);
    });

    test("also removes stale prefetch-upgrade dirs", async function () {
      const staleUpgrade = await makeAgedDir("auto-mobile-prefetch-upgrade-abc123", 2 * HOUR_MS);

      await AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(scratchRoot, sweepTimer);

      expect(await exists(staleUpgrade)).toBe(false);
    });

    test("preserves fresh prefetch dirs within the threshold (in-flight guard)", async function () {
      const fresh = await makeAgedDir("auto-mobile-prefetch-fresh01", 60 * 1000);

      await AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(scratchRoot, sweepTimer);

      expect(await exists(fresh)).toBe(true);
    });

    test("preserves sibling caches and the installed package even when old", async function () {
      const bunxCache = await makeAgedDir("bunx-1234-auto-mobile", 5 * HOUR_MS);
      const sharedCache = await makeAgedDir("automobile-bun-cache-shared", 5 * HOUR_MS);

      await AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(scratchRoot, sweepTimer);

      expect(await exists(bunxCache)).toBe(true);
      expect(await exists(sharedCache)).toBe(true);
    });

    test("is best-effort: a missing temp root does not throw", async function () {
      const missing = path.join(scratchRoot, "does-not-exist");

      await expect(
        AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(missing, sweepTimer),
      ).resolves.toBeUndefined();
    });

    test("caps stale directory work and warns about the skipped remainder", async function () {
      const staleDirs = await Promise.all(
        Array.from({ length: MAX_STALE_PREFETCH_DIRS_PER_STARTUP + 1 }, (_, index) =>
          makeAgedDir(`auto-mobile-prefetch-cap-${String(index).padStart(3, "0")}`, 2 * HOUR_MS),
        ),
      );
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        await AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(scratchRoot, sweepTimer);

        const remaining = await Promise.all(staleDirs.map(exists));
        expect(remaining.filter(Boolean)).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("skipped 1 uninspected prefetch dir candidate"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("does not let fresh directories consume the stale cleanup cap", async function () {
      const freshDirs = await Promise.all(
        Array.from({ length: MAX_STALE_PREFETCH_DIRS_PER_STARTUP }, (_, index) =>
          makeAgedDir(`auto-mobile-prefetch-a-fresh-${index}`, 60 * 1000),
        ),
      );
      const stale = await makeAgedDir("auto-mobile-prefetch-z-stale", 2 * HOUR_MS);
      const readdirSpy = spyOn(fs, "readdir").mockResolvedValue(
        [...freshDirs, stale].map((dir) => ({
          name: path.basename(dir),
          isDirectory: () => true,
        })) as unknown as Dirent[],
      );

      try {
        await AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(scratchRoot, sweepTimer);

        expect(await exists(stale)).toBe(false);
        await expect(Promise.all(freshDirs.map(exists))).resolves.toEqual(
          Array(MAX_STALE_PREFETCH_DIRS_PER_STARTUP).fill(true),
        );
      } finally {
        readdirSpy.mockRestore();
      }
    });

    test("stops inspection when the stale-prefetch deadline expires", async function () {
      const first = await makeAgedDir("auto-mobile-prefetch-first", 2 * HOUR_MS);
      const second = await makeAgedDir("auto-mobile-prefetch-second", 2 * HOUR_MS);
      const originalStat = fs.stat;
      let statCount = 0;
      const statSpy = spyOn(fs, "stat").mockImplementation(async (...args) => {
        statCount++;
        if (statCount === 1) {
          sweepTimer.advanceTime(STALE_PREFETCH_SWEEP_DEADLINE_MS);
        }
        return originalStat(...args);
      });
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        await AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(scratchRoot, sweepTimer);

        expect(statCount).toBe(1);
        expect(await exists(first)).toBe(true);
        expect(await exists(second)).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Prefetch sweep timed out"));
      } finally {
        warnSpy.mockRestore();
        statSpy.mockRestore();
      }
    });
  });
});
