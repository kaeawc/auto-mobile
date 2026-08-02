import { describe, expect, test, beforeEach } from "bun:test";
import type { AndroidDoctorDependencies } from "../../src/doctor/checks/android";
import {
  checkAndroidCommandLineTools,
  checkJavaHome,
  checkAdbInstallation,
  checkAdbVersion,
  checkConnectedDevices,
  checkAvdMemory,
} from "../../src/doctor/checks/android";
import { tmpdir } from "node:os";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../src/models";

const baseDependencies: AndroidDoctorDependencies = {
  detectAndroidCommandLineTools: async () => [],
  getBestAndroidToolsLocation: () => null,
  getAndroidHomeWithSystemImages: () => null,
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    setLogLevel: () => {},
    getLogLevel: () => "info",
    enableStdoutLogging: () => {},
    disableStdoutLogging: () => {},
    close: () => {}
  }
};

describe("Android doctor command line tools check", () => {
  test("warns when Homebrew tools are used and system images are in ANDROID_HOME", async () => {
    const homebrewLocation = {
      path: "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest",
      source: "homebrew" as const,
      available_tools: ["avdmanager", "sdkmanager"]
    };

    const result = await checkAndroidCommandLineTools({}, {
      ...baseDependencies,
      detectAndroidCommandLineTools: async () => [homebrewLocation],
      getBestAndroidToolsLocation: () => homebrewLocation,
      getAndroidHomeWithSystemImages: () => ({
        androidHome: "/Users/test/Library/Android/sdk",
        systemImagesPath: "/Users/test/Library/Android/sdk/system-images"
      })
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Homebrew cmdline-tools detected");
  });

  test("passes when tools are detected via ANDROID_SDK_ROOT", async () => {
    const sdkRootLocation = {
      path: "/Users/test/Library/Android/sdk/cmdline-tools/latest",
      source: "android_sdk_root" as const,
      available_tools: ["avdmanager", "sdkmanager"]
    };

    const result = await checkAndroidCommandLineTools({}, {
      ...baseDependencies,
      detectAndroidCommandLineTools: async () => [sdkRootLocation],
      getBestAndroidToolsLocation: () => sdkRootLocation
    });

    expect(result.status).toBe("pass");
    expect(result.message).toContain("detected");
  });

  test("warns when cmdline-tools is below the supported SDK XML version", async () => {
    const location = {
      path: "/Users/test/Library/Android/sdk/cmdline-tools/latest",
      source: "android_sdk_root" as const,
      available_tools: ["avdmanager", "sdkmanager"],
    };
    const result = await checkAndroidCommandLineTools({}, {
      ...baseDependencies,
      detectAndroidCommandLineTools: async () => [location],
      getBestAndroidToolsLocation: () => location,
      getCmdlineToolsVersion: async () => "8.0",
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("outdated");
    expect(result.message).toContain("8.0");
    expect(result.value).toBe(location.path);
  });

  test("passes when cmdline-tools meets the supported SDK XML version", async () => {
    const location = {
      path: "/Users/test/Library/Android/sdk/cmdline-tools/latest",
      source: "android_sdk_root" as const,
      available_tools: ["avdmanager", "sdkmanager"],
    };
    const result = await checkAndroidCommandLineTools({}, {
      ...baseDependencies,
      detectAndroidCommandLineTools: async () => [location],
      getBestAndroidToolsLocation: () => location,
      getCmdlineToolsVersion: async () => "13.0",
    });

    expect(result.status).toBe("pass");
    expect(result.message).toContain("13.0");
    expect(result.value).toBe(location.path);
  });
});

describe("checkJavaHome", () => {
  let originalJavaHome: string | undefined;

  beforeEach(() => {
    originalJavaHome = process.env.JAVA_HOME;
  });

  test("warns when JAVA_HOME is not set", async () => {
    delete process.env.JAVA_HOME;
    try {
      const result = await checkJavaHome();
      expect(result.name).toBe("JAVA_HOME");
      expect(result.status).toBe("warn");
      expect(result.message).toContain("JAVA_HOME environment variable not set");
      expect(result.recommendation).toContain("Set JAVA_HOME");
    } finally {
      if (originalJavaHome !== undefined) {
        process.env.JAVA_HOME = originalJavaHome;
      } else {
        delete process.env.JAVA_HOME;
      }
    }
  });

  test("warns when JAVA_HOME path does not exist", async () => {
    process.env.JAVA_HOME = "/nonexistent/java/path/that/does/not/exist";
    try {
      const result = await checkJavaHome();
      expect(result.name).toBe("JAVA_HOME");
      expect(result.status).toBe("warn");
      expect(result.message).toContain("path does not exist");
      expect(result.message).toContain("/nonexistent/java/path/that/does/not/exist");
      expect(result.recommendation).toContain("Update JAVA_HOME");
    } finally {
      if (originalJavaHome !== undefined) {
        process.env.JAVA_HOME = originalJavaHome;
      } else {
        delete process.env.JAVA_HOME;
      }
    }
  });

  test("passes when JAVA_HOME is set to a valid path", async () => {
    // Use a path known to exist on every platform (Windows has no /tmp).
    const validPath = tmpdir();
    process.env.JAVA_HOME = validPath;
    try {
      const result = await checkJavaHome();
      expect(result.name).toBe("JAVA_HOME");
      expect(result.status).toBe("pass");
      expect(result.message).toContain("Java home directory found");
      expect(result.value).toBe(validPath);
    } finally {
      if (originalJavaHome !== undefined) {
        process.env.JAVA_HOME = originalJavaHome;
      } else {
        delete process.env.JAVA_HOME;
      }
    }
  });
});

describe("checkAdbInstallation", () => {
  test("passes when ADB is available", async () => {
    const fakeFactory: AdbClientFactory = {
      create: () => ({
        getAdbPathOnly: async () => "/usr/local/bin/adb",
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => [],
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkAdbInstallation(fakeFactory);
    expect(result.name).toBe("ADB Installation");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("ADB is available");
    expect(result.value).toBe("/usr/local/bin/adb");
  });

  test("fails when ADB is not found", async () => {
    const fakeFactory: AdbClientFactory = {
      create: () => ({
        getAdbPathOnly: async () => { throw new Error("adb not found in PATH"); },
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => [],
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkAdbInstallation(fakeFactory);
    expect(result.name).toBe("ADB Installation");
    expect(result.status).toBe("fail");
    expect(result.message).toContain("ADB not found");
    expect(result.message).toContain("adb not found in PATH");
    expect(result.recommendation).toContain("Install Android SDK Platform-Tools");
  });

  test("fails with non-Error thrown values", async () => {
    const fakeFactory: AdbClientFactory = {
      create: () => ({
        getAdbPathOnly: async () => { throw "string error"; },
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => [],
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkAdbInstallation(fakeFactory);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("string error");
  });
});

describe("checkAdbVersion", () => {
  let fakeExecutor: FakeAdbExecutor;
  let fakeFactory: FakeAdbClientFactory;

  beforeEach(() => {
    fakeExecutor = new FakeAdbExecutor();
    // FakeAdbClientFactory expects FakeAdbClient, but checkAdbVersion uses
    // executeCommand which is on AdbExecutor. We build a custom factory
    // that returns our FakeAdbExecutor.
    fakeFactory = new FakeAdbClientFactory(fakeExecutor as any);
  });

  test("passes and parses version from standard ADB output", async () => {
    fakeExecutor.setCommandResponse("--version", {
      stdout: "Android Debug Bridge version 35.0.0\nInstalled as /usr/local/bin/adb",
      stderr: "",
      toString: () => "Android Debug Bridge version 35.0.0",
      trim: () => "Android Debug Bridge version 35.0.0",
      includes: (s: string) => "Android Debug Bridge version 35.0.0".includes(s),
    });

    const result = await checkAdbVersion(fakeFactory);
    expect(result.name).toBe("ADB Version");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Version 35.0.0");
    expect(result.value).toBe("35.0.0");
  });

  test("passes with unknown version when output does not match pattern", async () => {
    fakeExecutor.setCommandResponse("--version", {
      stdout: "some unexpected output",
      stderr: "",
      toString: () => "some unexpected output",
      trim: () => "some unexpected output",
      includes: (s: string) => "some unexpected output".includes(s),
    });

    const result = await checkAdbVersion(fakeFactory);
    expect(result.name).toBe("ADB Version");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Version unknown");
    expect(result.value).toBe("unknown");
  });

  test("warns when executeCommand throws an error", async () => {
    fakeExecutor.setDefaultError(new Error("ADB command failed"));

    const result = await checkAdbVersion(fakeFactory);
    expect(result.name).toBe("ADB Version");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Could not determine ADB version");
    expect(result.message).toContain("ADB command failed");
  });

  test("warns with non-Error thrown values", async () => {
    // Use a custom factory that throws a non-Error
    const throwingFactory: AdbClientFactory = {
      create: () => ({
        executeCommand: async () => { throw "raw string error"; },
        getBootedAndroidDevices: async () => [],
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkAdbVersion(throwingFactory);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("raw string error");
  });

});

describe("checkConnectedDevices", () => {
  let fakeExecutor: FakeAdbExecutor;
  let fakeFactory: FakeAdbClientFactory;

  beforeEach(() => {
    fakeExecutor = new FakeAdbExecutor();
    fakeFactory = new FakeAdbClientFactory(fakeExecutor as any);
  });

  test("warns when no devices are connected", async () => {
    fakeExecutor.setDevices([]);

    const result = await checkConnectedDevices(fakeFactory);
    expect(result.name).toBe("Connected Devices");
    expect(result.status).toBe("warn");
    expect(result.message).toBe("No Android devices connected");
    expect(result.value).toBe(0);
    expect(result.recommendation).toContain("Connect a device");
  });

  test("passes with one connected device", async () => {
    const device: BootedDevice = {
      name: "Pixel 7",
      platform: "android",
      deviceId: "emulator-5554",
    };
    fakeExecutor.setDevices([device]);

    const result = await checkConnectedDevices(fakeFactory);
    expect(result.name).toBe("Connected Devices");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 device(s) connected");
    expect(result.message).toContain("emulator-5554");
    expect(result.value).toBe(1);
  });

  test("passes with multiple connected devices", async () => {
    const devices: BootedDevice[] = [
      { name: "Pixel 7", platform: "android", deviceId: "emulator-5554" },
      { name: "Pixel 8", platform: "android", deviceId: "emulator-5556" },
      { name: "Samsung Galaxy", platform: "android", deviceId: "R5CT12345" },
    ];
    fakeExecutor.setDevices(devices);

    const result = await checkConnectedDevices(fakeFactory);
    expect(result.name).toBe("Connected Devices");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("3 device(s) connected");
    expect(result.message).toContain("emulator-5554");
    expect(result.message).toContain("emulator-5556");
    expect(result.message).toContain("R5CT12345");
    expect(result.value).toBe(3);
  });

  test("warns when getBootedAndroidDevices throws an error", async () => {
    // Use a custom factory that throws on getBootedAndroidDevices
    const throwingFactory: AdbClientFactory = {
      create: () => ({
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => { throw new Error("adb server not running"); },
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkConnectedDevices(throwingFactory);
    expect(result.name).toBe("Connected Devices");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Could not list devices");
    expect(result.message).toContain("adb server not running");
    expect(result.value).toBe(0);
  });

  test("warns with non-Error thrown values", async () => {
    const throwingFactory: AdbClientFactory = {
      create: () => ({
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => { throw "unexpected failure"; },
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkConnectedDevices(throwingFactory);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("unexpected failure");
    expect(result.value).toBe(0);
  });

  test("warns when adb reports an offline device", async () => {
    const fakeFactory: AdbClientFactory = {
      create: () => ({
        getDeviceStates: async () => [{ deviceId: "emulator-5554", state: "offline" }],
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => [],
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkConnectedDevices(fakeFactory);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("offline");
    expect(result.message).toContain("emulator-5554");
  });

  test("gives physical offline devices USB recovery guidance", async () => {
    const fakeFactory: AdbClientFactory = {
      create: () => ({
        getDeviceStates: async () => [{ deviceId: "R5CT12345", state: "offline" }],
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => [],
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkConnectedDevices(fakeFactory);
    expect(result.recommendation).toContain("USB debugging");
  });

  test("passes healthy devices even when adb also reports a stale offline device", async () => {
    const fakeFactory: AdbClientFactory = {
      create: () => ({
        getDeviceStates: async () => [{ deviceId: "emulator-5554", state: "offline" }],
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => [{ name: "Pixel", platform: "android", deviceId: "emulator-5556" }],
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkConnectedDevices(fakeFactory);
    expect(result.status).toBe("pass");
    expect(result.value).toBe(1);
    expect(result.message).toContain("emulator-5556");
  });

  test("keeps healthy devices when the auxiliary offline-state probe fails", async () => {
    const fakeFactory: AdbClientFactory = {
      create: () => ({
        getDeviceStates: async () => { throw new Error("adb state probe unavailable"); },
        executeCommand: async () => ({ stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false }),
        getBootedAndroidDevices: async () => [{ name: "Pixel", platform: "android", deviceId: "emulator-5556" }],
        isScreenOn: async () => true,
        getWakefulness: async () => "Awake" as const,
        listUsers: async () => [],
        getForegroundApp: async () => null,
      }),
    };

    const result = await checkConnectedDevices(fakeFactory);
    expect(result.status).toBe("pass");
    expect(result.value).toBe(1);
  });

  test("warns when an AVD has too little configured RAM", async () => {
    const result = await checkAvdMemory({
      listAvds: async () => [{ name: "Tiny" }],
      readAvdConfig: { readConfig: async () => ({ apiLevel: 36, tag: "google_apis_playstore", ramSizeMb: 1024 }) },
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Tiny");
    expect(result.message).toContain("2048 MB");
  });

  test("does not warn for low-memory non-Play or legacy AVDs", async () => {
    const result = await checkAvdMemory({
      listAvds: async () => [{ name: "Legacy" }, { name: "Wear" }],
      readAvdConfig: { readConfig: async name => name === "Legacy"
        ? { apiLevel: 28, tag: "google_apis", ramSizeMb: 1024 }
        : { apiLevel: 35, tag: "android-wear", ramSizeMb: 1024 } },
    });

    expect(result.status).toBe("pass");
    expect(result.message).toBe("All applicable modern Play-image AVDs meet the 2048 MB memory minimum.");
  });

  test("warns when no AVD config can be read", async () => {
    const result = await checkAvdMemory({
      listAvds: async () => [{ name: "Missing" }],
      readAvdConfig: { readConfig: async () => null },
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Could not read");
  });

  test("warns when any AVD memory configuration is unverifiable", async () => {
    const result = await checkAvdMemory({
      listAvds: async () => [{ name: "Verified" }, { name: "Missing" }],
      readAvdConfig: { readConfig: async name => name === "Verified" ? { ramSizeMb: 4096 } : null },
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Missing");
    expect(result.message).not.toContain("All AVDs meet");
  });

  test("skips when AVDs cannot be listed", async () => {
    const result = await checkAvdMemory({
      listAvds: async () => { throw new Error("emulator unavailable"); },
      readAvdConfig: { readConfig: async () => null },
    });

    expect(result.status).toBe("skip");
    expect(result.message).toContain("emulator unavailable");
  });
});
