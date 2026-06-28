import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

describe("AndroidEmulatorClient listAvds", () => {
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

  test("returns AVDs when emulator command succeeds", async () => {
    const execAsync = async (_command: string): Promise<ExecResult> =>
      createExecResult("Pixel_9\nPixel_Tablet\n");
    const client = new AndroidEmulatorClient(execAsync, null, new FakeTimer());
    (client as any).ensureEmulatorPath = async () => "emulator";

    await expect(client.listAvds()).resolves.toEqual([
      { name: "Pixel_9", platform: "android", isRunning: false, source: "local" },
      { name: "Pixel_Tablet", platform: "android", isRunning: false, source: "local" },
    ]);
  });
});
