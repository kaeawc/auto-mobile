import { describe, expect, test, spyOn } from "bun:test";
import { grantRecordAudioPermission } from "../../src/ctrlProxy/grantRecordAudioPermission";
import {
  AndroidCtrlProxyApkInstaller,
  type AndroidCtrlProxyApkInstallerHost,
} from "../../src/ctrlProxy/AndroidCtrlProxyApkInstaller";
import { CTRL_PROXY_PACKAGE } from "../../src/ctrlProxy/constants";
import { createExecResult } from "../../src/utils/execResult";
import { logger } from "../../src/utils/logger";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";

function installer(adb: FakeAdbExecutor, userId?: number) {
  const host: AndroidCtrlProxyApkInstallerHost = {
    adb,
    timer: new FakeTimer(),
    fileDownloader: new FakeFileDownloader(),
    checksumCalculator: new FakeChecksumCalculator(),
    assertPinnedVersionVerifiable: () => {},
    getApkPathOverride: () => null,
    consumePrefetchedApk: async () => false,
    getExpectedChecksum: async () => "",
    cleanupApk: async () => {},
    assertNotDrivenByOtherDaemon: async () => {},
    clearAvailabilityCache: () => {},
    executeApkStage: async (command) => adb.executeCommand(command),
    grantLocalNetworkAfterInstall: async () => {},
    statusInspectionDeviceError: () => undefined,
    getApiLevel: async () => [36, true],
    setupUser: async () => userId,
    device: { name: "test", deviceId: "emulator-5554", platform: "android" },
  };
  return new AndroidCtrlProxyApkInstaller(host);
}

describe("grantRecordAudioPermission", () => {
  for (const user of [undefined, 10]) {
    test(`grants RECORD_AUDIO for user ${user ?? "default"}`, async () => {
      const adb = new FakeAdbExecutor();
      await grantRecordAudioPermission(adb, user);
      expect(adb.getExecutedCommands()).toEqual([
        `shell pm grant${user === undefined ? "" : " --user 10"} ${CTRL_PROXY_PACKAGE} android.permission.RECORD_AUDIO`,
      ]);
      expect(adb.getCommandCalls()[0].noRetry).toBe(true);
      expect(adb.getApiLevelCalls()).toEqual([]);
    });
    test(`installer grants after install for user ${user ?? "default"}`, async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("install ", createExecResult("Success", ""));
      await installer(adb, user).install("/fake/control-proxy.apk");
      expect(adb.getExecutedCommands()).toEqual([
        'install "/fake/control-proxy.apk"',
        `shell pm grant${user === undefined ? "" : " --user 10"} ${CTRL_PROXY_PACKAGE} android.permission.RECORD_AUDIO`,
      ]);
    });
  }
  test("a thrown error warns without rejecting", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDefaultError(new Error("transport reset"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await grantRecordAudioPermission(adb);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to grant android.permission.RECORD_AUDIO"),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });
  test("unknown permissions are logged at debug", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDefaultResponse(
      createExecResult("", "Unknown permission: android.permission.RECORD_AUDIO"),
    );
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      await grantRecordAudioPermission(adb);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("not grantable"));
    } finally {
      debug.mockRestore();
    }
  });
  test("grant failure does not fail installation", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("install ", createExecResult("Success", ""));
    adb.setCommandError("pm grant", new Error("transport reset"));
    await installer(adb).install("/fake/control-proxy.apk");
  });
  test("failed installation does not grant", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("install ", createExecResult("Failure", ""));
    await expect(installer(adb).install("/fake/control-proxy.apk")).rejects.toThrow(
      "Installation failed",
    );
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });
});
