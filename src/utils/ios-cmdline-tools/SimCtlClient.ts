import { errorMessage } from "../describeUnknownError";
import { ChildProcess, execFile, spawn, type SpawnOptions } from "child_process";
import { promisify } from "util";
import { promises as fsPromises } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "../logger";
import { createExecResult } from "../execResult";
import { ExecResult, ActionableError, DeviceInfo, BootedDevice, ScreenSize } from "../../models";
import { defaultTimer, Timer } from "../SystemTimer";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../deviceTimeouts";
import { PlistClient, type PlistReader } from "./PlistClient";
import { isIosSimulatorUdid } from "./iosDeviceType";
import { getAbortSignal } from "../AbortContext";
import { Mutex } from "async-mutex";

export interface AppleDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  availabilityError?: string;
  deviceTypeIdentifier?: string;
  runtime?: string;
  model?: string;
  os_version?: string;
  architecture?: string;
  type?: string;
}

export interface AppleDeviceRuntime {
  bundlePath: string;
  buildversion: string;
  runtimeRoot: string;
  identifier: string;
  version: string;
  isAvailable: boolean;
  name: string;
}

export interface AppleDeviceType {
  minRuntimeVersion: number;
  bundlePath: string;
  maxRuntimeVersion: number;
  name: string;
  identifier: string;
  productFamily: string;
}

export interface SimCtlFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

const defaultSimCtlFileSystem: SimCtlFileSystem = {
  mkdtemp: (prefix) => fsPromises.mkdtemp(prefix),
  writeFile: (path, data, encoding) => fsPromises.writeFile(path, data, encoding),
  readFile: (path, encoding) => fsPromises.readFile(path, encoding),
  rm: (path, options) => fsPromises.rm(path, options),
};

/**
 * Interface for iOS simulator control using simctl
 * Provides methods to manage and interact with iOS simulators
 */
export interface SimCtl {
  /**
   * Set the target device ID
   * @param device - Device identifier
   */
  setDevice(device: BootedDevice): void;

  /**
   * Execute a simctl command
   * @param command - The simctl command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with command output
   */
  executeCommand(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;

  /**
   * Execute a simctl command from pre-split arguments. Use this for literal user
   * values that must preserve empty strings, backslashes, or shell metacharacters.
   * @param args - Arguments after the `simctl` executable name
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with command output
   */
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;

  /**
   * Start a long-lived simctl command. Callers own the returned process and
   * must stop it; recording callers should use SIGINT so simctl can finalize
   * its output before any escalation.
   */
  startCommandArgs(args: string[], options?: SpawnOptions): Promise<ChildProcess>;

  /**
   * Check if simctl is available
   * @returns Promise with boolean indicating availability
   */
  isAvailable(): Promise<boolean>;

  /**
   * Check if a simulator is running by name
   * @param name - Simulator name or UDID
   * @returns Promise with boolean indicating if running
   */
  isSimulatorRunning(name: string): Promise<boolean>;

  /**
   * Start a simulator by UDID
   * @param udid - Device UDID to start
   * @returns Promise that resolves when simulator is started
   */
  startSimulator(udid: string, timeoutMs?: number): Promise<ChildProcess>;

  /**
   * Kill a simulator
   * @param device - Device to kill
   * @returns Promise that resolves when kill is complete
   */
  killSimulator(device: BootedDevice, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;

  /** Erase all data from a simulator. Reserved for CI-owned recovery flows. */
  eraseSimulator(udid: string): Promise<void>;

  /**
   * Wait for a simulator to be ready
   * @param udid - Device UDID to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds
   * @param options - When `assumeBooted` is set, skip the blocking `bootstatus -b`
   *   readiness wait because the caller (e.g. `startSimulator`) already performed
   *   it, and only resolve device metadata.
   * @returns Promise with booted device information
   */
  waitForSimulatorReady(
    udid: string,
    timeoutMs?: number,
    options?: { assumeBooted?: boolean },
  ): Promise<BootedDevice>;

  /**
   * Get the list of available (booted and shutdown) simulator UDIDs
   * @param timeoutMs - Optional timeout for simulator discovery
   * @returns Promise with an array of device info
   */
  listSimulatorImages(timeoutMs?: number): Promise<DeviceInfo[]>;

  /**
   * Get the list of booted simulator UDIDs
   * @returns Promise with an array of booted devices
   */
  getBootedSimulators(timeoutMs?: number): Promise<BootedDevice[]>;

  /**
   * Get device information by UDID
   * @param udid - Device UDID
   * @returns Promise with device information or null if not found
   */
  getDeviceInfo(udid: string): Promise<AppleDevice | null>;

  /**
   * Boot a simulator by UDID
   * @param udid - Device UDID to boot
   * @returns Promise with booted device information
   */
  bootSimulator(udid: string): Promise<BootedDevice>;

  /**
   * Get available device types (iPhone models, iPad models, etc.)
   * @returns Promise with array of device types
   */
  getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]>;

  /**
   * Get available iOS runtimes
   * @returns Promise with array of runtimes
   */
  getRuntimes(): Promise<AppleDeviceRuntime[]>;

  /**
   * Create a new simulator
   * @param name - Name for the new simulator
   * @param deviceType - Device type identifier (e.g., "iPhone 15")
   * @param runtime - Runtime identifier (e.g., "iOS 17.0")
   * @returns Promise with the UDID of the created simulator
   */
  createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string>;

  /**
   * Delete a simulator by UDID
   * @param udid - Device UDID to delete
   * @returns Promise that resolves when deletion is complete
   */
  deleteSimulator(udid: string): Promise<void>;

  /**
   * List all installed apps on the simulator
   * @param deviceId - Optional device ID (defaults to "booted" for current booted simulator)
   * @returns Promise with array of app objects
   */
  listApps(deviceId?: string): Promise<any[]>;

  /**
   * Launch an app on the simulator
   * @param bundleId - The bundle identifier of the app to launch
   * @param options - Launch options
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   * @returns Promise with launch result containing success status and optional PID
   */
  launchApp(
    bundleId: string,
    options?: { foregroundIfRunning?: boolean },
    deviceId?: string,
  ): Promise<{
    success: boolean;
    pid?: number;
    error?: string;
  }>;

  /**
   * Terminate an app on the simulator
   * @param bundleId - The bundle identifier of the app to terminate
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   * @returns Promise that resolves when termination is complete
   */
  terminateApp(bundleId: string, deviceId?: string): Promise<void>;

  /**
   * Install an app on the simulator
   * @param appPath - Path to the .app bundle
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   */
  installApp(appPath: string, deviceId?: string): Promise<void>;

  /**
   * Uninstall an app from the simulator
   * @param bundleId - The bundle identifier of the app to uninstall
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   */
  uninstallApp(bundleId: string, deviceId?: string): Promise<void>;

  /**
   * Get the screen size of the simulator
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   * @returns Promise with screen dimensions
   */
  getScreenSize(deviceId?: string): Promise<ScreenSize>;

  /**
   * Set the simulator appearance
   * @param mode - Appearance mode ("light" or "dark")
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   */
  setAppearance(mode: "light" | "dark", deviceId?: string): Promise<void>;

  /**
   * Open Simulator.app. If udid is provided, focuses that specific device window.
   * With multiple simulators booted, this ensures the right device is visible.
   * @param udid - Optional device UDID to focus
   */
  openSimulatorApp(udid?: string, signal?: AbortSignal): Promise<void>;

  /**
   * Deliver a simulated remote push notification to a booted simulator.
   * @param deviceId - Simulator UDID
   * @param bundleId - Target app bundle identifier
   * @param payloadJson - APNs payload JSON (must contain a top-level `aps` key, <=4096 bytes)
   */
  pushNotification(
    deviceId: string,
    bundleId: string,
    payloadJson: string,
  ): Promise<{ success: boolean; error?: string }>;
}

// Enhance the standard execAsync result to implement the ExecResult interface
const execAsync = async (
  file: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal,
): Promise<ExecResult> => {
  // Pass the AbortSignal to execFile so that when a caller's timeout aborts, Node
  // kills the child process (SIGTERM) instead of leaving it running orphaned
  // (issue #3938). Without this a timed-out `bootstatus -b` keeps booting the
  // simulator in the background after the tool has already reported failure.
  const options: Parameters<typeof execFile>[2] =
    maxBuffer && signal
      ? { maxBuffer, signal }
      : maxBuffer
        ? { maxBuffer }
        : signal
          ? { signal }
          : undefined;
  const result = await promisify(execFile)(file, args, options);

  const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout.toString();
  const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString();
  return createExecResult(stdout, stderr);
};

function defaultSpawnProcess(
  command: string,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  return spawn(command, args, options ?? {});
}

function splitCommandArgs(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Command cannot be empty");
  }

  const args: string[] = [];
  let current = "";
  // A token that was opened with a quote is real even when it is empty — `""`
  // must survive as an empty argv entry. Dropping it shifts every later
  // positional argument, which silently rewrites the command (issue #4196).
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (started) {
      args.push(current);
      current = "";
      started = false;
    }
  };

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === "\\" && i + 1 < trimmed.length) {
      current += trimmed[i + 1];
      started = true;
      i++;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
    started = true;
  }

  flush();

  return args;
}

function normalizeIosVersion(
  runtimeId: string | undefined,
  osVersion: string | undefined,
): string | undefined {
  const trimmedOsVersion = osVersion?.trim();
  if (trimmedOsVersion) {
    return trimmedOsVersion;
  }

  if (!runtimeId) {
    return undefined;
  }

  const match = runtimeId.match(/iOS[-_](\d+(?:[-_]\d+)*)/);
  if (!match) {
    return undefined;
  }

  return match[1].replace(/_/g, ".").replace(/-/g, ".");
}

/** Numeric, component-wise comparison of dotted version strings. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** Highest-versioned runtime whose version starts with `prefix`, if any. */
function pickHighestRuntime(
  runtimes: AppleDeviceRuntime[],
  prefix: string,
): AppleDeviceRuntime | undefined {
  return runtimes
    .filter((runtime) => typeof runtime.version === "string" && runtime.version.startsWith(prefix))
    .sort((a, b) => compareVersions(a.version, b.version))
    .pop();
}

function inferIosFormFactor(deviceTypeId: string | undefined): "phone" | "tablet" | undefined {
  if (!deviceTypeId) {
    return undefined;
  }
  if (deviceTypeId.includes("iPad")) {
    return "tablet";
  }
  if (deviceTypeId.includes("iPhone")) {
    return "phone";
  }
  return undefined;
}

function isAlreadyBootedCoreSimulator405(error: unknown, udid: string): boolean {
  if (!isIosSimulatorUdid(udid) || !(error instanceof Error)) {
    return false;
  }

  const execError = error as NodeJS.ErrnoException & { stderr?: unknown };
  const stderr =
    typeof execError.stderr === "string"
      ? execError.stderr
      : Buffer.isBuffer(execError.stderr)
        ? execError.stderr.toString()
        : "";

  return (
    typeof execError.code === "number" &&
    execError.code !== 0 &&
    stderr.includes("domain=com.apple.CoreSimulator.SimError, code=405") &&
    stderr.includes("Unable to boot device in current state: Booted")
  );
}

/**
 * This file provides an interface to interact with iOS simulators using simctl.
 * It allows you to list, create, boot, and delete simulators.
 */

interface SimulatorList {
  devices: { [runtimeId: string]: AppleDevice[] };
  pairs?: any;
  runtimes?: AppleDeviceRuntime[];
  devicetypes?: AppleDeviceType[];
}

/**
 * Tuning knobs for the self-verifying boot loop. Injected so unit tests can
 * exercise the retry path without real waits (the backoff runs through the
 * injected {@link Timer}).
 */
export interface SimCtlBootOptions {
  /** Total boot attempts, including the first one. Minimum 1. */
  maxAttempts: number;
  /** Delay between a failed verification and the next boot attempt. */
  retryBackoffMs: number;
}

export const DEFAULT_SIMCTL_BOOT_OPTIONS: SimCtlBootOptions = {
  maxAttempts: 2,
  retryBackoffMs: 2000,
};

interface SimulatorBootState {
  mutex: Mutex;
  lastBootSucceeded: boolean;
  ownerToken: object | undefined;
}

interface SimulatorBootLease {
  state: SimulatorBootState;
  release(): void;
}

export class SimCtlClient implements SimCtl {
  device: BootedDevice | null;
  execAsync: (
    file: string,
    args: string[],
    maxBuffer?: number,
    signal?: AbortSignal,
  ) => Promise<ExecResult>;
  private timer: Timer;
  private platform: NodeJS.Platform;
  private readonly usesInjectedExecAsync: boolean;
  private readonly spawnProcess: (
    command: string,
    args: string[],
    options?: SpawnOptions,
  ) => ChildProcess;
  private readonly fileSystem: SimCtlFileSystem;
  private readonly bootOptions: SimCtlBootOptions;
  // Cached result of the launchctl headless-session probe (null = not yet probed)
  private headlessSessionCache: boolean | null = null;

  // Static cache for device list
  private static deviceListCache: { devices: DeviceInfo[]; timestamp: number } | null = null;
  private static readonly DEVICE_LIST_CACHE_TTL = 5000; // 5 seconds
  private static localSimctlAvailability: Promise<void> | null = null;
  private static readonly simulatorBoots = new Map<string, SimulatorBootState>();

  /**
   * Create an IosUtils instance
   * @param device - Optional device
   * @param execAsyncFn - promisified exec function (for testing)
   * @param timer - Timer for delays and time tracking
   */
  constructor(
    device: BootedDevice | null = null,
    execAsyncFn:
      | ((
          file: string,
          args: string[],
          maxBuffer?: number,
          signal?: AbortSignal,
        ) => Promise<ExecResult>)
      | null = null,
    timer: Timer = defaultTimer,
    platform: NodeJS.Platform = process.platform,
    spawnProcess: (
      command: string,
      args: string[],
      options?: SpawnOptions,
    ) => ChildProcess = defaultSpawnProcess,
    fileSystem: SimCtlFileSystem = defaultSimCtlFileSystem,
    bootOptions: SimCtlBootOptions = DEFAULT_SIMCTL_BOOT_OPTIONS,
    private readonly plist: PlistReader = new PlistClient(),
  ) {
    this.device = device;
    this.usesInjectedExecAsync = execAsyncFn !== null;
    this.execAsync = execAsyncFn || execAsync;
    this.timer = timer;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.fileSystem = fileSystem;
    this.bootOptions = {
      maxAttempts: Math.max(1, bootOptions.maxAttempts),
      retryBackoffMs: Math.max(0, bootOptions.retryBackoffMs),
    };
  }

  /**
   * Set the target device ID
   * @param device - Device identifier
   */
  setDevice(device: BootedDevice): void {
    this.device = device;
  }

  /**
   * Execute an simctl command
   * @param command - The simctl command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with command output
   */
  async executeCommand(
    command: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const hostArgs = splitCommandArgs(command);
    return this.executeCommandArgv(hostArgs, timeoutMs, command, signal);
  }

  async executeCommandArgs(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    return this.executeCommandArgv(args, timeoutMs, args.join(" "), signal);
  }

  async startCommandArgs(args: string[], options?: SpawnOptions): Promise<ChildProcess> {
    if (args.length === 0) {
      throw new Error("Command cannot be empty");
    }

    await this.ensureAvailableForCommand();
    const fullArgs = ["simctl", ...args];
    logger.debug(`[iOS] Starting command: xcrun ${fullArgs.join(" ")}`);
    return this.spawnProcess("xcrun", fullArgs, options);
  }

  private async ensureAvailableForCommand(): Promise<void> {
    try {
      await this.ensureLocalSimctlAvailable();
    } catch (error) {
      const detail = errorMessage(error);
      const message =
        this.platform === "darwin"
          ? `simctl is not available. Please install Xcode command line tools to continue. ${detail}`
          : "iOS simulator tooling is only available on macOS.";
      throw new ActionableError(message);
    }
  }

  private async executeCommandArgv(
    args: string[],
    timeoutMs?: number,
    displayCommand?: string,
    explicitSignal?: AbortSignal,
  ): Promise<ExecResult> {
    if (args.length === 0) {
      throw new Error("Command cannot be empty");
    }
    const command = displayCommand ?? args.map((arg) => JSON.stringify(arg)).join(" ");
    const hostArgs = args;
    const localArgs = ["simctl", ...hostArgs];

    const fullCommand = `xcrun simctl ${command}`;
    const startTime = this.timer.now();

    logger.debug(`[iOS] Executing command: ${fullCommand}`);

    await this.ensureAvailableForCommand();

    const callerSignal = explicitSignal ?? getAbortSignal();
    const runCommand = (signal?: AbortSignal) =>
      this.execAsync("xcrun", localArgs, undefined, signal);

    // Use Promise.race to implement timeout if specified. On timeout we abort the
    // controller so the underlying child process is killed rather than left
    // running orphaned (issue #3938).
    if (timeoutMs) {
      let timeoutId: NodeJS.Timeout;
      const controller = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;

      const timeoutPromise = new Promise<ExecResult>((_, reject) => {
        timeoutId = this.timer.setTimeout(() => {
          controller.abort();
          reject(new Error(`Command timed out after ${timeoutMs}ms: ${fullCommand}`));
        }, timeoutMs);
      });

      const runPromise = runCommand(signal);
      // Once the timeout wins the race the aborted run promise rejects with an
      // AbortError; keep it handled so it can't surface as an unhandledRejection.
      runPromise.catch(() => {
        /* settled after timeout; result consumed via race */
      });

      try {
        const result = await Promise.race([runPromise, timeoutPromise]);
        const duration = this.timer.now() - startTime;
        logger.debug(`[iOS] Command completed in ${duration}ms: ${command}`);
        return result;
      } catch (error) {
        const duration = this.timer.now() - startTime;
        logger.warn(
          `[iOS] Command failed after ${duration}ms: ${command} - ${(error as Error).message}`,
        );
        throw error;
      } finally {
        clearTimeout(timeoutId!);
      }
    }

    // No timeout specified
    try {
      const result = await runCommand(callerSignal);
      const duration = this.timer.now() - startTime;
      logger.debug(`[iOS] Command completed in ${duration}ms: ${command}`);
      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(
        `[iOS] Command failed after ${duration}ms: ${command} - ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Check if simctl is available
   * @returns Promise with boolean indicating availability
   */
  async isAvailable(): Promise<boolean> {
    return this.isLocalSimctlAvailable();
  }

  private async ensureLocalSimctlAvailable(): Promise<void> {
    if (this.usesInjectedExecAsync) {
      await this.execAsync("xcrun", ["simctl", "--version"]);
      return;
    }

    if (this.platform !== "darwin") {
      throw new ActionableError("iOS simulator tooling is only available on macOS.");
    }

    if (!SimCtlClient.localSimctlAvailability) {
      SimCtlClient.localSimctlAvailability = this.execAsync("xcrun", ["simctl", "--version"])
        .then(() => undefined)
        .catch((err) => {
          SimCtlClient.localSimctlAvailability = null;
          logger.debug(
            `[iOS] simctl unavailable: ${errorMessage(err)}`,
          );
          throw err;
        });
    }

    await SimCtlClient.localSimctlAvailability;
  }

  private async isLocalSimctlAvailable(): Promise<boolean> {
    try {
      await this.ensureLocalSimctlAvailable();
      return true;
    } catch (error) {
      // ensureLocalSimctlAvailable already logged the underlying reason; here we only need the boolean result.
      logger.debug(`src/utils/ios-cmdline-tools/SimCtlClient.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  /**
   * Get the list of all simulators and devices
   * @returns Promise with simulator list data
   */
  private async listSimulators(timeoutMs?: number): Promise<SimulatorList> {
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("simctlListDevices");
    const result = await this.executeCommandArgs(["list", "devices", "--json"], timeoutMs);
    perf.endOperation("simctlListDevices");

    try {
      perf.startOperation("jsonParse");
      const simulatorData = JSON.parse(result.stdout);
      perf.endOperation("jsonParse");
      return simulatorData as SimulatorList;
    } catch (error) {
      const stdoutSnippet = result.stdout.trim().slice(0, 300);
      const stderrSnippet = result.stderr.trim().slice(0, 300);
      logger.error(`Failed to parse simctl device list: ${error}`);
      throw new ActionableError(
        "Failed to parse iOS device list from 'xcrun simctl list devices --json'. " +
          `${errorMessage(error)}. ` +
          `stdout (first 300 chars): ${stdoutSnippet || "<empty>"}. ` +
          `stderr (first 300 chars): ${stderrSnippet || "<empty>"}.`,
      );
    }
  }

  async isSimulatorRunning(identifier: string): Promise<boolean> {
    return (await this.getBootedSimulators()).some(
      (simulator) => simulator.deviceId === identifier || simulator.name === identifier,
    );
  }

  async startSimulator(
    udid: string,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<ChildProcess> {
    const deadlineMs = this.bootDeadline(timeoutMs);
    const startSignal = getAbortSignal();
    const lease = await this.acquireSimulatorBoot(udid, deadlineMs, startSignal);
    try {
      if (this.timer.now() >= deadlineMs) {
        throw new Error(`Timed out waiting to start iOS simulator ${udid}`);
      }
      if (startSignal?.aborted) {
        throw startSignal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`);
      }
      if (lease.state.lastBootSucceeded) {
        const simulatorStillBooted = (
          await this.getBootedSimulatorsChecked(this.remainingBootTimeoutMs(deadlineMs))
        ).some((simulator) => simulator.deviceId === udid);
        if (simulatorStillBooted) {
          throw new ActionableError(`iOS simulator ${udid} is already running`);
        }
        lease.state.lastBootSucceeded = false;
        lease.state.ownerToken = undefined;
      }
      await this.startSimulatorExclusive(udid, deadlineMs, startSignal);
      const ownerToken = {};
      lease.state.lastBootSucceeded = true;
      lease.state.ownerToken = ownerToken;
      return this.createSimulatorHandle(udid, ownerToken);
    } finally {
      lease.release();
    }
  }

  private async startSimulatorExclusive(
    udid: string,
    deadlineMs: number,
    startSignal: AbortSignal | undefined,
  ): Promise<void> {
    logger.debug(`Starting iOS simulator ${udid}`);
    const perf = createGlobalPerformanceTracker();

    // `bootstatus -b` is idempotent: it boots shutdown simulators, accepts
    // already-booted simulators, and waits until CoreSimulator reports ready.
    // Its exit code alone is not trustworthy, so the post-condition (device
    // state == Booted) is verified and a wedge is retried. See
    // {@link bootAndVerify}.
    perf.startOperation("bootstatus");
    try {
      await this.runOwnedBoot(udid, () => this.bootAndVerify(udid, deadlineMs));
    } finally {
      perf.endOperation("bootstatus");
    }

    // Open Simulator.app focused on this specific device (no-op on headless hosts)
    try {
      perf.startOperation("openSimulatorApp");
      await this.openSimulatorAppBeforeDeadline(udid, deadlineMs, startSignal);
      perf.endOperation("openSimulatorApp");
    } catch {
      perf.endOperation("openSimulatorApp");
      logger.debug("Could not open Simulator.app (non-fatal)");
    }
    if (startSignal?.aborted) {
      await this.shutdownAfterFailedStart(udid);
      throw startSignal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`);
    }
  }

  private async openSimulatorAppBeforeDeadline(
    udid: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const remainingMs = this.remainingBootTimeoutMs(deadlineMs);
    if (signal?.aborted) {
      throw signal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`);
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const timeoutController = new AbortController();
    const operationSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.timer.setTimeout(() => {
        timeoutController.abort();
        reject(new Error(`Timed out opening Simulator.app for ${udid}`));
      }, remainingMs);
    });
    const contenders: Array<Promise<void>> = [
      this.openSimulatorApp(udid, operationSignal),
      timeout,
    ];
    if (signal) {
      contenders.push(
        new Promise<never>((_resolve, reject) => {
          abortListener = () =>
            reject(signal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }

    try {
      await Promise.race(contenders);
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private createSimulatorHandle(udid: string, ownerToken: object): ChildProcess {
    // `simctl bootstatus -b` is synchronous, so there is no long-lived OS child
    // process to hand back. Rather than fabricate a mock handle whose `kill()` is
    // a no-op (issue #3938), return an honest handle: `pid` is undefined (no OS
    // process), and `kill()` performs the meaningful cancellation for a simulator
    // — shutting it back down. `ChildProcess.kill` is synchronous, so the
    // shutdown is fired best-effort and the boolean result reports that a
    // cancellation was initiated.
    return {
      pid: undefined,
      kill: (): boolean => {
        // Cancellation cleanup must not inherit an already-aborted request signal.
        const cleanupSignal = new AbortController().signal;
        void this.shutdownSimulatorCoordinated(udid, 10_000, cleanupSignal, ownerToken).catch(
          (error) => {
            logger.debug(`[iOS] handle.kill() shutdown failed for ${udid}: ${error}`);
          },
        );
        return true;
      },
      killed: false,
      connected: false,
      exitCode: 0,
      signalCode: null,
    } as Pick<
      ChildProcess,
      "pid" | "kill" | "killed" | "connected" | "exitCode" | "signalCode"
    > as ChildProcess;
  }

  private async runOwnedBoot<T>(udid: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.shutdownAfterFailedStart(udid);
      throw error;
    }
  }

  private async runCoordinatedBoot<T>(
    udid: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    ownsBoot: boolean,
    operation: () => Promise<T>,
    adoptPriorSuccess?: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquireSimulatorBoot(udid, deadlineMs, signal);
    const priorBootSucceeded = lease.state.lastBootSucceeded;
    if (!priorBootSucceeded) {
      lease.state.lastBootSucceeded = false;
    }
    try {
      if (this.timer.now() >= deadlineMs) {
        throw new Error(`Timed out waiting to start iOS simulator ${udid}`);
      }
      if (signal?.aborted) {
        throw signal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`);
      }
      if (priorBootSucceeded && adoptPriorSuccess) {
        const simulatorStillBooted = (
          await this.getBootedSimulatorsChecked(this.remainingBootTimeoutMs(deadlineMs))
        ).some((simulator) => simulator.deviceId === udid);
        if (simulatorStillBooted) {
          return await adoptPriorSuccess();
        }
        lease.state.lastBootSucceeded = false;
        lease.state.ownerToken = undefined;
      }
      if (lease.state.lastBootSucceeded && ownsBoot) {
        throw new ActionableError(`iOS simulator ${udid} is already running`);
      }
      const result = ownsBoot ? await this.runOwnedBoot(udid, operation) : await operation();
      lease.state.lastBootSucceeded = true;
      return result;
    } finally {
      lease.release();
    }
  }

  private async acquireSimulatorBoot(
    udid: string,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SimulatorBootLease> {
    if (signal?.aborted) {
      throw signal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`);
    }

    let state = SimCtlClient.simulatorBoots.get(udid);
    if (!state) {
      state = { mutex: new Mutex(), lastBootSucceeded: false, ownerToken: undefined };
      SimCtlClient.simulatorBoots.set(udid, state);
    }

    let abandoned = false;
    let acquiredRelease: (() => void) | undefined;
    const acquirePromise = state.mutex.acquire().then((release) => {
      acquiredRelease = release;
      if (abandoned) {
        acquiredRelease = undefined;
        this.releaseSimulatorBoot(udid, state, release);
      }
      return release;
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const contenders: Array<Promise<() => void>> = [acquirePromise];
    if (deadlineMs !== undefined) {
      const remainingMs = Math.max(0, deadlineMs - this.timer.now());
      contenders.push(
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = this.timer.setTimeout(
            () => reject(new Error(`Timed out waiting to start iOS simulator ${udid}`)),
            remainingMs,
          );
        }),
      );
    }
    if (signal) {
      contenders.push(
        new Promise<never>((_resolve, reject) => {
          abortListener = () =>
            reject(signal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }

    let acquired = false;
    try {
      const release = await Promise.race(contenders);
      acquired = true;
      acquiredRelease = undefined;
      return {
        state,
        release: () => this.releaseSimulatorBoot(udid, state, release),
      };
    } finally {
      abandoned = !acquired;
      if (abandoned && acquiredRelease) {
        const release = acquiredRelease;
        acquiredRelease = undefined;
        this.releaseSimulatorBoot(udid, state, release);
      }
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private releaseSimulatorBoot(udid: string, state: SimulatorBootState, release: () => void): void {
    release();
    if (
      !state.lastBootSucceeded &&
      !state.mutex.isLocked() &&
      SimCtlClient.simulatorBoots.get(udid) === state
    ) {
      SimCtlClient.simulatorBoots.delete(udid);
    }
  }

  private async shutdownAfterFailedStart(udid: string): Promise<void> {
    try {
      // Cleanup must not inherit the already-aborted request signal.
      const cleanupSignal = new AbortController().signal;
      await this.executeCommandArgs(["shutdown", udid], 10_000, cleanupSignal);
    } catch (error) {
      logger.warn(`[iOS] Failed to shut down simulator ${udid} after unsuccessful start: ${error}`);
    }
  }

  private async shutdownSimulatorCoordinated(
    udid: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    expectedOwnerToken?: object,
  ): Promise<void> {
    // Waiting for an active boot must not consume the shutdown command's own
    // timeout. The caller's abort signal bounds the queue wait; once acquired,
    // simctl shutdown receives the complete timeout budget.
    const lease = await this.acquireSimulatorBoot(udid, undefined, signal);
    try {
      if (
        expectedOwnerToken !== undefined &&
        (!lease.state.lastBootSucceeded || lease.state.ownerToken !== expectedOwnerToken)
      ) {
        return;
      }
      await this.executeCommandArgs(["shutdown", udid], timeoutMs, signal);
      lease.state.lastBootSucceeded = false;
      lease.state.ownerToken = undefined;
    } finally {
      lease.release();
    }
  }

  async killSimulator(
    device: BootedDevice,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    logger.debug(`Killing iOS simulator ${device.deviceId}`);
    await this.shutdownSimulatorCoordinated(
      device.deviceId,
      options.timeoutMs ?? 10_000,
      options.signal ?? getAbortSignal(),
    );
  }

  async eraseSimulator(udid: string): Promise<void> {
    logger.debug(`Erasing iOS simulator ${udid}`);
    await this.executeCommandArgs(["erase", udid]);
  }

  async waitForSimulatorReady(
    udid: string,
    timeoutMs?: number,
    options?: { assumeBooted?: boolean },
  ): Promise<BootedDevice> {
    const perf = createGlobalPerformanceTracker();

    // The cold-boot path passes `assumeBooted`: startSimulator already ran
    // `bootstatus -b` (which throws on failure/timeout), so the device is
    // already fully booted. Re-running the wait here would be a redundant second
    // boot wait with its own independent timeout budget (issue #3938 follow-up),
    // so skip straight to metadata resolution.
    if (options?.assumeBooted) {
      const deadlineMs = this.bootDeadline(timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS);
      return this.runCoordinatedBoot(udid, deadlineMs, getAbortSignal(), false, () =>
        this.resolveReadySimulator(udid, this.remainingBootTimeoutMs(deadlineMs)),
      );
    }

    // Use `simctl bootstatus -b` which blocks until the simulator is fully
    // booted (data migration complete, system app ready, springboard launched).
    // This is far more reliable than polling `simctl list devices` for state.
    const deadlineMs = this.bootDeadline(timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS);
    perf.startOperation("bootstatus");
    try {
      return await this.runCoordinatedBoot(udid, deadlineMs, getAbortSignal(), false, async () => {
        await this.bootAndVerify(udid, deadlineMs);
        return this.resolveReadySimulator(udid, this.remainingBootTimeoutMs(deadlineMs));
      });
    } catch (error) {
      const message = errorMessage(error);
      // "Invalid device" means the UDID doesn't exist at all
      if (message.includes("Invalid device")) {
        throw new ActionableError(`Simulator with UDID ${udid} not found`);
      }
      throw new ActionableError(`Simulator with UDID ${udid} failed to become ready: ${message}`);
    } finally {
      perf.endOperation("bootstatus");
    }
  }

  /**
   * Boot `udid` and prove it actually reached the `Booted` state, retrying a
   * bounded number of times.
   *
   * `simctl bootstatus -b` is not a trustworthy success signal on its own: a
   * wedged boot can exit 0 while the device is still `Shutdown`, and the
   * trailing `Status=4294967295` line is printed by *healthy* boots on
   * macOS 26 / Xcode 26 (issue #4092) so it cannot be used as a sentinel
   * either. Device state is the signal that actually differs, which is what
   * AutoMobile product boot uses this state check, mirroring the multi-signal
   * readiness proof the Android emulator path already performs.
   *
   * On a failed verification the device is shut down, a bounded backoff is
   * awaited through the injected {@link Timer}, and the boot is retried.
   */
  private async bootAndVerify(udid: string, deadlineMs: number): Promise<void> {
    const { maxAttempts, retryBackoffMs } = this.bootOptions;
    let lastFailure = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let bootstatusReportedAlreadyBooted = false;
      try {
        await this.executeCommandArgs(
          ["bootstatus", udid, "-b"],
          this.remainingBootTimeoutMs(deadlineMs),
        );
      } catch (error) {
        // CoreSimulator can transiently reject bootstatus with error 405 while
        // reporting the requested simulator is already Booted. Verify its state
        // before deciding whether the command failure is actionable.
        if (!isAlreadyBootedCoreSimulator405(error, udid)) {
          throw error;
        }
        logger.debug(
          `[iOS] bootstatus returned expected CoreSimulator error 405 for ${udid}; verifying simulator state: ${error}`,
        );
        bootstatusReportedAlreadyBooted = true;
      }

      const state = await this.readSimulatorState(udid, this.remainingBootTimeoutMs(deadlineMs));
      if (state === "Booted") {
        return;
      }

      lastFailure = bootstatusReportedAlreadyBooted
        ? `bootstatus reported CoreSimulator error 405 but device state is ${state ?? "unknown"}, not Booted`
        : `bootstatus exited 0 but device state is ${state ?? "unknown"}, not Booted`;
      logger.warn(
        `[iOS] Boot verification failed for ${udid} on attempt ${attempt}/${maxAttempts}: ${lastFailure}`,
      );

      if (attempt < maxAttempts) {
        // Best-effort: shutting down an already-shutdown device errors, and that
        // is fine — the next attempt re-boots from whatever state it is in.
        try {
          await this.executeCommandArgs(
            ["shutdown", udid],
            this.remainingBootTimeoutMs(deadlineMs),
          );
        } catch (error) {
          logger.debug(`[iOS] shutdown before boot retry failed for ${udid}: ${error}`);
        }
        await this.timer.sleep(Math.min(retryBackoffMs, this.remainingBootTimeoutMs(deadlineMs)));
      }
    }

    throw new ActionableError(
      `Simulator ${udid} did not reach the Booted state after ${maxAttempts} boot attempt(s): ${lastFailure}. ` +
        "The simulator is likely wedged. Try 'xcrun simctl shutdown all' (or erase the device with " +
        `'xcrun simctl erase ${udid}') and start it again.`,
    );
  }

  private bootDeadline(timeoutMs: number): number {
    return this.timer.now() + timeoutMs;
  }

  private remainingBootTimeoutMs(deadlineMs: number): number {
    const remainingMs = deadlineMs - this.timer.now();
    if (remainingMs <= 0) {
      throw new Error("Simulator boot verification timed out before the next recovery step");
    }
    return remainingMs;
  }

  /**
   * Resolve the simulator runtime identifier to target with a 3-tier fallback:
   *   1. exact version prefix (SDK "26.3" matches runtime "26.3.0")
   *   2. major.minor prefix (SDK "26.3.1" matches runtime "26.3.x")
   *   3. highest runtime in the same major (SDK 26.3 → 26.4 when 26.3 is absent)
   *
   * The identifier is looked up rather than constructed because its format
   * varies across Xcode versions (iOS-26-3 vs iOS-26-3-0).
   *
   * Candidates are ordered by numeric version components rather than string
   * comparison (so "26.10" ranks above "26.9").
   *
   * @param requestedVersion - iOS version to target; defaults to the active
   *                           Xcode iphonesimulator SDK version.
   */
  async resolveRuntimeIdentifier(requestedVersion?: string, signal?: AbortSignal): Promise<string> {
    const version = (requestedVersion ?? (await this.detectIosSdkVersion(signal))).trim();
    if (!version) {
      throw new ActionableError(
        "Could not determine an iOS version to target. Ensure Xcode is installed and " +
          "'xcrun --sdk iphonesimulator --show-sdk-version' returns a version.",
      );
    }

    const runtimes = await this.listIosRuntimes(signal);
    const majorMinor = version.split(".").slice(0, 2).join(".");
    const major = version.split(".")[0];

    const prefixes = [version, `${majorMinor}.`, `${major}.`];
    for (const prefix of prefixes) {
      const match = pickHighestRuntime(runtimes, prefix);
      if (match) {
        logger.debug(
          `[iOS] Resolved runtime ${match.identifier} for iOS ${version} (prefix "${prefix}")`,
        );
        return match.identifier;
      }
    }

    const available =
      runtimes.map((runtime) => `${runtime.name} (${runtime.version})`).join(", ") || "<none>";
    throw new ActionableError(
      `No iOS simulator runtime found for iOS ${version} (tried ${version}, ${majorMinor}.x, ${major}.x). ` +
        `Available runtimes: ${available}. Install one via Xcode > Settings > Components.`,
    );
  }

  /** Read the active Xcode iphonesimulator SDK version. */
  private async detectIosSdkVersion(signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.execAsync(
        "xcrun",
        ["--sdk", "iphonesimulator", "--show-sdk-version"],
        undefined,
        signal,
      );
      return result.stdout.trim();
    } catch (error) {
      throw new ActionableError(
        "Could not detect the iOS SDK version from Xcode " +
          `('xcrun --sdk iphonesimulator --show-sdk-version' failed: ${errorMessage(error)}). ` +
          "Ensure Xcode and its command line tools are installed and selected via xcode-select.",
      );
    }
  }

  /** List installed iOS simulator runtimes that are actually available. */
  private async listIosRuntimes(signal?: AbortSignal): Promise<AppleDeviceRuntime[]> {
    const result = await this.executeCommandArgs(
      ["list", "runtimes", "iOS", "--json"],
      undefined,
      signal,
    );
    try {
      const parsed = JSON.parse(result.stdout) as { runtimes?: AppleDeviceRuntime[] };
      return (parsed.runtimes ?? []).filter((runtime) => runtime.isAvailable !== false);
    } catch (error) {
      throw new ActionableError(
        "Failed to parse iOS simulator runtimes from 'xcrun simctl list runtimes iOS --json': " +
          `${errorMessage(error)}. ` +
          `stdout (first 300 chars): ${result.stdout.trim().slice(0, 300) || "<empty>"}.`,
      );
    }
  }

  /**
   * Read the current CoreSimulator state for a device, bypassing the device
   * list cache so boot verification never trusts a stale snapshot.
   * @returns the state string (e.g. "Booted", "Shutdown"), or undefined when
   *          the device is absent or discovery failed.
   */
  private async readSimulatorState(udid: string, timeoutMs: number): Promise<string | undefined> {
    try {
      const simulatorList = await this.listSimulators(timeoutMs);
      for (const runtimeDevices of Object.values(simulatorList.devices)) {
        const match = runtimeDevices.find((device) => device.udid === udid);
        if (match) {
          return match.state;
        }
      }
      return undefined;
    } catch (error) {
      logger.warn(
        `[iOS] Could not read simulator state for ${udid}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /**
   * Look up full device metadata for an already-booted simulator and return it
   * as a BootedDevice. Shared by the cold-boot (assumeBooted) and already-running
   * branches of {@link waitForSimulatorReady}.
   */
  private async resolveReadySimulator(udid: string, timeoutMs?: number): Promise<BootedDevice> {
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("deviceLookup");
    const simulator = (await this.listSimulatorImages(timeoutMs)).find(
      (device) => device.deviceId === udid,
    );
    perf.endOperation("deviceLookup");

    if (!simulator) {
      throw new ActionableError(`Simulator with UDID ${udid} not found after boot`);
    }

    return {
      name: simulator.name,
      platform: simulator.platform,
      deviceId: simulator.deviceId,
    } as BootedDevice;
  }

  /**
   * Get the list of available (booted and shutdown) simulator UDIDs
   * @returns Promise with an array of device UDIDs
   */
  async listSimulatorImages(timeoutMs?: number): Promise<DeviceInfo[]> {
    // Check cache first
    if (SimCtlClient.deviceListCache) {
      const cacheAge = this.timer.now() - SimCtlClient.deviceListCache.timestamp;
      if (cacheAge < SimCtlClient.DEVICE_LIST_CACHE_TTL) {
        logger.info(`Getting list of iOS simulators (cached, age: ${cacheAge}ms)`);
        return SimCtlClient.deviceListCache.devices;
      }
    }

    logger.debug("Getting list of iOS simulators");

    try {
      const simulatorList = await this.listSimulators(timeoutMs);
      const devices: DeviceInfo[] = [];

      // Extract all devices from all runtime versions
      for (const [runtimeId, runtimeDevices] of Object.entries(simulatorList.devices)) {
        for (const device of runtimeDevices) {
          logger.debug(
            `Found iOS simulator: ${device.name} (${device.udid}) state=${device.state}`,
          );
          const iosVersion = normalizeIosVersion(runtimeId, device.os_version);
          devices.push({
            name: device.name,
            platform: "ios",
            deviceId: device.udid,
            isRunning: device.state === "Booted",
            state: device.state,
            isAvailable: device.isAvailable,
            availabilityError: device.availabilityError,
            iosVersion,
            osVersion: iosVersion,
            formFactor: inferIosFormFactor(device.deviceTypeIdentifier),
            deviceType: device.deviceTypeIdentifier,
            runtime: runtimeId,
            model: device.model,
            architecture: device.architecture,
          } as DeviceInfo);
        }
      }

      devices.sort((a, b) => (a.deviceId || "").localeCompare(b.deviceId || ""));
      if (devices.length > 0) {
        SimCtlClient.deviceListCache = {
          devices,
          timestamp: this.timer.now(),
        };
      } else {
        SimCtlClient.deviceListCache = null;
      }
      return devices;
    } catch (error) {
      SimCtlClient.deviceListCache = null;
      const detail = errorMessage(error);
      logger.warn(`Failed to get iOS devices: ${detail}`);
      throw new ActionableError(`Failed to list iOS simulator devices: ${detail}`);
    }
  }

  /**
   * Get the list of booted simulator UDIDs
   * @returns Promise with an array of booted device UDIDs
   */
  async getBootedSimulators(timeoutMs?: number): Promise<BootedDevice[]> {
    try {
      return await this.getBootedSimulatorsChecked(timeoutMs);
    } catch (error) {
      logger.debug(`Failed to get booted iOS devices: ${error}`);
      return [];
    }
  }

  /**
   * Like {@link getBootedSimulators} but rethrows discovery failures instead of
   * swallowing them into an empty list. Callers that must distinguish "no
   * simulators are booted" from "simctl discovery failed" should use this.
   */
  async getBootedSimulatorsChecked(timeoutMs?: number): Promise<BootedDevice[]> {
    const simulatorList = await this.listSimulators(timeoutMs);
    logger.debug(`Found simulator list: ${simulatorList}`);
    const bootedDevices: BootedDevice[] = [];

    // Extract booted devices from all runtime versions
    for (const [runtimeId, runtimeDevices] of Object.entries(simulatorList.devices)) {
      for (const device of runtimeDevices) {
        if (device.isAvailable && device.state === "Booted") {
          const iosVersion = normalizeIosVersion(runtimeId, device.os_version);
          bootedDevices.push({
            name: device.name,
            platform: "ios",
            deviceId: device.udid,
            iosVersion,
            osVersion: iosVersion,
            formFactor: inferIosFormFactor(device.deviceTypeIdentifier),
          } as BootedDevice);
        }
      }
    }

    bootedDevices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    return bootedDevices;
  }

  /**
   * Get device information by UDID
   * @param udid - Device UDID
   * @returns Promise with device information or null if not found
   */
  async getDeviceInfo(udid: string): Promise<AppleDevice | null> {
    try {
      const simulatorList = await this.listSimulators();

      // Search for the device in all runtime versions
      for (const [runtimeId, runtimeDevices] of Object.entries(simulatorList.devices)) {
        const device = runtimeDevices.find((d) => d.udid === udid);
        if (device) {
          return { ...device, runtime: runtimeId };
        }
      }

      return null;
    } catch (error) {
      logger.warn(`Failed to get iOS device info for ${udid}: ${error}`);
      return null;
    }
  }

  /**
   * Boot a simulator by UDID
   * @param udid - Device UDID to boot
   * @returns Promise that resolves when boot is initiated
   */
  async bootSimulator(udid: string): Promise<BootedDevice> {
    logger.debug(`Booting iOS simulator ${udid}`);
    const perf = createGlobalPerformanceTracker();

    // Route through the shared verifier so the SESSION AUTO-START path gets the
    // same post-condition check and bounded retry as startSimulator. This is the
    // default path when an MCP session begins with no booted simulator
    // (DeviceSessionManager.findOrStartIosDevice -> bootSimulator), so leaving it
    // on the old behaviour would have meant #4094 missed the very scenario it is
    // about. The old code ran a bare `simctl boot`, which does not wait for the
    // boot to finish, then slept a fixed 1s and asked whether the device had
    // shown up in the booted list -- neither a wait nor a proof of readiness.
    const deadlineMs = this.bootDeadline(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    perf.startOperation("simctlBoot");
    return this.runCoordinatedBoot(
      udid,
      deadlineMs,
      getAbortSignal(),
      true,
      async () => {
        await this.bootAndVerify(udid, deadlineMs);
        perf.endOperation("simctlBoot");
        return this.resolveRegisteredBootSimulator(udid, deadlineMs, perf);
      },
      () => {
        perf.endOperation("simctlBoot");
        return this.resolveRegisteredBootSimulator(udid, deadlineMs, perf);
      },
    );
  }

  private async resolveRegisteredBootSimulator(
    udid: string,
    deadlineMs: number,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<BootedDevice> {
    perf.startOperation("bootRegistration");
    const bootedSimulators = await this.getBootedSimulatorsChecked(
      this.remainingBootTimeoutMs(deadlineMs),
    );
    const bootedSimulator = bootedSimulators.find((device) => device.deviceId === udid);
    perf.endOperation("bootRegistration");
    if (!bootedSimulator) {
      throw new ActionableError(`Failed to boot iOS simulator ${udid}`);
    }
    return bootedSimulator;
  }

  /**
   * Get available device types (iPhone models, iPad models, etc.)
   * @returns Promise with array of device types
   */
  async getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]> {
    const result = await this.executeCommandArgs(
      ["list", "devicetypes", "--json"],
      undefined,
      signal,
    );
    try {
      const data = JSON.parse(result.stdout) as { devicetypes?: AppleDeviceType[] };
      return data.devicetypes ?? [];
    } catch (error) {
      logger.warn(`Failed to parse device types from simctl: ${error}`);
      return [];
    }
  }

  /** Get device types and preserve malformed simctl output as an error. */
  async getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]> {
    const result = await this.executeCommandArgs(
      ["list", "devicetypes", "--json"],
      undefined,
      signal,
    );
    const data = JSON.parse(result.stdout) as { devicetypes?: unknown };
    if (!Array.isArray(data?.devicetypes)) {
      throw new Error("simctl device types response does not contain a devicetypes array");
    }
    return data.devicetypes as AppleDeviceType[];
  }

  /**
   * Get available iOS runtimes
   * @returns Promise with array of runtimes
   */
  async getRuntimes(): Promise<AppleDeviceRuntime[]> {
    const result = await this.executeCommandArgs(["list", "runtimes", "--json"]);
    try {
      const data = JSON.parse(result.stdout) as { runtimes?: AppleDeviceRuntime[] };
      return (data.runtimes ?? []).filter(runtime => runtime.isAvailable);
    } catch (error) {
      logger.warn(`Failed to parse runtimes from simctl: ${error}`);
      return [];
    }
  }

  /** Get available runtimes and preserve malformed simctl output as an error. */
  async getRuntimesChecked(): Promise<AppleDeviceRuntime[]> {
    const result = await this.executeCommandArgs(["list", "runtimes", "--json"]);
    const data = JSON.parse(result.stdout) as { runtimes?: unknown };
    if (!Array.isArray(data?.runtimes)) {
      throw new Error("simctl runtimes response does not contain a runtimes array");
    }
    return (data.runtimes as AppleDeviceRuntime[]).filter(runtime => runtime.isAvailable);
  }

  /**
   * Create a new simulator
   * @param name - Name for the new simulator
   * @param deviceType - Device type identifier (e.g., "iPhone 15")
   * @param runtime - Runtime identifier (e.g., "iOS 17.0")
   * @returns Promise with the UDID of the created simulator
   */
  async createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string> {
    logger.debug(`Creating iOS simulator: ${name} (${deviceType}, ${runtime})`);
    const result = await this.executeCommandArgs(
      ["create", name, deviceType, runtime],
      undefined,
      signal,
    );
    const simulatorUdid = result.stdout.trim();

    if (!simulatorUdid) {
      throw new ActionableError(`Failed to create iOS simulator ${name}`);
    }

    // A freshly created simulator must be visible to the very next
    // listSimulatorImages() call, otherwise the provisioning path boots off a
    // snapshot that predates the device it just created.
    SimCtlClient.invalidateDeviceListCache();

    logger.debug(`Created iOS simulator ${name} with UDID: ${simulatorUdid}`);
    return simulatorUdid;
  }

  /** Drop the shared device-list snapshot so the next list re-reads simctl. */
  static invalidateDeviceListCache(): void {
    SimCtlClient.deviceListCache = null;
  }

  /**
   * Delete a simulator by UDID
   * @param udid - Device UDID to delete
   * @returns Promise that resolves when deletion is complete
   */
  async deleteSimulator(udid: string): Promise<void> {
    logger.debug(`Deleting iOS simulator ${udid}`);
    await this.executeCommandArgs(["delete", udid]);
  }

  /**
   * List all installed apps on the simulator
   * @param deviceId - Optional device ID (defaults to "booted" for current booted simulator)
   * @returns Promise with array of app objects containing bundle identifiers and other metadata
   */
  async listApps(deviceId?: string): Promise<any[]> {
    const targetDevice = deviceId || this.device?.deviceId || "booted";
    logger.debug(`Listing installed apps on iOS simulator ${targetDevice}`);

    try {
      const parseApps = (payload: string): any[] => {
        const appsData = JSON.parse(payload);

        if (Array.isArray(appsData)) {
          return appsData;
        }

        if (!appsData || typeof appsData !== "object") {
          return [];
        }

        // Convert the apps object to an array, preserving bundle IDs from keys.
        return Object.entries(appsData).map(([bundleId, appInfo]) => {
          const record = appInfo && typeof appInfo === "object" ? appInfo : {};
          return { ...record, bundleId };
        });
      };

      // simctl listapps may return an old-style plist instead of JSON (Xcode
      // 26+). The plist owner receives the exact bytes over stdin, avoiding a
      // shell pipe and a temporary host file.
      const listAppsJson = async (args: string[]): Promise<string> => {
        const result = await this.executeCommandArgs(["listapps", ...args]);
        try {
          JSON.parse(result.stdout);
          return result.stdout;
        } catch (error) {
          logger.debug(`[iOS] listapps returned plist; converting with plutil: ${error}`);
          return JSON.stringify(await this.plist.readJsonBytes(Buffer.from(result.stdout, "utf8")));
        }
      };

      try {
        return parseApps(await listAppsJson([targetDevice, "--all"]));
      } catch (error) {
        logger.warn(`Failed to list iOS apps with --all: ${error}`);
      }

      return parseApps(await listAppsJson([targetDevice]));
    } catch (error) {
      logger.warn(`Failed to list iOS apps: ${error}`);
      return [];
    }
  }

  /**
   * Launch an app on the simulator
   * @param bundleId - The bundle identifier of the app to launch
   * @param options - Launch options
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   * @returns Promise with launch result containing success status and optional PID
   */
  async launchApp(
    bundleId: string,
    options?: { foregroundIfRunning?: boolean },
    deviceId?: string,
  ): Promise<{
    success: boolean;
    pid?: number;
    error?: string;
  }> {
    const targetDevice = deviceId || this.device?.deviceId || "booted";
    logger.debug(`Launching app ${bundleId} on iOS simulator ${targetDevice}`);

    try {
      const result = await this.executeCommandArgs(["launch", targetDevice, bundleId]);

      // Parse the output to extract PID if available
      // Example output: "com.example.app: 12345"
      const pidMatch = result.stdout.match(/:\s*(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined;

      return {
        success: true,
        pid,
      };
    } catch (error) {
      logger.warn(`Failed to launch iOS app ${bundleId}: ${error}`);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Terminate an app on the simulator
   * @param bundleId - The bundle identifier of the app to terminate
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   * @returns Promise that resolves when termination is complete
   */
  async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
    const targetDevice = deviceId || this.device?.deviceId || "booted";
    logger.debug(`Terminating app ${bundleId} on iOS simulator ${targetDevice}`);

    try {
      await this.executeCommandArgs(["terminate", targetDevice, bundleId]);
    } catch (error) {
      logger.warn(`Failed to terminate iOS app ${bundleId}: ${error}`);
      throw error;
    }
  }

  async installApp(appPath: string, deviceId?: string): Promise<void> {
    const targetDevice = deviceId || this.device?.deviceId || "booted";
    logger.debug(`Installing app ${appPath} on iOS simulator ${targetDevice}`);
    await this.executeCommandArgs(["install", targetDevice, appPath]);
  }

  async uninstallApp(bundleId: string, deviceId?: string): Promise<void> {
    const targetDevice = deviceId || this.device?.deviceId || "booted";
    logger.debug(`Uninstalling app ${bundleId} from iOS simulator ${targetDevice}`);
    await this.executeCommandArgs(["uninstall", targetDevice, bundleId]);
  }

  /**
   * Get the screen size of the simulator
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   * @returns Promise with screen dimensions
   */
  async getScreenSize(deviceId?: string): Promise<ScreenSize> {
    const targetDevice = deviceId || this.device?.deviceId || "booted";

    logger.info(`[iOS] Getting screen size for simulator ${targetDevice}`);

    // Use simctl io enumerate to get display information
    const result = await this.executeCommandArgs(["io", targetDevice, "enumerate"]);

    // Parse the text output to find LCD screen information
    const lines = result.stdout.split("\n");
    let inLCDScreen = false;
    let width = 0;
    let height = 0;
    let uiScale = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Look for LCD screen section
      if (line.includes("LCD:") || line.includes("Screen Type: Integrated")) {
        inLCDScreen = true;
        continue;
      }

      // If we're in the LCD screen section, look for Pixel Size and UI Scale
      if (inLCDScreen) {
        if (line.includes("Pixel Size:")) {
          // Extract dimensions from format "Pixel Size: {1179, 2556}"
          const pixelSizeMatch = line.match(/Pixel Size:\s*\{(\d+),\s*(\d+)\}/);
          if (pixelSizeMatch) {
            width = parseInt(pixelSizeMatch[1], 10);
            height = parseInt(pixelSizeMatch[2], 10);
          }
        }

        if (line.includes("Preferred UI Scale:")) {
          // Extract UI scale from format "Preferred UI Scale: 3"
          const uiScaleMatch = line.match(/Preferred UI Scale:\s*(\d+(?:\.\d+)?)/);
          if (uiScaleMatch) {
            uiScale = parseFloat(uiScaleMatch[1]);
          }
        }
      }

      // Reset flag if we encounter a new port section
      if (line.startsWith("Port:") && inLCDScreen) {
        inLCDScreen = false;
      }
    }

    // If we found valid dimensions, apply UI scale and return logical size
    if (width > 0 && height > 0 && uiScale > 0) {
      return {
        width: Math.round(width / uiScale),
        height: Math.round(height / uiScale),
      } as ScreenSize;
    }

    throw new ActionableError("Unable to determine screen size from provided data.");
  }

  async setAppearance(mode: "light" | "dark", deviceId?: string): Promise<void> {
    const targetDevice = deviceId || this.device?.deviceId || "booted";
    await this.executeCommandArgs(["ui", targetDevice, "appearance", mode]);
  }

  /**
   * Deliver a simulated remote push to a booted simulator via `simctl push`.
   * Writes the payload to a temp .apns file because executeCommand cannot stream stdin.
   */
  async pushNotification(
    deviceId: string,
    bundleId: string,
    payloadJson: string,
  ): Promise<{ success: boolean; error?: string }> {
    const dir = await fsPromises.mkdtemp(join(tmpdir(), "automobile-apns-"));
    const file = join(dir, "payload.apns");
    try {
      await fsPromises.writeFile(file, payloadJson, "utf-8");
      // `xcrun simctl push <udid> <bundleId> <file>`; bundleId may be omitted when the
      // payload carries "Simulator Target Bundle", but passing it explicitly is harmless.
      const result = await this.executeCommandArgs(["push", deviceId, bundleId, file]);
      if ((result.stderr || "").trim().length > 0) {
        return { success: false, error: result.stderr.trim() };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async openSimulatorApp(udid?: string, signal?: AbortSignal): Promise<void> {
    // On a headless macOS host (no Aqua GUI session, e.g. a launchd daemon or
    // SSH context) `open -a Simulator` fails with OSLaunchdErrorDomain Code=125
    // after a slow retry, wasting wall-clock against the daemon-start budget.
    // The booted simulator + CtrlProxy work without the GUI, so skip the launch.
    if (await this.isHeadlessSession(signal)) {
      logger.debug("Skipping open -a Simulator: headless session (no Aqua GUI)");
      return;
    }

    // Ensure Simulator.app is open (creates windows for all booted devices)
    await this.execAsync("open", ["-a", "Simulator"], undefined, signal);
    // If a specific device is requested, focus it by switching to it
    // --args -CurrentDeviceUDID only works on fresh launch; for already-running
    // Simulator, we activate the app which brings all device windows forward
    if (udid) {
      try {
        await this.execAsync(
          "osascript",
          ["-e", 'tell application "Simulator" to activate'],
          undefined,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        logger.debug(`[iOS] Could not activate Simulator.app for ${udid}: ${error}`);
      }
    }
  }

  /**
   * Determine whether the current host can launch the Simulator GUI.
   *
   * Resolution order:
   *  1. Non-darwin platforms are always headless (Simulator.app is macOS-only).
   *     This gate comes BEFORE the env override so `AUTOMOBILE_IOS_HEADLESS=false`
   *     (or `""`) can never make `openSimulatorApp` shell `open -a Simulator` on
   *     Linux/Windows, where that binary does not exist (issue #4177).
   *  2. `AUTOMOBILE_IOS_HEADLESS` env override (`true`/`1` => headless,
   *     `false`/`0` => force GUI launch).
   *  3. Auto-detect via `launchctl managername`: an `Aqua` manager means a GUI
   *     login session; anything else (`System`/`Background`) is a daemon/SSH
   *     context with no GUI domain.
   *
   * If detection itself fails we assume a GUI session to preserve the prior
   * behavior. The result is cached so launchctl is probed at most once.
   */
  private async isHeadlessSession(signal?: AbortSignal): Promise<boolean> {
    if (this.platform !== "darwin") {
      return true;
    }

    const override = process.env.AUTOMOBILE_IOS_HEADLESS;
    if (override !== undefined) {
      return override === "true" || override === "1";
    }

    if (this.headlessSessionCache === null) {
      this.headlessSessionCache = await this.detectHeadlessSession(signal);
    }
    return this.headlessSessionCache;
  }

  private async detectHeadlessSession(signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await this.execAsync("launchctl", ["managername"], undefined, signal);
      const managerName = (result.stdout || "").trim();
      // "Aqua" is the GUI login session manager; "System"/"Background" are not.
      return managerName !== "Aqua";
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Can't determine the session type; assume a GUI session so we preserve
      // the historical behavior rather than silently suppressing the launch.
      logger.debug(`launchctl managername probe failed, assuming GUI session: ${error}`);
      return false;
    }
  }
}

// Backward compatibility export
export { SimCtlClient as Simctl };
