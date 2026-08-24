import { expect, describe, test, beforeEach } from "bun:test";
import {
  GetAppMetadata,
  IosAppMetadataSource,
  findAppByBundleId,
  iosRecordToMetadata,
} from "../../../src/features/observe/GetAppMetadata";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const fakeAdbFactory = (fakeAdb: FakeAdbExecutor) => ({ create: () => fakeAdb as any });
const nullAdbFactory = { create: () => ({}) as any };

// --- Android tests ---

describe("GetAppMetadata (Android)", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 7",
    platform: "android",
  };

  let fakeAdb: FakeAdbExecutor;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
  });

  test("parses full dumpsys package output", async () => {
    fakeAdb.setCommandResponse("shell dumpsys package com.example.app", {
      stdout: [
        "Packages:",
        "  Package [com.example.app] (abc123):",
        "    versionCode=42 minSdk=21 targetSdk=34",
        "    versionName=1.2.3",
        "    codePath=/data/app/~~random/com.example.app-xyz==",
        "    firstInstallTime=2024-01-15 10:30:00",
        "    lastUpdateTime=2024-06-20 14:45:00",
      ].join("\n"),
      stderr: "",
      toString() {
        return this.stdout;
      },
      trim() {
        return this.stdout.trim();
      },
      includes(s: string) {
        return this.stdout.includes(s);
      },
    });

    const metadata = new GetAppMetadata(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await metadata.execute("com.example.app");

    expect(result).not.toBeNull();
    expect(result!.appId).toBe("com.example.app");
    expect(result!.platform).toBe("android");
    expect(result!.versionName).toBe("1.2.3");
    expect(result!.buildNumber).toBe("42");
    expect(result!.installPath).toBe("/data/app/~~random/com.example.app-xyz==");
    expect(result!.firstInstallTime).toBe("2024-01-15 10:30:00");
    expect(result!.lastUpdateTime).toBe("2024-06-20 14:45:00");
  });

  test("returns null when package not found", async () => {
    fakeAdb.setCommandResponse("shell dumpsys package com.missing.app", {
      stdout: "Unable to find package: com.missing.app",
      stderr: "",
      toString() {
        return this.stdout;
      },
      trim() {
        return this.stdout.trim();
      },
      includes(s: string) {
        return this.stdout.includes(s);
      },
    });

    const metadata = new GetAppMetadata(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await metadata.execute("com.missing.app");

    expect(result).toBeNull();
  });

  test("returns null when adb command throws", async () => {
    fakeAdb.setCommandError("shell dumpsys package", new Error("device offline"));

    const metadata = new GetAppMetadata(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await metadata.execute("com.example.app");

    expect(result).toBeNull();
  });

  test("returns null when output has no useful fields", async () => {
    fakeAdb.setCommandResponse("shell dumpsys package com.empty.app", {
      stdout: "Packages:\n  Package [com.empty.app]:\n    flags=0\n",
      stderr: "",
      toString() {
        return this.stdout;
      },
      trim() {
        return this.stdout.trim();
      },
      includes(s: string) {
        return this.stdout.includes(s);
      },
    });

    const metadata = new GetAppMetadata(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await metadata.execute("com.empty.app");

    expect(result).toBeNull();
  });

  test("handles missing optional timestamps", async () => {
    fakeAdb.setCommandResponse("shell dumpsys package com.example.app", {
      stdout: [
        "Packages:",
        "  Package [com.example.app]:",
        "    versionCode=10 minSdk=21 targetSdk=34",
        "    versionName=2.0.0",
        "    codePath=/data/app/com.example.app",
      ].join("\n"),
      stderr: "",
      toString() {
        return this.stdout;
      },
      trim() {
        return this.stdout.trim();
      },
      includes(s: string) {
        return this.stdout.includes(s);
      },
    });

    const metadata = new GetAppMetadata(androidDevice, fakeAdbFactory(fakeAdb));
    const result = await metadata.execute("com.example.app");

    expect(result).not.toBeNull();
    expect(result!.versionName).toBe("2.0.0");
    expect(result!.buildNumber).toBe("10");
    expect(result!.firstInstallTime).toBeUndefined();
    expect(result!.lastUpdateTime).toBeUndefined();
  });
});

// --- iOS Simulator tests ---

describe("GetAppMetadata (iOS simulator)", () => {
  const iosSimDevice: BootedDevice = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    name: "iPhone 15",
    platform: "ios",
  };

  let fakeIosSource: FakeIosMetadataSource;

  beforeEach(() => {
    fakeIosSource = new FakeIosMetadataSource();
  });

  test("returns metadata from simulator listApps", async () => {
    fakeIosSource.setApps([
      {
        bundleId: "com.example.app",
        CFBundleShortVersionString: "3.1.0",
        CFBundleVersion: "456",
        bundlePath: "/Library/Developer/CoreSimulator/Devices/.../com.example.app.app",
      },
    ]);

    const metadata = new GetAppMetadata(iosSimDevice, nullAdbFactory, fakeIosSource);
    const result = await metadata.execute("com.example.app");

    expect(result).not.toBeNull();
    expect(result!.appId).toBe("com.example.app");
    expect(result!.platform).toBe("ios");
    expect(result!.versionName).toBe("3.1.0");
    expect(result!.buildNumber).toBe("456");
    expect(result!.installPath).toContain("com.example.app.app");
  });

  test("returns null when app not in simulator", async () => {
    fakeIosSource.setApps([]);

    const metadata = new GetAppMetadata(iosSimDevice, nullAdbFactory, fakeIosSource);
    const result = await metadata.execute("com.missing.app");

    expect(result).toBeNull();
  });

  test("handles alternative key names", async () => {
    fakeIosSource.setApps([
      {
        CFBundleIdentifier: "com.alt.app",
        bundleShortVersionString: "1.0",
        bundleVersion: "100",
        bundleContainer: "/some/path",
      },
    ]);

    const metadata = new GetAppMetadata(iosSimDevice, nullAdbFactory, fakeIosSource);
    const result = await metadata.execute("com.alt.app");

    expect(result).not.toBeNull();
    expect(result!.versionName).toBe("1.0");
    expect(result!.buildNumber).toBe("100");
    expect(result!.installPath).toBe("/some/path");
  });
});

// --- iOS Physical device tests ---

describe("GetAppMetadata (iOS physical)", () => {
  const iosPhysicalDevice: BootedDevice = {
    deviceId: "00008101-001A2B3C4D5E6F78",
    name: "Jason's iPhone",
    platform: "ios",
  };

  let fakeIosSource: FakeIosMetadataSource;

  beforeEach(() => {
    fakeIosSource = new FakeIosMetadataSource();
  });

  test("returns metadata from physical device info", async () => {
    fakeIosSource.setPhysicalAppInfo("com.example.app", {
      bundleIdentifier: "com.example.app",
      CFBundleShortVersionString: "5.0.1",
      CFBundleVersion: "789",
      bundlePath: "/private/var/containers/Bundle/Application/.../MyApp.app",
    });

    const metadata = new GetAppMetadata(iosPhysicalDevice, nullAdbFactory, fakeIosSource);
    const result = await metadata.execute("com.example.app");

    expect(result).not.toBeNull();
    expect(result!.appId).toBe("com.example.app");
    expect(result!.platform).toBe("ios");
    expect(result!.versionName).toBe("5.0.1");
    expect(result!.buildNumber).toBe("789");
    expect(result!.installPath).toContain("MyApp.app");
  });

  test("returns null when app not on physical device", async () => {
    const metadata = new GetAppMetadata(iosPhysicalDevice, nullAdbFactory, fakeIosSource);
    const result = await metadata.execute("com.missing.app");

    expect(result).toBeNull();
  });
});

// --- Helper function tests ---

describe("findAppByBundleId", () => {
  test("matches bundleId key", () => {
    const apps = [{ bundleId: "com.a" }, { bundleId: "com.b" }];
    expect(findAppByBundleId(apps, "com.b")).toEqual({ bundleId: "com.b" });
  });

  test("matches CFBundleIdentifier key", () => {
    const apps = [{ CFBundleIdentifier: "com.c" }];
    expect(findAppByBundleId(apps, "com.c")).toEqual({ CFBundleIdentifier: "com.c" });
  });

  test("returns null when not found", () => {
    expect(findAppByBundleId([], "com.x")).toBeNull();
    expect(findAppByBundleId([{ bundleId: "com.a" }], "com.b")).toBeNull();
  });
});

describe("iosRecordToMetadata", () => {
  test("extracts all fields", () => {
    const result = iosRecordToMetadata("com.test", {
      CFBundleShortVersionString: "1.2.3",
      CFBundleVersion: "45",
      bundlePath: "/path/to/app",
    });

    expect(result).toEqual({
      appId: "com.test",
      platform: "ios",
      versionName: "1.2.3",
      buildNumber: "45",
      installPath: "/path/to/app",
    });
  });

  test("defaults to empty strings for missing fields", () => {
    const result = iosRecordToMetadata("com.test", {});

    expect(result.versionName).toBe("");
    expect(result.buildNumber).toBe("");
    expect(result.installPath).toBe("");
  });
});

// --- Fake ---

class FakeIosMetadataSource implements IosAppMetadataSource {
  private apps: Record<string, unknown>[] = [];
  private physicalApps = new Map<string, Record<string, unknown>>();

  setApps(apps: Record<string, unknown>[]): void {
    this.apps = apps;
  }

  setPhysicalAppInfo(bundleId: string, info: Record<string, unknown>): void {
    this.physicalApps.set(bundleId, info);
  }

  async listApps(): Promise<Record<string, unknown>[]> {
    return this.apps;
  }

  async getPhysicalDeviceAppInfo(
    _deviceId: string,
    bundleId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.physicalApps.get(bundleId) ?? null;
  }
}
