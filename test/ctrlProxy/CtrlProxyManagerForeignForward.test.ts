import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { DeviceOwnedByOtherDaemonError } from "../../src/daemon/deviceAcquisitionRefusals";
import type { ForeignCtrlProxyForwardVerdict } from "../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import type { BootedDevice, ExecResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const device: BootedDevice = {
  deviceId: "emulator-12220",
  name: "Foreign forward test",
  platform: "android",
  isEmulator: true,
};

function commandResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString) => stdout.includes(searchString),
  };
}

describe("CtrlProxy manager foreign-forward mutation backstop #12220", () => {
  let adb: FakeAdbExecutor;
  let manager: AndroidCtrlProxyManager;
  let reads: number;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    manager = AndroidCtrlProxyManager.createForTestingWithDeps(device, adb);
    reads = 0;
  });

  afterEach(() => {
    AndroidCtrlProxyManager.setForeignForwardEvidenceForTesting(null);
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
  });

  function evidence(result: ForeignCtrlProxyForwardVerdict): void {
    AndroidCtrlProxyManager.setForeignForwardEvidenceForTesting({
      read: async () => {
        reads++;
        return result;
      },
    });
  }

  const blockedVerdicts: ForeignCtrlProxyForwardVerdict[] = [
    { kind: "foreign", ports: [9008], clientPids: [44122], message: "forward held" },
    { kind: "unknown", ports: [9008], reason: "forward owner not resolved", message: "unknown" },
  ];
  for (const result of blockedVerdicts) {
    test.each([
      ["setup(true)", (subject: AndroidCtrlProxyManager) => subject.setup(true)],
      ["install", (subject: AndroidCtrlProxyManager) => subject.install("/unused.apk")],
      ["enable", (subject: AndroidCtrlProxyManager) => subject.enable()],
      ["enableForUser", (subject: AndroidCtrlProxyManager) => subject.enableForUser(10)],
      ["enableViaSettings", (subject: AndroidCtrlProxyManager) => subject.enableViaSettings()],
      ["disableViaSettings", (subject: AndroidCtrlProxyManager) => subject.disableViaSettings()],
      ["rebindIfUnhealthy", (subject: AndroidCtrlProxyManager) => subject.rebindIfUnhealthy()],
      ["forceRestartProcess", (subject: AndroidCtrlProxyManager) => subject.forceRestartProcess()],
    ] as const)(`#12220 ${result.kind} %s refuses before adb writes`, async (_name, run) => {
      evidence(result);
      await expect(run(manager)).rejects.toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(reads).toBe(1);
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  }

  test("#12220 known foreign forward identifies the owner and ports", async () => {
    evidence({ kind: "foreign", ports: [9008, 9009], clientPids: [44122], message: "held" });
    try {
      await manager.assertNotDrivenByOtherDaemon();
      throw new Error("expected ownership refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect((error as DeviceOwnedByOtherDaemonError).ownerPid).toBe(44122);
      expect((error as Error).message).toContain("9008");
      expect((error as Error).message).toContain("another device");
      expect((error as Error).message).not.toContain("forward --remove");
    }
  });

  test("#12220 unknown forward owner refuses without an invented PID", async () => {
    evidence({ kind: "unknown", ports: [9008], reason: "owner unverified", message: "unknown" });
    try {
      await manager.assertNotDrivenByOtherDaemon();
      throw new Error("expected ownership refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect((error as DeviceOwnedByOtherDaemonError).ownerPid).toBeUndefined();
      expect((error as Error).message).toContain("9008");
      expect((error as Error).message).toContain("adb -s emulator-12220 forward --remove tcp:9008");
    }
  });

  test("#12220 F2 unreadable forward listing fails without cross-daemon refusal", async () => {
    evidence({
      kind: "unknown",
      ports: [],
      reason: "adb forward listing failed",
      message: "unknown",
    });
    try {
      await manager.assertNotDrivenByOtherDaemon();
      throw new Error("expected ownership refusal");
    } catch (error) {
      expect(error).not.toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect((error as Error).message).toContain("adb forward listing failed");
      expect((error as Error).message).toContain("retry");
      expect("code" in (error as Error)).toBe(false);
    }
    expect(reads).toBe(1);
  });

  test("#12220 no foreign forward permits a direct installation", async () => {
    evidence({ kind: "none" });
    adb.setCommandResponse('install "/unused.apk"', commandResult("Success"));
    await manager.install("/unused.apk");
    expect(reads).toBe(1);
    expect(adb.getExecutedCommands()).toContain('install "/unused.apk"');
  });

  test("#12220 setup checks at entry and after download while nested enable reuses the check", async () => {
    evidence({ kind: "none" });
    const compatibility = spyOn(manager, "ensureCompatibleVersion").mockResolvedValue({
      status: "compatible",
    });
    const installed = spyOn(manager, "isInstalled").mockResolvedValue(false);
    const enabled = spyOn(manager, "isEnabled").mockResolvedValue(false);
    const download = spyOn(manager, "downloadApk").mockResolvedValue("/unused.apk");
    const capabilities = spyOn(manager, "getToggleCapabilities").mockResolvedValue({
      supportsSettingsToggle: true,
      deviceType: "emulator",
      apiLevel: 35,
    });
    adb.setCommandResponse('install "/unused.apk"', commandResult("Success"));
    try {
      expect((await manager.setup()).success).toBe(true);
      expect(reads).toBe(2);
      expect(adb.getExecutedCommands()).toContain('install "/unused.apk"');
      expect(adb.getExecutedCommands()).toContain(
        "shell settings put secure accessibility_enabled 1",
      );
    } finally {
      compatibility.mockRestore();
      installed.mockRestore();
      enabled.mockRestore();
      download.mockRestore();
      capabilities.mockRestore();
    }
  });

  test("F5 owner appearing during setup download refuses before APK writes", async () => {
    AndroidCtrlProxyManager.setForeignForwardEvidenceForTesting({
      read: async () =>
        ++reads === 1
          ? { kind: "none" }
          : { kind: "foreign", ports: [8767], clientPids: [44122], message: "new owner" },
    });
    const spies = [
      spyOn(manager, "ensureCompatibleVersion").mockResolvedValue({ status: "compatible" }),
      spyOn(manager, "isInstalled").mockResolvedValue(false),
      spyOn(manager, "isEnabled").mockResolvedValue(false),
      spyOn(manager, "downloadApk").mockResolvedValue("/unused.apk"),
      spyOn(manager, "cleanupApk").mockResolvedValue(undefined),
    ];
    try {
      await expect(manager.setup()).rejects.toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(reads).toBe(2);
      expect(
        adb.getExecutedCommands().filter((command) => /install|uninstall/.test(command)),
      ).toEqual([]);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  test("F5 setup compatibility download rechecks before installation", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("a".repeat(64));
    AndroidCtrlProxyManager.setForeignForwardEvidenceForTesting({
      read: async () =>
        ++reads === 1
          ? { kind: "none" }
          : { kind: "foreign", ports: [8767], clientPids: [44122], message: "new owner" },
    });
    const spies = [
      spyOn(manager, "isInstalled").mockResolvedValue(false),
      spyOn(manager, "downloadApk").mockResolvedValue("/unused.apk"),
      spyOn(manager, "cleanupApk").mockResolvedValue(undefined),
    ];
    try {
      await expect(manager.setup()).rejects.toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(reads).toBe(2);
      expect(
        adb
          .getExecutedCommands()
          .filter((command) => /^(install|shell pm uninstall)/.test(command)),
      ).toEqual([]);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  test("#12220 compatible-version legacy uninstall is guarded and preserves the typed refusal", async () => {
    evidence({ kind: "foreign", ports: [9008], clientPids: [44122], message: "held" });
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("");
    adb.setCommandResponse(
      "shell pm list packages dev.jasonpearson.automobile.accessibilityservice",
      commandResult("package:dev.jasonpearson.automobile.accessibilityservice"),
    );
    await expect(manager.ensureCompatibleVersion()).rejects.toBeInstanceOf(
      DeviceOwnedByOtherDaemonError,
    );
    expect(reads).toBe(1);
    expect(adb.getExecutedCommands().every((command) => !command.includes("uninstall"))).toBe(true);
  });

  test("#12220 compatible-version read-only skip does not require forward evidence", async () => {
    evidence({ kind: "foreign", ports: [9008], clientPids: [44122], message: "held" });
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("");
    await expect(manager.ensureCompatibleVersion()).resolves.toMatchObject({ status: "skipped" });
    expect(reads).toBe(0);
  });
});
