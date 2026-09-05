import { afterEach, describe, it, expect } from "bun:test";
import {
  parseAvdConfig,
  apiLevelToVersion,
  versionToApiLevelRange,
  FileAvdConfigReader,
} from "../../../src/utils/android-cmdline-tools/AvdConfigReader";

describe("parseAvdConfig", () => {
  it("parses screen dimensions", () => {
    const content = ["hw.lcd.width=1080", "hw.lcd.height=2400", "hw.lcd.density=420"].join("\n");

    const config = parseAvdConfig(content);
    expect(config.screenWidth).toBe(1080);
    expect(config.screenHeight).toBe(2400);
    expect(config.screenDensity).toBe(420);
  });

  it("parses API level from image.sysdir.1", () => {
    const content = "image.sysdir.1=system-images/android-34/google_apis/arm64-v8a/";
    const config = parseAvdConfig(content);
    expect(config.apiLevel).toBe(34);
    expect(config.osVersion).toBe("14");
  });

  it("prefers the emulator CPU architecture over conflicting ABI metadata", () => {
    const config = parseAvdConfig(
      [
        "hw.cpu.arch=x86_64",
        "abi.type=arm64-v8a",
        "image.sysdir.1=system-images/android-34/google_apis/arm64-v8a/",
      ].join("\n"),
    );

    expect(config.architecture).toBe("x86_64");
  });

  it("normalizes supported ABI aliases when hw.cpu.arch is absent", () => {
    expect(parseAvdConfig("abi.type=ARM64-V8A").architecture).toBe("arm64");
    expect(parseAvdConfig("abi.type=aarch64").architecture).toBe("arm64");
    expect(parseAvdConfig("abi.type=armeabi-v7a").architecture).toBe("arm");
    expect(parseAvdConfig("abi.type=X86_64").architecture).toBe("x86_64");
  });

  it("falls back to image.sysdir.1 when abi.type is absent", () => {
    const config = parseAvdConfig(
      "image.sysdir.1=system-images/android-34/google_apis_playstore/x86_64/",
    );

    expect(config.architecture).toBe("x86_64");
  });

  it("ignores malformed architecture metadata", () => {
    const config = parseAvdConfig(
      "hw.cpu.arch=unknown\nabi.type=also-unknown\nimage.sysdir.1=not/a/system/image/",
    );

    expect(config.architecture).toBeUndefined();
  });

  it("parses device name and tag", () => {
    const content = ["hw.device.name=pixel_6", "tag.id=google_apis"].join("\n");

    const config = parseAvdConfig(content);
    expect(config.deviceName).toBe("pixel_6");
    expect(config.tag).toBe("google_apis");
  });

  it("derives a normalized hardware capability inventory", () => {
    const config = parseAvdConfig(
      ["hw.camera.back=virtualscene", "hw.fingerprint=yes", "hw.nfc=no"].join("\n"),
    );

    expect(config.capabilityInventory).toEqual({
      schemaVersion: 1,
      capabilities: [
        { id: "android.hardware.camera", state: "available", source: "avd_config" },
        { id: "android.hardware.fingerprint", state: "available", source: "avd_config" },
        { id: "android.hardware.nfc", state: "unavailable", source: "avd_config" },
      ],
    });
  });

  it("parses the configured RAM size in megabytes", () => {
    const config = parseAvdConfig("hw.ramSize=1536\n");
    expect(config.ramSizeMb).toBe(1536);
  });

  it("normalizes RAM size suffixes to megabytes", () => {
    expect(parseAvdConfig("hw.ramSize=2G\n").ramSizeMb).toBe(2048);
    expect(parseAvdConfig("hw.ramSize=1024KiB\n").ramSizeMb).toBe(1);
    expect(parseAvdConfig("hw.ramSize=2048M\n").ramSizeMb).toBe(2048);
    expect(parseAvdConfig("hw.ramSize=2GiB\n").ramSizeMb).toBe(2048);
  });

  it("marks malformed RAM sizes without interpreting partial numbers", () => {
    const config = parseAvdConfig("hw.ramSize=2G-invalid\n");
    expect(config.ramSizeMb).toBeUndefined();
    expect(config.ramSizeInvalid).toBe(true);
  });

  it("preserves a zero RAM value so the launch preflight can reject it", () => {
    expect(parseAvdConfig("hw.ramSize=0\n").ramSizeMb).toBe(0);
  });

  it("handles unknown API level gracefully", () => {
    const content = "image.sysdir.1=system-images/android-99/google_apis/arm64-v8a/";
    const config = parseAvdConfig(content);
    expect(config.apiLevel).toBe(99);
    expect(config.osVersion).toBe("99");
  });

  it("skips comments and blank lines", () => {
    const content = [
      "# This is a comment",
      "",
      "hw.lcd.width=1080",
      "  # Another comment",
      "hw.lcd.height=2400",
    ].join("\n");

    const config = parseAvdConfig(content);
    expect(config.screenWidth).toBe(1080);
    expect(config.screenHeight).toBe(2400);
  });

  it("returns empty config for empty content", () => {
    const config = parseAvdConfig("");
    expect(config.apiLevel).toBeUndefined();
    expect(config.screenWidth).toBeUndefined();
  });

  it("handles malformed values gracefully", () => {
    const content = ["hw.lcd.width=not_a_number", "hw.lcd.height="].join("\n");

    const config = parseAvdConfig(content);
    expect(config.screenWidth).toBeUndefined();
    expect(config.screenHeight).toBeUndefined();
  });

  it("parses a full realistic config.ini", () => {
    const content = [
      "AvdId=Pixel_7_API_34",
      "PlayStore.enabled=true",
      "abi.type=arm64-v8a",
      "hw.camera.back=virtualscene",
      "hw.cpu.arch=arm64",
      "hw.device.manufacturer=Google",
      "hw.device.name=pixel_7",
      "hw.lcd.density=420",
      "hw.lcd.height=2400",
      "hw.lcd.width=1080",
      "hw.nfc=no",
      "image.sysdir.1=system-images/android-34/google_apis_playstore/arm64-v8a/",
      "tag.id=google_apis_playstore",
    ].join("\n");

    const config = parseAvdConfig(content);
    expect(config.apiLevel).toBe(34);
    expect(config.osVersion).toBe("14");
    expect(config.architecture).toBe("arm64");
    expect(config.screenWidth).toBe(1080);
    expect(config.screenHeight).toBe(2400);
    expect(config.screenDensity).toBe(420);
    expect(config.deviceName).toBe("pixel_7");
    expect(config.tag).toBe("google_apis_playstore");
    expect(config.capabilityInventory).toEqual({
      schemaVersion: 1,
      capabilities: [
        { id: "android.hardware.camera", state: "available", source: "avd_config" },
        { id: "android.hardware.nfc", state: "unavailable", source: "avd_config" },
      ],
    });
  });
});

describe("apiLevelToVersion", () => {
  // PARAM-10: pin the entire API-level -> version map, not a sample of five, so
  // a drifted or removed entry is caught. The map runs contiguously 21..36.
  const mapRows: Array<[number, string]> = [
    [21, "5.0"],
    [22, "5.1"],
    [23, "6.0"],
    [24, "7.0"],
    [25, "7.1"],
    [26, "8.0"],
    [27, "8.1"],
    [28, "9"],
    [29, "10"],
    [30, "11"],
    [31, "12"],
    [32, "12L"],
    [33, "13"],
    [34, "14"],
    [35, "15"],
    [36, "16"],
  ];

  for (const [apiLevel, version] of mapRows) {
    it(`maps API ${apiLevel} to Android ${version}`, () => {
      expect(apiLevelToVersion(apiLevel)).toBe(version);
    });
  }

  // Boundaries just outside the map, plus clearly-out-of-range values.
  const unknownRows = [20, 37, 0, -1, 99];
  for (const apiLevel of unknownRows) {
    it(`returns undefined for unmapped API ${apiLevel}`, () => {
      expect(apiLevelToVersion(apiLevel)).toBeUndefined();
    });
  }
});

describe("versionToApiLevelRange", () => {
  // Inverse of apiLevelToVersion for the release-version bounds startDevice
  // documents (#6132). Every table row must round-trip.
  for (const apiLevel of Array.from({ length: 16 }, (_, index) => 21 + index)) {
    it(`round-trips API ${apiLevel} through its release version`, () => {
      const version = apiLevelToVersion(apiLevel);
      expect(version).toBeDefined();
      expect(versionToApiLevelRange(version as string)).toEqual({ min: apiLevel, max: apiLevel });
    });
  }

  it("spans every point release when only the major is given", () => {
    expect(versionToApiLevelRange("8")).toEqual({ min: 26, max: 27 });
    expect(versionToApiLevelRange("5")).toEqual({ min: 21, max: 22 });
  });

  it("treats a trailing .0 as the bare major", () => {
    expect(versionToApiLevelRange("14.0")).toEqual({ min: 34, max: 34 });
    expect(versionToApiLevelRange("9.0")).toEqual({ min: 28, max: 28 });
  });

  it("accepts redundant trailing-zero components like the matcher does (regression)", () => {
    // The device matcher's own comparator zero-pads and treats "14",
    // "14.0", and "14.0.0" as equal, so a minOsVersion/maxOsVersion bound
    // in any of those forms must resolve identically here too -- a caller
    // that echoes the matcher's own osVersion string back in as a bound
    // must not hit "Unrecognized ...OsVersion".
    expect(versionToApiLevelRange("14.0.0")).toEqual(versionToApiLevelRange("14"));
    expect(versionToApiLevelRange("8.1.0")).toEqual(versionToApiLevelRange("8.1"));
  });

  it("still rejects a non-zero third component (no such point release)", () => {
    expect(versionToApiLevelRange("8.1.5")).toBeUndefined();
  });

  it("does not fold 12L into 12", () => {
    expect(versionToApiLevelRange("12")).toEqual({ min: 31, max: 31 });
    expect(versionToApiLevelRange("12l")).toEqual({ min: 32, max: 32 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(versionToApiLevelRange(" 14 ")).toEqual({ min: 34, max: 34 });
  });

  for (const unknown of ["17", "4.4", "8.2", "", "abc", "14-QPR1"]) {
    it(`returns undefined for unmapped release version '${unknown}'`, () => {
      expect(versionToApiLevelRange(unknown)).toBeUndefined();
    });
  }
});

describe("FileAvdConfigReader", () => {
  const previousAndroidAvdHome = process.env.ANDROID_AVD_HOME;
  const previousAndroidUserHome = process.env.ANDROID_USER_HOME;
  const previousAndroidEmulatorHome = process.env.ANDROID_EMULATOR_HOME;
  const previousAndroidSdkHome = process.env.ANDROID_SDK_HOME;

  afterEach(() => {
    if (previousAndroidAvdHome === undefined) {
      delete process.env.ANDROID_AVD_HOME;
    } else {
      process.env.ANDROID_AVD_HOME = previousAndroidAvdHome;
    }
    if (previousAndroidUserHome === undefined) {
      delete process.env.ANDROID_USER_HOME;
    } else {
      process.env.ANDROID_USER_HOME = previousAndroidUserHome;
    }
    if (previousAndroidEmulatorHome === undefined) {
      delete process.env.ANDROID_EMULATOR_HOME;
    } else {
      process.env.ANDROID_EMULATOR_HOME = previousAndroidEmulatorHome;
    }
    if (previousAndroidSdkHome === undefined) {
      delete process.env.ANDROID_SDK_HOME;
    } else {
      process.env.ANDROID_SDK_HOME = previousAndroidSdkHome;
    }
  });

  it("reads config from correct path", async () => {
    const matchesConfigPath = (p: string) => p.includes("TestAvd.avd") && p.endsWith("config.ini");
    const readFileFn = async (path: string, _encoding: string) => {
      if (matchesConfigPath(path)) {
        return "hw.lcd.width=1080\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/";
      }
      throw new Error("File not found");
    };
    const existsFn = (path: string) => matchesConfigPath(path);

    const reader = new FileAvdConfigReader(readFileFn, existsFn, "/fake/avd");
    const config = await reader.readConfig("TestAvd");

    expect(config).not.toBeNull();
    expect(config!.screenWidth).toBe(1080);
    expect(config!.apiLevel).toBe(34);
  });

  it("returns null when config.ini does not exist", async () => {
    const readFileFn = async () => "";
    const existsFn = () => false;

    const reader = new FileAvdConfigReader(readFileFn, existsFn, "/fake/avd");
    const config = await reader.readConfig("Missing");

    expect(config).toBeNull();
  });

  it("returns null when readFile fails", async () => {
    const readFileFn = async () => {
      throw new Error("Permission denied");
    };
    const existsFn = () => true;

    const reader = new FileAvdConfigReader(readFileFn, existsFn, "/fake/avd");
    const config = await reader.readConfig("Broken");

    expect(config).toBeNull();
  });

  it("uses ANDROID_USER_HOME/avd when ANDROID_AVD_HOME is unset", async () => {
    delete process.env.ANDROID_AVD_HOME;
    delete process.env.ANDROID_EMULATOR_HOME;
    process.env.ANDROID_USER_HOME = "/user-home";
    const path = require("path");
    const paths: string[] = [];
    const expectedConfigPath = path.join("/user-home", "avd", "Play.avd", "config.ini");
    const reader = new FileAvdConfigReader(
      async (path) => {
        paths.push(path);
        return "image.sysdir.1=system-images/android-34/google_apis_playstore/arm64-v8a/";
      },
      (path) => path === expectedConfigPath,
    );

    const config = await reader.readConfig("Play");

    expect(config?.apiLevel).toBe(34);
    expect(paths[0]).toBe(path.join("/user-home", "avd", "Play.avd", "config.ini"));
  });

  it("ignores an empty ANDROID_EMULATOR_HOME", async () => {
    delete process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_EMULATOR_HOME = "";
    process.env.ANDROID_USER_HOME = "/user-home";
    const path = require("path");
    const expectedConfigPath = path.join("/user-home", "avd", "Play.avd", "config.ini");
    const reader = new FileAvdConfigReader(
      async (filePath) =>
        filePath === expectedConfigPath
          ? "image.sysdir.1=system-images/android-34/google_apis_playstore/arm64-v8a/"
          : "",
      (filePath) => filePath === expectedConfigPath,
    );

    const config = await reader.readConfig("Play");

    expect(config?.apiLevel).toBe(34);
  });

  it("resolves an absolute custom path from the AVD registry", async () => {
    const path = require("path");
    const avdHome = path.resolve("fake", "avd");
    const registryPath = path.join(avdHome, "Custom.ini");
    const configPath = path.join(path.resolve("custom", "avds"), "Custom.avd", "config.ini");
    const readPaths: string[] = [];
    const reader = new FileAvdConfigReader(
      async (filePath) => {
        readPaths.push(filePath);
        if (filePath === registryPath) {
          return `path=${path.dirname(configPath)}\n`;
        }
        if (filePath === configPath) {
          return "hw.ramSize=4096\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/";
        }
        throw new Error(`Unexpected path: ${filePath}`);
      },
      (filePath) => filePath === registryPath || filePath === configPath,
      avdHome,
    );

    const config = await reader.readConfig("Custom");

    expect(config?.ramSizeMb).toBe(4096);
    expect(readPaths).toEqual([registryPath, configPath]);
  });

  it("prefers a valid registry target over a stale conventional config", async () => {
    const path = require("path");
    const avdHome = path.resolve("fake", "avd");
    const relocatedAvdHome = path.resolve("custom", "avds");
    const registryPath = path.join(avdHome, "Custom.ini");
    const conventionalConfigPath = path.join(avdHome, "Custom.avd", "config.ini");
    const relocatedConfigPath = path.join(relocatedAvdHome, "Custom.avd", "config.ini");
    const readPaths: string[] = [];
    const reader = new FileAvdConfigReader(
      async (filePath) => {
        readPaths.push(filePath);
        if (filePath === registryPath) {
          return `path=${relocatedAvdHome}/Custom.avd\n`;
        }
        if (filePath === relocatedConfigPath) {
          return "hw.ramSize=4096\n";
        }
        if (filePath === conventionalConfigPath) {
          return "hw.ramSize=1024\n";
        }
        throw new Error(`Unexpected path: ${filePath}`);
      },
      (filePath) =>
        filePath === registryPath ||
        filePath === conventionalConfigPath ||
        filePath === relocatedConfigPath,
      avdHome,
    );

    const config = await reader.readConfig("Custom");

    expect(config?.ramSizeMb).toBe(4096);
    expect(readPaths).toEqual([registryPath, relocatedConfigPath]);
  });

  it("resolves a safe relative path.rel from the Android user-home parent", async () => {
    const path = require("path");
    const avdHome = path.resolve("fake", ".android", "avd");
    const configPath = path.join(path.dirname(avdHome), "custom-avds", "Custom.avd", "config.ini");
    const registryPath = path.join(avdHome, "Custom.ini");
    const readPaths: string[] = [];
    const reader = new FileAvdConfigReader(
      async (filePath) => {
        readPaths.push(filePath);
        if (filePath === registryPath) {
          return "path.rel=custom-avds/Custom.avd\n";
        }
        if (filePath === configPath) {
          return "hw.ramSize=3072\n";
        }
        throw new Error(`Unexpected path: ${filePath}`);
      },
      (filePath) => filePath === registryPath || filePath === configPath,
      avdHome,
    );

    const config = await reader.readConfig("Custom");

    expect(config?.ramSizeMb).toBe(3072);
    expect(readPaths).toEqual([registryPath, configPath]);
  });

  it("resolves path.rel from config home when ANDROID_AVD_HOME is overridden", async () => {
    const path = require("path");
    const avdHome = path.resolve("fake", "avd-data");
    const configHome = path.resolve("fake", ".android");
    process.env.ANDROID_AVD_HOME = avdHome;
    process.env.ANDROID_USER_HOME = configHome;
    process.env.ANDROID_EMULATOR_HOME = configHome;
    const registryPath = path.join(avdHome, "Custom.ini");
    const configPath = path.join(configHome, "avd", "Custom.avd", "config.ini");
    const readPaths: string[] = [];
    const reader = new FileAvdConfigReader(
      async (filePath) => {
        readPaths.push(filePath);
        if (filePath === registryPath) {
          return "path=/stale/Custom.avd\npath.rel=avd/Custom.avd\n";
        }
        if (filePath === configPath) {
          return "hw.ramSize=3072\n";
        }
        throw new Error(`Unexpected path: ${filePath}`);
      },
      (filePath) => filePath === registryPath || filePath === configPath,
    );

    const config = await reader.readConfig("Custom");

    expect(config?.ramSizeMb).toBe(3072);
    expect(readPaths).toEqual([registryPath, configPath]);
  });

  it("resolves path.rel from the AVD home parent when only ANDROID_AVD_HOME is set", async () => {
    const path = require("path");
    const avdHome = path.resolve("fake", "avd-data");
    const configHome = path.dirname(avdHome);
    process.env.ANDROID_AVD_HOME = avdHome;
    delete process.env.ANDROID_USER_HOME;
    delete process.env.ANDROID_EMULATOR_HOME;
    delete process.env.ANDROID_SDK_HOME;
    const registryPath = path.join(avdHome, "Custom.ini");
    const configPath = path.join(configHome, "custom-avds", "Custom.avd", "config.ini");
    const readPaths: string[] = [];
    const reader = new FileAvdConfigReader(
      async (filePath) => {
        readPaths.push(filePath);
        if (filePath === registryPath) {
          return "path.rel=custom-avds/Custom.avd\n";
        }
        if (filePath === configPath) {
          return "hw.ramSize=3072\n";
        }
        throw new Error(`Unexpected path: ${filePath}`);
      },
      (filePath) => filePath === registryPath || filePath === configPath,
    );

    const config = await reader.readConfig("Custom");

    expect(config?.ramSizeMb).toBe(3072);
    expect(readPaths).toEqual([registryPath, configPath]);
  });

  it("resolves a parent-relative registry path from the Android user-home parent", async () => {
    const path = require("path");
    const avdHome = path.resolve("fake", ".android", "avd");
    const registryPath = path.join(avdHome, "Custom.ini");
    const configPath = path.join(
      path.resolve("fake", ".android", "../..", "outside"),
      "Custom.avd",
      "config.ini",
    );
    const readPaths: string[] = [];
    const reader = new FileAvdConfigReader(
      async (filePath) => {
        readPaths.push(filePath);
        if (filePath === registryPath) {
          return "path.rel=../../outside/Custom.avd\n";
        }
        if (filePath === configPath) {
          return "hw.ramSize=3072\n";
        }
        throw new Error(`Unexpected path: ${filePath}`);
      },
      (filePath) => filePath === registryPath || filePath === configPath,
      avdHome,
    );

    const config = await reader.readConfig("Custom");

    expect(config?.ramSizeMb).toBe(3072);
    expect(readPaths).toEqual([registryPath, configPath]);
  });
});
