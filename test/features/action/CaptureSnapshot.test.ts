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

    it("should use settings-only snapshot for non-emulator device even with useVmSnapshot=true", async () => {
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

      const result = await capturePhysical.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: true,
      });

      // Physical devices cannot take a VM snapshot; they fall back to the
      // settings-only ADB path (VM snapshot command is never issued).
      expect(result.snapshotType).toBe("adb");
      expect(fakeAdb.wasCommandExecuted("emu avd snapshot save")).toBe(false);
    });
  });

  // #5708: the deprecated `adb backup` app-data path was dropped. Non-VM Android
  // (physical devices, or emulators with useVmSnapshot:false) now captures device
  // settings and foreground-app state only -- never `adb backup`.
  describe("settings-only Android snapshot (#5708)", () => {
    it("captures settings and foreground app without ever invoking adb backup", async () => {
      const snapshotName = "test-settings-only";

      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: true,
        useVmSnapshot: false,
      });

      // snapshotType stays "adb" for backward compatibility with the archive.
      expect(result.snapshotType).toBe("adb");
      expect(result.manifest.foregroundApp).toBe("com.example.app");

      // Settings are captured via `settings list` (CtrlProxy falls back to ADB).
      expect(result.manifest.settings?.global).toEqual({ airplane_mode_on: "0" });

      // No app-data machinery: no adb backup command, no appDataBackup metadata,
      // no package enumeration for backup, and includeAppData recorded as false.
      expect(fakeAdb.wasCommandExecuted("backup -f")).toBe(false);
      expect(result.manifest.appDataBackup).toBeUndefined();
      expect(result.manifest.packages).toBeUndefined();
      expect(result.manifest.includeAppData).toBe(false);
    });

    it("records includeAppData:false even when the caller requested app data", async () => {
      const snapshotName = "test-settings-only-requested-appdata";

      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
      });

      expect(result.manifest.includeAppData).toBe(false);
      expect(result.manifest.appDataBackup).toBeUndefined();
      expect(fakeAdb.wasCommandExecuted("backup -f")).toBe(false);
    });

    it("does not throw when strictBackupMode is set (it is iOS-only, a no-op on Android)", async () => {
      const snapshotName = "test-strict-mode-noop";

      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: false,
        useVmSnapshot: false,
        strictBackupMode: true,
      });

      // strictBackupMode used to fail the whole Android snapshot when adb backup
      // failed; with the adb-backup path gone it can no longer fail here.
      expect(result.snapshotType).toBe("adb");
      expect(fakeAdb.wasCommandExecuted("backup -f")).toBe(false);
    });

    it("captures a settings-only snapshot on a physical device without adb backup", async () => {
      const snapshotName = "test-physical-settings-only";
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

      const result = await capturePhysical.execute({
        snapshotName,
        includeAppData: true,
        includeSettings: true,
        useVmSnapshot: false,
      });

      expect(result.snapshotType).toBe("adb");
      expect(result.manifest.includeAppData).toBe(false);
      expect(result.manifest.settings?.secure).toEqual({ android_id: "abc123" });
      expect(fakeAdb.wasCommandExecuted("backup -f")).toBe(false);
    });
  });

  describe("settings capture", () => {
    it("should capture all settings types", async () => {
      const snapshotName = "test-settings";

      // Mock getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: false,
        includeSettings: true,
        useVmSnapshot: false,
      });

      expect(result.manifest.includeSettings).toBe(true);
      expect(result.manifest.settings).toBeDefined();
      expect(result.manifest.settings?.global).toEqual({ airplane_mode_on: "0" });
      expect(result.manifest.settings?.secure).toEqual({ android_id: "abc123" });
      expect(result.manifest.settings?.system).toEqual({ screen_brightness: "128" });

      // Verify settings were written to the AVD-scoped path (#5707): the
      // emulator's AVD name (device.name) keys the on-disk directory.
      expect(device.name).toBe("Pixel_5");
      const settingsPath = store.getSettingsPath(snapshotName, {
        platform: "android",
        avdName: device.name,
      });
      // Literal AVD segment (not `device.name`) so the native-source cache guard
      // does not read this as a reference to the on-disk `android/` tree (#4351).
      expect(settingsPath).toBe(
        path.join(testBasePath, "android", "Pixel_5", snapshotName, "settings.json"),
      );
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

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: false,
        includeSettings: true,
        useVmSnapshot: false,
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

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: false,
        includeSettings: true,
        useVmSnapshot: false,
      });

      expect(result.manifest.settings?.global).toEqual({});
      expect(result.manifest.settings?.secure).toEqual({});
      expect(result.manifest.settings?.system).toEqual({});
    });

    it("should skip settings capture when includeSettings is false", async () => {
      const snapshotName = "test-no-settings";

      // Mock getForegroundApp
      fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });

      const result = await captureSnapshot.execute({
        snapshotName,
        includeAppData: false,
        includeSettings: false,
        useVmSnapshot: false,
      });

      expect(result.manifest.includeSettings).toBe(false);
      expect(result.manifest.settings).toBeUndefined();

      // Verify settings commands were not called
      expect(fakeAdb.wasCommandExecuted("shell settings list")).toBe(false);
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
      });

      expect(result.manifest.foregroundApp).toBeUndefined();
      expect(result.manifest.appDataBackup).toBeUndefined();
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
