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
import { logger, type Logger } from "../../utils/logger";
import { IOS_CTRL_PROXY_RELEASE_VERSION, resolveAssetVersion } from "../../constants/release";
import { IOSCtrlProxyManager } from "../../utils/IOSCtrlProxyManager";
import { IOSCtrlProxyClient, IOS_RUNNER_FEATURE_COMMANDS } from "../../features/observe/ios/IOSCtrlProxyClient";

// Re-exported so doctor consumers (and tests) can reference the feature command
// set without reaching into the runner client module.
export { IOS_RUNNER_FEATURE_COMMANDS };

const MIN_XCODE_VERSION = "15.0";

const IOS_RUNNER_REBUILD_RECOMMENDATION =
  "Rebuild and redeploy the iOS CtrlProxy runner: run scripts/ios/ctrl-proxy-build-for-testing.sh " +
  "and point AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH at the rebuilt bundle, or run the iOS hot-reload " +
  "watcher with --manage-ios-runner.";

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
  fileExists: (path: string) => boolean;
  readDir: (path: string) => Promise<string[]>;
  homedir: () => string;
  logger: Logger;
  createSimctlClient: () => SimCtl;
  runnerInspector: IosCtrlProxyRunnerInspector;
}

/**
 * Real inspector: for each booted simulator, read installed/running from the
 * CtrlProxy manager and the advertised command set from the runner's `connected`
 * handshake (connecting only when the runner is running).
 */
function createIosCtrlProxyRunnerInspector(
  createSimctlClient: () => SimCtl,
  log: Logger
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
        const manager = IOSCtrlProxyManager.getInstance(device);
        const installed = await manager.isInstalled();
        const running = installed ? await manager.isRunning() : false;

        let supportedCommands: string[] | null = null;
        if (running) {
          try {
            const client = IOSCtrlProxyClient.getInstance(device);
            supportedCommands = await client.getSupportedCommands();
          } catch (error) {
            // Treated as an unreachable runner (versionStatus=unknown), not a hard
            // failure: doctor still reports installed/running for the simulator.
            log.warn(
              `iOS CtrlProxy runner command probe failed for ${simulator.deviceId}: ${normalizeErrorMessage(error)}`,
              error
            );
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

const createExecResult = (stdout: string, stderr: string): ExecResult => ({
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
  }
});

const createIosDoctorDependencies = (): IosDoctorDependencies => ({
  platform: () => process.platform,
  execFile: async (file, args) => {
    const result = await execFileAsync(file, args, {
      timeout: DOCTOR_EXEC_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout.toString();
    const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString();
    return createExecResult(stdout, stderr);
  },
  fileExists: existsSync,
  readDir: async path => fs.readdir(path),
  homedir,
  logger,
  createSimctlClient: () => new SimCtlClient(),
  runnerInspector: createIosCtrlProxyRunnerInspector(() => new SimCtlClient(), logger)
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

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorOutput(error: unknown): string {
  const stdout = typeof (error as { stdout?: string })?.stdout === "string"
    ? (error as { stdout?: string }).stdout
    : "";
  const stderr = typeof (error as { stderr?: string })?.stderr === "string"
    ? (error as { stderr?: string }).stderr
    : "";
  return [stdout, stderr, normalizeErrorMessage(error)].join("\n");
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
    const result = await dependencies.execFile("xcodebuild", ["-version"]);
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
    dependencies.logger.warn(`Xcode installation check failed: ${normalizeErrorMessage(error)}`, error);
    return {
      name: "Xcode",
      status: "fail",
      message: `Xcode not detected: ${normalizeErrorMessage(error)}`,
      recommendation: `Install Xcode ${minimumVersion}+ from the App Store.`,
    };
  }
}

/**
 * Check Xcode Command Line Tools (with optional auto-install)
 */
export async function checkXcodeCommandLineTools(
  options: DoctorOptions = {},
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

  if (options.installXcodeCommandLineTools) {
    try {
      await dependencies.execFile("xcode-select", ["--install"]);
      return {
        name,
        status: "pass",
        message: "Command Line Tools installation started",
        recommendation: "Follow the installer prompt and re-run doctor.",
      };
    } catch (error) {
      const output = errorOutput(error).toLowerCase();
      if (output.includes("already installed")) {
        return {
          name,
          status: "pass",
          message: "Command Line Tools already installed",
        };
      }

      dependencies.logger.warn(`Command Line Tools install failed: ${normalizeErrorMessage(error)}`, error);
      return {
        name,
        status: "fail",
        message: `Command Line Tools install failed: ${normalizeErrorMessage(error)}`,
        recommendation: "Run: xcode-select --install",
      };
    }
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
    dependencies.logger.warn(`Command Line Tools check failed: ${normalizeErrorMessage(error)}`, error);
    return {
      name,
      status: "fail",
      message: `Command Line Tools not available: ${normalizeErrorMessage(error)}`,
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
    dependencies.logger.warn(`xcrun check failed: ${normalizeErrorMessage(error)}`, error);
    return {
      name: "xcrun",
      status: "fail",
      message: `xcrun not functional: ${normalizeErrorMessage(error)}`,
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
    dependencies.logger.warn(`simctl check failed: ${normalizeErrorMessage(error)}`, error);
    return {
      name: "simctl",
      status: "fail",
      message: `simctl check failed: ${normalizeErrorMessage(error)}`,
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
    dependencies.logger.warn(`Simulator runtimes check failed: ${normalizeErrorMessage(error)}`, error);
    return {
      name,
      status: "fail",
      message: `Failed to list runtimes: ${normalizeErrorMessage(error)}`,
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
    const result = await dependencies.execFile("security", ["find-identity", "-v", "-p", "codesigning"]);
    const match = result.stdout.match(/(\d+)\s+valid identities found/);
    const count = match ? Number(match[1]) : 0;

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
    dependencies.logger.warn(`Code signing check failed: ${normalizeErrorMessage(error)}`, error);
    return {
      name,
      status: "warn",
      message: `Code signing check failed: ${normalizeErrorMessage(error)}`,
      recommendation: "Sign in to Xcode and install a development certificate for device testing.",
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
    dependencies.logger.warn(`Apple Developer account check failed: ${normalizeErrorMessage(error)}`, error);
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
    dependencies.logger.warn(`Provisioning profiles check failed: ${normalizeErrorMessage(error)}`, error);
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
    dependencies.logger.warn(`Booted simulators check failed: ${normalizeErrorMessage(error)}`, error);
    return {
      name: "Booted Simulators",
      status: "skip",
      message: `Could not check simulators: ${normalizeErrorMessage(error)}`,
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

    const expectedVersion = resolveAssetVersion(IOS_CTRL_PROXY_RELEASE_VERSION);
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
    dependencies.logger.warn(`iOS CtrlProxy runner check failed: ${normalizeErrorMessage(error)}`, error);
    return {
      name,
      status: "skip",
      message: `Could not check iOS CtrlProxy runner: ${normalizeErrorMessage(error)}`,
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
  results.push(await checkCodeSigning(dependencies));
  results.push(await checkAppleDeveloperAccount(dependencies));
  results.push(await checkProvisioningProfiles(dependencies));
  results.push(await checkBootedSimulators(dependencies));
  results.push(await checkIosCtrlProxyRunner(dependencies));

  return results;
}
