import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { DeviceOwnedByOtherDaemonError } from "../../src/daemon/deviceAcquisitionRefusals";
import type { AndroidCtrlProxy } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import type { BootedDevice } from "../../src/models";
import type { ForeignCtrlProxyForwardVerdict } from "../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import { DefaultForeignCtrlProxyForwardEvidence } from "../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import type { ExecResult } from "../../src/models";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";

afterEach(() => {
  AndroidCtrlProxyManager.setForeignForwardEvidenceForTesting(null);
  AndroidCtrlProxyManager.resetInstances();
});

function harness(installed: boolean, enabled: boolean, realManager = false, refuseGuard = true) {
  const device: BootedDevice = { platform: "android", deviceId: "emulator-5560", name: "Pixel" };
  const adb = new FakeAdbExecutor();
  adb.setDevices([device]);
  const devices = new FakeDeviceUtils();
  devices.setBootedDevices("android", [device]);
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
  const ctrlProxyManager = new FakeCtrlProxyManager();
  ctrlProxyManager.setInstalled(installed);
  ctrlProxyManager.setEnabled(enabled);
  const refusal = new DeviceOwnedByOtherDaemonError(device.deviceId, 4242);
  const guard = mock(async () => {
    if (refuseGuard) {
      throw refusal;
    }
  });
  Object.assign(ctrlProxyManager, { assertNotDrivenByOtherDaemon: guard });
  const actualCtrlProxyManager = realManager
    ? AndroidCtrlProxyManager.getInstance(device, adb)
    : ctrlProxyManager;
  const waitForConnection = mock(async () => false);
  const ctrlProxyClient = {
    isConnected: () => false,
    waitForConnection,
    verifyServiceReady: async () => true,
    isLastConnectionFailureForwardingLeaseConflict: () => true,
    getLastConnectionFailureMessage: () => refusal.message,
    resetConnectionBudget: () => {},
  } as unknown as AndroidCtrlProxy;
  const appearance = mock(async () => {});
  const manager = DeviceSessionManager.createInstance(
    new FakeDeviceClientProvider(adb, devices, new FakeSimctl() as unknown as SimCtlClient, {
      window,
      ctrlProxyManager: actualCtrlProxyManager,
      ctrlProxyClient,
    }),
    { create: () => adb },
    {
      runnerReadinessTimer: new FakeTimer(),
      lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
      admissionGate: { assertDeviceActionable: () => {} },
      executionBinding: { bindDeviceExecution: () => {} },
      appearanceOnConnectDependencies: {
        isSyncEnabled: () => true,
        getConfig: async () => ({ syncWithHost: true, defaultMode: "dark", applyOnConnect: true }),
        resolveMode: async () => "dark",
        apply: appearance,
      },
    },
  );
  return {
    device,
    adb,
    manager,
    ctrlProxyManager,
    ctrlProxyClient,
    waitForConnection,
    guard,
    appearance,
    refusal,
  };
}

function installAdbForwardEvidence(
  adb: FakeAdbExecutor,
  mode: "foreign" | "unknown" | "owned" | "none",
): void {
  adb.setCommandResponse("forward --list", {
    stdout: mode === "none" ? "" : "emulator-5560 tcp:18080 tcp:8765\n",
    stderr: "",
  } as ExecResult);
  AndroidCtrlProxyManager.setForeignForwardEvidenceForTesting(
    new DefaultForeignCtrlProxyForwardEvidence({
      adbFactory: { create: () => adb },
      clientProbe: {
        findClientPids: async () => {
          if (mode === "unknown") {
            throw new Error("host client probe unavailable");
          }
          return [4242];
        },
      },
      ownership: () => ({ ownsForward: () => mode === "owned" }),
      isProcessRunning: () => true,
      timer: new FakeTimer(),
    }),
  );
}

describe("#12220 foreign CtrlProxy forward at DeviceSessionManager readiness", () => {
  const controlCases = [
    [true, true],
    [false, false],
    [true, false],
  ] as const;
  for (const [installed, enabled] of controlCases) {
    test(`#12220 control refuses before setup (installed=${installed}, enabled=${enabled})`, async () => {
      const h = harness(installed, enabled);
      await expect(h.manager.ensureDeviceReady("android", h.device.deviceId)).rejects.toBe(
        h.refusal,
      );
      expect(h.guard).toHaveBeenCalled();
      expect(h.waitForConnection).not.toHaveBeenCalled();
      expect(h.ctrlProxyManager.getExecutedOperations()).toEqual([]);
      expect(
        h.adb
          .getExecutedCommands()
          .filter((command) => /forward|settings|force-stop|uninstall|install/.test(command)),
      ).toEqual([]);
      expect(h.manager.getCurrentDevice()).toBeUndefined();
      expect(h.appearance).not.toHaveBeenCalled();
    });
  }

  test("#12220 read resolves without changing CtrlProxy or selecting the device", async () => {
    const h = harness(true, true);
    await expect(
      h.manager.ensureDeviceReady("android", h.device.deviceId, { intent: "read" }),
    ).resolves.toEqual(h.device);
    expect(h.guard).toHaveBeenCalled();
    expect(h.waitForConnection).not.toHaveBeenCalled();
    expect(h.ctrlProxyManager.getExecutedOperations()).toEqual([]);
    expect(h.manager.getCurrentDevice()).toBeUndefined();
    expect(h.appearance).not.toHaveBeenCalled();
  });

  test("#12220 booted control refuses before pin and settings writes", async () => {
    const h = harness(true, true);
    await expect(
      h.manager.ensureDeviceReady("android", h.device.deviceId, { readiness: "booted" }),
    ).rejects.toBe(h.refusal);
    expect(h.manager.getCurrentDevice()).toBeUndefined();
    expect(h.appearance).not.toHaveBeenCalled();
    expect(
      h.adb.getExecutedCommands().filter((command) => /settings|force-stop/.test(command)),
    ).toEqual([]);
  });

  for (const kind of ["foreign", "unknown"] as const) {
    test(`#12220 real CtrlProxy manager refuses ${kind} forward without adb mutation`, async () => {
      const verdict: ForeignCtrlProxyForwardVerdict =
        kind === "foreign"
          ? { kind, ports: [18080], clientPids: [4242], message: "foreign forward" }
          : { kind, ports: [18080], reason: "probe failed", message: "unknown forward" };
      const read = mock(async () => verdict);
      AndroidCtrlProxyManager.setForeignForwardEvidenceForTesting({ read });
      const h = harness(true, true, true);
      let error: unknown;
      try {
        await h.manager.ensureDeviceReady("android", h.device.deviceId);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(read).toHaveBeenCalled();
      expect(h.waitForConnection).not.toHaveBeenCalled();
      expect(
        h.adb
          .getExecutedCommands()
          .filter((command) => /forward|settings|force-stop|uninstall|install/.test(command)),
      ).toEqual([]);
      expect(h.manager.getCurrentDevice()).toBeUndefined();
    });
  }

  for (const [installed, enabled] of [
    [true, true],
    [false, false],
    [true, false],
  ] as const) {
    test(`#12220 adb forward evidence refuses before ${installed ? (enabled ? "connect" : "enable") : "install"}`, async () => {
      const h = harness(installed, enabled, true);
      installAdbForwardEvidence(h.adb, "foreign");
      const real = AndroidCtrlProxyManager.getInstance(h.device, h.adb);
      const isInstalled = spyOn(real, "isInstalled");
      const isEnabled = spyOn(real, "isEnabled");
      await expect(
        h.manager.ensureDeviceReady("android", h.device.deviceId),
      ).rejects.toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(h.adb.getExecutedCommands()).toContain("forward --list");
      expect(
        h.adb
          .getExecutedCommands()
          .filter((command) =>
            /forward --remove|forward tcp:|settings put|force-stop|uninstall|install/.test(command),
          ),
      ).toEqual([]);
      expect(isInstalled).not.toHaveBeenCalled();
      expect(isEnabled).not.toHaveBeenCalled();
      expect(h.manager.getCurrentDevice()).toBeUndefined();
    });
  }

  test("#12220 real not-installed control refuses foreign adb forward before install", async () => {
    const h = harness(false, false, true);
    installAdbForwardEvidence(h.adb, "foreign");
    const real = AndroidCtrlProxyManager.getInstance(h.device, h.adb);
    spyOn(real, "isInstalled").mockResolvedValue(false);
    spyOn(real, "isEnabled").mockResolvedValue(false);
    spyOn(real, "ensureCompatibleVersion").mockResolvedValue({ status: "not_installed" });
    spyOn(real, "downloadApk").mockResolvedValue("/private/tmp/fake-ctrlproxy.apk");
    spyOn(real, "cleanupApk").mockResolvedValue(undefined);
    spyOn(real, "getToggleCapabilities").mockResolvedValue({
      supportsSettingsToggle: true,
      deviceType: "emulator",
      apiLevel: 35,
    });
    h.adb.setCommandResponse('install "/private/tmp/fake-ctrlproxy.apk"', {
      stdout: "Success",
      stderr: "",
    } as ExecResult);
    await expect(h.manager.ensureDeviceReady("android", h.device.deviceId)).rejects.toBeInstanceOf(
      DeviceOwnedByOtherDaemonError,
    );
    expect(h.adb.getExecutedCommands()).toContain("forward --list");
    expect(
      h.adb
        .getExecutedCommands()
        .filter((command) =>
          /forward --remove|forward tcp:|settings put|force-stop|uninstall|install/.test(command),
        ),
    ).toEqual([]);
    expect(h.manager.getCurrentDevice()).toBeUndefined();
  });

  test("#12220 unknown adb forward evidence permits a read without mutation", async () => {
    const h = harness(true, true, true);
    installAdbForwardEvidence(h.adb, "unknown");
    await expect(
      h.manager.ensureDeviceReady("android", h.device.deviceId, { intent: "read" }),
    ).resolves.toEqual(h.device);
    expect(h.adb.getExecutedCommands()).toContain("forward --list");
    expect(
      h.adb
        .getExecutedCommands()
        .filter((command) =>
          /forward --remove|forward tcp:|settings put|force-stop|uninstall|install/.test(command),
        ),
    ).toEqual([]);
    expect(h.waitForConnection).not.toHaveBeenCalled();
    expect(h.manager.getCurrentDevice()).toBeUndefined();
  });

  test("#12220 booted control refuses real foreign adb forward before appearance", async () => {
    const h = harness(true, true, true);
    installAdbForwardEvidence(h.adb, "foreign");
    await expect(
      h.manager.ensureDeviceReady("android", h.device.deviceId, { readiness: "booted" }),
    ).rejects.toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(h.adb.getExecutedCommands()).toContain("forward --list");
    expect(h.appearance).not.toHaveBeenCalled();
    expect(h.manager.getCurrentDevice()).toBeUndefined();
  });

  for (const mode of ["none", "owned"] as const) {
    test(`#12220 ${mode} adb forward permits real install, enable, and stylus`, async () => {
      const h = harness(false, false, true);
      installAdbForwardEvidence(h.adb, mode);
      const real = AndroidCtrlProxyManager.getInstance(h.device, h.adb);
      spyOn(real, "isInstalled").mockResolvedValue(false);
      spyOn(real, "isEnabled").mockResolvedValue(false);
      spyOn(real, "ensureCompatibleVersion").mockResolvedValue({ status: "not_installed" });
      spyOn(real, "downloadApk").mockResolvedValue("/private/tmp/fake-ctrlproxy.apk");
      spyOn(real, "cleanupApk").mockResolvedValue(undefined);
      spyOn(real, "getToggleCapabilities").mockResolvedValue({
        supportsSettingsToggle: true,
        deviceType: "emulator",
        apiLevel: 35,
      });
      h.adb.setCommandResponse('install "/private/tmp/fake-ctrlproxy.apk"', {
        stdout: "Success",
        stderr: "",
      } as ExecResult);
      h.waitForConnection.mockResolvedValue(true);
      await expect(h.manager.ensureDeviceReady("android", h.device.deviceId)).resolves.toEqual(
        h.device,
      );
      expect(h.adb.getExecutedCommands()).toContain('install "/private/tmp/fake-ctrlproxy.apk"');
      expect(h.adb.getExecutedCommands()).toContain(
        "shell settings put secure accessibility_enabled 1",
      );
      expect(h.adb.getExecutedCommands()).toContain(
        "shell settings put secure stylus_handwriting_enabled 0",
      );
      expect(h.manager.getCurrentDevice()).toEqual(h.device);
    });
  }

  test("#12220 connection lease conflict does not reset or reinstall an enabled service", async () => {
    const h = harness(true, true, false, false);
    await expect(h.manager.ensureDeviceReady("android", h.device.deviceId)).rejects.toThrow(
      h.refusal.message,
    );
    expect(h.ctrlProxyManager.wasMethodCalled("resetSetupState")).toBe(false);
    expect(h.ctrlProxyManager.wasMethodCalled("setup")).toBe(false);
    expect(h.ctrlProxyManager.wasMethodCalled("enable")).toBe(false);
    expect(h.manager.getCurrentDevice()).toBeUndefined();
  });

  test("#12220 read skips a lease conflict discovered after the ownership precheck", async () => {
    const h = harness(true, true, false, false);
    await expect(
      h.manager.ensureDeviceReady("android", h.device.deviceId, { intent: "read" }),
    ).resolves.toEqual(h.device);
    expect(h.guard).toHaveBeenCalled();
    expect(h.waitForConnection).toHaveBeenCalled();
    expect(h.ctrlProxyManager.wasMethodCalled("resetSetupState")).toBe(false);
    expect(h.ctrlProxyManager.wasMethodCalled("setup")).toBe(false);
    expect(h.manager.getCurrentDevice()).toBeUndefined();
  });

  test("#12220 setup failure preserves the typed foreign owner cause", async () => {
    const h = harness(false, false, false, false);
    h.ctrlProxyManager.setup = async () => ({
      success: false,
      message: "setup refused",
      cause: h.refusal,
    });
    await expect(h.manager.ensureDeviceReady("android", h.device.deviceId)).rejects.toBe(h.refusal);
    expect(h.manager.getCurrentDevice()).toBeUndefined();
  });

  test("#12220 no foreign forward allows booted control selection and appearance", async () => {
    const read = mock(async (): Promise<ForeignCtrlProxyForwardVerdict> => ({ kind: "none" }));
    AndroidCtrlProxyManager.setForeignForwardEvidenceForTesting({ read });
    const h = harness(true, true, true);
    await expect(
      h.manager.ensureDeviceReady("android", h.device.deviceId, { readiness: "booted" }),
    ).resolves.toEqual(h.device);
    expect(read).toHaveBeenCalled();
    expect(h.manager.getCurrentDevice()).toEqual(h.device);
    expect(h.appearance).toHaveBeenCalled();
    expect(h.adb.getExecutedCommands()).toContain(
      "shell settings put secure stylus_handwriting_enabled 0",
    );
  });
});
