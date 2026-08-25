import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { CaptureSnapshot } from "../../../src/features/action/CaptureSnapshot";
import { BootedDevice } from "../../../src/models";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DeviceSnapshotStore } from "../../../src/utils/DeviceSnapshotStore";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

describe("CaptureSnapshot", () => {
  let device: BootedDevice;
  let fakeAdb: FakeAdbClient;
  let fakeAdbFactory: AdbClientFactory;
  let fakeTimer: FakeTimer;
  let captureSnapshot: CaptureSnapshot;
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
    testBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-test-"));
    store = new DeviceSnapshotStore(testBasePath);

    // Create CaptureSnapshot instance with fakes
    captureSnapshot = new CaptureSnapshot(device, fakeAdbFactory, undefined, fakeTimer, store);

    // Setup default command results
    fakeAdb.setCommandResult(
      "shell pm list packages",
      "package:com.example.app\npackage:com.system.app",
    );
    fakeAdb.setCommandResult(
      "shell pm list packages -3 com.example.app",
      "package:com.example.app",
    );
    fakeAdb.setCommandResult("shell pm list packages -3 com.system.app", ""); // system app
    fakeAdb.setCommandResult("shell dumpsys package com.example.app", "flags=0x1234 ALLOW_BACKUP");
    fakeAdb.setCommandResult("shell settings list global", "airplane_mode_on=0");
    fakeAdb.setCommandResult("shell settings list secure", "android_id=abc123");
    fakeAdb.setCommandResult("shell settings list system", "screen_brightness=128");
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

  describe("VM snapshot capture", () => {
    it("should capture VM snapshot for emulator", async () => {
      const snapshotName = "test-vm-snapshot";

      // Setup getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Setup VM snapshot command
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "OK");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: true,
      });

      expect(result.snapshotType).toBe("vm");
      expect(result.snapshotName).toBe(snapshotName);
      expect(result.manifest.snapshotType).toBe("vm");
      expect(result.manifest.includeAppData).toBe(true); // VM snapshot includes everything
      expect(fakeAdb.wasCommandExecuted(`emu avd snapshot save ${snapshotName}`)).toBe(true);
    });

    it("should capture VM snapshot with settings", async () => {
      const snapshotName = "test-vm-with-settings";

      // Setup getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Setup VM snapshot command
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "OK");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: true,
        useVmSnapshot: true,
      });

      expect(result.snapshotType).toBe("vm");
      expect(result.manifest.includeSettings).toBe(true);
      expect(result.manifest.settings).toBeDefined();
      expect(result.manifest.settings?.global).toEqual({ airplane_mode_on: "0" });
      expect(result.manifest.settings?.secure).toEqual({ android_id: "abc123" });
      expect(result.manifest.settings?.system).toEqual({ screen_brightness: "128" });
    });

    it("should capture foreground app in VM snapshot", async () => {
      const snapshotName = "test-vm-foreground";
      const foregroundApp = "com.example.app";

      // Setup getForegroundApp
      fakeAdb.setForegroundApp({ packageName: foregroundApp, userId: 0 });

      // Setup VM snapshot command
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "OK");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: true,
      });

      expect(result.manifest.foregroundApp).toBe(foregroundApp);
    });

    it("degrades to an undefined foregroundApp when the adb probe throws", async () => {
      const snapshotName = "test-vm-foreground-throws";

      // The real getForegroundApp must swallow the adb error and return undefined
      // (issue #4169 item 9) rather than failing the whole snapshot.
      fakeAdb.setForegroundAppError(new Error("adb: device 'emulator-5554' not found"));
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "OK");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: true,
      });

      expect(result.manifest.foregroundApp).toBeUndefined();
    });

    it("should throw error when VM snapshot fails with KO", async () => {
      const snapshotName = "test-vm-fail";

      // Setup getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Setup VM snapshot command to fail
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "", "KO: snapshot failed");

      await expect(
        captureSnapshot.execute({
          snapshotName,
          includeAppData: true,
          includeSettings: false,
          useVmSnapshot: true,
        }),
      ).rejects.toThrow("Failed to capture VM snapshot");
    });

    it("should throw error when VM snapshot fails with KO in stdout", async () => {
      const snapshotName = "test-vm-fail-stdout";

      // Setup getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Setup VM snapshot command to fail (KO in stdout)
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "KO: snapshot failed");

      await expect(
        captureSnapshot.execute({
          snapshotName,
          includeAppData: true,
          includeSettings: false,
          useVmSnapshot: true,
        }),
      ).rejects.toThrow("Failed to capture VM snapshot");
    });

    it("should throw error when VM snapshot returns no OK response", async () => {
      const snapshotName = "test-vm-empty-response";

      // Setup getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Setup VM snapshot command with empty output
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "", "");

      await expect(
        captureSnapshot.execute({
          snapshotName,
          includeAppData: true,
          includeSettings: false,
          useVmSnapshot: true,
        }),
      ).rejects.toThrow("no response from emulator");
    });

    it("should surface offline errors when VM snapshot command fails", async () => {
      const snapshotName = "test-vm-offline";

      // Setup getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Setup VM snapshot command to throw offline error
      fakeAdb.setCommandError(`emu avd snapshot save ${snapshotName}`, new Error("device offline"));

      await expect(
        captureSnapshot.execute({
          snapshotName,
          includeAppData: true,
          includeSettings: false,
          useVmSnapshot: true,
        }),
      ).rejects.toThrow("offline");
    });

    it("should pass VM snapshot timeout to adb command", async () => {
      const snapshotName = "test-vm-timeout";
      const vmSnapshotTimeoutMs = 12000;

      // Setup getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Setup VM snapshot command
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "OK");

      await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: true,
        vmSnapshotTimeoutMs,
      });

      const call = fakeAdb
        .getCommandCalls()
        .find((entry) => entry.command === `emu avd snapshot save ${snapshotName}`);
      expect(call?.timeoutMs).toBe(vmSnapshotTimeoutMs);
    });

    it("should use ADB snapshot for non-emulator device even with useVmSnapshot=true", async () => {
      const snapshotName = "test-physical-device";

      // Create physical device
      const physicalDevice: BootedDevice = {
        deviceId: "ABC123DEF",
        name: "Pixel_5_Physical",
        platform: "android",
        isEmulator: false,
      };

      const capturePhysical = new CaptureSnapshot(
        physicalDevice,
        fakeAdbFactory,
        undefined,
        fakeTimer,
        store,
      );
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Create backup file
      const backupFilePath = store.getBackupFilePath(snapshotName);
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      const result = await capturePhysical.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: true,
        userApps: "current",
      });

      // Should use ADB snapshot for physical device
      expect(result.snapshotType).toBe("adb");
      expect(fakeAdb.wasCommandExecuted("emu avd snapshot save")).toBe(false);
    });
  });

  describe("settings capture", () => {
    it("should capture all settings types", async () => {
      const snapshotName = "test-settings";

      // Mock getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Create backup file
      const backupFilePath = store.getBackupFilePath(snapshotName);
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: true,
        useVmSnapshot: false,
        userApps: "current",
      });

      expect(result.manifest.includeSettings).toBe(true);
      expect(result.manifest.settings).toBeDefined();
      expect(result.manifest.settings?.global).toEqual({ airplane_mode_on: "0" });
      expect(result.manifest.settings?.secure).toEqual({ android_id: "abc123" });
      expect(result.manifest.settings?.system).toEqual({ screen_brightness: "128" });

      // Verify settings were written to file
      const settingsPath = store.getSettingsPath(snapshotName);
      const settingsContent = await fs.readFile(settingsPath, "utf-8");
      const settings = JSON.parse(settingsContent);
      expect(settings.global).toEqual({ airplane_mode_on: "0" });
    });

    it("should handle settings with special characters", async () => {
      const snapshotName = "test-settings-special";

      fakeAdb.setCommandResult(
        "shell settings list global",
        "some_key=value with spaces\nkey2=value=with=equals",
      );
      fakeAdb.setCommandResult("shell settings list secure", "");
      fakeAdb.setCommandResult("shell settings list system", "");

      // Mock getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Create backup file
      const backupFilePath = store.getBackupFilePath(snapshotName);
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: true,
        useVmSnapshot: false,
        userApps: "current",
      });

      expect(result.manifest.settings?.global).toEqual({
        some_key: "value with spaces",
        key2: "value=with=equals",
      });
    });

    it("should handle empty settings gracefully", async () => {
      const snapshotName = "test-settings-empty";

      fakeAdb.setCommandResult("shell settings list global", "");
      fakeAdb.setCommandResult("shell settings list secure", "");
      fakeAdb.setCommandResult("shell settings list system", "");

      // Mock getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Create backup file
      const backupFilePath = store.getBackupFilePath(snapshotName);
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: true,
        useVmSnapshot: false,
        userApps: "current",
      });

      expect(result.manifest.settings?.global).toEqual({});
      expect(result.manifest.settings?.secure).toEqual({});
      expect(result.manifest.settings?.system).toEqual({});
    });

    it("should skip settings capture when includeSettings is false", async () => {
      const snapshotName = "test-no-settings";

      // Mock getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Create backup file
      const backupFilePath = store.getBackupFilePath(snapshotName);
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "current",
      });

      expect(result.manifest.includeSettings).toBe(false);
      expect(result.manifest.settings).toBeUndefined();

      // Verify settings commands were not called
      expect(fakeAdb.wasCommandExecuted("shell settings list")).toBe(false);
    });
  });

  describe("error scenarios", () => {
    it("should throw error in strictBackupMode when backup fails", async () => {
      const snapshotName = "test-strict-mode";

      // Mock getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Don't create backup file to simulate failure

      await expect(
        captureSnapshot.execute({
          snapshotName,
          includeAppData: true,
          includeSettings: false,
          useVmSnapshot: false,
          userApps: "current",
          strictBackupMode: true,
        }),
      ).rejects.toThrow("App data backup failed");
    });
  });

  describe("edge cases", () => {
    it("should handle no foreground app gracefully", async () => {
      const snapshotName = "test-no-foreground";

      // Mock getForegroundApp to return undefined
      fakeAdb.setForegroundApp(null);

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "current",
      });

      expect(result.manifest.foregroundApp).toBeUndefined();
      expect(result.manifest.appDataBackup?.backupMethod).toBe("none");
    });

    it("should handle empty package list", async () => {
      const snapshotName = "test-empty-packages";

      fakeAdb.setCommandResult("shell pm list packages", "");

      // Mock getForegroundApp
      fakeAdb.setForegroundApp(null);

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "all",
      });

      expect(result.manifest.packages).toEqual([]);
      expect(result.manifest.appDataBackup?.backupMethod).toBe("none");
    });

    it("should handle foreground app that is not a user app", async () => {
      const snapshotName = "test-system-foreground";

      // Mock getForegroundApp to return a system app
      fakeAdb.setForegroundApp({ packageName: "com.system.app", userId: 0 });

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "current",
      });

      expect(result.manifest.appDataBackup?.backupMethod).toBe("none");
      expect(result.manifest.appDataBackup?.backedUpPackages).toEqual([]);
    });

    it("should handle all apps disallowing backup", async () => {
      const snapshotName = "test-all-disallow-backup";

      fakeAdb.setCommandResult(
        "shell pm list packages",
        "package:com.example.app1\npackage:com.example.app2",
      );
      fakeAdb.setCommandResult(
        "shell pm list packages -3 com.example.app1",
        "package:com.example.app1",
      );
      fakeAdb.setCommandResult(
        "shell pm list packages -3 com.example.app2",
        "package:com.example.app2",
      );
      fakeAdb.setCommandResult(
        "shell dumpsys package com.example.app1",
        "flags=0x1234 ALLOW_BACKUP=false",
      );
      fakeAdb.setCommandResult(
        "shell dumpsys package com.example.app2",
        "flags=0x1234 ALLOW_BACKUP=false",
      );

      // Mock getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app1", userId: 0 });

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "all",
      });

      expect(result.manifest.appDataBackup?.backupMethod).toBe("none");
      expect(result.manifest.appDataBackup?.skippedPackages?.length).toBe(2);
    });
  });

  describe("app data backup with timeout", () => {
    it("should backup successfully when user confirms within timeout", async () => {
      // Setup: Create a fake backup file to simulate successful backup
      const snapshotName = "test-snapshot";
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      const backupFilePath = store.getBackupFilePath(snapshotName);

      // Mock getForegroundApp to return the test app
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Create backup file first to simulate successful backup
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      // Simulate successful backup
      fakeAdb.setCommandResult(`backup -f "${backupFilePath}" -noapk com.example.app`, "Success");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "current",
      });

      expect(result.snapshotName).toBe(snapshotName);
      expect(result.manifest.appDataBackup).toBeDefined();
      expect(result.manifest.appDataBackup?.backupMethod).toBe("adb_backup");
      expect(result.manifest.appDataBackup?.backedUpPackages).toContain("com.example.app");

      // Verify timer was used for timeout
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0); // Should be cleared after completion
    });

    it("should clear the pending timeout when the backup command throws (regression #2866)", async () => {
      // Regression guard: timeoutHandle used to be declared inside the try block
      // but referenced in the catch block, causing a ReferenceError instead of a
      // graceful failure when adb executeCommand throws mid-backup.
      const backupFilePath = store.getBackupFilePath("test-throw");
      fakeAdb.setCommandError(
        `backup -f "${backupFilePath}" -noapk com.example.app`,
        new Error("adb connection dropped"),
      );

      const result = await (captureSnapshot as any).performAdbBackup(
        ["com.example.app"],
        backupFilePath,
        30000,
      );

      // Catch path returns a graceful failure, no ReferenceError thrown.
      expect(result).toEqual({ timedOut: false });
      // The timeout scheduled before the throw must be cleared to avoid a leak.
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    });

    it("records the failed backup in the manifest when no backup file is produced", async () => {
      const snapshotName = "test-snapshot-no-file";

      // Drive the real foreground-app path rather than stubbing the subject.
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // The backup command returns without creating a file (backup not confirmed).
      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "current",
        strictBackupMode: false,
        backupTimeoutMs: 30000,
      });

      // A failed backup must pin: adb_backup attempted, package moved to
      // failedPackages, NO backupFile recorded (item 11), and not-timed-out.
      const backup = result.manifest.appDataBackup;
      expect(backup?.backupMethod).toBe("adb_backup");
      expect(backup?.backedUpPackages).toEqual([]);
      expect(backup?.failedPackages).toEqual(["com.example.app"]);
      expect(backup?.backupFile).toBeUndefined();
      expect(backup?.backupTimedOut).toBe(false);
    });

    it("records backupTimedOut when the adb backup never completes", async () => {
      const snapshotName = "test-snapshot-timeout";

      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
      // The backup command hangs; the FakeTimer timeout wins the race.
      fakeAdb.setHangingCommand("backup -f");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "current",
        strictBackupMode: false,
        backupTimeoutMs: 30000,
      });

      const backup = result.manifest.appDataBackup;
      expect(backup?.backupMethod).toBe("adb_backup");
      expect(backup?.backupTimedOut).toBe(true);
      expect(backup?.failedPackages).toEqual(["com.example.app"]);
      expect(backup?.backupFile).toBeUndefined();
    });

    it("should backup only current foreground app by default", async () => {
      const snapshotName = "test-current-app";

      // Setup getForegroundApp to return a specific app
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      // Create dummy backup file
      const backupFilePath = store.getBackupFilePath(snapshotName);
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "current",
      });

      // Verify backup command was called with only the foreground app
      expect(fakeAdb.wasCommandExecuted("backup -f")).toBe(true);
      const backupCommand = fakeAdb.getAllCommands().find((cmd) => cmd.includes("backup -f"));
      expect(backupCommand).toContain("com.example.app");
      expect(backupCommand).not.toContain("com.system.app");
    });

    it("should backup all user apps when userApps is 'all'", async () => {
      const snapshotName = "test-all-apps";

      // Add more user apps
      fakeAdb.setCommandResult(
        "shell pm list packages",
        "package:com.example.app1\npackage:com.example.app2\npackage:com.system.app",
      );
      fakeAdb.setCommandResult(
        "shell pm list packages -3 com.example.app1",
        "package:com.example.app1",
      );
      fakeAdb.setCommandResult(
        "shell pm list packages -3 com.example.app2",
        "package:com.example.app2",
      );
      fakeAdb.setCommandResult(
        "shell dumpsys package com.example.app1",
        "flags=0x1234 ALLOW_BACKUP",
      );
      fakeAdb.setCommandResult(
        "shell dumpsys package com.example.app2",
        "flags=0x1234 ALLOW_BACKUP",
      );

      // Create dummy backup file
      const backupFilePath = store.getBackupFilePath(snapshotName);
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "all",
      });

      // Verify backup command was called with all user apps
      expect(fakeAdb.wasCommandExecuted("backup -f")).toBe(true);
      const backupCommand = fakeAdb.getAllCommands().find((cmd) => cmd.includes("backup -f"));
      expect(backupCommand).toContain("com.example.app1");
      expect(backupCommand).toContain("com.example.app2");
    });

    it("should skip apps with android:allowBackup=false", async () => {
      const snapshotName = "test-skip-nobackup";

      fakeAdb.setCommandResult(
        "shell pm list packages",
        "package:com.example.app1\npackage:com.example.app2",
      );
      fakeAdb.setCommandResult(
        "shell pm list packages -3 com.example.app1",
        "package:com.example.app1",
      );
      fakeAdb.setCommandResult(
        "shell pm list packages -3 com.example.app2",
        "package:com.example.app2",
      );

      // app1 allows backup, app2 doesn't
      fakeAdb.setCommandResult(
        "shell dumpsys package com.example.app1",
        "flags=0x1234 ALLOW_BACKUP",
      );
      fakeAdb.setCommandResult(
        "shell dumpsys package com.example.app2",
        "flags=0x1234 ALLOW_BACKUP=false",
      );

      // Create dummy backup file
      const backupFilePath = store.getBackupFilePath(snapshotName);
      const appDataPath = store.getAppDataPath(snapshotName);
      await fs.mkdir(appDataPath, { recursive: true });
      await fs.writeFile(backupFilePath, "backup data", "utf-8");

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        userApps: "all",
      });

      // Verify only app1 was backed up
      const backupCommand = fakeAdb.getAllCommands().find((cmd) => cmd.includes("backup -f"));
      expect(backupCommand).toContain("com.example.app1");
      expect(backupCommand).not.toContain("com.example.app2");

      // Check manifest contains skipped packages
      expect(result.manifest.appDataBackup?.skippedPackages).toContain("com.example.app2");
    });
  });

  // Issue #4169 item 17: pin the `settings list` line grammar through the real
  // manifest path. Each row is `key=value`, split on the FIRST `=`; a line with
  // no key is dropped; later duplicate keys win; CR is stripped with the trim.
  describe("parseSettings grammar (via manifest.settings.global)", () => {
    const grammarCases: Array<[string, string, Record<string, string>]> = [
      ["keeps everything after the first '=' in the value", "k=a=b", { k: "a=b" }],
      ["preserves an empty value", "k=", { k: "" }],
      ["drops a line with no key", "=v", {}],
      ["lets a later duplicate key win", "k=1\nk=2", { k: "2" }],
      ["strips CR from CRLF line endings", "a=1\r\nb=2", { a: "1", b: "2" }],
      ["skips blank and whitespace-only lines", "a=1\n\n   \nb=2", { a: "1", b: "2" }],
    ];

    test.each(grammarCases)("%s", async (_name, listOutput, expectedGlobal) => {
      const snapshotName = `grammar-${_name.replace(/\s+/g, "-")}`;
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
      fakeAdb.setCommandResult(`emu avd snapshot save ${snapshotName}`, "OK");
      fakeAdb.setCommandResult("shell settings list global", listOutput);

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: false,
        includeSettings: true,
        useVmSnapshot: true,
      });

      expect(result.manifest.settings?.global).toEqual(expectedGlobal);
    });
  });
});

describe("CaptureSnapshot (iOS)", () => {
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
    testBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-ios-capture-"));
    store = new DeviceSnapshotStore(testBasePath);
  });

  afterEach(async () => {
    try {
      await fs.rm(testBasePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function makeCapture(): CaptureSnapshot {
    return new CaptureSnapshot(device, undefined, undefined, undefined, store, simctl as any);
  }

  it("rejects a physical iOS device instead of driving simctl against it", async () => {
    // Physical iOS devices became discoverable/assignable in #5620, but every iOS
    // capture path routes through SimCtlClient (metadata, settings, app containers),
    // which only drives Simulators. Reject the physical UDID up front so the caller
    // gets an actionable error rather than a "captured successfully" over failed simctl.
    device = { deviceId: "00008030-001C2D3E1234567A", name: "iPhone 15 Pro", platform: "ios" };

    await expect(makeCapture().execute({ snapshotName: "physical" })).rejects.toThrow(
      /physical iOS device/i,
    );
    expect(simctl.getMethodCalls("getDeviceInfo").length).toBe(0);
  });

  it("captures app data and writes metadata", async () => {
    const snapshotName = "ios-snapshot";
    const bundleId = "com.example.app";
    const containerRoot = path.join(testBasePath, "containers", bundleId);
    const documentsPath = path.join(containerRoot, "Documents");
    await fs.mkdir(documentsPath, { recursive: true });
    await fs.writeFile(path.join(documentsPath, "data.txt"), "hello");

    simctl.setContainerPath(bundleId, containerRoot);
    // Installed apps: the user app (with a container) and a system app that is
    // installed but exposes no data container.
    simctl.setInstalledApps([
      { CFBundleIdentifier: bundleId },
      { CFBundleIdentifier: "com.apple.Preferences" },
    ]);
    simctl.setDeviceInfo(device.deviceId, {
      udid: device.deviceId,
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
      os_version: "17.2",
    });

    const captureSnapshot = makeCapture();

    const result = await captureSnapshot.execute({
      snapshotName,
      includeAppData: true,
      includeSettings: true,
      appBundleIds: [bundleId, "com.apple.Preferences", ` ${bundleId} `],
    });

    const pathOptions = { platform: "ios", deviceId: device.deviceId } as const;
    const metadataPath = store.getMetadataPath(snapshotName, pathOptions);
    const metadataJson = await fs.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(metadataJson) as typeof result.manifest;

    expect(result.manifest.includeSettings).toBe(true);
    expect(result.manifest.deviceType).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-15");
    expect(result.manifest.osVersion).toBe("17.2");
    expect(parsed.snapshotName).toBe(snapshotName);
    expect(parsed.platform).toBe("ios");
    expect(parsed.appDataBackup?.backedUpPackages).toEqual([bundleId]);
    // com.apple.Preferences is installed but container-less → skipped-no-container.
    expect(parsed.appDataBackup?.skippedPackages).toEqual(["com.apple.Preferences"]);
    expect(parsed.appDataBackup?.totalPackages).toBe(2);
    expect(parsed.appDataBackup?.bundleStatuses).toEqual([
      { bundleId, status: "captured" },
      { bundleId: "com.apple.Preferences", status: "skipped-no-container" },
    ]);

    const appDataPath = store.getAppDataPath(snapshotName, pathOptions);
    const copiedFile = await fs.readFile(
      path.join(appDataPath, bundleId, "Documents", "data.txt"),
      "utf-8",
    );
    expect(copiedFile).toBe("hello");
  });

  it("fails when strictBackupMode is enabled and app data backup fails", async () => {
    const captureSnapshot = makeCapture();

    await expect(
      captureSnapshot.execute({
        snapshotName: "strict-backup",
        includeAppData: true,
        strictBackupMode: true,
        appBundleIds: ["com.example.missing"],
      }),
    ).rejects.toThrow("Failed to backup app data");
  });

  it("throws when includeAppData is true but no appBundleIds are provided", async () => {
    const captureSnapshot = makeCapture();

    await expect(
      captureSnapshot.execute({
        snapshotName: "no-bundles",
        includeAppData: true,
        appBundleIds: [],
      }),
    ).rejects.toThrow("No app bundle IDs");
  });

  it("throws when includeAppData is true and appBundleIds is undefined", async () => {
    const captureSnapshot = makeCapture();

    await expect(
      captureSnapshot.execute({
        snapshotName: "undefined-bundles",
        includeAppData: true,
      }),
    ).rejects.toThrow("No app bundle IDs");
  });

  it("throws when appBundleIds contains only blank entries", async () => {
    const captureSnapshot = makeCapture();

    await expect(
      captureSnapshot.execute({
        snapshotName: "blank-bundles",
        includeAppData: true,
        appBundleIds: ["  ", ""],
      }),
    ).rejects.toThrow("No app bundle IDs");
  });

  it("classifies bundles as captured, skipped-no-container, or not-installed", async () => {
    const snapshotName = "classify";
    const captured = "com.example.captured";
    const noContainer = "com.example.nocontainer";
    const notInstalled = "com.example.missing";

    const containerRoot = path.join(testBasePath, "containers", captured);
    await fs.mkdir(path.join(containerRoot, "Documents"), { recursive: true });
    await fs.writeFile(path.join(containerRoot, "Documents", "data.txt"), "hello");

    simctl.setContainerPath(captured, containerRoot);
    // `noContainer` is installed but has no data container (empty path).
    simctl.setInstalledApps([
      { CFBundleIdentifier: captured },
      { CFBundleIdentifier: noContainer },
    ]);

    const captureSnapshot = makeCapture();
    const result = await captureSnapshot.execute({
      snapshotName,
      includeAppData: true,
      includeSettings: false,
      appBundleIds: [captured, noContainer, notInstalled],
    });

    expect(result.manifest.appDataBackup?.bundleStatuses).toEqual([
      { bundleId: captured, status: "captured" },
      { bundleId: noContainer, status: "skipped-no-container" },
      { bundleId: notInstalled, status: "not-installed" },
    ]);
    expect(result.manifest.appDataBackup?.backedUpPackages).toEqual([captured]);
    expect(result.manifest.appDataBackup?.skippedPackages).toEqual([noContainer]);
    expect(result.manifest.appDataBackup?.failedPackages).toEqual([notInstalled]);
    expect(result.manifest.appDataBackup?.totalPackages).toBe(3);
  });

  it("fails in strictBackupMode when a bundle is not installed", async () => {
    simctl.setInstalledApps([{ CFBundleIdentifier: "com.example.other" }]);
    const captureSnapshot = makeCapture();

    await expect(
      captureSnapshot.execute({
        snapshotName: "strict-not-installed",
        includeAppData: true,
        strictBackupMode: true,
        appBundleIds: ["com.example.missing"],
      }),
    ).rejects.toThrow("Failed to backup app data");
  });

  it("captures iOS settings (locale + UI) into the manifest when includeSettings", async () => {
    simctl.setCommandArgsResult(
      ["spawn", device.deviceId, "defaults", "read", ".GlobalPreferences", "AppleLocale"],
      "nl_BE\n",
    );
    simctl.setCommandArgsResult(["ui", device.deviceId, "appearance"], "dark\n");
    simctl.setCommandArgsResult(["ui", device.deviceId, "content_size"], "large\n");

    const captureSnapshot = makeCapture();
    const result = await captureSnapshot.execute({
      snapshotName: "with-settings",
      includeAppData: false,
      includeSettings: true,
    });

    expect(result.manifest.includeSettings).toBe(true);
    expect(result.manifest.iosSettings?.values[".GlobalPreferences/AppleLocale"]).toBe("nl_BE");
    expect(result.manifest.iosSettings?.ui).toEqual({ appearance: "dark", contentSize: "large" });

    // Manifest survives the round-trip to disk.
    const pathOptions = { platform: "ios", deviceId: device.deviceId } as const;
    const metadataJson = await fs.readFile(
      store.getMetadataPath("with-settings", pathOptions),
      "utf-8",
    );
    const parsed = JSON.parse(metadataJson) as typeof result.manifest;
    expect(parsed.iosSettings?.values[".GlobalPreferences/AppleLocale"]).toBe("nl_BE");
  });

  it("omits iosSettings and issues no settings commands when includeSettings is false", async () => {
    const captureSnapshot = makeCapture();
    const result = await captureSnapshot.execute({
      snapshotName: "no-settings",
      includeAppData: false,
      includeSettings: false,
    });

    expect(result.manifest.includeSettings).toBe(false);
    expect(result.manifest.iosSettings).toBeUndefined();

    const settingsCommands = simctl
      .getMethodCalls("executeCommandArgs")
      .map((call) => call.args as string[])
      .filter((args) => args.includes("defaults") || args[0] === "ui");
    expect(settingsCommands).toEqual([]);
  });
});
