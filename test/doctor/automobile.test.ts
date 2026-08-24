import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkImageBackend,
  checkCtrlProxy,
  checkCtrlProxyVersion,
  checkDaemonBuildIdentity,
  checkDaemonStatus,
  checkDaemonVersion,
  runAutoMobileChecks,
} from "../../src/doctor/checks/automobile";
import type { BuildIdentity } from "../../src/daemon/buildIdentity";
import {
  LATEST_RELEASE_VERSION,
  RELEASE_CHECKSUM_REGISTRY,
  RELEASE_VERSION,
  resolveAssetVersion,
} from "../../src/constants/release";
import { getMcpServerVersion } from "../../src/utils/mcpVersion";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import * as fs from "fs/promises";
import * as path from "path";
import AdmZip from "adm-zip";
import crypto from "crypto";
import { FakeLogger } from "../fakes/FakeLogger";

describe("checkDaemonVersion", () => {
  test("returns pass status", () => {
    expect(checkDaemonVersion().status).toBe("pass");
  });

  test("reports the daemon JS package version, not the CtrlProxy version", () => {
    const result = checkDaemonVersion();

    expect(result.name).toBe("AutoMobile Daemon Version");
    expect(result.value).toBe(getMcpServerVersion());
    expect(result.message).toBe(`Version ${getMcpServerVersion()}`);
  });
});

describe("checkCtrlProxyVersion", () => {
  test("returns pass status", () => {
    expect(checkCtrlProxyVersion().status).toBe("pass");
  });

  test("reports the concrete on-device CtrlProxy version from the registry", () => {
    const result = checkCtrlProxyVersion();
    const expected = resolveAssetVersion(RELEASE_VERSION);

    expect(result.name).toBe("CtrlProxy Release Version");
    expect(result.value).toBe(expected);
    if (RELEASE_VERSION === LATEST_RELEASE_VERSION) {
      expect(result.message).toMatch(/\(latest\)$/);
    }
  });

  test("honors AUTOMOBILE_VERSION and drops the (latest) suffix when pinned (EC6)", () => {
    const prev = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    try {
      const result = checkCtrlProxyVersion();
      expect(result.value).toBe("0.0.18");
      expect(result.message).toBe("Version 0.0.18");
    } finally {
      if (prev === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prev;
      }
    }
  });
});

describe("checkImageBackend", () => {
  test("reports active sharp backend and load status on macOS and Linux", async () => {
    const result = await checkImageBackend({
      platform: "linux",
      sharpLoader: async () => ({}) as never,
    });

    expect(result).toEqual({
      name: "Image Backend",
      status: "pass",
      message: "active=sharp; sharp=loaded",
    });
  });

  test("logs and returns a typed failure when sharp cannot load", async () => {
    const warnings: string[] = [];

    const result = await checkImageBackend({
      platform: "darwin",
      sharpLoader: async () => {
        throw new Error("sharp import failed");
      },
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(result.name).toBe("Image Backend");
    expect(result.status).toBe("fail");
    expect(result.message).toBe(
      "active=sharp; sharp=unavailable; webp=unavailable; error=sharp import failed",
    );
    expect(result.recommendation).toContain("Reinstall dependencies");
    expect(result.recommendation).toContain("WebP support");
    expect(warnings).toEqual(["Image backend doctor check failed: sharp import failed"]);
  });

  test("skips real sharp loading when tests spoof process.platform away from the host OS", async () => {
    const result = await checkImageBackend({
      platform: "linux",
      hostPlatform: "darwin",
    });

    expect(result).toEqual({
      name: "Image Backend",
      status: "skip",
      message: "active=sharp; sharp=not checked; platform=linux; host=darwin",
    });
  });

  test("reports active jimp-cli backend and cwebp/dwebp resolution on Windows", async () => {
    const result = await checkImageBackend({
      platform: "win32",
      webpBinaryResolver: {
        resolve: async () => ({
          cwebp: "C:\\auto-mobile\\vendor\\libwebp\\cwebp.exe",
          dwebp: "C:\\auto-mobile\\vendor\\libwebp\\dwebp.exe",
        }),
      },
    });

    expect(result).toEqual({
      name: "Image Backend",
      status: "pass",
      message:
        "active=jimp-cli; cwebp=C:\\auto-mobile\\vendor\\libwebp\\cwebp.exe; dwebp=C:\\auto-mobile\\vendor\\libwebp\\dwebp.exe",
    });
  });

  test("logs and returns a typed failure when Windows WebP binaries are unavailable", async () => {
    const warnings: string[] = [];

    const result = await checkImageBackend({
      platform: "win32",
      webpBinaryResolver: {
        resolve: async () => {
          throw new Error("Unable to resolve cwebp");
        },
      },
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(result.name).toBe("Image Backend");
    expect(result.status).toBe("fail");
    expect(result.message).toBe(
      "active=jimp-cli; cwebp=unavailable; dwebp=unavailable; error=Unable to resolve cwebp",
    );
    expect(result.recommendation).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(warnings).toEqual(["Image backend doctor check failed: Unable to resolve cwebp"]);
  });
});

describe("checkDaemonStatus", () => {
  test("probes daemon socket before invoking status cleanup", async () => {
    const result = await checkDaemonStatus({
      daemonManager: {
        status: async () => {
          throw new Error("status should not run before socket probe succeeds");
        },
      },
      getDaemonHealthReport: async () => ({
        timestamp: "2026-06-29T00:00:00.000Z",
        daemonRunning: true,
        socketExists: true,
        socketAccessible: true,
        pidFileExists: true,
        pidFileValid: true,
        daemonPid: 12345,
        socketConnectable: true,
        recommendations: [],
      }),
    });

    expect(result.name).toBe("Daemon Status");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Running (serving via socket)");
    expect(result.value).toBe(12345);
  });

  test("reports responsive serving daemon when pid status is stale", async () => {
    const result = await checkDaemonStatus({
      daemonManager: {
        status: async () => ({ running: false }),
      },
      getDaemonHealthReport: async () => ({
        timestamp: "2026-06-29T00:00:00.000Z",
        daemonRunning: false,
        socketExists: true,
        socketAccessible: true,
        pidFileExists: false,
        pidFileValid: false,
        socketConnectable: true,
        recommendations: [],
      }),
    });

    expect(result.name).toBe("Daemon Status");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Running (serving via socket)");
    expect(result.recommendation).toBeUndefined();
  });

  test("recommends a concrete pinned install command, never @latest (EC6)", async () => {
    const result = await checkDaemonStatus({
      daemonManager: {
        status: async () => ({ running: false }),
      },
      getDaemonHealthReport: async () => ({
        timestamp: "2026-06-29T00:00:00.000Z",
        daemonRunning: false,
        socketExists: false,
        socketAccessible: false,
        pidFileExists: false,
        pidFileValid: false,
        socketConnectable: false,
        recommendations: [],
      }),
    });

    expect(result.status).toBe("warn");
    expect(result.recommendation).toContain("@kaeawc/auto-mobile@");
    // Issue #2746: floating @latest advice causes silent version drift.
    expect(result.recommendation).not.toContain("@latest");
    expect(result.recommendation).toContain(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});

describe("checkDaemonBuildIdentity", () => {
  const client: BuildIdentity = {
    entryScript: "/wt/dist/src/index.js",
    buildId: "1111111111111111",
  };

  test("skips when the daemon is not running", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: { status: async () => ({ running: false }) },
      getClientBuildIdentity: () => client,
    });

    expect(result.name).toBe("Daemon Build Identity");
    expect(result.status).toBe("skip");
    expect(result.message).toBe("Daemon is not running");
  });

  test("passes and surfaces buildId + entryScript when client and daemon builds match", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: {
        status: async () => ({
          running: true,
          pid: 4242,
          entryScript: "/wt/dist/src/index.js",
          buildId: "1111111111111111",
        }),
      },
      getClientBuildIdentity: () => client,
    });

    expect(result.status).toBe("pass");
    // No `value`: the console formatter renders `value` instead of `message`, so
    // both buildId and entryScript are carried in the message to stay visible.
    expect(result.value).toBeUndefined();
    expect(result.message).toContain("1111111111111111");
    expect(result.message).toContain("/wt/dist/src/index.js");
    expect(result.recommendation).toBeUndefined();
  });

  test("warns and shows BOTH identities when the daemon is a different build", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: {
        status: async () => ({
          running: true,
          pid: 4242,
          entryScript: "/main/dist/src/index.js",
          buildId: "2222222222222222",
        }),
      },
      getClientBuildIdentity: () => client,
    });

    expect(result.status).toBe("warn");
    // daemon identity
    expect(result.message).toContain("2222222222222222");
    expect(result.message).toContain("/main/dist/src/index.js");
    // client identity
    expect(result.message).toContain("1111111111111111");
    expect(result.message).toContain("/wt/dist/src/index.js");
    expect(result.recommendation).toContain("restart");
  });

  test("warns (does not throw) when reading daemon status fails", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: {
        status: async () => {
          throw new Error("PID file unreadable");
        },
      },
      getClientBuildIdentity: () => client,
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("PID file unreadable");
  });

  test("does not report a false skew for a legacy daemon without build identity", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: {
        status: async () => ({
          running: true,
          pid: 4242,
          // legacy daemon predating build identity: no entryScript/buildId
        }),
      },
      getClientBuildIdentity: () => client,
    });

    expect(result.status).toBe("pass");
    expect(result.message).toContain("unknown");
  });
});

describe("checkCtrlProxy", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeFactory: AdbClientFactory;

  beforeEach(() => {
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
    fakeAdb = new FakeAdbExecutor();
    fakeFactory = {
      create: () => fakeAdb,
    };
  });

  afterEach(async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
    await AndroidCtrlProxyManager.cleanupPrefetchedApk();
  });

  test("returns skip when no devices connected", async () => {
    fakeAdb.setDevices([]);

    const result = await checkCtrlProxy(fakeFactory);

    expect(result.name).toBe("CtrlProxy");
    expect(result.status).toBe("skip");
    expect(result.message).toBe("No Android devices connected");
  });

  test("logs unexpected failures at warn before returning typed skip", async () => {
    const log = new FakeLogger();
    const result = await checkCtrlProxy(
      {
        create: () => {
          throw new Error("adb unavailable");
        },
      },
      { logger: log },
    );

    expect(result.name).toBe("CtrlProxy");
    expect(result.status).toBe("skip");
    expect(result.message).toBe("Could not check: adb unavailable");
    expect(log.at("warn")).toContainEqual(
      expect.objectContaining({
        message: "CtrlProxy check failed: adb unavailable",
      }),
    );
  });

  test("fails malformed mirror configuration even when no devices are connected (#2815)", async () => {
    const prevBaseUrl = process.env.AUTOMOBILE_ASSET_BASE_URL;
    process.env.AUTOMOBILE_ASSET_BASE_URL = "https://mirror.test/am?";
    try {
      fakeAdb.setDevices([]);

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.name).toBe("CtrlProxy");
      expect(result.status).toBe("fail");
      expect(result.message).toContain(
        "AUTOMOBILE_ASSET_BASE_URL must not include a query string or fragment",
      );
    } finally {
      if (prevBaseUrl === undefined) {
        delete process.env.AUTOMOBILE_ASSET_BASE_URL;
      } else {
        process.env.AUTOMOBILE_ASSET_BASE_URL = prevBaseUrl;
      }
    }
  });

  test("fails (not skips) when AUTOMOBILE_VERSION pins an unverifiable version (#2746)", async () => {
    const prevVersion = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "99.99.99";
    try {
      fakeAdb.setDevices([
        {
          deviceId: "emulator-5554",
          platform: "android",
          isEmulator: true,
          name: "Pixel",
        },
      ]);

      const result = await checkCtrlProxy(fakeFactory);

      // Must be `fail` so the `--cli doctor` CI gate blocks — a thrown guard would
      // otherwise be caught and downgraded to `skip`, which doesn't count as a failure.
      expect(result.status).toBe("fail");
      expect(result.message).toContain("99.99.99");
      expect(result.recommendation).toContain("AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM");
    } finally {
      if (prevVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prevVersion;
      }
    }
  });

  test("fails (not skips) when a known pinned CtrlProxy APK SHA mismatches (#2815)", async () => {
    const prevVersion = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    try {
      fakeAdb.setDevices([
        {
          deviceId: "emulator-5554",
          platform: "android",
          isEmulator: true,
          name: "Pixel",
        },
      ]);
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.status).toBe("fail");
      expect(result.message).toContain(
        "Installed CtrlProxy APK SHA differs from expected release checksum",
      );
      expect(result.message).toContain("AUTOMOBILE_VERSION=0.0.18");
    } finally {
      if (prevVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prevVersion;
      }
    }
  });

  test("fails (not warns) when a known pinned CtrlProxy APK download fails checksum verification (#2815)", async () => {
    const prevVersion = process.env.AUTOMOBILE_VERSION;
    const originalDefaultDownloader = (AndroidCtrlProxyManager as any).defaultFileDownloader;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    try {
      (AndroidCtrlProxyManager as any).defaultFileDownloader = {
        download: async (_url: string, destination: string) => {
          const zip = new AdmZip();
          zip.addFile(
            "AndroidManifest.xml",
            Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest></manifest>', "utf8"),
          );
          zip.addFile("classes.dex", crypto.randomBytes(15000));
          await fs.mkdir(path.dirname(destination), { recursive: true });
          zip.writeZip(destination);
        },
      };
      fakeAdb.setDevices([
        {
          deviceId: "emulator-5554",
          platform: "android",
          isEmulator: true,
          name: "Pixel",
        },
      ]);
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: "",
          stderr: "",
        },
      );

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.status).toBe("fail");
      expect(result.message).toContain("versionStatus=failed");
      expect(result.message).toContain("APK checksum verification failed");
    } finally {
      (AndroidCtrlProxyManager as any).defaultFileDownloader = originalDefaultDownloader;
      if (prevVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prevVersion;
      }
    }
  });

  test("warns when installed and enabled CtrlProxy is stale but accepted for readiness", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    const originalDefaultDownloader = (AndroidCtrlProxyManager as any).defaultFileDownloader;
    (AndroidCtrlProxyManager as any).defaultFileDownloader = {
      download: async () => {
        throw new Error("network is unreachable");
      },
    };

    try {
      fakeAdb.setDevices([
        {
          deviceId: "emulator-5554",
          platform: "android",
          isEmulator: true,
          name: "Pixel",
        },
      ]);
      fakeAdb.setCommandResponse(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
          stderr: "",
        },
      );
      fakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`,
        stderr: "",
      });

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.status).toBe("warn");
      expect(result.message).toContain("versionStatus=skipped");
      expect(result.message).toContain("acceptedPreinstalled=true");
      expect(result.recommendation).toBe(
        "CtrlProxy is installed and enabled, but its APK SHA differs from the expected release. Re-run doctor after the background APK refresh completes or update CtrlProxy from the latest release.",
      );
    } finally {
      (AndroidCtrlProxyManager as any).defaultFileDownloader = originalDefaultDownloader;
    }
  });

  test("passes skip-env checks without reporting a stale CtrlProxy warning", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    const originalSkipDownload = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
    process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = "true";

    try {
      fakeAdb.setDevices([
        {
          deviceId: "emulator-5554",
          platform: "android",
          isEmulator: true,
          name: "Pixel",
        },
      ]);
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

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.status).toBe("pass");
      expect(result.message).toContain("platform=android");
      expect(result.message).toContain("device=emulator-5554");
      expect(result.message).toContain("versionStatus=skipped");
      expect(result.message).not.toContain("acceptedPreinstalled=true");
      expect(result.recommendation).toBeUndefined();
    } finally {
      if (originalSkipDownload === undefined) {
        delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
      } else {
        process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = originalSkipDownload;
      }
    }
  });
});

describe("runAutoMobileChecks", () => {
  const stubChecks = {
    checkImageBackend: async () => ({
      name: "Image Backend",
      status: "pass" as const,
      message: "active=sharp; sharp=loaded",
    }),
    checkDaemonStatus: async () => ({
      name: "Daemon Status",
      status: "pass" as const,
      message: "Running (serving via socket)",
    }),
    checkDaemonConnectivity: async () => ({
      name: "Daemon Connectivity",
      status: "pass" as const,
      message: "Daemon is responsive",
    }),
    checkDaemonBuildIdentity: async () => ({
      name: "Daemon Build Identity",
      status: "pass" as const,
      message: "Build 1111111111111111 (/wt/dist/src/index.js)",
    }),
  };

  test("skips Android CtrlProxy diagnostics during iOS-only doctor runs", async () => {
    const results = await runAutoMobileChecks({ ios: true }, stubChecks);

    const ctrlProxy = results.find((result) => result.name === "CtrlProxy");

    expect(ctrlProxy?.status).toBe("skip");
    expect(ctrlProxy?.message).toBe("Skipped for iOS-only doctor run");
    expect(ctrlProxy?.message).not.toContain("emulator-5554");
  });

  test("includes the daemon build identity check", async () => {
    const results = await runAutoMobileChecks({ ios: true }, stubChecks);

    const buildIdentity = results.find((result) => result.name === "Daemon Build Identity");

    expect(buildIdentity).toBeDefined();
    expect(buildIdentity?.status).toBe("pass");
  });

  test("includes the image backend provisioning check", async () => {
    const results = await runAutoMobileChecks({ ios: true }, stubChecks);

    const imageBackend = results.find((result) => result.name === "Image Backend");

    expect(imageBackend).toBeDefined();
    expect(imageBackend?.status).toBe("pass");
    expect(imageBackend?.message).toBe("active=sharp; sharp=loaded");
  });

  const androidStubChecks = {
    ...stubChecks,
    checkCtrlProxy: async () => ({
      name: "CtrlProxy",
      status: "pass" as const,
      message: "platform=android; device=emulator-5554",
    }),
    checkWorkProfileAccessibility: async () => ({
      name: "Work Profile Accessibility",
      status: "warn" as const,
      message: "Work profile detected",
    }),
  };

  test("runs the Android CtrlProxy and work-profile checks for an Android run", async () => {
    const results = await runAutoMobileChecks({ android: true }, androidStubChecks);

    const ctrlProxy = results.find((result) => result.name === "CtrlProxy");
    const workProfile = results.find((result) => result.name === "Work Profile Accessibility");

    expect(ctrlProxy?.status).toBe("pass");
    expect(ctrlProxy?.message).toBe("platform=android; device=emulator-5554");
    expect(workProfile?.status).toBe("warn");
    expect(workProfile?.message).toBe("Work profile detected");
  });

  test("does not run the Android checks during an iOS-only run", async () => {
    let androidRan = false;
    const results = await runAutoMobileChecks(
      { ios: true },
      {
        ...androidStubChecks,
        checkCtrlProxy: async () => {
          androidRan = true;
          return { name: "CtrlProxy", status: "pass" as const, message: "should not run" };
        },
      },
    );

    expect(androidRan).toBe(false);
    expect(results.find((result) => result.name === "CtrlProxy")?.status).toBe("skip");
  });
});
