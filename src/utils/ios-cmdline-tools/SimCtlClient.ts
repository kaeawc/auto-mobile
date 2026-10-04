import { detectImageMimeType } from "../screenshot/imageHeaderDimensions";
import { errorMessage } from "../describeUnknownError";
import { trackAmbient } from "../PerfContext";
import type {
  HostChildProcess as ChildProcess,
  HostSpawnOptions as SpawnOptions,
} from "../HostCommandExecutor";
import { promises as fsPromises } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { logger } from "../logger";
import { runExecSeam } from "../ExecSeam";
import {
  DefaultHostCommandExecutor,
  execFileAsync as sharedExecFileAsync,
  type HostProcessExecutor,
} from "../HostCommandExecutor";
import { ExecResult, ActionableError, DeviceInfo, BootedDevice, ScreenSize } from "../../models";
import { defaultTimer, Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import {
  defaultDiscoveryObservationSequence,
  type DiscoveryObservationSequence,
} from "../DiscoveryObservationSequence";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  SIMULATOR_SHUTDOWN_LEASE_WAIT_TIMEOUT_MS,
} from "../deviceTimeouts";
import { PlistClient, type PlistReader } from "./PlistClient";
import { inferIosFormFactor, isIosSimulatorUdid } from "./iosDeviceType";
import { iosVersionStringFromRuntimeId } from "./iosVersion";
import { getAbortSignal, runWithAbortSignal } from "../AbortContext";
import { Mutex } from "async-mutex";
import { iosSimulatorCapabilityInventory } from "../../models/virtualDeviceCapabilities";
import { compareSimctlVersions, parseSimctlVersion } from "./simctlVersion";
import { compareStrictNumericVersions } from "../deviceMatcher";
import { defaultIdGenerator, type IdGenerator } from "../IdGenerator";
import { fixedBackoff } from "../Backoff";
import { DefaultSimulatorAppPresenter, type SimulatorAppPresenter } from "./SimulatorAppPresenter";
import {
  SimCtlSimulatorDeviceTypeProfiles,
  type SimulatorDeviceTypeProfile,
  type SimulatorDeviceTypeProfileSource,
} from "./SimulatorDeviceTypeProfiles";
import {
  parseSimulatorDisplays,
  simulatorDeviceDisplays,
  type SimulatorDisplay,
} from "./SimulatorDisplays";
import type { DeviceDisplays } from "../../models/DisplayPanel";

const COMMAND_SETTLEMENT_GRACE_MS = 1_000;
const SCREENSHOT_CLEANUP_BOUND_MS = 1_000;

interface ScreenshotCaptureContext {
  signal: AbortSignal;
  abortFailure(cause?: unknown, exitCode?: number | null, stderr?: string): SimctlScreenshotError;
}
const SIMCTL_AVAILABILITY_PROBE_TIMEOUT_MS = 10_000;
const SIMCTL_COMMAND_TIMEOUT_MS = 60_000;
/**
 * Backoff between retried `simctl list devices --json` reads when boot
 * verification cannot trust a single failed read (issue #6411). Small and
 * fixed: the read itself is cheap, so this only needs to avoid hammering a
 * wedged `simctl`, not model a real device-state transition.
 */
const STATE_READ_RETRY_BACKOFF_MS = 250;
const SHUTDOWN_SETTLE_MS = 10_000;
const SHUTDOWN_SETTLE_BACKOFF = fixedBackoff(1_000);

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

export class SimctlScreenshotError extends Error {
  readonly reason: SimctlScreenshotFailureReason;
  readonly exitCode: number | null;
  readonly stderrExcerpt: string;
  readonly byteLength: number;

  constructor(
    reason: SimctlScreenshotFailureReason,
    message: string,
    options: {
      exitCode?: number | null;
      stderr?: string;
      byteLength?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SimctlScreenshotError";
    this.reason = reason;
    this.exitCode = options.exitCode ?? null;
    this.stderrExcerpt = (options.stderr ?? "").slice(0, 300);
    this.byteLength = options.byteLength ?? 0;
  }
}

const defaultSimCtlFileSystem: SimCtlFileSystem = {
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

  /**
   * Get the list of booted simulator UDIDs
   * @returns Promise with an array of booted devices
   */
  getBootedSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<BootedDevice[]>;

  /** List booted simulators without swallowing discovery failures. */
  getBootedSimulatorsChecked(timeoutMs?: number, signal?: AbortSignal): Promise<BootedDevice[]>;

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
    options?: { foregroundIfRunning?: boolean; launchArguments?: string[] },
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
  terminateApp(bundleId: string, deviceId?: string): Promise<void>;

  /**
   * Install an app on the simulator
   * @param appPath - Path to the .app bundle
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   */
  installApp(appPath: string, deviceId?: string): Promise<void>;

  /**
   * Uninstall an app from the simulator
   * @param bundleId - The bundle identifier of the app to uninstall
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   */
  uninstallApp(bundleId: string, deviceId?: string): Promise<void>;

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

// Route the execFile leg through the shared exec seam (issue #5459) so the
// option mapping and the Buffer→string / trim / includes coercion live in one
// place and this client no longer imports `child_process` for its exec path.
//
// `preserveError: true` keeps the raw execFile rejection intact: the seam's
// default `wrapCommandError` path returns a fresh Error copying only `.name`,
// but CoreSimulator-405 boot recovery (issue #3938 / #4092) branches on the
// original error's `.code`/`.stderr` via `parseAlreadyBootedCoreSimulator405State`.
//
// The AbortSignal is forwarded so that when a caller's timeout aborts, Node kills
// the child process (SIGTERM) instead of leaving it booting orphaned (issue
// #3938) — without this a timed-out `bootstatus -b` keeps booting the simulator
// in the background after the tool has already reported failure.
const execAsync = async (
  file: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal,
): Promise<ExecResult> => {
  return runExecSeam(
    (execOptions) => sharedExecFileAsync(file, args, execOptions),
    { maxBuffer, signal },
    { command: file, args },
    { preserveError: true },
  );
};

// Route the default long-lived spawn through the shared host-process seam so the
// client no longer reaches for `child_process.spawn` directly (issue #5459). The
// executor's `spawn` is a plain passthrough that already defaults `options` to
// `{}`, so this is behavior-identical; SimCtlClient keeps its own timeout/abort
// orchestration and the injected `spawnProcess` test seam.
const hostProcessExecutor: HostProcessExecutor = new DefaultHostCommandExecutor();

function defaultSpawnProcess(
  command: string,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  return hostProcessExecutor.spawn(command, args, options);
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

  return iosVersionStringFromRuntimeId(runtimeId);
}

/** Numeric, component-wise comparison of dotted version strings. */
function compareVersions(a: string, b: string): number {
  const left = parseSimctlVersion(a);
  const right = parseSimctlVersion(b);
  return left && right ? compareSimctlVersions(left, right) : Number.NaN;
}

/** Highest-versioned runtime whose dotted version starts with complete components from `prefix`. */
function pickHighestRuntime(
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

/**
 * Shared simctl availability convention (issue #6412): a device record whose
 * `isAvailable` field is explicitly `false` is unavailable; missing/undefined
 * (an unvalidated `JSON.parse` cast can drop the field) is treated as
 * available. Matches the runtime convention already used for
 * `AppleDeviceRuntime.isAvailable` above. Every booted-device lookup in this
 * file must route through this predicate so a boot's post-condition cannot
 * drift between listings again.
 */
function isDeviceAvailable(device: { isAvailable?: boolean }): boolean {
  return device.isAvailable !== false;
}

// The state capture is non-greedy and stops at either an inline
// " (domain=...)" clause or end of line, because CoreSimulator emits the
// domain/code both *before* the sentence ("...(domain=..., code=405): Unable
// to boot device in current state: Booted") and *appended inline after* the
// state ("...current state: Booted (domain=..., code=405)"). A greedy capture
// folded that trailing clause into the state, so it no longer equalled the bare
// state token (e.g. "Booted") and the rejection was misclassified (issue #6411).
const CORE_SIMULATOR_405_CURRENT_STATE_PATTERN =
  /Unable to boot device in current state: (.+?)(?:\s*\(domain=|\s*$)/m;

/**
 * Parse the current-state CoreSimulator 405 rejection (`Unable to boot
 * device in current state: <state>`) out of a `bootstatus` failure, or
 * `undefined` if the error is not that specific, structured CoreSimulator
 * error. Widened from a single literal (`Booted`) so `bootAndVerify` can
 * branch per reported state (issue #6411) rather than only tolerating one.
 */
function parseAlreadyBootedCoreSimulator405State(error: unknown, udid: string): string | undefined {
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

function simulatorModel(
  model: string | undefined,
  profile: SimulatorDeviceTypeProfile | null,
): string | undefined {
  return model ?? profile?.modelIdentifier ?? undefined;
}

export class SimCtlClient implements SimCtl {
  private readonly deviceTypeProfiles: SimulatorDeviceTypeProfileSource;
  private readonly hostArchitecture = process.arch;
  device: BootedDevice | null;
  execAsync: (
    file: string,
    args: string[],
    maxBuffer?: number,
    signal?: AbortSignal,
  ) => Promise<ExecResult>;
  private timer: Timer;
  private platform: NodeJS.Platform;
  private readonly spawnProcess: (
    command: string,
    args: string[],
    options?: SpawnOptions,
  ) => ChildProcess;
  private readonly fileSystem: SimCtlFileSystem;
  private readonly bootOptions: SimCtlBootOptions;
  private readonly simulatorAppPresenter: SimulatorAppPresenter;
  private readonly idGenerator: IdGenerator;
  private static readonly bootPresentationGenerations = new Map<string, string>();
  private static readonly simulatorAppPresentations = new Map<
    string,
    { bootGeneration: string; presentation: Promise<void> }
  >();
  // Cached result of the launchctl headless-session probe (null = not yet probed).
  // Re-probed after HEADLESS_SESSION_CACHE_TTL so a GUI login/logout mid-process
  // (e.g. an SSH session that later gains a GUI, or vice versa) does not leave a
  // stale answer cached for the process lifetime (issue #6372).
  private headlessSessionCache: boolean | null = null;
  private headlessSessionCacheTimestamp = 0;
  private headlessSessionProbeSequence = 0;
  private static readonly HEADLESS_SESSION_CACHE_TTL = 30_000; // 30 seconds

  // Static cache for device list
  private static deviceListCache: { devices: DeviceInfo[]; timestamp: number } | null = null;
  private static readonly DEVICE_LIST_CACHE_TTL = 5000; // 5 seconds
  // Last-known-good device list, retained past a failed listing so a transient
  // `simctl` error degrades to a stale-but-usable snapshot instead of throwing
  // (issue #6576), mirroring DevicectlDeviceLister.lastGood.
  private static lastGoodDeviceList: { devices: DeviceInfo[]; timestamp: number } | null = null;
  private static readonly LAST_GOOD_DEVICE_LIST_RETENTION_MS = 60_000;
  // Concurrent cold/expired-cache callers share one `simctl list devices`
  // invocation rather than each spawning their own process (issue #6576).
  private static inFlightDeviceList: Promise<DeviceInfo[]> | null = null;
  // Ceiling on the SHARED `simctl list devices` invocation behind
  // inFlightDeviceList. Deliberately NOT any individual caller's timeoutMs --
  // that would let one bounded/aborted caller cut the read short (or, before
  // this fix, extend it) for every other waiter sharing the same promise.
  // Mirrors DevicectlDeviceLister.DEVICE_LIST_TIMEOUT_MS; each waiter instead
  // races the shared result against its OWN deadline/signal (issue #6576).
  private static readonly SHARED_DEVICE_LIST_TIMEOUT_MS = 15_000;
  // Invalidation epoch. A listing started in an older epoch must not
  // repopulate the cache/last-good snapshot after a create/delete/reset.
  private static deviceListGeneration = 0;
  // Physical listing order is distinct from invalidation. Only successful
  // reads advance the recorded sequence, so a failed newer refresh does not
  // discard an older flight's usable result; once a newer read succeeds, an
  // older completion cannot overwrite it.
  private static deviceListRequestSequence = 0;
  private static recordedDeviceListRequestSequence = 0;
  private static inFlightDeviceListRequestSequence: number | null = null;
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
    private readonly observationSequence: DiscoveryObservationSequence = defaultDiscoveryObservationSequence,
    deviceTypeProfiles?: SimulatorDeviceTypeProfileSource,
    simulatorAppPresenter?: SimulatorAppPresenter,
    idGenerator?: IdGenerator,
  ) {
    this.device = device;
    this.execAsync = execAsyncFn || execAsync;
    this.timer = timer;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.fileSystem = fileSystem;
    this.deviceTypeProfiles = deviceTypeProfiles ?? new SimCtlSimulatorDeviceTypeProfiles(this);
    this.simulatorAppPresenter = this.resolveSimulatorAppPresenter(simulatorAppPresenter);
    this.idGenerator = this.resolveIdGenerator(idGenerator);
    this.bootOptions = {
      maxAttempts: Math.max(1, bootOptions.maxAttempts),
      retryBackoffMs: Math.max(0, bootOptions.retryBackoffMs),
    };
  }

  private resolveSimulatorAppPresenter(presenter?: SimulatorAppPresenter): SimulatorAppPresenter {
    return (
      presenter ??
      new DefaultSimulatorAppPresenter(
        (udid) => this.openSimulatorAppBounded(udid),
        SimCtlClient.simulatorAppPresentations,
      )
    );
  }

  private resolveIdGenerator(generator?: IdGenerator): IdGenerator {
    return generator ?? defaultIdGenerator;
  }

  private async openSimulatorAppBounded(udid: string): Promise<boolean> {
    const controller = new AbortController();
    return await raceWithDeadline(this.openSimulatorApp(udid, controller.signal), {
      timer: this.timer,
      timeoutMs: 1_000,
      label: "Simulator.app open",
      timeoutError: () => new Error(`Timed out opening Simulator.app for ${udid}`),
      onTimeout: () => controller.abort(),
    });
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
    return this.executeCommandArgv(
      hostArgs,
      timeoutMs ?? ((signal ?? getAbortSignal()) ? undefined : SIMCTL_COMMAND_TIMEOUT_MS),
      command,
      signal,
    );
  }

  async executeCommandArgs(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    return this.executeCommandArgv(
      args,
      timeoutMs ?? ((signal ?? getAbortSignal()) ? undefined : SIMCTL_COMMAND_TIMEOUT_MS),
      args.join(" "),
      signal,
    );
  }

  async startCommandArgs(args: string[], options?: SpawnOptions): Promise<ChildProcess> {
    if (args.length === 0) {
      throw new Error("Command cannot be empty");
    }

    const fullArgs = ["simctl", ...args];
    logger.debug(`[iOS] Starting command: xcrun ${fullArgs.join(" ")}`);
    return this.spawnProcess("xcrun", fullArgs, options);
  }

  private executeCommandArgv(
    args: string[],
    timeoutMs?: number,
    displayCommand?: string,
    explicitSignal?: AbortSignal,
    waitForTimedOutCommandSettlement = false,
  ): Promise<ExecResult> {
    // One span per simctl invocation, named by the leading subcommand so spans
    // aggregate (e.g. `simctl boot`), recorded against the ambient
    // device-lifecycle tracker when one is in scope (see PerfContext).
    return trackAmbient(`simctl ${args[0] ?? ""}`.trimEnd(), () =>
      this.executeCommandArgvInner(
        args,
        timeoutMs,
        displayCommand,
        explicitSignal,
        waitForTimedOutCommandSettlement,
      ),
    );
  }

  private async executeCommandArgvInner(
    args: string[],
    timeoutMs?: number,
    displayCommand?: string,
    explicitSignal?: AbortSignal,
    waitForTimedOutCommandSettlement = false,
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

    const callerSignal = explicitSignal ?? getAbortSignal();
    const runCommand = async (signal?: AbortSignal) => {
      try {
        return await this.execAsync("xcrun", localArgs, undefined, signal);
      } catch (error) {
        const tokenIndex = args.indexOf("--automobile-mutation-token");
        const token = tokenIndex >= 0 ? args[tokenIndex + 1] : undefined;
        if (!token) {
          throw error;
        }
        throw new ActionableError(errorMessage(error).split(token).join("[REDACTED]"));
      }
    };

    // On timeout we abort the
    // controller so the underlying child process is killed rather than left
    // running orphaned (issue #3938).
    if (timeoutMs) {
      let timeoutError: Error | undefined;
      let runPromise: Promise<ExecResult> | undefined;
      const controller = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;

      try {
        runPromise = runCommand(signal);
        const result = await raceWithDeadline(runPromise, {
          timer: this.timer,
          timeoutMs,
          label: "simctl command",
          timeoutError: () =>
            (timeoutError = new Error(`Command timed out after ${timeoutMs}ms: ${fullCommand}`)),
          onTimeout: () => controller.abort(timeoutError),
        });
        const duration = this.timer.now() - startTime;
        logger.debug(`[iOS] Command completed in ${duration}ms: ${command}`);
        return result;
      } catch (error) {
        if (waitForTimedOutCommandSettlement && runPromise && error === timeoutError) {
          await this.waitForCommandSettlement(runPromise, command);
        }
        const commandError = this.toActionableSimctlUnavailableError(error);
        const duration = this.timer.now() - startTime;
        logger.warn(
          `[iOS] Command failed after ${duration}ms: ${command} - ${errorMessage(commandError)}`,
        );
        throw commandError;
      }
    }

    // No timeout specified
    try {
      const result = await runCommand(callerSignal);
      const duration = this.timer.now() - startTime;
      logger.debug(`[iOS] Command completed in ${duration}ms: ${command}`);
      return result;
    } catch (error) {
      const commandError = this.toActionableSimctlUnavailableError(error);
      const duration = this.timer.now() - startTime;
      logger.warn(
        `[iOS] Command failed after ${duration}ms: ${command} - ${errorMessage(commandError)}`,
      );
      throw commandError;
    }
  }

  private async waitForCommandSettlement(
    runPromise: Promise<ExecResult>,
    command: string,
  ): Promise<void> {
    let settlementTimedOut = false;
    const timeout = new Error("simctl command settlement grace expired");
    try {
      await raceWithDeadline(
        runPromise.then(
          () => undefined,
          () => undefined,
        ),
        {
          timer: this.timer,
          timeoutMs: COMMAND_SETTLEMENT_GRACE_MS,
          label: "simctl command settlement",
          timeoutError: () => timeout,
          onTimeout: () => {
            settlementTimedOut = true;
          },
        },
      );
    } catch (error) {
      if (error !== timeout) {
        throw error;
      }
    }
    if (settlementTimedOut) {
      logger.warn(
        `[iOS] Command did not settle within ${COMMAND_SETTLEMENT_GRACE_MS}ms after termination: ${command}`,
      );
    }
  }

  /**
   * Check if simctl is available
   * @returns Promise with boolean indicating availability
   */
  async isAvailable(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<boolean> {
    return this.isLocalSimctlAvailable(options);
  }

  private async isLocalSimctlAvailable(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const controller = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const probe = this.execAsync("xcrun", ["--find", "simctl"], undefined, signal);
    try {
      return await raceWithDeadline(
        probe.then(
          () => true,
          () => false,
        ),
        {
          timer: this.timer,
          timeoutMs: options?.timeoutMs ?? SIMCTL_AVAILABILITY_PROBE_TIMEOUT_MS,
          label: "simctl availability",
          onTimeout: () => controller.abort(),
        },
      );
    } catch (error) {
      logger.debug(`src/utils/ios-cmdline-tools/SimCtlClient.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  private toActionableSimctlUnavailableError(error: unknown): unknown {
    const detail = errorMessage(error);
    if (
      !/(?:unable to find utility ["']?simctl|active developer path .* does not exist|xcode-select: error|command not found: xcrun|spawn xcrun ENOENT)/i.test(
        detail,
      )
    ) {
      return error;
    }
    const message =
      this.platform === "darwin"
        ? `simctl is not available. Please install Xcode command line tools to continue. ${detail}`
        : "iOS simulator tooling is only available on macOS.";
    return new ActionableError(message);
  }

  /**
   * Get the list of all simulators and devices
   * @returns Promise with simulator list data
   */
  private async listSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<SimulatorList> {
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("simctlListDevices");
    const result = await this.executeCommandArgs(["list", "devices", "--json"], timeoutMs, signal);
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
          await this.getBootedSimulatorsChecked(
            this.remainingBootTimeoutMs(udid, deadlineMs),
            undefined,
            { bypassCache: true },
          )
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
      SimCtlClient.bootPresentationGenerations.delete(udid);
      await this.runOwnedBoot(udid, () => this.bootAndVerify(udid, deadlineMs));
    } finally {
      perf.endOperation("bootstatus");
    }

    await this.waitForPresentationAfterStart(
      udid,
      this.idGenerator.next(),
      deadlineMs,
      startSignal,
    );
    if (startSignal?.aborted) {
      await this.shutdownAfterFailedStart(udid);
      throw startSignal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`);
    }
  }

  private async waitForPresentationAfterStart(
    udid: string,
    bootGeneration: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const remainingMs = Math.min(1_000, deadlineMs - this.timer.now());
    if (remainingMs <= 0 || signal?.aborted) {
      return;
    }
    const presentation = this.presentSimulatorAfterStart(udid, bootGeneration);

    const timeout = new Error("Simulator presentation deadline expired");
    try {
      await raceWithDeadline(presentation, {
        timer: this.timer,
        timeoutMs: remainingMs,
        signal,
        label: "Simulator presentation",
        timeoutError: () => timeout,
      });
    } catch (error) {
      if (error !== timeout && !signal?.aborted) {
        throw error;
      }
    }
  }

  async presentSimulatorAfterStart(
    udid: string,
    bootGeneration: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    try {
      if (signal) {
        await this.waitForPresentationAfterStart(
          udid,
          bootGeneration,
          this.timer.now() + 1_000,
          signal,
        );
        return;
      }
      const generation = SimCtlClient.bootPresentationGenerations.get(udid) ?? bootGeneration;
      SimCtlClient.bootPresentationGenerations.set(udid, generation);
      await this.simulatorAppPresenter.presentAfterStart(udid, generation);
    } catch (error) {
      // The presenter warns on GUI launch failure; unexpected errors cannot fail a start.
      logger.debug(`Could not present Simulator.app for ${udid}: ${error}`);
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
          await this.getBootedSimulatorsChecked(
            this.remainingBootTimeoutMs(udid, deadlineMs),
            undefined,
            { bypassCache: true },
          )
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
    operation: "start" | "shut down" = "start",
  ): Promise<SimulatorBootLease> {
    if (signal?.aborted) {
      throw signal.reason ?? new ActionableError(`iOS simulator ${operation} aborted for ${udid}`);
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

    let acquired = false;
    try {
      const release = await raceWithDeadline(acquirePromise, {
        timer: this.timer,
        timeoutMs:
          deadlineMs === undefined ? undefined : Math.max(0, deadlineMs - this.timer.now()),
        signal,
        label: `iOS simulator ${operation}`,
        timeoutError: () => new Error(`Timed out waiting to ${operation} iOS simulator ${udid}`),
      });
      acquired = true;
      acquiredRelease = undefined;
      return {
        state,
        release: () => this.releaseSimulatorBoot(udid, state, release),
      };
    } finally {
      abandoned = !acquired;
      if (acquiredRelease) {
        const release = acquiredRelease;
        acquiredRelease = undefined;
        this.releaseSimulatorBoot(udid, state, release);
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
      SimCtlClient.invalidateDeviceListCache();
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
    // timeout, so the queue wait gets its own dedicated deadline instead of
    // `timeoutMs`. That deadline is still a hard ceiling, independent of
    // `signal`: callers with no ambient abort signal (CI boot recovery, a boot
    // handle's cleanup) must not queue forever behind a wedged boot (issue #6577).
    // Once the lease is acquired, simctl shutdown receives the complete timeoutMs budget.
    const leaseDeadlineMs = this.timer.now() + SIMULATOR_SHUTDOWN_LEASE_WAIT_TIMEOUT_MS;
    const lease = await this.acquireSimulatorBoot(udid, leaseDeadlineMs, signal, "shut down");
    try {
      if (
        expectedOwnerToken !== undefined &&
        (!lease.state.lastBootSucceeded || lease.state.ownerToken !== expectedOwnerToken)
      ) {
        return;
      }
      await this.executeCommandArgv(
        ["shutdown", udid],
        timeoutMs,
        `shutdown ${udid}`,
        signal,
        true,
      );
      SimCtlClient.invalidateDeviceListCache();
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
    const signal = options.signal ?? getAbortSignal();
    await this.shutdownSimulatorCoordinated(device.deviceId, options.timeoutMs ?? 10_000, signal);
    await this.verifyShutdownSettled(device, signal);
  }

  private async verifyShutdownSettled(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    const deadlineMs = this.timer.now() + SHUTDOWN_SETTLE_MS;
    let state: string | undefined;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      const remainingMs = deadlineMs - this.timer.now();
      if (remainingMs <= 0) {
        if (state !== "Shutdown") {
          throw new ActionableError(
            `iOS simulator '${device.name}' did not remain Shutdown after shutdown (state: ${state ?? "unknown"}).`,
          );
        }
        return;
      }
      try {
        state = await this.readSimulatorState(device.deviceId, remainingMs);
      } catch (error) {
        signal?.throwIfAborted();
        if (
          state !== "Shutdown" ||
          deadlineMs - this.timer.now() > SHUTDOWN_SETTLE_BACKOFF.delayForAttempt(attempt)
        ) {
          throw error;
        }
        // The final probe may exhaust its budget; the last successful read already confirmed Shutdown.
        logger.debug(
          `[iOS] Keeping confirmed Shutdown for ${device.deviceId} after late state read failed: ${errorMessage(error)}`,
        );
      }
      if (state === "Booted") {
        throw await this.revivedSimulatorError(device, signal);
      }
      await this.timer.sleep(
        Math.min(
          SHUTDOWN_SETTLE_BACKOFF.delayForAttempt(attempt),
          Math.max(0, deadlineMs - this.timer.now()),
        ),
      );
    }
  }

  private async revivedSimulatorError(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<ActionableError> {
    let deviceHubRunning = false;
    try {
      // DeviceHub.app runs DevicesTrampoline, so match the app path instead of its executable name.
      const result = await this.execAsync(
        "pgrep",
        ["-f", "/DeviceHub.app/Contents/"],
        undefined,
        signal,
      );
      deviceHubRunning = /^\d+$/m.test(result.stdout.trim());
    } catch (error) {
      // pgrep exits 1 when Device Hub is not running.
      logger.debug(`[iOS] Device Hub process probe found no process: ${errorMessage(error)}`);
    }
    return new ActionableError(
      `iOS simulator '${device.name}' was revived after shutdown.` +
        (deviceHubRunning
          ? " Device Hub is running; close Device Hub or stop displaying this device, then try again."
          : " Close the application displaying this device, then try again."),
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
    const deadlineMs = this.bootDeadline(timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS);
    perf.startOperation("bootstatus");
    try {
      // The cold-boot path passes `assumeBooted`: startSimulator already ran
      // `bootstatus -b` (which throws on failure/timeout), so the device is
      // already fully booted. Re-running the wait here would be a redundant second
      // boot wait with its own independent timeout budget (issue #3938 follow-up),
      // so skip straight to metadata resolution.
      if (options?.assumeBooted) {
        return await this.runCoordinatedBoot(udid, deadlineMs, getAbortSignal(), false, () =>
          this.resolveReadySimulator(udid, this.remainingBootTimeoutMs(udid, deadlineMs)),
        );
      }

      // Use `simctl bootstatus -b` which blocks until the simulator is fully
      // booted (data migration complete, system app ready, springboard launched).
      // This is far more reliable than polling `simctl list devices` for state.
      return await this.runCoordinatedBoot(udid, deadlineMs, getAbortSignal(), false, async () => {
        await this.bootAndVerify(udid, deadlineMs);
        return this.resolveReadySimulator(udid, this.remainingBootTimeoutMs(udid, deadlineMs));
      });
    } catch (error) {
      throw this.classifyBootReadinessError(udid, error);
    } finally {
      perf.endOperation("bootstatus");
    }
  }

  /**
   * Reclassify any error surfaced while waiting for a simulator to become
   * ready (both the `assumeBooted` and full-verification paths) into an
   * `ActionableError` naming the UDID. This is the single site that gives the
   * boot-deadline-expired condition (and any other failure reaching either
   * path) one consistent, actionable shape (issue #6413).
   */
  private classifyBootReadinessError(udid: string, error: unknown): ActionableError {
    const message = errorMessage(error);
    // "Invalid device" means the UDID doesn't exist at all
    if (message.includes("Invalid device")) {
      return new ActionableError(`Simulator with UDID ${udid} not found`);
    }
    return new ActionableError(`Simulator with UDID ${udid} failed to become ready: ${message}`);
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
          this.remainingBootTimeoutMs(udid, deadlineMs),
        );
      } catch (error) {
        if (await this.handleBootstatusRejection(error, udid, deadlineMs, retryBackoffMs)) {
          // A mid-transition 405 was waited out; re-issue bootstatus within
          // this same attempt rather than burning a retry (issue #6411).
          attempt--;
          continue;
        }
        bootstatusReportedAlreadyBooted = true;
      }

      // A failed or absent state read is not evidence of a failed boot — it
      // means discovery itself is unreliable right now. Retry the read (bounded
      // by the deadline) rather than treating "unknown" the same as "not
      // Booted" and tearing a possibly-healthy simulator back down (#6411).
      const state = await this.readSimulatorStateRetrying(udid, deadlineMs);
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
            this.remainingBootTimeoutMs(udid, deadlineMs),
          );
        } catch (error) {
          logger.debug(`[iOS] shutdown before boot retry failed for ${udid}: ${error}`);
        }
        // Wait for the shutdown to actually take hold before re-issuing
        // bootstatus, instead of a fixed sleep: `simctl shutdown` returns before
        // the device leaves `Shutting Down`, and re-booting into that in-flight
        // transition is what produces the very 405 handled above (#6411).
        await this.waitForSimulatorSettled(udid, deadlineMs, retryBackoffMs);
      }
    }

    throw new ActionableError(
      `Simulator ${udid} did not reach the Booted state after ${maxAttempts} boot attempt(s): ${lastFailure}. ` +
        "The simulator is likely wedged. Try 'xcrun simctl shutdown all' (or erase the device with " +
        `'xcrun simctl erase ${udid}') and start it again.`,
    );
  }

  /**
   * Classify a `bootstatus` rejection for {@link bootAndVerify}. CoreSimulator
   * can transiently reject `bootstatus` with a structured "current state" 405.
   * Parse the state it reported and branch: `Booted` contradicts the failure
   * (the caller should verify state itself); `Booting`/`Shutting Down` means a
   * prior retry's transition (e.g. our own `shutdown`) has not settled yet, so
   * this waits for it before returning; any other reported state — or an error
   * that isn't this structured 405 at all — is not one this loop knows how to
   * recover from and is rethrown (issue #6411).
   *
   * @returns `true` when the caller should re-issue `bootstatus` within the
   *          same attempt (a mid-transition rejection was waited out); `false`
   *          when the caller should proceed to verify state (a contradictory
   *          "already Booted" 405).
   */
  private async handleBootstatusRejection(
    error: unknown,
    udid: string,
    deadlineMs: number,
    retryBackoffMs: number,
  ): Promise<boolean> {
    const reportedState = parseAlreadyBootedCoreSimulator405State(error, udid);
    if (reportedState === undefined) {
      throw error;
    }
    if (reportedState === "Booting" || reportedState === "Shutting Down") {
      logger.debug(
        `[iOS] bootstatus rejected ${udid} mid-transition (${reportedState}); ` +
          `polling for settlement before re-issuing bootstatus: ${error}`,
      );
      await this.waitForSimulatorSettled(udid, deadlineMs, retryBackoffMs);
      await this.waitForBootRetry(udid, retryBackoffMs || STATE_READ_RETRY_BACKOFF_MS, deadlineMs);
      return true;
    }
    if (reportedState !== "Booted") {
      throw error;
    }
    logger.debug(
      `[iOS] bootstatus returned expected CoreSimulator error 405 for ${udid}; verifying simulator state: ${error}`,
    );
    return false;
  }

  /**
   * Poll device state (through {@link readSimulatorStateRetrying}, so a
   * transient discovery failure does not abort the wait) until it is no
   * longer mid-transition (`Booting` / `Shutting Down`), or the boot deadline
   * is exhausted. Used both before re-issuing `bootstatus` after a retry
   * shutdown and after a mid-transition CoreSimulator 405 rejection (#6411).
   */
  private async waitForSimulatorSettled(
    udid: string,
    deadlineMs: number,
    pollIntervalMs: number,
  ): Promise<void> {
    for (;;) {
      const state = await this.readSimulatorStateRetrying(udid, deadlineMs);
      if (state !== "Booting" && state !== "Shutting Down") {
        return;
      }
      await this.waitForBootRetry(udid, pollIntervalMs || STATE_READ_RETRY_BACKOFF_MS, deadlineMs);
    }
  }

  private async waitForBootRetry(udid: string, delayMs: number, deadlineMs: number): Promise<void> {
    const boundedDelayMs = Math.min(delayMs, this.remainingBootTimeoutMs(udid, deadlineMs));
    const signal = getAbortSignal();
    if (!signal) {
      await this.timer.sleep(boundedDelayMs);
      return;
    }
    let delayHandle: NodeJS.Timeout | undefined;
    try {
      await raceWithDeadline(
        new Promise<void>((resolve) => {
          delayHandle = this.timer.setTimeout(resolve, boundedDelayMs);
        }),
        { timer: this.timer, signal, label: "iOS simulator boot retry" },
      );
      signal.throwIfAborted();
    } finally {
      if (delayHandle) {
        this.timer.clearTimeout(delayHandle);
      }
    }
  }

  private bootDeadline(timeoutMs: number): number {
    return this.timer.now() + timeoutMs;
  }

  /**
   * Compute the time left before `deadlineMs`, for sizing the next boot
   * recovery step's own command timeout. Throws `ActionableError` (naming the
   * UDID and the elapsed budget) once the deadline itself has passed, so the
   * same condition — the boot deadline elapsing between recovery steps —
   * surfaces in one classified shape regardless of which of the three boot
   * entry points (`waitForSimulatorReady`, `bootSimulator`, or a caller of
   * either) is waiting on it (issue #6413).
   */
  private remainingBootTimeoutMs(udid: string, deadlineMs: number): number {
    getAbortSignal()?.throwIfAborted();
    const remainingMs = deadlineMs - this.timer.now();
    if (remainingMs <= 0) {
      throw new ActionableError(
        `Simulator boot verification for ${udid} timed out before the next recovery step ` +
          `(deadline elapsed ${-remainingMs}ms ago)`,
      );
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

  /**
   * Resolve the newest available runtime satisfying both requested bounds.
   * Unlike SDK compatibility resolution, bounds are strict predicates and
   * never fall back to another version in the same major.
   */
  async resolveRuntimeIdentifiersForBounds(
    minVersion?: string,
    maxVersion?: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (minVersion === undefined && maxVersion === undefined) {
      return [await this.resolveRuntimeIdentifier(undefined, signal)];
    }
    const min = this.parseRequestedRuntimeBound(minVersion, "min");
    const max = this.parseRequestedRuntimeBound(maxVersion, "max");
    const runtimes = await this.listIosRuntimes(signal);
    const matching = runtimes
      .filter(
        (runtime) => !Number.isNaN(compareStrictNumericVersions(runtime.version, runtime.version)),
      )
      .filter(({ version }) => {
        if (min && compareStrictNumericVersions(version, min) < 0) {
          return false;
        }
        return !max || compareStrictNumericVersions(version, max) <= 0;
      })
      .sort((left, right) => compareStrictNumericVersions(right.version, left.version));

    if (matching.length > 0) {
      logger.debug(
        `[iOS] Resolved ${matching.length} runtime candidate(s) within requested range ` +
          `(min=${minVersion ?? "any"}, max=${maxVersion ?? "any"})`,
      );
      return matching.map((runtime) => runtime.identifier);
    }

    const available = runtimes.map((runtime) => runtime.name).join(", ") || "<none>";
    throw new ActionableError(
      "No available iOS simulator runtime matches the requested range " +
        `(min=${minVersion ?? "any"}, max=${maxVersion ?? "any"}). ` +
        `Available runtimes: ${available}. Install one via Xcode > Settings > Components.`,
    );
  }

  private parseRequestedRuntimeBound(
    version: string | undefined,
    edge: "min" | "max",
  ): string | undefined {
    if (version === undefined) {
      return undefined;
    }
    const trimmed = version.trim();
    if (Number.isNaN(compareStrictNumericVersions(trimmed, trimmed))) {
      throw new ActionableError(
        `Invalid iOS ${edge}OsVersion '${version}'. Pass a numeric version such as '18.2'.`,
      );
    }
    return trimmed;
  }

  /** Read the active Xcode iphonesimulator SDK version. */
  private async detectIosSdkVersion(signal?: AbortSignal): Promise<string> {
    try {
      // Direct xcrun (not a `simctl` subcommand), so it bypasses the
      // executeCommandArgv funnel; give it its own ambient leaf (see PerfContext).
      const result = await trackAmbient("xcrun --show-sdk-version", () =>
        this.execAsync(
          "xcrun",
          ["--sdk", "iphonesimulator", "--show-sdk-version"],
          undefined,
          signal,
        ),
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
   *          the device is absent from the listing.
   * @throws when discovery itself fails (e.g. `simctl list devices --json`
   *         times out or its output cannot be parsed) — a failed read is not
   *         evidence of a failed boot, so callers must not conflate the two
   *         (issue #6411). {@link readSimulatorStateRetrying} is the retrying
   *         wrapper boot verification should use instead of calling this
   *         directly.
   */
  private async readSimulatorState(udid: string, timeoutMs: number): Promise<string | undefined> {
    // `bypassCache: true` because a stale cached/last-good snapshot would defeat
    // the "never trust a stale snapshot" contract this method promises boot
    // verification (issue #6576); a bypassCache read always throws on discovery
    // failure rather than falling back, so that failure propagates to
    // {@link readSimulatorStateRetrying} for its own retry-vs-surface decision
    // (issue #6411) instead of being swallowed here.
    const devices = await this.listSimulatorImages(timeoutMs, { bypassCache: true });
    return devices.find((device) => device.deviceId === udid)?.state;
  }

  /**
   * {@link readSimulatorState}, retrying a discovery failure (bounded by the
   * boot deadline) instead of surfacing it. A `simctl list devices --json`
   * timeout/parse hiccup is transient and unrelated to whether the simulator
   * actually booted, so boot verification retries the *read* here rather than
   * treating "could not tell" as "not Booted" and tearing the device down
   * (issue #6411).
   */
  private async readSimulatorStateRetrying(
    udid: string,
    deadlineMs: number,
  ): Promise<string | undefined> {
    for (;;) {
      try {
        return await this.readSimulatorState(udid, this.remainingBootTimeoutMs(udid, deadlineMs));
      } catch (error) {
        // Expected to happen occasionally (a transient simctl hiccup); safe to
        // retry within the boot deadline rather than surfacing immediately.
        logger.debug(
          `[iOS] Could not read simulator state for ${udid}; retrying within the boot deadline: ${errorMessage(error)}`,
        );
        await this.waitForBootRetry(udid, STATE_READ_RETRY_BACKOFF_MS, deadlineMs);
      }
    }
  }

  /**
   * Find a device by UDID whose `state` is `Booted`, directly from `simctl
   * list devices --json`. This is the single lookup both boot-completion
   * paths share — {@link resolveRegisteredBootSimulator} and
   * {@link resolveReadySimulator} — so a finished boot's post-condition
   * cannot drift between them again (issue #6412). Availability is reported
   * rather than filtered here: callers apply {@link isDeviceAvailable} so
   * each can produce its own not-found vs. unavailable error.
   */
  private async findBootedSimulator(
    udid: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AppleDevice | undefined> {
    const simulatorList = await this.listSimulators(timeoutMs, signal);
    for (const [runtimeId, runtimeDevices] of Object.entries(simulatorList.devices)) {
      const device = runtimeDevices.find(
        (candidate) => candidate.udid === udid && candidate.state === "Booted",
      );
      if (device) {
        return { ...device, runtime: runtimeId };
      }
    }
    return undefined;
  }

  /**
   * Build the ActionableError for a booted device rejected on availability,
   * naming the actual `availabilityError` (issue #6412) instead of a generic
   * boot-failure message that hides the cause.
   */
  private unavailableBootError(udid: string, device: AppleDevice): ActionableError {
    return new ActionableError(
      `Simulator with UDID ${udid} booted but is unavailable` +
        (device.availabilityError ? `: ${device.availabilityError}` : ""),
    );
  }

  /**
   * Look up full device metadata for an already-booted simulator and return it
   * as a BootedDevice. Shared by the cold-boot (assumeBooted) and already-running
   * branches of {@link waitForSimulatorReady}.
   */
  private async resolveReadySimulator(udid: string, timeoutMs?: number): Promise<BootedDevice> {
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("deviceLookup");
    // findBootedSimulator always issues its own unshared `simctl list
    // devices` read (never listSimulatorImages()'s TTL cache), and is shared
    // with resolveRegisteredBootSimulator (issue #6412) so both boot-
    // completion paths agree on the same booted device and neither trusts a
    // stale cached snapshot (issue #6576).
    const simulator = await this.findBootedSimulator(udid, timeoutMs);
    perf.endOperation("deviceLookup");

    if (!simulator) {
      throw new ActionableError(`Simulator with UDID ${udid} not found after boot`);
    }
    if (!isDeviceAvailable(simulator)) {
      throw this.unavailableBootError(udid, simulator);
    }

    return {
      name: simulator.name,
      platform: "ios",
      deviceId: simulator.udid,
      observedAt: this.observationSequence.next(),
    } as BootedDevice;
  }

  /**
   * Get the list of available (booted and shutdown) simulator UDIDs
   * @returns Promise with an array of device UDIDs
   */
  async listSimulatorImages(
    timeoutMs?: number,
    options: { bypassCache?: boolean; signal?: AbortSignal } = {},
  ): Promise<DeviceInfo[]> {
    // An already-aborted caller must fail even on a cache hit below -- a cached
    // "success" for a request the caller has already given up on is silently
    // wrong (issue #6576).
    const signal = options.signal ?? getAbortSignal();
    signal?.throwIfAborted();

    // Check cache first
    if (!options.bypassCache && SimCtlClient.deviceListCache) {
      const cacheAge = this.timer.now() - SimCtlClient.deviceListCache.timestamp;
      if (cacheAge < SimCtlClient.DEVICE_LIST_CACHE_TTL) {
        logger.info(`Getting list of iOS simulators (cached, age: ${cacheAge}ms)`);
        return SimCtlClient.deviceListCache.devices;
      }
    }

    // A caller that explicitly bypassed the cache wants a read that is
    // provably fresh (e.g. boot verification via readSimulatorState), so it
    // must not join an in-flight request some other caller's options started
    // — that request's failure-fallback behavior is not this caller's to
    // inherit. Run it standalone instead of sharing the coalescing slot below.
    if (options.bypassCache) {
      return this.runListSimulatorImages(timeoutMs, { bypassCache: true, signal });
    }

    return this.raceOwnDeadline(this.runListSimulatorImages(undefined, {}), timeoutMs, signal);
  }

  private sharedDeviceList(): Promise<DeviceInfo[]> {
    if (!SimCtlClient.inFlightDeviceList) {
      const generation = SimCtlClient.deviceListGeneration;
      const requestSequence = ++SimCtlClient.deviceListRequestSequence;
      const flight = runWithAbortSignal(undefined, () =>
        this.listDevicesForBootedCheck(SimCtlClient.SHARED_DEVICE_LIST_TIMEOUT_MS, undefined),
      )
        .then((devices) => {
          this.recordDeviceListSnapshot(devices, generation, requestSequence);
          return devices;
        })
        .finally(() => {
          if (SimCtlClient.inFlightDeviceList === flight) {
            SimCtlClient.inFlightDeviceList = null;
            SimCtlClient.inFlightDeviceListRequestSequence = null;
          }
        });
      SimCtlClient.inFlightDeviceList = flight;
      SimCtlClient.inFlightDeviceListRequestSequence = requestSequence;
    }
    return SimCtlClient.inFlightDeviceList;
  }

  /**
   * Await a listing shared with other callers (`SimCtlClient.inFlightDeviceList`)
   * but bound ONLY by THIS caller's own timeout/signal. Losing that race must
   * not cancel the shared fetch or affect any other waiter racing the same
   * promise (issue #6576) -- unlike `executeCommandArgv`'s timeout, this never
   * aborts the underlying process, since other callers may still need it.
   */
  private async raceOwnDeadline(
    shared: Promise<DeviceInfo[]>,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DeviceInfo[]> {
    signal?.throwIfAborted();
    if (timeoutMs === undefined && !signal) {
      return shared;
    }

    return await raceWithDeadline(shared, {
      timer: this.timer,
      timeoutMs,
      signal,
      label: "iOS simulator listing",
      timeoutError: () =>
        new Error(`Timed out waiting for iOS simulator listing after ${timeoutMs}ms`),
    });
  }

  /** Map a raw `simctl list devices --json` payload into sorted {@link DeviceInfo} records. */
  private async mapSimulatorListToDeviceInfos(
    simulatorList: SimulatorList,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DeviceInfo[]> {
    const devices: DeviceInfo[] = [];
    for (const [runtimeId, runtimeDevices] of Object.entries(simulatorList.devices)) {
      for (const device of runtimeDevices) {
        logger.debug(`Found iOS simulator: ${device.name} (${device.udid}) state=${device.state}`);
        const iosVersion = normalizeIosVersion(runtimeId, device.os_version);
        const profile = device.deviceTypeIdentifier
          ? await this.profileForDeviceType(device.deviceTypeIdentifier, deadlineMs, signal)
          : null;
        const displays = await this.displaysForBootedSimulator(device, deadlineMs, signal);
        const deviceDisplays = simulatorDeviceDisplays(displays, device.deviceTypeIdentifier);
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
          runtimeId,
          runtime: runtimeId,
          model: simulatorModel(device.model, profile),
          // Simulator processes execute on the host architecture; this does not
          // require another simctl invocation.
          architecture: this.hostArchitecture,
          screenWidth: profile?.pixelWidth ?? undefined,
          screenHeight: profile?.pixelHeight ?? undefined,
          screenDensity: profile?.dpi ?? undefined,
          ...(deviceDisplays ? { displays: deviceDisplays } : {}),
          capabilityInventory: iosSimulatorCapabilityInventory({
            isAvailable: device.isAvailable,
            availabilityError: device.availabilityError,
            runtime: runtimeId,
          }),
        } as DeviceInfo);
      }
    }
    devices.sort((a, b) => (a.deviceId || "").localeCompare(b.deviceId || ""));
    return devices;
  }

  private async displaysForBootedSimulator(
    device: AppleDevice,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SimulatorDisplay[]> {
    if (device.state !== "Booted") {
      return [];
    }
    const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return [];
    }
    try {
      return await this.enumerateDisplays(device.udid, remainingMs, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Optional display enrichment cannot make the device inventory unavailable.
      logger.debug(
        `Failed to enumerate simulator displays for ${device.udid}: ${errorMessage(error)}`,
      );
      return [];
    }
  }

  private async profileForDeviceType(
    deviceTypeIdentifier: string,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<SimulatorDeviceTypeProfileSource["profileFor"]>>> {
    const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return null;
    }
    if (remainingMs === undefined && signal === undefined) {
      return this.deviceTypeProfiles.profileFor(deviceTypeIdentifier);
    }
    // The remaining budget bounds only this caller's wait (the race below); the shared,
    // memoizing source gets the caller's signal but its own default timeout, so a
    // near-deadline listing cannot poison the profile cache with a transient timeout.
    const profile = this.deviceTypeProfiles.profileFor(deviceTypeIdentifier, { signal });
    try {
      return await this.raceWithDeadlineAndAbort(profile, remainingMs, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Display dimensions are optional best-effort enrichment; a bounded
      // profile lookup must not fail the simulator listing.
      logger.debug(`Failed to enrich iOS simulator display dimensions: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Race an optional lookup against the remaining budget and the caller's abort signal. */
  private async raceWithDeadlineAndAbort<T>(
    operation: Promise<T>,
    remainingMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return await raceWithDeadline(operation, {
      timer: this.timer,
      timeoutMs: remainingMs,
      signal,
      label: "iOS simulator device type profile",
      timeoutError: () => new Error("Timed out reading iOS simulator device type profile"),
    });
  }

  /** Write a successful physical listing unless invalidation or a newer success superseded it. */
  private recordDeviceListSnapshot(
    devices: DeviceInfo[],
    generation: number,
    requestSequence: number,
  ): boolean {
    if (
      SimCtlClient.deviceListGeneration !== generation ||
      requestSequence < SimCtlClient.recordedDeviceListRequestSequence
    ) {
      return false;
    }
    const timestamp = this.timer.now();
    SimCtlClient.deviceListCache = devices.length ? { devices, timestamp } : null;
    SimCtlClient.lastGoodDeviceList = { devices, timestamp };
    SimCtlClient.recordedDeviceListRequestSequence = requestSequence;
    return true;
  }

  private async runListSimulatorImages(
    timeoutMs: number | undefined,
    options: { bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<DeviceInfo[]> {
    logger.debug("Getting list of iOS simulators");
    const generation = SimCtlClient.deviceListGeneration;
    const requestSequence = options.bypassCache
      ? ++SimCtlClient.deviceListRequestSequence
      : undefined;

    try {
      const devices = options.bypassCache
        ? await this.listDevicesForBootedCheck(timeoutMs, options.signal)
        : await this.sharedDeviceList();
      if (
        requestSequence !== undefined &&
        this.recordDeviceListSnapshot(devices, generation, requestSequence) &&
        SimCtlClient.inFlightDeviceListRequestSequence !== null &&
        SimCtlClient.inFlightDeviceListRequestSequence < requestSequence
      ) {
        SimCtlClient.inFlightDeviceList = null;
        SimCtlClient.inFlightDeviceListRequestSequence = null;
      }
      return devices;
    } catch (error) {
      options.signal?.throwIfAborted();
      const detail = errorMessage(error);

      // A caller that explicitly requested a fresh read (e.g. boot
      // verification via readSimulatorState) must never be handed a stale
      // snapshot in place of the failure it asked to observe. Everyone else
      // gets the last-good snapshot within its retention window, mirroring
      // DevicectlDeviceLister.lastGood (issue #6576).
      const lastGood = SimCtlClient.lastGoodDeviceList;
      if (
        !options.bypassCache &&
        lastGood &&
        this.timer.now() - lastGood.timestamp < SimCtlClient.LAST_GOOD_DEVICE_LIST_RETENTION_MS
      ) {
        logger.warn(
          `Failed to get iOS devices: ${detail}. Falling back to last-good simulator list (age: ${this.timer.now() - lastGood.timestamp}ms).`,
        );
        return lastGood.devices;
      }

      logger.warn(`Failed to get iOS devices: ${detail}`);
      throw new ActionableError(`Failed to list iOS simulator devices: ${detail}`);
    }
  }

  /**
   * Get the list of booted simulator UDIDs
   * @returns Promise with an array of booted device UDIDs
   */
  async getBootedSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<BootedDevice[]> {
    try {
      return await this.getBootedSimulatorsChecked(timeoutMs, signal);
    } catch (error) {
      (signal ?? getAbortSignal())?.throwIfAborted();
      logger.debug(`Failed to get booted iOS devices: ${error}`);
      return [];
    }
  }

  /**
   * Like {@link getBootedSimulators} but rethrows discovery failures instead of
   * swallowing them into an empty list. Callers that must distinguish "no
   * simulators are booted" from "simctl discovery failed" should use this.
   *
   * Reuses fresh cached discovery or the shared raw listing. Each waiter retains
   * its own cancellation/deadline, and checked discovery propagates raw errors
   * instead of returning the UI listing's last-good fallback.
   */
  async getBootedSimulatorsChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options: { bypassCache?: boolean } = {},
  ): Promise<BootedDevice[]> {
    // An already-aborted caller must fail even on a cache hit below -- a cached
    // "success" for a request the caller has already given up on is silently
    // wrong (issue #6576).
    signal ??= getAbortSignal();
    signal?.throwIfAborted();
    const cached = SimCtlClient.deviceListCache;
    const devices =
      !options.bypassCache &&
      cached &&
      this.timer.now() - cached.timestamp < SimCtlClient.DEVICE_LIST_CACHE_TTL
        ? cached.devices
        : options.bypassCache
          ? await this.listDevicesForBootedCheck(timeoutMs, signal)
          : await this.raceOwnDeadline(this.sharedDeviceList(), timeoutMs, signal);
    const observedAt = this.observationSequence.next();

    return devices
      .filter((device) => isDeviceAvailable(device) && device.state === "Booted" && device.deviceId)
      .map(
        (device) =>
          ({
            name: device.name,
            platform: "ios",
            deviceId: device.deviceId,
            observedAt,
            iosVersion: device.iosVersion,
            osVersion: device.osVersion,
            formFactor: device.formFactor,
            runtimeId: device.runtimeId,
            runtime: device.runtime,
            deviceType: device.deviceType,
            model: device.model,
            architecture: device.architecture,
            displays: device.displays,
          }) as BootedDevice,
      )
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  /** Cold-cache path for {@link getBootedSimulatorsChecked}: the raw discovery primitive. */
  private async listDevicesForBootedCheck(
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DeviceInfo[]> {
    const deadlineMs = timeoutMs === undefined ? undefined : this.timer.now() + timeoutMs;
    const simulatorList = await this.listSimulators(timeoutMs, signal);
    return this.mapSimulatorListToDeviceInfos(simulatorList, deadlineMs, signal);
  }

  /**
   * Get device information by UDID
   * @param udid - Device UDID
   * @returns Promise with device information or null if not found
   */
  async getDeviceInfo(udid: string): Promise<AppleDevice | null> {
    try {
      // Routes through listSimulatorImages so this shares the cached/coalesced
      // listing instead of always spawning a fresh `simctl` process (issue #6576).
      const device = (await this.listSimulatorImages()).find((d) => d.deviceId === udid);
      if (device) {
        return {
          udid: device.deviceId ?? udid,
          name: device.name,
          state: device.state ?? "",
          isAvailable: device.isAvailable ?? false,
          availabilityError: device.availabilityError,
          deviceTypeIdentifier: device.deviceType,
          runtime: device.runtime,
          model: device.model,
          os_version: device.osVersion,
          architecture: device.architecture,
        };
      }

      return null;
    } catch (error) {
      getAbortSignal()?.throwIfAborted();
      logger.warn(`Failed to get iOS device info for ${udid}: ${error}`);
      return null;
    }
  }

  /** Read the physical screens of one booted simulator without enumerating every device. */
  async readDeviceDisplays(
    udid: string,
    signal?: AbortSignal,
  ): Promise<DeviceDisplays | undefined> {
    signal?.throwIfAborted();
    const device = await this.getDeviceInfo(udid);
    signal?.throwIfAborted();
    if (!device) {
      throw new Error(`Unable to read display inventory: simulator ${udid} was not found`);
    }
    if (device.state !== "Booted") {
      return undefined;
    }
    const displays = await this.enumerateDisplays(udid, 2_000, signal);
    return simulatorDeviceDisplays(displays, device.deviceTypeIdentifier);
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
        SimCtlClient.bootPresentationGenerations.delete(udid);
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
    // Shares findBootedSimulator with resolveReadySimulator (issue #6412) so
    // this session auto-start path and the explicit startSimulator +
    // waitForSimulatorReady path agree on the same booted device.
    //
    // findBootedSimulator always issues its own unshared `simctl list
    // devices` read (it calls listSimulators() directly, never
    // listSimulatorImages()'s TTL cache), so it is already immune to the
    // stale-cache risk bypassCache guards against elsewhere (issue #6576):
    // there is no cached snapshot here to trust in the first place.
    const device = await this.findBootedSimulator(
      udid,
      this.remainingBootTimeoutMs(udid, deadlineMs),
    );
    perf.endOperation("bootRegistration");
    if (!device) {
      throw new ActionableError(`Failed to boot iOS simulator ${udid}`);
    }
    if (!isDeviceAvailable(device)) {
      throw this.unavailableBootError(udid, device);
    }
    const iosVersion = normalizeIosVersion(device.runtime, device.os_version);
    return {
      name: device.name,
      platform: "ios",
      deviceId: device.udid,
      observedAt: this.observationSequence.next(),
      iosVersion,
      osVersion: iosVersion,
      formFactor: inferIosFormFactor(device.deviceTypeIdentifier),
      runtimeId: device.runtime,
      runtime: device.runtime,
      deviceType: device.deviceTypeIdentifier,
    } as BootedDevice;
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
  async getRuntimes(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]> {
    const result = await this.executeCommandArgs(["list", "runtimes", "--json"], timeoutMs, signal);
    try {
      const data = JSON.parse(result.stdout) as { runtimes?: AppleDeviceRuntime[] };
      return (data.runtimes ?? []).filter((runtime) => runtime.isAvailable);
    } catch (error) {
      logger.warn(`Failed to parse runtimes from simctl: ${error}`);
      return [];
    }
  }

  /** Get available runtimes and preserve malformed simctl output as an error. */
  async getRuntimesChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AppleDeviceRuntime[]> {
    const result = await this.executeCommandArgs(["list", "runtimes", "--json"], timeoutMs, signal);
    const data = JSON.parse(result.stdout) as { runtimes?: unknown };
    if (!Array.isArray(data?.runtimes)) {
      throw new Error("simctl runtimes response does not contain a runtimes array");
    }
    return data.runtimes as AppleDeviceRuntime[];
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

  /**
   * Drop the shared device-list snapshot so the next list re-reads simctl.
   * Also drops the last-good fallback: a caller invalidating the cache knows
   * something changed (a device was created/deleted, or a test is resetting
   * state), so a subsequent transient failure must not resurrect the
   * pre-invalidation snapshot as if it were still trustworthy (issue #6576).
   *
   * Also bumps `deviceListGeneration` so an in-flight listing that was already
   * running when this invalidation fires cannot repopulate the cache with the
   * obsolete snapshot it captured before the mutation (issue #6576).
   */
  static invalidateDeviceListCache(): void {
    SimCtlClient.deviceListCache = null;
    SimCtlClient.lastGoodDeviceList = null;
    SimCtlClient.inFlightDeviceList = null;
    SimCtlClient.inFlightDeviceListRequestSequence = null;
    SimCtlClient.deviceListGeneration++;
  }

  /**
   * Delete a simulator by UDID
   * @param udid - Device UDID to delete
   * @returns Promise that resolves when deletion is complete
   */
  async deleteSimulator(
    udid: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    logger.debug(`Deleting iOS simulator ${udid}`);
    const lease = await this.acquireSimulatorBoot(
      udid,
      this.timer.now() + (options.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS),
      options.signal,
    );
    try {
      await this.executeCommandArgv(
        ["delete", udid],
        options.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS,
        `delete ${udid}`,
        options.signal,
        true,
      );
      lease.state.lastBootSucceeded = false;
      lease.state.ownerToken = undefined;
      SimCtlClient.invalidateDeviceListCache();
    } finally {
      lease.release();
    }
  }

  private requireSimulatorDeviceId(deviceId?: string): string {
    const targetDevice = deviceId || this.device?.deviceId;
    if (!targetDevice || targetDevice === "booted") {
      throw new ActionableError(
        "No simulator is selected. Bind a device when constructing SimCtlClient or pass a deviceId. " +
          "Use a simulator UDID from xcrun simctl list devices or the listDevices tool.",
      );
    }
    return targetDevice;
  }

  /**
   * List all installed apps on the simulator
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with array of app objects containing bundle identifiers and other metadata
   */
  async listApps(deviceId?: string): Promise<any[]> {
    try {
      return await this.listAppsOrThrow(deviceId);
    } catch (error) {
      // Legacy lenient contract: callers of `listApps` treat an unavailable
      // listing as "no apps". Callers that must distinguish a failed listing
      // from an empty device use `listAppsOrThrow` instead (issue #5621).
      logger.warn(`Failed to list iOS apps: ${error}`);
      return [];
    }
  }

  /**
   * List installed apps, propagating a listing failure instead of collapsing it
   * into an empty array. `listApps` swallows the error for its existing
   * callers; consumers that must tell "the listing failed" apart from "the
   * device has no such app" — the install pre-checks in `UninstallApp` and
   * `TerminateApp` — call this variant (issue #5621).
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with array of app objects containing bundle identifiers and other metadata
   */
  async listAppsOrThrow(deviceId?: string): Promise<any[]> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    logger.debug(`Listing installed apps on iOS simulator ${targetDevice}`);

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
  }

  /**
   * Launch an app on the simulator
   * @param bundleId - The bundle identifier of the app to launch
   * @param options - Launch options
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with launch result containing success status and optional PID
   */
  async launchApp(
    bundleId: string,
    options?: { foregroundIfRunning?: boolean; launchArguments?: string[] },
    deviceId?: string,
  ): Promise<{
    success: boolean;
    pid?: number;
    error?: string;
  }> {
    try {
      const targetDevice = this.requireSimulatorDeviceId(deviceId);
      logger.debug(`Launching app ${bundleId} on iOS simulator ${targetDevice}`);
      const launchArgs = ["launch", targetDevice, bundleId, ...(options?.launchArguments ?? [])];
      const result = await this.executeCommandArgv(
        launchArgs,
        undefined,
        `launch ${targetDevice} ${bundleId} [app arguments redacted]`,
      );

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
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise that resolves when termination is complete
   */
  async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    logger.debug(`Terminating app ${bundleId} on iOS simulator ${targetDevice}`);

    try {
      await this.executeCommandArgs(["terminate", targetDevice, bundleId]);
    } catch (error) {
      logger.warn(`Failed to terminate iOS app ${bundleId}: ${error}`);
      throw error;
    }
  }

  async installApp(appPath: string, deviceId?: string): Promise<void> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    logger.debug(`Installing app ${appPath} on iOS simulator ${targetDevice}`);
    await this.executeCommandArgs(["install", targetDevice, appPath]);
  }

  async uninstallApp(bundleId: string, deviceId?: string): Promise<void> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    logger.debug(`Uninstalling app ${bundleId} from iOS simulator ${targetDevice}`);
    await this.executeCommandArgs(["uninstall", targetDevice, bundleId]);
  }

  /**
   * Get the screen size of the simulator
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with screen dimensions
   */
  async getScreenSize(deviceId?: string, timeoutMs?: number): Promise<ScreenSize> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);

    logger.info(`[iOS] Getting screen size for simulator ${targetDevice}`);

    const display = (await this.enumerateDisplays(targetDevice, timeoutMs)).find(
      (candidate) => candidate.uiScale !== null,
    );
    if (display?.uiScale) {
      return {
        width: Math.round(display.width / display.uiScale),
        height: Math.round(display.height / display.uiScale),
      };
    }

    throw new ActionableError("Unable to determine screen size from provided data.");
  }

  async enumerateDisplays(
    deviceId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SimulatorDisplay[]> {
    const result = await this.executeCommandArgs(["io", deviceId, "enumerate"], timeoutMs, signal);
    return parseSimulatorDisplays(result.stdout);
  }

  /** Capture the selected physical framebuffer as PNG through a private temporary file. */
  async screenshot(deviceId: string, display: string, signal?: AbortSignal): Promise<Buffer> {
    const startedAt = this.timer.now();
    const timeout = new AbortController();
    const handle = this.timer.setTimeout(() => timeout.abort(), 10_000);
    const captureSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const context: ScreenshotCaptureContext = {
      signal: captureSignal,
      abortFailure: (cause, exitCode, stderr) => {
        const elapsed = this.timer.now() - startedAt;
        const timedOut = captureSignal.reason === timeout.signal.reason && timeout.signal.aborted;
        return new SimctlScreenshotError(
          timedOut ? "aborted-by-timeout" : "aborted-by-caller",
          timedOut
            ? `simctl screenshot timed out after ${elapsed}ms`
            : `simctl screenshot cancelled by the caller after ${elapsed}ms: ${errorMessage(signal?.reason)}`,
          { exitCode, stderr, cause: cause ?? captureSignal.reason },
        );
      },
    };
    let dir: string | undefined;
    let finished = false;
    try {
      // The continuation owns late directories; finally owns ones received before settlement.
      const preparing = this.prepareScreenshotDirectory().then(async (created) => {
        if (finished) {
          await this.removeScreenshotDirectory(created);
        } else {
          dir = created;
        }
        return created;
      });
      // A pre-aborted race does not subscribe to its input; observe setup failures even then.
      void preparing.then(undefined, (error: unknown) => {
        logger.debug(`simctl screenshot temp preparation failed: ${errorMessage(error)}`, error);
      });
      const created = await raceWithDeadline(preparing, {
        timer: this.timer,
        signal: captureSignal,
        label: "simctl screenshot temp directory",
      });
      const path = resolve(created, `screenshot-${this.idGenerator.next()}.png`);
      return await this.captureScreenshotFile(deviceId, display, path, context);
    } catch (error) {
      throw error instanceof SimctlScreenshotError || !captureSignal.aborted
        ? error
        : context.abortFailure(error);
    } finally {
      finished = true;
      try {
        if (dir !== undefined) {
          await this.removeScreenshotDirectory(dir);
        }
      } finally {
        this.timer.clearTimeout(handle);
      }
    }
  }

  private async prepareScreenshotDirectory(): Promise<string> {
    try {
      return await this.fileSystem.mkdtemp(resolve(tmpdir(), "automobile-screenshot-"));
    } catch (error) {
      throw new SimctlScreenshotError(
        "read-failure",
        "Unable to prepare simctl screenshot temp directory",
        { cause: error },
      );
    }
  }

  private async removeScreenshotDirectory(dir: string): Promise<void> {
    await this.waitForScreenshotCleanup(
      () => this.fileSystem.rm(dir, { recursive: true, force: true }),
      "temp directory",
    );
  }

  private async waitForScreenshotCleanup(
    cleanup: () => Promise<unknown>,
    phase: string,
  ): Promise<void> {
    try {
      await raceWithDeadline(cleanup, {
        timer: this.timer,
        timeoutMs: SCREENSHOT_CLEANUP_BOUND_MS,
        label: `simctl screenshot ${phase} cleanup`,
      });
    } catch (error) {
      // Best-effort cleanup is safe to swallow: the capture result is already decided.
      logger.debug(`simctl screenshot ${phase} cleanup failed: ${errorMessage(error)}`, error);
    }
  }

  private async readScreenshotFile(path: string, stderr: string): Promise<Buffer> {
    let output: Buffer;
    try {
      output = await this.fileSystem.readFileBuffer(path);
    } catch (error) {
      const missing =
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      throw new SimctlScreenshotError(
        missing ? "missing-output-file" : "read-failure",
        `simctl screenshot output ${missing ? "file missing" : "read failed"}: ${errorMessage(error)}`,
        { exitCode: 0, stderr, cause: error },
      );
    }
    if (output.length === 0 || detectImageMimeType(output) !== "image/png") {
      const reason = output.length === 0 ? "empty-output" : "non-image-output";
      throw new SimctlScreenshotError(reason, `simctl screenshot returned ${reason}`, {
        exitCode: 0,
        stderr,
        byteLength: output.length,
      });
    }
    return output;
  }

  private async captureScreenshotFile(
    deviceId: string,
    display: string,
    path: string,
    context: ScreenshotCaptureContext,
  ): Promise<Buffer> {
    const args = ["simctl", "io", deviceId, "screenshot", `--display=${display}`, path];
    const captureSignal = context.signal;
    const errors: Buffer[] = [];
    const stderrText = (): string => Buffer.concat(errors).toString();
    const abortFailure = (cause?: unknown, exitCode?: number | null): SimctlScreenshotError =>
      context.abortFailure(cause, exitCode, stderrText());
    if (captureSignal.aborted) {
      throw abortFailure();
    }
    const process = new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        if (captureSignal.aborted) {
          reject(abortFailure());
          return;
        }
        child = this.spawnProcess("xcrun", args, { signal: captureSignal });
      } catch (error) {
        reject(
          captureSignal.aborted
            ? abortFailure(error)
            : new SimctlScreenshotError(
                "non-zero-exit",
                `simctl screenshot failed to spawn: ${errorMessage(error)}`,
                { cause: error },
              ),
        );
        return;
      }
      // Drain diagnostic stdout; simctl writes the PNG only to the requested file.
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
      child.once("error", (error) => {
        reject(
          captureSignal.aborted
            ? abortFailure(error)
            : new SimctlScreenshotError(
                "non-zero-exit",
                `simctl screenshot process failed: ${errorMessage(error)}`,
                { stderr: stderrText(), cause: error },
              ),
        );
      });
      child.once("close", (code) => {
        if (captureSignal.aborted) {
          reject(abortFailure(captureSignal.reason, code));
        } else if (code === 0) {
          resolve(stderrText());
        } else {
          const stderr = stderrText();
          reject(
            new SimctlScreenshotError("non-zero-exit", `simctl screenshot failed: ${stderr}`, {
              exitCode: code,
              stderr,
            }),
          );
        }
      });
    });
    let stderr: string;
    try {
      stderr = await raceWithDeadline(process, {
        timer: this.timer,
        signal: captureSignal,
        label: "simctl screenshot process",
      });
    } catch (error) {
      const failure =
        error instanceof SimctlScreenshotError || !captureSignal.aborted
          ? error
          : abortFailure(error);
      if (captureSignal.aborted) {
        // Spawn's signal has requested termination; wait only briefly for its notification.
        await this.waitForScreenshotCleanup(
          () =>
            process.then(
              () => undefined,
              () => undefined,
            ),
          "process settlement",
        );
      }
      throw failure;
    }
    try {
      return await raceWithDeadline(() => this.readScreenshotFile(path, stderr), {
        timer: this.timer,
        signal: captureSignal,
        label: "simctl screenshot",
      });
    } catch (error) {
      throw captureSignal.aborted ? abortFailure(captureSignal.reason, 0) : error;
    }
  }

  async setAppearance(mode: "light" | "dark", deviceId?: string): Promise<void> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
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
    const dir = await this.fileSystem.mkdtemp(join(tmpdir(), "automobile-apns-"));
    const file = join(dir, "payload.apns");
    try {
      await this.fileSystem.writeFile(file, payloadJson, "utf8");
      // `xcrun simctl push <udid> <bundleId> <file>`; bundleId may be omitted when the
      // payload carries "Simulator Target Bundle", but passing it explicitly is harmless.
      const result = await this.executeCommandArgs(["push", deviceId, bundleId, file]);
      // `simctl push` can exit 0 (delivered) while still writing advisory or
      // diagnostic text to stderr, depending on the Xcode/simctl version.
      // Success is driven by the exit code alone — executeCommandArgs already
      // throws on a non-zero exit, which the catch below converts into
      // { success: false, error } (issue #6517). Log stderr for diagnostics
      // only; it must not flip a delivered push into a reported failure.
      if ((result.stderr || "").trim().length > 0) {
        logger.debug(`[iOS] simctl push wrote to stderr despite exit 0: ${result.stderr.trim()}`);
      }
      return { success: true };
    } catch (error) {
      logger.warn(
        `[iOS] Failed to push notification to ${deviceId}: ${errorMessage(error)}`,
        error,
      );
      return { success: false, error: errorMessage(error) };
    } finally {
      await this.fileSystem.rm(dir, { recursive: true, force: true }).catch((error) => {
        logger.warn(
          `[iOS] Failed to remove push notification directory ${dir}: ${errorMessage(error)}`,
          error,
        );
      });
    }
  }

  async openSimulatorApp(udid?: string, signal?: AbortSignal): Promise<boolean> {
    // On a headless macOS host (no Aqua GUI session, e.g. a launchd daemon or
    // SSH context) `open -a Simulator` fails with OSLaunchdErrorDomain Code=125
    // after a slow retry, wasting wall-clock against the daemon-start budget.
    // The booted simulator + CtrlProxy work without the GUI, so skip the launch.
    if (await this.isHeadlessSession(signal)) {
      logger.debug("Skipping open -a Simulator: headless session (no Aqua GUI)");
      return false;
    }

    // Ensure Simulator.app is open (creates windows for all booted devices).
    // Direct `open`/`osascript` bypass the executeCommandArgv funnel, so give
    // them their own ambient leaves (see PerfContext).
    await trackAmbient("open -a Simulator", () =>
      this.execAsync("open", ["-a", "Simulator"], undefined, signal),
    );
    // The start presenter already limits this to one call per boot. `open -a`
    // presents the app; activating it again would steal focus a second time.
    return true;
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
   * behavior. The result is cached for {@link HEADLESS_SESSION_CACHE_TTL} so
   * launchctl is not probed on every call, but a stale answer does not persist
   * for the process lifetime — mirrors the {@link DEVICE_LIST_CACHE_TTL} pattern.
   */
  private async isHeadlessSession(signal?: AbortSignal): Promise<boolean> {
    if (this.platform !== "darwin") {
      return true;
    }

    const override = process.env.AUTOMOBILE_IOS_HEADLESS;
    if (override !== undefined) {
      return override === "true" || override === "1";
    }

    const cacheAge = this.timer.now() - this.headlessSessionCacheTimestamp;
    if (
      this.headlessSessionCache !== null &&
      cacheAge >= 0 &&
      cacheAge < SimCtlClient.HEADLESS_SESSION_CACHE_TTL
    ) {
      return this.headlessSessionCache;
    }

    // Two device starts can race past the expired TTL and each launch an
    // independent probe. A sequence distinguishes probes that begin in the
    // same timer tick; only the newest one may update the cache. Each caller
    // keeps its own probe and cancellation signal.
    const probeSequence = ++this.headlessSessionProbeSequence;
    const headless = await this.detectHeadlessSession(signal);
    if (probeSequence === this.headlessSessionProbeSequence) {
      this.headlessSessionCache = headless;
      this.headlessSessionCacheTimestamp = this.timer.now();
    }
    return headless;
  }

  private async detectHeadlessSession(signal?: AbortSignal): Promise<boolean> {
    try {
      // Direct launchctl (not a simctl subcommand), so it bypasses the
      // executeCommandArgv funnel; give it its own ambient leaf (see PerfContext).
      const result = await trackAmbient("launchctl managername", () =>
        this.execAsync("launchctl", ["managername"], undefined, signal),
      );
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
