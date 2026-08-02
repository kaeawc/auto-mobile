import { ChildProcess, execFile, spawn } from "child_process";
import { existsSync } from "node:fs";
import { promisify } from "util";
import { logger } from "../logger";
import { BootedDevice, DeviceInfo, ExecResult, ActionableError } from "../../models";
import { AdbClientFactory, defaultAdbClientFactory } from "./AdbClientFactory";
import { arch } from "os";
import { detectAndroidCommandLineTools, getBestAndroidToolsLocation } from "./detection";
import { defaultTimer, Timer } from "../SystemTimer";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import type { AvdConfigReader } from "./AvdConfigReader";
import { FileAvdConfigReader, MIN_AVD_RAM_MB } from "./AvdConfigReader";
import { WakeAndUnlock } from "../../features/action/WakeAndUnlock";
import { DeviceLockStore } from "../../features/action/DeviceLockStore";
import type { FormFactor } from "../../models/DeviceMatchCriteria";
import type { AdbDeviceState } from "./interfaces/AdbExecutor";

const MODERN_PLAY_IMAGE_MIN_API_LEVEL = 30;
const OFFLINE_DEVICE_THRESHOLD_MS = 15_000;

/**
 * Interface for Android Emulator (AVD) management
 * Provides emulator lifecycle and control capabilities
 */
export interface AndroidEmulatorLaunchRequest {
  /** The configured Android Virtual Device to launch. */
  avdName: string;
  /**
   * The expected ADB serial, when the caller already knows it. This remains
   * authoritative during readiness checks instead of relying on AVD-name
   * discovery from a concurrently starting emulator.
   */
  deviceId?: string;
  /** Additional, already-tokenized emulator arguments. */
  extraArgs?: readonly string[];
  /** Cancels a launch that has not begun, or disposes a completed launch. */
  signal?: AbortSignal;
}

export interface AndroidEmulatorLaunchHandle {
  readonly avdName: string;
  readonly process: ChildProcess | null;
  readonly targetDeviceId?: string;
  /** Stops the emulator only when this launch created its process. */
  dispose(): void;
}

export interface AndroidEmulator {
  /**
   * Execute an emulator command
   * @param command - The command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with stdout and stderr
   */
  executeCommand(args: string[], timeoutMs?: number): Promise<ExecResult>;

  /**
   * List all available AVDs
   * @returns Promise with array of AVD names
   */
  listAvds(): Promise<DeviceInfo[]>;

  /**
   * Check if a specific AVD is running
   * @param avdName - The AVD name to check
   * @returns Promise with boolean indicating if the AVD is running
   */
  isAvdRunning(avdName: string): Promise<boolean>;

  /**
   * Check if a specific AVD is currently starting (booting up)
   * @param avdName - The AVD name to check
   * @returns Promise with boolean indicating if the AVD is currently starting
   */
  isAvdStarting(avdName: string): Promise<boolean>;

  /**
   * Check if any emulator is currently running
   * @returns Promise with array of running emulator info
   */
  getBootedDevices(onlyEmulators?: boolean): Promise<BootedDevice[]>;

  /**
   * Start an emulator with the specified AVD
   * @param avdName - The AVD name to start
   * @returns Promise with the spawned child process
   */
  startEmulator(avdName: string): Promise<ChildProcess | null>;

  /** Launch an AVD with structured context and an owned lifecycle handle. */
  launchEmulator(request: AndroidEmulatorLaunchRequest): Promise<AndroidEmulatorLaunchHandle>;

  /**
   * Kill a running emulator
   * @param device - The device to kill
   * @returns Promise that resolves when emulator is stopped
   */
  killDevice(device: BootedDevice): Promise<void>;

  /**
   * Wait for the emulator to be ready for use
   * @param avdName - The AVD name to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120000 = 2 minutes)
   * @param childProcess - Optional child process to monitor for early exit
   * @param targetDeviceId - Optional adb device id to require when waiting for an already-running device
   * @returns Promise that resolves with device ID when emulator is ready
   */
  waitForEmulatorReady(avdName: string, timeoutMs?: number, childProcess?: ChildProcess | null, targetDeviceId?: string): Promise<BootedDevice>;
}

/**
 * Infer form factor from AVD device name.
 * Tablet device names typically contain "tab", "pad", or "nexus_9/10".
 */
export function inferAndroidFormFactor(deviceName?: string): FormFactor | undefined {
  if (!deviceName) {return undefined;}
  const lower = deviceName.toLowerCase();
  if (lower.includes("tab") || lower.includes("pad")) {return "tablet";}
  // Nexus 9 and 10 are tablets
  if (lower.includes("nexus_9") || lower.includes("nexus_10") || lower.includes("nexus 9") || lower.includes("nexus 10")) {return "tablet";}
  // Pixel Tablet
  if (lower.includes("pixel_tablet") || lower.includes("pixel tablet")) {return "tablet";}
  // Most other devices (pixel, nexus 5/6, etc.) are phones
  if (lower.includes("pixel") || lower.includes("phone") || lower.includes("nexus")) {return "phone";}
  return undefined;
}

/**
 * Decide whether the emulator should launch headless (`-no-window`).
 *
 * Resolution order:
 * 1. `AUTOMOBILE_EMULATOR_HEADLESS=true`  → always headless.
 * 2. `AUTOMOBILE_EMULATOR_HEADLESS=false` → always windowed (honor the explicit
 *    opt-out even on a Linux host with no display).
 * 3. Linux with no usable display server (`DISPLAY`/`WAYLAND_DISPLAY` unset or
 *    blank) → headless, because a windowed launch aborts on the Qt `xcb`
 *    platform plugin (see issue #2722).
 * 4. Otherwise → windowed (macOS/Windows have a native display; Linux has one).
 *
 * @param platform - `process.platform` value
 * @param env - environment variables to read
 * @returns the resolved mode plus a human-readable reason for logging
 */
export function resolveHeadlessMode(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): { headless: boolean; reason: string } {
  const explicit = env.AUTOMOBILE_EMULATOR_HEADLESS;
  if (explicit === "true") {
    return { headless: true, reason: "AUTOMOBILE_EMULATOR_HEADLESS=true" };
  }
  if (explicit === "false") {
    return { headless: false, reason: "AUTOMOBILE_EMULATOR_HEADLESS=false (windowed forced)" };
  }

  if (platform === "linux") {
    const hasDisplay = Boolean((env.DISPLAY && env.DISPLAY.trim()) || (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim()));
    if (!hasDisplay) {
      return {
        headless: true,
        reason: "no DISPLAY/WAYLAND_DISPLAY detected on Linux; defaulting to -no-window",
      };
    }
  }

  return { headless: false, reason: "usable display detected" };
}

/**
 * Parse `AUTOMOBILE_EMULATOR_ARGS` as a JSON argv array.
 *
 * This deliberately does not split on whitespace: a value such as
 * `"swiftshader indirect"` must remain a single argv member, and shell-style
 * quoting is not a portable or safe configuration language. Callers that
 * construct launches programmatically should use `extraArgs` instead.
 */
export function parseExtraEmulatorArguments(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ActionableError(
      "AUTOMOBILE_EMULATOR_ARGS must be a JSON array of emulator arguments, for example [\"-gpu\", \"swiftshader_indirect\"]"
    );
  }

  if (!Array.isArray(parsed) || parsed.some(argument => typeof argument !== "string" || argument.length === 0)) {
    throw new ActionableError(
      "AUTOMOBILE_EMULATOR_ARGS must be a JSON array containing non-empty string arguments"
    );
  }

  return [...parsed];
}

const execAsync = async (file: string, args: string[], signal?: AbortSignal): Promise<ExecResult> => {
  // Run the emulator binary via execFile (argv, no shell) rather than exec. This
  // removes the shell entirely — command arguments such as AVD names are passed
  // literally instead of being interpreted/split by a shell (issue #3938) — and
  // the AbortSignal is forwarded so a timed-out command kills its child instead
  // of leaving it running orphaned.
  const options: Parameters<typeof execFile>[2] = signal ? { signal } : undefined;
  const result = await promisify(execFile)(file, args, options);

  // Add the required string methods
  // noinspection UnnecessaryLocalVariableJS
  const enhancedResult: ExecResult = {
    stdout: typeof result.stdout === "string" ? result.stdout : result.stdout.toString(),
    stderr: typeof result.stderr === "string" ? result.stderr : result.stderr.toString(),
    toString() {
      return this.stdout;
    },
    trim() {
      return this.stdout.trim();
    },
    includes(searchString: string) {
      return this.stdout.includes(searchString);
    }
  };

  return enhancedResult;
};

export class AndroidEmulatorClient implements AndroidEmulator {
  private execAsync: (file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  private spawnFn: typeof spawn;
  private emulatorPath: string;
  private timer: Timer;
  private adbFactory: AdbClientFactory;
  private modelNameCache = new Map<string, string>();
  private avdConfigReader: AvdConfigReader;
  private readonly launchTargetDeviceIds = new WeakMap<ChildProcess, string>();
  private readonly launchErrors = new WeakMap<ChildProcess, ActionableError>();

  /**
   * Create an AndroidEmulatorClient instance
   * @param execAsyncFn - promisified exec function (for testing)
   * @param spawnFn - spawn function (for testing)
   * @param timer - Timer for delays
   * @param adbFactory - Factory for creating AdbClient instances (for testing)
   * @param avdConfigReader - Reader for AVD config.ini files (for testing)
   */
  constructor(
    execAsyncFn: ((file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>) | null = null,
    spawnFn: typeof spawn | null = null,
    timer: Timer = defaultTimer,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    avdConfigReader?: AvdConfigReader
  ) {
    this.execAsync = execAsyncFn || execAsync;
    this.spawnFn = spawnFn || spawn;
    this.timer = timer;
    this.adbFactory = adbFactory;
    this.avdConfigReader = avdConfigReader ?? new FileAvdConfigReader();
    // Only set a fallback emulator path here; proper detection happens lazily
    this.emulatorPath = this.getFallbackEmulatorPath();
  }

  /**
   * Get the path to the emulator executable.
   * This function tries the best available path synchronously, falling back to env/PATH.
   * Actual async detection is performed when needed by ensureEmulatorPath().
   * @returns The path to the emulator
   */
  private getFallbackEmulatorPath(): string {
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_SDK_HOME;
    if (androidHome) {
      return `${androidHome}/emulator/emulator`;
    }
    return "emulator";
  }

  /**
   * Try multiple common paths to find the emulator executable
   * @returns Promise<string | null> The emulator path if found, null otherwise
   */
  private async tryMultiplePaths(): Promise<string | null> {
    const { existsSync } = require("fs");
    const path = require("path");

    // Build list of potential emulator paths
    const potentialPaths: string[] = [];

    // 1. Check environment variables first (highest priority)
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_SDK_HOME;
    if (androidHome) {
      potentialPaths.push(`${androidHome}/emulator/emulator`);
      potentialPaths.push(`${androidHome}/emulator/emulator-arm64-v8a`);
    }

    // 2. Check standard macOS Android SDK location
    const homeDir = process.env.HOME || process.env.USERPROFILE;
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
        const sdkRoot = bestLocation.path.replace("/cmdline-tools/latest", "").replace("/cmdline-tools", "");
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
   * Enrich a list of DeviceInfo with config.ini metadata (osVersion, screen size, form factor)
   */
  private async enrichDeviceInfoList(devices: DeviceInfo[]): Promise<DeviceInfo[]> {
    const enriched = await Promise.all(
      devices.map(async device => {
        try {
          const config = await this.avdConfigReader.readConfig(device.name);
          if (!config) {return device;}
          return {
            ...device,
            osVersion: config.osVersion ?? device.osVersion,
            screenWidth: config.screenWidth ?? device.screenWidth,
            screenHeight: config.screenHeight ?? device.screenHeight,
            screenDensity: config.screenDensity ?? device.screenDensity,
            formFactor: inferAndroidFormFactor(config.deviceName) ?? device.formFactor,
          };
        } catch (error) {
          logger.debug(`Failed to enrich AVD ${device.name}: ${error}`);
          return device;
        }
      })
    );
    return enriched;
  }

  /**
   * Gets the emulator path asynchronously via detection.
   * @returns Promise<string>
   */
  private async getEmulatorPath(): Promise<string> {
    // Try multiple common paths
    const foundPath = await this.tryMultiplePaths();
    if (foundPath) {
      return foundPath;
    }

    // Fall back to default
    return this.getFallbackEmulatorPath();
  }

  /**
   * Ensure emulator path is properly detected and cached
   */
  private async ensureEmulatorPath(): Promise<string> {
    // Update cached path if needed
    const detectedPath = await this.getEmulatorPath();
    this.emulatorPath = detectedPath;
    return this.emulatorPath;
  }

  private isResolvedEmulatorPathAvailable(): boolean {
    const trimmedPath = this.emulatorPath.trim();
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
  private describeEmulatorResolution(): string {
    const unset = "<unset>";
    return [
      `  resolved emulator path: ${this.emulatorPath || unset}`,
      `  ANDROID_HOME=${process.env.ANDROID_HOME ?? unset}`,
      `  ANDROID_SDK_ROOT=${process.env.ANDROID_SDK_ROOT ?? unset}`,
      `  ANDROID_SDK_HOME=${process.env.ANDROID_SDK_HOME ?? unset}`,
      `  PATH=${process.env.PATH ?? unset}`,
    ].join("\n");
  }

  private isLikelyDaemonWorkingDirectoryFailure(errorMsg: string): boolean {
    if (!this.isResolvedEmulatorPathAvailable()) {
      return false;
    }

    const lowerError = errorMsg.toLowerCase();
    return (lowerError.includes("enoent") && lowerError.includes("spawn"))
      || lowerError.includes("getcwd")
      || lowerError.includes("current working directory")
      || lowerError.includes("current directory");
  }

  /**
   * Get the host architecture
   * @returns The host architecture string
   */
  private getHostArchitecture(): string {
    return arch();
  }

  /**
   * Check if an AVD architecture is compatible with the host
   * @param avdName - The AVD name to check
   * @returns Promise with compatibility result
   */
  private async checkArchitectureCompatibility(avdName: string): Promise<{
    compatible: boolean;
    hostArch: string;
    avdArch?: string;
    reason?: string
  }> {
    const hostArch = this.getHostArchitecture();

    try {
      // Get AVD config to determine its architecture
      const result = await this.executeCommand(["-avd", avdName, "-verbose"], 3000);
      const output = result.stdout + result.stderr;

      // Look for architecture information in the output
      let avdArch: string | undefined;

      // Check for target architecture in verbose output
      const archMatch = output.match(/Found AVD target architecture: (\w+)/);
      if (archMatch) {
        avdArch = archMatch[1];
      }

      // If we couldn't determine from verbose output, try to infer from common patterns
      if (!avdArch) {
        // This is a fallback - we'll let the actual emulator start attempt reveal the issue
        return { compatible: true, hostArch, reason: "Could not determine AVD architecture, allowing attempt" };
      }

      // Check compatibility
      const compatible = this.isArchitectureCompatible(hostArch, avdArch);
      const reason = compatible ? undefined : `Host architecture '${hostArch}' cannot run AVD with architecture '${avdArch}'`;

      return { compatible, hostArch, avdArch, reason };
    } catch (error) {
      // If we can't check, we'll let the emulator start attempt proceed and catch errors there
      logger.debug(`Could not check architecture compatibility for ${avdName}: ${error}`);
      return { compatible: true, hostArch, reason: "Could not verify compatibility, allowing attempt" };
    }
  }

  /**
   * Check if host architecture can run AVD architecture
   * @param hostArch - Host architecture
   * @param avdArch - AVD architecture
   * @returns Boolean indicating compatibility
   */
  private isArchitectureCompatible(hostArch: string, avdArch: string): boolean {
    // ARM64 hosts (Apple Silicon) cannot run x86/x86_64 AVDs
    if ((hostArch === "arm64" || hostArch === "aarch64") && (avdArch === "x86" || avdArch === "x86_64")) {
      return false;
    }

    // x86_64 hosts can generally run both x86 and ARM (with performance impact)
    // ARM hosts can run ARM AVDs
    return true;
  }

  /**
   * Detect if emulator output contains architecture-related PANIC errors
   * @param output - Emulator output to check
   * @returns Error details if PANIC detected, null otherwise
   */
  private detectArchitecturePanic(output: string): {
    isPanic: boolean;
    message?: string;
    hostArch?: string;
    avdArch?: string
  } {
    // Look for the specific PANIC message about architecture compatibility
    const panicMatch = output.match(/PANIC: Avd's CPU Architecture '(\w+)' is not supported by the QEMU2 emulator on (\w+) host/);

    if (panicMatch) {
      const avdArch = panicMatch[1];
      const hostArch = panicMatch[2];
      return {
        isPanic: true,
        message: `AVD architecture '${avdArch}' is not supported on ${hostArch} host`,
        hostArch,
        avdArch
      };
    }

    // Check for other PANIC messages that might be architecture-related
    if (output.includes("PANIC:") && (output.includes("architecture") || output.includes("CPU") || output.includes("QEMU"))) {
      return {
        isPanic: true,
        message: "Emulator PANIC detected (possibly architecture-related)",
      };
    }

    return { isPanic: false };
  }

  /** Detect sandbox/JIT entitlement failures that leave an emulator offline. */
  detectSandboxMprotect(output: string): {
    isSandboxError: boolean;
    message?: string;
    suggestion?: string;
  } {
    const mprotectFailure = /qemu_mprotect__osdep:\s*mprotect failed:\s*permission denied/i.test(output);
    const hvfFailure = /hvf is not enabled on this aarch64 host/i.test(output);
    if (!mprotectFailure && !hvfFailure) {
      return { isSandboxError: false };
    }

    return {
      isSandboxError: true,
      message: "Emulator hypervisor initialization failed (mprotect/HVF is unavailable)",
      suggestion: "Run the emulator outside the restrictive sandbox or grant the host hypervisor/JIT entitlement required by QEMU.",
    };
  }

  private sandboxFailure(output: string): ActionableError | null {
    const result = this.detectSandboxMprotect(output);
    if (!result.isSandboxError) {return null;}
    return new ActionableError([
      `Emulator failed to start: ${result.message}`,
      result.suggestion ? `Suggestion: ${result.suggestion}` : "",
    ].filter(Boolean).join("\n\n"));
  }

  private async validateAvdMemory(avdName: string): Promise<void> {
    const avdConfig = await this.avdConfigReader.readConfig(avdName);
    if (!avdConfig) {return;}
    const isModernPlayImage = avdConfig.tag?.toLowerCase().includes("play")
      && (avdConfig.apiLevel ?? 0) >= MODERN_PLAY_IMAGE_MIN_API_LEVEL;
    if (isModernPlayImage && avdConfig.ramSizeMb !== undefined && avdConfig.ramSizeMb < MIN_AVD_RAM_MB) {
      throw new ActionableError(
        `Cannot start AVD '${avdName}': hw.ramSize is ${avdConfig.ramSizeMb} MB, below the minimum ${MIN_AVD_RAM_MB} MB needed for a modern system image. Increase hw.ramSize in the AVD config and retry.`
      );
    }
  }

  private async detectOfflineFailure(
    avdName: string,
    deviceId: string | undefined,
    tracker: { deviceId: string | null; since: number | null },
  ): Promise<ActionableError | null> {
    let states: AdbDeviceState[];
    try {
      states = await this.adbFactory.create(null).getDeviceStates?.() ?? [];
    } catch (error) {
      logger.debug(`Offline-state probe unavailable during emulator readiness: ${error instanceof Error ? error.message : String(error)}`);
      tracker.deviceId = null;
      tracker.since = null;
      return null;
    }
    const targetState = deviceId
      ? states.find((state: AdbDeviceState) => state.deviceId === deviceId)
      : undefined;
    if (targetState?.state !== "offline") {
      tracker.deviceId = null;
      tracker.since = null;
      return null;
    }
    if (tracker.deviceId !== targetState.deviceId) {
      tracker.deviceId = targetState.deviceId;
      tracker.since = this.timer.now();
    }
    if (tracker.since !== null && this.timer.now() - tracker.since >= OFFLINE_DEVICE_THRESHOLD_MS) {
      return new ActionableError(
        `Emulator '${avdName}' (${targetState.deviceId}) has remained offline for ${OFFLINE_DEVICE_THRESHOLD_MS / 1000} seconds. Restart it outside the restrictive sandbox and verify that adb can reach the emulator.`
      );
    }
    return null;
  }

  /**
   * Detect corrupt disk image errors in emulator output.
   * Returns an actionable error message if corruption is detected.
   */
  detectCorruptImage(output: string): {
    isCorrupt: boolean;
    message?: string;
    suggestion?: string;
  } {
    // qcow2 corruption: "qcow2: Image is corrupt; cannot be opened read/write"
    const qcow2Match = output.match(/qcow2:\s*(.*corrupt[^"\n]*)/i);
    if (qcow2Match) {
      return {
        isCorrupt: true,
        message: `Disk image is corrupt: ${qcow2Match[1].trim()}`,
        suggestion: "Delete the corrupt userdata overlay to force a fresh image:\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img.qcow2\nThe emulator will recreate it on next boot. All emulator data (installed apps, settings) will be lost.",
      };
    }

    // Generic disk image errors
    const diskErrorMatch = output.match(/(cannot open disk image|disk image .* is (?:corrupt|invalid|damaged)|failed to open .*\.img)/i);
    if (diskErrorMatch) {
      return {
        isCorrupt: true,
        message: `Disk image error: ${diskErrorMatch[1].trim()}`,
        suggestion: "Try deleting corrupt overlay files in ~/.android/avd/<AVD_NAME>.avd/ and restarting the emulator.",
      };
    }

    // QEMU abnormal exit with corruption context
    if (output.includes("QEMU main loop exits abnormally") && (output.includes("corrupt") || output.includes("qcow2"))) {
      return {
        isCorrupt: true,
        message: "QEMU exited abnormally due to disk image corruption",
        suggestion: "Delete the corrupt userdata overlay to force a fresh image:\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img.qcow2\nThe emulator will recreate it on next boot.",
      };
    }

    return { isCorrupt: false };
  }

  /**
   * Detect display / Qt platform-plugin errors in emulator output.
   *
   * On a headless host a windowed emulator cannot connect to the X display,
   * fails to load the Qt `xcb` platform plugin, and is killed by signal — which
   * Node reports as `code: null`. This surfaces that root cause instead of the
   * opaque "exited with code: null" (see issue #2722).
   */
  detectDisplayError(output: string): {
    isDisplayError: boolean;
    message?: string;
    suggestion?: string;
  } {
    const noDisplay = /could not connect to display/i.test(output);
    const qtPlugin = /could not load the Qt platform plugin/i.test(output);

    if (noDisplay || qtPlugin) {
      return {
        isDisplayError: true,
        message: "Emulator could not connect to a display (Qt 'xcb' platform plugin failed to load)",
        suggestion:
          "Run the emulator headless by setting AUTOMOBILE_EMULATOR_HEADLESS=true " +
          "(adds -no-window -no-audio), or start an X server / export DISPLAY before launching.",
      };
    }

    return { isDisplayError: false };
  }

  /**
   * Execute an emulator command
   * @param command - The command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with stdout and stderr
   */
  async executeCommand(args: string[], timeoutMs?: number): Promise<ExecResult> {
    const emulatorPath = await this.ensureEmulatorPath();
    const fullCommand = `${emulatorPath} ${args.join(" ")}`;
    logger.debug(`Executing emulator command: ${fullCommand}`);

    // Use Promise.race to implement timeout if specified. On timeout we abort the
    // controller so the underlying child process is killed rather than left
    // running orphaned (issue #3938).
    if (timeoutMs) {
      let timeoutId: NodeJS.Timeout;
      const controller = new AbortController();

      const timeoutPromise = new Promise<ExecResult>((_, reject) => {
        timeoutId = this.timer.setTimeout(() => {
          controller.abort();
          reject(new ActionableError(`Command timed out after ${timeoutMs}ms: ${fullCommand}`));
        }, timeoutMs);
      });

      const runPromise = this.execAsync(emulatorPath, args, controller.signal);
      // Once the timeout wins the race the aborted run promise rejects with an
      // AbortError; keep it handled so it can't surface as an unhandledRejection.
      runPromise.catch(() => { /* settled after timeout; result consumed via race */ });

      try {
        return await Promise.race([runPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId!);
      }
    }

    return await this.execAsync(emulatorPath, args);
  }

  /**
   * List all available AVDs
   * @returns Promise with array of AVD names
   */
  async listAvds(): Promise<DeviceInfo[]> {
    try {
      const result = await this.executeCommand(["-list-avds"]);
      const devices = result.stdout
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(name => ({ name, platform: "android", isRunning: false, source: "local" } as DeviceInfo));
      return this.enrichDeviceInfoList(devices);
    } catch (error) {
      logger.error("Failed to list AVDs:", error);

      // Check if the error is because emulator is not found
      const errorMsg = error instanceof Error ? error.message : String(error);
      const missingEmulator = errorMsg.includes("No such file or directory") || errorMsg.includes("command not found") || errorMsg.includes("ENOENT");
      if (missingEmulator && this.isLikelyDaemonWorkingDirectoryFailure(errorMsg)) {
        throw new ActionableError(
          `Android emulator command failed because the daemon working directory is unavailable. ` +
          `Restart the AutoMobile daemon so it can use a stable working directory. Underlying error: ${errorMsg}`
        );
      }
      if (missingEmulator) {
        throw new ActionableError(
          `Android emulator not found.\n${this.describeEmulatorResolution()}\n\n` +
          `Install the emulator package with: sdkmanager --install "emulator"\n` +
          `(Android Studio installs it too: https://developer.android.com/studio)\n` +
          `Or point ANDROID_HOME at an SDK that already has emulator/emulator.`
        );
      }

      throw new ActionableError(`Failed to list AVDs: ${errorMsg}`);
    }
  }

  /**
   * Check if a specific AVD is running
   * @param avdName - The AVD name to check
   * @returns Promise with boolean indicating if the AVD is running
   */
  async isAvdRunning(avdName: string): Promise<boolean> {
    const runningEmulators = await this.getBootedDevices();
    return runningEmulators.some(emulator => emulator.name === avdName);
  }

  /**
   * Check if a specific AVD is currently starting (booting up)
   * @param avdName - The AVD name to check
   * @returns Promise with boolean indicating if the AVD is currently starting
   */
  async isAvdStarting(avdName: string): Promise<boolean> {
    try {
      const { existsSync, readdirSync, readFileSync } = require("fs");
      const path = require("path");

      // Check the temp directory where emulator advertises running instances
      const runningDir = path.join(require("os").tmpdir(), "avd", "running");

      if (!existsSync(runningDir)) {
        return false;
      }

      // Read all pid_*.ini files
      const files = readdirSync(runningDir);
      const pidFiles = files.filter((f: string) => f.startsWith("pid_") && f.endsWith(".ini"));

      for (const file of pidFiles) {
        try {
          const filePath = path.join(runningDir, file);
          const content = readFileSync(filePath, "utf-8");

          // Check if this file is for our AVD
          const avdIdMatch = content.match(/^avd\.id=(.+)$/m);
          if (avdIdMatch && avdIdMatch[1] === avdName) {
            // Extract PID from filename (pid_12345.ini -> 12345)
            const pidMatch = file.match(/pid_(\d+)\.ini/);
            if (pidMatch) {
              const pid = parseInt(pidMatch[1], 10);

              // Check if the process is still alive
              try {
                process.kill(pid, 0); // Signal 0 checks if process exists without killing it
                logger.info(`AVD '${avdName}' is currently starting (PID: ${pid})`);
                return true;
              } catch (e) {
                // Process doesn't exist, the pid file is stale
                logger.debug(`Stale pid file found for AVD '${avdName}' (PID ${pid} not running)`);
              }
            }
          }
        } catch (error) {
          logger.debug(`Failed to read pid file ${file}: ${error}`);
        }
      }

      return false;
    } catch (error) {
      logger.debug(`Failed to check if AVD is starting: ${error}`);
      return false;
    }
  }

  /**
   * Check if any emulator is currently running
   * @returns Promise with array of running emulator info
   */
  async getBootedDevices(onlyEmulators: boolean = false): Promise<BootedDevice[]> {
    try {
      return await this.getBootedDevicesChecked(onlyEmulators);
    } catch (error) {
      logger.debug(`[DeviceListTimeout] Failed to get running emulators: ${error}`);
      return [];
    }
  }

  /**
   * Like {@link getBootedDevices} but rethrows discovery failures (e.g. adb
   * unreachable) instead of swallowing them into an empty list. Callers that
   * must distinguish "no emulators are booted" from "adb discovery failed"
   * should use this.
   */
  async getBootedDevicesChecked(
    onlyEmulators: boolean = false,
    options: { bypassDeviceListCache?: boolean } = {}
  ): Promise<BootedDevice[]> {
    const perf = createGlobalPerformanceTracker();
    {
      const adb = this.adbFactory.create(null);
      perf.startOperation("adbDeviceScan");
      const devices = await adb.getBootedAndroidDevices({ bypassCache: options.bypassDeviceListCache });
      perf.endOperation("adbDeviceScan");
      const runningDevices: BootedDevice[] = [];

      // Add local emulator devices
      const emulatorDevices = devices.filter(device => device.deviceId.startsWith("emulator-"));
      const physicalDevices = devices.filter(device => !device.deviceId.startsWith("emulator-"));

      const infoTimeoutMs = 2000;
      perf.startOperation("avdNameResolution");
      for (const device of emulatorDevices) {
        const deviceId = device.deviceId;
        try {
          // Try to get the AVD name from the running emulator
          const adbWithDevice = this.adbFactory.create(device);
          const result = await adbWithDevice.executeCommand("emu avd name", infoTimeoutMs, undefined, true);
          const avdName = result.stdout.trim().replace(/\r?\n.*$/, ""); // Remove any trailing newlines and additional text

          logger.debug(`AVD name detection for ${deviceId}: raw="${result.stdout}" (${result.stdout.length} chars), cleaned="${avdName}"`);

          runningDevices.push({
            ...device,
            name: avdName || this.unknownEmulatorName(deviceId),
            platform: "android",
            deviceId: deviceId,
            source: "local"
          });
        } catch (error) {
          // If we can't get the AVD name, just use the device ID
          logger.debug(`Failed to get AVD name for ${deviceId}: ${error}`);
          runningDevices.push({
            ...device,
            name: this.unknownEmulatorName(deviceId),
            platform: "android",
            deviceId: deviceId,
            source: "local"
          });
        }
      }

      for (const device of physicalDevices) {
        let deviceName = device.deviceId; // Default fallback

        const cachedModel = this.modelNameCache.get(device.deviceId);
        if (cachedModel) {
          deviceName = cachedModel;
          logger.debug(`Got model name for ${device.deviceId}: "${cachedModel}" (cached)`);
        } else {
          try {
            const adbWithDevice = this.adbFactory.create(device);
            const result = await adbWithDevice.executeCommand(
              "shell getprop ro.product.model",
              infoTimeoutMs,
              undefined,
              true
            );
            const modelName = result.stdout.trim();

            if (modelName && modelName !== "unknown" && modelName.length > 0) {
              deviceName = modelName;
              this.modelNameCache.set(device.deviceId, modelName);
              logger.debug(`Got model name for ${device.deviceId}: "${modelName}"`);
            } else {
              logger.debug(`No model name found for ${device.deviceId}, using device ID`);
            }
          } catch (error) {
            logger.debug(`Failed to get model name for ${device.deviceId}: ${error}`);
          }
        }

        runningDevices.push({
          ...device,
          name: deviceName,
          platform: "android",
          deviceId: device.deviceId,
          source: "local"
        });
      }
      perf.endOperation("avdNameResolution");

      return runningDevices;
    }
  }

  /**
   * Start an emulator with the specified AVD
   * @param avdName - The AVD name to start
   * @returns Promise with the spawned child process
   */
  async startEmulator(avdName: string): Promise<ChildProcess | null> {
    return (await this.launchEmulator({ avdName })).process;
  }

  async launchEmulator(request: AndroidEmulatorLaunchRequest): Promise<AndroidEmulatorLaunchHandle> {
    if (request.signal?.aborted) {
      throw new ActionableError(`Android emulator launch for '${request.avdName}' was cancelled`);
    }

    let process: ChildProcess | null = null;
    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (process && !process.killed) {
        process.kill();
      }
    };
    request.signal?.addEventListener("abort", dispose, { once: true });

    try {
      process = await this.startEmulatorProcess(
        request.avdName,
        request.extraArgs,
        spawnedProcess => {
          process = spawnedProcess;
          if (disposed && !spawnedProcess.killed) {
            spawnedProcess.kill();
          }
        },
        () => disposed,
      );
      if (disposed) {
        if (process && !process.killed) {
          process.kill();
        }
        throw new ActionableError(`Android emulator launch for '${request.avdName}' was cancelled`);
      }
    } catch (error) {
      request.signal?.removeEventListener("abort", dispose);
      if (disposed) {
        throw new ActionableError(`Android emulator launch for '${request.avdName}' was cancelled`);
      }
      throw error;
    }
    if (process && request.deviceId) {
      this.launchTargetDeviceIds.set(process, request.deviceId);
    }

    const release = () => {
      if (!disposed) {
        disposed = true;
      }
      request.signal?.removeEventListener("abort", dispose);
    };

    const client = this;
    return {
      avdName: request.avdName,
      process,
      get targetDeviceId() {
        return process ? client.launchTargetDeviceIds.get(process) : request.deviceId;
      },
      dispose: () => {
        dispose();
        release();
      },
    };
  }

  private throwIfLaunchCancelled(avdName: string, isCancelled?: () => boolean): void {
    if (isCancelled?.()) {
      throw new ActionableError(`Android emulator launch for '${avdName}' was cancelled`);
    }
  }

  private async startEmulatorProcess(
    avdName: string,
    requestedExtraArgs?: readonly string[],
    onSpawn?: (process: ChildProcess) => void,
    isCancelled?: () => boolean,
  ): Promise<ChildProcess | null> {
    logger.info(`Using local emulator for AVD: ${avdName}`);
    const perf = createGlobalPerformanceTracker();

    // Check if the AVD exists
    perf.startOperation("validateAvd");
    const availableAvds = await this.listAvds();
    perf.endOperation("validateAvd");
    if (!availableAvds.find(emu => emu.name === avdName)) {
      throw new ActionableError(`AVD '${avdName}' not found. Available AVDs: ${availableAvds.map(emu => emu.name).join(", ")}`);
    }

    // Check if already running or starting
    perf.startOperation("checkAlreadyRunning");
    const alreadyRunning = await this.isAvdRunning(avdName);
    const alreadyStarting = !alreadyRunning && await this.isAvdStarting(avdName);
    perf.endOperation("checkAlreadyRunning");

    if (alreadyRunning) {
      logger.info(`AVD '${avdName}' is already running - waiting for it to be ready`);
      // We did not spawn this AVD, so there is no process handle to hand back.
      // Return null rather than a fabricated `{} as ChildProcess` (issue #3938);
      // the caller (waitForEmulatorReady) waits for readiness regardless.
      return null;
    }

    if (alreadyStarting) {
      logger.info(`AVD '${avdName}' is already starting - waiting for it to be ready`);
      // Started by another actor — no process handle to hand back (issue #3938).
      return null;
    }

    await this.validateAvdMemory(avdName);

    // Check architecture compatibility before attempting to start
    perf.startOperation("architectureCheck");
    const compatibility = await this.checkArchitectureCompatibility(avdName);
    perf.endOperation("architectureCheck");
    if (!compatibility.compatible && compatibility.reason) {
      logger.error(`Architecture compatibility check failed: ${compatibility.reason}`);
      throw new ActionableError(`Cannot start AVD '${avdName}': ${compatibility.reason}. On ${compatibility.hostArch} hosts, use AVDs with compatible architectures (e.g., arm64-v8a for Apple Silicon Macs).`);
    }

    const args = ["-avd", avdName];
    const headlessMode = resolveHeadlessMode(process.platform, process.env);
    logger.info(`Emulator display mode: ${headlessMode.headless ? "headless" : "windowed"} (${headlessMode.reason})`);
    if (headlessMode.headless) {
      args.push("-no-window", "-no-audio");
    }
    const extraArgsRaw = process.env.AUTOMOBILE_EMULATOR_ARGS;
    if (requestedExtraArgs) {
      args.push(...requestedExtraArgs);
    } else if (extraArgsRaw) {
      args.push(...parseExtraEmulatorArguments(extraArgsRaw));
    }
    logger.info(`Starting emulator with AVD: ${avdName}`);
    logger.debug(`Emulator command: ${this.emulatorPath} ${args.join(" ")}`);
    this.throwIfLaunchCancelled(avdName, isCancelled);

    return new Promise((resolve, reject) => {
      perf.startOperation("spawnEmulator");
      const child = this.spawnFn(this.emulatorPath, args);
      perf.endOperation("spawnEmulator");
      onSpawn?.(child);

      // Buffer to collect initial output for PANIC detection
      let initialOutput = "";
      const outputBuffer: string[] = [];
      const maxBufferLines = 50; // Keep last 50 lines for error analysis
      let startupValidationComplete = false;
      perf.startOperation("panicDetection");

      // Monitor emulator output for PANIC errors
      const monitorOutput = (data: any) => {
        const output = data.toString();
        initialOutput += output;
        this.captureLaunchTargetDeviceId(child, initialOutput);

        // Keep a rolling buffer of recent output
        const lines = output.split("\n");
        outputBuffer.push(...lines);
        if (outputBuffer.length > maxBufferLines) {
          outputBuffer.splice(0, outputBuffer.length - maxBufferLines);
        }

        // Detect sandbox/JIT entitlement failures before generic PANIC handling.
        const sandboxError = this.sandboxFailure(initialOutput);
        if (sandboxError) {
          logger.error(`Emulator sandbox error detected: ${sandboxError.message}`);
          this.launchErrors.set(child, sandboxError);
          if (!child.killed) {child.kill();}
          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(sandboxError);
          }
          return;
        }

        // Check for PANIC in the output
        const panicResult = this.detectArchitecturePanic(initialOutput);
        if (panicResult.isPanic) {
          logger.error(`Emulator PANIC detected: ${panicResult.message}`);

          // Create a more helpful error message
          let errorMessage = `Emulator failed to start: ${panicResult.message}`;
          if (panicResult.hostArch && panicResult.avdArch) {
            errorMessage += `\n\nSuggestion: On ${panicResult.hostArch} hosts, create AVDs with compatible architectures:`;
            if (panicResult.hostArch === "aarch64" || panicResult.hostArch === "arm64") {
              errorMessage += `\n- Use ARM64 system images (arm64-v8a) instead of x86/x86_64`;
              errorMessage += `\n- Example: avdmanager create avd -n MyAVD -k "system-images;android-35;google_apis;arm64-v8a"`;
            } else if (panicResult.hostArch === "x86" || panicResult.hostArch === "x86_64") {
              errorMessage += `\n- Use x86/x86_64 system images instead of ARM64`;
              errorMessage += `\n- Example: avdmanager create avd -n MyAVD -k "system-images;android-35;google_apis;x86_64"`;
            }
          }

          // Kill the process if it's still running
          if (!child.killed) {
            child.kill();
          }

          // Reject the promise instead of just emitting error
          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(new ActionableError(errorMessage));
          }
          return;
        }

        // Check for corrupt disk image
        const corruptResult = this.detectCorruptImage(initialOutput);
        if (corruptResult.isCorrupt) {
          logger.error(`Emulator corrupt image detected: ${corruptResult.message}`);

          let errorMessage = `Emulator failed to start: ${corruptResult.message}`;
          if (corruptResult.suggestion) {
            errorMessage += `\n\nSuggestion: ${corruptResult.suggestion}`;
          }

          if (!child.killed) {
            child.kill();
          }

          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(new ActionableError(errorMessage));
          }
          return;
        }

        // Check for display / Qt platform-plugin failure (windowed launch on a headless host)
        const displayResult = this.detectDisplayError(initialOutput);
        if (displayResult.isDisplayError) {
          logger.error(`Emulator display error detected: ${displayResult.message}`);

          let errorMessage = `Emulator failed to start: ${displayResult.message}`;
          if (displayResult.suggestion) {
            errorMessage += `\n\nSuggestion: ${displayResult.suggestion}`;
          }

          if (!child.killed) {
            child.kill();
          }

          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(new ActionableError(errorMessage));
          }
          return;
        }

        // Check for successful startup indicators
        if (output.includes("INFO         | emuDirName:") ||
          output.includes("Hax is enabled") ||
          output.includes("Detected GPU type")) {
          // Emulator has started successfully, resolve with the child process
          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            resolve(child);
          }
        }
      };

      // Set a timeout for startup validation (5 seconds should be enough to detect PANIC)
      const startupTimeout = this.timer.setTimeout(() => {
        if (!startupValidationComplete) {
          startupValidationComplete = true;
          perf.endOperation("panicDetection");
          // If no PANIC detected and no clear success indicators, assume success
          resolve(child);
        }
      }, 5000);

      // Log emulator output for debugging and monitor for PANIC
      child.stdout?.on("data", data => {
        logger.debug(`Emulator stdout: ${data}`);
        monitorOutput(data);
      });

      child.stderr?.on("data", data => {
        logger.debug(`Emulator stderr: ${data}`);
        monitorOutput(data);
      });

      child.on("exit", code => {
        clearTimeout(startupTimeout);
        if (code !== 0) {
          logger.error(`Emulator process exited with code: ${code}`);

          // Check if exit was due to "already running" error
          if (initialOutput.includes("Running multiple emulators with the same AVD")) {
            logger.info(`AVD '${avdName}' is already starting/running - this is expected, will wait for it to be ready`);
            if (!startupValidationComplete) {
              startupValidationComplete = true;
              perf.endOperation("panicDetection");
              // Another emulator already owns this AVD; we hold no process handle
              // for it. Resolve null rather than a fabricated handle (issue #3938);
              // the caller waits for readiness regardless.
              resolve(null);
            }
            return;
          }

          // Check if exit was due to a sandbox/JIT entitlement failure.
          const sandboxError = this.sandboxFailure(initialOutput);
          if (sandboxError) {
            logger.error(`Exit was due to emulator sandbox error: ${sandboxError.message}`);
            this.launchErrors.set(child, sandboxError);
            if (!startupValidationComplete) {
              startupValidationComplete = true;
              perf.endOperation("panicDetection");
              reject(sandboxError);
            }
            return;
          }

          // Check if exit was due to PANIC
          const panicResult = this.detectArchitecturePanic(initialOutput);
          if (panicResult.isPanic) {
            logger.error(`Exit was due to PANIC: ${panicResult.message}`);
            if (!startupValidationComplete) {
              startupValidationComplete = true;
              perf.endOperation("panicDetection");
              reject(new ActionableError(`Emulator failed to start: ${panicResult.message}`));
            }
            return;
          }

          // Check if exit was due to corrupt disk image
          const corruptResult = this.detectCorruptImage(initialOutput);
          if (corruptResult.isCorrupt) {
            logger.error(`Exit was due to corrupt image: ${corruptResult.message}`);
            if (!startupValidationComplete) {
              startupValidationComplete = true;
              perf.endOperation("panicDetection");
              let errorMessage = `Emulator failed to start: ${corruptResult.message}`;
              if (corruptResult.suggestion) {
                errorMessage += `\n\nSuggestion: ${corruptResult.suggestion}`;
              }
              reject(new ActionableError(errorMessage));
            }
            return;
          }

          // Check if exit was due to a display / Qt platform-plugin failure.
          // Signal death (e.g. SIGABRT from the failed xcb plugin) arrives as code === null.
          const displayResult = this.detectDisplayError(initialOutput);
          if (displayResult.isDisplayError) {
            logger.error(`Exit was due to display error: ${displayResult.message}`);
            if (!startupValidationComplete) {
              startupValidationComplete = true;
              perf.endOperation("panicDetection");
              let errorMessage = `Emulator failed to start: ${displayResult.message}`;
              if (displayResult.suggestion) {
                errorMessage += `\n\nSuggestion: ${displayResult.suggestion}`;
              }
              reject(new ActionableError(errorMessage));
            }
          } else if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(new ActionableError(`Emulator process exited with code: ${code}`));
          }
        } else {
          logger.info(`Emulator process exited with code: ${code}`);
        }
      });

      child.on("error", error => {
        clearTimeout(startupTimeout);
        if (!startupValidationComplete) {
          startupValidationComplete = true;
          perf.endOperation("panicDetection");
          reject(new ActionableError(`Emulator failed to start: ${error.message}`));
        }
      });
    });
  }

  /**
   * Kill a running emulator
   * @param device - The device to kill
   * @returns Promise that resolves when emulator is stopped
   */
  async killDevice(device: BootedDevice): Promise<void> {
    const runningEmulators = await this.getBootedDevices();
    const emulator = runningEmulators.find(emu => emu.deviceId === device.deviceId);

    if (!emulator || !emulator.deviceId) {
      throw new ActionableError(`Emulator '${device.name}' is not running`);
    }

    // Use ADB to stop the emulator
    const adb = this.adbFactory.create(emulator);
    await adb.executeCommand("emu kill");

    logger.info(`Killed emulator '${device.name}'`);
  }

  private getLaunchTargetDeviceId(childProcess?: ChildProcess | null): string | undefined {
    return childProcess ? this.launchTargetDeviceIds.get(childProcess) : undefined;
  }

  private getLaunchError(childProcess?: ChildProcess | null): ActionableError | undefined {
    return childProcess ? this.launchErrors.get(childProcess) : undefined;
  }

  private recordLaunchError(
    childProcess: ChildProcess | null | undefined,
    onError: (error: ActionableError) => void,
  ): void {
    const error = this.getLaunchError(childProcess);
    if (error) {
      onError(error);
    }
  }

  private readinessTimeoutError(
    avdName: string,
    timeoutMs: number,
    offlineFailure: ActionableError | null,
    processExitError: ActionableError | null,
  ): ActionableError {
    return processExitError
      ?? offlineFailure
      ?? new ActionableError(`Emulator '${avdName}' failed to become ready within ${timeoutMs}ms`);
  }

  private unknownEmulatorName(deviceId: string): string {
    return `Unknown (${deviceId})`;
  }

  private isUnknownEmulatorName(name: string, deviceId: string): boolean {
    return name === this.unknownEmulatorName(deviceId);
  }

  private matchesRequestedAvdOrUnknown(emulator: BootedDevice, avdName: string, targetDeviceId?: string): boolean {
    if (targetDeviceId === emulator.deviceId && !targetDeviceId.startsWith("emulator-")) {
      return true;
    }

    return emulator.name === avdName
      || this.isUnknownEmulatorName(emulator.name, emulator.deviceId)
      || (targetDeviceId === emulator.deviceId && this.isUnknownEmulatorName(avdName, targetDeviceId));
  }

  private detectDeviceIdFromEmulatorOutput(output: string): string | undefined {
    const explicitDeviceId = output.match(/\bemulator-(\d{4,5})\b/);
    if (explicitDeviceId) {
      return `emulator-${explicitDeviceId[1]}`;
    }

    const consolePort = output.match(/\bconsole(?:\s+on)?\s+port\s*(?:=|:|\s)\s*(\d{4,5})\b/i);
    if (!consolePort) {
      return undefined;
    }

    const port = Number.parseInt(consolePort[1], 10);
    if (port < 5554 || port % 2 !== 0) {
      return undefined;
    }

    return `emulator-${port}`;
  }

  private captureLaunchTargetDeviceId(childProcess: ChildProcess, output: string): void {
    if (this.launchTargetDeviceIds.has(childProcess)) {
      return;
    }

    const targetDeviceId = this.detectDeviceIdFromEmulatorOutput(output);
    if (targetDeviceId) {
      this.launchTargetDeviceIds.set(childProcess, targetDeviceId);
      logger.debug(`Captured emulator launch target deviceId from process output: ${targetDeviceId}`);
    }
  }

  /**
   * Wait for the emulator to be ready for use
   * @param avdName - The AVD name to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120000 = 2 minutes)
   * @returns Promise that resolves with device ID when emulator is ready
   */
  async waitForEmulatorReady(
    avdName: string,
    timeoutMs: number = 120000,
    childProcess?: ChildProcess | null,
    targetDeviceId?: string,
  ): Promise<BootedDevice> {
    const startTime = this.timer.now();
    const perf = createGlobalPerformanceTracker();

    // Read polling interval from environment variable (default: 500ms, minimum: 100ms)
    const pollingIntervalMs = Math.max(parseInt(process.env.EMULATOR_POLLING_INTERVAL_MS || "500", 10), 100);
    logger.info(`Waiting for emulator '${avdName}' to be ready... (polling interval: ${pollingIntervalMs}ms)`);

    // Monitor child process for early exit if provided
    let processExited = false;
    let processExitError: ActionableError | null = null;
    if (childProcess && childProcess.pid) {
      const processOutput: string[] = [];
      const captureOutput = (data: any) => {
        const output = data.toString();
        processOutput.push(output);
        this.captureLaunchTargetDeviceId(childProcess, output);
        // Keep buffer bounded
        if (processOutput.length > 50) {
          processOutput.splice(0, processOutput.length - 50);
        }
      };
      childProcess.stdout?.on("data", captureOutput);
      childProcess.stderr?.on("data", captureOutput);
      childProcess.on("exit", code => {
        // A null code means the process was killed by signal (e.g. SIGABRT from a
        // failed Qt xcb plugin on a headless host) — treat that as a failure too.
        if (code !== 0) {
          processExited = true;
          const combinedOutput = processOutput.join("");

          // Check for known error patterns
          const sandboxError = this.sandboxFailure(combinedOutput);
          const corruptResult = this.detectCorruptImage(combinedOutput);
          const displayResult = this.detectDisplayError(combinedOutput);
          if (sandboxError) {
            processExitError = sandboxError;
          } else if (corruptResult.isCorrupt) {
            let msg = `Emulator failed to start: ${corruptResult.message}`;
            if (corruptResult.suggestion) {
              msg += `\n\nSuggestion: ${corruptResult.suggestion}`;
            }
            processExitError = new ActionableError(msg);
          } else if (displayResult.isDisplayError) {
            let msg = `Emulator failed to start: ${displayResult.message}`;
            if (displayResult.suggestion) {
              msg += `\n\nSuggestion: ${displayResult.suggestion}`;
            }
            processExitError = new ActionableError(msg);
          } else {
            const panicResult = this.detectArchitecturePanic(combinedOutput);
            if (panicResult.isPanic) {
              processExitError = new ActionableError(`Emulator failed to start: ${panicResult.message}`);
            } else {
              processExitError = new ActionableError(
                `Emulator process exited with code ${code} while waiting for readiness`
              );
            }
          }
          logger.error(`Emulator process exited during readiness wait: ${processExitError.message}`);
        }
      });
    }

    // Start background polling immediately with configurable intervals
    let pollingActive = true;
    let foundDeviceId: string | null = null;
    let offlineFailure: ActionableError | null = null;
    const offlineTracker = { deviceId: null as string | null, since: null as number | null };

    perf.startOperation("devicePolling");
    const backgroundPoller = async () => {
      while (pollingActive && !foundDeviceId) {
        try {
          this.recordLaunchError(childProcess, error => {
            processExited = true;
            processExitError = error;
          });
          logger.debug(`Background polling iteration - checking for emulator '${avdName}'...`);

          const correlatedTargetDeviceId = targetDeviceId ?? this.getLaunchTargetDeviceId(childProcess);
          offlineFailure = await this.detectOfflineFailure(avdName, correlatedTargetDeviceId, offlineTracker);

          // For local emulators, check for running devices
          logger.debug(`Checking for running local emulators...`);
          const runningEmulators = await this.getBootedDevices();
          logger.debug(`Device scan complete - found ${runningEmulators.length} running emulators`);

          if (runningEmulators.length > 0) {
            logger.debug(`Found ${runningEmulators.length} running emulators: ${runningEmulators.map(e => `${e.name}(${e.deviceId})`).join(", ")}`);

            // Prefer an exact deviceId when startDevice already selected or correlated a device.
            let emulator = correlatedTargetDeviceId
              ? runningEmulators.find(emu => emu.deviceId === correlatedTargetDeviceId)
              : undefined;
            if (correlatedTargetDeviceId) {
              logger.debug(`Exact deviceId match for '${correlatedTargetDeviceId}': ${emulator ? `Found ${emulator.deviceId}` : "Not found"}`);
              if (emulator && !this.matchesRequestedAvdOrUnknown(emulator, avdName, correlatedTargetDeviceId)) {
                logger.debug(`Exact deviceId match ${emulator.deviceId} resolved as '${emulator.name}', not requested AVD '${avdName}'`);
                emulator = undefined;
              }
            }

            // Look for emulator by name next.
            if (!emulator && !correlatedTargetDeviceId) {
              emulator = runningEmulators.find(emu => emu.name === avdName);
              logger.debug(`Exact name match for '${avdName}': ${emulator ? `Found ${emulator.deviceId}` : "Not found"}`);
            }

            if (emulator && emulator.deviceId) {
              logger.debug(`Target emulator found: ${emulator.name} (${emulator.deviceId}) - starting readiness checks`);

              // Check if the device is online and ready.
              // Run ADB state, package manager, and boot-complete checks in parallel for faster detection.
              logger.debug(`[PARALLEL] Running device state, package manager, and boot-complete checks for ${emulator.deviceId}...`);
              const adb = this.adbFactory.create(emulator);
              try {
                perf.startOperation("adbParallelChecks");
                const [
                  deviceStateResult,
                  packageManagerResult,
                  sysBootCompletedResult,
                  bootAnimationResult,
                ] = await Promise.allSettled([
                  adb.executeCommand("get-state"),
                  adb.executeCommand("shell pm list packages"),
                  adb.executeCommand("shell getprop sys.boot_completed"),
                  adb.executeCommand("shell getprop init.svc.bootanim"),
                ]);
                perf.endOperation("adbParallelChecks");

                // Check device state result
                if (
                  deviceStateResult.status !== "fulfilled" ||
                  packageManagerResult.status !== "fulfilled" ||
                  sysBootCompletedResult.status !== "fulfilled" ||
                  bootAnimationResult.status !== "fulfilled"
                ) {
                  logger.debug(
                    `[PARALLEL] Checks not yet complete: deviceStatus: ${deviceStateResult.status}, ` +
                    `packageManager: ${packageManagerResult.status}, ` +
                    `sysBootCompleted: ${sysBootCompletedResult.status}, bootAnimation: ${bootAnimationResult.status}`,
                  );
                } else {
                  const stateOutput = deviceStateResult.value.stdout.trim();
                  const sysBootCompleted = sysBootCompletedResult.value.stdout.trim();
                  const bootAnimationState = bootAnimationResult.value.stdout.trim();
                  logger.debug(`[PARALLEL] Package manager command completed for ${emulator.deviceId} - output: ${packageManagerResult.value.stdout.length} bytes`);
                  if (!stateOutput.includes("device")) {
                    logger.debug(`[PARALLEL] ❌ Device state check failed for ${emulator.deviceId}: state="${stateOutput}"`);
                  } else if (!packageManagerResult.value.stdout || !packageManagerResult.value.stdout.includes("package:")) {
                    logger.debug(`[PARALLEL] ❌ Package manager returned no packages for ${emulator.deviceId} (${packageManagerResult.value.stdout.length} bytes output)`);
                  } else if (packageManagerResult.value.stderr || packageManagerResult.value.stderr.includes("Failure")) {
                    logger.debug(`[PARALLEL] ❌ Package manager returned failure for ${emulator.deviceId}: ${packageManagerResult.value.stderr}`);
                  } else if (sysBootCompleted !== "1") {
                    logger.debug(`[PARALLEL] ❌ sys.boot_completed is not set for ${emulator.deviceId}: "${sysBootCompleted}"`);
                  } else if (bootAnimationState && bootAnimationState !== "stopped") {
                    logger.debug(`[PARALLEL] ❌ boot animation is still active for ${emulator.deviceId}: "${bootAnimationState}"`);
                  } else {
                    logger.debug(`[PARALLEL] ✅ Device state check passed for ${emulator.deviceId}`);
                    logger.debug(`[PARALLEL] ✅ Package manager is responsive for ${emulator.deviceId} - emulator is ready!`);
                    logger.debug(`[PARALLEL] ✅ Android boot-complete signals are ready for ${emulator.deviceId}`);
                    logger.debug(`[PARALLEL] ✅ No package manager errors detected - marking emulator as ready`);
                    foundDeviceId = emulator.deviceId;
                    return;
                  }
                }
              } catch (parallelError) {
                logger.debug(`[PARALLEL] ❌ Parallel checks failed for ${emulator.deviceId}: ${parallelError}`);
              }
            } else {
              logger.debug(`No suitable emulator found for '${avdName}' - will continue polling`);
            }
          } else {
            logger.debug(`No running emulators detected - will continue polling`);
          }
        } catch (error) {
          logger.debug(`Background polling error (will continue): ${error}`);
        }

        // Always wait at least the minimum polling interval
        logger.debug(`Background polling cycle complete - sleeping ${pollingIntervalMs}ms before next check`);
        await this.sleep(pollingIntervalMs);
      }
      logger.debug(`Background polling stopped - pollingActive: ${pollingActive}, foundDeviceId: ${foundDeviceId}`);
    };

    // Start background polling immediately
    const pollingPromise = backgroundPoller();

    // Main timeout loop
    while (this.timer.now() - startTime < timeoutMs) {
      // Check if emulator process crashed during readiness wait
      if (processExited && processExitError) {
        pollingActive = false;
        await pollingPromise;
        perf.endOperation("devicePolling");
        throw processExitError;
      }

      if (foundDeviceId) {
        pollingActive = false;
        perf.endOperation("devicePolling");
        logger.info(`Emulator '${avdName}' is ready! Device ID: ${foundDeviceId}`);
        const bootedDevice = { name: avdName, platform: "android", deviceId: foundDeviceId } as BootedDevice;
        perf.startOperation("wakeAndUnlock");
        await this.wakeAndUnlock(bootedDevice);
        perf.endOperation("wakeAndUnlock");
        return bootedDevice;
      }

      // Check less frequently in main loop since background polling is doing the work
      await this.sleep(500);
    }

    // Stop background polling
    pollingActive = false;
    await pollingPromise;
    perf.endOperation("devicePolling");

    if (foundDeviceId) {
      logger.info(`Emulator '${avdName}' is ready! Device ID: ${foundDeviceId}`);
      const bootedDevice = { name: avdName, platform: "android", deviceId: foundDeviceId } as BootedDevice;
      perf.startOperation("wakeAndUnlock");
      await this.wakeAndUnlock(bootedDevice);
      perf.endOperation("wakeAndUnlock");
      return bootedDevice;
    }

    throw this.readinessTimeoutError(avdName, timeoutMs, offlineFailure, processExitError);
  }

  /**
   * Wake up the emulator and dismiss the lock screen after boot.
   * This ensures the device is immediately usable for automation.
   *
   * Delegates to the shared {@link WakeAndUnlock} feature so boot uses the same
   * path as the `wakeAndUnlock` tool: a swipe lock is dismissed, and a secure
   * lock is unlocked with the PIN remembered for the device this session (if
   * any). A secure device with no remembered PIN is left locked — non-fatal, the
   * device is still ready and the user can unlock it with the tool (#4360).
   * @param device - The booted device to wake and unlock
   */
  private async wakeAndUnlock(device: BootedDevice): Promise<void> {
    try {
      const wakeAndUnlock = new WakeAndUnlock(device, this.adbFactory, {
        timer: this.timer,
        credentialStore: new DeviceLockStore()
      });
      const result = await wakeAndUnlock.execute();
      if (!result.unlocked && result.secure) {
        logger.info(
          `[WakeAndUnlock] Device ${device.deviceId} is secure-locked and no PIN is remembered; ` +
          "leaving it locked. Unlock it once with the wakeAndUnlock tool (passing a pin) to remember it."
        );
      } else {
        logger.info(`[WakeAndUnlock] Device ${device.deviceId} wake/unlock: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      // Log but don't fail - the device is still ready, just might need manual interaction.
      // A secure lock with no remembered PIN throws ActionableError here; that is expected.
      logger.warn(`[WakeAndUnlock] Failed to wake/unlock device ${device.deviceId}: ${error}`);
    }
  }

  /**
   * Utility method to sleep for a specified duration
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return this.timer.sleep(ms);
  }
}
