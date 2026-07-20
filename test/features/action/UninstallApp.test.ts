import { expect, describe, test, beforeEach } from "bun:test";
import { UninstallApp, DeviceAppUninstaller } from "../../../src/features/action/UninstallApp";
import type { BootedDevice } from "../../../src/models";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";

class FakeDeviceAppUninstaller implements DeviceAppUninstaller {
  public calls: Array<{ deviceUdid: string; bundleId: string; isSimulator?: boolean }> = [];
  public shouldThrow: Error | null = null;

  async uninstallApp(deviceUdid: string, bundleId: string, isSimulator?: boolean): Promise<void> {
    this.calls.push({ deviceUdid, bundleId, isSimulator });
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
  }
}

const fakeAdbFactory = (fakeAdb: FakeAdbClient) => ({ create: () => fakeAdb as any });
const nullAdbFactory = { create: () => ({} as any) };

describe("UninstallApp (iOS simulator)", () => {
  const iosSimDevice: BootedDevice = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    name: "iPhone 15",
    platform: "ios"
  };

  let fakeSimctl: FakeSimctl;
  let fakeUninstaller: FakeDeviceAppUninstaller;

  beforeEach(() => {
    fakeSimctl = new FakeSimctl();
    fakeUninstaller = new FakeDeviceAppUninstaller();
  });

  test("uninstalls installed simulator app", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    // After uninstall call, simulate removal
    fakeUninstaller.uninstallApp = async (deviceUdid, bundleId, isSimulator) => {
      fakeUninstaller.calls.push({ deviceUdid, bundleId, isSimulator });
      fakeSimctl.setInstalledApps([]);
    };

    const uninstall = new UninstallApp(iosSimDevice, nullAdbFactory, fakeSimctl, fakeUninstaller);
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.keepData).toBe(false);
    expect(result.packageName).toBe("com.example.app");
    expect(fakeUninstaller.calls[0]?.isSimulator).toBe(true);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(true);
  });

  test("returns success when app is not installed", async () => {
    fakeSimctl.setInstalledApps([]);

    const uninstall = new UninstallApp(iosSimDevice, nullAdbFactory, fakeSimctl, fakeUninstaller);
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(fakeUninstaller.calls).toHaveLength(0);
  });

  test("returns failure when uninstall does not remove app", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);
    // Don't clear installed apps — simulates failed uninstall

    const uninstall = new UninstallApp(iosSimDevice, nullAdbFactory, fakeSimctl, fakeUninstaller);
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(false);
    expect(result.wasInstalled).toBe(true);
    expect(result.error).toBe("Failed to uninstall application");
  });

  test("returns failure when uninstaller throws", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);
    fakeUninstaller.shouldThrow = new Error("simctl uninstall failed");

    const uninstall = new UninstallApp(iosSimDevice, nullAdbFactory, fakeSimctl, fakeUninstaller);
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(false);
    expect(result.error).toBe("simctl uninstall failed");
  });

  test("returns failure for empty package name", async () => {
    const uninstall = new UninstallApp(iosSimDevice, nullAdbFactory, fakeSimctl, fakeUninstaller);
    const result = await uninstall.execute("");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid package name provided");
  });
});

describe("UninstallApp (iOS physical device)", () => {
  const iosPhysicalDevice: BootedDevice = {
    deviceId: "00008110001234560A",
    name: "Jason's iPhone",
    platform: "ios"
  };

  let fakeSimctl: FakeSimctl;
  let fakeUninstaller: FakeDeviceAppUninstaller;

  beforeEach(() => {
    fakeSimctl = new FakeSimctl();
    fakeUninstaller = new FakeDeviceAppUninstaller();
  });

  test("uninstalls app via devicectl for physical device", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    fakeUninstaller.uninstallApp = async (deviceUdid, bundleId, isSimulator) => {
      fakeUninstaller.calls.push({ deviceUdid, bundleId, isSimulator });
      fakeSimctl.setInstalledApps([]);
    };

    const uninstall = new UninstallApp(iosPhysicalDevice, nullAdbFactory, fakeSimctl, fakeUninstaller);
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    // Physical device — isSimulator should be false
    expect(fakeUninstaller.calls[0]?.isSimulator).toBe(false);
    // Should NOT attempt simctl terminate for physical devices
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
  });
});

describe("UninstallApp (Android)", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 7",
    platform: "android"
  };

  let fakeAdb: FakeAdbClient;

  function setupAndroidApp(adb: FakeAdbClient, packageName: string, userId: number): void {
    // pm list packages --user N (all packages)
    adb.setCommandResult(
      `shell pm list packages --user ${userId}`,
      `package:${packageName}\npackage:com.android.settings`
    );
    // pm list packages -s --user N (system packages)
    adb.setCommandResult(
      `shell pm list packages -s --user ${userId}`,
      "package:com.android.settings"
    );
  }

  function setupNoApp(adb: FakeAdbClient, userId: number): void {
    adb.setCommandResult(
      `shell pm list packages --user ${userId}`,
      "package:com.android.settings"
    );
    adb.setCommandResult(
      `shell pm list packages -s --user ${userId}`,
      "package:com.android.settings"
    );
  }

  beforeEach(() => {
    fakeAdb = new FakeAdbClient();
  });

  test("uninstalls installed foreground app", async () => {
    fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    setupAndroidApp(fakeAdb, "com.example.app", 0);

    // After uninstall, the second listPackages call should show no app
    let uninstallCalled = false;
    const origExecute = fakeAdb.executeCommand.bind(fakeAdb);
    fakeAdb.executeCommand = async (cmd: string, ...rest: any[]) => {
      if (cmd.includes("pm uninstall")) {
        uninstallCalled = true;
        // Simulate removal: update package list results
        fakeAdb.setCommandResult(
          "shell pm list packages --user 0",
          "package:com.android.settings"
        );
      }
      return origExecute(cmd, ...rest);
    };

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.keepData).toBe(false);
    expect(result.userId).toBe(0);
    expect(uninstallCalled).toBe(true);
  });

  test("uninstalls with keepData flag", async () => {
    fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    setupAndroidApp(fakeAdb, "com.example.app", 0);

    let keepDataCmd = false;
    const origExecute = fakeAdb.executeCommand.bind(fakeAdb);
    fakeAdb.executeCommand = async (cmd: string, ...rest: any[]) => {
      if (cmd.includes("pm uninstall") && cmd.includes("-k")) {
        keepDataCmd = true;
        fakeAdb.setCommandResult(
          "shell pm list packages --user 0",
          "package:com.android.settings"
        );
      }
      return origExecute(cmd, ...rest);
    };

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("com.example.app", true);

    expect(result.success).toBe(true);
    expect(result.keepData).toBe(true);
    expect(keepDataCmd).toBe(true);
  });

  test("returns not installed when package is missing", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    setupNoApp(fakeAdb, 0);

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("detects work profile user", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([
      { userId: 0, name: "Owner", running: true },
      { userId: 10, name: "Work", flags: 0x30, running: true }
    ]);
    // App installed under work profile (userId 10)
    setupNoApp(fakeAdb, 0);
    setupAndroidApp(fakeAdb, "com.example.app", 10);

    let uninstallUserId: number | null = null;
    const origExecute = fakeAdb.executeCommand.bind(fakeAdb);
    fakeAdb.executeCommand = async (cmd: string, ...rest: any[]) => {
      if (cmd.includes("pm uninstall --user 10")) {
        uninstallUserId = 10;
        fakeAdb.setCommandResult(
          "shell pm list packages --user 10",
          "package:com.android.settings"
        );
      }
      return origExecute(cmd, ...rest);
    };

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("com.example.app");

    expect(result.userId).toBe(10);
    expect(uninstallUserId).toBe(10);
  });

  test("returns failure for blank package name", async () => {
    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("  ");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid package name provided");
  });
});
