import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AndroidEmulatorClient,
  AndroidEmulatorUnavailableError,
  isMissingExecutableError,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import {
  parseAvdConfig,
  type AvdConfigReader,
} from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
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
      const client = new AndroidEmulatorClient({
        emulatorPathLocator: async () => "emulator",
        execAsync,
        timer: new FakeTimer(),
        avdConfigReader: noAvdConfigReader,
      });

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
      const client = new AndroidEmulatorClient({
        emulatorPathLocator: async () => emulatorPath,
        execAsync,
        timer: new FakeTimer(),
      });

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
      const client = new AndroidEmulatorClient({
        emulatorPathLocator: async () => emulatorPath,
        execAsync,
        timer: new FakeTimer(),
      });

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
      const client = new AndroidEmulatorClient({
        emulatorPathLocator: async () => "emulator",
        execAsync,
        timer: new FakeTimer(),
      });

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
      const client = new AndroidEmulatorClient({
        emulatorPathLocator: async () => "/usr/local/lib/android/sdk/emulator/emulator",
        execAsync,
        timer: new FakeTimer(),
        avdConfigReader: noAvdConfigReader,
      });

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
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => "emulator",
      execAsync,
      timer: new FakeTimer(),
      avdConfigReader: noAvdConfigReader,
    });

    await expect(client.listAvds()).resolves.toEqual([
      { name: "Pixel_9", platform: "android", isRunning: false, source: "local" },
      { name: "Pixel_Tablet", platform: "android", isRunning: false, source: "local" },
    ]);
  });

  test("carries parsed AVD runtime and device-type metadata into configured images", async () => {
    const configReader: AvdConfigReader = {
      async readConfig() {
        return parseAvdConfig(`
          image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/
          hw.device.name=pixel_6
          hw.lcd.width=1080
          hw.lcd.height=2400
          hw.lcd.density=420
        `);
      },
    };
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => "emulator",
      execAsync: async () => createExecResult("Pixel_6\n"),
      timer: new FakeTimer(),
      avdConfigReader: configReader,
    });

    await expect(client.listAvds()).resolves.toEqual([
      expect.objectContaining({
        name: "Pixel_6",
        runtimeId: "system-images;android-36;google_apis;arm64-v8a",
        deviceType: "pixel_6",
        formFactor: "phone",
      }),
    ]);
  });

  test("infers a tablet AVD from its profile when display geometry is incomplete", async () => {
    const configReader: AvdConfigReader = {
      async readConfig() {
        return parseAvdConfig("hw.device.name=pixel_tablet");
      },
    };
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => "emulator",
      execAsync: async () => createExecResult("Pixel_Tablet\n"),
      timer: new FakeTimer(),
      avdConfigReader: configReader,
    });

    await expect(client.listAvds()).resolves.toEqual([
      expect.objectContaining({
        deviceType: "pixel_tablet",
        formFactor: "tablet",
      }),
    ]);
  });

  test("keeps runtimeId undefined when the AVD config has no image.sysdir.1 metadata", async () => {
    const configReader: AvdConfigReader = {
      async readConfig() {
        return parseAvdConfig("hw.device.name=pixel_6");
      },
    };
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => "emulator",
      execAsync: async () => createExecResult("Pixel_6\n"),
      timer: new FakeTimer(),
      avdConfigReader: configReader,
    });

    const [image] = await client.listAvds();
    expect(image.runtimeId).toBeUndefined();
    expect(image.deviceType).toBe("pixel_6");
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
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => "emulator",
      execAsync,
      timer: new FakeTimer(),
      avdConfigReader: configReader,
    });

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

  test("includes the configured Android API level in the AVD listing", async () => {
    const configReader: AvdConfigReader = {
      async readConfig() {
        return { apiLevel: 34 };
      },
    };
    const execAsync = async (_command: string): Promise<ExecResult> =>
      createExecResult("Pixel_9\\n");
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => "emulator",
      execAsync,
      timer: new FakeTimer(),
      avdConfigReader: configReader,
    });

    await expect(client.listAvds()).resolves.toMatchObject([{ apiLevel: 34 }]);
  });

  // Captured via execFile and the client's preserveError shared seam under Bun 1.3.14,
  // darwin/arm64; scratch/m38-12172/capture/errors.ts. Tests only inject these errors.
  const bareMissing = {
    message: 'Executable not found in $PATH: "amprobe-emulator-not-on-path"',
    code: "ENOENT",
    path: "amprobe-emulator-not-on-path",
    syscall: "spawn amprobe-emulator-not-on-path",
    killed: undefined,
    signal: undefined,
  };
  const absoluteMissing = {
    message: "ENOENT: no such file or directory, posix_spawn '/amprobe-emulator-not-on-path'",
    code: "ENOENT",
    path: "/amprobe-emulator-not-on-path",
    syscall: "spawn /amprobe-emulator-not-on-path",
    killed: undefined,
    signal: undefined,
  };
  const nonzeroExit = {
    message:
      "Command failed: /bin/ls /amprobe-no-such-dir\nls: /amprobe-no-such-dir: No such file or directory\n",
    code: 1,
    path: undefined,
    syscall: undefined,
    killed: false,
    signal: null,
  };

  function clientRejecting(error: Error, path: string): AndroidEmulatorClient {
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => path,
      execAsync: async () => {
        throw error;
      },
      timer: new FakeTimer(),
      avdConfigReader: noAvdConfigReader,
    });
    return client;
  }

  test("captured Bun spawn failures are unavailable while nonzero exits stay untyped", async () => {
    for (const fixture of [bareMissing, absoluteMissing]) {
      const client = clientRejecting(
        Object.assign(new Error(fixture.message), fixture),
        fixture.path,
      );
      await expect(client.listAvds()).rejects.toBeInstanceOf(AndroidEmulatorUnavailableError);
      await expect(client.listAvds()).rejects.toThrow("Android emulator not found.");
    }
    const client = clientRejecting(
      Object.assign(new Error(nonzeroExit.message), nonzeroExit),
      "/bin/ls",
    );
    await expect(client.listAvds()).rejects.not.toBeInstanceOf(AndroidEmulatorUnavailableError);
    await expect(client.listAvds()).rejects.toThrow("Android emulator not found.");
  });

  test.each([
    { label: "killed process", killed: true },
    { label: "signal termination", signal: "SIGTERM" },
    { label: "timeout", name: "TimeoutError", message: "Command timed out: ENOENT" },
    { label: "timeout code", code: "ETIMEDOUT" },
    { label: "cancellation code", code: "ABORT_ERR" },
    { label: "cancellation", name: "AbortError" },
    { label: "cancelled command", name: "AbortError", message: "Command cancelled: ENOENT" },
    {
      label: "daemon cwd",
      path: import.meta.path,
      message: "ENOENT: current working directory unavailable",
    },
  ])("spawn failure stays untyped for $label", async (overrides) => {
    // Safety variants of the captured spawn error, not additional host-process probes.
    const fixture = { ...absoluteMissing, ...overrides };
    const client = clientRejecting(
      Object.assign(new Error(fixture.message), fixture),
      fixture.path,
    );
    await expect(client.listAvds()).rejects.not.toBeInstanceOf(AndroidEmulatorUnavailableError);
  });

  test("bare ENOENT requires a matching spawn path when provided", async () => {
    const mismatched = { ...bareMissing, path: "another-executable" };
    const wrongPath = clientRejecting(
      Object.assign(new Error(mismatched.message), mismatched),
      bareMissing.path,
    );
    await expect(wrongPath.listAvds()).rejects.not.toBeInstanceOf(AndroidEmulatorUnavailableError);
    const unspecified = { ...bareMissing, path: undefined };
    const noPath = clientRejecting(
      Object.assign(new Error(unspecified.message), unspecified),
      bareMissing.path,
    );
    await expect(noPath.listAvds()).rejects.toBeInstanceOf(AndroidEmulatorUnavailableError);
  });

  // Node's documented execFile spawn-error shape (not a Bun capture).
  test("missing executable retains the typed unavailable error and existing message", async () => {
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => "amprobe-emulator-not-on-path",
      execAsync: async () => {
        throw Object.assign(new Error("spawn amprobe-emulator-not-on-path ENOENT"), {
          code: "ENOENT",
          path: "amprobe-emulator-not-on-path",
          syscall: "spawn amprobe-emulator-not-on-path",
        });
      },
      timer: new FakeTimer(),
      avdConfigReader: noAvdConfigReader,
    });
    await expect(client.listAvds()).rejects.toBeInstanceOf(AndroidEmulatorUnavailableError);
    await expect(client.listAvds()).rejects.toThrow("Android emulator not found.");
  });

  test.each([
    "Command failed: emulator -list-avds\nNo such file or directory: missing AVD home",
    "spawn /bin/sh ENOENT",
  ])("an installed executable failure stays untyped: %s", async (message) => {
    // This existing on-disk source file stands in for the resolved executable; it is never run.
    const client = new AndroidEmulatorClient({
      emulatorPathLocator: async () => import.meta.path,
      execAsync: async () => {
        throw new Error(message);
      },
      timer: new FakeTimer(),
      avdConfigReader: noAvdConfigReader,
    });
    await expect(client.listAvds()).rejects.not.toBeInstanceOf(AndroidEmulatorUnavailableError);
    await expect(client.listAvds()).rejects.toThrow(
      message.includes("/bin/sh") ? "daemon working directory" : "Android emulator not found.",
    );
  });
});

describe("isMissingExecutableError structured evidence", () => {
  test("installed bare executable with captured deleted-cwd failure stays untyped", () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'ls'"), {
      code: "ENOENT",
      path: "ls",
    });
    expect(isMissingExecutableError(error, "ls", true)).toBe(false);
  });

  test.each([
    "/Users/abortiz/Library/Android/sdk/emulator/emulator",
    "/Users/timeout/Library/Android/sdk/emulator/emulator",
  ])("missing absolute executable ignores message path components: %s", (path) => {
    const error = Object.assign(
      new Error(`ENOENT: no such file or directory, posix_spawn '${path}'`),
      { code: "ENOENT", path },
    );
    expect(isMissingExecutableError(error, path, false)).toBe(true);
  });

  test("missing absolute executable with EMFILE stays untyped", () => {
    const path = "/amprobe-emulator-not-on-path";
    const error = Object.assign(new Error(`spawn ${path} EMFILE`), { code: "EMFILE", path });
    expect(isMissingExecutableError(error, path, false)).toBe(false);
  });

  test.each([
    { label: "Bun missing bare name", path: "amprobe-emulator-not-on-path" },
    { label: "missing absolute path", path: "/amprobe-emulator-not-on-path" },
  ])("$label is typed", ({ path }) => {
    const error = Object.assign(new Error(`Executable not found in $PATH: "${path}"`), {
      code: "ENOENT",
      path,
    });
    expect(isMissingExecutableError(error, path, false)).toBe(true);
  });

  test.each([
    { label: "numeric exit", code: 1 },
    { label: "missing code", code: undefined },
    { label: "numeric-looking string exit", code: "1" },
    { label: "killed", killed: true },
    { label: "signal", signal: "SIGTERM" },
    { label: "abort", name: "AbortError" },
    { label: "timeout", name: "TimeoutError" },
    { label: "timeout code", code: "ETIMEDOUT" },
    { label: "cancellation code", code: "ABORT_ERR" },
    { label: "different executable", path: "another-executable" },
  ])("$label stays untyped even when the absolute executable is absent", (overrides) => {
    const path = "/amprobe-emulator-not-on-path";
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", path }, overrides);
    expect(isMissingExecutableError(error, path, false)).toBe(false);
  });

  test("non-Error values stay untyped", () => {
    expect(isMissingExecutableError({ code: "ENOENT" }, "emulator", false)).toBe(false);
  });

  test("ENOENT with an existing absolute executable or bad shebang stays untyped", () => {
    const path = "/installed-sdk/emulator/emulator";
    const error = Object.assign(new Error(`spawn ${path} ENOENT`), { code: "ENOENT", path });
    expect(isMissingExecutableError(error, path, true)).toBe(false);
  });

  test("ENOENT without a path is typed only when the executable is absent", () => {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect(isMissingExecutableError(error, "amprobe-emulator-not-on-path", false)).toBe(true);
    expect(isMissingExecutableError(error, "amprobe-emulator-not-on-path", true)).toBe(false);
  });
});
