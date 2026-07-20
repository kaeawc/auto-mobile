import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { logger } from "../logger";
import { defaultTimer } from "../SystemTimer";
import {
  detectAndroidCommandLineTools,
  getAndroidHomeWithSystemImages,
  getBestAndroidToolsLocation,
  getCmdlineToolsRoot,
  isHomebrewToolsPath,
  validateRequiredTools,
  type AndroidToolsLocation
} from "./detection";
import { AvdManagerClient } from "./AvdManagerClient";

// Dependencies interface for dependency injection
export interface AvdManagerDependencies {
  spawn: typeof spawn;
  existsSync: typeof existsSync;
  logger: typeof logger;
  detectAndroidCommandLineTools: typeof detectAndroidCommandLineTools;
  getAndroidHomeWithSystemImages: typeof getAndroidHomeWithSystemImages;
  getBestAndroidToolsLocation: typeof getBestAndroidToolsLocation;
  validateRequiredTools: typeof validateRequiredTools;
}

// Create default dependencies
const createDefaultDependencies = (): AvdManagerDependencies => ({
  spawn,
  existsSync,
  logger,
  detectAndroidCommandLineTools,
  getAndroidHomeWithSystemImages,
  getBestAndroidToolsLocation,
  validateRequiredTools,
});

const SDK_ROOT_MARKERS = ["system-images", "platforms", "platform-tools", "build-tools"];
let hasWarnedHomebrewSystemImagesMismatch = false;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function maybeWarnHomebrewSystemImagesMismatch(
  location: AndroidToolsLocation,
  dependencies: AvdManagerDependencies
): void {
  if (hasWarnedHomebrewSystemImagesMismatch) {
    return;
  }

  if (!isHomebrewToolsPath(location.path)) {
    return;
  }

  const androidHomeInfo = dependencies.getAndroidHomeWithSystemImages();
  if (!androidHomeInfo) {
    return;
  }

  const toolsRoot = getCmdlineToolsRoot(location.path);
  if (normalizePath(toolsRoot) === normalizePath(androidHomeInfo.androidHome)) {
    return;
  }

  const warningMessage = [
    "Warning: Homebrew Android cmdline-tools detected, but system images are in ANDROID_HOME.",
    "avdmanager may report missing system images because Homebrew sets com.android.sdkmanager.toolsdir to its own root.",
    `avdmanager location: ${location.path}`,
    `ANDROID_HOME: ${androidHomeInfo.androidHome}`,
    `System images: ${androidHomeInfo.systemImagesPath}`,
    "Fix: ensure cmdline-tools are present under ANDROID_HOME."
  ].join(" ");

  dependencies.logger.warn(warningMessage);
  hasWarnedHomebrewSystemImagesMismatch = true;
}

function looksLikeAndroidSdkRoot(sdkRoot: string, dependencies: AvdManagerDependencies): boolean {
  if (!dependencies.existsSync(sdkRoot)) {
    return false;
  }

  // For avdmanager operations, system-images is required
  // Check if system-images exists, OR if at least 2 other markers exist (for backward compatibility)
  const hasSystemImages = dependencies.existsSync(join(sdkRoot, "system-images"));
  if (hasSystemImages) {
    return true;
  }

  // Fall back to checking if at least 2 markers exist (for SDK roots without system-images yet)
  const markerCount = SDK_ROOT_MARKERS.filter(marker =>
    dependencies.existsSync(join(sdkRoot, marker))
  ).length;

  return markerCount >= 2;
}

function stripCmdlineToolsPath(pathValue: string): string | undefined {
  const normalized = pathValue.replace(/\\/g, "/");
  if (normalized.endsWith("/cmdline-tools/latest")) {
    return normalized.replace(/\/cmdline-tools\/latest$/, "");
  }
  if (normalized.endsWith("/cmdline-tools")) {
    return normalized.replace(/\/cmdline-tools$/, "");
  }
  return undefined;
}

function getTypicalSdkPaths(): string[] {
  const homeDir = process.env.HOME || process.env.USERPROFILE;

  switch (process.platform) {
    case "darwin":
      return [
        ...(homeDir ? [join(homeDir, "Library/Android/sdk")] : []),
        "/opt/android-sdk",
        "/usr/local/android-sdk"
      ];
    case "linux":
      return [
        ...(homeDir ? [join(homeDir, "Android/Sdk")] : []),
        "/opt/android-sdk",
        "/usr/local/android-sdk"
      ];
    case "win32":
      return [
        ...(homeDir ? [join(homeDir, "AppData/Local/Android/Sdk")] : []),
        "C:/Android/Sdk",
        "C:/android-sdk"
      ];
    default:
      return [];
  }
}

function resolveAndroidSdkRoot(
  location: AndroidToolsLocation,
  dependencies: AvdManagerDependencies
): string | undefined {
  const candidates = new Set<string>();

  const envCandidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_HOME
  ].filter(Boolean) as string[];

  for (const candidate of envCandidates) {
    candidates.add(candidate);
  }

  const strippedPath = stripCmdlineToolsPath(location.path);
  if (strippedPath) {
    candidates.add(strippedPath);
  }

  candidates.add(location.path);
  candidates.add(resolve(location.path, ".."));
  candidates.add(resolve(location.path, "..", ".."));

  for (const typicalPath of getTypicalSdkPaths()) {
    candidates.add(typicalPath);
  }

  // Two-pass search: First pass prioritizes SDK roots with system-images
  // This ensures we pick a complete SDK (with system-images) over an incomplete one
  // (e.g., Homebrew with only platforms/platform-tools/build-tools)

  // Pass 1: Only accept candidates with system-images
  for (const candidate of candidates) {
    if (!dependencies.existsSync(candidate)) {
      continue;
    }
    const hasSystemImages = dependencies.existsSync(join(candidate, "system-images"));
    if (hasSystemImages) {
      return candidate;
    }
  }

  // Pass 2: Fall back to candidates with 2+ markers (backward compatibility)
  for (const candidate of candidates) {
    if (looksLikeAndroidSdkRoot(candidate, dependencies)) {
      return candidate;
    }
  }

  return undefined;
}

function getAndroidSdkEnv(
  location: AndroidToolsLocation,
  dependencies: AvdManagerDependencies
): NodeJS.ProcessEnv | undefined {
  const sdkRoot = resolveAndroidSdkRoot(location, dependencies);
  if (!sdkRoot) {
    return undefined;
  }

  return {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot
  };
}

/**
 * Execute a command using spawn with proper error handling and logging
 */
async function spawnCommand(command: string, args: string[], options: {
  cwd?: string;
  input?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
} = {}, dependencies = createDefaultDependencies()): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    dependencies.logger.info(`Executing: ${command} ${args.join(" ")}`);

    const child = dependencies.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timeoutId: NodeJS.Timeout | undefined;

    // Set up timeout if specified
    if (options.timeout) {
      timeoutId = defaultTimer.setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${options.timeout}ms: ${command} ${args.join(" ")}`));
      }, options.timeout);
    }

    child.stdout?.on("data", data => {
      const output = data.toString();
      stdout += output;
      if (output.trim()) {
        dependencies.logger.info(`[${command}] ${output.trim()}`);
      }
    });

    child.stderr?.on("data", data => {
      const output = data.toString();
      stderr += output;
      if (output.trim()) {
        dependencies.logger.warn(`[${command}] ${output.trim()}`);
      }
    });

    child.on("close", code => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({ stdout, stderr, exitCode: code || 0 });
    });

    child.on("error", error => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(new Error(`Failed to spawn command: ${command} ${args.join(" ")}\nError: ${error.message}`));
    });

    // Send input if provided (for license acceptance)
    if (options.input) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

/**
 * Ensure required Android tools are available, installing if necessary
 */
async function ensureToolsAvailable(dependencies = createDefaultDependencies()): Promise<AndroidToolsLocation> {
  const locations = await dependencies.detectAndroidCommandLineTools();
  const bestLocation = dependencies.getBestAndroidToolsLocation(locations);

  if (!bestLocation) {
    dependencies.logger.error("Android command line tools not found and tool installation has been removed");
    throw new Error("Android command line tools not found. Tool installation functionality has been removed. Please install Android SDK manually from https://developer.android.com/studio or using Homebrew: brew install --cask android-commandlinetools");
  }

  // Validate that required tools are available
  const validation = dependencies.validateRequiredTools(bestLocation, ["avdmanager", "sdkmanager"]);
  if (!validation.valid) {
    dependencies.logger.error(`Missing required tools: ${validation.missing.join(", ")} and tool installation has been removed`);
    throw new Error(`Missing required tools: ${validation.missing.join(", ")}. Tool installation functionality has been removed. Please install Android SDK manually.`);
  }

  maybeWarnHomebrewSystemImagesMismatch(bestLocation, dependencies);

  return bestLocation;
}

/**
 * Get the sdkmanager executable path
 */
function getSdkManagerPath(location: AndroidToolsLocation, dependencies = createDefaultDependencies()): string {
  const sdkmanagerPath = join(location.path, "bin", "sdkmanager");
  const sdkmanagerBatPath = join(location.path, "bin", "sdkmanager.bat");

  if (dependencies.existsSync(sdkmanagerPath)) {
    return sdkmanagerPath;
  } else if (dependencies.existsSync(sdkmanagerBatPath)) {
    return sdkmanagerBatPath;
  }

  throw new Error(`SDK manager not found at ${location.path}`);
}

/**
 * Accept Android SDK licenses
 */
export async function acceptLicenses(dependencies = createDefaultDependencies()): Promise<{
  success: boolean;
  message: string
}> {
  try {
    const location = await ensureToolsAvailable(dependencies);
    const sdkmanagerPath = getSdkManagerPath(location, dependencies);
    const env = getAndroidSdkEnv(location, dependencies);

    dependencies.logger.info("Accepting Android SDK licenses...");

    // Provide "y" responses to all license prompts
    const licenseInput = "y\n".repeat(20);
    const result = await spawnCommand(sdkmanagerPath, ["--licenses"], {
      input: licenseInput,
      timeout: 60000, // 60 second timeout
      env
    }, dependencies);

    if (result.exitCode === 0) {
      dependencies.logger.info("Successfully accepted Android SDK licenses");
      return { success: true, message: "Android SDK licenses accepted" };
    } else {
      return { success: false, message: `License acceptance failed: ${result.stderr}` };
    }
  } catch (error) {
    const message = `Failed to accept licenses: ${(error as Error).message}`;
    dependencies.logger.error(message);
    return { success: false, message };
  }
}

/**
 * List available system images
 */
export async function listSystemImages(filter?: SystemImageFilter, dependencies = createDefaultDependencies()): Promise<SystemImage[]> {
  try {
    const location = await ensureToolsAvailable(dependencies);
    const sdkmanagerPath = getSdkManagerPath(location, dependencies);
    const env = getAndroidSdkEnv(location, dependencies);

    const result = await spawnCommand(sdkmanagerPath, ["--list"], { env }, dependencies);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list system images: ${result.stderr}`);
    }

    return parseSystemImages(result.stdout, filter);
  } catch (error) {
    dependencies.logger.error(`Failed to list system images: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Download and install a system image
 */
export async function installSystemImage(packageName: string, acceptLicense = true, dependencies = createDefaultDependencies()): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const location = await ensureToolsAvailable(dependencies);
    const sdkmanagerPath = getSdkManagerPath(location, dependencies);
    const env = getAndroidSdkEnv(location, dependencies);

    dependencies.logger.info(`Installing system image: ${packageName}`);

    // Accept license and install
    const input = acceptLicense ? "y\n".repeat(10) : undefined;
    const result = await spawnCommand(sdkmanagerPath, [packageName], {
      input,
      timeout: 600000, // 10 minute timeout for downloads
      env
    }, dependencies);

    if (result.exitCode === 0) {
      dependencies.logger.info(`Successfully installed system image: ${packageName}`);
      return { success: true, message: `System image ${packageName} installed successfully` };
    } else {
      return { success: false, message: `Installation failed: ${result.stderr}` };
    }
  } catch (error) {
    const message = `Failed to install system image ${packageName}: ${(error as Error).message}`;
    dependencies.logger.error(message);
    return { success: false, message };
  }
}

/**
 * List available AVDs
 */
export async function listDeviceImages(dependencies = createDefaultDependencies()): Promise<AvdInfo[]> {
  try {
    return await createAvdManagerClient(dependencies).listDeviceImages();
  } catch (error) {
    dependencies.logger.error(`Failed to list AVDs: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Create a new AVD
 */
export async function createAvd(params: CreateAvdParams, dependencies = createDefaultDependencies()): Promise<{
  success: boolean;
  message: string;
  avdName?: string;
}> {
  return createAvdManagerClient(dependencies).createAvd(params);
}

/**
 * Delete an AVD
 */
export async function deleteAvd(name: string, dependencies = createDefaultDependencies()): Promise<{
  success: boolean;
  message: string;
}> {
  return createAvdManagerClient(dependencies).deleteAvd(name);
}

/**
 * List available device profiles
 */
export async function listDevices(dependencies = createDefaultDependencies()): Promise<DeviceProfile[]> {
  try {
    return await createAvdManagerClient(dependencies).listDevices();
  } catch (error) {
    dependencies.logger.error(`Failed to list devices: ${(error as Error).message}`);
    throw error;
  }
}

function createAvdManagerClient(dependencies: AvdManagerDependencies): AvdManagerClient {
  return new AvdManagerClient({
    ...dependencies,
    timer: defaultTimer,
    environment: process.env,
  });
}

/**
 * Parse system images from sdkmanager output
 */
function parseSystemImages(output: string, filter?: SystemImageFilter): SystemImage[] {
  const lines = output.split("\n");
  const images: SystemImage[] = [];
  let inSystemImagesSection = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.includes("Available Packages:")) {
      inSystemImagesSection = true;
      continue;
    }

    if (trimmedLine.includes("Installed packages:")) {
      inSystemImagesSection = false;
      continue;
    }

    if (inSystemImagesSection && trimmedLine.startsWith("system-images;")) {
      const parts = trimmedLine.split(/\s+/);
      const packageName = parts[0];
      const versionInfo = parts.slice(1).join(" ");

      // Parse package name: system-images;android-XX;tag;abi
      const packageParts = packageName.split(";");
      if (packageParts.length >= 4) {
        const apiLevel = parseInt(packageParts[1].replace("android-", ""), 10);
        const tag = packageParts[2];
        const abi = packageParts[3];

        const image: SystemImage = {
          packageName,
          apiLevel,
          tag,
          abi,
          versionInfo: versionInfo || ""
        };

        // Apply filter if provided
        if (!filter || matchesFilter(image, filter)) {
          images.push(image);
        }
      }
    }
  }

  return images;
}

/**
 * Check if system image matches filter criteria
 */
function matchesFilter(image: SystemImage, filter: SystemImageFilter): boolean {
  if (filter.apiLevel && image.apiLevel !== filter.apiLevel) {
    return false;
  }
  if (filter.tag && image.tag !== filter.tag) {
    return false;
  }
  if (filter.abi && image.abi !== filter.abi) {
    return false;
  }
  return true;
}

// Type definitions

export interface SystemImageFilter {
  apiLevel?: number;
  tag?: string;
  abi?: string;
}

export interface SystemImage {
  packageName: string;
  apiLevel: number;
  tag: string;
  abi: string;
  versionInfo: string;
}

export interface CreateAvdParams {
  name: string;
  package: string;
  device?: string;
  force?: boolean;
  path?: string;
  tag?: string;
  abi?: string;
}

export interface AvdInfo {
  name: string;
  path?: string;
  target?: string;
  basedOn?: string;
  error?: string;
}

export interface DeviceProfile {
  id: string;
  name?: string;
  oem?: string;
}

// Common system image packages for convenience
export const COMMON_SYSTEM_IMAGES = {
  API_35: {
    GOOGLE_APIS_ARM64: "system-images;android-35;google_apis;arm64-v8a",
    GOOGLE_APIS_X86_64: "system-images;android-35;google_apis;x86_64",
    PLAYSTORE_ARM64: "system-images;android-35;google_apis_playstore;arm64-v8a",
    PLAYSTORE_X86_64: "system-images;android-35;google_apis_playstore;x86_64"
  },
  API_34: {
    GOOGLE_APIS_ARM64: "system-images;android-34;google_apis;arm64-v8a",
    GOOGLE_APIS_X86_64: "system-images;android-34;google_apis;x86_64",
    PLAYSTORE_ARM64: "system-images;android-34;google_apis_playstore;arm64-v8a",
    PLAYSTORE_X86_64: "system-images;android-34;google_apis_playstore;x86_64"
  },
  API_33: {
    GOOGLE_APIS_ARM64: "system-images;android-33;google_apis;arm64-v8a",
    GOOGLE_APIS_X86_64: "system-images;android-33;google_apis;x86_64",
    PLAYSTORE_ARM64: "system-images;android-33;google_apis_playstore;arm64-v8a",
    PLAYSTORE_X86_64: "system-images;android-33;google_apis_playstore;x86_64"
  }
} as const;

// Common device profiles
export const COMMON_DEVICES = {
  PIXEL_4: "pixel_4",
  PIXEL_6: "pixel_6",
  PIXEL_7: "pixel_7",
  NEXUS_5X: "Nexus 5X",
  MEDIUM_PHONE: "Medium Phone",
  SMALL_PHONE: "Small Phone"
} as const;
