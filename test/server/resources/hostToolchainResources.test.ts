import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createHostToolchainResourceHandler,
  HOST_TOOLCHAIN_RESOURCE_URI,
  type HostToolchainResourceDependencies,
  registerHostToolchainResources,
} from "../../../src/server/hostToolchainResources";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DOCTOR_EXEC_TIMEOUT_MS } from "../../../src/doctor/checks/ios";
import type { CheckResult, DoctorProbeOptions } from "../../../src/doctor/types";

const pass = (value?: string): CheckResult => ({
  name: "test",
  status: "pass",
  message: "ok",
  value,
});

function makeDependencies(
  overrides: Partial<HostToolchainResourceDependencies> = {},
): HostToolchainResourceDependencies {
  return {
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    checkAdbInstallation: async () => pass("/opt/android/platform-tools/adb"),
    checkAdbVersion: async () => pass("v35.0.1"),
    checkEmulator: async () => pass("/opt/android/emulator/emulator"),
    checkAndroidCommandLineTools: async () => ({
      ...pass("/opt/android/cmdline-tools/latest"),
      message: "Android command line tools detected (version v12.3).",
    }),
    checkXcodeInstallation: async () => pass("v16.1"),
    checkXcodeCommandLineTools: async () => pass("/Applications/Xcode.app/Contents/Developer"),
    checkXcrunAvailable: async () => pass(),
    checkSimctlAvailable: async () => pass(),
    checkDevicectlAvailable: async () => pass(),
    ...overrides,
  };
}

async function read(dependencies: HostToolchainResourceDependencies) {
  const content = await createHostToolchainResourceHandler(dependencies)();
  return JSON.parse(content.text!);
}

describe("host toolchain resource", () => {
  beforeEach(() => ResourceRegistry.clearResources());
  afterEach(() => ResourceRegistry.clearResources());

  test("reports every probed tool from injected doctor checks", async () => {
    const payload = await read(makeDependencies());

    expect(payload.lastUpdated).toBe("2026-09-14T12:00:00.000Z");
    expect(payload.entries).toHaveLength(9);
    expect(
      Object.fromEntries(payload.entries.map((entry: { name: string }) => [entry.name, entry])),
    ).toMatchObject({
      adb: {
        name: "adb",
        available: true,
        version: "35.0.1",
        location: "/opt/android/platform-tools/adb",
      },
      emulator: { name: "emulator", available: true, location: "/opt/android/emulator/emulator" },
      sdkmanager: {
        name: "sdkmanager",
        available: true,
        version: "12.3",
        location: "/opt/android/cmdline-tools/latest",
      },
      avdmanager: {
        name: "avdmanager",
        available: true,
        version: "12.3",
        location: "/opt/android/cmdline-tools/latest",
      },
      xcodebuild: { name: "xcodebuild", available: true, version: "16.1" },
      "xcode-select": {
        name: "xcode-select",
        available: true,
        location: "/Applications/Xcode.app/Contents/Developer",
      },
      xcrun: { name: "xcrun", available: true },
      simctl: { name: "simctl", available: true },
      devicectl: { name: "devicectl", available: true },
    });
  });

  test("converts one rejected probe into an entry failure without rejecting the read", async () => {
    const payload = await read(
      makeDependencies({
        checkSimctlAvailable: async () => Promise.reject(new Error("simctl missing")),
      }),
    );
    const entries = Object.fromEntries(
      payload.entries.map((entry: { name: string }) => [entry.name, entry]),
    );

    expect(entries.simctl).toMatchObject({ available: false, error: "simctl missing" });
    expect(entries.adb).toMatchObject({ available: true });
    expect(entries.xcrun).toMatchObject({ available: true });
  });

  test("times out one hanging probe using the injected fake timer", async () => {
    const timer = new FakeTimer();
    const pending = read(
      makeDependencies({
        timer,
        checkEmulator: async () => new Promise<CheckResult>(() => {}),
      }),
    );
    await Promise.resolve();
    timer.advanceTime(DOCTOR_EXEC_TIMEOUT_MS + 1);
    const payload = await pending;
    const emulator = payload.entries.find((entry: { name: string }) => entry.name === "emulator");

    expect(emulator).toMatchObject({ available: false });
    expect(emulator.error).toContain("timed out");
  });

  test("aborts the losing probe when the timeout wins so its child processes are killed", async () => {
    const timer = new FakeTimer();
    let received: DoctorProbeOptions | undefined;
    const pending = read(
      makeDependencies({
        timer,
        checkEmulator: async (probe) => {
          received = probe;
          return new Promise<CheckResult>(() => {});
        },
      }),
    );
    await Promise.resolve();
    expect(received?.timeoutMs).toBe(DOCTOR_EXEC_TIMEOUT_MS);
    expect(received?.signal?.aborted).toBe(false);

    timer.advanceTime(DOCTOR_EXEC_TIMEOUT_MS + 1);
    const payload = await pending;
    const emulator = payload.entries.find((entry: { name: string }) => entry.name === "emulator");

    expect(emulator).toMatchObject({ available: false });
    expect(emulator.error).toContain("timed out");
    expect(received?.signal?.aborted).toBe(true);
  });

  test("leaves a probe that settles in time un-aborted", async () => {
    const signals: AbortSignal[] = [];
    await read(
      makeDependencies({
        checkAdbInstallation: async (probe) => {
          signals.push(probe.signal!);
          return pass("/opt/android/platform-tools/adb");
        },
      }),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
  });

  test("retains Windows drive-letter tool locations", async () => {
    const payload = await read(
      makeDependencies({
        checkAdbInstallation: async () => pass("C:\\Android\\platform-tools\\adb.exe"),
        checkAndroidCommandLineTools: async () => ({
          ...pass("D:\\sdk\\cmdline-tools\\latest"),
          message: "Android command line tools detected (version v12.3).",
        }),
      }),
    );
    const entries = Object.fromEntries(
      payload.entries.map((entry: { name: string }) => [entry.name, entry]),
    );

    expect(entries.adb).toMatchObject({
      available: true,
      location: "C:\\Android\\platform-tools\\adb.exe",
    });
    expect(entries.sdkmanager).toMatchObject({ location: "D:\\sdk\\cmdline-tools\\latest" });
  });

  test("omits a location that is only a bare command name", async () => {
    const payload = await read(makeDependencies({ checkAdbInstallation: async () => pass("adb") }));
    const adb = payload.entries.find((entry: { name: string }) => entry.name === "adb");

    expect(adb).toMatchObject({ available: true });
    expect(adb.location).toBeUndefined();
  });

  test("registers a static resource", () => {
    registerHostToolchainResources();
    expect(ResourceRegistry.getResource(HOST_TOOLCHAIN_RESOURCE_URI)).toBeDefined();
  });
});
