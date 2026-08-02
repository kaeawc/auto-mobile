import { afterEach, describe, it, expect } from "bun:test";
import { parseAvdConfig, apiLevelToVersion, FileAvdConfigReader } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";

describe("parseAvdConfig", () => {
  it("parses screen dimensions", () => {
    const content = [
      "hw.lcd.width=1080",
      "hw.lcd.height=2400",
      "hw.lcd.density=420",
    ].join("\n");

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

  it("parses device name and tag", () => {
    const content = [
      "hw.device.name=pixel_6",
      "tag.id=google_apis",
    ].join("\n");

    const config = parseAvdConfig(content);
    expect(config.deviceName).toBe("pixel_6");
    expect(config.tag).toBe("google_apis");
  });

  it("parses the configured RAM size in megabytes", () => {
    const config = parseAvdConfig("hw.ramSize=1536\n");
    expect(config.ramSizeMb).toBe(1536);
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
    const content = [
      "hw.lcd.width=not_a_number",
      "hw.lcd.height=",
    ].join("\n");

    const config = parseAvdConfig(content);
    expect(config.screenWidth).toBeUndefined();
    expect(config.screenHeight).toBeUndefined();
  });

  it("parses a full realistic config.ini", () => {
    const content = [
      "AvdId=Pixel_7_API_34",
      "PlayStore.enabled=true",
      "abi.type=arm64-v8a",
      "hw.cpu.arch=arm64",
      "hw.device.manufacturer=Google",
      "hw.device.name=pixel_7",
      "hw.lcd.density=420",
      "hw.lcd.height=2400",
      "hw.lcd.width=1080",
      "image.sysdir.1=system-images/android-34/google_apis_playstore/arm64-v8a/",
      "tag.id=google_apis_playstore",
    ].join("\n");

    const config = parseAvdConfig(content);
    expect(config.apiLevel).toBe(34);
    expect(config.osVersion).toBe("14");
    expect(config.screenWidth).toBe(1080);
    expect(config.screenHeight).toBe(2400);
    expect(config.screenDensity).toBe(420);
    expect(config.deviceName).toBe("pixel_7");
    expect(config.tag).toBe("google_apis_playstore");
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

describe("FileAvdConfigReader", () => {
  const previousAndroidAvdHome = process.env.ANDROID_AVD_HOME;
  const previousAndroidUserHome = process.env.ANDROID_USER_HOME;
  const previousAndroidEmulatorHome = process.env.ANDROID_EMULATOR_HOME;
  const previousAndroidSdkHome = process.env.ANDROID_SDK_HOME;

  afterEach(() => {
    if (previousAndroidAvdHome === undefined) {delete process.env.ANDROID_AVD_HOME;} else {process.env.ANDROID_AVD_HOME = previousAndroidAvdHome;}
    if (previousAndroidUserHome === undefined) {delete process.env.ANDROID_USER_HOME;} else {process.env.ANDROID_USER_HOME = previousAndroidUserHome;}
    if (previousAndroidEmulatorHome === undefined) {delete process.env.ANDROID_EMULATOR_HOME;} else {process.env.ANDROID_EMULATOR_HOME = previousAndroidEmulatorHome;}
    if (previousAndroidSdkHome === undefined) {delete process.env.ANDROID_SDK_HOME;} else {process.env.ANDROID_SDK_HOME = previousAndroidSdkHome;}
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
    const readFileFn = async () => { throw new Error("Permission denied"); };
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
      async path => { paths.push(path); return "image.sysdir.1=system-images/android-34/google_apis_playstore/arm64-v8a/"; },
      path => path === expectedConfigPath,
    );

    const config = await reader.readConfig("Play");

    expect(config?.apiLevel).toBe(34);
    expect(paths[0]).toBe(path.join("/user-home", "avd", "Play.avd", "config.ini"));
  });

  it("resolves an absolute custom path from the AVD registry", async () => {
    const path = require("path");
    const avdHome = path.resolve("fake", "avd");
    const registryPath = path.join(avdHome, "Custom.ini");
    const configPath = path.join(path.resolve("custom", "avds"), "Custom.avd", "config.ini");
    const readPaths: string[] = [];
    const reader = new FileAvdConfigReader(
      async filePath => {
        readPaths.push(filePath);
        if (filePath === registryPath) {return `path=${path.dirname(configPath)}\n`;}
        if (filePath === configPath) {return "hw.ramSize=4096\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/";}
        throw new Error(`Unexpected path: ${filePath}`);
      },
      filePath => filePath === registryPath || filePath === configPath,
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
      async filePath => {
        readPaths.push(filePath);
        if (filePath === registryPath) {return `path=${relocatedAvdHome}/Custom.avd\n`;}
        if (filePath === relocatedConfigPath) {return "hw.ramSize=4096\n";}
        if (filePath === conventionalConfigPath) {return "hw.ramSize=1024\n";}
        throw new Error(`Unexpected path: ${filePath}`);
      },
      filePath => filePath === registryPath || filePath === conventionalConfigPath || filePath === relocatedConfigPath,
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
      async filePath => {
        readPaths.push(filePath);
        if (filePath === registryPath) {return "path.rel=custom-avds/Custom.avd\n";}
        if (filePath === configPath) {return "hw.ramSize=3072\n";}
        throw new Error(`Unexpected path: ${filePath}`);
      },
      filePath => filePath === registryPath || filePath === configPath,
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
      async filePath => {
        readPaths.push(filePath);
        if (filePath === registryPath) {return "path=/stale/Custom.avd\npath.rel=avd/Custom.avd\n";}
        if (filePath === configPath) {return "hw.ramSize=3072\n";}
        throw new Error(`Unexpected path: ${filePath}`);
      },
      filePath => filePath === registryPath || filePath === configPath,
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
      async filePath => {
        readPaths.push(filePath);
        if (filePath === registryPath) {return "path.rel=custom-avds/Custom.avd\n";}
        if (filePath === configPath) {return "hw.ramSize=3072\n";}
        throw new Error(`Unexpected path: ${filePath}`);
      },
      filePath => filePath === registryPath || filePath === configPath,
    );

    const config = await reader.readConfig("Custom");

    expect(config?.ramSizeMb).toBe(3072);
    expect(readPaths).toEqual([registryPath, configPath]);
  });

  it("resolves a parent-relative registry path from the Android user-home parent", async () => {
    const path = require("path");
    const avdHome = path.resolve("fake", ".android", "avd");
    const registryPath = path.join(avdHome, "Custom.ini");
    const configPath = path.join(path.resolve("fake", ".android", "../..", "outside"), "Custom.avd", "config.ini");
    const readPaths: string[] = [];
    const reader = new FileAvdConfigReader(
      async filePath => {
        readPaths.push(filePath);
        if (filePath === registryPath) {return "path.rel=../../outside/Custom.avd\n";}
        if (filePath === configPath) {return "hw.ramSize=3072\n";}
        throw new Error(`Unexpected path: ${filePath}`);
      },
      filePath => filePath === registryPath || filePath === configPath,
      avdHome,
    );

    const config = await reader.readConfig("Custom");

    expect(config?.ramSizeMb).toBe(3072);
    expect(readPaths).toEqual([registryPath, configPath]);
  });
});
