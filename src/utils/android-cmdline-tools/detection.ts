import { join, dirname } from "path";
import { logger } from "../logger";
import { SystemDetection, DefaultSystemDetection } from "../system/SystemDetection";

/**
 * Signals that a caller-owned deadline expired while this module was probing
 * the host. Discovery normally treats missing commands as a negative result;
 * a deadline expiry must instead reach that caller unchanged.
 */
export class AndroidToolsDetectionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AndroidToolsDetectionTimeoutError";
  }
}

/** Preserves caller cancellation through discovery's normal miss handling. */
export class AndroidToolsDetectionAbortError extends Error {
  constructor(readonly abortError: Error) {
    super(abortError.message);
    this.name = "AndroidToolsDetectionAbortError";
  }
}

function isAndroidToolsDetectionControlError(
  error: unknown
): error is AndroidToolsDetectionTimeoutError | AndroidToolsDetectionAbortError {
  return error instanceof AndroidToolsDetectionTimeoutError || error instanceof AndroidToolsDetectionAbortError;
}

function rethrowAndroidToolsDetectionControlError(error: unknown): void {
  if (isAndroidToolsDetectionControlError(error)) {
    throw error;
  }
}

export type AndroidToolsSource = "homebrew" | "android_home" | "android_sdk_root" | "path" | "manual" | "typical";

export interface AndroidToolsLocation {
  path: string;
  source: AndroidToolsSource;
  available_tools: string[];
}

interface AndroidToolInfo {
  name: string;
  description: string;
}

interface AndroidHomeWithSystemImages {
  androidHome: string;
  systemImagesPath: string;
}

// Create one stable default context so production callers retain the shared
// detection cache, while injected/fake contexts remain isolated from each
// other (and from concurrent tests).
const createDefaultSystemDetection = (): SystemDetection => new DefaultSystemDetection();
const defaultSystemDetection = createDefaultSystemDetection();

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function getCmdlineToolsRoot(toolsPath: string): string {
  const normalized = normalizePath(toolsPath);
  if (normalized.endsWith("/cmdline-tools/latest")) {
    return normalized.replace(/\/cmdline-tools\/latest$/, "");
  }
  if (normalized.endsWith("/cmdline-tools")) {
    return normalized.replace(/\/cmdline-tools$/, "");
  }
  return normalized;
}

export function isHomebrewToolsPath(toolsPath: string): boolean {
  const normalized = normalizePath(toolsPath).toLowerCase();
  return normalized.includes("/homebrew/") || normalized.includes("/share/android-commandlinetools/");
}

export function getAndroidHomeWithSystemImages(
  systemDetection = createDefaultSystemDetection()
): AndroidHomeWithSystemImages | null {
  const androidHome = getAndroidSdkFromEnvironment(systemDetection);
  if (!androidHome) {
    return null;
  }

  const systemImagesPath = join(androidHome, "system-images");
  if (!systemDetection.fileExistsSync(systemImagesPath)) {
    return null;
  }

  return {
    androidHome,
    systemImagesPath
  };
}

/**
 * In-memory cache for detection results
 */
let cachedAndroidToolsLocations = new WeakMap<SystemDetection, AndroidToolsLocation[]>();

/**
 * Clear cached detection results
 */
export function clearDetectionCache(): void {
  cachedAndroidToolsLocations = new WeakMap();
}

/**
 * Registry of available Android command line tools
 */
export const ANDROID_TOOLS: Record<string, AndroidToolInfo> = {
  apkanalyzer: {
    name: "apkanalyzer",
    description: "APK analysis and inspection"
  },
  avdmanager: {
    name: "avdmanager",
    description: "Android Virtual Device management"
  },
  sdkmanager: {
    name: "sdkmanager",
    description: "SDK package management"
  },
  lint: {
    name: "lint",
    description: "Static code analysis"
  },
  screenshot2: {
    name: "screenshot2",
    description: "Device screenshot capture"
  },
  d8: {
    name: "d8",
    description: "DEX compiler"
  },
  r8: {
    name: "r8",
    description: "Code shrinking and obfuscation"
  },
  resourceshrinker: {
    name: "resourceshrinker",
    description: "Resource optimization"
  },
  retrace: {
    name: "retrace",
    description: "Stack trace de-obfuscation"
  },
  profgen: {
    name: "profgen",
    description: "ART profile generation"
  }
};

/**
 * Get typical Android SDK installation paths for each platform
 */
export function getTypicalAndroidSdkPaths(systemDetection = createDefaultSystemDetection()): string[] {
  const platformName = systemDetection.getCurrentPlatform();
  const home = systemDetection.getHomeDir();

  switch (platformName) {
    case "darwin": // macOS
      return [
        join(home, "Library/Android/sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk"
      ];
    case "linux":
      return [
        join(home, "Android/Sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk"
      ];
    case "win32": // Windows
      return [
        join(home, "AppData/Local/Android/Sdk"),
        "C:/Android/Sdk",
        "C:/android-sdk"
      ];
    default:
      return [];
  }
}

/**
 * Get Homebrew installation path for Android command line tools (macOS only)
 */
export function getHomebrewAndroidToolsPath(systemDetection = createDefaultSystemDetection()): string | null {
  if (systemDetection.getCurrentPlatform() !== "darwin") {
    return null;
  }

  const homebrewPaths = [
    "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest",
    "/usr/local/share/android-commandlinetools/cmdline-tools/latest"
  ];

  for (const homebrewPath of homebrewPaths) {
    if (systemDetection.fileExistsSync(homebrewPath)) {
      return homebrewPath;
    }
  }

  return null;
}

async function getHomebrewAndroidToolsPathAsync(
  systemDetection: SystemDetection
): Promise<string | null> {
  if (systemDetection.getCurrentPlatform() !== "darwin") {
    return null;
  }

  const homebrewPaths = [
    "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest",
    "/usr/local/share/android-commandlinetools/cmdline-tools/latest"
  ];

  for (const homebrewPath of homebrewPaths) {
    if (await systemDetection.fileExists(homebrewPath)) {
      return homebrewPath;
    }
  }

  return null;
}

/**
 * Get Android SDK path from environment variables
 */
export function getAndroidSdkFromEnvironment(systemDetection = createDefaultSystemDetection()): string | null {
  // Check ANDROID_HOME first, then ANDROID_SDK_ROOT
  const androidHome = systemDetection.getEnvVar("ANDROID_HOME");
  if (androidHome && systemDetection.fileExistsSync(androidHome)) {
    return androidHome;
  }

  const androidSdkRoot = systemDetection.getEnvVar("ANDROID_SDK_ROOT");
  if (androidSdkRoot && systemDetection.fileExistsSync(androidSdkRoot)) {
    return androidSdkRoot;
  }

  return null;
}

async function getAndroidSdkFromEnvironmentAsync(
  systemDetection: SystemDetection
): Promise<string | null> {
  const androidHome = systemDetection.getEnvVar("ANDROID_HOME");
  if (androidHome && await systemDetection.fileExists(androidHome)) {
    return androidHome;
  }

  const androidSdkRoot = systemDetection.getEnvVar("ANDROID_SDK_ROOT");
  if (androidSdkRoot && await systemDetection.fileExists(androidSdkRoot)) {
    return androidSdkRoot;
  }

  return null;
}

/**
 * Check if a tool is available in the system PATH
 */
export async function isToolInPath(toolName: string, systemDetection = createDefaultSystemDetection()): Promise<boolean> {
  try {
    const command = systemDetection.getCurrentPlatform() === "win32" ? "where" : "which";
    await systemDetection.executeCommand(command, [toolName]);
    return true;
  } catch (error) {
    rethrowAndroidToolsDetectionControlError(error);
    // which/where exits non-zero when the tool isn't on PATH; that's a normal "not found", not a fault.
    logger.debug(`src/utils/android-cmdline-tools/detection.ts fallback failed: ${error}`, error);
    return false;
  }
}

/**
 * Get the full path to a tool in PATH
 */
export async function getToolPathFromPath(toolName: string, systemDetection = createDefaultSystemDetection()): Promise<string | null> {
  try {
    const command = systemDetection.getCurrentPlatform() === "win32" ? "where" : "which";
    const result = await systemDetection.executeCommand(command, [toolName]);
    const path = result.stdout.trim().split("\n")[0]; // Take first result if multiple
    return path || null;
  } catch (error) {
    rethrowAndroidToolsDetectionControlError(error);
    // which/where exits non-zero when the tool isn't on PATH; null tells the caller to keep searching.
    logger.debug(`src/utils/android-cmdline-tools/detection.ts fallback failed: ${error}`, error);
    return null;
  }
}

/**
 * Check if a directory contains Android command line tools
 */
export function getAvailableToolsInDirectory(toolsDir: string, systemDetection = createDefaultSystemDetection()): string[] {
  if (!systemDetection.fileExistsSync(toolsDir)) {
    return [];
  }

  const availableTools: string[] = [];
  const binDir = join(toolsDir, "bin");

  // Check if bin directory exists
  if (!systemDetection.fileExistsSync(binDir)) {
    return [];
  }

  // Check each tool
  for (const toolName of Object.keys(ANDROID_TOOLS)) {
    const toolPath = join(binDir, toolName);
    const toolPathWithExt = join(binDir, `${toolName}.bat`); // Windows

    if (systemDetection.fileExistsSync(toolPath) || systemDetection.fileExistsSync(toolPathWithExt)) {
      availableTools.push(toolName);
    }
  }

  return availableTools;
}

async function getAvailableToolsInDirectoryAsync(
  toolsDir: string,
  systemDetection: SystemDetection
): Promise<string[]> {
  if (!await systemDetection.fileExists(toolsDir)) {
    return [];
  }

  const availableTools: string[] = [];
  const binDir = join(toolsDir, "bin");
  if (!await systemDetection.fileExists(binDir)) {
    return [];
  }

  for (const toolName of Object.keys(ANDROID_TOOLS)) {
    const toolPath = join(binDir, toolName);
    const toolPathWithExt = join(binDir, `${toolName}.bat`);
    if (await systemDetection.fileExists(toolPath) || await systemDetection.fileExists(toolPathWithExt)) {
      availableTools.push(toolName);
    }
  }

  return availableTools;
}

/**
 * Detect Android command line tools installation from Homebrew (macOS only)
 */
export async function detectHomebrewAndroidTools(systemDetection = createDefaultSystemDetection()): Promise<AndroidToolsLocation | null> {
  const homebrewPath = await getHomebrewAndroidToolsPathAsync(systemDetection);
  if (!homebrewPath) {
    return null;
  }

  const availableTools = await getAvailableToolsInDirectoryAsync(homebrewPath, systemDetection);
  if (availableTools.length === 0) {
    return null;
  }

  return {
    path: homebrewPath,
    source: "homebrew",
    available_tools: availableTools
  };
}

/**
 * Detect Android command line tools from Android SDK installation
 */
export async function detectAndroidSdkTools(systemDetection = createDefaultSystemDetection()): Promise<AndroidToolsLocation[]> {
  const locations: AndroidToolsLocation[] = [];
  logger.debug("Looking for Android SDK tools");

  // Check environment variables
  const sdkPath = await getAndroidSdkFromEnvironmentAsync(systemDetection);
  if (sdkPath) {
    const cmdlineToolsPath = join(sdkPath, "cmdline-tools", "latest");
    const availableTools = await getAvailableToolsInDirectoryAsync(cmdlineToolsPath, systemDetection);

    if (availableTools.length > 0) {
      const source = systemDetection.getEnvVar("ANDROID_HOME") ? "android_home" : "android_sdk_root";

      locations.push({
        path: cmdlineToolsPath,
        source,
        available_tools: availableTools
      });
    }
  }

  // Check typical installation paths
  const typicalPaths = getTypicalAndroidSdkPaths(systemDetection);
  for (const sdkPath of typicalPaths) {
    logger.debug(`Checking typical path for Android SDK: ${sdkPath}`);
    // Skip if we already found this path from environment
    const androidHome = systemDetection.getEnvVar("ANDROID_HOME");
    const androidSdkRoot = systemDetection.getEnvVar("ANDROID_SDK_ROOT");
    if (androidHome === sdkPath || androidSdkRoot === sdkPath) {
      continue;
    }

    const cmdlineToolsPath = join(sdkPath, "cmdline-tools", "latest");
    const availableTools = await getAvailableToolsInDirectoryAsync(cmdlineToolsPath, systemDetection);

    if (availableTools.length > 0) {
      locations.push({
        path: cmdlineToolsPath,
        source: "typical",
        available_tools: availableTools
      });
    }
  }

  return locations;
}

/**
 * Detect Android command line tools available in PATH
 */
async function detectAndroidToolsInPath(systemDetection = createDefaultSystemDetection()): Promise<AndroidToolsLocation | null> {
  const availableTools: string[] = [];
  const toolPaths: Record<string, string> = {};
  logger.debug("Looking for Android SDK tools in PATH");

  // Check each tool individually
  for (const toolName of Object.keys(ANDROID_TOOLS)) {
    if (await isToolInPath(toolName, systemDetection)) {
      const toolPath = await getToolPathFromPath(toolName, systemDetection);
      if (toolPath) {
        logger.debug(`Tool ${toolName} was in PATH`);
        availableTools.push(toolName);
        toolPaths[toolName] = toolPath;
      }
    }
  }

  if (availableTools.length === 0) {
    return null;
  }

  // Try to determine a common path (directory containing most tools)
  const directories = Object.values(toolPaths).map(p => dirname(p));
  const directoryCount = directories.reduce((acc, dir) => {
    acc[dir] = (acc[dir] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const mostCommonDir = Object.entries(directoryCount)
    .sort(([, a], [, b]) => b - a)[0]?.[0];

  const basePath = mostCommonDir ? dirname(mostCommonDir) : "";

  return {
    path: basePath,
    source: "path",
    available_tools: availableTools
  };
}

/**
 * Comprehensive detection of all Android command line tools installations
 */
export async function detectAndroidCommandLineTools(systemDetection = defaultSystemDetection): Promise<AndroidToolsLocation[]> {
  const cachedLocations = cachedAndroidToolsLocations.get(systemDetection);
  if (cachedLocations !== undefined) {
    logger.debug("Already cached Android tools locations. Returning cached result.");
    return cachedLocations;
  }

  const locations: AndroidToolsLocation[] = [];

  logger.debug("Starting Android command line tools detection...");

  // 1. Check Homebrew installation (macOS only)
  try {
    const homebrewLocation = await detectHomebrewAndroidTools(systemDetection);
    if (homebrewLocation) {
      locations.push(homebrewLocation);
      logger.debug(`Found Homebrew Android tools at: ${homebrewLocation.path}`);
    }
  } catch (error) {
    rethrowAndroidToolsDetectionControlError(error);
    logger.warn(`Error detecting Homebrew Android tools: ${(error as Error).message}`);
  }

  // 2. Check Android SDK installations
  try {
    const sdkLocations = await detectAndroidSdkTools(systemDetection);
    locations.push(...sdkLocations);
    for (const location of sdkLocations) {
      logger.debug(`Found Android SDK tools at: ${location.path} (source: ${location.source})`);
    }
  } catch (error) {
    rethrowAndroidToolsDetectionControlError(error);
    logger.warn(`Error detecting Android SDK tools: ${(error as Error).message}`);
  }

  // 3. Check PATH
  try {
    const pathLocation = await detectAndroidToolsInPath(systemDetection);
    if (pathLocation) {
      locations.push(pathLocation);
      logger.debug(`Found Android tools in PATH: ${pathLocation.available_tools.join(", ")}`);
    }
  } catch (error) {
    rethrowAndroidToolsDetectionControlError(error);
    logger.warn(`Error detecting Android tools in PATH: ${(error as Error).message}`);
  }

  // Remove duplicates based on path while preserving first-seen ordering.
  const uniqueLocationsByPath = new Map<string, AndroidToolsLocation>();
  for (const location of locations) {
    if (!uniqueLocationsByPath.has(location.path)) {
      uniqueLocationsByPath.set(location.path, location);
    }
  }
  const uniqueLocations = Array.from(uniqueLocationsByPath.values());

  logger.debug(`Detection complete. Found ${uniqueLocations.length} unique Android tools installations.`);

  cachedAndroidToolsLocations.set(systemDetection, uniqueLocations);
  return uniqueLocations;
}

/**
 * Get the best Android tools installation based on source priority and number of available tools
 */
export function getBestAndroidToolsLocation(locations: AndroidToolsLocation[]): AndroidToolsLocation | null {
  if (locations.length === 0) {
    return null;
  }

  // Priority order: android_home > android_sdk_root > typical > homebrew > path > manual
  const sourcePriority: Record<AndroidToolsSource, number> = {
    android_home: 1,
    android_sdk_root: 2,
    typical: 3,
    homebrew: 4,
    path: 5,
    manual: 6
  };

  // Score each location based on source priority and number of available tools
  const scored = locations.map(location => {
    const sourcePriorityScore = sourcePriority[location.source] || 10;
    const totalTools = location.available_tools.length;

    // Lower score is better (higher priority)
    const score = sourcePriorityScore * 100 - totalTools;

    return { location, score };
  });

  // Sort by score (ascending - lower is better)
  scored.sort((a, b) => a.score - b.score);

  return scored[0]?.location || null;
}

/**
 * Validate that required Android tools are available at a location
 */
export function validateRequiredTools(location: AndroidToolsLocation, requiredTools: string[]): {
  valid: boolean;
  missing: string[];
} {
  const missing = requiredTools.filter(tool => !location.available_tools.includes(tool));

  return {
    valid: missing.length === 0,
    missing
  };
}
