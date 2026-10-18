import { existsSync } from "node:fs";
import { AMBIENT_ENV, readEnvRaw } from "../../config/env";
import { logger } from "../logger";
import { detectAndroidCommandLineTools, getBestAndroidToolsLocation } from "./detection";
import { resolveAndroidSdkRoot } from "./androidSdkRoot";

/**
 * Get the path to the emulator executable.
 * This function tries the best available path synchronously, falling back to env/PATH.
 * Actual async detection is performed when needed by ensureEmulatorPath().
 * @returns The path to the emulator
 */
export function getFallbackEmulatorPath(): string {
  const androidHome = resolveAndroidSdkRoot(process.env);
  if (androidHome) {
    return `${androidHome}/emulator/emulator`;
  }
  return "emulator";
}

/**
 * Try multiple common paths to find the emulator executable
 * @returns Promise<string | null> The emulator path if found, null otherwise
 */
async function tryMultiplePaths(): Promise<string | null> {
  const { existsSync } = require("fs");
  const path = require("path");

  // Build list of potential emulator paths
  const potentialPaths: string[] = [];

  // 1. Check environment variables first (highest priority)
  const androidHome = resolveAndroidSdkRoot(
    process.env,
    (candidate) =>
      existsSync(path.join(candidate, "emulator", "emulator")) ||
      existsSync(path.join(candidate, "emulator", "emulator-arm64-v8a")),
  );
  if (androidHome) {
    potentialPaths.push(`${androidHome}/emulator/emulator`);
    potentialPaths.push(`${androidHome}/emulator/emulator-arm64-v8a`);
  }

  // 2. Check standard macOS Android SDK location
  const homeDir = readEnvRaw(AMBIENT_ENV.HOME) || readEnvRaw(AMBIENT_ENV.USERPROFILE);
  if (homeDir) {
    potentialPaths.push(path.join(homeDir, "Library/Android/sdk/emulator/emulator"));
    potentialPaths.push(path.join(homeDir, ".android/emulator/emulator"));
  }

  // 3. Check Linux/WSL locations
  potentialPaths.push("/usr/lib/android-sdk/emulator/emulator");
  potentialPaths.push("/opt/android-sdk/emulator/emulator");

  // 4. Check Homebrew locations
  potentialPaths.push("/opt/homebrew/bin/emulator");
  potentialPaths.push("/usr/local/bin/emulator");
  potentialPaths.push("/opt/homebrew/Caskroom/android-studio/*/Contents/emulator/emulator");

  // 5. Try to find via Android command line tools detection
  try {
    const locations = await detectAndroidCommandLineTools();
    const bestLocation = getBestAndroidToolsLocation(locations);

    if (bestLocation) {
      // Check various emulator locations relative to SDK root
      const sdkRoot = bestLocation.path
        .replace("/cmdline-tools/latest", "")
        .replace("/cmdline-tools", "");
      potentialPaths.push(`${sdkRoot}/emulator/emulator`);
      potentialPaths.push(`${sdkRoot}/emulator/emulator-arm64-v8a`);

      // Also check Homebrew location structure
      potentialPaths.push(`${sdkRoot}/../emulator/emulator`);
    }
  } catch (error) {
    logger.debug(`Failed to detect Android tools: ${error}`);
  }

  // 6. Check system PATH
  potentialPaths.push("emulator");

  // Try each path
  for (const potentialPath of potentialPaths) {
    try {
      // Handle glob patterns - skip them in basic existence check
      if (potentialPath.includes("*")) {
        continue;
      }

      // Expand ~ if present
      const expandedPath = potentialPath.startsWith("~")
        ? path.join(homeDir || "", potentialPath.slice(1))
        : potentialPath;

      if (existsSync(expandedPath)) {
        logger.debug(`Found emulator at: ${expandedPath}`);
        return expandedPath;
      }
    } catch (error) {
      logger.debug(`Failed to check path ${potentialPath}: ${error}`);
    }
  }

  logger.debug(`Emulator not found in any of these paths:\n${potentialPaths.join("\n")}`);
  return null;
}

/**
 * Gets the emulator path asynchronously via detection.
 * @returns Promise<string>
 */
export async function locateEmulatorPath(): Promise<string> {
  // Try multiple common paths
  const foundPath = await tryMultiplePaths();
  if (foundPath) {
    return foundPath;
  }

  // Fall back to default
  return getFallbackEmulatorPath();
}

export function isResolvedEmulatorPathAvailable(emulatorPath: string): boolean {
  const trimmedPath = emulatorPath.trim();
  if (trimmedPath.length === 0) {
    return false;
  }
  if (!trimmedPath.includes("/") && !trimmedPath.includes("\\")) {
    return false;
  }
  return existsSync(trimmedPath);
}

/**
 * Describe how the emulator binary was resolved, for failure diagnostics.
 *
 * The previous guidance ("install via Homebrew") is actively misleading on a
 * CI runner, where the SDK is present but the emulator package is not. The
 * resolved path plus the environment it came from is what identifies the
 * actual gap (issue #4237).
 */
export function describeEmulatorResolution(emulatorPath: string): string {
  const unset = "<unset>";
  return [
    `  resolved emulator path: ${emulatorPath || unset}`,
    ...(["ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK_HOME", "PATH"] as const).map(
      (key) => `  ${key}=${readEnvRaw(AMBIENT_ENV[key]) ?? unset}`,
    ),
  ].join("\n");
}

export function isLikelyDaemonWorkingDirectoryFailure(
  emulatorPath: string,
  errorMsg: string,
): boolean {
  if (!isResolvedEmulatorPathAvailable(emulatorPath)) {
    return false;
  }

  const lowerError = errorMsg.toLowerCase();
  return (
    (lowerError.includes("enoent") && lowerError.includes("spawn")) ||
    lowerError.includes("getcwd") ||
    lowerError.includes("current working directory") ||
    lowerError.includes("current directory")
  );
}
