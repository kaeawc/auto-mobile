import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkCtrlProxy,
  checkCtrlProxyVersion,
  checkDaemonVersion,
} from "../../src/doctor/checks/automobile";
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
});
