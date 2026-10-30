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
import { AdbCommandTimeoutError } from "../../src/utils/android-cmdline-tools/AdbCommandTimeoutError";

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
    grantPostInstallPermissions: () => apkInstaller.grantPostInstallPermissions(),
    grantLocalNetworkAfterInstall: async () => {},
    statusInspectionDeviceError: () => undefined,
    getApiLevel: async () => [36, true],
    setupUser: async () => userId,
    device: { name: "test", deviceId: "emulator-5554", platform: "android" },
  };
  const apkInstaller = new AndroidCtrlProxyApkInstaller(host);
  return apkInstaller;
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
      expect(adb.getCommandCalls()[0].timeoutMs).toBe(10_000);
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
  test.each(["result", "throw"])("%s timeout then success retries exactly once", async (mode) => {
    const adb = new FakeAdbExecutor();
    if (mode === "result") {
      adb.setCommandResponseSequence("pm grant", [
        { ...createExecResult("", ""), error: "Command timed out after 10000ms" },
        createExecResult("", ""),
      ]);
    } else {
      const execute = adb.execute.bind(adb);
      let attempts = 0;
      adb.execute = async (args, options) => {
        const result = await execute(args, options);
        if (attempts++ === 0) {
          throw new AdbCommandTimeoutError("grant budget expired");
        }
        return result;
      };
    }
    expect(await grantRecordAudioPermission(adb)).toEqual({ granted: true });
    expect(adb.getExecutedCommands()).toHaveLength(2);
    expect(adb.getCommandCalls().map((call) => call.timeoutMs)).toEqual([10_000, 10_000]);
  });

  test.each(["result", "throw"])(
    "%s timeout twice warns and stops after two commands",
    async (mode) => {
      const adb = new FakeAdbExecutor();
      if (mode === "result") {
        adb.setCommandResponse("pm grant", {
          ...createExecResult("", ""),
          error: "Command timeout",
        });
      } else {
        adb.setCommandError("pm grant", new AdbCommandTimeoutError("grant budget expired"));
      }
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(await grantRecordAudioPermission(adb)).toMatchObject({ granted: false });
        expect(adb.getExecutedCommands()).toHaveLength(2);
        expect(adb.getCommandCalls().map((call) => call.timeoutMs)).toEqual([10_000, 10_000]);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("device refusal is not retried", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("pm grant", createExecResult("", "Unknown permission"));
    expect(await grantRecordAudioPermission(adb)).toMatchObject({
      granted: false,
      reason: "Unknown permission",
    });
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test.each([
    "Unknown permission: android.permission.RECORD_AUDIO",
    "java.lang.SecurityException: permission cannot be granted",
    "Error: permission grant refused",
  ])("rejected pm grant with %s is a device refusal without retry", async (output) => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "pm grant",
      new Error("Command failed", {
        cause: Object.assign(new Error("exit code 1"), { stderr: output }),
      }),
    );
    expect(await grantRecordAudioPermission(adb)).toEqual({ granted: false, reason: output });
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test("rejected pm grant with a plain transport error preserves transportError", async () => {
    const adb = new FakeAdbExecutor();
    const error = new Error("transport reset");
    adb.setCommandError("pm grant", error);
    expect(await grantRecordAudioPermission(adb)).toEqual({
      granted: false,
      reason: "transport reset",
      transportError: error,
    });
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

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
  test("unknown permissions are logged at warn", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDefaultResponse(
      createExecResult("", "Unknown permission: android.permission.RECORD_AUDIO"),
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await grantRecordAudioPermission(adb);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not grantable"));
    } finally {
      warn.mockRestore();
    }
  });
  test.each(["transport", "unknown permission"])(
    "%s grant failure warns without failing installation",
    async (failure) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("install ", createExecResult("Success", ""));
      if (failure === "transport") {
        adb.setCommandError("pm grant", new Error("transport reset"));
      } else {
        adb.setCommandResponse("pm grant", createExecResult("", "Unknown permission"));
      }
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await installer(adb).install("/fake/control-proxy.apk");
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );
  test("failed installation does not grant", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("install ", createExecResult("Failure", ""));
    await expect(installer(adb).install("/fake/control-proxy.apk")).rejects.toThrow(
      "Installation failed",
    );
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });
});
