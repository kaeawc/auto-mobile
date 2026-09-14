import { isAbsolute, win32 } from "node:path";
import {
  checkAdbInstallation,
  checkAdbVersion,
  checkAndroidCommandLineTools,
  checkEmulator,
} from "../doctor/checks/android";
import {
  checkSimctlAvailable,
  checkXcodeCommandLineTools,
  checkXcodeInstallation,
  checkXcrunAvailable,
  createIosDoctorDependencies,
  DOCTOR_EXEC_TIMEOUT_MS,
} from "../doctor/checks/ios";
import type { CheckResult, DoctorProbeOptions } from "../doctor/types";
import { errorMessage } from "../utils/describeUnknownError";
import { checkDevicectlAvailability } from "../utils/ios-cmdline-tools/DevicectlDeviceLister";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";

export const HOST_TOOLCHAIN_RESOURCE_URI = "automobile:host/toolchain";

export interface HostToolchainEntry {
  name: string;
  available: boolean;
  version?: string;
  location?: string;
  error?: string;
}

export interface HostToolchainResourceContent {
  lastUpdated: string;
  entries: HostToolchainEntry[];
}

/**
 * One doctor probe. The resource hands every check a signal it aborts when its
 * own deadline wins the race, plus that deadline, so the check bounds and kills
 * the commands it spawns (#7008). Checks that spawn nothing may ignore both.
 */
type DoctorCheck = (probe: DoctorProbeOptions) => Promise<CheckResult>;

export interface HostToolchainResourceDependencies {
  now: () => Date;
  timer?: Timer;
  checkAdbInstallation: DoctorCheck;
  checkAdbVersion: DoctorCheck;
  checkEmulator: DoctorCheck;
  checkAndroidCommandLineTools: DoctorCheck;
  checkXcodeInstallation: DoctorCheck;
  checkXcodeCommandLineTools: DoctorCheck;
  checkXcrunAvailable: DoctorCheck;
  checkSimctlAvailable: DoctorCheck;
  checkDevicectlAvailable: DoctorCheck;
}

function createDefaultDependencies(): HostToolchainResourceDependencies {
  const iosDependencies = createIosDoctorDependencies();
  return {
    now: () => new Date(),
    timer: defaultTimer,
    checkAdbInstallation: (probe) => checkAdbInstallation(undefined, probe),
    checkAdbVersion: (probe) => checkAdbVersion(undefined, probe),
    checkEmulator: (probe) => checkEmulator(probe),
    checkAndroidCommandLineTools: (probe) => checkAndroidCommandLineTools(probe),
    // The iOS dependencies' execFile already bounds every command with
    // DOCTOR_EXEC_TIMEOUT_MS + SIGKILL, so these need no per-probe signal.
    checkXcodeInstallation: () => checkXcodeInstallation(undefined, iosDependencies),
    checkXcodeCommandLineTools: () => checkXcodeCommandLineTools(undefined, iosDependencies),
    checkXcrunAvailable: () => checkXcrunAvailable(iosDependencies),
    checkSimctlAvailable: () => checkSimctlAvailable(iosDependencies),
    checkDevicectlAvailable: () =>
      checkDevicectlAvailability({
        platform: iosDependencies.platform,
        invoke: iosDependencies.execFile,
        logger: iosDependencies.logger,
      }),
  };
}

function normalizedVersion(
  value: string | number | boolean | null | undefined,
  message: string,
): string | undefined {
  const sources = [message];
  if (typeof value === "string" && !isAbsolutePath(value)) {
    sources.push(value);
  }
  for (const source of sources) {
    const match = source
      .trim()
      .replace(/^v/i, "")
      .match(/\d+(?:\.\d+)+/);
    if (match) {
      return match[0];
    }
  }
  return undefined;
}

function entryFromCheck(
  name: string,
  result: CheckResult,
  options: { version?: boolean; location?: boolean } = {},
): HostToolchainEntry {
  if (result.status !== "pass") {
    return { name, available: false, error: result.message };
  }
  const value = typeof result.value === "string" ? result.value : undefined;
  const version = options.version ? normalizedVersion(result.value, result.message) : undefined;
  return {
    name,
    available: true,
    ...(version ? { version } : {}),
    ...(options.location && value !== undefined && isAbsolutePath(value)
      ? { location: value }
      : {}),
  };
}

/** POSIX and Windows absolute paths both count; a bare command name does not. */
function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

async function probe(name: string, check: DoctorCheck, timer: Timer): Promise<CheckResult> {
  let timeout: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        check({ signal: controller.signal, timeoutMs: DOCTOR_EXEC_TIMEOUT_MS }),
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = timer.setTimeout(() => {
          const error = new Error(`Probe timed out after ${DOCTOR_EXEC_TIMEOUT_MS}ms`);
          // The losing check keeps running otherwise; aborting kills its children.
          controller.abort(error);
          reject(error);
        }, DOCTOR_EXEC_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    const message = errorMessage(error);
    logger.warn(`[HostToolchainResources] ${name} probe failed: ${message}`, error);
    return { name, status: "fail", message };
  } finally {
    if (timeout) {
      timer.clearTimeout(timeout);
    }
  }
}

function timestamp(now: () => Date): string {
  try {
    return now().toISOString();
  } catch (error) {
    logger.warn(`[HostToolchainResources] clock failed: ${errorMessage(error)}`, error);
    return "1970-01-01T00:00:00.000Z";
  }
}

export function createHostToolchainResourceHandler(
  overrides: Partial<HostToolchainResourceDependencies> = {},
): () => Promise<ResourceContent> {
  const dependencies = { ...createDefaultDependencies(), ...overrides };
  const timer = dependencies.timer ?? defaultTimer;
  return async () => {
    const lastUpdated = timestamp(dependencies.now);
    try {
      const [
        adbInstallation,
        adbVersion,
        emulator,
        commandLineTools,
        xcodebuild,
        xcodeSelect,
        xcrun,
        simctl,
        devicectl,
      ] = await Promise.all([
        probe("adb installation", dependencies.checkAdbInstallation, timer),
        probe("adb version", dependencies.checkAdbVersion, timer),
        probe("emulator", dependencies.checkEmulator, timer),
        probe("Android command line tools", dependencies.checkAndroidCommandLineTools, timer),
        probe("xcodebuild", dependencies.checkXcodeInstallation, timer),
        probe("xcode-select", dependencies.checkXcodeCommandLineTools, timer),
        probe("xcrun", dependencies.checkXcrunAvailable, timer),
        probe("simctl", dependencies.checkSimctlAvailable, timer),
        probe("devicectl", dependencies.checkDevicectlAvailable, timer),
      ]);
      const adb = entryFromCheck("adb", adbInstallation, { location: true });
      if (adb.available && adbVersion.status === "pass") {
        const version = normalizedVersion(adbVersion.value, adbVersion.message);
        if (version) {
          adb.version = version;
        }
      } else if (adb.available) {
        adb.available = false;
        adb.error = adbVersion.message;
      }
      const commandLineToolEntry = entryFromCheck("sdkmanager", commandLineTools, {
        version: true,
        location: true,
      });
      const content: HostToolchainResourceContent = {
        lastUpdated,
        entries: [
          adb,
          entryFromCheck("emulator", emulator, { location: true }),
          commandLineToolEntry,
          { ...commandLineToolEntry, name: "avdmanager" },
          entryFromCheck("xcodebuild", xcodebuild, { version: true }),
          entryFromCheck("xcode-select", xcodeSelect, { location: true }),
          entryFromCheck("xcrun", xcrun),
          entryFromCheck("simctl", simctl),
          entryFromCheck("devicectl", devicectl),
        ],
      };
      return {
        uri: HOST_TOOLCHAIN_RESOURCE_URI,
        mimeType: "application/json",
        text: JSON.stringify(content),
      };
    } catch (error) {
      logger.warn(`[HostToolchainResources] resource read failed: ${errorMessage(error)}`, error);
      return {
        uri: HOST_TOOLCHAIN_RESOURCE_URI,
        mimeType: "application/json",
        text: JSON.stringify({ lastUpdated, entries: [] } satisfies HostToolchainResourceContent),
      };
    }
  };
}

export function registerHostToolchainResources(): void {
  ResourceRegistry.register(
    HOST_TOOLCHAIN_RESOURCE_URI,
    "Host Toolchain",
    "Read-only diagnostic status for Android and Apple host tooling.",
    "application/json",
    createHostToolchainResourceHandler(),
  );
}
