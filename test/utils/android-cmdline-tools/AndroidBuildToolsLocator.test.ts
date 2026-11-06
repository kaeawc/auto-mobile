import { expect, describe, test, beforeEach, spyOn } from "bun:test";
import { DefaultAndroidBuildToolsLocator } from "../../../src/utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { FakeSystemDetection } from "../../fakes/FakeSystemDetection";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { join } from "path";
import { logger } from "../../../src/utils/logger";

describe("DefaultAndroidBuildToolsLocator", () => {
  let systemDetection: FakeSystemDetection;
  let fileSystem: FakeFileSystem;

  beforeEach(() => {
    systemDetection = new FakeSystemDetection();
    fileSystem = new FakeFileSystem();
  });

  test("uses aapt2 from PATH when available", async () => {
    systemDetection.setPlatform("darwin");
    systemDetection.setExecResponse("which aapt2", "/usr/local/bin/aapt2\n");

    const locator = new DefaultAndroidBuildToolsLocator(fileSystem, systemDetection);
    const tool = await locator.findAaptTool();

    expect(tool).toEqual({ tool: "aapt2", path: "/usr/local/bin/aapt2" });
  });

  test("warns on an unreadable build-tools directory and keeps searching", async () => {
    systemDetection.setPlatform("darwin");
    systemDetection.setEnvVar("ANDROID_HOME", "/sdk");
    systemDetection.addExistingFile("/sdk");
    fileSystem.setDirectory("/sdk/build-tools");
    const read = spyOn(fileSystem, "readdir").mockRejectedValue(new Error("permission denied"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const locator = new DefaultAndroidBuildToolsLocator(fileSystem, systemDetection);
      expect(await locator.findAaptTool()).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "[AndroidBuildToolsLocator] Failed to read build-tools directory: permission denied",
      );
    } finally {
      read.mockRestore();
      warn.mockRestore();
    }
  });

  test("prefers aapt2 in build-tools over aapt", async () => {
    systemDetection.setPlatform("darwin");
    systemDetection.setEnvVar("ANDROID_HOME", "/sdk");
    systemDetection.addExistingFile("/sdk");

    fileSystem.setDirectory("/sdk/build-tools");
    fileSystem.setFile(join("/sdk/build-tools", "35.0.0", "aapt"), "");
    fileSystem.setFile(join("/sdk/build-tools", "34.0.0", "aapt2"), "");

    const locator = new DefaultAndroidBuildToolsLocator(fileSystem, systemDetection);
    const tool = await locator.findAaptTool();

    expect(tool).toEqual({ tool: "aapt2", path: join("/sdk/build-tools", "34.0.0", "aapt2") });
  });
  test("finds stamp tools together and chooses the newest installed platform", async () => {
    systemDetection.setPlatform("darwin");
    systemDetection.setEnvVar("ANDROID_HOME", "/sdk");
    systemDetection.addExistingFile("/sdk");
    for (const tool of ["aapt2", "zipalign", "apksigner"]) {
      fileSystem.setFile(`/sdk/build-tools/37.0.0/${tool}`, "");
    }
    fileSystem.setFile("/sdk/platforms/android-9/android.jar", "");
    fileSystem.setFile("/sdk/platforms/android-37/android.jar", "");
    const locator = new DefaultAndroidBuildToolsLocator(fileSystem, systemDetection);
    expect(await locator.findStampTools()).toEqual({
      aapt2: join("/sdk/build-tools", "37.0.0", "aapt2"),
      zipalign: join("/sdk/build-tools", "37.0.0", "zipalign"),
      apksigner: join("/sdk/build-tools", "37.0.0", "apksigner"),
      androidJar: join("/sdk/platforms", "android-37", "android.jar"),
    });
  });
  test("skips a newer build-tools directory missing zipalign or apksigner", async () => {
    systemDetection.setPlatform("darwin");
    systemDetection.setEnvVar("ANDROID_HOME", "/sdk");
    systemDetection.addExistingFile("/sdk");
    fileSystem.setFile("/sdk/build-tools/37.0.0/aapt2", "");
    fileSystem.setFile("/sdk/build-tools/37.0.0/zipalign", "");
    for (const tool of ["aapt2", "zipalign", "apksigner"]) {
      fileSystem.setFile(`/sdk/build-tools/35.0.0/${tool}`, "");
    }
    fileSystem.setFile("/sdk/platforms/android-35/android.jar", "");
    const locator = new DefaultAndroidBuildToolsLocator(fileSystem, systemDetection);
    expect((await locator.findStampTools())?.apksigner).toBe(
      join("/sdk/build-tools", "35.0.0", "apksigner"),
    );
  });
  test("keeps searching later SDK roots when a platforms directory is unreadable", async () => {
    systemDetection.setPlatform("darwin");
    systemDetection.setEnvVar("ANDROID_HOME", "/sdk");
    systemDetection.addExistingFile("/sdk");
    for (const tool of ["aapt2", "zipalign", "apksigner"]) {
      fileSystem.setFile(`/sdk/build-tools/37.0.0/${tool}`, "");
    }
    fileSystem.setDirectory("/sdk/platforms");
    fileSystem.setFile("/opt/android-sdk/platforms/android-36/android.jar", "");
    const readdir = fileSystem.readdir.bind(fileSystem);
    const read = spyOn(fileSystem, "readdir").mockImplementation(async (path: string) => {
      if (path === join("/sdk", "platforms")) {
        throw new Error("permission denied");
      }
      return readdir(path);
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const locator = new DefaultAndroidBuildToolsLocator(fileSystem, systemDetection);
      expect((await locator.findStampTools())?.androidJar).toBe(
        join("/opt/android-sdk/platforms", "android-36", "android.jar"),
      );
      expect(warn).toHaveBeenCalledWith(
        "[AndroidBuildToolsLocator] Failed to read platforms directory: permission denied",
      );
    } finally {
      read.mockRestore();
      warn.mockRestore();
    }
  });
});
