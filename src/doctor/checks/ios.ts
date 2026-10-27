/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from "node:path";
import { CheckResult, DoctorOptions } from "../types";
import { errorMessage } from "../../utils/describeUnknownError";
import type { DoctorProbeOptions } from "../types";
import { awaitDoctorProbe, remainingDoctorProbe } from "../deadline";
import {
  formatCoreDeviceVersion,
  parseCoreDeviceVersion,
  type CoreDeviceCapabilities,
  type SimulatorBootSummary,
  REQUIRED_SIMULATOR_COREDEVICE_VERSION,
} from "../../utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import { checkDevicectlAvailability } from "../../utils/ios-cmdline-tools/DevicectlDeviceLister";
import { compareSimctlVersions } from "../../utils/ios-cmdline-tools/simctlVersion";
import { checkIosSimulatorFleetCost } from "./iosSimFleet";
import { DOCTOR_EXEC_TIMEOUT_MS } from "../../utils/diagnosticTimeouts";
import { createIosDoctorDependencies } from "./iosDoctorDependencies";
import { checkIosCtrlProxyRunner, checkIosObserveRoundTrip } from "./iosRunnerChecks";
import { checkIosNetworkFilter } from "./iosNetworkFilterChecks";

// Re-exported so doctor consumers (and tests) can reference the feature command
// set without reaching into the runner client module.
export {
  IOS_RUNNER_FEATURE_COMMANDS,
  IOS_RUNNER_FEATURE_FLAGS,
} from "../../features/observe/ios/IOSCtrlProxyClient";
export { DOCTOR_EXEC_TIMEOUT_MS } from "../../utils/diagnosticTimeouts";
export { createIosDoctorDependencies, type IosDoctorDependencies } from "./iosDoctorDependencies";
export {
  createIosCtrlProxyRunnerInspector,
  createIosObserveRoundTripInspector,
  type IosRunnerInspection,
  type IosCtrlProxyRunnerInspector,
  type IosObserveRoundTripInspection,
  type IosObserveRoundTripInspector,
  type IosRunnerInspectorHooks,
  type IosObserveRoundTripInspectorHooks,
} from "./iosRunnerInspectors";
export { checkIosCtrlProxyRunner, checkIosObserveRoundTrip } from "./iosRunnerChecks";
export { checkIosNetworkFilter } from "./iosNetworkFilterChecks";

const MIN_XCODE_VERSION = "15.0";

function parseXcodeVersion(output: string): string | null {
  const match = output.match(/Xcode\s+([0-9]+(?:\.[0-9]+)*)/);
  return match ? match[1] : null;
}

function compareVersions(current: string, minimum: string): number {
  const currentParts = current.split(".").map((part) => Number(part));
  const minimumParts = minimum.split(".").map((part) => Number(part));
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
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  if (dependencies.platform() !== "darwin") {
    return {
      name: "Xcode",
      status: "skip",
      message: "iOS development requires macOS",
    };
  }

  try {
    const currentProbe = remainingDoctorProbe(probe);
    const result = await dependencies.xcodebuild.executeCommand(["-version"], {
      timeoutMs: currentProbe.timeoutMs ?? DOCTOR_EXEC_TIMEOUT_MS,
      signal: currentProbe.signal,
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

    // A slow `xcodebuild -version` probe (issue #6003) must be diagnosed
    // distinctly from a missing/unusable Xcode: it should not force a nonzero
    // doctor verdict that blocks readiness-gate callers. Only a genuine
    // timeout maps to `warn`; every other failure stays a `fail`.
    if (isTimeoutError(error)) {
      return {
        name: "Xcode",
        status: "warn",
        message:
          `Xcode availability probe timed out after ${DOCTOR_EXEC_TIMEOUT_MS}ms ` +
          `(xcodebuild -version); Command Line Tools and simulator automation may still be usable`,
        recommendation:
          "A slow probe is not a missing install — re-run doctor. If it keeps timing out, " +
          "raise AUTOMOBILE_DOCTOR_TIMEOUT_MS to give xcodebuild more time.",
      };
    }

    return {
      name: "Xcode",
      status: "fail",
      message: `Xcode not detected: ${errorMessage(error)}`,
      recommendation: `Install Xcode ${minimumVersion}+ from the App Store.`,
    };
  }
}

/**
 * A timed-out probe is distinct from a missing/unusable install (issue #6003).
 * There is no typed timeout error at this seam, so match the message the way
 * the rest of the repo does (e.g. CtrlProxyManager's `errorLower.includes`).
 */
function isTimeoutError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

/**
 * Check Xcode Command Line Tools
 */
export async function checkXcodeCommandLineTools(
  options: DoctorOptions = {},
  dependencies = createIosDoctorDependencies(),
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
    const probe = remainingDoctorProbe(options);
    const result = await dependencies.execFile("xcode-select", ["-p"], probe);
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
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  if (dependencies.platform() !== "darwin") {
    return {
      name: "xcrun",
      status: "skip",
      message: "iOS development requires macOS",
    };
  }

  try {
    const simctl = dependencies.createSimctlClient();
    const available = await simctl.isAvailable(remainingDoctorProbe(probe));
    if (!available) {
      throw new Error("xcrun could not locate simctl");
    }
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
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
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
    const currentProbe = remainingDoctorProbe(probe);
    const available = await simctl.isAvailable({
      signal: currentProbe.signal,
      timeoutMs: currentProbe.timeoutMs,
    });

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

export type CoreDeviceDiagnostic = (
  | { status: "meets-requirement"; version: string }
  | { status: "below-required"; version: string }
  | { status: "non-darwin"; reason: string }
  | { status: "missing"; reason: string }
  | { status: "unparsable"; reason: string }
) & { simulatorBootState?: SimulatorBootSummary; capabilities?: CoreDeviceCapabilities };

/** Preserve the bounded availability read; only capability state stays lazy. */
export async function probeCoreDeviceVersion(
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CoreDeviceDiagnostic> {
  if (dependencies.platform() !== "darwin") {
    return { status: "non-darwin", reason: "iOS development requires macOS" };
  }
  const capabilityProbe = dependencies.getCoreDeviceProbe();
  const measured = await capabilityProbe.refreshVersion(async () => {
    const availability = await checkDevicectlAvailability({
      platform: dependencies.platform,
      invoke: dependencies.execFile,
      logger: dependencies.logger,
      probe: remainingDoctorProbe(probe),
    });
    if (availability.status !== "pass") {
      return { kind: "unavailable", reasonKind: "missing", reason: availability.message };
    }
    const version = parseCoreDeviceVersion(String(availability.value ?? ""));
    if (!version) {
      const reason = "devicectl returned an unrecognized CoreDevice version";
      dependencies.logger.warn(`CoreDevice version check failed: ${reason}`);
      return { kind: "unavailable", reasonKind: "unparsable", reason };
    }
    return { kind: "available", version };
  });
  let simulatorBootState: SimulatorBootSummary;
  try {
    simulatorBootState = await awaitDoctorProbe(probe, () =>
      capabilityProbe.readSimulatorBootState(remainingDoctorProbe(probe)),
    );
  } catch (error) {
    dependencies.logger.warn(
      `CoreDevice simulator state read failed: ${errorMessage(error)}`,
      error,
    );
    simulatorBootState = { status: "unavailable", reason: errorMessage(error) };
  }
  const state = { simulatorBootState, capabilities: capabilityProbe.getCapabilities() };
  if (measured.kind === "unavailable") {
    return { status: measured.reasonKind ?? "missing", reason: measured.reason, ...state };
  }
  return {
    status:
      compareSimctlVersions(measured.version, REQUIRED_SIMULATOR_COREDEVICE_VERSION) >= 0
        ? "meets-requirement"
        : "below-required",
    version: formatCoreDeviceVersion(measured.version),
    ...state,
  };
}

function describeCoreDeviceState(result: CoreDeviceDiagnostic): string {
  const boot = result.simulatorBootState;
  const bootState =
    boot?.status === "available"
      ? `${boot.booted} booted, ${boot.shutdown} shutdown, ${boot.unknown} unknown`
      : `unavailable (${boot?.reason ?? "simulator state unavailable"})`;
  const capabilities = result.capabilities?.entries.length
    ? result.capabilities.entries
        .map((entry) => `${entry.featureId ?? entry.command} ${entry.status} (${entry.scope})`)
        .join(", ")
    : "not probed";
  return `simulator boot state: ${bootState}; capabilities: ${capabilities}`;
}

export async function checkCoreDeviceVersion(
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  const name = "CoreDevice";
  const required = formatCoreDeviceVersion(REQUIRED_SIMULATOR_COREDEVICE_VERSION);
  let unchecked = "simulator boot state: unavailable; capabilities: not probed";
  const unavailable =
    "devicectl-only simulator features will be unavailable; simctl-based features are unaffected";
  try {
    const result = await probeCoreDeviceVersion(dependencies, probe);
    unchecked = describeCoreDeviceState(result);
    if (result.status === "non-darwin") {
      return { name, status: "skip", message: `${result.reason}; ${unchecked}`, detail: unchecked };
    }
    if (result.status === "missing") {
      return {
        name,
        status: "warn",
        message: `devicectl missing: ${result.reason}; ${unavailable}; ${unchecked}`,
        detail: unchecked,
      };
    }
    if (result.status === "unparsable") {
      return {
        name,
        status: "warn",
        message: `CoreDevice version unreadable: ${result.reason}; ${unavailable}; ${unchecked}`,
        detail: unchecked,
      };
    }
    if (result.status === "below-required") {
      return {
        name,
        status: "warn",
        message: `CoreDevice ${result.version} installed (below required); requires CoreDevice >= ${required}; ${unavailable}; ${unchecked}`,
        detail: unchecked,
        value: result.version,
      };
    }
    return {
      name,
      status: "pass",
      message: `CoreDevice ${result.version} installed (requires CoreDevice >= ${required}); ${unchecked}`,
      detail: unchecked,
      value: result.version,
    };
  } catch (error) {
    dependencies.logger.warn(`CoreDevice version check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "warn",
      message: `CoreDevice version unreadable: ${errorMessage(error)}; ${unavailable}; ${unchecked}`,
      detail: unchecked,
    };
  }
}

/**
 * Check available iOS simulator runtimes
 */
export async function checkSimulatorRuntimes(
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
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
  const currentProbe = remainingDoctorProbe(probe);
  if (
    !(await simctl.isAvailable({
      signal: currentProbe.signal,
      timeoutMs: currentProbe.timeoutMs,
    }))
  ) {
    return {
      name,
      status: "skip",
      message: "simctl not available",
    };
  }

  try {
    const runtimes = await simctl.getRuntimesChecked(currentProbe.timeoutMs, currentProbe.signal);
    const iosRuntimes = runtimes
      .filter((runtime) => runtime.isAvailable)
      .filter((runtime) => runtime.name.startsWith("iOS"));

    if (iosRuntimes.length === 0) {
      return {
        name,
        status: "fail",
        message: "No iOS simulator runtimes available",
        recommendation: "Install an iOS Simulator runtime in Xcode Settings > Platforms.",
      };
    }

    const runtimeNames = iosRuntimes.map((runtime) => runtime.name).join(", ");
    return {
      name,
      status: "pass",
      message: `iOS runtimes available: ${runtimeNames}`,
      value: iosRuntimes.length,
    };
  } catch (error) {
    remainingDoctorProbe(probe);
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
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
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
    const currentProbe = remainingDoctorProbe(probe);
    const identities = await dependencies.securityClient.listCodeSigningIdentities({
      signal: currentProbe.signal,
      timeoutMs: currentProbe.timeoutMs ?? DOCTOR_EXEC_TIMEOUT_MS,
    });
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
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  const name = "Security CLI";
  if (dependencies.platform() !== "darwin") {
    return { name, status: "skip", message: "macOS security is only available on macOS" };
  }

  try {
    const currentProbe = remainingDoctorProbe(probe);
    const diagnostics = await dependencies.securityClient.getDiagnostics({
      signal: currentProbe.signal,
      timeoutMs: currentProbe.timeoutMs ?? DOCTOR_EXEC_TIMEOUT_MS,
    });
    if (diagnostics.available) {
      return {
        name,
        status: "pass",
        message: "macOS security CLI available (the tool does not report a standalone version)",
        value: diagnostics.version,
      };
    }
    return {
      name,
      status: "fail",
      message: "macOS security CLI is unavailable",
      recommendation: "Install or repair the macOS command line tools, then re-run doctor.",
    };
  } catch (error) {
    dependencies.logger.warn(`Security CLI check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "fail",
      message: "Could not check macOS security CLI availability",
      recommendation: "Install or repair the macOS command line tools, then re-run doctor.",
    };
  }
}

/**
 * Check Apple Developer account presence (optional)
 */
export async function checkAppleDeveloperAccount(
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
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
    const entries = await awaitDoctorProbe(probe, () => dependencies.readDir(accountsPath));
    const visibleEntries = entries.filter((entry) => entry.trim().length > 0);
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
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  const name = "Provisioning Profiles";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "Provisioning profiles only available on macOS",
    };
  }

  const profilesPath = join(
    dependencies.homedir(),
    "Library",
    "MobileDevice",
    "Provisioning Profiles",
  );
  try {
    const entries = await awaitDoctorProbe(probe, () => dependencies.readDir(profilesPath));
    const profiles = entries.filter((entry) => entry.endsWith(".mobileprovision"));

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
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
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
    const currentProbe = remainingDoctorProbe(probe);

    if (
      !(await simctl.isAvailable({
        signal: currentProbe.signal,
        timeoutMs: currentProbe.timeoutMs,
      }))
    ) {
      return {
        name: "Booted Simulators",
        status: "skip",
        message: "simctl not available",
      };
    }

    const simulators = await simctl.getBootedSimulatorsChecked(
      currentProbe.timeoutMs,
      currentProbe.signal,
    );

    if (simulators.length === 0) {
      return {
        name: "Booted Simulators",
        status: "pass",
        message: "No simulators currently running",
        value: 0,
      };
    }

    const simNames = simulators.map((s) => s.name).join(", ");
    return {
      name: "Booted Simulators",
      status: "pass",
      message: `${simulators.length} simulator(s) running: ${simNames}`,
      value: simulators.length,
    };
  } catch (error) {
    remainingDoctorProbe(probe);
    dependencies.logger.warn(`Booted simulators check failed: ${errorMessage(error)}`, error);
    return {
      name: "Booted Simulators",
      status: "skip",
      message: `Could not check simulators: ${errorMessage(error)}`,
    };
  }
}

export async function runIosChecks(
  options: DoctorOptions = {},
  dependencies = createIosDoctorDependencies(),
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const run = async (check: () => Promise<CheckResult>): Promise<void> => {
    remainingDoctorProbe(options);
    results.push(await check());
    remainingDoctorProbe(options);
  };

  await run(() => checkXcodeInstallation(MIN_XCODE_VERSION, dependencies, options));
  await run(() => checkXcodeCommandLineTools(options, dependencies));
  await run(() => checkXcrunAvailable(dependencies, options));
  await run(() => checkSimctlAvailable(dependencies, options));
  await run(() => checkCoreDeviceVersion(dependencies, options));
  await run(() => checkSimulatorRuntimes(dependencies, options));
  await run(() => checkSecurityCli(dependencies, options));
  await run(() => checkCodeSigning(dependencies, options));
  await run(() => checkAppleDeveloperAccount(dependencies, options));
  await run(() => checkProvisioningProfiles(dependencies, options));
  await run(() => checkBootedSimulators(dependencies, options));
  if (dependencies.simFleet) {
    const simFleet = dependencies.simFleet;
    await run(() => checkIosSimulatorFleetCost(simFleet, options));
  }
  await run(() => checkIosCtrlProxyRunner(dependencies, options));
  await run(() => checkIosObserveRoundTrip(dependencies, options));
  await run(() => checkIosNetworkFilter(dependencies, options));

  return results;
}

/** Run only host-wide iOS tooling checks after repair. */
export async function runPostRepairIosChecks(
  options: DoctorOptions = {},
  dependencies = createIosDoctorDependencies(),
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const run = async (check: () => Promise<CheckResult>): Promise<void> => {
    remainingDoctorProbe(options);
    results.push(await check());
    remainingDoctorProbe(options);
  };

  await run(() => checkXcodeInstallation(MIN_XCODE_VERSION, dependencies, options));
  await run(() => checkXcodeCommandLineTools(options, dependencies));
  await run(() => checkXcrunAvailable(dependencies, options));
  await run(() => checkSimctlAvailable(dependencies, options));
  await run(() => checkCoreDeviceVersion(dependencies, options));
  await run(() => checkSimulatorRuntimes(dependencies, options));
  return results;
}
