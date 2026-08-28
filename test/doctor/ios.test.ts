import { describe, expect, test } from "bun:test";
import type { IosDoctorDependencies } from "../../src/doctor/checks/ios";
import {
  checkAppleDeveloperAccount,
  checkBootedSimulators,
  checkCodeSigning,
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

const baseDependencies: IosDoctorDependencies = {
  platform: () => "darwin",
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
    getDeviceInfo: async () => null,
    bootSimulator: async () => ({ name: "sim", platform: "ios", deviceId: "123" }),
    getDeviceTypes: async () => [],
    getRuntimes: async () => [],
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

    test("fails when xcodebuild throws", async () => {
      const result = await checkXcodeInstallation("15.0", {
        ...baseDependencies,
        xcodebuild: {
          executeCommand: async () => {
            throw new Error("xcodebuild not found");
          },
        },
      });

      expect(result.status).toBe("fail");
      expect(result.message).toContain("Xcode not detected");
      expect(result.message).toContain("xcodebuild not found");
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
        execFile: async () => createExecResult("xcrun version 75."),
      });

      expect(result.status).toBe("pass");
      expect(result.message).toBe("xcrun functional");
    });

    test("fails when xcrun fails", async () => {
      const result = await checkXcrunAvailable({
        ...baseDependencies,
        execFile: async () => {
          throw new Error("xcrun: error: unable to find utility");
        },
      });

      expect(result.status).toBe("fail");
      expect(result.message).toContain("xcrun not functional");
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
          getRuntimes: async () => [],
        }),
      });

      expect(result.status).toBe("fail");
      expect(result.message).toContain("No iOS simulator runtimes");
    });

    test("passes when iOS runtimes are available", async () => {
      const result = await checkSimulatorRuntimes({
        ...baseDependencies,
        createSimctlClient: () => ({
          ...baseDependencies.createSimctlClient(),
          getRuntimes: async () => [
            {
              bundlePath: "/path",
              buildversion: "21A328",
              runtimeRoot: "/path",
              identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
              version: "17.0",
              isAvailable: true,
              name: "iOS 17.0",
            },
          ],
        }),
      });

      expect(result.status).toBe("pass");
      expect(result.message).toContain("iOS 17.0");
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
      const result = await checkAppleDeveloperAccount({
        ...baseDependencies,
        readDir: async () => ["account.plist"],
      });

      expect(result.status).toBe("pass");
      expect(result.message).toContain("Apple Developer account configured");
    });
  });

  describe("checkProvisioningProfiles", () => {
    test("passes when profiles exist", async () => {
      const result = await checkProvisioningProfiles({
        ...baseDependencies,
        readDir: async () => ["dev.mobileprovision", "dist.mobileprovision"],
      });

      expect(result.status).toBe("pass");
      expect(result.message).toContain("2 provisioning profile(s)");
      expect(result.value).toBe(2);
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
          getBootedSimulators: async () => [
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
          getBootedSimulators: async () => [],
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
        execFile: throwingExecFile,
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
          getRuntimes: async () => {
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

  test("warns when a released runner lacks a current non-command feature", async () => {
    const result = await checkIosCtrlProxyRunner(
      withRunners([inspection({ supportedFeatures: null })]),
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("versionStatus=stale");
    expect(result.message).toContain("missingFeatures=display_cutout_info");
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
    getReportedRunnerPort: async () => 8765,
  };

  test("closes a probe client it created (no pre-existing client)", async () => {
    let closes = 0;
    const probe = {
      getSupportedCommands: async () => [...IOS_RUNNER_FEATURE_COMMANDS],
      getSupportedFeatures: async () => [...IOS_RUNNER_FEATURE_FLAGS],
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
      getSupportedCommands: async () => [...IOS_RUNNER_FEATURE_COMMANDS],
      getSupportedFeatures: async () => [...IOS_RUNNER_FEATURE_FLAGS],
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

  test("closes the created probe client even when the command read throws", async () => {
    let closes = 0;
    const probe = {
      getSupportedCommands: async () => {
        throw new Error("unreachable");
      },
      getSupportedFeatures: async () => null,
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
});

describe("createIosObserveRoundTripInspector lifecycle", () => {
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
    getReportedRunnerPort: async () => 8790,
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
          requestHierarchySync: async () => ({
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
      requestHierarchySync: async () => ({
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

  test("reports the client port after the hierarchy request can resync it", async () => {
    let currentClientPort = 8765;
    const existing = {
      getConnectionPortForDiagnostics: () => currentClientPort,
      requestHierarchySync: async () => {
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
        getReportedRunnerPort: async () => null,
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

  test("reports the runner's actual bound port from the manager, not the client port (#2735)", async () => {
    // #2731 failure mode: the runner binds 8765 while the client/daemon expects
    // 8767. isRunning() probes the client port (8767) and finds nothing, but the
    // runner reports its real bound port (8765) via /health.
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        isInstalled: async () => true,
        isRunning: async () => false,
        getServicePort: () => 8767,
        getReportedRunnerPort: async () => 8765,
      }),
      getExistingClient: () => null,
      createClient: () => {
        throw new Error("should not create client when runner unreachable on client port");
      },
      elementsBuilder,
    };

    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedObserveRoundTrips();

    // runnerPort must reflect the runner's reported bound port, decoupled from
    // the client port, so classifyObserveRoundTrip can detect the mismatch.
    expect(inspections[0].runnerPort).toBe(8765);
    expect(inspections[0].clientPort).toBe(8767);
    expect(inspections[0].connected).toBe(false);
  });

  test("surfaces an actionable mismatch error when the runner is bound to a different port (#2735)", async () => {
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        isInstalled: async () => true,
        isRunning: async () => false,
        getServicePort: () => 8767,
        getReportedRunnerPort: async () => 8765,
      }),
      getExistingClient: () => null,
      createClient: () => {
        throw new Error("should not create client when runner unreachable on client port");
      },
      elementsBuilder,
    };

    const inspector = createIosObserveRoundTripInspector(
      () => simctlReturning([{ name: "iPhone 15", deviceId: "SIM-1" }]) as any,
      new FakeLogger(),
      hooks,
    );
    const inspections = await inspector.inspectBootedObserveRoundTrips();

    expect(inspections[0].hierarchyError).toContain("8765");
    expect(inspections[0].hierarchyError).toContain("8767");
    // The misleading "not running" must not be reported when the runner is alive
    // on another port.
    expect(inspections[0].hierarchyError).not.toBe("iOS CtrlProxy runner is not running");
  });

  test("falls back to the service port when the runner reports no bound port", async () => {
    const hooks: IosObserveRoundTripInspectorHooks = {
      getManager: () => ({
        isInstalled: async () => true,
        isRunning: async () => true,
        getServicePort: () => 8790,
        getReportedRunnerPort: async () => null,
      }),
      getExistingClient: () => null,
      createClient: (_device, port) => ({
        getConnectionPortForDiagnostics: () => port,
        requestHierarchySync: async () => ({
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
