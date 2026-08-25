import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RestoreSnapshot } from "../../../src/features/action/RestoreSnapshot";
import { BootedDevice, DeviceSnapshotManifest } from "../../../src/models";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DeviceSnapshotStore } from "../../../src/utils/DeviceSnapshotStore";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

describe("RestoreSnapshot", () => {
  let device: BootedDevice;
  let fakeAdb: FakeAdbClient;
  let fakeAdbFactory: AdbClientFactory;
  let fakeTimer: FakeTimer;
  let restoreSnapshot: RestoreSnapshot;
  let store: DeviceSnapshotStore;
  let testBasePath: string;

  beforeEach(async () => {
    // Create test device
    device = {
      deviceId: "emulator-5554",
      name: "Pixel_5",
      platform: "android",
      isEmulator: true,
    };

    // Create fakes
    fakeAdb = new FakeAdbClient();
    fakeAdbFactory = { create: () => fakeAdb as any };
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Create secure temporary directory for tests
    testBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-restore-test-"));
    store = new DeviceSnapshotStore(testBasePath);

    // Create RestoreSnapshot instance with fakes
    restoreSnapshot = new RestoreSnapshot(device, fakeAdbFactory, undefined, fakeTimer, store);

    // Setup default command results
    fakeAdb.setCommandResult("shell pm clear com.example.app", "Success");
    fakeAdb.setCommandResult(
      "shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.app",
      "",
    );
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testBasePath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    fakeTimer.reset();
  });

  describe("VM snapshot restore", () => {
    it("should restore VM snapshot for emulator", async () => {
      const snapshotName = "test-vm-restore";

      // Create VM snapshot manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
      };

      // Setup VM snapshot load command
      fakeAdb.setCommandResult(`emu avd snapshot load ${snapshotName}`, "OK");

      const result = await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: true,
      });

      expect(result.snapshotType).toBe("vm");
      expect(result.restoredAt).toBeDefined();
      expect(fakeAdb.wasCommandExecuted(`emu avd snapshot load ${snapshotName}`)).toBe(true);
      expect(fakeTimer.wasSleepCalled(2000)).toBe(true); // Stabilization sleep
    });

    it("should throw error when VM snapshot load fails with KO", async () => {
      const snapshotName = "test-vm-fail";

      // Create VM snapshot manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
      };

      // Setup VM snapshot load command to fail
      fakeAdb.setCommandResult(
        `emu avd snapshot load ${snapshotName}`,
        "",
        "KO: snapshot load failed",
      );

      await expect(
        restoreSnapshot.execute({
          snapshotName,
          manifest,
          useVmSnapshot: true,
        }),
      ).rejects.toThrow("Failed to restore VM snapshot");
    });

    it("should throw error when VM snapshot load fails with KO in stdout", async () => {
      const snapshotName = "test-vm-fail-stdout";

      // Create VM snapshot manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
      };

      // Setup VM snapshot load command to fail (KO in stdout)
      fakeAdb.setCommandResult(`emu avd snapshot load ${snapshotName}`, "KO: snapshot load failed");

      await expect(
        restoreSnapshot.execute({
          snapshotName,
          manifest,
          useVmSnapshot: true,
        }),
      ).rejects.toThrow("Failed to restore VM snapshot");
    });

    it("should throw error when VM snapshot load returns no OK response", async () => {
      const snapshotName = "test-vm-empty-response";

      // Create VM snapshot manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
      };

      // Setup VM snapshot load command with empty output
      fakeAdb.setCommandResult(`emu avd snapshot load ${snapshotName}`, "", "");

      await expect(
        restoreSnapshot.execute({
          snapshotName,
          manifest,
          useVmSnapshot: true,
        }),
      ).rejects.toThrow("no response from emulator");
    });

    it("should surface offline errors when VM snapshot command fails", async () => {
      const snapshotName = "test-vm-offline";

      // Create VM snapshot manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
      };

      // Setup VM snapshot load command to throw offline error
      fakeAdb.setCommandError(`emu avd snapshot load ${snapshotName}`, new Error("device offline"));

      await expect(
        restoreSnapshot.execute({
          snapshotName,
          manifest,
          useVmSnapshot: true,
        }),
      ).rejects.toThrow("offline");
    });

    it("should pass VM snapshot timeout to adb command", async () => {
      const snapshotName = "test-vm-timeout";
      const vmSnapshotTimeoutMs = 15000;

      // Create VM snapshot manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
      };

      // Setup VM snapshot load command
      fakeAdb.setCommandResult(`emu avd snapshot load ${snapshotName}`, "OK");

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: true,
        vmSnapshotTimeoutMs,
      });

      const call = fakeAdb
        .getCommandCalls()
        .find((entry) => entry.command === `emu avd snapshot load ${snapshotName}`);
      expect(call?.timeoutMs).toBe(vmSnapshotTimeoutMs);
    });

    it("should use ADB restore for VM snapshot when useVmSnapshot is false", async () => {
      const snapshotName = "test-vm-as-adb";

      // Create VM snapshot manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: false,
        includeSettings: false,
      };

      const result = await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Should use ADB restore even for VM snapshot when flag is false
      expect(result.snapshotType).toBe("vm");
      expect(fakeAdb.wasCommandExecuted("emu avd snapshot load")).toBe(false);
    });

    it("should not use VM restore for physical device", async () => {
      const snapshotName = "test-physical-vm";

      // Create physical device
      const physicalDevice: BootedDevice = {
        deviceId: "ABC123DEF",
        name: "Pixel_5_Physical",
        platform: "android",
        isEmulator: false,
      };

      const restorePhysical = new RestoreSnapshot(
        physicalDevice,
        fakeAdbFactory,
        undefined,
        fakeTimer,
        store,
      );

      // Create VM snapshot manifest (but can't restore on physical device)
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: false,
        includeSettings: false,
      };

      const result = await restorePhysical.execute({
        snapshotName,
        manifest,
        useVmSnapshot: true,
      });

      // Should use ADB restore for physical device
      expect(result.snapshotType).toBe("vm");
      expect(fakeAdb.wasCommandExecuted("emu avd snapshot load")).toBe(false);
    });
  });

  describe("settings restore", () => {
    it("should restore all settings types", async () => {
      const snapshotName = "test-restore-settings";

      // Create manifest with settings
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
        settings: {
          global: { airplane_mode_on: "1", wifi_on: "0" },
          secure: { android_id: "xyz789", mock_location: "0" },
          system: { screen_brightness: "200", font_scale: "1.2" },
        },
      };

      // Setup settings restore commands
      fakeAdb.setCommandResult("shell settings put global airplane_mode_on '1'", "");
      fakeAdb.setCommandResult("shell settings put global wifi_on '0'", "");
      fakeAdb.setCommandResult("shell settings put secure android_id 'xyz789'", "");
      fakeAdb.setCommandResult("shell settings put secure mock_location '0'", "");
      fakeAdb.setCommandResult("shell settings put system screen_brightness '200'", "");
      fakeAdb.setCommandResult("shell settings put system font_scale '1.2'", "");

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Verify all settings were restored
      expect(fakeAdb.wasCommandExecuted("shell settings put global airplane_mode_on '1'")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put global wifi_on '0'")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure android_id 'xyz789'")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put secure mock_location '0'")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put system screen_brightness '200'")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system font_scale '1.2'")).toBe(true);
    });

    it("shell-quotes a setting value containing spaces and quotes when restoring it", async () => {
      const snapshotName = "test-settings-special";

      // Create manifest with settings containing special characters
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
        settings: {
          global: { test_key: "value with spaces and 'quotes'" },
          secure: {},
          system: {},
        },
      };

      // Setup settings restore command with escaped value
      fakeAdb.setCommandResult(
        "shell settings put global test_key 'value with spaces and '\\''quotes'\\'''",
        "",
      );

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Verify special characters were escaped properly — assert the FULL command,
      // including the shell-quoted value, so deleting the escaping cannot pass.
      const putCommands = fakeAdb
        .getCommandCalls()
        .map((call) => call.command)
        .filter((command) => command.startsWith("shell settings put global test_key"));
      expect(putCommands).toEqual([
        "shell settings put global test_key 'value with spaces and '\\''quotes'\\'''",
      ]);
    });

    it("should skip empty settings sections", async () => {
      const snapshotName = "test-empty-settings";

      // Create manifest with empty settings
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
        settings: {
          global: {},
          secure: {},
          system: {},
        },
      };

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Verify no settings commands were called
      expect(fakeAdb.wasCommandExecuted("shell settings put")).toBe(false);
    });

    it("should skip settings restore when includeSettings is false", async () => {
      const snapshotName = "test-no-settings-restore";

      // Create manifest without settings
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: false,
      };

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Verify no settings commands were called
      expect(fakeAdb.wasCommandExecuted("shell settings put")).toBe(false);
    });
  });

  describe("error scenarios", () => {
    it("should throw error for platform mismatch", async () => {
      const snapshotName = "test-platform-mismatch";

      // Create manifest for different platform
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: "ios-device",
        deviceName: "iPhone_14",
        platform: "ios",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: false,
      };

      await expect(
        restoreSnapshot.execute({
          snapshotName,
          manifest,
          useVmSnapshot: false,
        }),
      ).rejects.toThrow("Snapshot platform 'ios' does not match device platform 'android'");
    });
  });

  // #5708: the deprecated adb backup/restore app-data path was dropped. Non-VM
  // Android restore now reapplies settings and relaunches the foreground app
  // only -- `pm clear` and `adb restore` are never issued.
  describe("settings-only Android restore (#5708)", () => {
    const androidManifest = (
      overrides: Partial<DeviceSnapshotManifest> = {},
    ): DeviceSnapshotManifest => ({
      snapshotName: "settings-only",
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "android",
      snapshotType: "adb",
      includeAppData: false,
      includeSettings: true,
      ...overrides,
    });

    it("restores settings and relaunches the foreground app, never clearing app data", async () => {
      const manifest = androidManifest({
        settings: { global: { airplane_mode_on: "1" }, secure: {}, system: {} },
        foregroundApp: "com.example.app",
      });
      fakeAdb.setCommandResult("shell settings put global airplane_mode_on '1'", "");

      const result = await restoreSnapshot.execute({
        snapshotName: "settings-only",
        manifest,
        useVmSnapshot: false,
      });

      expect(result.snapshotType).toBe("adb");
      expect(fakeAdb.wasCommandExecuted("shell settings put global airplane_mode_on '1'")).toBe(
        true,
      );
      expect(
        fakeAdb.wasCommandExecuted(
          "shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.app",
        ),
      ).toBe(true);

      // No app-data phase: neither `pm clear` nor `adb restore` is issued, even
      // if a legacy manifest still carries backup metadata.
      expect(fakeAdb.wasCommandExecuted("pm clear")).toBe(false);
      expect(fakeAdb.wasCommandExecuted("restore")).toBe(false);
    });

    it("ignores legacy app-data backup metadata without clearing or restoring", async () => {
      // A snapshot captured before #5708 may still carry appDataBackup with a
      // backedUpPackages list. Restore must not act on it.
      const manifest = androidManifest({
        includeAppData: true,
        foregroundApp: "com.example.app",
        packages: ["com.example.app", "com.android.systemui"],
        appDataBackup: {
          backupFile: "backup.ab",
          backedUpPackages: ["com.example.app"],
          skippedPackages: [],
          totalPackages: 2,
        },
      });

      await restoreSnapshot.execute({
        snapshotName: "settings-only",
        manifest,
        useVmSnapshot: false,
      });

      expect(fakeAdb.wasCommandExecuted("pm clear")).toBe(false);
      expect(fakeAdb.wasCommandExecuted("restore")).toBe(false);
    });

    it("skips foreground relaunch when the manifest has no foreground app", async () => {
      const manifest = androidManifest({ includeSettings: false });

      await restoreSnapshot.execute({
        snapshotName: "settings-only",
        manifest,
        useVmSnapshot: false,
      });

      expect(fakeAdb.wasCommandExecuted("shell am start")).toBe(false);
    });
  });
});

describe("RestoreSnapshot (iOS)", () => {
  let device: BootedDevice;
  let simctl: FakeSimCtlClient;
  let store: DeviceSnapshotStore;
  let testBasePath: string;

  beforeEach(async () => {
    device = {
      deviceId: "ios-device-1",
      name: "iPhone 15",
      platform: "ios",
    };

    simctl = new FakeSimCtlClient();
    testBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-ios-restore-"));
    store = new DeviceSnapshotStore(testBasePath);
  });

  afterEach(async () => {
    try {
      await fs.rm(testBasePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function makeRestore(): RestoreSnapshot {
    return new RestoreSnapshot(device, undefined, undefined, undefined, store, simctl as any);
  }

  it("rejects a physical iOS device instead of driving simctl against it", async () => {
    // iOS restore drives simctl for settings/app-container operations, which only works
    // on a Simulator. Reject a physical iPhone up front rather than half-applying a
    // restore over a failing simctl transport (#5620).
    device = { deviceId: "00008030-001C2D3E1234567A", name: "iPhone 15 Pro", platform: "ios" };

    await expect(makeRestore().execute({ snapshotName: "physical" })).rejects.toThrow(
      /physical iOS device/i,
    );
    expect(simctl.getMethodCalls("launchApp").length).toBe(0);
  });

  it("restores app data using fallback device path", async () => {
    const snapshotName = "restore-snapshot";
    const bundleId = "com.example.app";
    const appDataPath = store.getAppDataPath(snapshotName, {
      platform: "ios",
      deviceId: device.deviceId,
    });
    await fs.mkdir(path.join(appDataPath, bundleId, "Documents"), { recursive: true });
    await fs.writeFile(path.join(appDataPath, bundleId, "Documents", "data.txt"), "new-data");

    const containerRoot = path.join(testBasePath, "containers", bundleId);
    await fs.mkdir(path.join(containerRoot, "Documents"), { recursive: true });
    await fs.writeFile(path.join(containerRoot, "Documents", "data.txt"), "old-data");

    simctl.setContainerPath(bundleId, containerRoot);
    simctl.setInstalledApps([{ bundleId }]);

    const manifest: DeviceSnapshotManifest = {
      snapshotName,
      timestamp: new Date().toISOString(),
      deviceId: "other-device",
      deviceName: device.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
      appDataBackup: {
        backupMethod: "simctl_copy",
        backedUpPackages: [bundleId],
      },
    };

    await makeRestore().execute({
      snapshotName,
      manifest,
      useVmSnapshot: false,
    });

    const restored = await fs.readFile(path.join(containerRoot, "Documents", "data.txt"), "utf-8");
    expect(restored).toBe("new-data");
    expect(simctl.getMethodCalls("terminateApp")).toHaveLength(1);
  });

  it("throws when required app is not installed", async () => {
    const snapshotName = "missing-app";
    const appDataPath = store.getAppDataPath(snapshotName, {
      platform: "ios",
      deviceId: device.deviceId,
    });
    await fs.mkdir(appDataPath, { recursive: true });
    simctl.setInstalledApps([{ bundleId: "com.example.other" }]);

    const manifest: DeviceSnapshotManifest = {
      snapshotName,
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
      appDataBackup: {
        backupMethod: "simctl_copy",
        backedUpPackages: ["com.example.missing"],
      },
    };

    await expect(
      makeRestore().execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      }),
    ).rejects.toThrow("App(s) not installed");
  });

  it("throws on major iOS version mismatch", async () => {
    simctl.setDeviceInfo(device.deviceId, {
      udid: device.deviceId,
      name: device.name,
      state: "Booted",
      isAvailable: true,
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
    });
    simctl.setRuntimes([
      {
        bundlePath: "/runtime",
        buildversion: "A123",
        runtimeRoot: "/runtime/root",
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
        version: "17.0",
        isAvailable: true,
        name: "iOS 17.0",
      },
    ]);

    const manifest: DeviceSnapshotManifest = {
      snapshotName: "version-mismatch",
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
      osVersion: "iOS 16.4",
      appDataBackup: {
        backupMethod: "simctl_copy",
        backedUpPackages: ["com.example.app"],
      },
    };

    await expect(
      makeRestore().execute({
        snapshotName: "version-mismatch",
        manifest,
        useVmSnapshot: false,
      }),
    ).rejects.toThrow("incompatible");
  });

  it("skips restore when backup method is none", async () => {
    const snapshotName = "no-backup";
    const appDataPath = store.getAppDataPath(snapshotName, {
      platform: "ios",
      deviceId: device.deviceId,
    });
    await fs.mkdir(appDataPath, { recursive: true });

    const manifest: DeviceSnapshotManifest = {
      snapshotName,
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
      appDataBackup: {
        backupMethod: "none",
      },
    };

    await makeRestore().execute({
      snapshotName,
      manifest,
      useVmSnapshot: false,
    });

    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
    expect(simctl.getMethodCalls("terminateApp")).toHaveLength(0);
  });

  it("restores iOS settings via per-key defaults write and simctl ui", async () => {
    const snapshotName = "settings-restore";
    const manifest: DeviceSnapshotManifest = {
      snapshotName,
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: false,
      includeSettings: true,
      iosSettings: {
        values: { ".GlobalPreferences/AppleLocale": "nl_BE" },
        ui: { appearance: "dark", contentSize: "large" },
      },
    };

    await makeRestore().execute({ snapshotName, manifest, useVmSnapshot: false });

    const argvCommands = simctl.getMethodCalls("executeCommandArgs").map((c) => c.args);
    expect(argvCommands).toContainEqual([
      "spawn",
      device.deviceId,
      "defaults",
      "write",
      ".GlobalPreferences",
      "AppleLocale",
      "nl_BE",
    ]);
    expect(argvCommands).toContainEqual(["ui", device.deviceId, "appearance", "dark"]);
    expect(argvCommands).toContainEqual(["ui", device.deviceId, "content_size", "large"]);
  });

  it("skips settings restore when includeSettings is false", async () => {
    const snapshotName = "settings-skip";
    const manifest: DeviceSnapshotManifest = {
      snapshotName,
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: false,
      includeSettings: false,
      iosSettings: {
        values: { ".GlobalPreferences/AppleLocale": "nl_BE" },
      },
    };

    await makeRestore().execute({ snapshotName, manifest, useVmSnapshot: false });

    const argvCommands = simctl.getMethodCalls("executeCommandArgs").map((c) => c.args as string[]);
    expect(argvCommands.some((args) => args.includes("defaults") && args.includes("write"))).toBe(
      false,
    );
  });

  it("continues restoring remaining settings when one key write fails (non-fatal)", async () => {
    const snapshotName = "settings-partial";
    simctl.setCommandArgsError(
      ["spawn", device.deviceId, "defaults", "write", ".GlobalPreferences", "AppleLocale", "nl_BE"],
      new Error("write failed"),
    );
    const manifest: DeviceSnapshotManifest = {
      snapshotName,
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: false,
      includeSettings: true,
      iosSettings: {
        values: { ".GlobalPreferences/AppleLocale": "nl_BE" },
        ui: { appearance: "light" },
      },
    };

    // Should not throw despite the failed key write.
    await makeRestore().execute({ snapshotName, manifest, useVmSnapshot: false });

    const argvCommands = simctl.getMethodCalls("executeCommandArgs").map((c) => c.args);
    // UI restore still runs after the failed defaults write.
    expect(argvCommands).toContainEqual(["ui", device.deviceId, "appearance", "light"]);
  });
});
