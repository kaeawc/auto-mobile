import type { BootedDevice } from "../../models";
import { apiLevelToVersion } from "./AvdConfigReader";
import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { parseWmDensity, parseWmSize } from "./wmDisplayParsers";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

/** Release and physical display facts a booted Android device reports about itself (#18988). */
export type AndroidRuntimeFacts = Pick<
  BootedDevice,
  "apiLevel" | "osVersion" | "screenWidth" | "screenHeight" | "screenDensity"
>;

export const RUNTIME_FACT_COMMANDS = {
  sdk: "shell getprop ro.build.version.sdk",
  release: "shell getprop ro.build.version.release",
  size: "shell wm size",
  density: "shell wm density",
} as const;

/**
 * Read the API level, release and physical display of a booted device, so inventory does not
 * depend on resolving its AVD (no `avdmanager`). Every read is optional: an unreadable fact is
 * omitted and the configured image, when there is one, still fills it.
 */
export async function readAndroidRuntimeFacts(
  adb: AdbCommandRunner,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<AndroidRuntimeFacts> {
  const read = async (command: string): Promise<string> => {
    try {
      return (
        await adb.executeCommand(command, {
          timeoutMs: options.timeoutMs,
          noRetry: true,
          signal: options.signal,
        })
      ).stdout;
    } catch (error) {
      options.signal?.throwIfAborted();
      // Each fact is optional inventory metadata; a failed read leaves that field unset.
      logger.debug(`Android runtime fact '${command}' unavailable: ${errorMessage(error)}`);
      return "";
    }
  };
  const [sdk, release, size, density] = await Promise.all([
    read(RUNTIME_FACT_COMMANDS.sdk),
    read(RUNTIME_FACT_COMMANDS.release),
    read(RUNTIME_FACT_COMMANDS.size),
    read(RUNTIME_FACT_COMMANDS.density),
  ]);
  return parseAndroidRuntimeFacts({ sdk, release, size, density });
}

export function parseAndroidRuntimeFacts(output: {
  sdk: string;
  release: string;
  size: string;
  density: string;
}): AndroidRuntimeFacts {
  const apiLevel = /^\d+$/.test(output.sdk.trim()) ? Number(output.sdk.trim()) : undefined;
  const release = output.release.trim();
  // Match the configured-image spelling (API 24 is "7.0"); the raw release covers unknown levels.
  const osVersion =
    (apiLevel !== undefined ? apiLevelToVersion(apiLevel) : undefined) ?? (release || undefined);
  const physicalSize = parseWmSize(output.size)?.physical;
  const physicalDensity = parseWmDensity(output.density).physical;
  return {
    ...(apiLevel !== undefined && apiLevel > 0 ? { apiLevel } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(physicalSize ? { screenWidth: physicalSize.width, screenHeight: physicalSize.height } : {}),
    ...(physicalDensity !== undefined ? { screenDensity: physicalDensity } : {}),
  };
}

/** Fill the device's unset facts from what it reported; values already on the device win. */
export function withRuntimeFacts(device: BootedDevice, facts: AndroidRuntimeFacts): BootedDevice {
  return {
    ...device,
    ...Object.fromEntries(
      Object.entries(facts).filter(
        ([key]) => device[key as keyof AndroidRuntimeFacts] === undefined,
      ),
    ),
  };
}
