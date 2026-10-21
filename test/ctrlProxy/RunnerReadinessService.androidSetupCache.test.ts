import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import {
  RunnerReadinessService,
  type ReadinessClient,
  type RunnerReadinessDependencies,
} from "../../src/ctrlProxy/RunnerReadinessService";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { useFakeCtrlProxyManagerHost } from "../helpers/ctrlProxyManagerHost";

const checksum = "a".repeat(64);
const packageName = AndroidCtrlProxyManager.PACKAGE;
const packageList = `shell pm list packages ${packageName}`;
const enabledSettings = "shell settings get secure enabled_accessibility_services";
const device: BootedDevice = {
  deviceId: "emulator-13971",
  platform: "android",
  name: "readiness-cache-test",
};

function createHarness() {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(packageList, createExecResult(`package:${packageName}\n`, ""));
  adb.setCommandResponse(
    `shell pm path ${packageName}`,
    createExecResult(`package:/data/app/${packageName}/base.apk\n`, ""),
  );
  adb.setCommandResponse(
    "shell sha256sum",
    createExecResult(`${checksum} /data/app/${packageName}/base.apk\n`, ""),
  );
  const setEnabled = (enabled: boolean) =>
    adb.setCommandResponse(
      enabledSettings,
      createExecResult(enabled ? `${packageName}/${packageName}.CtrlProxy` : "", ""),
    );
  setEnabled(true);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const manager = AndroidCtrlProxyManager.createForTestingWithDeps(device, adb, timer);
  // Exercise real setup without unrelated accessibility-rebind diagnostics.
  const readinessManager: Pick<
    AndroidCtrlProxyManager,
    | "ensureCompatibleVersion"
    | "isInstalled"
    | "isEnabled"
    | "isVersionCompatible"
    | "enable"
    | "setup"
    | "resetSetupState"
    | "reopenSetupGate"
  > = {
    ensureCompatibleVersion: (options) => manager.ensureCompatibleVersion(options),
    isInstalled: () => manager.isInstalled(),
    isEnabled: (signal, options) => manager.isEnabled(signal, options),
    isVersionCompatible: () => manager.isVersionCompatible(),
    enable: () => manager.enable(),
    setup: (force, perf) => manager.setup(force, perf),
    resetSetupState: () => manager.resetSetupState(),
    reopenSetupGate: () => manager.reopenSetupGate(),
  };
  const client: ReadinessClient = {
    isConnected: () => false,
    waitForConnection: async () => true,
    verifyServiceReady: async () => true,
  };
  const dependencies: RunnerReadinessDependencies = {
    timer,
    getAndroidManager: () => readinessManager,
    getAndroidClient: () => client,
    getIosManager: () => {
      throw new Error("Android readiness must not request an iOS manager");
    },
    getIosClient: () => {
      throw new Error("Android readiness must not request an iOS client");
    },
    checkIosOverride: async () => ({ present: false, usable: true }),
    awaitIosStartupMaintenance: async () => {},
  };
  const service = new RunnerReadinessService(dependencies);
  return {
    adb,
    manager,
    setEnabled,
    ready: () =>
      service.ensureReady({
        device,
        requestedIdentity: "android",
        totalDeadlineMs: timer.now() + 1_000,
        readinessTimeoutMs: 500,
      }),
  };
}

describe("Android readiness setup caches", () => {
  useFakeCtrlProxyManagerHost();
  afterEach(() => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
  });

  test("reads each status command once for an installed enabled disconnected runner", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(checksum);
    const h = createHarness();
    await h.ready();

    const commands = h.adb.getExecutedCommands();
    console.log(
      `readiness adb commands: ${commands.length === 10 ? "before" : "after"}=${commands.length}`,
    );
    expect(commands.toSorted()).toEqual(
      [
        "shell pm list packages dev.jasonpearson.automobile.accessibilityservice",
        packageList,
        `shell pm path ${packageName}`,
        `shell sha256sum '/data/app/${packageName}/base.apk'`,
        enabledSettings,
      ].toSorted(),
    );
    expect(commands).toHaveLength(5);
  });

  test("reopens automated setup after failure while preserving freshly read status", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(checksum);
    const h = createHarness();
    h.setEnabled(false);
    const commandsAtEnable: number[] = [];
    const enable = spyOn(h.manager, "enable").mockImplementation(async () => {
      commandsAtEnable.push(h.adb.getExecutedCommands().length);
      if (commandsAtEnable.length === 1) {
        throw new Error("Permission denied enabling CtrlProxy");
      }
      h.setEnabled(true);
      h.manager.clearAvailabilityCache();
    });
    try {
      await expect(h.ready()).rejects.toThrow("Permission denied enabling CtrlProxy");
      h.adb.clearHistory();
      await h.ready();
      expect(enable).toHaveBeenCalledTimes(2);
      expect(commandsAtEnable).toEqual([5, 5]);
    } finally {
      enable.mockRestore();
    }
  });

  test("installs a missing package and invalidates the fresh negative status on mutation", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(checksum);
    const h = createHarness();
    h.adb.setCommandResponseSequence(packageList, [
      createExecResult("", ""),
      createExecResult(`package:${packageName}\n`, ""),
    ]);
    h.setEnabled(false);
    const download = spyOn(h.manager, "downloadApk").mockResolvedValue("/fake/ctrlproxy.apk");
    const cleanup = spyOn(h.manager, "cleanupApk").mockResolvedValue();
    const clear = spyOn(h.manager, "clearAvailabilityCache");
    const enable = spyOn(h.manager, "enable").mockImplementation(async () => {
      h.setEnabled(true);
      h.manager.clearAvailabilityCache();
    });
    h.adb.setCommandResponse('install "/fake/ctrlproxy.apk"', createExecResult("Success", ""));
    try {
      await h.ready();
      expect(download).toHaveBeenCalledTimes(1);
      expect(enable).toHaveBeenCalledTimes(1);
      expect(h.adb.getExecutedCommands()).toContain('install "/fake/ctrlproxy.apk"');
      expect(await h.manager.isInstalled()).toBe(true);
      expect(await h.manager.isEnabled()).toBe(true);
      // install, enable and compatibility completion invalidate mutated state;
      // reopening the setup gate must not add a fourth invalidation.
      expect(clear).toHaveBeenCalledTimes(3);
    } finally {
      download.mockRestore();
      cleanup.mockRestore();
      clear.mockRestore();
      enable.mockRestore();
    }
  });
});
