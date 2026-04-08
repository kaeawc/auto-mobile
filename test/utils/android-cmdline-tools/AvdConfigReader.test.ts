import { describe, it, expect } from "bun:test";
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
  it("maps known API levels", () => {
    expect(apiLevelToVersion(34)).toBe("14");
    expect(apiLevelToVersion(35)).toBe("15");
    expect(apiLevelToVersion(33)).toBe("13");
    expect(apiLevelToVersion(28)).toBe("9");
    expect(apiLevelToVersion(21)).toBe("5.0");
  });

  it("returns undefined for unknown API levels", () => {
    expect(apiLevelToVersion(99)).toBeUndefined();
    expect(apiLevelToVersion(0)).toBeUndefined();
  });
});

describe("FileAvdConfigReader", () => {
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
});
