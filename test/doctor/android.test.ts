import { describe, expect, test, beforeEach } from "bun:test";
import type { AndroidDoctorDependencies } from "../../src/doctor/checks/android";
import {
  checkAndroidCommandLineTools,
  checkJavaHome,
  checkAdbInstallation,
  checkAdbVersion,
  checkConnectedDevices,
  checkAvdMemory,
  checkEmulator,
  runPostRepairAndroidChecks,
} from "../../src/doctor/checks/android";
import type { DoctorProbeOptions } from "../../src/doctor/types";
import { tmpdir } from "node:os";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../src/models";
import { createDoctorDeadline } from "../../src/doctor/deadline";
import { FakeTimer } from "../fakes/FakeTimer";
import { runDoctor } from "../../src/doctor";

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
    close: () => {},
  },
};

describe("Android doctor command line tools check", () => {
  test("warns when Homebrew tools are used and system images are in ANDROID_HOME", async () => {
    const homebrewLocation = {
      path: "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest",
      source: "homebrew" as const,
      available_tools: ["avdmanager", "sdkmanager"],
    };

    const result = await checkAndroidCommandLineTools(
      {},
      {
        ...baseDependencies,
        detectAndroidCommandLineTools: async () => [homebrewLocation],
        getBestAndroidToolsLocation: () => homebrewLocation,
        getAndroidHomeWithSystemImages: () => ({
          androidHome: "/Users/test/Library/Android/sdk",
          systemImagesPath: "/Users/test/Library/Android/sdk/system-images",
        }),
      },
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Homebrew cmdline-tools detected");
  });

  test("passes when tools are detected via ANDROID_SDK_ROOT", async () => {
    const sdkRootLocation = {
      path: "/Users/test/Library/Android/sdk/cmdline-tools/latest",
      source: "android_sdk_root" as const,
      available_tools: ["avdmanager", "sdkmanager"],
    };

    const result = await checkAndroidCommandLineTools(
      {},
      {
        ...baseDependencies,
        detectAndroidCommandLineTools: async () => [sdkRootLocation],
        getBestAndroidToolsLocation: () => sdkRootLocation,
      },
    );

    expect(result.status).toBe("pass");
    expect(result.message).toContain("detected");
  });

  test("warns when cmdline-tools is below the supported SDK XML version", async () => {
    const location = {
      path: "/Users/test/Library/Android/sdk/cmdline-tools/latest",
      source: "android_sdk_root" as const,
      available_tools: ["avdmanager", "sdkmanager"],
    };
    const result = await checkAndroidCommandLineTools(
      {},
      {
        ...baseDependencies,
        detectAndroidCommandLineTools: async () => [location],
        getBestAndroidToolsLocation: () => location,
        getCmdlineToolsVersion: async () => "8.0",
      },
    );

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
    const result = await checkAndroidCommandLineTools(
      {},
      {
        ...baseDependencies,
        detectAndroidCommandLineTools: async () => [location],
        getBestAndroidToolsLocation: () => location,
        getCmdlineToolsVersion: async () => "13.0",
      },
    );

    expect(result.status).toBe("pass");
    expect(result.message).toContain("13.0");
    expect(result.value).toBe(location.path);
  });
});

describe("post-repair Android doctor checks", () => {
  test("remain device-neutral and never enumerate AVDs", async () => {
    let listAvdsCalls = 0;
    const adbFactory = {
      create: () => ({
        getAdbPathOnly: async () => "/test/android-sdk/platform-tools/adb",
        executeCommand: async () => ({
          stdout: "Android Debug Bridge version 35.0.0",
          stderr: "",
          exitCode: 0,
        }),
      }),
    } as unknown as AdbClientFactory;

    const results = await runPostRepairAndroidChecks(
      {},
      {
        ...baseDependencies,
        adbFactory,
        listAvds: async () => {
          listAvdsCalls++;
          throw new Error("post-repair verification must not enumerate AVDs");
        },
      },
    );

    expect(listAvdsCalls).toBe(0);
    expect(results.map((result) => result.name)).toEqual([
      "Android Command Line Tools",
      "JAVA_HOME",
      "ADB Installation",
      "ADB Version",
    ]);
  });

  test("aborts a stalled host-tool probe at the shared repair deadline", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50 }, timer);
    const location = {
      path: "/test/android-sdk/cmdline-tools/latest",
      source: "android_sdk_root" as const,
      available_tools: ["sdkmanager"],
    };
    let cancellationObserved = false;
    let adbFactoryCalls = 0;
    const checks = runPostRepairAndroidChecks(
      { ...deadline.probe },
      {
        ...baseDependencies,
        detectAndroidCommandLineTools: async () => [location],
        getBestAndroidToolsLocation: () => location,
        getCmdlineToolsVersion: async (_location, probe) => {
          await new Promise<void>((resolve) => {
            probe?.signal?.addEventListener(
              "abort",
              () => {
                cancellationObserved = true;
                resolve();
              },
              { once: true },
            );
          });
          return null;
        },
        adbFactory: {
          create: () => {
            adbFactoryCalls++;
            throw new Error("post-deadline Android probes must not start");
          },
        } as unknown as AdbClientFactory,
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(50);

    await expect(checks).rejects.toThrow("Doctor diagnostic deadline elapsed");
    expect(cancellationObserved).toBe(true);
    expect(adbFactoryCalls).toBe(0);
    deadline.dispose();
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
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
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
        getAdbPathOnly: async () => {
          throw new Error("adb not found in PATH");
        },
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
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
        getAdbPathOnly: async () => {
          throw "string error";
        },
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
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
        executeCommand: async () => {
          throw "raw string error";
        },
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

describe("Android doctor cancellation", () => {
  test("bounds never-settling command-line-tool discovery", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    const discoveryStarted = Promise.withResolvers<void>();
    const check = checkAndroidCommandLineTools(deadline.probe, {
      ...baseDependencies,
      detectAndroidCommandLineTools: async () => {
        discoveryStarted.resolve();
        return await new Promise<never>(() => {});
      },
    });

    await discoveryStarted.promise;
    timer.advanceTime(50);
    const result = await check;
    deadline.dispose();

    expect(deadline.probe.signal?.aborted).toBe(true);
    expect(result.status).toBe("warn");
    expect(result.message).toBe("Failed to detect Android command line tools.");
  });

  test("aborts delayed emulator subprocess I/O without publishing a late pass", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    let observedSignal: AbortSignal | undefined;
    let observedTimeoutMs: number | undefined;
    let lateSuccess = false;
    let settled = false;
    const check = checkEmulator(deadline.probe, {
      listAvds: async (probe) => {
        observedSignal = probe?.signal;
        observedTimeoutMs = probe?.timeoutMs;
        await new Promise<void>((resolve) => {
          probe?.signal?.addEventListener("abort", resolve, { once: true });
        });
        try {
          probe?.signal?.throwIfAborted();
          lateSuccess = true;
          return [];
        } finally {
          settled = true;
        }
      },
    });

    timer.advanceTime(50);
    const result = await check;
    deadline.dispose();

    expect(observedSignal?.aborted).toBe(true);
    expect(observedTimeoutMs).toBe(50);
    expect(settled).toBe(true);
    expect(lateSuccess).toBe(false);
    expect(result.status).toBe("warn");
  });
});

describe("doctor probe cancellation seam (#7008)", () => {
  const androidHome = tmpdir();
  const cmdlineToolsDependencies = (
    versionCalls: Array<DoctorProbeOptions | undefined>,
  ): AndroidDoctorDependencies => ({
    ...baseDependencies,
    detectAndroidCommandLineTools: async () => [
      {
        path: `${androidHome}/cmdline-tools/latest`,
        source: "android_home" as const,
        available_tools: ["sdkmanager"],
      },
    ],
    getBestAndroidToolsLocation: (locations) => locations[0] ?? null,
    getCmdlineToolsVersion: async (_location, probe) => {
      versionCalls.push(probe);
      return "13.0";
    },
  });

  test("checkEmulator forwards the signal and deadline to listAvds", async () => {
    const controller = new AbortController();
    const calls: Array<DoctorProbeOptions | undefined> = [];
    const result = await checkEmulator(
      { signal: controller.signal, timeoutMs: 1234 },
      {
        listAvds: async (probe) => {
          calls.push(probe);
          return [];
        },
      },
    );

    expect(result.status).toBe("pass");
    expect(calls).toEqual([{ signal: controller.signal, timeoutMs: 1234 }]);
  });

  test("checkEmulator passes no signal or deadline when the caller supplies none", async () => {
    const calls: Array<DoctorProbeOptions | undefined> = [];
    await checkEmulator(undefined, {
      listAvds: async (probe) => {
        calls.push(probe);
        return [];
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBeUndefined();
    expect(calls[0]?.timeoutMs).toBeUndefined();
  });

  test("checkAdbVersion forwards the signal and deadline to the adb command", async () => {
    const controller = new AbortController();
    const fakeExecutor = new FakeAdbExecutor();
    fakeExecutor.setCommandResponse("--version", {
      stdout: "Android Debug Bridge version 35.0.0",
      stderr: "",
      toString: () => "",
      trim: () => "",
      includes: () => false,
    });
    const fakeFactory = new FakeAdbClientFactory(fakeExecutor as any);

    await checkAdbVersion(fakeFactory, { signal: controller.signal, timeoutMs: 1234 });

    expect(fakeExecutor.getCommandCalls()).toEqual([
      {
        command: "--version",
        timeoutMs: 1234,
        maxBuffer: undefined,
        noRetry: true,
        signal: controller.signal,
      },
    ]);
  });

  test("checkAdbVersion runs the adb command without a signal or deadline by default", async () => {
    const fakeExecutor = new FakeAdbExecutor();
    const fakeFactory = new FakeAdbClientFactory(fakeExecutor as any);

    await checkAdbVersion(fakeFactory);

    const [call] = fakeExecutor.getCommandCalls();
    expect(call?.timeoutMs).toBeUndefined();
    expect(call?.signal).toBeUndefined();
  });

  test("checkAdbInstallation forwards the signal and deadline to adb path discovery", async () => {
    const controller = new AbortController();
    const calls: Array<DoctorProbeOptions | undefined> = [];
    const fakeFactory: AdbClientFactory = {
      create: () =>
        ({
          getAdbPathOnly: async (probe?: DoctorProbeOptions) => {
            calls.push(probe);
            return "/usr/local/bin/adb";
          },
        }) as any,
    };

    await checkAdbInstallation(fakeFactory, { signal: controller.signal, timeoutMs: 1234 });
    await checkAdbInstallation(fakeFactory);

    expect(calls).toEqual([{ signal: controller.signal, timeoutMs: 1234 }, {}]);
  });

  test("checkAndroidCommandLineTools forwards the signal and deadline to the version probe", async () => {
    const controller = new AbortController();
    const calls: Array<DoctorProbeOptions | undefined> = [];

    await checkAndroidCommandLineTools(
      { signal: controller.signal, timeoutMs: 1234 },
      cmdlineToolsDependencies(calls),
    );
    await checkAndroidCommandLineTools(undefined, cmdlineToolsDependencies(calls));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ signal: controller.signal, timeoutMs: 1234 });
    expect(calls[1]?.signal).toBeUndefined();
    expect(calls[1]?.timeoutMs).toBeUndefined();
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
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
        getBootedAndroidDevices: async () => {
          throw new Error("adb server not running");
        },
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
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
        getBootedAndroidDevices: async () => {
          throw "unexpected failure";
        },
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
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
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
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
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
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
        getBootedAndroidDevices: async () => [
          { name: "Pixel", platform: "android", deviceId: "emulator-5556" },
        ],
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
        getDeviceStates: async () => {
          throw new Error("adb state probe unavailable");
        },
        executeCommand: async () => ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }),
        getBootedAndroidDevices: async () => [
          { name: "Pixel", platform: "android", deviceId: "emulator-5556" },
        ],
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
      readAvdConfig: {
        readConfig: async () => ({ apiLevel: 36, tag: "google_apis_playstore", ramSizeMb: 1024 }),
      },
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Tiny");
    expect(result.message).toContain("2048 MB");
  });

  test("does not warn for low-memory non-Play or legacy AVDs", async () => {
    const result = await checkAvdMemory({
      listAvds: async () => [{ name: "Legacy" }, { name: "Wear" }],
      readAvdConfig: {
        readConfig: async (name) =>
          name === "Legacy"
            ? { apiLevel: 28, tag: "google_apis", ramSizeMb: 1024 }
            : { apiLevel: 35, tag: "android-wear", ramSizeMb: 1024 },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.message).toBe(
      "All applicable modern Play-image AVDs meet the 2048 MB memory minimum.",
    );
  });

  test("does not warn when a non-applicable AVD omits RAM", async () => {
    const result = await checkAvdMemory({
      listAvds: async () => [{ name: "Legacy" }],
      readAvdConfig: { readConfig: async () => ({ apiLevel: 28, tag: "google_apis" }) },
    });

    expect(result.status).toBe("pass");
    expect(result.message).toContain("applicable modern Play-image");
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
      readAvdConfig: {
        readConfig: async (name) => (name === "Verified" ? { ramSizeMb: 4096 } : null),
      },
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Missing");
    expect(result.message).not.toContain("All AVDs meet");
  });

  test("skips when AVDs cannot be listed", async () => {
    const result = await checkAvdMemory({
      listAvds: async () => {
        throw new Error("emulator unavailable");
      },
      readAvdConfig: { readConfig: async () => null },
    });

    expect(result.status).toBe("skip");
    expect(result.message).toContain("emulator unavailable");
  });

  test("bounds a never-settling AVD config read at the runDoctor deadline", async () => {
    const timer = new FakeTimer();
    let markReadStarted: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let rejection: unknown;
    const doctor = runDoctor(
      { android: true, timeoutMs: 50 },
      {
        timer,
        runSystemChecks: () => [],
        runAndroidChecks: async (options) => [
          await checkAvdMemory(
            {
              listAvds: async () => [{ name: "NetworkAvd" }],
              readAvdConfig: {
                readConfig: () => {
                  markReadStarted();
                  return new Promise<never>(() => {});
                },
              },
            },
            options,
          ),
        ],
        runIosChecks: async () => [],
        runAutoMobileChecks: async () => [],
      },
    );
    void doctor.catch((error: unknown) => {
      rejection = error;
    });

    await readStarted;
    timer.advanceTime(50);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Doctor diagnostic deadline elapsed");
  });

  test("bounds a never-settling AVD config read on runDoctor caller abort", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    let markReadStarted: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let rejection: unknown;
    const doctor = runDoctor(
      { android: true, signal: controller.signal },
      {
        timer,
        runSystemChecks: () => [],
        runAndroidChecks: async (options) => [
          await checkAvdMemory(
            {
              listAvds: async () => [{ name: "NetworkAvd" }],
              readAvdConfig: {
                readConfig: () => {
                  markReadStarted();
                  return new Promise<never>(() => {});
                },
              },
            },
            options,
          ),
        ],
        runIosChecks: async () => [],
        runAutoMobileChecks: async () => [],
      },
    );
    void doctor.catch((error: unknown) => {
      rejection = error;
    });

    await readStarted;
    controller.abort(new Error("Doctor caller cancelled"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Doctor caller cancelled");
  });

  test("preserves successful AVD config reads through runDoctor", async () => {
    const report = await runDoctor(
      { android: true },
      {
        timer: new FakeTimer(),
        runSystemChecks: () => [],
        runAndroidChecks: async (options) => [
          await checkAvdMemory(
            {
              listAvds: async () => [{ name: "HealthyAvd" }],
              readAvdConfig: {
                readConfig: async () => ({
                  apiLevel: 36,
                  tag: "google_apis_playstore",
                  ramSizeMb: 4096,
                }),
              },
            },
            options,
          ),
        ],
        runIosChecks: async () => [],
        runAutoMobileChecks: async () => [],
      },
    );

    expect(report.android?.checks).toEqual([
      {
        name: "AVD Memory",
        status: "pass",
        message: "All applicable modern Play-image AVDs meet the 2048 MB memory minimum.",
      },
    ]);
  });
});
