import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AvdConfigReader } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

const noAvdConfigReader: AvdConfigReader = {
  async readConfig() {
    return null;
  },
};

describe("AndroidEmulatorClient listAvds", () => {
  test("does not read AVD config files when the emulator command is missing", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "automobile-home-"));
    const originalHome = process.env.HOME;

    try {
      mkdirSync(join(homeDir, ".android", "avd"), { recursive: true });
      writeFileSync(join(homeDir, ".android", "avd", "Pixel_9.ini"), "path=/host/Pixel_9.avd\n");
      process.env.HOME = homeDir;

      const execAsync = async (_command: string): Promise<ExecResult> => {
        throw new Error("emulator: command not found");
      };
      const client = new AndroidEmulatorClient(
        execAsync,
        null,
        new FakeTimer(),
        undefined,
        noAvdConfigReader,
      );
      (client as any).ensureEmulatorPath = async () => "emulator";

      await expect(client.listAvds()).rejects.toThrow("Android emulator not found");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("reports deleted daemon cwd failures separately from a missing emulator binary", async () => {
    const sdkDir = mkdtempSync(join(tmpdir(), "android-sdk-"));
    const originalAndroidHome = process.env.ANDROID_HOME;
    const originalAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const originalAndroidSdkHome = process.env.ANDROID_SDK_HOME;

    try {
      const emulatorDir = join(sdkDir, "emulator");
      const emulatorPath = join(emulatorDir, "emulator");
      mkdirSync(emulatorDir, { recursive: true });
      writeFileSync(emulatorPath, "");
      process.env.ANDROID_HOME = sdkDir;
      delete process.env.ANDROID_SDK_ROOT;
      delete process.env.ANDROID_SDK_HOME;

      const execAsync = async (_command: string): Promise<ExecResult> => {
        throw new Error("spawn /bin/sh ENOENT");
      };
      const client = new AndroidEmulatorClient(execAsync, null, new FakeTimer());
      (client as any).emulatorPath = emulatorPath;
      (client as any).ensureEmulatorPath = async () => emulatorPath;

      await expect(client.listAvds()).rejects.toThrow("daemon working directory");
      await expect(client.listAvds()).rejects.not.toThrow("Android emulator not found");
    } finally {
      if (originalAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = originalAndroidHome;
      }
      if (originalAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = originalAndroidSdkRoot;
      }
      if (originalAndroidSdkHome === undefined) {
        delete process.env.ANDROID_SDK_HOME;
      } else {
        process.env.ANDROID_SDK_HOME = originalAndroidSdkHome;
      }
      rmSync(sdkDir, { recursive: true, force: true });
    }
  });

  test("reports Bun posix_spawn ENOENT as a daemon cwd failure when emulator path exists", async () => {
    const sdkDir = mkdtempSync(join(tmpdir(), "android-sdk-"));

    try {
      const emulatorDir = join(sdkDir, "emulator");
      const emulatorPath = join(emulatorDir, "emulator");
      mkdirSync(emulatorDir, { recursive: true });
      writeFileSync(emulatorPath, "");

      const execAsync = async (_command: string): Promise<ExecResult> => {
        throw new Error("ENOENT: no such file or directory, posix_spawn '/bin/sh'");
      };
      const client = new AndroidEmulatorClient(execAsync, null, new FakeTimer());
      (client as any).emulatorPath = emulatorPath;
      (client as any).ensureEmulatorPath = async () => emulatorPath;

      await expect(client.listAvds()).rejects.toThrow("daemon working directory");
      await expect(client.listAvds()).rejects.not.toThrow("Android emulator not found");
    } finally {
      rmSync(sdkDir, { recursive: true, force: true });
    }
  });

  test("still reports missing emulator when no emulator path can be resolved", async () => {
    const originalAndroidHome = process.env.ANDROID_HOME;
    const originalAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const originalAndroidSdkHome = process.env.ANDROID_SDK_HOME;

    try {
      delete process.env.ANDROID_HOME;
      delete process.env.ANDROID_SDK_ROOT;
      delete process.env.ANDROID_SDK_HOME;

      const execAsync = async (_command: string): Promise<ExecResult> => {
        throw new Error("emulator: command not found");
      };
      const client = new AndroidEmulatorClient(execAsync, null, new FakeTimer());
      (client as any).ensureEmulatorPath = async () => "emulator";

      await expect(client.listAvds()).rejects.toThrow("Android emulator not found");
    } finally {
      if (originalAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = originalAndroidHome;
      }
      if (originalAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = originalAndroidSdkRoot;
      }
      if (originalAndroidSdkHome === undefined) {
        delete process.env.ANDROID_SDK_HOME;
      } else {
        process.env.ANDROID_SDK_HOME = originalAndroidSdkHome;
      }
    }
  });

  test("names the resolved emulator path, ANDROID_HOME and PATH when the emulator is missing", async () => {
    // Issue #4237: on a GitHub runner the "install via Homebrew" guidance is
    // useless. What the operator actually needs is the path that was probed and
    // the environment it was derived from.
    const originalAndroidHome = process.env.ANDROID_HOME;
    const originalAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const originalPath = process.env.PATH;

    try {
      process.env.ANDROID_HOME = "/usr/local/lib/android/sdk";
      delete process.env.ANDROID_SDK_ROOT;
      process.env.PATH = "/usr/bin:/bin";

      const execAsync = async (): Promise<ExecResult> => {
        throw new Error("spawn /usr/local/lib/android/sdk/emulator/emulator ENOENT");
      };
      const client = new AndroidEmulatorClient(
        execAsync,
        null,
        new FakeTimer(),
        undefined,
        noAvdConfigReader,
      );
      (client as any).ensureEmulatorPath = async () =>
        "/usr/local/lib/android/sdk/emulator/emulator";

      let message = "";
      try {
        await client.listAvds();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("Android emulator not found");
      expect(message).toContain("/usr/local/lib/android/sdk/emulator/emulator");
      expect(message).toContain("ANDROID_HOME=/usr/local/lib/android/sdk");
      expect(message).toContain("ANDROID_SDK_ROOT=<unset>");
      expect(message).toContain("PATH=/usr/bin:/bin");
    } finally {
      if (originalAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = originalAndroidHome;
      }
      if (originalAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = originalAndroidSdkRoot;
      }
      process.env.PATH = originalPath;
    }
  });

  test("returns AVDs when emulator command succeeds", async () => {
    const execAsync = async (_command: string): Promise<ExecResult> =>
      createExecResult("Pixel_9\nPixel_Tablet\n");
    const client = new AndroidEmulatorClient(
      execAsync,
      null,
      new FakeTimer(),
      undefined,
      noAvdConfigReader,
    );
    (client as any).ensureEmulatorPath = async () => "emulator";

    await expect(client.listAvds()).resolves.toEqual([
      { name: "Pixel_9", platform: "android", isRunning: false, source: "local" },
      { name: "Pixel_Tablet", platform: "android", isRunning: false, source: "local" },
    ]);
  });

  test("includes configured Android hardware capabilities in the AVD listing", async () => {
    const configReader: AvdConfigReader = {
      async readConfig() {
        return {
          capabilityInventory: {
            schemaVersion: 1,
            capabilities: [
              { id: "android.hardware.camera", state: "available", source: "avd_config" },
            ],
          },
        };
      },
    };
    const execAsync = async (_command: string): Promise<ExecResult> =>
      createExecResult("Pixel_9\n");
    const client = new AndroidEmulatorClient(
      execAsync,
      null,
      new FakeTimer(),
      undefined,
      configReader,
    );
    (client as any).ensureEmulatorPath = async () => "emulator";

    await expect(client.listAvds()).resolves.toEqual([
      {
        name: "Pixel_9",
        platform: "android",
        isRunning: false,
        source: "local",
        capabilityInventory: {
          schemaVersion: 1,
          capabilities: [
            { id: "android.hardware.camera", state: "available", source: "avd_config" },
          ],
        },
      },
    ]);
  });
});
