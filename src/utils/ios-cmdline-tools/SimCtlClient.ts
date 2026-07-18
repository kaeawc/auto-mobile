import { ChildProcess, execFile } from "child_process";
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
  executeCommand(command: string, timeoutMs?: number): Promise<ExecResult>;

  /**
   * Execute a simctl command from pre-split arguments. Use this for literal user
   * values that must preserve empty strings, backslashes, or shell metacharacters.
   * @param args - Arguments after the `simctl` executable name
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with command output
   */
  executeCommandArgs(args: string[], timeoutMs?: number): Promise<ExecResult>;

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
  startSimulator(udid: string, timeoutMs?: number): Promise<any>;

  /**
   * Kill a simulator
   * @param device - Device to kill
   * @returns Promise that resolves when kill is complete
   */
  killSimulator(device: BootedDevice): Promise<void>;

  /**
   * Wait for a simulator to be ready
   * @param udid - Device UDID to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds
   * @param options - When `assumeBooted` is set, skip the blocking `bootstatus -b`
   *   readiness wait because the caller (e.g. `startSimulator`) already performed
   *   it, and only resolve device metadata.
   * @returns Promise with booted device information
   */
  waitForSimulatorReady(udid: string, timeoutMs?: number, options?: { assumeBooted?: boolean }): Promise<BootedDevice>;

  /**
   * Get the list of available (booted and shutdown) simulator UDIDs
   * @returns Promise with an array of device info
   */
  listSimulatorImages(): Promise<DeviceInfo[]>;

  /**
   * Get the list of booted simulator UDIDs
   * @returns Promise with an array of booted devices
   */
  getBootedSimulators(): Promise<BootedDevice[]>;

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
  getDeviceTypes(): Promise<AppleDeviceType[]>;

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
  createSimulator(name: string, deviceType: string, runtime: string): Promise<string>;

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
    deviceId?: string
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
  openSimulatorApp(udid?: string): Promise<void>;

  /**
   * Deliver a simulated remote push notification to a booted simulator.
   * @param deviceId - Simulator UDID
   * @param bundleId - Target app bundle identifier
   * @param payloadJson - APNs payload JSON (must contain a top-level `aps` key, <=4096 bytes)
   */
  pushNotification(deviceId: string, bundleId: string, payloadJson: string): Promise<{ success: boolean; error?: string }>;
}

// Enhance the standard execAsync result to implement the ExecResult interface
const execAsync = async (
  file: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal
): Promise<ExecResult> => {
  // Pass the AbortSignal to execFile so that when a caller's timeout aborts, Node
  // kills the child process (SIGTERM) instead of leaving it running orphaned
  // (issue #3938). Without this a timed-out `bootstatus -b` keeps booting the
  // simulator in the background after the tool has already reported failure.
  const options: Parameters<typeof execFile>[2] =
    maxBuffer && signal ? { maxBuffer, signal }
      : maxBuffer ? { maxBuffer }
        : signal ? { signal }
          : undefined;
  const result = await promisify(execFile)(file, args, options);

  const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout.toString();
  const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString();
  return createExecResult(stdout, stderr);
};

function splitCommandArgs(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Command cannot be empty");
  }

  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === "\\" && i + 1 < trimmed.length) {
      current += trimmed[i + 1];
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

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

function normalizeIosVersion(runtimeId: string | undefined, osVersion: string | undefined): string | undefined {
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

function inferIosFormFactor(deviceTypeId: string | undefined): "phone" | "tablet" | undefined {
  if (!deviceTypeId) {return undefined;}
  if (deviceTypeId.includes("iPad")) {return "tablet";}
  if (deviceTypeId.includes("iPhone")) {return "phone";}
  return undefined;
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

export class SimCtlClient implements SimCtl {
  device: BootedDevice | null;
  execAsync: (file: string, args: string[], maxBuffer?: number, signal?: AbortSignal) => Promise<ExecResult>;
  private timer: Timer;
  private platform: NodeJS.Platform;
  private readonly usesInjectedExecAsync: boolean;
  // Cached result of the launchctl headless-session probe (null = not yet probed)
  private headlessSessionCache: boolean | null = null;

  // Static cache for device list
  private static deviceListCache: { devices: DeviceInfo[], timestamp: number } | null = null;
  private static readonly DEVICE_LIST_CACHE_TTL = 5000; // 5 seconds
  private static localSimctlAvailability: Promise<void> | null = null;

  /**
   * Create an IosUtils instance
   * @param device - Optional device
   * @param execAsyncFn - promisified exec function (for testing)
   * @param timer - Timer for delays and time tracking
   */
  constructor(
    device: BootedDevice | null = null,
    execAsyncFn: ((file: string, args: string[], maxBuffer?: number, signal?: AbortSignal) => Promise<ExecResult>) | null = null,
    timer: Timer = defaultTimer,
    platform: NodeJS.Platform = process.platform
  ) {
    this.device = device;
    this.usesInjectedExecAsync = execAsyncFn !== null;
    this.execAsync = execAsyncFn || execAsync;
    this.timer = timer;
    this.platform = platform;
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
  async executeCommand(command: string, timeoutMs?: number): Promise<ExecResult> {
    const hostArgs = splitCommandArgs(command);
    return this.executeCommandArgv(hostArgs, timeoutMs, command);
  }

  async executeCommandArgs(args: string[], timeoutMs?: number): Promise<ExecResult> {
    return this.executeCommandArgv(args, timeoutMs, args.map(arg => JSON.stringify(arg)).join(" "));
  }

  private async executeCommandArgv(args: string[], timeoutMs?: number, displayCommand?: string): Promise<ExecResult> {
    if (args.length === 0) {
      throw new Error("Command cannot be empty");
    }
    const command = displayCommand ?? args.map(arg => JSON.stringify(arg)).join(" ");
    const hostArgs = args;
    const localArgs = ["simctl", ...hostArgs];

    const fullCommand = `xcrun simctl ${command}`;
    const startTime = this.timer.now();

    logger.debug(`[iOS] Executing command: ${fullCommand}`);

    try {
      await this.ensureLocalSimctlAvailable();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = this.platform === "darwin"
        ? `simctl is not available. Please install Xcode command line tools to continue. ${detail}`
        : "iOS simulator tooling is only available on macOS.";
      throw new ActionableError(message);
    }

    const runCommand = (signal?: AbortSignal) => this.execAsync("xcrun", localArgs, undefined, signal);

    // Use Promise.race to implement timeout if specified. On timeout we abort the
    // controller so the underlying child process is killed rather than left
    // running orphaned (issue #3938).
    if (timeoutMs) {
      let timeoutId: NodeJS.Timeout;
      const controller = new AbortController();

      const timeoutPromise = new Promise<ExecResult>((_, reject) => {
        timeoutId = this.timer.setTimeout(
          () => {
            controller.abort();
            reject(new Error(`Command timed out after ${timeoutMs}ms: ${fullCommand}`));
          },
          timeoutMs
        );
      });

      const runPromise = runCommand(controller.signal);
      // Once the timeout wins the race the aborted run promise rejects with an
      // AbortError; keep it handled so it can't surface as an unhandledRejection.
      runPromise.catch(() => { /* settled after timeout; result consumed via race */ });

      try {
        const result = await Promise.race([runPromise, timeoutPromise]);
        const duration = this.timer.now() - startTime;
        logger.debug(`[iOS] Command completed in ${duration}ms: ${command}`);
        return result;
      } catch (error) {
        const duration = this.timer.now() - startTime;
        logger.warn(`[iOS] Command failed after ${duration}ms: ${command} - ${(error as Error).message}`);
        throw error;
      } finally {
        clearTimeout(timeoutId!);
      }
    }

    // No timeout specified
    try {
      const result = await runCommand();
      const duration = this.timer.now() - startTime;
      logger.debug(`[iOS] Command completed in ${duration}ms: ${command}`);
      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[iOS] Command failed after ${duration}ms: ${command} - ${(error as Error).message}`);
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
        .catch(err => {
          SimCtlClient.localSimctlAvailability = null;
          logger.debug(`[iOS] simctl unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
  private async listSimulators(): Promise<SimulatorList> {
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("simctlListDevices");
    const result = await this.executeCommand("list devices --json");
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
        `${error instanceof Error ? error.message : String(error)}. ` +
        `stdout (first 300 chars): ${stdoutSnippet || "<empty>"}. ` +
        `stderr (first 300 chars): ${stderrSnippet || "<empty>"}.`
      );
    }
  }

  async isSimulatorRunning(identifier: string): Promise<boolean> {
    return (await this.getBootedSimulators()).some(simulator =>
      simulator.deviceId === identifier || simulator.name === identifier
    );
  }

  async startSimulator(udid: string, timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS): Promise<ChildProcess> {
    logger.debug(`Starting iOS simulator ${udid}`);
    const perf = createGlobalPerformanceTracker();

    // `bootstatus -b` is idempotent: it boots shutdown simulators, accepts
    // already-booted simulators, and waits until CoreSimulator reports ready.
    perf.startOperation("bootstatus");
    await this.executeCommand(`bootstatus ${udid} -b`, timeoutMs);
    perf.endOperation("bootstatus");

    // Open Simulator.app focused on this specific device (no-op on headless hosts)
    try {
      perf.startOperation("openSimulatorApp");
      await this.openSimulatorApp(udid);
      perf.endOperation("openSimulatorApp");
    } catch {
      perf.endOperation("openSimulatorApp");
      logger.debug("Could not open Simulator.app (non-fatal)");
    }

    // simctl bootstatus is synchronous, so we return a mock process handle
    // with the minimal subset of ChildProcess fields used by callers
    return {
      pid: this.timer.now(), // Use timestamp as mock PID
      kill: () => false,
      killed: false,
      connected: false,
      exitCode: 0,
      signalCode: null
    } as Pick<ChildProcess, "pid" | "kill" | "killed" | "connected" | "exitCode" | "signalCode"> as ChildProcess;
  }

  async killSimulator(device: BootedDevice): Promise<void> {
    logger.debug(`Killing iOS simulator ${device.deviceId}`);
    await this.executeCommand(`shutdown ${device.deviceId}`);
  }

  async waitForSimulatorReady(
    udid: string,
    timeoutMs?: number,
    options?: { assumeBooted?: boolean }
  ): Promise<BootedDevice> {
    const perf = createGlobalPerformanceTracker();

    // The cold-boot path passes `assumeBooted`: startSimulator already ran
    // `bootstatus -b` (which throws on failure/timeout), so the device is
    // already fully booted. Re-running the wait here would be a redundant second
    // boot wait with its own independent timeout budget (issue #3938 follow-up),
    // so skip straight to metadata resolution.
    if (options?.assumeBooted) {
      return this.resolveReadySimulator(udid);
    }

    // Use `simctl bootstatus -b` which blocks until the simulator is fully
    // booted (data migration complete, system app ready, springboard launched).
    // This is far more reliable than polling `simctl list devices` for state.
    perf.startOperation("bootstatus");
    try {
      await this.executeCommand(`bootstatus ${udid} -b`, timeoutMs);
    } catch (error) {
      perf.endOperation("bootstatus");
      const message = error instanceof Error ? error.message : String(error);
      // "Invalid device" means the UDID doesn't exist at all
      if (message.includes("Invalid device")) {
        throw new ActionableError(`Simulator with UDID ${udid} not found`);
      }
      throw new ActionableError(
        `Simulator with UDID ${udid} failed to become ready: ${message}`
      );
    }
    perf.endOperation("bootstatus");

    return this.resolveReadySimulator(udid);
  }

  /**
   * Look up full device metadata for an already-booted simulator and return it
   * as a BootedDevice. Shared by the cold-boot (assumeBooted) and already-running
   * branches of {@link waitForSimulatorReady}.
   */
  private async resolveReadySimulator(udid: string): Promise<BootedDevice> {
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("deviceLookup");
    const simulator = (await this.listSimulatorImages())
      .find(device => device.deviceId === udid);
    perf.endOperation("deviceLookup");

    if (!simulator) {
      throw new ActionableError(`Simulator with UDID ${udid} not found after boot`);
    }

    return {
      name: simulator.name,
      platform: simulator.platform,
      deviceId: simulator.deviceId
    } as BootedDevice;
  }

  /**
   * Get the list of available (booted and shutdown) simulator UDIDs
   * @returns Promise with an array of device UDIDs
   */
  async listSimulatorImages(): Promise<DeviceInfo[]> {
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
      const simulatorList = await this.listSimulators();
      const devices: DeviceInfo[] = [];

      // Extract all devices from all runtime versions
      for (const [runtimeId, runtimeDevices] of Object.entries(simulatorList.devices)) {
        for (const device of runtimeDevices) {
          logger.debug(`Found iOS simulator: ${device.name} (${device.udid}) state=${device.state}`);
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
            architecture: device.architecture
          } as DeviceInfo);
        }
      }

      devices.sort((a, b) => (a.deviceId || "").localeCompare(b.deviceId || ""));
      if (devices.length > 0) {
        SimCtlClient.deviceListCache = {
          devices,
          timestamp: this.timer.now()
        };
      } else {
        SimCtlClient.deviceListCache = null;
      }
      return devices;
    } catch (error) {
      SimCtlClient.deviceListCache = null;
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to get iOS devices: ${detail}`);
      throw new ActionableError(`Failed to list iOS simulator devices: ${detail}`);
    }
  }

  /**
   * Get the list of booted simulator UDIDs
   * @returns Promise with an array of booted device UDIDs
   */
  async getBootedSimulators(): Promise<BootedDevice[]> {
    try {
      return await this.getBootedSimulatorsChecked();
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
  async getBootedSimulatorsChecked(): Promise<BootedDevice[]> {
    const simulatorList = await this.listSimulators();
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
        const device = runtimeDevices.find(d => d.udid === udid);
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

    perf.startOperation("simctlBoot");
    await this.executeCommand(`boot ${udid}`);
    perf.endOperation("simctlBoot");

    // Wait a moment for the simulator to register as booted
    await this.timer.sleep(1000);

    perf.startOperation("bootRegistration");
    const bootedSimulators = await this.getBootedSimulators();
    const bootedSimulator = bootedSimulators.find(device => device.deviceId === udid);
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
  async getDeviceTypes(): Promise<AppleDeviceType[]> {
    const result = await this.executeCommand("list devicetypes --json");
    try {
      const data = JSON.parse(result.stdout);
      return data.devicetypes ?? [];
    } catch (error) {
      logger.warn(`Failed to parse device types from simctl: ${error}`);
      return [];
    }
  }

  /**
   * Get available iOS runtimes
   * @returns Promise with array of runtimes
   */
  async getRuntimes(): Promise<AppleDeviceRuntime[]> {
    const result = await this.executeCommand("list runtimes --json");
    try {
      const data = JSON.parse(result.stdout);
      return (data.runtimes ?? []).filter((runtime: AppleDeviceRuntime) => runtime.isAvailable);
    } catch (error) {
      logger.warn(`Failed to parse runtimes from simctl: ${error}`);
      return [];
    }
  }

  /**
   * Create a new simulator
   * @param name - Name for the new simulator
   * @param deviceType - Device type identifier (e.g., "iPhone 15")
   * @param runtime - Runtime identifier (e.g., "iOS 17.0")
   * @returns Promise with the UDID of the created simulator
   */
  async createSimulator(name: string, deviceType: string, runtime: string): Promise<string> {
    logger.debug(`Creating iOS simulator: ${name} (${deviceType}, ${runtime})`);
    const result = await this.executeCommand(`create "${name}" "${deviceType}" "${runtime}"`);
    const simulatorUdid = result.stdout.trim();

    if (!simulatorUdid) {
      throw new ActionableError(`Failed to create iOS simulator ${name}`);
    }

    logger.debug(`Created iOS simulator ${name} with UDID: ${simulatorUdid}`);
    return simulatorUdid;
  }

  /**
   * Delete a simulator by UDID
   * @param udid - Device UDID to delete
   * @returns Promise that resolves when deletion is complete
   */
  async deleteSimulator(udid: string): Promise<void> {
    logger.debug(`Deleting iOS simulator ${udid}`);
    await this.executeCommand(`delete ${udid}`);
  }

  /**
   * List all installed apps on the simulator
   * @param deviceId - Optional device ID (defaults to "booted" for current booted simulator)
   * @returns Promise with array of app objects containing bundle identifiers and other metadata
   */
  async listApps(deviceId?: string): Promise<any[]> {
    const targetDevice = deviceId || (this.device?.deviceId) || "booted";
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

      // simctl listapps may return old-style plist instead of JSON (Xcode 26+).
      // Pipe through plutil to convert plist to JSON.
      const listAppsJson = async (args: string): Promise<string> => {
        const result = await this.execAsync(
          "/bin/sh",
          ["-c", `xcrun simctl listapps ${args} | plutil -convert json -o - -- -`]
        );
        return result.stdout;
      };

      try {
        return parseApps(await listAppsJson(`${targetDevice} --all`));
      } catch (error) {
        logger.warn(`Failed to list iOS apps with --all: ${error}`);
      }

      return parseApps(await listAppsJson(targetDevice));
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
  async launchApp(bundleId: string, options?: { foregroundIfRunning?: boolean }, deviceId?: string): Promise<{
    success: boolean;
    pid?: number;
    error?: string
  }> {
    const targetDevice = deviceId || (this.device?.deviceId) || "booted";
    logger.debug(`Launching app ${bundleId} on iOS simulator ${targetDevice}`);

    try {
      const result = await this.executeCommand(`launch ${targetDevice} ${bundleId}`);

      // Parse the output to extract PID if available
      // Example output: "com.example.app: 12345"
      const pidMatch = result.stdout.match(/:\s*(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined;

      return {
        success: true,
        pid
      };
    } catch (error) {
      logger.warn(`Failed to launch iOS app ${bundleId}: ${error}`);
      return {
        success: false,
        error: (error as Error).message
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
    const targetDevice = deviceId || (this.device?.deviceId) || "booted";
    logger.debug(`Terminating app ${bundleId} on iOS simulator ${targetDevice}`);

    try {
      await this.executeCommand(`terminate ${targetDevice} ${bundleId}`);
    } catch (error) {
      logger.warn(`Failed to terminate iOS app ${bundleId}: ${error}`);
      throw error;
    }
  }

  async installApp(appPath: string, deviceId?: string): Promise<void> {
    const targetDevice = deviceId || (this.device?.deviceId) || "booted";
    logger.debug(`Installing app ${appPath} on iOS simulator ${targetDevice}`);
    await this.executeCommand(`install ${targetDevice} "${appPath}"`);
  }

  async uninstallApp(bundleId: string, deviceId?: string): Promise<void> {
    const targetDevice = deviceId || (this.device?.deviceId) || "booted";
    logger.debug(`Uninstalling app ${bundleId} from iOS simulator ${targetDevice}`);
    await this.executeCommand(`uninstall ${targetDevice} ${bundleId}`);
  }

  /**
   * Get the screen size of the simulator
   * @param deviceId - Optional device ID (defaults to current device or "booted")
   * @returns Promise with screen dimensions
   */
  async getScreenSize(deviceId?: string): Promise<ScreenSize> {
    const targetDevice = deviceId || (this.device?.deviceId) || "booted";

    logger.info(`[iOS] Getting screen size for simulator ${targetDevice}`);

    // Use simctl io enumerate to get display information
    const result = await this.executeCommand(`io ${targetDevice} enumerate`);

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
        height: Math.round(height / uiScale)
      } as ScreenSize;
    }

    throw new ActionableError("Unable to determine screen size from provided data.");
  }

  async setAppearance(mode: "light" | "dark", deviceId?: string): Promise<void> {
    const targetDevice = deviceId || this.device?.deviceId || "booted";
    await this.executeCommand(`ui ${targetDevice} appearance ${mode}`);
  }

  /**
   * Deliver a simulated remote push to a booted simulator via `simctl push`.
   * Writes the payload to a temp .apns file because executeCommand cannot stream stdin.
   */
  async pushNotification(deviceId: string, bundleId: string, payloadJson: string): Promise<{ success: boolean; error?: string }> {
    const dir = await fsPromises.mkdtemp(join(tmpdir(), "automobile-apns-"));
    const file = join(dir, "payload.apns");
    try {
      await fsPromises.writeFile(file, payloadJson, "utf-8");
      // `xcrun simctl push <udid> <bundleId> <file>`; bundleId may be omitted when the
      // payload carries "Simulator Target Bundle", but passing it explicitly is harmless.
      const result = await this.executeCommand(`push ${deviceId} ${bundleId} "${file}"`);
      if ((result.stderr || "").trim().length > 0) {
        return { success: false, error: result.stderr.trim() };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async openSimulatorApp(udid?: string): Promise<void> {
    // On a headless macOS host (no Aqua GUI session, e.g. a launchd daemon or
    // SSH context) `open -a Simulator` fails with OSLaunchdErrorDomain Code=125
    // after a slow retry, wasting wall-clock against the daemon-start budget.
    // The booted simulator + CtrlProxy work without the GUI, so skip the launch.
    if (await this.isHeadlessSession()) {
      logger.debug("Skipping open -a Simulator: headless session (no Aqua GUI)");
      return;
    }

    // Ensure Simulator.app is open (creates windows for all booted devices)
    await this.execAsync("open", ["-a", "Simulator"]);
    // If a specific device is requested, focus it by switching to it
    // --args -CurrentDeviceUDID only works on fresh launch; for already-running
    // Simulator, we activate the app which brings all device windows forward
    if (udid) {
      try {
        await this.execAsync("osascript", ["-e", 'tell application "Simulator" to activate']);
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Determine whether the current host can launch the Simulator GUI.
   *
   * Resolution order:
   *  1. `AUTOMOBILE_IOS_HEADLESS` env override (`true`/`1` => headless,
   *     `false`/`0` => force GUI launch).
   *  2. Non-darwin platforms are always headless (Simulator.app is macOS-only).
   *  3. Auto-detect via `launchctl managername`: an `Aqua` manager means a GUI
   *     login session; anything else (`System`/`Background`) is a daemon/SSH
   *     context with no GUI domain.
   *
   * If detection itself fails we assume a GUI session to preserve the prior
   * behavior. The result is cached so launchctl is probed at most once.
   */
  private async isHeadlessSession(): Promise<boolean> {
    const override = process.env.AUTOMOBILE_IOS_HEADLESS;
    if (override !== undefined) {
      return override === "true" || override === "1";
    }

    if (this.platform !== "darwin") {
      return true;
    }

    if (this.headlessSessionCache === null) {
      this.headlessSessionCache = await this.detectHeadlessSession();
    }
    return this.headlessSessionCache;
  }

  private async detectHeadlessSession(): Promise<boolean> {
    try {
      const result = await this.execAsync("launchctl", ["managername"]);
      const managerName = (result.stdout || "").trim();
      // "Aqua" is the GUI login session manager; "System"/"Background" are not.
      return managerName !== "Aqua";
    } catch (error) {
      // Can't determine the session type; assume a GUI session so we preserve
      // the historical behavior rather than silently suppressing the launch.
      logger.debug(`launchctl managername probe failed, assuming GUI session: ${error}`);
      return false;
    }
  }
}

// Backward compatibility export
export { SimCtlClient as Simctl };
