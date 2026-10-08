import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createHostToolchainResourceHandler,
  HOST_TOOLCHAIN_RESOURCE_URI,
  type HostToolchainResourceDependencies,
  registerHostToolchainResources,
} from "../../../src/server/hostToolchainResources";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  createIosDoctorDependencies,
  checkCoreDeviceVersion,
  DOCTOR_EXEC_TIMEOUT_MS,
} from "../../../src/doctor/checks/ios";
import type { CheckResult, DoctorProbeOptions } from "../../../src/doctor/types";

import { createProductionCoreDeviceProbe } from "../../../src/utils/ios-cmdline-tools/CoreDeviceProbeHolder";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";

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
    probeCoreDeviceVersion: async () => ({
      status: "meets-requirement",
      version: "651.13.4",
      simulatorBootState: { status: "available", booted: 1, shutdown: 2, unknown: 0 },
      capabilities: { status: "not probed", entries: [] },
    }),
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
    const entry = payload.entries.find((item: { name: string }) => item.name === "devicectl");
    expect("downgradeGuard" in entry.coreDevice).toBe(false);
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
      devicectl: {
        name: "devicectl",
        available: true,
        version: "651.13.4",
        coreDevice: {
          status: "meets-requirement",
          requiredVersion: "651.0.0",
          simulatorBootState: { status: "available", booted: 1, shutdown: 2, unknown: 0 },
          capabilities: { status: "not probed", entries: [] },
        },
      },
    });
  });

  test("uses detected tool versions instead of dotted install path segments", async () => {
    const payload = await read(
      makeDependencies({
        checkAdbVersion: async () => ({
          ...pass("35.0.1"),
          message: "Version 35.0.1",
        }),
        checkAndroidCommandLineTools: async () => ({
          ...pass("/opt/hostedtoolcache/Android/33.0.0/cmdline-tools/latest/bin"),
          message: "Android command line tools detected (version 12.3).",
        }),
        checkXcodeInstallation: async () => ({
          ...pass("16.1"),
          message: "Xcode 16.1 installed",
        }),
      }),
    );
    const entries = Object.fromEntries(
      payload.entries.map((entry: { name: string }) => [entry.name, entry]),
    );

    expect(entries.sdkmanager.version).toBe("12.3");
    expect(entries.avdmanager.version).toBe("12.3");
    expect(entries.adb.version).toBe("35.0.1");
    expect(entries.xcodebuild.version).toBe("16.1");
  });

  test.each([
    [{ status: "below-required", version: "650.2.0" }, true, "650.2.0"],
    [{ status: "missing", reason: "devicectl missing" }, false, "devicectl missing"],
    [{ status: "unparsable", reason: "unrecognized version" }, false, "unrecognized version"],
    [
      { status: "non-darwin", reason: "iOS development requires macOS" },
      false,
      "iOS development requires macOS",
    ],
  ] as const)("reports CoreDevice diagnostic %s", async (diagnostic, available, detail) => {
    const payload = await read(
      makeDependencies({ probeCoreDeviceVersion: async () => diagnostic }),
    );
    const entry = payload.entries.find((item: { name: string }) => item.name === "devicectl");
    expect(entry.available).toBe(available);
    expect(entry.coreDevice.status).toBe(diagnostic.status);
    expect(entry.coreDevice.simulatorBootState).toEqual({
      status: "unavailable",
      reason: "simulator state unavailable",
    });
    expect(entry.coreDevice.capabilities).toEqual({ status: "not probed", entries: [] });
    expect("downgradeGuard" in entry.coreDevice).toBe(false);
    expect(entry.version ?? entry.error).toBe(detail);
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
  test.each([
    ["meets", "651.13.4", "darwin", true, "meets-requirement", "651.13.4", undefined],
    ["below", "650.2.0", "darwin", true, "below-required", "650.2.0", undefined],
    [
      "missing",
      undefined,
      "darwin",
      false,
      "missing",
      undefined,
      "devicectl not functional: command not found",
    ],
    [
      "unparsable",
      "unexpected output",
      "darwin",
      false,
      "unparsable",
      undefined,
      "devicectl returned an unrecognized CoreDevice version",
    ],
    [
      "non-darwin",
      "651.13.4",
      "linux",
      false,
      "non-darwin",
      undefined,
      "iOS development requires macOS",
    ],
  ] as const)(
    "fresh resource preserves the exact HEAD version fields for %s",
    async (_outcome, output, platform, available, status, version, error) => {
      const executor = new FakeHostCommandExecutor();
      const timer = new FakeTimer();
      const stdout =
        output === "651.13.4"
          ? readFileSync(join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"), "utf8")
          : (output ?? "");
      const capabilityProbe = createProductionCoreDeviceProbe({
        executor,
        timer,
        simctl: {
          getDeviceInfo: async () => null,
          listSimulatorImages: async () => [],
        },
      });
      const calls: string[] = [];
      const ios = {
        ...createIosDoctorDependencies({ coreDeviceProbe: capabilityProbe }),
        platform: () => platform,
        execFile: async (
          file: string,
          args: string[],
          options?: { timeoutMs?: number; signal?: AbortSignal },
        ) => {
          calls.push([file, ...args].join(" "));
          expect(options?.timeoutMs).toBe(DOCTOR_EXEC_TIMEOUT_MS);
          expect(options?.signal).toBeDefined();
          if (output === undefined) {
            throw new Error("command not found");
          }
          return {
            stdout,
            stderr: "",
            toString: () => stdout,
            trim: () => stdout.trim(),
            includes: (value: string) => stdout.includes(value),
          };
        },
      };
      const { probeCoreDeviceVersion: _readVersion, ...otherChecks } = makeDependencies({ timer });
      // Omit the fake version reader so the default handler exercises the injected iOS dependencies.
      void _readVersion;
      const payload = JSON.parse(
        (await createHostToolchainResourceHandler({ ...otherChecks, iosDependencies: ios })())
          .text!,
      );
      const entry = payload.entries.find((item: { name: string }) => item.name === "devicectl");
      const { simulatorBootState: boot, capabilities, ...coreDevice } = entry.coreDevice;
      expect(boot.status).toBe(platform === "darwin" ? "available" : "unavailable");
      expect(capabilities).toEqual({ status: "not probed", entries: [] });
      expect({ ...entry, coreDevice }).toEqual({
        name: "devicectl",
        available,
        ...(version ? { version } : { error }),
        coreDevice: { status, requiredVersion: "651.0.0" },
      });
      expect(calls).toEqual(platform === "darwin" ? ["xcrun devicectl --version"] : []);
      expect(executor.getExecutedCommands()).toEqual([]);
    },
  );

  test("fresh resource preserves HEAD version fields, reads only --version, and seeds later capabilities", async () => {
    const executor = new FakeHostCommandExecutor();
    const timer = new FakeTimer();
    const stdout = readFileSync(
      join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"),
      "utf8",
    );
    executor.setCommandResponse("xcrun devicectl --version", {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value) => stdout.includes(value),
    });
    const capabilityProbe = createProductionCoreDeviceProbe({
      executor,
      timer,
      files: {
        tmpdir: () => "/fake",
        mkdtemp: async () => "/fake/probe",
        readFile: async () =>
          readFileSync(
            join(process.cwd(), "test/fixtures/ios-devicectl/info-displays-booted-simulator.json"),
            "utf8",
          ),
        rm: async () => undefined,
      },
      simctl: {
        getDeviceInfo: async () => null,
        listSimulatorImages: async () => [
          { name: "one", platform: "ios", deviceId: "one", state: "Booted" },
          { name: "two", platform: "ios", deviceId: "two", state: "Shutdown" },
        ],
      },
    });
    const ios = {
      ...createIosDoctorDependencies({ coreDeviceProbe: capabilityProbe }),
      platform: () => "darwin" as const,
      execFile: (
        file: string,
        args: string[],
        options?: { timeoutMs?: number; signal?: AbortSignal },
      ) => executor.executeCommand(file, args, options),
    };
    const { probeCoreDeviceVersion: _readVersion, ...otherChecks } = makeDependencies({ timer });
    // Omit the fake version reader so the default handler exercises the injected iOS dependencies.
    void _readVersion;
    const handler = createHostToolchainResourceHandler({ ...otherChecks, iosDependencies: ios });
    expect(ios.getCoreDeviceProbe()).toBe(capabilityProbe);
    expect(executor.getExecutedCommands()).toEqual([]);
    const payload = JSON.parse((await handler()).text!);
    const entry = payload.entries.find((item: { name: string }) => item.name === "devicectl");
    expect(entry.coreDevice).toMatchObject({
      status: "meets-requirement",
      requiredVersion: "651.0.0",
      simulatorBootState: { status: "available", booted: 1, shutdown: 1, unknown: 0 },
      capabilities: { status: "not probed", entries: [] },
    });
    expect("downgradeGuard" in entry.coreDevice).toBe(false);
    expect(entry.available).toBe(true);
    expect(entry.version).toBe("651.13.4");
    expect(entry.error).toBeUndefined();
    expect(executor.getExecutedCommands()).toEqual(["xcrun devicectl --version"]);
    const doctorResult = await checkCoreDeviceVersion(ios);
    expect(doctorResult).toMatchObject({
      status: "pass",
      value: "651.13.4",
      message: expect.stringContaining(
        "CoreDevice 651.13.4 installed (requires CoreDevice >= 651.0.0); ",
      ),
    });
    expect(ios.getCoreDeviceProbe()).toBe(capabilityProbe);
    expect(
      await capabilityProbe.checkSimulatorCommand("one", "info displays", [651, 0, 0]),
    ).toMatchObject({ kind: "supported" });
    expect(
      executor.getExecutedCommands().filter((call) => call.includes("--version")),
    ).toHaveLength(2);
    await handler();
    expect(
      executor.getExecutedCommands().filter((call) => call.includes("--version")),
    ).toHaveLength(3);
  });
});
