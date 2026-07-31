import { expect, describe, test, beforeEach } from "bun:test";
import { UninstallApp, DeviceAppUninstaller } from "../../../src/features/action/UninstallApp";
import type { BootedDevice } from "../../../src/models";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";

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

  test("forces keepData to false on iOS even when the caller requests keepData:true", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);
    fakeUninstaller.uninstallApp = async (deviceUdid, bundleId, isSimulator) => {
      fakeUninstaller.calls.push({ deviceUdid, bundleId, isSimulator });
      fakeSimctl.setInstalledApps([]);
    };

    const uninstall = new UninstallApp(iosSimDevice, nullAdbFactory, fakeSimctl, fakeUninstaller);
    // iOS cannot keep app data during uninstall — the request must be ignored.
    const result = await uninstall.execute("com.example.app", true);

    expect(result.success).toBe(true);
    expect(result.keepData).toBe(false);
  });
});

describe("UninstallApp (unsupported platform)", () => {
  test("throws for an unknown platform instead of silently no-oping", async () => {
    const webDevice = {
      deviceId: "web-device-1",
      name: "web",
      platform: "web"
    } as unknown as BootedDevice;

    const uninstall = new UninstallApp(
      webDevice,
      nullAdbFactory,
      new FakeSimctl(),
      new FakeDeviceAppUninstaller()
    );

    await expect(uninstall.execute("com.example.app")).rejects.toThrow("Unsupported platform: web");
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

  test("emits force-stop then a data-clearing pm uninstall for the target user", async () => {
    fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    // Pre-uninstall the app is present; the post-uninstall re-check sees it gone.
    fakeAdb.setCommandResultSequence("shell pm list packages --user 0", [
      { stdout: "package:com.example.app\npackage:com.android.settings" },
      { stdout: "package:com.android.settings" }
    ]);

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.keepData).toBe(false);
    expect(result.userId).toBe(0);

    // Assert the exact emitted commands — no -k because keepData is false.
    const commands = fakeAdb.getCommandCalls().map(call => call.command);
    expect(commands).toContain("shell am force-stop --user 0 com.example.app");
    expect(commands).toContain("shell pm uninstall --user 0 com.example.app");
    expect(commands).not.toContain("shell pm uninstall --user 0 -k com.example.app");
  });

  test("marks the Android installed-apps cache stale after a successful uninstall", async () => {
    const repo = new FakeInstalledAppsRepository();
    await repo.upsertInstalledApp(androidDevice.deviceId, 0, "com.example.previous", false, 1_000);
    fakeAdb.setCommandResultSequence("shell pm list packages --user 0", [
      { stdout: "package:com.example.app\npackage:com.android.settings" },
      { stdout: "package:com.android.settings" }
    ]);

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb), null, null, repo);

    await uninstall.execute("com.example.app");

    expect(await repo.getLatestVerification(androidDevice.deviceId)).toBe(0);
  });

  test("invalidates the cache before post-uninstall verification", async () => {
    class VerificationFailureAdb extends FakeAdbClient {
      private listPackagesCalls = 0;

      override async executeCommand(
        command: string,
        timeoutMs?: number,
        maxBuffer?: number,
        noRetry?: boolean,
        signal?: AbortSignal
      ) {
        if (command === "shell pm list packages --user 0") {
          this.listPackagesCalls++;
          if (this.listPackagesCalls === 2) {
            throw new Error("ADB disconnected after uninstall");
          }
        }
        return super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
      }
    }

    const repo = new FakeInstalledAppsRepository();
    const adb = new VerificationFailureAdb();
    await repo.upsertInstalledApp(androidDevice.deviceId, 0, "com.example.previous", false, 1_000);
    adb.setCommandResult("shell pm list packages --user 0", "package:com.example.app");

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(adb), null, null, repo);
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(false);
    expect(await repo.getLatestVerification(androidDevice.deviceId)).toBe(0);
  });

  test("emits pm uninstall -k when keepData is requested", async () => {
    fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    fakeAdb.setCommandResultSequence("shell pm list packages --user 0", [
      { stdout: "package:com.example.app\npackage:com.android.settings" },
      { stdout: "package:com.android.settings" }
    ]);

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("com.example.app", true);

    expect(result.success).toBe(true);
    expect(result.keepData).toBe(true);

    // The -k flag preserves app data; assert the exact command carried it.
    const commands = fakeAdb.getCommandCalls().map(call => call.command);
    expect(commands).toContain("shell pm uninstall --user 0 -k com.example.app");
    expect(commands).not.toContain("shell pm uninstall --user 0 com.example.app");
  });

  test("returns not installed when package is missing", async () => {
    const repo = new FakeInstalledAppsRepository();
    await repo.upsertInstalledApp(androidDevice.deviceId, 0, "com.example.previous", false, 1_000);
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    setupNoApp(fakeAdb, 0);

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb), null, null, repo);
    const result = await uninstall.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
    expect(await repo.getLatestVerification(androidDevice.deviceId)).toBe(1_000);
  });

  test("detects work profile user", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([
      { userId: 0, name: "Owner", running: true },
      { userId: 10, name: "Work", flags: 0x30, running: true }
    ]);
    // App installed under work profile (userId 10)
    setupNoApp(fakeAdb, 0);
    fakeAdb.setCommandResultSequence("shell pm list packages --user 10", [
      { stdout: "package:com.example.app\npackage:com.android.settings" },
      { stdout: "package:com.android.settings" }
    ]);

    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("com.example.app");

    expect(result.userId).toBe(10);
    // The uninstall must target the work-profile user, not user 0.
    const commands = fakeAdb.getCommandCalls().map(call => call.command);
    expect(commands).toContain("shell pm uninstall --user 10 com.example.app");
    expect(commands).not.toContain("shell pm uninstall --user 0 com.example.app");
  });

  test("returns failure for blank package name", async () => {
    const uninstall = new UninstallApp(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await uninstall.execute("  ");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid package name provided");
  });
});
