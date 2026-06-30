import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
  RELEASE_VERSION,
  resolveAssetVersion,
} from "../../src/constants/release";
import { getMcpServerVersion } from "../../src/utils/mcpVersion";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";

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
    expect(result.value).toBe("1111111111111111");
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

  test("warns when installed and enabled CtrlProxy is stale but accepted for readiness", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    const originalDefaultDownloader = (AndroidCtrlProxyManager as any).defaultFileDownloader;
    (AndroidCtrlProxyManager as any).defaultFileDownloader = {
      download: async () => {
        throw new Error("network is unreachable");
      }
    };

    try {
      fakeAdb.setDevices([{
        deviceId: "emulator-5554",
        platform: "android",
        isEmulator: true,
        name: "Pixel"
      }]);
      fakeAdb.setCommandResponse(`shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
        stderr: ""
      });
      fakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: ""
      });
      fakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: ""
      });
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`,
        stderr: ""
      });

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.status).toBe("warn");
      expect(result.message).toContain("versionStatus=skipped");
      expect(result.message).toContain("acceptedPreinstalled=true");
      expect(result.recommendation).toBe("CtrlProxy is installed and enabled, but its APK SHA differs from the expected release. Re-run doctor after the background APK refresh completes or update CtrlProxy from the latest release.");
    } finally {
      (AndroidCtrlProxyManager as any).defaultFileDownloader = originalDefaultDownloader;
    }
  });

  test("passes skip-env checks without reporting a stale CtrlProxy warning", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    const originalSkipDownload = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
    process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = "true";

    try {
      fakeAdb.setDevices([{
        deviceId: "emulator-5554",
        platform: "android",
        isEmulator: true,
        name: "Pixel"
      }]);
      fakeAdb.setCommandResponse(`shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
        stderr: ""
      });
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`,
        stderr: ""
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

    const ctrlProxy = results.find(result => result.name === "CtrlProxy");

    expect(ctrlProxy?.status).toBe("skip");
    expect(ctrlProxy?.message).toBe("Skipped for iOS-only doctor run");
    expect(ctrlProxy?.message).not.toContain("emulator-5554");
  });

  test("includes the daemon build identity check", async () => {
    const results = await runAutoMobileChecks({ ios: true }, stubChecks);

    const buildIdentity = results.find(result => result.name === "Daemon Build Identity");

    expect(buildIdentity).toBeDefined();
    expect(buildIdentity?.status).toBe("pass");
  });
});
