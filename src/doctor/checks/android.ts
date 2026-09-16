/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { existsSync } from "node:fs";
import { CheckResult, DoctorOptions, DoctorProbeOptions } from "../types";
import {
  detectAndroidCommandLineTools,
  getAndroidHomeWithSystemImages,
  getAndroidSdkFromEnvironment,
  getBestAndroidToolsLocation,
  getCmdlineToolsRoot,
  isHomebrewToolsPath,
} from "../../utils/android-cmdline-tools/detection";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import { readSdkManagerVersion } from "../../utils/android-cmdline-tools/SdkManagerClient";
import { logger } from "../../utils/logger";
import type { AndroidToolsLocation } from "../../utils/android-cmdline-tools/detection";
import {
  FileAvdConfigReader,
  MIN_AVD_RAM_MB,
  type AvdConfigReader,
} from "../../utils/android-cmdline-tools/AvdConfigReader";
import type { AdbDeviceState } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { awaitDoctorProbe, remainingDoctorProbe } from "../deadline";

const MIN_CMDLINE_TOOLS_VERSION = [9, 0] as const;
type CmdlineToolsVersionReader = (
  location: AndroidToolsLocation,
  probe?: DoctorProbeOptions,
) => Promise<string | null>;

const readCmdlineToolsVersion: CmdlineToolsVersionReader = async (location, probe) => {
  return readSdkManagerVersion(undefined, location, probe);
};

async function checkCmdlineToolsVersion(
  location: AndroidToolsLocation,
  reader: CmdlineToolsVersionReader,
  probe: DoctorProbeOptions,
): Promise<CheckResult> {
  try {
    const version = await reader(location, probe);
    if (!version) {
      return {
        name: "Android Command Line Tools",
        status: "warn",
        message: "Could not determine cmdline-tools version.",
        recommendation:
          "Install a current Android SDK Command-line Tools package that supports SDK XML v4.",
        value: location.path,
      };
    }
    const parts = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const isSupported =
      parts[0] > MIN_CMDLINE_TOOLS_VERSION[0] ||
      (parts[0] === MIN_CMDLINE_TOOLS_VERSION[0] &&
        (parts[1] ?? 0) >= MIN_CMDLINE_TOOLS_VERSION[1]);
    if (!isSupported) {
      return {
        name: "Android Command Line Tools",
        status: "warn",
        message: `Android cmdline-tools version ${version} is outdated for current SDK XML/device catalogs.`,
        recommendation: "Upgrade to Android SDK Command-line Tools 9.0 or newer.",
        value: location.path,
      };
    }
    return {
      name: "Android Command Line Tools",
      status: "pass",
      message: `Android command line tools detected (version ${version}).`,
      value: location.path,
    };
  } catch (error) {
    logger.warn(`Failed to determine cmdline-tools version: ${errorMessage(error)}`);
    return {
      name: "Android Command Line Tools",
      status: "warn",
      message: `Could not determine cmdline-tools version: ${errorMessage(error)}`,
      recommendation:
        "Install a current Android SDK Command-line Tools package that supports SDK XML v4.",
      value: location.path,
    };
  }
}

export interface AndroidDoctorDependencies {
  detectAndroidCommandLineTools: typeof detectAndroidCommandLineTools;
  getBestAndroidToolsLocation: typeof getBestAndroidToolsLocation;
  getAndroidHomeWithSystemImages: typeof getAndroidHomeWithSystemImages;
  logger: typeof logger;
  adbFactory?: AdbClientFactory;
  getCmdlineToolsVersion?: CmdlineToolsVersionReader;
  listAvds?: (probe?: DoctorProbeOptions) => Promise<Array<{ name: string }>>;
  readAvdConfig?: AvdConfigReader;
}

const listAvdsWithEmulator = async (probe?: DoctorProbeOptions) =>
  new AndroidEmulatorClient().listAvds(probe);

const createAndroidDoctorDependencies = (): AndroidDoctorDependencies => ({
  detectAndroidCommandLineTools,
  getBestAndroidToolsLocation,
  getAndroidHomeWithSystemImages,
  logger,
  getCmdlineToolsVersion: readCmdlineToolsVersion,
  listAvds: listAvdsWithEmulator,
  readAvdConfig: new FileAvdConfigReader(),
});

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Keep one caller-owned absolute deadline across Android subprocess probes. */
function probeOptions(options: DoctorProbeOptions): DoctorProbeOptions {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.timer === undefined ? {} : { timer: options.timer }),
  };
}

/**
 * Check Android command line tools installation and Homebrew mismatch
 */
export async function checkAndroidCommandLineTools(
  options: DoctorOptions & DoctorProbeOptions = {},
  dependencies = createAndroidDoctorDependencies(),
): Promise<CheckResult> {
  const name = "Android Command Line Tools";
  const probe = remainingDoctorProbe(probeOptions(options));

  let locations: Awaited<ReturnType<typeof detectAndroidCommandLineTools>>;
  try {
    locations = await dependencies.detectAndroidCommandLineTools();
  } catch (error) {
    dependencies.logger.warn(
      `Failed to detect Android command line tools: ${errorMessage(error)}`,
      error,
    );
    return {
      name,
      status: "warn",
      message: "Failed to detect Android command line tools.",
    };
  }

  const bestLocation = dependencies.getBestAndroidToolsLocation(locations);
  if (!bestLocation) {
    return {
      name,
      status: "warn",
      message: "Android command line tools not detected.",
      recommendation: "Ensure Android command line tools are present under ANDROID_HOME.",
    };
  }

  const androidHomeInfo = dependencies.getAndroidHomeWithSystemImages();
  if (androidHomeInfo && isHomebrewToolsPath(bestLocation.path)) {
    const toolsRoot = getCmdlineToolsRoot(bestLocation.path);
    if (normalizePath(toolsRoot) !== normalizePath(androidHomeInfo.androidHome)) {
      return {
        name,
        status: "warn",
        message: "Homebrew cmdline-tools detected while system images are in ANDROID_HOME.",
        recommendation: "Ensure Android command line tools are present under ANDROID_HOME.",
      };
    }
  }

  if (dependencies.getCmdlineToolsVersion) {
    return checkCmdlineToolsVersion(bestLocation, dependencies.getCmdlineToolsVersion, probe);
  }

  return {
    name,
    status: "pass",
    message: "Android command line tools detected.",
    value: bestLocation.path,
  };
}

/**
 * Check ANDROID_HOME environment variable
 */
async function checkAndroidHome(): Promise<CheckResult> {
  const androidHome = getAndroidSdkFromEnvironment();

  if (androidHome) {
    return {
      name: "ANDROID_HOME",
      status: "pass",
      message: `Android SDK found`,
      value: androidHome,
    };
  }

  return {
    name: "ANDROID_HOME",
    status: "fail",
    message: "ANDROID_HOME or ANDROID_SDK_ROOT not set or path does not exist",
    recommendation:
      "Set ANDROID_HOME to your Android SDK installation path. " +
      "Example: export ANDROID_HOME=$HOME/Library/Android/sdk",
  };
}

/**
 * Check JAVA_HOME environment variable
 */
export async function checkJavaHome(): Promise<CheckResult> {
  const javaHome = process.env.JAVA_HOME;

  if (!javaHome) {
    return {
      name: "JAVA_HOME",
      status: "warn",
      message: "JAVA_HOME environment variable not set",
      recommendation:
        "Set JAVA_HOME to your Java installation. " +
        "Example: export JAVA_HOME=$(/usr/libexec/java_home)",
    };
  }

  if (!existsSync(javaHome)) {
    return {
      name: "JAVA_HOME",
      status: "warn",
      message: `JAVA_HOME is set but path does not exist: ${javaHome}`,
      recommendation: "Update JAVA_HOME to a valid Java installation path",
    };
  }

  return {
    name: "JAVA_HOME",
    status: "pass",
    message: "Java home directory found",
    value: javaHome,
  };
}

/**
 * Check ADB installation and get path
 */
export async function checkAdbInstallation(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    const adb = adbFactory.create();
    const adbPath = await adb.getAdbPathOnly(currentProbe);

    return {
      name: "ADB Installation",
      status: "pass",
      message: "ADB is available",
      value: adbPath,
    };
  } catch (error) {
    logger.warn(`ADB installation check failed: ${errorMessage(error)}`, error);
    return {
      name: "ADB Installation",
      status: "fail",
      message: `ADB not found: ${errorMessage(error)}`,
      recommendation:
        "Install Android SDK Platform-Tools. " +
        "Via Homebrew: brew install android-platform-tools",
    };
  }
}

/**
 * Check ADB version
 */
export async function checkAdbVersion(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    const adb = adbFactory.create();
    const result = await adb.executeCommand(
      "--version",
      currentProbe.timeoutMs,
      undefined,
      true,
      currentProbe.signal,
    );

    // Parse version from output like "Android Debug Bridge version 35.0.0"
    const versionMatch = result.stdout.match(/Android Debug Bridge version (\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : "unknown";

    return {
      name: "ADB Version",
      status: "pass",
      message: `Version ${version}`,
      value: version,
    };
  } catch (error) {
    logger.warn(`ADB version check failed: ${errorMessage(error)}`, error);
    return {
      name: "ADB Version",
      status: "warn",
      message: `Could not determine ADB version: ${errorMessage(error)}`,
    };
  }
}

/**
 * Check Android emulator availability
 */
export async function checkEmulator(
  probe: DoctorProbeOptions = {},
  dependencies: Pick<AndroidDoctorDependencies, "listAvds"> = createAndroidDoctorDependencies(),
): Promise<CheckResult> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    // Try to list AVDs - this will fail if emulator is not available
    await (dependencies.listAvds ?? listAvdsWithEmulator)(currentProbe);

    return {
      name: "Android Emulator",
      status: "pass",
      message: "Emulator is available",
    };
  } catch (error) {
    const errorMsg = errorMessage(error);
    logger.warn(`Android emulator check failed: ${errorMsg}`, error);

    // Check if it's a "not found" error
    if (errorMsg.includes("not found") || errorMsg.includes("ENOENT")) {
      return {
        name: "Android Emulator",
        status: "warn",
        message: "Emulator not found",
        recommendation:
          "Install Android Emulator via SDK Manager or Homebrew: " +
          "brew install android-emulator",
      };
    }

    return {
      name: "Android Emulator",
      status: "warn",
      message: `Emulator check failed: ${errorMsg}`,
    };
  }
}

/**
 * Check connected Android devices
 */
export async function checkConnectedDevices(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    const adb = adbFactory.create();
    const devices = await adb.getBootedAndroidDevices({
      signal: currentProbe.signal,
      timeoutMs: currentProbe.timeoutMs,
    });
    if (devices.length > 0) {
      const deviceNames = devices.map((d) => d.deviceId).join(", ");
      return {
        name: "Connected Devices",
        status: "pass",
        message: `${devices.length} device(s) connected: ${deviceNames}`,
        value: devices.length,
      };
    }
    let rawStates: AdbDeviceState[] = [];
    try {
      rawStates =
        (await adb.getDeviceStates?.({
          signal: currentProbe.signal,
          timeoutMs: currentProbe.timeoutMs,
        })) ?? [];
    } catch (error) {
      logger.debug(`Could not query offline Android device states: ${errorMessage(error)}`);
    }
    const offlineDevices = rawStates.filter((state: AdbDeviceState) => state.state === "offline");
    if (offlineDevices.length > 0) {
      const ids = offlineDevices.map((device) => device.deviceId).join(", ");
      return {
        name: "Connected Devices",
        status: "warn",
        message: `Android device(s) present but offline: ${ids}`,
        value: 0,
        recommendation: offlineDevices.every((device) => device.deviceId.startsWith("emulator-"))
          ? "Restart the emulator and verify adb access outside restrictive sandboxing."
          : "Reconnect the device, accept USB debugging authorization, or restart the adb server.",
      };
    }
    return {
      name: "Connected Devices",
      status: "warn",
      message: "No Android devices connected",
      value: 0,
      recommendation: "Connect a device via USB or start an emulator",
    };
  } catch (error) {
    logger.warn(`Connected Android devices check failed: ${errorMessage(error)}`, error);
    return {
      name: "Connected Devices",
      status: "warn",
      message: `Could not list devices: ${errorMessage(error)}`,
      value: 0,
    };
  }
}

/** Check that configured AVDs have enough guest memory for modern images. */
export async function checkAvdMemory(
  dependencies: Pick<
    AndroidDoctorDependencies,
    "listAvds" | "readAvdConfig"
  > = createAndroidDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  if (!dependencies.listAvds || !dependencies.readAvdConfig) {
    return { name: "AVD Memory", status: "skip", message: "AVD memory could not be checked." };
  }

  try {
    const currentProbe = remainingDoctorProbe(probe);
    const readAvdConfig = dependencies.readAvdConfig;
    const avds = await dependencies.listAvds(currentProbe);
    const unverifiableConfigs: string[] = [];
    const lowMemory = (
      await Promise.all(
        avds.map(async (avd) => {
          currentProbe.signal?.throwIfAborted();
          const config = await awaitDoctorProbe(currentProbe, () =>
            readAvdConfig.readConfig(avd.name),
          );
          currentProbe.signal?.throwIfAborted();
          if (!config) {
            unverifiableConfigs.push(avd.name);
            return null;
          }
          const isModernPlayImage =
            config.tag?.toLowerCase().includes("play") && (config.apiLevel ?? 0) >= 30;
          if (!isModernPlayImage) {
            return null;
          }
          if (config.ramSizeMb === undefined) {
            unverifiableConfigs.push(avd.name);
            return null;
          }
          return isModernPlayImage && config.ramSizeMb < MIN_AVD_RAM_MB
            ? `${avd.name} (${config.ramSizeMb} MB)`
            : null;
        }),
      )
    ).filter((name): name is string => name !== null);
    if (unverifiableConfigs.length > 0 && lowMemory.length > 0) {
      return {
        name: "AVD Memory",
        status: "warn",
        message: `AVD(s) below the ${MIN_AVD_RAM_MB} MB minimum: ${lowMemory.join(", ")}. Could not verify: ${unverifiableConfigs.join(", ")}`,
        recommendation:
          "Increase hw.ramSize in affected AVD config.ini files and ensure every AVD config can be read.",
      };
    }
    if (unverifiableConfigs.length > 0) {
      return {
        name: "AVD Memory",
        status: "warn",
        message: `Could not read or verify AVD memory configuration: ${unverifiableConfigs.join(", ")}`,
        recommendation: "Check AVD_HOME and the affected AVD config.ini files.",
      };
    }
    if (lowMemory.length > 0) {
      return {
        name: "AVD Memory",
        status: "warn",
        message: `AVD(s) below the ${MIN_AVD_RAM_MB} MB minimum: ${lowMemory.join(", ")}`,
        recommendation: "Increase hw.ramSize in each affected AVD config.ini and retry.",
      };
    }
    return {
      name: "AVD Memory",
      status: "pass",
      message: `All applicable modern Play-image AVDs meet the ${MIN_AVD_RAM_MB} MB memory minimum.`,
    };
  } catch (error) {
    logger.warn(`AVD memory check failed: ${errorMessage(error)}`);
    return {
      name: "AVD Memory",
      status: "skip",
      message: `Could not check AVD memory: ${errorMessage(error)}`,
    };
  }
}

/**
 * Check available AVDs
 */
async function checkAvailableAvds(probe: DoctorProbeOptions = {}): Promise<CheckResult> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    const emulator = new AndroidEmulatorClient();
    const avds = await emulator.listAvds(currentProbe);

    if (avds.length === 0) {
      return {
        name: "Available AVDs",
        status: "warn",
        message: "No AVDs found",
        value: 0,
        recommendation: "Create an AVD using Android Studio or avdmanager",
      };
    }

    const avdNames = avds.map((a) => a.name).join(", ");
    return {
      name: "Available AVDs",
      status: "pass",
      message: `${avds.length} AVD(s) available: ${avdNames}`,
      value: avds.length,
    };
  } catch (error) {
    logger.warn(`Failed to list AVDs: ${errorMessage(error)}`, error);
    return {
      name: "Available AVDs",
      status: "skip",
      message: "Could not list AVDs (emulator may not be installed)",
      value: 0,
    };
  }
}

/**
 * Run all Android checks
 */
export async function runAndroidChecks(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const run = async (check: () => Promise<CheckResult>): Promise<void> => {
    remainingDoctorProbe(options);
    results.push(await check());
    remainingDoctorProbe(options);
  };

  // Run checks sequentially to avoid overwhelming the system
  results.push(await checkAndroidHome());
  await run(() => checkAndroidCommandLineTools(options));
  results.push(await checkJavaHome());
  await run(() => checkAdbInstallation(defaultAdbClientFactory, options));
  await run(() => checkAdbVersion(defaultAdbClientFactory, options));
  await run(() => checkEmulator(options));
  await run(() => checkConnectedDevices(defaultAdbClientFactory, options));
  await run(() => checkAvailableAvds(options));
  await run(() => checkAvdMemory(createAndroidDoctorDependencies(), options));

  return results;
}

/**
 * Run the narrow Android portion of post-repair verification.
 *
 * This deliberately limits itself to host toolchain probes. In particular it
 * never enumerates AVDs or booted devices, resolves the first discovered
 * device, or invokes CtrlProxy's compatibility reconciler, which can install
 * or upgrade an APK.
 */
export async function runPostRepairAndroidChecks(
  options: DoctorOptions = {},
  dependencies = createAndroidDoctorDependencies(),
): Promise<CheckResult[]> {
  const probe = probeOptions(options);
  const results: CheckResult[] = [];
  const run = async (check: () => Promise<CheckResult>): Promise<void> => {
    remainingDoctorProbe(options);
    results.push(await check());
    remainingDoctorProbe(options);
  };

  await run(() => checkAndroidCommandLineTools(options, dependencies));
  await run(() => checkJavaHome());
  await run(() => checkAdbInstallation(dependencies.adbFactory, probe));
  await run(() => checkAdbVersion(dependencies.adbFactory, probe));

  return results;
}
