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

    it("should handle app clear failures gracefully", async () => {
      const snapshotName = "test-clear-fail";

      // Create manifest with packages
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: false,
        packages: ["com.example.app1", "com.example.app2"],
        appDataBackup: {
          backupFile: "backup.ab",
          backupMethod: "adb_backup",
          totalPackages: 2,
          backedUpPackages: ["com.example.app1", "com.example.app2"],
          skippedPackages: [],
          failedPackages: [],
        },
      };

      // Setup clear commands - one succeeds, one fails
      fakeAdb.setCommandResult("shell pm clear com.example.app1", "Success");
      fakeAdb.setCommandResult("shell pm clear com.example.app2", "Failed");

      // Should not throw, just log warnings
      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      expect(fakeAdb.wasCommandExecuted("shell pm clear com.example.app1")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell pm clear com.example.app2")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should not clear app data when includeAppData is false", async () => {
      const snapshotName = "test-no-clear";

      // Create manifest without app data
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: false,
        packages: ["com.example.app"],
      };

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Verify pm clear was not called
      expect(fakeAdb.wasCommandExecuted("shell pm clear")).toBe(false);
    });

    it("should not clear app data when packages list is empty", async () => {
      const snapshotName = "test-empty-packages";

      // Create manifest with empty packages
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: false,
        packages: [],
      };

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Verify pm clear was not called
      expect(fakeAdb.wasCommandExecuted("shell pm clear")).toBe(false);
    });

    it("should skip foreground app restore when not in manifest", async () => {
      const snapshotName = "test-no-foreground";

      // Create manifest without foreground app
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

      // Verify app launch was not called
      expect(fakeAdb.wasCommandExecuted("shell am start")).toBe(false);
    });

    it("should handle missing backup file gracefully", async () => {
      const snapshotName = "test-missing-backup";

      // Create manifest with backup metadata but no actual file
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: false,
        packages: ["com.example.app"],
        appDataBackup: {
          backupFile: "backup.ab",
          backupMethod: "adb_backup",
          totalPackages: 1,
          backedUpPackages: ["com.example.app"],
          skippedPackages: [],
          failedPackages: [],
        },
      };

      // Should not throw, just skip restore
      const result = await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      expect(result.snapshotType).toBe("adb");
      expect(fakeAdb.wasCommandExecuted("restore")).toBe(false);
    });

    it("should skip restore for empty backup file", async () => {
      const snapshotName = "test-empty-backup";

      // Create manifest with backup
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: false,
        packages: ["com.example.app"],
        appDataBackup: {
          backupFile: "backup.ab",
          backupMethod: "adb_backup",
          totalPackages: 1,
          backedUpPackages: ["com.example.app"],
          skippedPackages: [],
          failedPackages: [],
        },
      };

      // Create empty backup file
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      const backupFilePath = store.getBackupFilePath(snapshotName);
      await fs.writeFile(backupFilePath, "", "utf-8"); // Empty file

      const result = await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      expect(result.snapshotType).toBe("adb");
      expect(fakeAdb.wasCommandExecuted("restore")).toBe(false);
    });
  });

  describe("app data restore with timeout", () => {
    it("should clear the pending timeout when the restore command throws (regression #2866)", async () => {
      // Regression guard: timeoutHandle used to be declared inside the try block
      // but referenced in the catch block, causing a ReferenceError instead of a
      // graceful failure when adb executeCommand throws mid-restore.
      const backupFilePath = "/tmp/backup.ab";
      fakeAdb.setCommandError(`restore "${backupFilePath}"`, new Error("adb connection dropped"));

      const result = await (restoreSnapshot as any).performAdbRestore(backupFilePath, 30000);

      // Catch path returns a graceful failure, no ReferenceError thrown.
      expect(result).toEqual({ success: false, timedOut: false });
      // The timeout scheduled before the throw must be cleared to avoid a leak.
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    });

    it("should restore successfully when user confirms within timeout", async () => {
      const snapshotName = "test-snapshot";

      // Create manifest with backup data
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: false,
        packages: ["com.example.app"],
        appDataBackup: {
          backupFile: "backup.ab",
          backupMethod: "adb_backup",
          totalPackages: 1,
          backedUpPackages: ["com.example.app"],
          skippedPackages: [],
          failedPackages: [],
          backupTimedOut: false,
        },
      };

      // Create backup file
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      const backupFilePath = store.getBackupFilePath(snapshotName);
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      // Setup restore command result
      fakeAdb.setCommandResult(`restore "${backupFilePath}"`, "");

      const result = await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      expect(result.snapshotType).toBe("adb");
      expect(result.restoredAt).toBeDefined();

      // Verify restore command was called
      expect(fakeAdb.wasCommandExecuted(`restore "${backupFilePath}"`)).toBe(true);

      // Verify timer was used for timeout
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0); // Should be cleared after completion
    });

    it("should skip restore if no backup file exists", async () => {
      const snapshotName = "test-no-backup";

      // Create manifest without backup data
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: false,
        packages: ["com.example.app"],
        appDataBackup: {
          backupMethod: "none",
          totalPackages: 1,
          backedUpPackages: [],
          skippedPackages: [],
          failedPackages: [],
        },
      };

      // Create app data directory but no backup file
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });

      const result = await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      expect(result.snapshotType).toBe("adb");

      // Verify restore command was not called
      expect(fakeAdb.wasCommandExecuted("restore")).toBe(false);
    });

    it("should clear app data before restore", async () => {
      const snapshotName = "test-clear";

      // Create manifest with packages
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: false,
        packages: ["com.example.app1", "com.example.app2"],
        appDataBackup: {
          backupFile: "backup.ab",
          backupMethod: "adb_backup",
          totalPackages: 2,
          backedUpPackages: ["com.example.app1"],
          skippedPackages: [],
          failedPackages: [],
          backupTimedOut: false,
        },
      };

      // Create backup file
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      const backupFilePath = store.getBackupFilePath(snapshotName);
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      // Setup clear commands
      fakeAdb.setCommandResult("shell pm clear com.example.app1", "Success");
      fakeAdb.setCommandResult("shell pm clear com.example.app2", "Success");
      fakeAdb.setCommandResult(`restore "${backupFilePath}"`, "");

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Only the backed-up package is cleared. app2 was never captured
      // (backedUpPackages is [app1]), so clearing it would wipe data that
      // cannot be restored (#4236).
      expect(fakeAdb.wasCommandExecuted("shell pm clear com.example.app1")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell pm clear com.example.app2")).toBe(false);
    });

    it("should restore foreground app after data restore", async () => {
      const snapshotName = "test-foreground";
      const foregroundApp = "com.example.app";

      // Create manifest with foreground app
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: false,
        packages: [foregroundApp],
        foregroundApp,
        appDataBackup: {
          backupFile: "backup.ab",
          backupMethod: "adb_backup",
          totalPackages: 1,
          backedUpPackages: [foregroundApp],
          skippedPackages: [],
          failedPackages: [],
          backupTimedOut: false,
        },
      };

      // Create backup file
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      const backupFilePath = store.getBackupFilePath(snapshotName);
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      fakeAdb.setCommandResult(`restore "${backupFilePath}"`, "");

      await restoreSnapshot.execute({
        snapshotName,
        manifest,
        useVmSnapshot: false,
      });

      // Verify foreground app was launched
      expect(
        fakeAdb.wasCommandExecuted(
          `shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${foregroundApp}`,
        ),
      ).toBe(true);
    });

    it("should restore VM snapshot with timer sleep", async () => {
      const snapshotName = "test-vm";

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
      });

      // Verify sleep was called for stabilization
      expect(fakeTimer.wasSleepCalled(2000)).toBe(true);

      // Verify VM restore command was called
      expect(fakeAdb.wasCommandExecuted(`emu avd snapshot load ${snapshotName}`)).toBe(true);
    });
  });
});

describe("RestoreSnapshot restores settings before the slow app-data phase (#4236)", () => {
  let device: BootedDevice;
  let fakeAdb: FakeAdbClient;
  let fakeAdbFactory: AdbClientFactory;
  let fakeTimer: FakeTimer;
  let restoreSnapshot: RestoreSnapshot;
  let store: DeviceSnapshotStore;
  let basePath: string;

  beforeEach(async () => {
    device = {
      deviceId: "emulator-5554",
      name: "Pixel_5",
      platform: "android",
      isEmulator: true,
    } as BootedDevice;
    fakeAdb = new FakeAdbClient();
    fakeAdbFactory = { create: () => fakeAdb as any };
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-scope-test-"));
    store = new DeviceSnapshotStore(basePath);
    restoreSnapshot = new RestoreSnapshot(device, fakeAdbFactory, undefined, fakeTimer, store);
  });

  afterEach(async () => {
    try {
      await fs.rm(basePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    fakeTimer.reset();
  });

  // manifest.packages is every installed package (getInstalledPackages), while
  // only appDataBackup.backedUpPackages was actually captured. Clearing the
  // former wipes data that can never be restored, and the volume of pm clear
  // calls is what exhausted the request budget before restoreSettings ran.
  const manifestWith = (allPackages: string[], backedUp: string[]): DeviceSnapshotManifest =>
    ({
      snapshotName: "scope-test",
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "android",
      snapshotType: "adb",
      includeAppData: true,
      includeSettings: true,
      packages: allPackages,
      settings: { system: { screen_off_timeout: "60000" }, global: {}, secure: {} },
      appDataBackup: {
        backedUpPackages: backedUp,
        skippedPackages: [],
        totalPackages: allPackages.length,
      },
    }) as unknown as DeviceSnapshotManifest;

  it("clears only the backed-up packages, not every installed package (#4236 P1)", async () => {
    // The default restore path: manifest.packages is every installed package but
    // only a subset was backed up. Clearing all of them is what exhausted the
    // request budget before the restore could finish.
    const manifest = manifestWith(
      ["com.example.app", "com.android.systemui", "com.google.android.gms"],
      ["com.example.app"],
    );

    await restoreSnapshot
      .execute({ snapshotName: "scope-test", manifest, useVmSnapshot: false })
      .catch(() => undefined);

    expect(fakeAdb.getCommandCount("pm clear com.example.app")).toBeGreaterThan(0);
    expect(fakeAdb.getCommandCount("pm clear com.android.systemui")).toBe(0);
    expect(fakeAdb.getCommandCount("pm clear com.google.android.gms")).toBe(0);
  });

  it("clears nothing when no packages were backed up (#4236 P1)", async () => {
    const manifest = manifestWith(["com.example.app", "com.android.systemui"], []);

    await restoreSnapshot
      .execute({ snapshotName: "scope-test", manifest, useVmSnapshot: false })
      .catch(() => undefined);

    expect(fakeAdb.getCommandCount("pm clear")).toBe(0);
  });

  it("restores settings before clearing app data, so a slow clear cannot cost the settings", async () => {
    // Ordering is the fix: on a real device the clear phase spans every installed
    // package and exhausts the request budget, so settings restored afterwards
    // never happened. Fakes are instant, so assert the command *sequence* rather
    // than timing -- otherwise the test passes with either order.
    const manifest = manifestWith(["com.example.app"], ["com.example.app"]);

    await restoreSnapshot
      .execute({ snapshotName: "scope-test", manifest, useVmSnapshot: false })
      .catch(() => undefined);

    const commands = fakeAdb.getAllCommands();
    const settingsAt = commands.findIndex((c) =>
      c.includes("settings put system screen_off_timeout"),
    );
    const clearAt = commands.findIndex((c) => c.includes("pm clear"));

    expect(settingsAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(settingsAt).toBeLessThan(clearAt);
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
