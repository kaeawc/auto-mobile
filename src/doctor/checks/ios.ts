/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BootedDevice, ExecResult } from "../../models";
import { CheckResult, DoctorOptions } from "../types";
import { SimCtl, SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { Xcodebuild, XcodebuildClient } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { logger, type Logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { resolveAssetVersion, resolvePinnedVersion } from "../../constants/release";
import { IOSCtrlProxyBuilder } from "../../utils/IOSCtrlProxyBuilder";
import { IOSCtrlProxyManager } from "../../utils/IOSCtrlProxyManager";
import { IOSCtrlProxyClient, IOS_RUNNER_FEATURE_COMMANDS } from "../../features/observe/ios/IOSCtrlProxyClient";
import { ObserveElementsBuilder } from "../../features/observe/ObserveElementsBuilder";
import type { CtrlProxyHierarchy } from "../../features/observe/ios/types";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import { createExecResult } from "../../utils/execResult";
import { SecurityClient, type SecurityClientApi } from "../../utils/ios-cmdline-tools/SecurityClient";

// Re-exported so doctor consumers (and tests) can reference the feature command
// set without reaching into the runner client module.
export { IOS_RUNNER_FEATURE_COMMANDS };

const MIN_XCODE_VERSION = "15.0";

const IOS_RUNNER_REBUILD_RECOMMENDATION =
  "Rebuild and redeploy the iOS CtrlProxy runner: run scripts/ios/ctrl-proxy-build-for-testing.sh " +
  "— its output lands in the default derived-data path (set AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA " +
  "to the derived-data root only when building to a non-default location). Start the daemon with " +
  "AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true so a missing/mismatched cached bundle metadata does not " +
  "download the released runner over your build. Alternatively, run the iOS hot-reload watcher with " +
  "--manage-ios-runner.";

/** Per-simulator runner identity gathered by the inspector. */
export interface IosRunnerInspection {
  deviceId: string;
  name: string;
  installed: boolean;
  running: boolean;
  /** Advertised command set, or null when the runner could not be reached. */
  supportedCommands: string[] | null;
}

/** Source of booted-simulator runner identities (injectable for tests). */
export interface IosCtrlProxyRunnerInspector {
  inspectBootedRunners(): Promise<IosRunnerInspection[]>;
}

/** Per-simulator result of a real iOS runner observe round trip. */
export interface IosObserveRoundTripInspection {
  deviceId: string;
  name: string;
  runnerPort: number;
  clientPort: number;
  connected: boolean;
  screenSize: { width: number; height: number };
  hierarchyError: string | null;
  elementCount: number;
}

/** Source of booted-simulator iOS observe round trips (injectable for tests). */
export interface IosObserveRoundTripInspector {
  inspectBootedObserveRoundTrips(): Promise<IosObserveRoundTripInspection[]>;
}

type IosRunnerVersionStatus = "compatible" | "stale" | "unknown";

/**
 * Bound every external diagnostic call. Tools like `xcrun`, `security`
 * (keychain), and `xcode-select` can block indefinitely (license prompts, stuck
 * keychain, missing CLT). Without a timeout a single wedged tool hangs the whole
 * `doctor` run. On timeout execFile rejects, which each check already turns into
 * a clean `fail` result. Overridable for slow CI hosts via
 * AUTOMOBILE_DOCTOR_TIMEOUT_MS.
 */
const DOCTOR_EXEC_TIMEOUT_MS = Number(process.env.AUTOMOBILE_DOCTOR_TIMEOUT_MS) || 5000;

const execFileAsync = promisify(execFile);

export interface IosDoctorDependencies {
  platform: () => NodeJS.Platform;
  execFile: (file: string, args: string[]) => Promise<ExecResult>;
  xcodebuild: Pick<Xcodebuild, "executeCommand">;
  fileExists: (path: string) => boolean;
  readDir: (path: string) => Promise<string[]>;
  homedir: () => string;
  securityClient: SecurityClientApi;
  logger: Logger;
  createSimctlClient: () => SimCtl;
  runnerInspector: IosCtrlProxyRunnerInspector;
  observeRoundTripInspector: IosObserveRoundTripInspector;
}

/**
 * Minimal runner-manager surface the inspector needs (install/run probes).
 */
interface IosRunnerManager {
  isInstalled(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  getServicePort(): number;
  /**
   * The port the runner self-reports it is actually bound to (via /health), or
   * null when no matching runner answers. Lets the round-trip check compare the
   * runner's real port against the client port instead of comparing the service
   * port to itself (issue #2735).
   */
  getReportedRunnerPort(): Promise<number | null>;
}

/**
 * Minimal runner-client surface the inspector needs: read the advertised command
 * set and (for throwaway probe clients) close the connection afterwards.
 */
interface IosRunnerProbeClient {
  getSupportedCommands(): Promise<string[] | null>;
  close(): Promise<void>;
}

/** Minimal iOS runner client surface for the doctor observe round-trip check. */
interface IosObserveRoundTripClient {
  getConnectionPortForDiagnostics(): number;
  requestHierarchySync(
    perf?: unknown,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<{ hierarchy: CtrlProxyHierarchy } | null>;
  convertToViewHierarchyResult(hierarchy: CtrlProxyHierarchy): ViewHierarchyResult;
  close(): Promise<void>;
}

/**
 * Injection seam for the inspector's device-side singletons, so the
 * close-only-when-created lifecycle is unit-testable without a real device.
 */
export interface IosRunnerInspectorHooks {
  getManager(device: BootedDevice): IosRunnerManager;
  getExistingClient(deviceId: string): IosRunnerProbeClient | null;
  createClient(device: BootedDevice): IosRunnerProbeClient;
}

/** Injection seam for the iOS observe round-trip inspector. */
export interface IosObserveRoundTripInspectorHooks {
  getManager(device: BootedDevice): IosRunnerManager;
  getExistingClient(deviceId: string): IosObserveRoundTripClient | null;
  createClient(device: BootedDevice, port: number): IosObserveRoundTripClient;
  elementsBuilder: ObserveElementsBuilder;
}

const defaultIosRunnerInspectorHooks: IosRunnerInspectorHooks = {
  getManager: device => IOSCtrlProxyManager.getInstance(device),
  getExistingClient: deviceId => IOSCtrlProxyClient.getExistingInstance(deviceId),
  // Detached (not singleton-registered) so closing it leaves nothing for a later
  // probe to rediscover and reconnect — see IOSCtrlProxyClient.createDetached.
  createClient: device => IOSCtrlProxyClient.createDetached(device),
};

const defaultIosObserveRoundTripInspectorHooks: IosObserveRoundTripInspectorHooks = {
  getManager: device => IOSCtrlProxyManager.getInstance(device),
  getExistingClient: deviceId => IOSCtrlProxyClient.getExistingInstance(deviceId),
  createClient: device => IOSCtrlProxyClient.createDetached(device),
  elementsBuilder: new ObserveElementsBuilder(),
};

/**
 * Real inspector: for each booted simulator, read installed/running from the
 * CtrlProxy manager and the advertised command set from the runner's `connected`
 * handshake (connecting only when the runner is running).
 */
export function createIosCtrlProxyRunnerInspector(
  createSimctlClient: () => SimCtl,
  log: Logger,
  hooks: IosRunnerInspectorHooks = defaultIosRunnerInspectorHooks
): IosCtrlProxyRunnerInspector {
  return {
    async inspectBootedRunners(): Promise<IosRunnerInspection[]> {
      const simctl = createSimctlClient();
      if (!(await simctl.isAvailable())) {
        return [];
      }

      const simulators = await simctl.getBootedSimulators();
      const inspections: IosRunnerInspection[] = [];
      for (const simulator of simulators) {
        const device: BootedDevice = {
          name: simulator.name,
          platform: "ios",
          deviceId: simulator.deviceId,
          source: simulator.source,
        };
        const manager = hooks.getManager(device);
        const installed = await manager.isInstalled();
        const running = installed ? await manager.isRunning() : false;

        let supportedCommands: string[] | null = null;
        if (running) {
          // Don't disturb a client someone else owns (e.g. the daemon's live
          // session): if one already exists, read through it and leave its
          // lifecycle alone. Otherwise open a throwaway probe client and close it
          // afterwards so doctor leaves no persistent runner connection or SDK
          // polling timer behind (especially for the one-shot CLI invocation).
          const existing = hooks.getExistingClient(device.deviceId);
          const probe = existing ?? hooks.createClient(device);
          try {
            supportedCommands = await probe.getSupportedCommands();
          } catch (error) {
            // Treated as an unreachable runner (versionStatus=unknown), not a hard
            // failure: doctor still reports installed/running for the simulator.
            log.warn(
              `iOS CtrlProxy runner command probe failed for ${simulator.deviceId}: ${errorMessage(error)}`,
              error
            );
          } finally {
            if (existing === null) {
              await probe.close();
            }
          }
        }

        inspections.push({
          deviceId: simulator.deviceId,
          name: simulator.name,
          installed,
          running,
          supportedCommands,
        });
      }
      return inspections;
    },
  };
}

/**
 * Real iOS observe round-trip inspector: for every booted simulator, verify the
 * runner is installed/running, connect through the same client-side port path
 * `observe` uses, compare that client port to the runner service port, request a
 * fresh hierarchy, and summarize the same non-degenerate signals users see in
 * `observe`.
 */
export function createIosObserveRoundTripInspector(
  createSimctlClient: () => SimCtl,
  log: Logger,
  hooks: IosObserveRoundTripInspectorHooks = defaultIosObserveRoundTripInspectorHooks
): IosObserveRoundTripInspector {
  return {
    async inspectBootedObserveRoundTrips(): Promise<IosObserveRoundTripInspection[]> {
      const simctl = createSimctlClient();
      if (!(await simctl.isAvailable())) {
        return [];
      }

      const simulators = await simctl.getBootedSimulators();
      const inspections: IosObserveRoundTripInspection[] = [];

      for (const simulator of simulators) {
        const device: BootedDevice = {
          name: simulator.name,
          platform: "ios",
          deviceId: simulator.deviceId,
          source: simulator.source,
        };
        const manager = hooks.getManager(device);
        const servicePort = manager.getServicePort();
        // The runner's *actual* bound port, read from its /health self-report, so
        // a runner that bound the wrong port surfaces as a real mismatch instead
        // of the service port being compared to itself (issue #2735). Falls back
        // to the service port when no runner reports a port (older or unreachable
        // runner) so a healthy runner is never falsely flagged.
        const reportedRunnerPort = await manager.getReportedRunnerPort();
        const runnerPort = reportedRunnerPort ?? servicePort;
        let clientPort = servicePort;
        let connected = false;
        let screenSize = { width: 0, height: 0 };
        let hierarchyError: string | null = null;
        let elementCount = 0;

        try {
          const installed = await manager.isInstalled();
          const running = installed ? await manager.isRunning() : false;
          if (!installed || !running) {
            if (!installed) {
              hierarchyError = "iOS CtrlProxy runner is not installed";
            } else if (reportedRunnerPort !== null && reportedRunnerPort !== servicePort) {
              // The runner is alive but bound to a different port than the client
              // expects — the #2731 failure mode. Surface it explicitly rather
              // than the misleading "not running".
              hierarchyError =
                `iOS CtrlProxy runner is bound to port ${reportedRunnerPort} but the client expects port ${servicePort}`;
            } else {
              hierarchyError = "iOS CtrlProxy runner is not running";
            }
          } else {
            const existing = hooks.getExistingClient(device.deviceId);
            const client = existing ?? hooks.createClient(device, runnerPort);
            try {
              clientPort = client.getConnectionPortForDiagnostics();
              const response = await client.requestHierarchySync(undefined, false, undefined, 5000);
              clientPort = client.getConnectionPortForDiagnostics();
              connected = response !== null;
              if (!response?.hierarchy) {
                hierarchyError = "No iOS hierarchy returned from CtrlProxy runner";
              } else if (response.hierarchy.error) {
                hierarchyError = response.hierarchy.error;
              } else {
                const viewHierarchy = client.convertToViewHierarchyResult(response.hierarchy);
                hierarchyError = viewHierarchy.hierarchy.error ?? null;
                screenSize = {
                  width: viewHierarchy.screenWidth ?? response.hierarchy.screenWidth ?? 0,
                  height: viewHierarchy.screenHeight ?? response.hierarchy.screenHeight ?? 0,
                };
                const elements = hooks.elementsBuilder.build(viewHierarchy, "ios");
                elementCount =
                  elements.clickable.length +
                  elements.scrollable.length +
                  elements.text.length +
                  elements.media.length;
              }
            } finally {
              if (existing === null) {
                await client.close();
              }
            }
          }
        } catch (error) {
          hierarchyError = errorMessage(error);
          log.warn(
            `iOS observe round-trip failed for ${simulator.deviceId}: ${hierarchyError}`,
            error
          );
        }

        inspections.push({
          deviceId: simulator.deviceId,
          name: simulator.name,
          runnerPort,
          clientPort,
          connected,
          screenSize,
          hierarchyError,
          elementCount,
        });
      }

      return inspections;
    },
  };
}

const createIosDoctorDependencies = (): IosDoctorDependencies => ({
  platform: () => process.platform,
  execFile: async (file, args) => {
    const result = await execFileAsync(file, args, {
      timeout: DOCTOR_EXEC_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return createExecResult(result.stdout, result.stderr);
  },
  xcodebuild: new XcodebuildClient(),
  fileExists: existsSync,
  readDir: async path => fs.readdir(path),
  homedir,
  securityClient: new SecurityClient(),
  logger,
  createSimctlClient: () => new SimCtlClient(),
  runnerInspector: createIosCtrlProxyRunnerInspector(() => new SimCtlClient(), logger),
  observeRoundTripInspector: createIosObserveRoundTripInspector(() => new SimCtlClient(), logger)
});

function parseXcodeVersion(output: string): string | null {
  const match = output.match(/Xcode\s+([0-9]+(?:\.[0-9]+)*)/);
  return match ? match[1] : null;
}

function compareVersions(current: string, minimum: string): number {
  const currentParts = current.split(".").map(part => Number(part));
  const minimumParts = minimum.split(".").map(part => Number(part));
  const length = Math.max(currentParts.length, minimumParts.length);

  for (let i = 0; i < length; i++) {
    const currentValue = currentParts[i] ?? 0;
    const minimumValue = minimumParts[i] ?? 0;
    if (currentValue > minimumValue) {
      return 1;
    }
    if (currentValue < minimumValue) {
      return -1;
    }
  }

  return 0;
}


/**
 * Check Xcode installation and minimum version
 */
export async function checkXcodeInstallation(
  minimumVersion: string = MIN_XCODE_VERSION,
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  if (dependencies.platform() !== "darwin") {
    return {
      name: "Xcode",
      status: "skip",
      message: "iOS development requires macOS",
    };
  }

  try {
    const result = await dependencies.xcodebuild.executeCommand(["-version"], {
      timeoutMs: DOCTOR_EXEC_TIMEOUT_MS,
    });
    const version = parseXcodeVersion(result.stdout);

    if (!version) {
      return {
        name: "Xcode",
        status: "fail",
        message: "Unable to determine Xcode version",
        recommendation: `Install Xcode ${minimumVersion}+ from the App Store.`,
      };
    }

    if (compareVersions(version, minimumVersion) < 0) {
      return {
        name: "Xcode",
        status: "fail",
        message: `Xcode ${version} installed (requires ${minimumVersion}+)`,
        recommendation: `Update Xcode to ${minimumVersion}+ and re-run doctor.`,
        value: version,
      };
    }

    return {
      name: "Xcode",
      status: "pass",
      message: `Xcode ${version} installed`,
      value: version,
    };
  } catch (error) {
    dependencies.logger.warn(`Xcode installation check failed: ${errorMessage(error)}`, error);
    return {
      name: "Xcode",
      status: "fail",
      message: `Xcode not detected: ${errorMessage(error)}`,
      recommendation: `Install Xcode ${minimumVersion}+ from the App Store.`,
    };
  }
}

/**
 * Check Xcode Command Line Tools
 */
export async function checkXcodeCommandLineTools(
  _options: DoctorOptions = {},
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  const name = "Command Line Tools";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "iOS development requires macOS",
    };
  }

  try {
    const result = await dependencies.execFile("xcode-select", ["-p"]);
    const developerDir = result.stdout.trim();

    if (!developerDir) {
      return {
        name,
        status: "fail",
        message: "Command Line Tools path not configured",
        recommendation: "Run: xcode-select --install",
      };
    }

    if (!dependencies.fileExists(developerDir)) {
      return {
        name,
        status: "fail",
        message: `Command Line Tools path missing: ${developerDir}`,
        recommendation: "Run: xcode-select --install",
      };
    }

    const message = developerDir.includes("CommandLineTools")
      ? "Command Line Tools installed"
      : "Xcode developer directory selected";

    return {
      name,
      status: "pass",
      message,
      value: developerDir,
    };
  } catch (error) {
    dependencies.logger.warn(`Command Line Tools check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "fail",
      message: `Command Line Tools not available: ${errorMessage(error)}`,
      recommendation: "Run: xcode-select --install",
    };
  }
}

/**
 * Check xcrun availability
 */
export async function checkXcrunAvailable(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  if (dependencies.platform() !== "darwin") {
    return {
      name: "xcrun",
      status: "skip",
      message: "iOS development requires macOS",
    };
  }

  try {
    await dependencies.execFile("xcrun", ["--version"]);
    return {
      name: "xcrun",
      status: "pass",
      message: "xcrun functional",
    };
  } catch (error) {
    dependencies.logger.warn(`xcrun check failed: ${errorMessage(error)}`, error);
    return {
      name: "xcrun",
      status: "fail",
      message: `xcrun not functional: ${errorMessage(error)}`,
      recommendation: "Install Xcode Command Line Tools: xcode-select --install",
    };
  }
}

/**
 * Check if simctl is available (requires Xcode)
 */
export async function checkSimctlAvailable(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  if (dependencies.platform() !== "darwin") {
    return {
      name: "simctl",
      status: "skip",
      message: "iOS development requires macOS",
    };
  }

  try {
    const simctl = dependencies.createSimctlClient();
    const available = await simctl.isAvailable();

    if (available) {
      return {
        name: "simctl",
        status: "pass",
        message: "simctl functional",
      };
    }

    return {
      name: "simctl",
      status: "fail",
      message: "simctl not available",
      recommendation: "Install Xcode Command Line Tools: xcode-select --install",
    };
  } catch (error) {
    dependencies.logger.warn(`simctl check failed: ${errorMessage(error)}`, error);
    return {
      name: "simctl",
      status: "fail",
      message: `simctl check failed: ${errorMessage(error)}`,
      recommendation: "Install Xcode Command Line Tools: xcode-select --install",
    };
  }
}

/**
 * Check available iOS simulator runtimes
 */
export async function checkSimulatorRuntimes(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  const name = "iOS Simulator Runtimes";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "iOS simulators only available on macOS",
    };
  }

  const simctl = dependencies.createSimctlClient();
  if (!(await simctl.isAvailable())) {
    return {
      name,
      status: "skip",
      message: "simctl not available",
    };
  }

  try {
    const runtimes = await simctl.getRuntimes();
    const iosRuntimes = runtimes.filter(runtime => runtime.name.startsWith("iOS"));

    if (iosRuntimes.length === 0) {
      return {
        name,
        status: "fail",
        message: "No iOS simulator runtimes available",
        recommendation: "Install an iOS Simulator runtime in Xcode Settings > Platforms.",
      };
    }

    const runtimeNames = iosRuntimes.map(runtime => runtime.name).join(", ");
    return {
      name,
      status: "pass",
      message: `iOS runtimes available: ${runtimeNames}`,
      value: iosRuntimes.length,
    };
  } catch (error) {
    dependencies.logger.warn(`Simulator runtimes check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "fail",
      message: `Failed to list runtimes: ${errorMessage(error)}`,
      recommendation: "Install an iOS Simulator runtime in Xcode Settings > Platforms.",
    };
  }
}

/**
 * Check code signing identities (optional)
 */
export async function checkCodeSigning(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  const name = "Code Signing Identity";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "Code signing only available on macOS",
    };
  }

  try {
    const identities = await dependencies.securityClient.listCodeSigningIdentities({ timeoutMs: DOCTOR_EXEC_TIMEOUT_MS });
    const count = identities.length;

    if (count > 0) {
      return {
        name,
        status: "pass",
        message: `${count} code signing identity(ies) available`,
        value: count,
      };
    }

    return {
      name,
      status: "warn",
      message: "No code signing identities found",
      recommendation: "Sign in to Xcode and install a development certificate for device testing.",
    };
  } catch (error) {
    dependencies.logger.warn(`Code signing check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "warn",
      message: `Code signing check failed: ${errorMessage(error)}`,
      recommendation: "Sign in to Xcode and install a development certificate for device testing.",
    };
  }
}

/** Check that the centralized macOS security CLI boundary is available. */
export async function checkSecurityCli(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  const name = "Security CLI";
  if (dependencies.platform() !== "darwin") {
    return { name, status: "skip", message: "macOS security is only available on macOS" };
  }

  try {
    const diagnostics = await dependencies.securityClient.getDiagnostics({ timeoutMs: DOCTOR_EXEC_TIMEOUT_MS });
    if (diagnostics.available) {
      return {
        name,
        status: "pass",
        message: "macOS security CLI available (the tool does not report a standalone version)",
        value: diagnostics.version
      };
    }
    return {
      name,
      status: "fail",
      message: "macOS security CLI is unavailable",
      recommendation: "Install or repair the macOS command line tools, then re-run doctor."
    };
  } catch (error) {
    dependencies.logger.warn(`Security CLI check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "fail",
      message: "Could not check macOS security CLI availability",
      recommendation: "Install or repair the macOS command line tools, then re-run doctor."
    };
  }
}

/**
 * Check Apple Developer account presence (optional)
 */
export async function checkAppleDeveloperAccount(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  const name = "Apple Developer Account";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "Apple Developer accounts only available on macOS",
    };
  }

  const accountsPath = join(dependencies.homedir(), "Library", "Developer", "Xcode", "Accounts");
  try {
    const entries = await dependencies.readDir(accountsPath);
    const visibleEntries = entries.filter(entry => entry.trim().length > 0);
    if (visibleEntries.length > 0) {
      return {
        name,
        status: "pass",
        message: "Apple Developer account configured",
      };
    }

    return {
      name,
      status: "warn",
      message: "No Apple Developer account configured",
      recommendation: "Sign in to Xcode to enable device testing.",
    };
  } catch (error) {
    dependencies.logger.warn(`Apple Developer account check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "warn",
      message: "No Apple Developer account configured",
      recommendation: "Sign in to Xcode to enable device testing.",
    };
  }
}

/**
 * Check provisioning profiles (optional)
 */
export async function checkProvisioningProfiles(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  const name = "Provisioning Profiles";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "Provisioning profiles only available on macOS",
    };
  }

  const profilesPath = join(dependencies.homedir(), "Library", "MobileDevice", "Provisioning Profiles");
  try {
    const entries = await dependencies.readDir(profilesPath);
    const profiles = entries.filter(entry => entry.endsWith(".mobileprovision"));

    if (profiles.length > 0) {
      return {
        name,
        status: "pass",
        message: `${profiles.length} provisioning profile(s) available`,
        value: profiles.length,
      };
    }

    return {
      name,
      status: "warn",
      message: "No provisioning profiles found",
      recommendation: "Create a provisioning profile in Xcode to enable device testing.",
    };
  } catch (error) {
    dependencies.logger.warn(`Provisioning profiles check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "warn",
      message: "No provisioning profiles found",
      recommendation: "Create a provisioning profile in Xcode to enable device testing.",
    };
  }
}

/**
 * Check booted iOS simulators
 */
export async function checkBootedSimulators(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  if (dependencies.platform() !== "darwin") {
    return {
      name: "Booted Simulators",
      status: "skip",
      message: "iOS simulators only available on macOS",
    };
  }

  try {
    const simctl = dependencies.createSimctlClient();

    if (!(await simctl.isAvailable())) {
      return {
        name: "Booted Simulators",
        status: "skip",
        message: "simctl not available",
      };
    }

    const simulators = await simctl.getBootedSimulators();

    if (simulators.length === 0) {
      return {
        name: "Booted Simulators",
        status: "pass",
        message: "No simulators currently running",
        value: 0,
      };
    }

    const simNames = simulators.map(s => s.name).join(", ");
    return {
      name: "Booted Simulators",
      status: "pass",
      message: `${simulators.length} simulator(s) running: ${simNames}`,
      value: simulators.length,
    };
  } catch (error) {
    dependencies.logger.warn(`Booted simulators check failed: ${errorMessage(error)}`, error);
    return {
      name: "Booted Simulators",
      status: "skip",
      message: `Could not check simulators: ${errorMessage(error)}`,
      value: 0,
    };
  }
}

interface IosRunnerClassification {
  status: IosRunnerVersionStatus;
  missingCommands: string[];
  line: string;
}

function classifyRunner(
  inspection: IosRunnerInspection,
  expectedVersion: string
): IosRunnerClassification {
  let status: IosRunnerVersionStatus;
  let missingCommands: string[] = [];

  if (!inspection.installed) {
    status = "unknown";
  } else if (!inspection.running) {
    status = "unknown";
  } else if (inspection.supportedCommands === null) {
    status = "unknown";
  } else {
    const advertised = new Set(inspection.supportedCommands);
    missingCommands = IOS_RUNNER_FEATURE_COMMANDS.filter(command => !advertised.has(command));
    status = missingCommands.length === 0 ? "compatible" : "stale";
  }

  const parts = [
    "platform=ios",
    `device=${inspection.deviceId}`,
    `installed=${inspection.installed}`,
    `running=${inspection.running}`,
    `expectedVersion=${expectedVersion}`,
    `versionStatus=${status}`,
  ];
  if (missingCommands.length > 0) {
    parts.push(`missingCommands=${missingCommands.join(",")}`);
  }

  return { status, missingCommands, line: parts.join("; ") };
}

interface IosObserveRoundTripClassification {
  failed: boolean;
  line: string;
}

function classifyObserveRoundTrip(
  inspection: IosObserveRoundTripInspection
): IosObserveRoundTripClassification {
  const hasPortMismatch = inspection.runnerPort !== inspection.clientPort;
  const hasDegenerateScreen =
    inspection.screenSize.width <= 0 || inspection.screenSize.height <= 0;
  const hasHierarchyError = inspection.hierarchyError !== null && inspection.hierarchyError.trim().length > 0;
  const hasNoElements = inspection.elementCount < 1;
  const failed =
    !inspection.connected ||
    hasPortMismatch ||
    hasDegenerateScreen ||
    hasHierarchyError ||
    hasNoElements;

  const parts = [
    "platform=ios",
    `device=${inspection.deviceId}`,
    `runnerPort=${inspection.runnerPort}`,
    `clientPort=${inspection.clientPort}`,
    `connected=${inspection.connected}`,
    `screenSize=${inspection.screenSize.width}x${inspection.screenSize.height}`,
    `elementCount=${inspection.elementCount}`,
    `hierarchyStatus=${hasHierarchyError ? "error" : "ok"}`,
  ];
  if (inspection.hierarchyError) {
    parts.push(`hierarchyError=${inspection.hierarchyError}`);
  }

  return { failed, line: parts.join("; ") };
}

/**
 * Check the iOS CtrlProxy runner on each booted simulator, mirroring the Android
 * CtrlProxy check. Reports installed/running, the expected pinned runner version,
 * and a `versionStatus` derived from the runner's advertised feature command set
 * so a stale runner (e.g. released v0.0.38) is flagged with remediation instead of
 * silently passing.
 */
export async function checkIosCtrlProxyRunner(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  const name = "iOS CtrlProxy Runner";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "iOS simulators only available on macOS",
    };
  }

  try {
    const inspections = await dependencies.runnerInspector.inspectBootedRunners();

    if (inspections.length === 0) {
      return {
        name,
        status: "skip",
        message: "No booted simulators to check",
      };
    }

    // An unverifiable explicit pin is a hard configuration failure — classifyRunner
    // only checks the advertised command set, so without this a running runner would
    // still report `pass` and leave the `doctor --ios` hermetic gate green (#2746).
    if (IOSCtrlProxyBuilder.isPinnedVersionUnverifiable()) {
      return {
        name,
        status: "fail",
        message: `AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the release checksum registry`,
        recommendation: "The pinned CtrlProxy bundle cannot be integrity-verified. Pin a released version, or vendor a trusted bundle via AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH.",
      };
    }

    // Honor AUTOMOBILE_VERSION so a pinned runner is not falsely flagged "stale"
    // against the newest registry entry (#2746).
    const expectedVersion = resolveAssetVersion(resolvePinnedVersion());
    const classifications = inspections.map(inspection => classifyRunner(inspection, expectedVersion));

    const message = classifications.map(classification => classification.line).join(" | ");
    const hasStale = classifications.some(classification => classification.status === "stale");
    const hasUnknown = classifications.some(classification => classification.status === "unknown");

    if (hasStale) {
      return {
        name,
        status: "warn",
        message,
        recommendation: IOS_RUNNER_REBUILD_RECOMMENDATION,
      };
    }

    if (hasUnknown) {
      return {
        name,
        status: "warn",
        message,
        recommendation:
          "Could not confirm the iOS CtrlProxy runner identity. Ensure the runner is installed and " +
          `running, then re-run doctor. ${IOS_RUNNER_REBUILD_RECOMMENDATION}`,
      };
    }

    return {
      name,
      status: "pass",
      message,
    };
  } catch (error) {
    dependencies.logger.warn(`iOS CtrlProxy runner check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "skip",
      message: `Could not check iOS CtrlProxy runner: ${errorMessage(error)}`,
    };
  }
}

/**
 * Exercise the daemon/client-to-runner path that `observe` depends on. This is a
 * hard failure when a booted iOS simulator cannot return a non-degenerate
 * hierarchy, because otherwise doctor reports green for the exact broken state
 * users need it to diagnose.
 */
export async function checkIosObserveRoundTrip(
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult> {
  const name = "iOS Observe Round Trip";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "iOS simulators only available on macOS",
    };
  }

  try {
    const inspections = await dependencies.observeRoundTripInspector.inspectBootedObserveRoundTrips();

    if (inspections.length === 0) {
      return {
        name,
        status: "skip",
        message: "No booted simulators to check",
      };
    }

    const classifications = inspections.map(classifyObserveRoundTrip);
    const message = classifications.map(classification => classification.line).join(" | ");
    const hasFailure = classifications.some(classification => classification.failed);

    if (hasFailure) {
      return {
        name,
        status: "fail",
        message,
        recommendation:
          "Restart the AutoMobile daemon and iOS CtrlProxy runner, then verify the runner WebSocket port " +
          "matches the client port and re-run: auto-mobile --doctor --ios.",
      };
    }

    return {
      name,
      status: "pass",
      message,
    };
  } catch (error) {
    dependencies.logger.warn(`iOS observe round-trip check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "fail",
      message: `Could not check iOS observe round trip: ${errorMessage(error)}`,
      recommendation:
        "Restart the AutoMobile daemon and iOS CtrlProxy runner, then re-run: auto-mobile --doctor --ios.",
    };
  }
}

/**
 * Run all iOS checks
 */
export async function runIosChecks(
  options: DoctorOptions = {},
  dependencies = createIosDoctorDependencies()
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await checkXcodeInstallation(MIN_XCODE_VERSION, dependencies));
  results.push(await checkXcodeCommandLineTools(options, dependencies));
  results.push(await checkXcrunAvailable(dependencies));
  results.push(await checkSimctlAvailable(dependencies));
  results.push(await checkSimulatorRuntimes(dependencies));
  results.push(await checkSecurityCli(dependencies));
  results.push(await checkCodeSigning(dependencies));
  results.push(await checkAppleDeveloperAccount(dependencies));
  results.push(await checkProvisioningProfiles(dependencies));
  results.push(await checkBootedSimulators(dependencies));
  results.push(await checkIosCtrlProxyRunner(dependencies));
  results.push(await checkIosObserveRoundTrip(dependencies));

  return results;
}
