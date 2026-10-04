import * as childProcess from "node:child_process";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeWebSocket, createInstantFailureWebSocketFactory } from "../fakes/FakeWebSocket";
import { ObserveElementsBuilder } from "../../src/features/observe/ObserveElementsBuilder";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IosDoctorDependencies } from "../../src/doctor/checks/ios";
import { IOS_RUNNER_COMMAND_APPLICABILITY } from "../../src/features/observe/ios/iosRunnerFeatureCommands";
import {
  checkAppleDeveloperAccount,
  checkBootedSimulators,
  checkCodeSigning,
  checkCoreDeviceVersion,
  checkIosCtrlProxyRunner,
  checkIosObserveRoundTrip,
  checkProvisioningProfiles,
  checkSecurityCli,
  checkSimctlAvailable,
  checkSimulatorRuntimes,
  checkXcodeCommandLineTools,
  checkXcodeInstallation,
  checkXcrunAvailable,
  createIosObserveRoundTripInspector,
  createIosCtrlProxyRunnerInspector,
  IOS_RUNNER_FEATURE_COMMANDS,
  IOS_RUNNER_FEATURE_FLAGS,
  runIosChecks,
  runPostRepairIosChecks,
} from "../../src/doctor/checks/ios";
import type {
  IosObserveRoundTripInspection,
  IosObserveRoundTripInspectorHooks,
  IosRunnerInspection,
  IosRunnerInspectorHooks,
} from "../../src/doctor/checks/ios";
import type { ExecResult } from "../../src/models";
import type { SecurityClient } from "../../src/utils/ios-cmdline-tools/SecurityClient";
import { FakeLogger } from "../fakes/FakeLogger";
import { createDoctorDeadline, DoctorDeadlineError } from "../../src/doctor/deadline";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeTimer } from "../fakes/FakeTimer";

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString() {
    return this.stdout;
  },
  trim() {
    return this.stdout.trim();
  },
  includes(searchString: string) {
    return this.stdout.includes(searchString);
  },
});

const capturedCoreDeviceVersion = readFileSync(
  join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"),
  "utf8",
);

const coreDeviceState = {
  recordVersion: () => {},
  refreshVersion: async (
    read: () => Promise<
      import("../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe").CoreDeviceVersionMeasurement
    >,
  ) => read(),
  getCachedVersion: () => ({
    kind: "available" as const,
    version: [651, 13, 4] as [number, number, number],
  }),
  getCapabilities: () => ({ status: "not probed" as const, entries: [] }),
  readSimulatorBootState: async () => ({
    status: "available" as const,
    booted: 1,
    shutdown: 2,
    unknown: 1,
  }),
};

const baseDependencies: IosDoctorDependencies = {
  platform: () => "darwin",
  getCoreDeviceProbe: () => coreDeviceState,
  execFile: async () => createExecResult(""),
  xcodebuild: {
    executeCommand: async () => createExecResult(""),
  },
  fileExists: () => true,
  readDir: async () => [],
  homedir: () => "/Users/test",
  securityClient: {
    getDiagnostics: async () => ({ available: true, version: null }),
    listCodeSigningIdentities: async () => [],
  } as SecurityClient,
  logger: new FakeLogger(),
  createSimctlClient: () => ({
    setDevice: () => {},
    executeCommand: async () => createExecResult(""),
    isAvailable: async () => true,
    isSimulatorRunning: async () => false,
    startSimulator: async () => ({}) as any,
    killSimulator: async () => {},
    waitForSimulatorReady: async () => ({ name: "sim", platform: "ios", deviceId: "123" }),
    listSimulatorImages: async () => [],
    getBootedSimulators: async () => [],
    getBootedSimulatorsChecked: async () => [],
    getDeviceInfo: async () => null,
    bootSimulator: async () => ({ name: "sim", platform: "ios", deviceId: "123" }),
    getDeviceTypes: async () => [],
    getRuntimes: async () => [],
    getRuntimesChecked: async () => [],
    createSimulator: async () => "123",
    deleteSimulator: async () => {},
    listApps: async () => [],
    launchApp: async () => ({ success: true }),
    terminateApp: async () => {},
    getScreenSize: async () => ({ width: 100, height: 100 }),
    setAppearance: async () => {},
  }),
  runnerInspector: {
    inspectBootedRunners: async () => [],
  },
  observeRoundTripInspector: {
    inspectBootedObserveRoundTrips: async () => [],
  },
};

describe("iOS doctor checks", () => {
  describe("checkCoreDeviceVersion", () => {
    test("reports the captured installed version and requirement", async () => {
      const calls: Array<{ file: string; args: string[] }> = [];
      const result = await checkCoreDeviceVersion({
        ...baseDependencies,
        execFile: async (file, args) => {
          calls.push({ file, args });
          return createExecResult(capturedCoreDeviceVersion);
        },
      });
      expect(result).toMatchObject({ name: "CoreDevice", status: "pass", value: "651.13.4" });
      expect(result.message).toContain("requires CoreDevice >= 651.0.0");
      expect(result.message).toStartWith(
        "CoreDevice 651.13.4 installed (requires CoreDevice >= 651.0.0); ",
      );
      expect(result.message).not.toContain("downgrade");
      expect(result.message).toContain(
        "simulator boot state: 1 booted, 2 shutdown, 1 unknown; capabilities: not probed",
      );
      expect(result.detail).toBe(
        "simulator boot state: 1 booted, 2 shutdown, 1 unknown; capabilities: not probed",
      );
      expect(calls).toEqual([{ file: "xcrun", args: ["devicectl", "--version"] }]);
    });

    test.each([
      [
        "meets",
        capturedCoreDeviceVersion,
        "darwin",
        "pass",
        "651.13.4",
        "CoreDevice 651.13.4 installed (requires CoreDevice >= 651.0.0); ",
      ],
      [
        "below",
        "650.2.0",
        "darwin",
        "warn",
        "650.2.0",
        "CoreDevice 650.2.0 installed (below required); requires CoreDevice >= 651.0.0; devicectl-only simulator features will be unavailable; simctl-based features are unaffected; ",
      ],
      [
        "missing",
        undefined,
        "darwin",
        "warn",
        undefined,
        "devicectl missing: devicectl not functional: command not found; devicectl-only simulator features will be unavailable; simctl-based features are unaffected; ",
      ],
      [
        "unparsable",
        "unexpected output",
        "darwin",
        "warn",
        undefined,
        "CoreDevice version unreadable: devicectl returned an unrecognized CoreDevice version; devicectl-only simulator features will be unavailable; simctl-based features are unaffected; ",
      ],
      [
        "non-darwin",
        capturedCoreDeviceVersion,
        "linux",
        "skip",
        undefined,
        "iOS development requires macOS; ",
      ],
    ] as const)(
      "preserves the exact HEAD doctor version portion for %s",
      async (_outcome, output, platform, status, value, prefix) => {
        const calls: Array<{
          file: string;
          args: string[];
          timeoutMs?: number;
          signal?: AbortSignal;
        }> = [];
        const controller = new AbortController();
        const result = await checkCoreDeviceVersion(
          {
            ...baseDependencies,
            platform: () => platform,
            logger: new FakeLogger(),
            execFile: async (file, args, options) => {
              calls.push({ file, args, ...options });
              if (output === undefined) {
                throw new Error("command not found");
              }
              return createExecResult(output);
            },
          },
          { timeoutMs: 123, signal: controller.signal },
        );
        const suffix =
          platform === "darwin"
            ? "simulator boot state: 1 booted, 2 shutdown, 1 unknown; capabilities: not probed"
            : "simulator boot state: unavailable (simulator state unavailable); capabilities: not probed";
        expect(result).toEqual({
          name: "CoreDevice",
          status,
          message: prefix + suffix,
          detail: suffix,
          ...(value ? { value } : {}),
        });
        expect(calls).toEqual(
          platform === "darwin"
            ? [
                {
                  file: "xcrun",
                  args: ["devicectl", "--version"],
                  timeoutMs: 123,
                  signal: controller.signal,
                },
              ]
            : [],
        );
      },
    );

    test("a boot summary failure preserves the HEAD version result", async () => {
      const logger = new FakeLogger();
      const result = await checkCoreDeviceVersion({
        ...baseDependencies,
        logger,
        execFile: async () => createExecResult(capturedCoreDeviceVersion),
        getCoreDeviceProbe: () => ({
          ...coreDeviceState,
          readSimulatorBootState: async () => {
            throw new Error("state read failed");
          },
        }),
      });
      expect(result).toMatchObject({
        status: "pass",
        value: "651.13.4",
        message: expect.stringContaining(
          "CoreDevice 651.13.4 installed (requires CoreDevice >= 651.0.0); simulator boot state: unavailable (state read failed);",
        ),
      });
      expect(logger.at("warn")).toHaveLength(1);
    });

    test("reports memoized feature IDs and supported commands", async () => {
      const result = await checkCoreDeviceVersion({
        ...baseDependencies,
        execFile: async () => createExecResult(capturedCoreDeviceVersion),
        getCoreDeviceProbe: () => ({
          ...coreDeviceState,
          getCapabilities: () => ({
            status: "probed",
            entries: [
              {
                scope: "nonDuo",
                command: "info lockState",
                featureId: "com.apple.coredevice.feature.getlockstate",
                status: "unsupported",
              },
              { scope: "nonDuo", command: "info displays", status: "supported" },
            ],
          }),
        }),
      });
      expect(result.message).toContain("com.apple.coredevice.feature.getlockstate unsupported");
      expect(result.message).toContain("info displays supported");
      expect(result.detail).toContain("com.apple.coredevice.feature.getlockstate unsupported");
      expect(result.detail).toContain("info displays supported");
    });

    test("reports a below-required version", async () => {
      const result = await checkCoreDeviceVersion({
        ...baseDependencies,
        execFile: async () => createExecResult("650.2.0"),
      });
      expect(result.status).toBe("warn");
      expect(result.value).toBe("650.2.0");
      expect(result.message).toContain("requires CoreDevice >= 651.0.0");
    });

    test("logs and warns when devicectl is missing", async () => {
      const logger = new FakeLogger();
      const result = await checkCoreDeviceVersion({
        ...baseDependencies,
        logger,
        execFile: async () => {
          throw new Error("command not found");
        },
      });
      expect(result.status).toBe("warn");
      expect(result.message).toContain("devicectl missing");
      expect(result.message).toContain("devicectl-only simulator features will be unavailable");
      expect(result.message).toContain("simctl-based features are unaffected");
      expect(result.message).not.toContain("downgrade");
      expect(logger.at("warn")).toHaveLength(1);
    });

    test("logs and warns when the version is unreadable", async () => {
      const logger = new FakeLogger();
      const result = await checkCoreDeviceVersion({
        ...baseDependencies,
        logger,
        execFile: async () => createExecResult("unexpected output"),
      });
      expect(result.status).toBe("warn");
      expect(result.message).toContain("version unreadable");
      expect(result.message).toContain("devicectl-only simulator features will be unavailable");
      expect(result.message).toContain("simctl-based features are unaffected");
      expect(result.message).not.toContain("downgrade");
      expect(logger.at("warn")).toHaveLength(1);
    });

    test("logs and warns when the version probe throws unexpectedly", async () => {
      const logger = new FakeLogger();
      const result = await checkCoreDeviceVersion({
        ...baseDependencies,
        logger,
        platform: () => {
          throw new Error("platform probe failed");
        },
      });
      expect(result.status).toBe("warn");
      expect(result.message).toContain("platform probe failed");
      expect(result.detail).toBe("simulator boot state: unavailable; capabilities: not probed");
      expect(result.message).toContain("devicectl-only simulator features will be unavailable");
      expect(result.message).toContain("simctl-based features are unaffected");
      expect(result.message).not.toContain("downgrade");
      expect(logger.at("warn")).toHaveLength(1);
    });

    test("skips without running devicectl on non-darwin hosts", async () => {
      const result = await checkCoreDeviceVersion({
        ...baseDependencies,
        platform: () => "linux",
        execFile: async () => {
          throw new Error("must not run");
        },
      });
      expect(result.status).toBe("skip");
    });
  });
  describe("checkXcodeInstallation", () => {
    test("passes when version meets minimum", async () => {
      const result = await checkXcodeInstallation("15.0", {
        ...baseDependencies,
        xcodebuild: {
          executeCommand: async () => createExecResult("Xcode 15.2\nBuild version 15C500b"),
        },
      });

      expect(result.status).toBe("pass");
      expect(result.message).toContain("Xcode 15.2 installed");
      expect(result.value).toBe("15.2");
    });

    test("fails when Xcode version is below minimum", async () => {
      const result = await checkXcodeInstallation("15.0", {
        ...baseDependencies,
        xcodebuild: {
          executeCommand: async () => createExecResult("Xcode 14.2\nBuild version 14C18"),
        },
      });

      expect(result.status).toBe("fail");
      expect(result.message).toContain("requires 15.0");
    });

    test("fails when unable to determine version", async () => {
      const result = await checkXcodeInstallation("15.0", {
        ...baseDependencies,
        xcodebuild: { executeCommand: async () => createExecResult("some unexpected output") },
      });

      expect(result.status).toBe("fail");
      expect(result.message).toContain("Unable to determine Xcode version");
    });

    test("skips when not on darwin", async () => {
      const result = await checkXcodeInstallation("15.0", {
        ...baseDependencies,
        platform: () => "linux",
      });

      expect(result.status).toBe("skip");
      expect(result.message).toContain("requires macOS");
    });

    test("warns (does not fail) when the xcodebuild probe times out", async () => {
      // A slow `xcodebuild -version` probe must be diagnosed distinctly from a
      // missing Xcode and must not force a nonzero doctor verdict (issue #6003).
      const result = await checkXcodeInstallation("15.0", {
        ...baseDependencies,
        xcodebuild: {
          executeCommand: async () => {
            throw new Error("Command timed out after 5000ms: xcodebuild -version");
          },
        },
      });

      expect(result.status).toBe("warn");
      // Assert the duration shape, not a literal value: DOCTOR_EXEC_TIMEOUT_MS
      // is read from AUTOMOBILE_DOCTOR_TIMEOUT_MS at module load, so hard-coding
      // 5000ms would go red in any env that overrides it (issue #6003 review).
      expect(result.message).toMatch(/timed out after \d+ms/);
      expect(result.message).toContain("xcodebuild -version");
      expect(result.message).not.toContain("Xcode not detected");
      expect(result.recommendation).toContain("AUTOMOBILE_DOCTOR_TIMEOUT_MS");
    });

    test("fails when xcodebuild throws a non-timeout error", async () => {
      const result = await checkXcodeInstallation("15.0", {
        ...baseDependencies,
        xcodebuild: {
          executeCommand: async () => {
            throw new Error("spawn xcodebuild ENOENT");
          },
        },
      });

      expect(result.status).toBe("fail");
      expect(result.message).toContain("Xcode not detected");
      expect(result.message).toContain("spawn xcodebuild ENOENT");
    });
  });

  describe("checkXcodeCommandLineTools", () => {
    test("passes when path exists and contains CommandLineTools", async () => {
      const result = await checkXcodeCommandLineTools(
        {},
        {
          ...baseDependencies,
          execFile: async () => createExecResult("/Library/Developer/CommandLineTools\n"),
          fileExists: () => true,
        },
      );

      expect(result.status).toBe("pass");
      expect(result.message).toBe("Command Line Tools installed");
      expect(result.value).toBe("/Library/Developer/CommandLineTools");
    });

    test("passes when Xcode developer dir is selected", async () => {
      const result = await checkXcodeCommandLineTools(
        {},
        {
          ...baseDependencies,
          execFile: async () => createExecResult("/Applications/Xcode.app/Contents/Developer\n"),
          fileExists: () => true,
        },
      );

      expect(result.status).toBe("pass");
      expect(result.message).toBe("Xcode developer directory selected");
      expect(result.value).toBe("/Applications/Xcode.app/Contents/Developer");
    });

    test("fails when path doesn't exist", async () => {
      const result = await checkXcodeCommandLineTools(
        {},
        {
          ...baseDependencies,
          execFile: async () => createExecResult("/Library/Developer/CommandLineTools\n"),
          fileExists: () => false,
        },
      );

      expect(result.status).toBe("fail");
      expect(result.message).toContain("path missing");
    });

    test("skips when not on darwin", async () => {
      const result = await checkXcodeCommandLineTools(
        {},
        {
          ...baseDependencies,
          platform: () => "linux",
        },
      );

      expect(result.status).toBe("skip");
      expect(result.message).toContain("requires macOS");
    });
  });

  describe("checkXcrunAvailable", () => {
    test("passes when xcrun works", async () => {
      const result = await checkXcrunAvailable({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          isAvailable: async () => true,
        }),
      });

      expect(result.status).toBe("pass");
      expect(result.message).toBe("xcrun functional");
    });

    test("fails when xcrun fails", async () => {
      const result = await checkXcrunAvailable({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          isAvailable: async () => false,
        }),
      });

      expect(result.status).toBe("fail");
      expect(result.message).toContain("xcrun not functional");
    });

    test("passes the shared cancellation options to the simctl-backed probe", async () => {
      const controller = new AbortController();
      let received: { signal?: AbortSignal; timeoutMs?: number } | undefined;
      const result = await checkXcrunAvailable(
        {
          ...baseDependencies,
          createSimctlClient: () => ({
            ...baseDependencies.createSimctlClient(),
            isAvailable: async (options) => {
              received = options;
              return true;
            },
          }),
        },
        { signal: controller.signal, timeoutMs: 123 },
      );

      expect(result.status).toBe("pass");
      expect(received).toEqual({ signal: controller.signal, timeoutMs: 123 });
    });

    test("skips when not on darwin", async () => {
      const result = await checkXcrunAvailable({
        ...baseDependencies,
        platform: () => "win32",
      });

      expect(result.status).toBe("skip");
      expect(result.message).toContain("requires macOS");
    });
  });

  describe("checkSimctlAvailable", () => {
    test("passes when simctl is available", async () => {
      const result = await checkSimctlAvailable({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          isAvailable: async () => true,
        }),
      });

      expect(result.status).toBe("pass");
      expect(result.message).toBe("simctl functional");
    });

    test("fails when simctl is not available", async () => {
      const result = await checkSimctlAvailable({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          isAvailable: async () => false,
        }),
      });

      expect(result.status).toBe("fail");
      expect(result.message).toBe("simctl not available");
    });

    test("skips when not on darwin", async () => {
      let createSimctlClientCalls = 0;
      const result = await checkSimctlAvailable({
        ...baseDependencies,
        platform: () => "linux",
        createSimctlClient: () => {
          createSimctlClientCalls++;
          throw new Error("createSimctlClient should not be called on non-darwin");
        },
      });

      expect(result.status).toBe("skip");
      expect(result.message).toContain("requires macOS");
      expect(createSimctlClientCalls).toBe(0);
    });
  });

  describe("checkSimulatorRuntimes", () => {
    test("skips without creating simctl client when not on darwin", async () => {
      let createSimctlClientCalls = 0;
      const result = await checkSimulatorRuntimes({
        ...baseDependencies,
        platform: () => "linux",
        createSimctlClient: () => {
          createSimctlClientCalls++;
          throw new Error("createSimctlClient should not be called on non-darwin");
        },
      });

      expect(result.status).toBe("skip");
      expect(result.message).toContain("only available on macOS");
      expect(createSimctlClientCalls).toBe(0);
    });

    test("fails when no simulator runtimes are available", async () => {
      const result = await checkSimulatorRuntimes({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          getRuntimesChecked: async () => [],
        }),
      });

      expect(result.status).toBe("fail");
      expect(result.message).toContain("No iOS simulator runtimes");
    });

    test.each([true, false])("filters iOS runtimes by availability (%s)", async (isAvailable) => {
      const result = await checkSimulatorRuntimes({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          getRuntimesChecked: async () => [
            {
              bundlePath: "/path",
              buildversion: "21A328",
              runtimeRoot: "/path",
              identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
              version: "17.0",
              isAvailable,
              name: "iOS 17.0",
            },
          ],
        }),
      });

      expect(result.status).toBe(isAvailable ? "pass" : "fail");
      if (isAvailable) {
        expect(result.message).toContain("iOS 17.0");
        expect(result.value).toBe(1);
      } else {
        expect(result.message).toBe("No iOS simulator runtimes available");
        expect(result.recommendation).toBe(
          "Install an iOS Simulator runtime in Xcode Settings > Platforms.",
        );
      }
    });
  });

  describe("checkCodeSigning", () => {
    test("warns when no code signing identities are present", async () => {
      const result = await checkCodeSigning({
        ...baseDependencies,
        securityClient: {
          ...baseDependencies.securityClient,
          listCodeSigningIdentities: async () => [],
        } as SecurityClient,
      });

      expect(result.status).toBe("warn");
      expect(result.message).toContain("No code signing identities");
    });

    test("passes when code signing identities exist", async () => {
      const result = await checkCodeSigning({
        ...baseDependencies,
        securityClient: {
          ...baseDependencies.securityClient,
          listCodeSigningIdentities: async () => [
            { fingerprint: "ABC123", name: "Apple Development: test@test.com" },
          ],
        } as SecurityClient,
      });

      expect(result.status).toBe("pass");
      expect(result.message).toContain("1 code signing identity");
    });
  });

  describe("checkSecurityCli", () => {
    test("reports the centralized security client diagnostics", async () => {
      const result = await checkSecurityCli(baseDependencies);

      expect(result.status).toBe("pass");
      expect(result.message).toContain("does not report a standalone version");
    });

    test("uses the configured doctor timeout for the security probe", async () => {
      let timeoutMs: number | undefined;
      await checkSecurityCli({
        ...baseDependencies,
        securityClient: {
          ...baseDependencies.securityClient,
          getDiagnostics: async (options) => {
            timeoutMs = options?.timeoutMs;
            return { available: true, version: null };
          },
        } as SecurityClient,
      });

      expect(timeoutMs).toBe(5000);
    });

    test("fails when the security client is unavailable", async () => {
      const result = await checkSecurityCli({
        ...baseDependencies,
        securityClient: {
          ...baseDependencies.securityClient,
          getDiagnostics: async () => ({ available: false, version: null }),
        } as SecurityClient,
      });

      expect(result.status).toBe("fail");
      expect(result.recommendation).toContain("command line tools");
    });

    test("logs and returns a diagnostic failure when the client probe throws", async () => {
      const logger = new FakeLogger();
      const result = await checkSecurityCli({
        ...baseDependencies,
        logger,
        securityClient: {
          ...baseDependencies.securityClient,
          getDiagnostics: async () => {
            throw new Error("security probe failed");
          },
        } as SecurityClient,
      });

      expect(result.status).toBe("fail");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });
  });

  describe("checkAppleDeveloperAccount", () => {
    test("warns when no Apple Developer account is configured", async () => {
      const result = await checkAppleDeveloperAccount({
        ...baseDependencies,
        readDir: async () => [],
      });

      expect(result.status).toBe("warn");
      expect(result.message).toContain("No Apple Developer account");
    });

    test("passes when account entries exist", async () => {
      const controller = new AbortController();
      const result = await checkAppleDeveloperAccount(
        {
          ...baseDependencies,
          readDir: async () => ["account.plist"],
        },
        { signal: controller.signal },
      );

      expect(result.status).toBe("pass");
      expect(result.message).toContain("Apple Developer account configured");
      expect(controller.signal.aborted).toBe(false);
    });
  });

  describe("checkProvisioningProfiles", () => {
    test("passes when profiles exist", async () => {
      const controller = new AbortController();
      const result = await checkProvisioningProfiles(
        {
          ...baseDependencies,
          readDir: async () => ["dev.mobileprovision", "dist.mobileprovision"],
        },
        { signal: controller.signal },
      );

      expect(result.status).toBe("pass");
      expect(result.message).toContain("2 provisioning profile(s)");
      expect(result.value).toBe(2);
      expect(controller.signal.aborted).toBe(false);
    });

    test("warns when no profiles", async () => {
      const result = await checkProvisioningProfiles({
        ...baseDependencies,
        readDir: async () => [],
      });

      expect(result.status).toBe("warn");
      expect(result.message).toContain("No provisioning profiles");
    });

    test("skips when not on darwin", async () => {
      const result = await checkProvisioningProfiles({
        ...baseDependencies,
        platform: () => "linux",
      });

      expect(result.status).toBe("skip");
      expect(result.message).toContain("only available on macOS");
    });
  });

  describe("checkBootedSimulators", () => {
    test("passes with running simulators", async () => {
      const result = await checkBootedSimulators({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          getBootedSimulatorsChecked: async () => [
            { name: "iPhone 15", platform: "ios", deviceId: "ABC-123" },
            { name: "iPad Air", platform: "ios", deviceId: "DEF-456" },
          ],
        }),
      });

      expect(result.status).toBe("pass");
      expect(result.message).toContain("2 simulator(s) running");
      expect(result.message).toContain("iPhone 15");
      expect(result.message).toContain("iPad Air");
      expect(result.value).toBe(2);
    });

    test("passes with no simulators", async () => {
      const result = await checkBootedSimulators({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          getBootedSimulatorsChecked: async () => [],
        }),
      });

      expect(result.status).toBe("pass");
      expect(result.message).toContain("No simulators currently running");
      expect(result.value).toBe(0);
    });

    test("skips when not on darwin", async () => {
      let createSimctlClientCalls = 0;
      const result = await checkBootedSimulators({
        ...baseDependencies,
        platform: () => "linux",
        createSimctlClient: () => {
          createSimctlClientCalls++;
          throw new Error("createSimctlClient should not be called on non-darwin");
        },
      });

      expect(result.status).toBe("skip");
      expect(result.message).toContain("only available on macOS");
      expect(createSimctlClientCalls).toBe(0);
    });
  });

  describe("diagnostic tracing", () => {
    const throwingExecFile = async () => {
      throw new Error("xcrun: command not found");
    };

    test("checkXcodeInstallation logs the underlying error before returning fail", async () => {
      const logger = new FakeLogger();
      const result = await checkXcodeInstallation("15.0", {
        ...baseDependencies,
        logger,
        xcodebuild: { executeCommand: throwingExecFile },
      });

      expect(result.status).toBe("fail");
      const debug = logger.at("warn");
      expect(debug.length).toBeGreaterThan(0);
      expect(JSON.stringify(debug)).toContain("xcrun: command not found");
    });

    test("checkXcodeCommandLineTools logs the underlying error before returning fail", async () => {
      const logger = new FakeLogger();
      const result = await checkXcodeCommandLineTools(
        {},
        {
          ...baseDependencies,
          logger,
          execFile: throwingExecFile,
        },
      );

      expect(result.status).toBe("fail");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });

    test("checkXcrunAvailable logs the underlying error before returning fail", async () => {
      const logger = new FakeLogger();
      const result = await checkXcrunAvailable({
        ...baseDependencies,
        logger,
        createSimctlClient: () => {
          throw new Error("xcrun: command not found");
        },
      });

      expect(result.status).toBe("fail");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });

    test("checkSimctlAvailable logs the underlying error before returning fail", async () => {
      const logger = new FakeLogger();
      const result = await checkSimctlAvailable({
        ...baseDependencies,
        logger,
        createSimctlClient: () => {
          throw new Error("simctl exploded");
        },
      });

      expect(result.status).toBe("fail");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });

    test("checkSimulatorRuntimes logs the underlying error before returning fail", async () => {
      const logger = new FakeLogger();
      const result = await checkSimulatorRuntimes({
        ...baseDependencies,
        logger,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          isAvailable: async () => true,
          getRuntimesChecked: async () => {
            throw new Error("runtimes exploded");
          },
        }),
      });

      expect(result.status).toBe("fail");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });

    test("checkCodeSigning logs the underlying error before returning warn", async () => {
      const logger = new FakeLogger();
      const result = await checkCodeSigning({
        ...baseDependencies,
        logger,
        securityClient: {
          ...baseDependencies.securityClient,
          listCodeSigningIdentities: async () => {
            throw new Error("security exploded");
          },
        } as SecurityClient,
      });

      expect(result.status).toBe("warn");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });

    test("checkAppleDeveloperAccount logs the underlying error before returning warn", async () => {
      const logger = new FakeLogger();
      const result = await checkAppleDeveloperAccount({
        ...baseDependencies,
        logger,
        readDir: async () => {
          throw new Error("home dir unreadable");
        },
      });

      expect(result.status).toBe("warn");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });

    test("checkProvisioningProfiles logs the underlying error before returning warn", async () => {
      const logger = new FakeLogger();
      const result = await checkProvisioningProfiles({
        ...baseDependencies,
        logger,
        readDir: async () => {
          throw new Error("profiles unreadable");
        },
      });

      expect(result.status).toBe("warn");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });

    test("checkBootedSimulators logs the underlying error before returning skip", async () => {
      const logger = new FakeLogger();
      const result = await checkBootedSimulators({
        ...baseDependencies,
        logger,
        createSimctlClient: () => {
          throw new Error("booted lookup failed");
        },
      });

      expect(result.status).toBe("skip");
      expect(logger.at("warn").length).toBeGreaterThan(0);
    });
  });
});

describe("iOS doctor checked simctl listings", () => {
  beforeEach(() => SimCtlClient.invalidateDeviceListCache());
  afterEach(() => SimCtlClient.invalidateDeviceListCache());

  test("reports a failed device listing instead of no booted simulators", async () => {
    const message = "Unable to locate device set: CoreSimulatorService connection became invalid";
    const logger = new FakeLogger();
    const simctl = new SimCtlClient(
      null,
      async (file, args) => {
        const command = `${file} ${args.join(" ")}`;
        if (command === "xcrun --find simctl") {
          return createExecResult("/usr/bin/simctl");
        }
        expect(command).toBe("xcrun simctl list devices --json");
        throw new Error(message);
      },
      new FakeTimer(),
      "darwin",
    );

    const result = await checkBootedSimulators({
      ...baseDependencies,
      logger,
      createSimctlClient: () => simctl,
    });
    expect(result.status).toBe("skip");
    expect(result.message).toStartWith("Could not check simulators:");
    expect(result.message).toContain(message);
    expect(logger.at("warn").length).toBeGreaterThan(0);
  });

  test.each([
    ["non-JSON", "xcrun: error: unable to find utility"],
    ["missing runtimes array", "{}"],
  ])("reports malformed runtime listing (%s) instead of no runtimes", async (_kind, stdout) => {
    const logger = new FakeLogger();
    const simctl = new SimCtlClient(
      null,
      async (file, args) => {
        const command = `${file} ${args.join(" ")}`;
        if (command === "xcrun --find simctl") {
          return createExecResult("/usr/bin/simctl");
        }
        expect(command).toBe("xcrun simctl list runtimes --json");
        return createExecResult(stdout);
      },
      new FakeTimer(),
      "darwin",
    );

    const result = await checkSimulatorRuntimes({
      ...baseDependencies,
      logger,
      createSimctlClient: () => simctl,
    });
    expect(result.status).toBe("fail");
    expect(result.message).toStartWith("Failed to list runtimes:");
    expect(result.message).not.toContain("No iOS simulator runtimes available");
    expect(logger.at("warn").length).toBeGreaterThan(0);
  });

  test.each([
    ["booted simulators", checkBootedSimulators, "devices"],
    ["runtimes", checkSimulatorRuntimes, "runtimes"],
  ] as const)("propagates the doctor deadline during %s listing", async (_name, check, listing) => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    const logger = new FakeLogger();
    let listingStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      listingStarted = resolve;
    });
    let rejectListing: (error: unknown) => void = () => {};
    const pendingListing = new Promise<ExecResult>((_resolve, reject) => {
      rejectListing = reject;
    });
    const simctl = new SimCtlClient(
      null,
      async (file, args, _maxBuffer, signal) => {
        const command = `${file} ${args.join(" ")}`;
        if (command === "xcrun --find simctl") {
          return createExecResult("/usr/bin/simctl");
        }
        expect(command).toBe(`xcrun simctl list ${listing} --json`);
        expect(signal).toBeDefined();
        listingStarted();
        return await pendingListing;
      },
      timer,
      "darwin",
    );

    try {
      const checking = check(
        {
          ...baseDependencies,
          logger,
          createSimctlClient: () => simctl,
        },
        deadline.probe,
      );
      const rejected = checking.then(
        () => {
          throw new Error("Expected the doctor deadline to propagate");
        },
        (error: unknown) => error,
      );
      await started;
      timer.advanceTime(50);
      rejectListing(deadline.probe.signal?.reason);
      expect(await rejected).toBeInstanceOf(DoctorDeadlineError);
      expect(logger.at("warn")).toEqual([]);
    } finally {
      deadline.dispose();
    }
  });
});

describe("iOS doctor cancellation", () => {
  test("bounds a never-settling Apple account filesystem read", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    let result: Awaited<ReturnType<typeof checkAppleDeveloperAccount>> | undefined;
    const check = checkAppleDeveloperAccount(
      {
        ...baseDependencies,
        readDir: () => new Promise<string[]>(() => {}),
      },
      deadline.probe,
    ).then((value) => {
      result = value;
    });

    timer.advanceTime(49);
    await Promise.resolve();
    expect(result).toBeUndefined();

    timer.advanceTime(1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deadline.probe.signal?.aborted).toBe(true);
    expect(result?.status).toBe("warn");
    await check;
    deadline.dispose();
  });

  test("bounds a never-settling provisioning profiles filesystem read", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    let result: Awaited<ReturnType<typeof checkProvisioningProfiles>> | undefined;
    const check = checkProvisioningProfiles(
      {
        ...baseDependencies,
        readDir: () => new Promise<string[]>(() => {}),
      },
      deadline.probe,
    ).then((value) => {
      result = value;
    });

    timer.advanceTime(50);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deadline.probe.signal?.aborted).toBe(true);
    expect(result?.status).toBe("warn");
    await check;
    deadline.dispose();
  });

  test("exits the iOS doctor deadline when a filesystem read never settles", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    let startedRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    let rejection: unknown;
    const doctor = runIosChecks(deadline.probe, {
      ...baseDependencies,
      readDir: () => {
        startedRead?.();
        return new Promise<string[]>(() => {});
      },
    }).then(
      () => {},
      (error: unknown) => {
        rejection = error;
      },
    );

    await readStarted;
    timer.advanceTime(50);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(rejection).toBeInstanceOf(DoctorDeadlineError);
    await doctor;
    deadline.dispose();
  });

  test("aborts delayed simctl I/O without publishing a late pass", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    let observedSignal: AbortSignal | undefined;
    let observedTimeoutMs: number | undefined;
    let lateSuccess = false;
    let settled = false;
    const check = checkSimctlAvailable(
      {
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          isAvailable: async (options) => {
            observedSignal = options?.signal;
            observedTimeoutMs = options?.timeoutMs;
            await new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", resolve, { once: true });
            });
            try {
              options?.signal?.throwIfAborted();
              lateSuccess = true;
              return true;
            } finally {
              settled = true;
            }
          },
        }),
      },
      deadline.probe,
    );

    timer.advanceTime(50);
    const result = await check;
    deadline.dispose();

    expect(observedSignal?.aborted).toBe(true);
    expect(observedTimeoutMs).toBe(50);
    expect(settled).toBe(true);
    expect(lateSuccess).toBe(false);
    expect(result.status).toBe("fail");
  });
});

describe("checkIosCtrlProxyRunner", () => {
  // A fresh runner advertises every feature command plus the baseline ones.
  const FRESH_COMMANDS = [
    ...IOS_RUNNER_FEATURE_COMMANDS,
    "request_hierarchy",
    "request_screenshot",
    "request_tap_coordinates",
  ];
  // Remove a required feature command so the stale fixture remains meaningfully
  // different from a fresh runner even while append has a compatibility fallback.
  const STALE_COMMANDS = FRESH_COMMANDS.filter((command) => command !== "request_shake");

  const inspection = (over: Partial<IosRunnerInspection> = {}): IosRunnerInspection => ({
    deviceId: "SIM-1",
    name: "iPhone 15",
    installed: true,
    running: true,
    supportedCommands: [...FRESH_COMMANDS],
    supportedFeatures: [...IOS_RUNNER_FEATURE_FLAGS],
    ...over,
  });

  const withRunners = (inspections: IosRunnerInspection[]) => ({
    ...baseDependencies,
    runnerInspector: { inspectBootedRunners: async () => inspections },
  });

  for (const environment of ["simulator", "physical", undefined] as const) {
    for (const missing of ["set_hinge_angle", "set_voiceover_state", "request_shake"] as const) {
      test(`classifies missing ${missing} on ${environment ?? "default simulator"}`, async () => {
        const commands = [...IOS_RUNNER_FEATURE_COMMANDS, "set_voiceover_state"];
        const stale =
          missing === "request_shake" ||
          (missing === "set_hinge_angle" && environment !== "physical") ||
          (missing === "set_voiceover_state" && environment === "physical");
        const result = await checkIosCtrlProxyRunner({
          ...withRunners([
            inspection({
              environment,
              supportedCommands: commands.filter((command) => command !== missing),
            }),
          ]),
          runnerCommandRequirements: {
            requiredCommands: commands,
            applicability: IOS_RUNNER_COMMAND_APPLICABILITY,
          },
        });
        expect(result.status).toBe(stale ? "warn" : "pass");
        expect(result.message).toContain(`versionStatus=${stale ? "stale" : "compatible"}`);
        if (stale) {
          expect(result.message).toContain(`missingCommands=${missing}`);
        } else {
          expect(result.message).not.toContain("missingCommands=");
        }
      });
    }
  }

  test("passes when a booted runner advertises every feature command", async () => {
    const result = await checkIosCtrlProxyRunner(withRunners([inspection()]));

    expect(result.status).toBe("pass");
    expect(result.message).toContain("device=SIM-1");
    expect(result.message).toContain("versionStatus=compatible");
    expect(result.message).not.toContain("missingCommands");
  });

  test("fails (not passes) when AUTOMOBILE_VERSION pins an unverifiable version (#2746)", async () => {
    const prev = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "99.99.99";
    try {
      // A running runner advertising the full command set would classify as
      // `compatible` (pass); the unverifiable pin must override that to `fail`.
      const result = await checkIosCtrlProxyRunner(withRunners([inspection()]));
      expect(result.status).toBe("fail");
      expect(result.message).toContain("99.99.99");
      expect(result.recommendation).toContain("AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH");
    } finally {
      if (prev === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prev;
      }
    }
  });

  test("reports the pinned expectedVersion in the diagnostic line (#2746)", async () => {
    const prev = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    try {
      const result = await checkIosCtrlProxyRunner(withRunners([inspection()]));
      expect(result.message).toContain("expectedVersion=0.0.18");
    } finally {
      if (prev === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prev;
      }
    }
  });

  test("warns and lists missing commands when the runner is stale", async () => {
    const result = await checkIosCtrlProxyRunner(
      withRunners([inspection({ supportedCommands: [...STALE_COMMANDS] })]),
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("versionStatus=stale");
    expect(result.message).toContain("request_shake");
    expect(result.recommendation).toContain("ctrl-proxy-build-for-testing.sh");
    // BUNDLE_PATH takes an .ipa file and cannot consume the build script's
    // derived-data output; DERIVED_DATA is the followable override (#4221).
    expect(result.recommendation).toContain("AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA");
    expect(result.recommendation).not.toContain("AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH");
  });

  test("accepts the immutable 0.0.66 runner before the feature handshake release", async () => {
    const prev = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.66";
    try {
      const result = await checkIosCtrlProxyRunner(
        withRunners([inspection({ supportedFeatures: null })]),
      );

      expect(result.status).toBe("pass");
      expect(result.message).toContain("versionStatus=compatible");
      expect(result.message).not.toContain("missingFeatures");
    } finally {
      if (prev === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prev;
      }
    }
  });

  test("reports unknown when the runner is installed but not running", async () => {
    const result = await checkIosCtrlProxyRunner(
      withRunners([inspection({ running: false, supportedCommands: null })]),
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("versionStatus=unknown");
    expect(result.message).toContain("running=false");
  });

  test("reports unknown when the runner is running but unreachable", async () => {
    const result = await checkIosCtrlProxyRunner(
      withRunners([inspection({ supportedCommands: null })]),
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("versionStatus=unknown");
  });

  test("reports unknown when the runner is not installed", async () => {
    const result = await checkIosCtrlProxyRunner(
      withRunners([inspection({ installed: false, running: false, supportedCommands: null })]),
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("installed=false");
    expect(result.message).toContain("versionStatus=unknown");
  });

  test("skips when no simulators are booted", async () => {
    const result = await checkIosCtrlProxyRunner(withRunners([]));
    expect(result.status).toBe("skip");
  });

  test("skips on non-macOS platforms", async () => {
    const result = await checkIosCtrlProxyRunner({
      ...baseDependencies,
      platform: () => "linux",
    });
    expect(result.status).toBe("skip");
  });

  test("overall status is the worst across multiple simulators", async () => {
    const result = await checkIosCtrlProxyRunner(
      withRunners([
        inspection({ deviceId: "SIM-A" }),
        inspection({ deviceId: "SIM-B", supportedCommands: [...STALE_COMMANDS] }),
      ]),
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("device=SIM-A");
    expect(result.message).toContain("device=SIM-B");
  });

  test("logs and returns skip when the inspector throws", async () => {
    const logger = new FakeLogger();
    const result = await checkIosCtrlProxyRunner({
      ...baseDependencies,
      logger,
      runnerInspector: {
        inspectBootedRunners: async () => {
          throw new Error("inspection failed");
        },
      },
    });

    expect(result.status).toBe("skip");
    expect(logger.at("warn").length).toBeGreaterThan(0);
  });

  test("runIosChecks includes the iOS CtrlProxy runner check", async () => {
    const results = await runIosChecks({}, baseDependencies);
    const names = results.map((check) => check.name);
    expect(names).toContain("iOS CtrlProxy Runner");
  });
});

describe("checkIosObserveRoundTrip", () => {
  const inspection = (
    over: Partial<IosObserveRoundTripInspection> = {},
  ): IosObserveRoundTripInspection => ({
    deviceId: "SIM-1",
    name: "iPhone 15",
    runnerPort: 8765,
    clientPort: 8765,
    connected: true,
    screenSize: { width: 390, height: 844 },
    hierarchyError: null,
    elementCount: 7,
    ...over,
  });

  const withRoundTrips = (inspections: IosObserveRoundTripInspection[]) => ({
    ...baseDependencies,
    observeRoundTripInspector: {
      inspectBootedObserveRoundTrips: async () => inspections,
    },
  });

  test("passes when the client port matches the runner port and observe returns a usable hierarchy", async () => {
    const result = await checkIosObserveRoundTrip(withRoundTrips([inspection()]));

    expect(result.status).toBe("pass");
    expect(result.message).toContain("device=SIM-1");
    expect(result.message).toContain("runnerPort=8765");
    expect(result.message).toContain("clientPort=8765");
    expect(result.message).toContain("screenSize=390x844");
    expect(result.message).toContain("elementCount=7");
  });

  test("passes when a per-device host port diverges from the runner's internal port on a healthy round trip (#5636)", async () => {
    // The runner self-reports its internal default port (8765) via /health while
    // the client reaches it through a unique forwarded host port (8767). That
    // divergence is expected for a per-device CtrlProxy and must not fail doctor
    // once the observe round trip has otherwise succeeded.
    const result = await checkIosObserveRoundTrip(
      withRoundTrips([inspection({ runnerPort: 8765, clientPort: 8767 })]),
    );

    expect(result.status).toBe("pass");
    expect(result.message).toContain("runnerPort=8765");
    expect(result.message).toContain("clientPort=8767");
  });

  test("passes two simulators with distinct per-device host ports (#5636)", async () => {
    const result = await checkIosObserveRoundTrip(
      withRoundTrips([
        inspection({ deviceId: "SIM-A", runnerPort: 8765, clientPort: 8765 }),
        inspection({ deviceId: "SIM-B", runnerPort: 8765, clientPort: 8767 }),
      ]),
    );

    expect(result.status).toBe("pass");
    expect(result.message).toContain("device=SIM-A");
    expect(result.message).toContain("device=SIM-B");
    expect(result.message).toContain("clientPort=8765");
    expect(result.message).toContain("clientPort=8767");
  });

  test("still fails when ports diverge and the round trip did not connect (#2731 preserved)", async () => {
    // A genuine wrong-port bind (#2731): the runner is on 8765 but the client
    // expects 8767 and cannot connect. The connection failure — not the port
    // comparison — must keep this red.
    const result = await checkIosObserveRoundTrip(
      withRoundTrips([
        inspection({
          runnerPort: 8765,
          clientPort: 8767,
          connected: false,
          screenSize: { width: 0, height: 0 },
          hierarchyError:
            "iOS CtrlProxy runner is bound to port 8765 but the client expects port 8767",
          elementCount: 0,
        }),
      ]),
    );

    expect(result.status).toBe("fail");
    expect(result.message).toContain("runnerPort=8765");
    expect(result.message).toContain("clientPort=8767");
    expect(result.recommendation).toContain("CtrlProxy");
  });

  test("fails when the runner WebSocket cannot return a hierarchy", async () => {
    const result = await checkIosObserveRoundTrip(
      withRoundTrips([
        inspection({
          connected: false,
          screenSize: { width: 0, height: 0 },
          hierarchyError: "Failed to retrieve iOS view hierarchy from CtrlProxy iOS",
          elementCount: 0,
        }),
      ]),
    );

    expect(result.status).toBe("fail");
    expect(result.message).toContain("connected=false");
    expect(result.message).toContain("hierarchyStatus=error");
    expect(result.message).toContain("Failed to retrieve iOS view hierarchy");
  });

  test("fails for a degenerate observe result with zero screen size", async () => {
    const result = await checkIosObserveRoundTrip(
      withRoundTrips([inspection({ screenSize: { width: 0, height: 0 } })]),
    );

    expect(result.status).toBe("fail");
    expect(result.message).toContain("screenSize=0x0");
  });

  test("fails when observe returns no elements from the known simulator screen", async () => {
    const result = await checkIosObserveRoundTrip(
      withRoundTrips([inspection({ elementCount: 0 })]),
    );

    expect(result.status).toBe("fail");
    expect(result.message).toContain("elementCount=0");
  });

  test("skips when no simulators are booted", async () => {
    const result = await checkIosObserveRoundTrip(withRoundTrips([]));

    expect(result.status).toBe("skip");
  });

  test("skips on non-macOS platforms", async () => {
    const result = await checkIosObserveRoundTrip({
      ...baseDependencies,
      platform: () => "linux",
    });

    expect(result.status).toBe("skip");
  });

  test("logs and fails when the round-trip inspector throws", async () => {
    const logger = new FakeLogger();
    const result = await checkIosObserveRoundTrip({
      ...baseDependencies,
      logger,
      observeRoundTripInspector: {
        inspectBootedObserveRoundTrips: async () => {
          throw new Error("round trip failed");
        },
      },
    });

    expect(result.status).toBe("fail");
    expect(result.message).toContain("round trip failed");
    expect(logger.at("warn").length).toBeGreaterThan(0);
  });

  test("runIosChecks includes the iOS observe round-trip check", async () => {
    const results = await runIosChecks({}, baseDependencies);
    const names = results.map((check) => check.name);
    expect(names).toContain("iOS Observe Round Trip");
    expect(names).toContain("CoreDevice");
  });

  test("keeps post-repair iOS verification device-neutral", async () => {
    const results = await runPostRepairIosChecks(
      {},
      {
        ...baseDependencies,
        runnerInspector: {
          inspectBootedRunners: async () => {
            throw new Error("post-repair verification must not inspect iOS devices");
          },
        },
        observeRoundTripInspector: {
          inspectBootedObserveRoundTrips: async () => {
            throw new Error("post-repair verification must not observe iOS devices");
          },
        },
      },
    );

    expect(results.map((result) => result.name)).not.toEqual(
      expect.arrayContaining(["iOS CtrlProxy Runner", "iOS Observe Round Trip"]),
    );
    expect(results.map((result) => result.name)).toContain("CoreDevice");
  });
});

describe("createIosCtrlProxyRunnerInspector lifecycle", () => {
  const simctlReturning = (devices: { name: string; deviceId: string }[]) => ({
    ...baseDependencies.createSimctlClient(),
    isAvailable: async () => true,
    getBootedSimulators: async () =>
      devices.map((d) => ({ name: d.name, platform: "ios" as const, deviceId: d.deviceId })),
  });

  const runningManager = {
    isInstalled: async () => true,
    isRunning: async () => true,
    getServicePort: () => 8765,
    discoverRunnerPort: async () => 8765,
  };

  test("discovers a running runner and checks its version on the discovered port", async () => {
    const ports: number[] = [];
    const simctl = baseDependencies.createSimctlClient();
    const available = spyOn(simctl, "isAvailable").mockResolvedValue(true);
    const booted = spyOn(simctl, "getBootedSimulators").mockResolvedValue([
      { name: "iPhone", platform: "ios", deviceId: "SIM-1" },
    ]);
    const inspector = createIosCtrlProxyRunnerInspector(() => simctl, new FakeLogger(), {
      getManager: () => ({
        isInstalled: async () => true,
        getServicePort: () => 8765,
        discoverRunnerPort: async () => 8768,
      }),
      getExistingClient: () => null,
      createClient: (_device, port) => {
        ports.push(port);
        return {
          getRunnerIdentityForDiagnostics: async () => ({
            commands: [...IOS_RUNNER_FEATURE_COMMANDS],
            features: [...IOS_RUNNER_FEATURE_FLAGS],
          }),
          close: async () => {},
        };
      },
    });
    try {
      const inspections = await inspector.inspectBootedRunners();
      expect(inspections[0].running).toBe(true);
      const result = await checkIosCtrlProxyRunner({
        ...baseDependencies,
        runnerInspector: inspector,
      });
      expect(result.message).toContain("running=true");
      expect(result.message).toContain("versionStatus=compatible");
      expect(ports).toEqual([8768, 8768]);
    } finally {
      available.mockRestore();
      booted.mockRestore();
    }
  });

  test("both inspectors read a connected resident client despite stale manager state", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeIOSCtrlProxyManager(timer);
    manager.setInstalled(true);
    manager.setRunning(false);
    class ResidentSocket extends FakeWebSocket {
      override send(data: unknown): void {
        super.send(data);
        const message = JSON.parse(String(data)) as { type: string; requestId: string };
        if (message.type === "request_hierarchy_if_stale") {
          this.simulateMessage(
            JSON.stringify({
              type: "hierarchy_update",
              requestId: message.requestId,
              data: {
                updatedAt: 1,
                packageName: "SpringBoard",
                hierarchy: {},
                screenWidth: 390,
                screenHeight: 844,
              },
            }),
          );
        }
      }
    }
    let socket: ResidentSocket | undefined;
    const client = IOSCtrlProxyClient.createForTesting(
      { name: "iPhone", deviceId: "SIM-1", platform: "ios" },
      8765,
      (url) => {
        socket = new ResidentSocket(url, "none", 0, timer);
        return socket;
      },
      timer,
      () => manager,
    );
    const simctl = simctlReturning([{ name: "iPhone", deviceId: "SIM-1" }]);
    try {
      expect(await client.connectWithoutSetup()).toBe(true);
      socket!.simulateMessage(
        JSON.stringify({
          type: "connected",
          supportedCommands: [...IOS_RUNNER_FEATURE_COMMANDS],
          supportedFeatures: [...IOS_RUNNER_FEATURE_FLAGS],
        }),
      );
      const createClient = () => {
        throw new Error("must reuse the resident connection");
      };
      const runner = createIosCtrlProxyRunnerInspector(() => simctl, new FakeLogger(), {
        getManager: () => manager,
        getExistingClient: () => client,
        createClient,
      });
      const observe = createIosObserveRoundTripInspector(() => simctl, new FakeLogger(), {
        getManager: () => manager,
        getExistingClient: () => client,
        createClient,
        elementsBuilder: new ObserveElementsBuilder(),
      });
      expect((await runner.inspectBootedRunners())[0]).toMatchObject({
        running: true,
        supportedCommands: [...IOS_RUNNER_FEATURE_COMMANDS].sort(),
        supportedFeatures: [...IOS_RUNNER_FEATURE_FLAGS].sort(),
      });
      expect((await observe.inspectBootedObserveRoundTrips())[0]).toMatchObject({
        connected: true,
        hierarchyError: null,
        screenSize: { width: 390, height: 844 },
      });
      expect(client.isConnected()).toBe(true);
      expect(manager.getExecutedOperations()).not.toContain("start");
      expect(manager.getExecutedOperations()).not.toContain("setup:force=true");
      expect(manager.getExecutedOperations()).not.toContain("forceRestart");
    } finally {
      await client.close();
    }
  });

  test("closed resident probes ignore stale manager state and never retain a successful handshake", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeIOSCtrlProxyManager(timer);
    manager.setInstalled(true);
    manager.setRunning(false);
    let reachable = true;
    let dials = 0;
    class ProbeSocket extends FakeWebSocket {
      override send(data: unknown): void {
        super.send(data);
        const request = JSON.parse(String(data)) as { type: string; requestId: string };
        if (request.type === "request_hierarchy_if_stale") {
          this.simulateMessage(
            JSON.stringify({
              type: "hierarchy_update",
              requestId: request.requestId,
              data: {
                updatedAt: 1,
                packageName: "SpringBoard",
                hierarchy: {},
                screenWidth: 390,
                screenHeight: 844,
              },
            }),
          );
        }
      }
    }
    const client = IOSCtrlProxyClient.createForTesting(
      { name: "iPhone", deviceId: "SIM-1", platform: "ios" },
      8765,
      (url) => {
        dials++;
        const socket = new ProbeSocket(url, reachable ? "none" : "instant", 0, timer);
        socket.on("open", () =>
          queueMicrotask(() =>
            socket.simulateMessage(
              JSON.stringify({
                type: "connected",
                supportedCommands: [...IOS_RUNNER_FEATURE_COMMANDS],
                supportedFeatures: [...IOS_RUNNER_FEATURE_FLAGS],
              }),
            ),
          ),
        );
        return socket;
      },
      timer,
      () => manager,
    );
    const simctl = simctlReturning([{ name: "iPhone", deviceId: "SIM-1" }]);
    const hooks = {
      getManager: () => manager,
      getExistingClient: () => client,
      createClient: () => {
        throw new Error("resident client exists");
      },
    };
    const runner = createIosCtrlProxyRunnerInspector(() => simctl, new FakeLogger(), hooks);
    const observe = createIosObserveRoundTripInspector(() => simctl, new FakeLogger(), {
      ...hooks,
      elementsBuilder: new ObserveElementsBuilder(),
    });
    try {
      const [identity, hierarchy] = await Promise.all([
        runner.inspectBootedRunners(),
        observe.inspectBootedObserveRoundTrips(),
      ]);
      expect(identity[0]).toMatchObject({
        running: true,
        supportedCommands: [...IOS_RUNNER_FEATURE_COMMANDS].sort(),
      });
      expect(hierarchy[0]).toMatchObject({ connected: true, hierarchyError: null });
      expect(client.getCachedSupportedCommands()).toBeNull();
      expect(client.getCachedSupportedFeatures()).toBeNull();
      expect(client.isConnected()).toBe(false);
      expect(client["autoReconnectEnabled"]).toBe(true);
      reachable = false;
      expect((await runner.inspectBootedRunners())[0]).toMatchObject({
        running: false,
        supportedCommands: null,
        supportedFeatures: null,
      });
      expect((await observe.inspectBootedObserveRoundTrips())[0]).toMatchObject({
        connected: false,
        hierarchyError: "iOS CtrlProxy runner is not running or unreachable",
      });
      expect(dials).toBe(4);
      expect(client["connectionAttempts"]).toBe(0);
      expect(client["autoReconnectEnabled"]).toBe(true);
      expect(
        manager
          .getExecutedOperations()
          .filter((operation) =>
            ["setup:force=true", "setup:force=false", "start", "forceRestart"].includes(operation),
          ),
      ).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("both inspectors leave an unreachable resident runner untouched", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeIOSCtrlProxyManager(timer);
    manager.setInstalled(true);
    manager.setRunning(false);
    const setup = spyOn(manager, "setup");
    const start = spyOn(manager, "start");
    const restart = spyOn(manager, "forceRestart");
    const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("doctor must not spawn a process");
    });
    const client = IOSCtrlProxyClient.createForTesting(
      { name: "iPhone", deviceId: "SIM-1", platform: "ios" },
      8765,
      createInstantFailureWebSocketFactory(timer),
      timer,
      () => manager,
    );
    const simctl = simctlReturning([{ name: "iPhone", deviceId: "SIM-1" }]);
    const runner = createIosCtrlProxyRunnerInspector(() => simctl, new FakeLogger(), {
      getManager: () => manager,
      getExistingClient: () => client,
      createClient: () => {
        throw new Error("resident client exists");
      },
    });
    const observe = createIosObserveRoundTripInspector(() => simctl, new FakeLogger(), {
      getManager: () => manager,
      getExistingClient: () => client,
      createClient: () => {
        throw new Error("resident client exists");
      },
      elementsBuilder: new ObserveElementsBuilder(),
    });
    try {
      // Cross the normal auto-restart threshold as well as the setup fallback.
      for (let attempt = 0; attempt < 5; attempt++) {
        expect((await runner.inspectBootedRunners())[0]).toMatchObject({
          running: false,
          supportedCommands: null,
          supportedFeatures: null,
        });
        expect((await observe.inspectBootedObserveRoundTrips())[0].connected).toBe(false);
        timer.advanceTime(10000);
      }
      expect(setup).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(client["consecutiveConnectionFailures"]).toBe(0);
      expect(client["restartRearmTimeout"]).toBeNull();
    } finally {
      await client.close();
      spawn.mockRestore();
      setup.mockRestore();
      start.mockRestore();
      restart.mockRestore();
    }
  });

  test("closes a probe client it created (no pre-existing client)", async () => {
    let closes = 0;
    const probe = {
      getRunnerIdentityForDiagnostics: async () => ({
        commands: [...IOS_RUNNER_FEATURE_COMMANDS],
        features: [...IOS_RUNNER_FEATURE_FLAGS],
      }),
      close: async () => {
        closes += 1;
      },
    };
    const hooks: IosRunnerInspectorHooks = {
      getManager: () => runningManager,
      getExistingClient: () => null,
      createClient: () => probe,
    };

    const inspector = createIosCtrlProxyRunnerInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedRunners();

    expect(inspections[0].supportedCommands).toEqual([...IOS_RUNNER_FEATURE_COMMANDS]);
    expect(inspections[0].supportedFeatures).toEqual([...IOS_RUNNER_FEATURE_FLAGS]);
    expect(closes).toBe(1);
  });

  test("does not close a pre-existing client it did not create", async () => {
    let closes = 0;
    const existing = {
      getRunnerIdentityForDiagnostics: async () => ({
        commands: [...IOS_RUNNER_FEATURE_COMMANDS],
        features: [...IOS_RUNNER_FEATURE_FLAGS],
      }),
      close: async () => {
        closes += 1;
      },
    };
    let created = false;
    const hooks: IosRunnerInspectorHooks = {
      getManager: () => runningManager,
      getExistingClient: () => existing,
      createClient: () => {
        created = true;
        return existing;
      },
    };

    const inspector = createIosCtrlProxyRunnerInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    await inspector.inspectBootedRunners();

    expect(closes).toBe(0);
    expect(created).toBe(false);
  });

  test("treats a reachable pre-existing client as running when manager port state is stale", async () => {
    const existing = {
      getRunnerIdentityForDiagnostics: async () => ({
        commands: [...IOS_RUNNER_FEATURE_COMMANDS],
        features: [...IOS_RUNNER_FEATURE_FLAGS],
      }),
      close: async () => {},
    };
    const hooks: IosRunnerInspectorHooks = {
      getManager: () => ({
        ...runningManager,
        isRunning: async () => false,
        discoverRunnerPort: async () => null,
      }),
      getExistingClient: () => existing,
      createClient: () => {
        throw new Error("should use the resident client");
      },
    };

    const inspector = createIosCtrlProxyRunnerInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedRunners();

    expect(inspections[0].running).toBe(true);
    expect(inspections[0].supportedCommands).toEqual([...IOS_RUNNER_FEATURE_COMMANDS]);
  });

  test("closes the created probe client even when the identity read throws", async () => {
    let closes = 0;
    const probe = {
      getRunnerIdentityForDiagnostics: async () => {
        throw new Error("unreachable");
      },
      close: async () => {
        closes += 1;
      },
    };
    const hooks: IosRunnerInspectorHooks = {
      getManager: () => runningManager,
      getExistingClient: () => null,
      createClient: () => probe,
    };

    const inspector = createIosCtrlProxyRunnerInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedRunners();

    expect(inspections[0].supportedCommands).toBeNull();
    expect(inspections[0].supportedFeatures).toBeNull();
    expect(closes).toBe(1);
  });

  test.each(["commands", "features"] as const)(
    "bounds a never-settling runner %s handshake read",
    async (stalledRead) => {
      const timer = new FakeTimer();
      const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
      const readStarted = Promise.withResolvers<void>();
      let closes = 0;
      const probe = {
        getRunnerIdentityForDiagnostics: async () => {
          const readCommands = async () => {
            if (stalledRead === "commands") {
              readStarted.resolve();
              return await new Promise<never>(() => {});
            }
            return [...IOS_RUNNER_FEATURE_COMMANDS];
          };
          const readFeatures = async () => {
            if (stalledRead === "features") {
              readStarted.resolve();
              return await new Promise<never>(() => {});
            }
            return [...IOS_RUNNER_FEATURE_FLAGS];
          };
          const [commands, features] = await Promise.all([readCommands(), readFeatures()]);
          return { commands, features };
        },
        close: async () => {
          closes += 1;
        },
      };
      const hooks: IosRunnerInspectorHooks = {
        getManager: () => runningManager,
        getExistingClient: () => null,
        createClient: () => probe,
      };
      const inspector = createIosCtrlProxyRunnerInspector(
        () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
        new FakeLogger(),
        hooks,
      );

      const inspection = inspector.inspectBootedRunners(undefined, deadline.probe);
      await readStarted.promise;
      timer.advanceTime(50);
      const inspections = await inspection;
      deadline.dispose();

      expect(deadline.probe.signal?.aborted).toBe(true);
      const result = await checkIosCtrlProxyRunner({
        ...baseDependencies,
        runnerInspector: { inspectBootedRunners: async () => inspections },
      });
      expect(result.status).toBe("warn");
      expect(result.message).toContain("versionStatus=unknown");
      expect(inspections[0]?.supportedCommands).toBeNull();
      expect(inspections[0]?.supportedFeatures).toBeNull();
      expect(closes).toBe(1);
    },
  );

  test("unavailable commands with successful features cannot pass runner compatibility", async () => {
    const probe = {
      getRunnerIdentityForDiagnostics: async () => ({
        commands: null,
        features: [...IOS_RUNNER_FEATURE_FLAGS],
      }),
      close: async () => {},
    };
    const inspector = createIosCtrlProxyRunnerInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]),
      new FakeLogger(),
      {
        getManager: () => runningManager,
        getExistingClient: () => null,
        createClient: () => probe,
      },
    );
    const inspections = await inspector.inspectBootedRunners();
    expect(inspections[0]?.supportedCommands).toBeNull();
    expect(inspections[0]?.supportedFeatures).toBeNull();
    const result = await checkIosCtrlProxyRunner({
      ...baseDependencies,
      runnerInspector: { inspectBootedRunners: async () => inspections },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("versionStatus=unknown");
  });

  test("filters unrelated booted simulators before creating a runner manager or client", async () => {
    const managerDevices: string[] = [];
    const clientDevices: string[] = [];
    const hooks: IosRunnerInspectorHooks = {
      getManager: (device) => {
        managerDevices.push(device.deviceId);
        return runningManager;
      },
      getExistingClient: () => null,
      createClient: (device) => {
        clientDevices.push(device.deviceId);
        return {
          getRunnerIdentityForDiagnostics: async () => ({
            commands: [...IOS_RUNNER_FEATURE_COMMANDS],
            features: [...IOS_RUNNER_FEATURE_FLAGS],
          }),
          close: async () => {},
        };
      },
    };

    const inspector = createIosCtrlProxyRunnerInspector(
      () =>
        simctlReturning([
          { name: "Unrelated", deviceId: "SIM-OTHER" },
          { name: "Target", deviceId: "SIM-TARGET" },
        ]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedRunners("SIM-TARGET");

    expect(inspections.map((inspection) => inspection.deviceId)).toEqual(["SIM-TARGET"]);
    expect(managerDevices).toEqual(["SIM-TARGET"]);
    expect(clientDevices).toEqual(["SIM-TARGET"]);
  });
});

describe("createIosObserveRoundTripInspector lifecycle", () => {
  test.each(["request", "convert", "collect", "close"])(
    "preserves partial observations and cleanup when %s fails",
    async (failure) => {
      const calls: string[] = [];
      const log = new FakeLogger();
      const hooks: IosObserveRoundTripInspectorHooks = {
        getManager: () => ({
          getServicePort: () => 8790,
          discoverRunnerPort: async () => {
            calls.push("discover");
            return 8790;
          },
          isInstalled: async () => {
            calls.push("installed");
            return true;
          },
        }),
        getExistingClient: () => null,
        createClient: () => ({
          getConnectionPortForDiagnostics: () => 8791,
          requestHierarchySyncForDiagnostics: async () => {
            calls.push("request");
            if (failure === "request") {
              throw new Error("request failed");
            }
            return { hierarchy: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} } };
          },
          convertToViewHierarchyResult: () => {
            calls.push("convert");
            if (failure === "convert") {
              throw new Error("convert failed");
            }
            return { hierarchy: {}, screenWidth: 390, screenHeight: 844 };
          },
          close: async () => {
            calls.push("close");
            if (failure === "close") {
              throw new Error("close failed");
            }
          },
        }),
        elementsBuilder: new ObserveElementsBuilder({
          collect: () => {
            calls.push("collect");
            if (failure === "collect") {
              throw new Error("collect failed");
            }
            return undefined;
          },
        }),
      };
      const simctl = baseDependencies.createSimctlClient();
      const booted = spyOn(simctl, "getBootedSimulators").mockResolvedValue([
        { name: "iPhone", platform: "ios", deviceId: "SIM-1" },
      ]);
      try {
        const inspections = await createIosObserveRoundTripInspector(
          () => simctl,
          log,
          hooks,
        ).inspectBootedObserveRoundTrips();
        expect(calls).toEqual([
          "discover",
          "installed",
          "request",
          ...(failure === "request" ? [] : ["convert"]),
          ...(failure === "request" || failure === "convert" ? [] : ["collect"]),
          "close",
        ]);
        expect(inspections[0]).toMatchObject({
          connected: failure !== "request",
          runnerPort: 8790,
          clientPort: 8791,
          hierarchyError: `${failure} failed`,
          elementCount: 0,
          screenSize:
            failure === "collect" || failure === "close"
              ? { width: 390, height: 844 }
              : { width: 0, height: 0 },
        });
        expect(log.at("warn")).toHaveLength(1);
      } finally {
        booted.mockRestore();
      }
    },
  );

  test("reports zero elements and closes the probe when the collector returns undefined", async () => {
    let closes = 0;
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        isInstalled: async () => true,
        getServicePort: () => 8790,
        discoverRunnerPort: async () => 8790,
      }),
      getExistingClient: () => null,
      createClient: () => ({
        getConnectionPortForDiagnostics: () => 8790,
        requestHierarchySyncForDiagnostics: async () => ({
          hierarchy: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} },
        }),
        convertToViewHierarchyResult: () => ({
          hierarchy: {},
          screenWidth: 390,
          screenHeight: 844,
        }),
        close: async () => {
          closes += 1;
        },
      }),
      elementsBuilder: new ObserveElementsBuilder({ collect: () => undefined }),
    };
    const simctl = baseDependencies.createSimctlClient();
    const available = spyOn(simctl, "isAvailable").mockResolvedValue(true);
    const booted = spyOn(simctl, "getBootedSimulators").mockResolvedValue([
      { name: "iPhone", platform: "ios", deviceId: "SIM-1" },
    ]);
    try {
      const inspections = await createIosObserveRoundTripInspector(
        () => simctl,
        new FakeLogger(),
        hooks,
      ).inspectBootedObserveRoundTrips();

      expect(inspections).toEqual([
        {
          deviceId: "SIM-1",
          name: "iPhone",
          runnerPort: 8790,
          clientPort: 8790,
          connected: true,
          screenSize: { width: 390, height: 844 },
          hierarchyError: null,
          elementCount: 0,
        },
      ]);
      expect(closes).toBe(1);
    } finally {
      available.mockRestore();
      booted.mockRestore();
    }
  });

  const simctlReturning = (devices: { name: string; deviceId: string }[]) => ({
    ...baseDependencies.createSimctlClient(),
    isAvailable: async () => true,
    getBootedSimulators: async () =>
      devices.map((d) => ({ name: d.name, platform: "ios" as const, deviceId: d.deviceId })),
  });

  const runningManager = {
    isInstalled: async () => true,
    isRunning: async () => true,
    getServicePort: () => 8790,
    discoverRunnerPort: async () => 8790,
  };
  const viewHierarchy = {
    hierarchy: { node: { $: { text: "Home" } } },
    screenWidth: 390,
    screenHeight: 844,
  };
  const elementsBuilder = {
    build: () => ({
      clickable: [{ index: 0 }],
      scrollable: [],
      text: [{ index: 1 }],
      media: [],
    }),
  } as any;

  test("bounds a never-settling runner port probe by the doctor deadline", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    const probeStarted = Promise.withResolvers<void>();
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        ...runningManager,
        discoverRunnerPort: async () => {
          probeStarted.resolve();
          return await new Promise<never>(() => {});
        },
      }),
      getExistingClient: () => null,
      createClient: () => {
        throw new Error("must not create a client after the deadline");
      },
      elementsBuilder,
    };
    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );

    const inspection = inspector.inspectBootedObserveRoundTrips(undefined, deadline.probe);
    await probeStarted.promise;
    timer.advanceTime(50);

    await expect(inspection).rejects.toThrow("Doctor diagnostic deadline elapsed");
    deadline.dispose();
  });

  test("passes the manager service port to the probe factory and closes the probe", async () => {
    let closes = 0;
    const requestedPorts: number[] = [];
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => runningManager,
      getExistingClient: () => null,
      createClient: (_device, port) => {
        requestedPorts.push(port);
        return {
          getConnectionPortForDiagnostics: () => port,
          requestHierarchySyncForDiagnostics: async () => ({
            hierarchy: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} } as any,
          }),
          convertToViewHierarchyResult: () => viewHierarchy as any,
          close: async () => {
            closes += 1;
          },
        };
      },
      elementsBuilder,
    };

    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedObserveRoundTrips();

    expect(requestedPorts).toEqual([8790]);
    expect(closes).toBe(1);
    expect(inspections[0]).toEqual({
      deviceId: "SIM-1",
      name: "iPhone 15",
      runnerPort: 8790,
      clientPort: 8790,
      connected: true,
      screenSize: { width: 390, height: 844 },
      hierarchyError: null,
      elementCount: 2,
    });
  });

  test("does not close a pre-existing client and reports its actual client port", async () => {
    let closes = 0;
    let created = false;
    const existing = {
      getConnectionPortForDiagnostics: () => 8765,
      requestHierarchySyncForDiagnostics: async () => ({
        hierarchy: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} } as any,
      }),
      convertToViewHierarchyResult: () => viewHierarchy as any,
      close: async () => {
        closes += 1;
      },
    };
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => runningManager,
      getExistingClient: () => existing,
      createClient: () => {
        created = true;
        return existing;
      },
      elementsBuilder,
    };

    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedObserveRoundTrips();

    expect(created).toBe(false);
    expect(closes).toBe(0);
    expect(inspections[0].runnerPort).toBe(8790);
    expect(inspections[0].clientPort).toBe(8765);
  });

  test("uses a healthy resident client when manager port state no longer reaches its runner", async () => {
    const existing = {
      getConnectionPortForDiagnostics: () => 8765,
      requestHierarchySyncForDiagnostics: async () => ({
        hierarchy: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} } as any,
      }),
      convertToViewHierarchyResult: () => viewHierarchy as any,
      close: async () => {},
    };
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        isInstalled: async () => true,
        isRunning: async () => false,
        getServicePort: () => 8767,
        discoverRunnerPort: async () => 8765,
      }),
      getExistingClient: () => existing,
      createClient: () => {
        throw new Error("should use the resident client");
      },
      elementsBuilder,
    };

    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedObserveRoundTrips();

    expect(inspections[0]).toMatchObject({
      runnerPort: 8765,
      clientPort: 8765,
      connected: true,
      hierarchyError: null,
      elementCount: 2,
    });
  });

  test("reports the client port after the hierarchy request can resync it", async () => {
    let currentClientPort = 8765;
    const existing = {
      getConnectionPortForDiagnostics: () => currentClientPort,
      requestHierarchySyncForDiagnostics: async () => {
        currentClientPort = 8790;
        return { hierarchy: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} } as any };
      },
      convertToViewHierarchyResult: () => viewHierarchy as any,
      close: async () => {},
    };
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => runningManager,
      getExistingClient: () => existing,
      createClient: () => existing,
      elementsBuilder,
    };

    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedObserveRoundTrips();

    expect(inspections[0].clientPort).toBe(8790);
  });

  test("does not create a client when the runner is not running", async () => {
    let created = false;
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        isInstalled: async () => true,
        isRunning: async () => false,
        getServicePort: () => 8790,
        discoverRunnerPort: async () => null,
      }),
      getExistingClient: () => null,
      createClient: () => {
        created = true;
        throw new Error("should not create client for stopped runner");
      },
      elementsBuilder,
    };

    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedObserveRoundTrips();

    expect(created).toBe(false);
    expect(inspections[0].connected).toBe(false);
    expect(inspections[0].hierarchyError).toBe("iOS CtrlProxy runner is not running");
  });

  test("connects to the discovered host port despite stale manager allocation", async () => {
    const requestedPorts: number[] = [];
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        isInstalled: async () => true,
        getServicePort: () => 8765,
        discoverRunnerPort: async () => 8768,
      }),
      getExistingClient: () => null,
      createClient: (_device, port) => {
        requestedPorts.push(port);
        return {
          getConnectionPortForDiagnostics: () => port,
          requestHierarchySyncForDiagnostics: async () => ({
            hierarchy: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} },
          }),
          convertToViewHierarchyResult: () => viewHierarchy,
          close: async () => {},
        };
      },
      elementsBuilder,
    };
    const simctl = baseDependencies.createSimctlClient();
    const available = spyOn(simctl, "isAvailable").mockResolvedValue(true);
    const booted = spyOn(simctl, "getBootedSimulators").mockResolvedValue([
      { name: "iPhone", platform: "ios", deviceId: "SIM-1" },
    ]);
    try {
      const inspections = await createIosObserveRoundTripInspector(
        () => simctl,
        new FakeLogger(),
        hooks,
      ).inspectBootedObserveRoundTrips();
      expect(requestedPorts).toEqual([8768]);
      expect(inspections[0]).toMatchObject({
        runnerPort: 8768,
        clientPort: 8768,
        connected: true,
        hierarchyError: null,
      });
    } finally {
      available.mockRestore();
      booted.mockRestore();
    }
  });

  test("uses the answering host port without requiring a self-reported port", async () => {
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        isInstalled: async () => true,
        isRunning: async () => true,
        getServicePort: () => 8790,
        discoverRunnerPort: async () => 8790,
      }),
      getExistingClient: () => null,
      createClient: (_device, port) => ({
        getConnectionPortForDiagnostics: () => port,
        requestHierarchySyncForDiagnostics: async () => ({
          hierarchy: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} } as any,
        }),
        convertToViewHierarchyResult: () => viewHierarchy as any,
        close: async () => {},
      }),
      elementsBuilder,
    };

    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedObserveRoundTrips();

    // No reported port → runnerPort falls back to the service port so a healthy
    // runner is not falsely flagged as a mismatch.
    expect(inspections[0].runnerPort).toBe(8790);
    expect(inspections[0].clientPort).toBe(8790);
    expect(inspections[0].connected).toBe(true);
  });
});
