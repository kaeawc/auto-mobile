import type {
  HostChildProcess as ChildProcess,
  HostSpawnOptions as SpawnOptions,
} from "../HostCommandExecutor";
import { promises as fsPromises } from "fs";

import { runExecSeam } from "../ExecSeam";
import {
  DefaultHostCommandExecutor,
  execFileAsync as sharedExecFileAsync,
  type HostProcessExecutor,
} from "../HostCommandExecutor";
import { ExecResult, ActionableError, DeviceInfo, BootedDevice, ScreenSize } from "../../models";

import { isIosSimulatorUdid } from "./iosDeviceType";
import { iosVersionStringFromRuntimeId } from "./iosVersion";

import { Mutex } from "async-mutex";

import { compareSimctlVersions, parseSimctlVersion } from "./simctlVersion";

import { fixedBackoff } from "../Backoff";

import { type SimulatorDeviceTypeProfile } from "./SimulatorDeviceTypeProfiles";
import { type SimulatorDisplay } from "./SimulatorDisplays";

import { type TransitionalSimulator } from "../../models/TransitionalSimulator";

import { SimctlScreenshotError } from "./SimctlScreenshotError";

export const COMMAND_SETTLEMENT_GRACE_MS = 1_000;

export const SCREENSHOT_CLEANUP_BOUND_MS = 1_000;

export interface ScreenshotCaptureContext {
  signal: AbortSignal;
  abortFailure(cause?: unknown, exitCode?: number | null, stderr?: string): SimctlScreenshotError;
}

export const SIMCTL_AVAILABILITY_PROBE_TIMEOUT_MS = 10_000;

export const SIMCTL_COMMAND_TIMEOUT_MS = 60_000;

export const STATE_READ_RETRY_BACKOFF_MS = 250;

export const SHUTDOWN_SETTLE_MS = 10_000;

export const LAUNCHD_SIM_PROBE_TIMEOUT_MS = 2_000;

export const SHUTDOWN_SETTLE_BACKOFF = fixedBackoff(1_000);

export interface AppleDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  availabilityError?: string;
  deviceTypeIdentifier?: string;
  /** Device data directory size in bytes, as reported by `simctl list devices`. */
  dataPathSize?: number;
  /** CoreSimulator last boot/use stamp from `simctl list devices`. */
  lastUsedAt?: string;
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
  availabilityError?: string;
  name: string;
}

export interface AppleDeviceType {
  minRuntimeVersion: number;
  minRuntimeVersionString?: string;
  bundlePath: string;
  maxRuntimeVersion: number;
  maxRuntimeVersionString?: string;
  name: string;
  identifier: string;
  productFamily: string;
  modelIdentifier?: string;
}

/** One coherent host catalog snapshot for exact simulator specification checks. */
export interface SimCtlCatalog {
  runtimes: AppleDeviceRuntime[];
  deviceTypes: AppleDeviceType[];
}

export interface SimCtlFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFileBuffer(path: string): Promise<Buffer>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

export type SimctlScreenshotFailureReason =
  | "missing-output-file"
  | "read-failure"
  | "empty-output"
  | "non-image-output"
  | "aborted-by-caller"
  | "aborted-by-timeout"
  | "non-zero-exit";

export const defaultSimCtlFileSystem: SimCtlFileSystem = {
  mkdtemp: (prefix) => fsPromises.mkdtemp(prefix),
  writeFile: (path, data, encoding) => fsPromises.writeFile(path, data, encoding),
  readFile: (path, encoding) => fsPromises.readFile(path, encoding),
  readFileBuffer: (path) => fsPromises.readFile(path),
  rm: (path, options) => fsPromises.rm(path, options),
};

/**
 * Interface for iOS simulator control using simctl
 * Provides methods to manage and interact with iOS simulators
 */
export interface SimctlLaunchOptions {
  foregroundIfRunning?: boolean;
  launchArguments?: string[];
  /**
   * Environment for the launched app. Every key must carry the `SIMCTL_CHILD_` prefix: simctl
   * strips it and hands the rest to the app process. Merged over the host environment for this
   * one `simctl launch`, so a host-level `SIMCTL_CHILD_*` value is replaced, not combined.
   */
  environment?: Record<string, string>;
}

export function launchEnvironment(
  environment: Record<string, string> | undefined,
): NodeJS.ProcessEnv | undefined {
  if (environment === undefined || Object.keys(environment).length === 0) {
    return undefined;
  }
  const invalid = Object.keys(environment).filter((key) => !key.startsWith("SIMCTL_CHILD_"));
  if (invalid.length > 0) {
    throw new ActionableError(
      `simctl launch environment keys must start with SIMCTL_CHILD_: ${invalid.join(", ")}`,
    );
  }
  return { ...process.env, ...environment };
}

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
  isAvailable(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<boolean>;

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
  killSimulator(
    device: BootedDevice,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;

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
  listSimulatorImages(
    timeoutMs?: number,
    options?: { bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<DeviceInfo[]>;

  /** Fresh raw device row, without enrichment or caching; absent/ambiguous UDIDs return undefined. */
  readSimulatorTarget(
    udid: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AppleDevice | undefined>;

  /**
   * Get the list of booted simulator UDIDs
   * @returns Promise with an array of booted devices
   */
  getBootedSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<BootedDevice[]>;

  /** List booted simulators without swallowing discovery failures. */
  getBootedSimulatorsChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options?: { bypassCache?: boolean; maxCacheAgeMs?: number },
  ): Promise<BootedDevice[]>;

  /**
   * {@link getBootedSimulatorsChecked} plus the simulators `simctl` reports `Booting` or
   * `Shutting Down` (#11573). Optional: fakes that only model booted devices omit it.
   */
  getSimulatorListingChecked?(
    timeoutMs?: number,
    signal?: AbortSignal,
    options?: { bypassCache?: boolean; maxCacheAgeMs?: number },
  ): Promise<{ booted: BootedDevice[]; transitional: TransitionalSimulator[] }>;

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
  getRuntimes(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]>;

  /** List runtimes without swallowing malformed output. */
  getRuntimesChecked(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]>;

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
  deleteSimulator(
    udid: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;

  /**
   * List all installed apps on the simulator
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with array of app objects
   */
  listApps(deviceId?: string): Promise<any[]>;

  /**
   * Launch an app on the simulator
   * @param bundleId - The bundle identifier of the app to launch
   * @param options - Launch options
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with launch result containing success status and optional PID
   */
  launchApp(
    bundleId: string,
    options?: SimctlLaunchOptions,
    deviceId?: string,
  ): Promise<{
    success: boolean;
    pid?: number;
    error?: string;
  }>;

  /**
   * Terminate an app on the simulator
   * @param bundleId - The bundle identifier of the app to terminate
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise that resolves when termination is complete
   */
  terminateApp(
    bundleId: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;

  /**
   * Install an app on the simulator
   * @param appPath - Path to the .app bundle
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @param options - `timeoutMs` is the explicit bound for this install (it kills the child). Without
   *   one, the default command budget applies. `signal` cancels earlier.
   */
  installApp(
    appPath: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;

  /**
   * Uninstall an app from the simulator
   * @param bundleId - The bundle identifier of the app to uninstall
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @param options - `timeoutMs` kills the child and rejects with a SimctlCommandTimeoutError;
   *   `signal` kills it on cancellation. Without a `timeoutMs` the default command budget applies.
   */
  uninstallApp(
    bundleId: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;

  /**
   * Get the screen size of the simulator
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @param timeoutMs - Optional command timeout in milliseconds
   * @returns Promise with screen dimensions
   */
  getScreenSize(deviceId?: string, timeoutMs?: number): Promise<ScreenSize>;
  enumerateDisplays(
    deviceId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SimulatorDisplay[]>;
  screenshot(deviceId: string, display: string, signal?: AbortSignal): Promise<Buffer>;

  /**
   * Set the simulator appearance
   * @param mode - Appearance mode ("light" or "dark")
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   */
  setAppearance(mode: "light" | "dark", deviceId?: string): Promise<void>;

  /**
   * Open Simulator.app. If udid is provided, focuses that specific device window.
   * With multiple simulators booted, this ensures the right device is visible.
   * @param udid - Optional device UDID to focus
   * @returns true if the GUI launch was performed, false if this host has no Aqua session.
   */
  openSimulatorApp(udid?: string, signal?: AbortSignal): Promise<boolean>;
  /** Report a simulator boot completed by this process. Never call from readiness checks. */
  presentSimulatorAfterStart(
    udid: string,
    bootGeneration: string,
    signal?: AbortSignal,
  ): Promise<void>;

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

export const execAsync = async (
  file: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> => {
  return runExecSeam(
    (execOptions) => sharedExecFileAsync(file, args, execOptions),
    { maxBuffer, signal, env },
    { command: file, args },
    { preserveError: true },
  );
};

export const hostProcessExecutor: HostProcessExecutor = new DefaultHostCommandExecutor();

export function defaultSpawnProcess(
  command: string,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  return hostProcessExecutor.spawn(command, args, options);
}

export function splitCommandArgs(command: string): string[] {
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

export function normalizeIosVersion(
  runtimeId: string | undefined,
  osVersion: string | undefined,
): string | undefined {
  const trimmedOsVersion = osVersion?.trim();
  if (trimmedOsVersion) {
    return trimmedOsVersion;
  }

  return iosVersionStringFromRuntimeId(runtimeId);
}

export function compareVersions(a: string, b: string): number {
  const left = parseSimctlVersion(a);
  const right = parseSimctlVersion(b);
  return left && right ? compareSimctlVersions(left, right) : Number.NaN;
}

export function pickHighestRuntime(
  runtimes: AppleDeviceRuntime[],
  prefix: string,
): AppleDeviceRuntime | undefined {
  const componentPrefix = prefix.replace(/\.+$/, "");
  return runtimes
    .filter(
      (runtime) =>
        typeof runtime.version === "string" &&
        (runtime.version === componentPrefix || runtime.version.startsWith(`${componentPrefix}.`)),
    )
    .sort((a, b) => compareVersions(a.version, b.version))
    .pop();
}

export function isDeviceAvailable(device: { isAvailable?: boolean }): boolean {
  return device.isAvailable !== false;
}

export const CORE_SIMULATOR_405_CURRENT_STATE_PATTERN =
  /Unable to boot device in current state: (.+?)(?:\s*\(domain=|\s*$)/m;

export function parseAlreadyBootedCoreSimulator405State(
  error: unknown,
  udid: string,
): string | undefined {
  if (!isIosSimulatorUdid(udid) || !(error instanceof Error)) {
    return undefined;
  }

  const execError = error as NodeJS.ErrnoException & { stderr?: unknown };
  const stderr =
    typeof execError.stderr === "string"
      ? execError.stderr
      : Buffer.isBuffer(execError.stderr)
        ? execError.stderr.toString()
        : "";

  if (
    typeof execError.code !== "number" ||
    execError.code === 0 ||
    !stderr.includes("domain=com.apple.CoreSimulator.SimError, code=405")
  ) {
    return undefined;
  }

  const match = CORE_SIMULATOR_405_CURRENT_STATE_PATTERN.exec(stderr);
  return match?.[1]?.trim();
}

export interface SimulatorList {
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

export interface SimulatorBootState {
  mutex: Mutex;
  lastBootSucceeded: boolean;
  ownerToken: object | undefined;
}

export interface SimulatorBootLease {
  state: SimulatorBootState;
  release(): void;
}

export function simulatorModel(
  model: string | undefined,
  profile: SimulatorDeviceTypeProfile | null,
): string | undefined {
  return model ?? profile?.modelIdentifier ?? undefined;
}

/** The single raw row for a UDID across runtimes; absent or ambiguous UDIDs return undefined. */
export function findUniqueSimulatorRow(
  listing: SimulatorList,
  udid: string,
): AppleDevice | undefined {
  const rows = Object.entries(listing.devices).flatMap(([runtime, devices]) =>
    devices.filter((device) => device.udid === udid).map((device) => ({ ...device, runtime })),
  );
  return rows.length === 1 ? rows[0] : undefined;
}
