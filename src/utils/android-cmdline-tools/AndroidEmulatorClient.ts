import {
  emulatorProcessEscapeHint,
  EmulatorStillRunningError,
  markEmulatorStopDispatched,
  type EmulatorProcessIdentity,
  type EmulatorSerialDescription,
  type EmulatorProcessStopper,
} from "./EmulatorProcessStop";
import { AdbCommandTimeoutError } from "./AdbClient";
import { errorMessage } from "../describeUnknownError";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { extname, resolve, isAbsolute } from "node:path";
import type { FileSystem } from "../filesystem/DefaultFileSystem";
import { logger } from "../logger";
import { testOverrides } from "../testOverrides";
import { runExecSeam } from "../ExecSeam";
import {
  DefaultHostCommandExecutor,
  execFileAsync as sharedExecFileAsync,
  type HostProcessExecutor,
  type HostChildProcess as ChildProcess,
  type SpawnFn,
} from "../HostCommandExecutor";
import { BootedDevice, DeviceInfo, ExecResult, ActionableError } from "../../models";
import { toActionableError } from "../../models/ActionableError";
import { EmulatorLaunchCancelledError } from "../../models/EmulatorLaunchCancelledError";
import type { AdmitColdBoot, BootAdmission } from "../../models/BootAdmission";
import { AdbClientFactory, unadmittedAdbClientFactory } from "./AdbClientFactory";
import { AdbClient } from "./AdbClient";
import { arch } from "os";
import { detectAndroidCommandLineTools, getBestAndroidToolsLocation } from "./detection";
import { resolveAndroidSdkRoot } from "./androidSdkRoot";
import { defaultTimer, Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import { combineAbortSignals, getAbortSignal, runWithAbortSignal } from "../AbortContext";
import { trackAmbient } from "../PerfContext";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import { BunPortAvailabilityChecker, type PortAvailabilityChecker } from "../PortManager";
import type { AvdConfig, AvdConfigReader } from "./AvdConfigReader";
import { FileAvdConfigReader, MIN_AVD_RAM_MB } from "./AvdConfigReader";
import type { RunningAvdAdvertisementReader } from "./RunningAvdAdvertisementReader";
import { TmpdirRunningAvdAdvertisementReader } from "./RunningAvdAdvertisementReader";
import { AndroidWakeAndUnlock } from "./AndroidWakeAndUnlock";
import { DeviceLockStore } from "../../devices/DeviceLockStore";
import { androidProfileFormFactor } from "../../models/formFactor";
import type { AdbDeviceState } from "./interfaces/AdbExecutor";
import { redactAndroidCommandOutput } from "./redactAndroidCommandOutput";
import {
  defaultEmulatorConsoleBusyRegistry,
  type EmulatorConsoleBusyRegistry,
} from "./EmulatorConsoleBusyRegistry";
import {
  defaultDiscoveryObservationSequence,
  type DiscoveryObservationSequence,
} from "../DiscoveryObservationSequence";

import {
  DefaultEmulatorPortReservations,
  resetEmulatorLaunchReservations,
  type EmulatorDeviceIdReservation,
  type EmulatorPortReservationDeps,
  type EmulatorPortReservations,
} from "./EmulatorPortReservations";
import {
  DefaultAndroidDeviceInventoryScanner,
  ANDROID_INVENTORY_AVD_LIST_CAP_MS,
  READINESS_NAME_TIMEOUT_MS,
  configuredAvdArchitecture,
  inventoryEnrichmentState,
  type AndroidDeviceInventoryDeps,
  type AndroidDeviceInventoryScanner,
  type BootedDeviceScan,
  type BootedDeviceScanOptions,
  type ReadinessDiagnostic,
} from "./AndroidDeviceInventoryScanner";
import {
  isUnknownEmulatorName,
  matchesRequestedAvdOrUnknown,
  nextReadinessNameCandidates,
  readinessDiagnostic,
  readinessTarget,
  readinessTimeoutError,
  rejectedReadinessDiagnostic,
  relevantScanDiagnostic,
  retryUnresolvedReadinessNames,
  unknownEmulatorName,
  unmetReadinessPredicate,
  type TargetReadinessState,
} from "./emulatorReadinessEvaluation";
import {
  DefaultEmulatorLauncher,
  type AndroidEmulatorLaunchOutcome,
  EmulatorExitedDuringReadinessError,
  boundedEmulatorOutputTail,
  type EmulatorLauncher,
  type EmulatorLauncherHost,
  type LaunchFailureCategory,
} from "./EmulatorLauncher";
export {
  EmulatorExitedDuringReadinessError,
  boundedEmulatorOutputTail,
  emulatorLaunchOutputSource,
  parseExtraEmulatorArguments,
  recordEmulatorLaunchOutputSource,
  resolveHeadlessMode,
  type AndroidEmulatorLaunchOutcome,
  type EmulatorLaunchOutputSource,
} from "./EmulatorLauncher";
export {
  ANDROID_INVENTORY_ENRICHMENT_TTL_MS,
  resetAndroidInventoryEnrichmentCache,
} from "./AndroidDeviceInventoryScanner";

export const EMULATOR_CONSOLE_KILL_BOUND_MS = 10_000;
interface EmulatorKillOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  force?: boolean;
  processStop?: { stopper: EmulatorProcessStopper; expectedAvdName?: string };
  /** Internal absolute deadline, set before discovery. */
  deadlineMs?: number;
}

const MODERN_PLAY_IMAGE_MIN_API_LEVEL = 30;
const ACCEL_CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_EMULATOR_POLLING_INTERVAL_MS = 500;
const MIN_EMULATOR_POLLING_INTERVAL_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_POLLING_SLEEP_CHUNK_MS = 500;
const READINESS_PROBE_TIMEOUT_MS = 10_000;
// A freshly-provisioned AVD's first cold boot can land its serial in ADB
// `offline` and stay there. This bounds a single re-detect recovery while
// normal readiness polling continues through the caller's full budget.
const FRESH_OFFLINE_RECOVERY_THRESHOLD_MS = 15_000;
const FRESH_OFFLINE_RECOVERY_COMMAND_TIMEOUT_MS = 5_000;
// Continue checking at a bounded cadence after recovery so a device that
// becomes ready before the deadline is observed despite a large configured interval.
const FRESH_OFFLINE_POST_RECOVERY_POLL_INTERVAL_MS = 5_000;
const PRIMARY_USER_UNLOCK_WAIT_MS = 5_000;
const PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS = 250;

interface OfflineTracker {
  deviceId: string | null;
  since: number | null;
  state?: TargetReadinessState;
  /** A bounded `adb -s <serial> reconnect` recovery has been dispatched during this readiness invocation (monotonic once set). */
  recoveryAttempted?: boolean;
}

interface EmulatorReadinessState {
  processExitError: ActionableError | null;
  foundDeviceId: string | null;
  foundEmulatorName: string;
  foundDeviceModel?: string;
  resolvedTargetDeviceId?: string;
  correlationFailure?: string;
  lastDiagnostic?: ReadinessDiagnostic;
}
interface EmulatorReadinessContext {
  avdName: string;
  timeoutMs: number;
  childProcess?: ChildProcess | null;
  targetDeviceId?: string;
  signal?: AbortSignal;
  options?: AndroidEmulatorReadinessOptions;
  startTime: number;
  perf: ReturnType<typeof createGlobalPerformanceTracker>;
  polling: ReadinessPollingState;
  state: EmulatorReadinessState;
  pollingIntervalMs: number;
  probedNameSerials: Set<string>;
  unresolvedNameSerials: Set<string>;
  offlineTracker: OfflineTracker;
}

interface ReadinessPollingState {
  active: boolean;
  failure?: unknown;
}

function outputFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return "";
}

function resolveEmulatorPollingInterval(value: string | undefined): number {
  const configuredInterval = Number(value);
  if (
    !Number.isFinite(configuredInterval) ||
    configuredInterval <= 0 ||
    configuredInterval > MAX_TIMER_DELAY_MS
  ) {
    return DEFAULT_EMULATOR_POLLING_INTERVAL_MS;
  }
  return Math.max(configuredInterval, MIN_EMULATOR_POLLING_INTERVAL_MS);
}

function resolveEmulatorLauncher(
  launcher: EmulatorLauncher | undefined,
  createHost: () => EmulatorLauncherHost,
): EmulatorLauncher {
  return launcher ?? new DefaultEmulatorLauncher(createHost());
}

function resolveInventoryScanner(
  inventory: AndroidDeviceInventoryScanner | undefined,
  createDeps: () => AndroidDeviceInventoryDeps,
): AndroidDeviceInventoryScanner {
  return inventory ?? new DefaultAndroidDeviceInventoryScanner(createDeps());
}

function resolveEmulatorPortReservations(
  reservations: EmulatorPortReservations | undefined,
  deps: EmulatorPortReservationDeps,
): EmulatorPortReservations {
  return reservations ?? new DefaultEmulatorPortReservations(deps);
}

function resolveConsoleBusyRegistry(
  registry: EmulatorConsoleBusyRegistry | undefined,
): EmulatorConsoleBusyRegistry {
  return registry ?? defaultEmulatorConsoleBusyRegistry;
}

function resolveEmulatorExecAsync(
  execAsyncFn: ((file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>) | null,
): (file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult> {
  return execAsyncFn || execAsync;
}

/**
 * Interface for Android Emulator (AVD) management
 * Provides emulator lifecycle and control capabilities
 */
export interface AndroidEmulatorLaunchRequest {
  /** Host still image used as the virtual-scene back-camera wall poster at boot. */
  cameraPosterPath?: string;
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
  /**
   * Boot admission (#11181), awaited only on the cold-spawn path: after the
   * in-process join and the already-running/starting adoption checks, so
   * adopting a running AVD is never refused for capacity.
   */
  admitColdBoot?: AdmitColdBoot;
}

/** Optional readiness behavior for callers recovering an existing guest state. */
export interface AndroidEmulatorReadinessOptions {
  /** Preserve the guest's restored display and keyguard state instead of waking it. */
  skipWakeAndUnlock?: boolean;
  /**
   * The device was just created by a fresh provision, so its first boot is a
   * genuine cold boot (no quick-boot snapshot to restore). When its serial sits
   * in ADB `offline` past a bounded threshold, attempt one `adb -s <serial> reconnect`
   * re-detect, then continue readiness polling through the caller's
   * timeout. A quick-boot-after-shutdown restore leaves this unset and skips
   * that recovery attempt.
   */
  freshProvision?: boolean;
}

export interface AndroidEmulatorLaunchHandle {
  readonly avdName: string;
  readonly process: ChildProcess | null;
  readonly outcome: AndroidEmulatorLaunchOutcome;
  readonly targetDeviceId?: string;
  /** Stops the emulator only when this launch created its process. */
  dispose(): void;
}

export interface AndroidEmulator {
  /**
   * Execute an emulator command
   * @param command - The command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @param signal - Optional caller abort; kills the child alongside the timeout
   * @returns Promise with stdout and stderr
   */
  executeCommand(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;

  /**
   * List all available AVDs
   * @param options - Optional deadline/abort for the `-list-avds` child (#7008)
   * @returns Promise with array of AVD names
   */
  listAvds(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    coalesceInventoryEnrichment?: boolean;
  }): Promise<DeviceInfo[]>;

  /**
   * Check if a specific AVD is running
   * @param avdName - The AVD name to check
   * @returns Promise with boolean indicating if the AVD is running
   */
  isAvdRunning(avdName: string, options?: { bypassDeviceListCache?: boolean }): Promise<boolean>;

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
  getBootedDevices(
    onlyEmulators?: boolean,
    options?: { bypassDeviceListCache?: boolean },
  ): Promise<BootedDevice[]>;

  /** Resolve the AVD name from one runtime serial without scanning all devices. */
  resolveAvdNameForSerial(
    serial: string,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<string | undefined>;

  /**
   * Start an emulator with the specified AVD
   * @param avdName - The AVD name to start
   * @returns Promise with the spawned child process
   */
  startEmulator(avdName: string): Promise<ChildProcess | null>;

  /** Launch an AVD with structured context and an owned lifecycle handle. */
  launchEmulator(request: AndroidEmulatorLaunchRequest): Promise<AndroidEmulatorLaunchHandle>;

  /**
   * Request termination of the expected running emulator.
   * @param device - The device to kill
   * @param options - `force` drops the AVD-name comparison against the fresh
   *   discovery, for a caller that has already decided to act on whatever
   *   occupies the serial (#6864). Serial selection is not part of that: a
   *   serial with nothing on it still refuses.
   * @returns The checked target after ADB accepts termination; callers confirm disappearance.
   */
  killDevice(device: BootedDevice, options?: EmulatorKillOptions): Promise<BootedDevice>;

  /**
   * Wait for the emulator to be ready for use
   * @param avdName - The AVD name to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120000 = 2 minutes)
   * @param childProcess - Optional child process to monitor for early exit
   * @param targetDeviceId - Optional adb device id to require when waiting for an already-running device
   * @returns Promise that resolves with device ID when emulator is ready
   */
  waitForEmulatorReady(
    avdName: string,
    timeoutMs?: number,
    childProcess?: ChildProcess | null,
    targetDeviceId?: string,
    signal?: AbortSignal,
    options?: AndroidEmulatorReadinessOptions,
  ): Promise<BootedDevice>;
}

/** The Android emulator operations used by MultiPlatformDeviceManager. */
export interface AndroidEmulatorForDeviceManager extends Pick<
  AndroidEmulatorClient,
  | "listAvds"
  | "getBootedDevicesChecked"
  | "getBootedDevices"
  | "getOfflineDeviceIdsAmong"
  | "getListedNonDeviceStatesAmong"
  | "recoverOfflineDevices"
  | "launchEmulator"
  | "killDevice"
  | "waitForEmulatorReady"
> {}

/** Any failure of a launch the caller cancelled is reported as that cancellation, with the spawned child. */
function asLaunchCancellation(
  avdName: string,
  error: unknown,
  process: ChildProcess | null,
): EmulatorLaunchCancelledError {
  return error instanceof EmulatorLaunchCancelledError
    ? error
    : new EmulatorLaunchCancelledError(avdName, process);
}

function shouldCaptureEmulatorReservationSnapshot(deviceId: string | undefined): boolean {
  return deviceId === undefined || deviceId.startsWith("emulator-");
}

// Route the default long-lived spawn through the shared host-process seam so the
// client no longer reaches for `child_process.spawn` directly (issue #5459). The
// executor's `spawn` is a plain passthrough, so this is behavior-identical; all
// of AndroidEmulatorClient's own reservation/launch orchestration is unchanged.
const emulatorHostProcessExecutor: HostProcessExecutor = new DefaultHostCommandExecutor();

// Route the execFile leg through the shared exec seam (issue #5459) so the option
// mapping and the Buffer→string / trim / includes coercion live in one place and
// this wrapper no longer reaches for `child_process` on its exec path. Argv (no
// shell) means AVD names are passed literally instead of being interpreted/split
// by a shell (issue #3938), and the AbortSignal is forwarded so a timed-out
// command kills its child instead of leaving it running orphaned.
//
// `preserveError: true` keeps the raw execFile rejection intact: callers here
// historically observed node's original error (with its `.code`/`.stderr`), and
// the seam's default `wrapCommandError` would drop those fields.
const execAsync = async (
  file: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ExecResult> => {
  return runExecSeam(
    (execOptions) => sharedExecFileAsync(file, args, execOptions),
    { signal },
    { command: file, args },
    { preserveError: true },
  );
};

// Keep the runtime API typed locally; this project does not include Bun's ambient types.
declare const Bun: { which(name: string): string | null };

/** Offline discovery failed; callers must retain the prior episode state. */
export class AndroidOfflineProbeError extends ActionableError {}

export class AndroidEmulatorUnavailableError extends ActionableError {}

/** Classify spawn failures without mistaking a running/stopped process for missing tooling. */
export function isMissingExecutableError(
  error: unknown,
  resolvedPath: string,
  executableExists: boolean,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const failure = error as Error & {
    code?: string | number;
    path?: string;
    killed?: boolean;
    signal?: string | null;
  };
  return (
    failure.code === "ENOENT" &&
    !failure.killed &&
    !failure.signal &&
    !["AbortError", "TimeoutError"].includes(failure.name) &&
    (failure.path === undefined || failure.path === resolvedPath) &&
    !executableExists
  );
}

export class AndroidEmulatorClient implements AndroidEmulator, AndroidEmulatorForDeviceManager {
  private execAsync: (file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  private spawnFn: SpawnFn;
  private emulatorPath: string;
  private timer: Timer;
  private adbFactory: AdbClientFactory;
  private avdConfigReader: AvdConfigReader;
  private platform: NodeJS.Platform;
  private hostArchitecture: string;
  private readonly hostPortAvailabilityChecker: PortAvailabilityChecker;
  private readonly runningAvdAdvertisementReader: RunningAvdAdvertisementReader;
  private readonly consoleBusyRegistry: EmulatorConsoleBusyRegistry;
  private readonly launchTargetDeviceIds = new WeakMap<ChildProcess, string>();
  private readonly reservations: EmulatorPortReservations;
  private readonly inventory: AndroidDeviceInventoryScanner;
  private readonly launcher: EmulatorLauncher;
  private readonly launchErrors = new WeakMap<ChildProcess, ActionableError>();
  private readonly launchErrorFinalizations = new WeakMap<
    ChildProcess,
    Promise<ActionableError | undefined>
  >();

  /**
   * Create an AndroidEmulatorClient instance
   * @param execAsyncFn - promisified exec function (for testing)
   * @param spawnFn - spawn function (for testing)
   * @param timer - Timer for delays
   * @param adbFactory - Factory for creating AdbClient instances (for testing)
   * @param avdConfigReader - Reader for AVD config.ini files (for testing)
   * @param platform - Host platform (for testing)
   * @param hostArchitecture - Host CPU architecture (for testing)
   * @param hostPortAvailabilityChecker - Checks whether emulator ports are free (for testing)
   * @param consoleBusyRegistry - Tracks daemon-owned console-exclusive operations (for testing)
   * @param observationSequence - Orders completed device discovery observations (for testing)
   */
  constructor(
    execAsyncFn:
      | ((file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>)
      | null = null,
    spawnFn: SpawnFn | null = null,
    timer: Timer = defaultTimer,
    // Below the admission gate, not behind it: discovery reading the AVD name on
    // a quarantined serial is the only event that can LIFT the quarantine, and
    // `emu kill` on one is how the pool settles a serial it can no longer
    // identify ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    adbFactory: AdbClientFactory = unadmittedAdbClientFactory,
    avdConfigReader?: AvdConfigReader,
    platform: NodeJS.Platform = process.platform,
    hostArchitecture: string = arch(),
    hostPortAvailabilityChecker: PortAvailabilityChecker = AndroidEmulatorClient.defaultHostPortAvailabilityChecker(),
    runningAvdAdvertisementReader: RunningAvdAdvertisementReader = new TmpdirRunningAvdAdvertisementReader(),
    consoleBusyRegistry?: EmulatorConsoleBusyRegistry,
    private readonly observationSequence: DiscoveryObservationSequence = defaultDiscoveryObservationSequence,
    private readonly posterFileSystem?: Pick<FileSystem, "existsSync">,
    reservations?: EmulatorPortReservations,
    inventory?: AndroidDeviceInventoryScanner,
    launcher?: EmulatorLauncher,
  ) {
    this.execAsync = resolveEmulatorExecAsync(execAsyncFn);
    this.spawnFn =
      spawnFn || ((file, args, options) => emulatorHostProcessExecutor.spawn(file, args, options));
    this.timer = timer;
    this.adbFactory = adbFactory;
    this.avdConfigReader = avdConfigReader ?? new FileAvdConfigReader();
    this.platform = platform;
    this.hostArchitecture = hostArchitecture;
    this.hostPortAvailabilityChecker = hostPortAvailabilityChecker;
    this.runningAvdAdvertisementReader = runningAvdAdvertisementReader;
    this.consoleBusyRegistry = resolveConsoleBusyRegistry(consoleBusyRegistry);
    this.inventory = resolveInventoryScanner(inventory, () => this.createInventoryDeps());
    this.launcher = resolveEmulatorLauncher(launcher, () => this.createLauncherHost());
    this.reservations = resolveEmulatorPortReservations(reservations, {
      timer: () => this.timer,
      adbFactory: () => this.adbFactory,
      hostPortAvailabilityChecker: () => this.hostPortAvailabilityChecker,
    });
    // Only set a fallback emulator path here; proper detection happens lazily
    this.emulatorPath = this.getFallbackEmulatorPath();
  }

  private createLauncherHost(): EmulatorLauncherHost {
    // Every member resolves through the client at call time, so reassigned fields and patched
    // methods (the stderr classifiers stay here) still take effect.
    return {
      reservations: () => this.reservations,
      timer: () => this.timer,
      emulatorPath: () => this.emulatorPath,
      spawnFn: () => this.spawnFn,
      platform: () => this.platform,
      avdConfigReader: () => this.avdConfigReader,
      launchErrors: () => this.launchErrors,
      launchErrorFinalizations: () => this.launchErrorFinalizations,
      launchTargetDeviceIds: () => this.launchTargetDeviceIds,
      accelerationCheckCategory: (output) => this.accelerationCheckCategory(output),
      adoptsExistingAvdLaunch: (avdName, perf, signal) =>
        this.adoptsExistingAvdLaunch(avdName, perf, signal),
      appendCategory: (error, category) => this.appendCategory(error, category),
      assertCameraPosterColdBoot: (posterPath) => this.assertCameraPosterColdBoot(posterPath),
      captureLaunchTargetDeviceId: (childProcess, output) =>
        this.captureLaunchTargetDeviceId(childProcess, output),
      checkArchitectureCompatibility: (avdName, avdConfig) =>
        this.checkArchitectureCompatibility(avdName, avdConfig),
      detectArchitecturePanic: (output) => this.detectArchitecturePanic(output),
      detectCorruptImage: (output) => this.detectCorruptImage(output),
      detectDisplayError: (output) => this.detectDisplayError(output),
      emulatorAudioArguments: () => this.emulatorAudioArguments(),
      formatEarlyExitError: (avdName, code, signal, category, output, accelCheckOutput) =>
        this.formatEarlyExitError(avdName, code, signal, category, output, accelCheckOutput),
      launchFailureCategory: (output) => this.launchFailureCategory(output),
      listAvds: (options) => this.listAvds(options),
      recordReservedEmulatorDeviceId: (childProcess, reservation) =>
        this.recordReservedEmulatorDeviceId(childProcess, reservation),
      releaseReservationIfLaunchCancelled: (avdName, reservation, isCancelled) =>
        this.releaseReservationIfLaunchCancelled(avdName, reservation, isCancelled),
      runAccelerationCheck: () => this.runAccelerationCheck(),
      sandboxFailure: (output) => this.sandboxFailure(output),
      throwIfLaunchCancelled: (avdName, isCancelled) =>
        this.throwIfLaunchCancelled(avdName, isCancelled),
      validateAvdMemory: (avdName, avdConfig) => this.validateAvdMemory(avdName, avdConfig),
    };
  }

  private createInventoryDeps(): AndroidDeviceInventoryDeps {
    return {
      timer: () => this.timer,
      adbFactory: () => this.adbFactory,
      observationSequence: () => this.observationSequence,
      avdConfigReader: () => this.avdConfigReader,
      getRunningAvdName: (device, infoTimeoutMs, signal) =>
        this.getRunningAVDName(device, infoTimeoutMs, signal),
      isUnknownEmulatorName,
      unknownEmulatorName,
      throwIfAborted: (signal) => this.throwIfReadinessAborted(signal),
    };
  }

  private static defaultHostPortAvailabilityChecker(): PortAvailabilityChecker {
    return testOverrides.hostPortAvailabilityChecker ?? new BunPortAvailabilityChecker();
  }

  static resetLaunchReservationsForTesting(): void {
    resetEmulatorLaunchReservations();
  }

  static setHostPortAvailabilityCheckerForTesting(
    checker: PortAvailabilityChecker | undefined,
  ): void {
    testOverrides.hostPortAvailabilityChecker = checker;
  }

  /**
   * Get the path to the emulator executable.
   * This function tries the best available path synchronously, falling back to env/PATH.
   * Actual async detection is performed when needed by ensureEmulatorPath().
   * @returns The path to the emulator
   */
  private getFallbackEmulatorPath(): string {
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
  private async tryMultiplePaths(): Promise<string | null> {
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
   * Enrich a list of DeviceInfo with config.ini metadata (osVersion, screen size, form factor)
   */
  private async enrichDeviceInfoList(devices: DeviceInfo[]): Promise<DeviceInfo[]> {
    const enriched = await Promise.all(
      devices.map(async (device) => {
        try {
          const config = await this.avdConfigReader.readConfig(device.name);
          if (!config) {
            return device;
          }
          const formFactor = androidProfileFormFactor({
            profileId: config.deviceName,
            width: config.screenWidth,
            height: config.screenHeight,
            density: config.screenDensity,
          });
          return this.deviceInfoFromConfig(device, config, formFactor);
        } catch (error) {
          logger.debug(`Failed to enrich AVD ${device.name}: ${error}`);
          return device;
        }
      }),
    );
    return enriched;
  }

  private deviceInfoFromConfig(
    device: DeviceInfo,
    config: AvdConfig,
    formFactor: ReturnType<typeof androidProfileFormFactor>,
  ): DeviceInfo {
    return {
      ...device,
      apiLevel: config.apiLevel ?? device.apiLevel,
      osVersion: config.osVersion ?? device.osVersion,
      runtimeId: config.systemImagePackage ?? device.runtimeId,
      deviceType: config.deviceName ?? device.deviceType,
      architecture: configuredAvdArchitecture(config, device.architecture),
      screenWidth: config.screenWidth ?? device.screenWidth,
      screenHeight: config.screenHeight ?? device.screenHeight,
      screenDensity: config.screenDensity ?? device.screenDensity,
      formFactor: formFactor === "unknown" ? device.formFactor : formFactor,
      capabilityInventory: config.capabilityInventory ?? device.capabilityInventory,
    };
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
    return (
      (lowerError.includes("enoent") && lowerError.includes("spawn")) ||
      lowerError.includes("getcwd") ||
      lowerError.includes("current working directory") ||
      lowerError.includes("current directory")
    );
  }

  /**
   * Get the host architecture
   * @returns The host architecture string
   */
  private getHostArchitecture(): string {
    return this.hostArchitecture;
  }

  /**
   * Check if an AVD architecture is compatible with the host
   * @param avdName - The AVD name to check
   * @returns Promise with compatibility result
   */
  private async checkArchitectureCompatibility(
    avdName: string,
    avdConfig?: AvdConfig | null,
  ): Promise<{
    compatible: boolean;
    hostArch: string;
    avdArch?: string;
    reason?: string;
  }> {
    const hostArch = this.getHostArchitecture();

    try {
      const config =
        avdConfig === undefined ? await this.avdConfigReader.readConfig(avdName) : avdConfig;
      const avdArch = config?.architecture;
      if (!avdArch) {
        // Missing config metadata is non-fatal; the launch attempt provides definitive diagnostics.
        return {
          compatible: true,
          hostArch,
          reason: "Could not determine AVD architecture, allowing attempt",
        };
      }

      // Check compatibility
      const compatible = this.isArchitectureCompatible(hostArch, avdArch);
      const reason = compatible
        ? undefined
        : `Host architecture '${hostArch}' cannot run AVD with architecture '${avdArch}'`;

      return { compatible, hostArch, avdArch, reason };
    } catch (error) {
      // If we can't check, we'll let the emulator start attempt proceed and catch errors there
      logger.debug(`Could not check architecture compatibility for ${avdName}: ${error}`);
      return {
        compatible: true,
        hostArch,
        reason: "Could not verify compatibility, allowing attempt",
      };
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
    if (
      (hostArch === "arm64" || hostArch === "aarch64") &&
      (avdArch === "x86" || avdArch === "x86_64")
    ) {
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
    avdArch?: string;
  } {
    // Look for the specific PANIC message about architecture compatibility
    const panicMatch = output.match(
      /PANIC: Avd's CPU Architecture '(\w+)' is not supported by the QEMU2 emulator on (\w+) host/,
    );

    if (panicMatch) {
      const avdArch = panicMatch[1];
      const hostArch = panicMatch[2];
      return {
        isPanic: true,
        message: `AVD architecture '${avdArch}' is not supported on ${hostArch} host`,
        hostArch,
        avdArch,
      };
    }

    // Check for other PANIC messages that might be architecture-related
    if (
      output.includes("PANIC:") &&
      (output.includes("architecture") || output.includes("CPU") || output.includes("QEMU"))
    ) {
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
    const mprotectFailure = /qemu_mprotect__osdep:\s*mprotect failed:\s*permission denied/i.test(
      output,
    );
    const hvfFailure =
      /hvf is not enabled on this aarch64 host|HVF error:\s*HV_(?:UNSUPPORTED|ERROR)|failed to initialize HVF:\s*Invalid argument/i.test(
        output,
      );
    if (!mprotectFailure && !hvfFailure) {
      return { isSandboxError: false };
    }

    return {
      isSandboxError: true,
      message: "Emulator hypervisor initialization failed (mprotect/HVF is unavailable)",
      suggestion:
        "Run the emulator outside the restrictive sandbox or grant the host hypervisor/JIT entitlement required by QEMU.",
    };
  }

  private sandboxFailure(output: string): ActionableError | null {
    const result = this.detectSandboxMprotect(output);
    if (!result.isSandboxError) {
      return null;
    }
    return new ActionableError(
      [
        `Emulator failed to start: ${result.message}`,
        result.suggestion ? `Suggestion: ${result.suggestion}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  private validateAvdMemory(avdName: string, avdConfig: AvdConfig | null): void {
    if (!avdConfig) {
      return;
    }
    const isModernPlayImage =
      avdConfig.tag?.toLowerCase().includes("play") &&
      (avdConfig.apiLevel ?? 0) >= MODERN_PLAY_IMAGE_MIN_API_LEVEL;
    if (isModernPlayImage && avdConfig.ramSizeInvalid) {
      throw new ActionableError(
        `Cannot start AVD '${avdName}': hw.ramSize is invalid. Use a whole number in MB or a K, M, or G size suffix and retry.`,
      );
    }
    if (
      isModernPlayImage &&
      avdConfig.ramSizeMb !== undefined &&
      avdConfig.ramSizeMb < MIN_AVD_RAM_MB
    ) {
      throw new ActionableError(
        `Cannot start AVD '${avdName}': hw.ramSize is ${avdConfig.ramSizeMb} MB, below the minimum ${MIN_AVD_RAM_MB} MB needed for a modern system image. Increase hw.ramSize in the AVD config and retry.`,
      );
    }
  }

  /**
   * Clear only the CURRENT OBSERVATION on the offline tracker (device serial,
   * offline-since, and last observed state). Used when there is no target serial
   * and when a device-state probe rejects/omits the target, so a stale offline
   * reading cannot drive recovery off out-of-date data (#7054).
   *
   * `recoveryAttempted` is deliberately NOT reset: it is MONOTONIC for the
   * lifetime of a single `waitForEmulatorReady` invocation. A probe gap after
   * the one-shot `adb -s <serial> reconnect` has been dispatched must not wipe that
   * history, or a later re-confirmed offline would issue a SECOND reconnect.
   */
  private clearOfflineTracker(tracker: OfflineTracker): void {
    tracker.deviceId = null;
    tracker.since = null;
    tracker.state = undefined;
  }

  private async detectOfflineFailure(
    deviceId: string | undefined,
    tracker: OfflineTracker,
    timeoutMs?: number,
    signal?: AbortSignal,
    observedStates?: AdbDeviceState[],
  ): Promise<ActionableError | null> {
    let states: AdbDeviceState[];
    try {
      states =
        observedStates ??
        (await this.adbFactory.create(null).getDeviceStates?.({ timeoutMs, signal })) ??
        [];
    } catch (error) {
      this.throwIfReadinessAborted(signal);
      // Auxiliary diagnostic probe; a failure here must not block readiness polling.
      logger.debug(
        `Offline-state probe unavailable during emulator readiness: ${errorMessage(error)}`,
      );
      // A rejected probe is NOT a current offline observation. Clear the tracker
      // so both the reconnect dispatch and the fail-fast wait for a fresh,
      // successful observation that still shows offline; a run of failed probes
      // must not by itself satisfy the offline-failure threshold (#7054).
      this.clearOfflineTracker(tracker);
      return null;
    }
    if (!deviceId) {
      this.clearOfflineTracker(tracker);
      return null;
    }
    const targetState = states.find((state: AdbDeviceState) => state.deviceId === deviceId);
    tracker.state = this.targetReadinessState(targetState);
    if (targetState?.state !== "offline") {
      tracker.deviceId = null;
      tracker.since = null;
      return null;
    }
    if (tracker.deviceId !== targetState.deviceId) {
      // Refresh the current observation for a (re-)observed offline serial.
      // Recovery history stays monotonic for the invocation, so a re-confirmed
      // offline after the one-shot reconnect keeps advancing toward the
      // fail-fast instead of resurrecting a second reconnect (#7054).
      tracker.deviceId = targetState.deviceId;
      tracker.since = this.timer.now();
    }
    // An offline ADB state is transient during normal emulator startup. Keep
    // tracking it for diagnostics, but wait for the caller's readiness deadline
    // unless the emulator process provides definitive failure evidence.
    return null;
  }

  /**
   * Bounded recovery for a fresh-provision cold boot whose serial is stuck in
   * ADB `offline`. Runs at most one `adb -s <serial> reconnect` re-detect once the
   * serial has been offline past {@link FRESH_OFFLINE_RECOVERY_THRESHOLD_MS}.
   * The recovery never terminates readiness: normal polling continues until the
   * caller's deadline or a terminal emulator failure (issue #7078).
   */
  private async maybeRecoverFreshOffline(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
    startTime: number,
    timeoutMs: number,
    context: { avdName: string; signal: AbortSignal | undefined },
  ): Promise<void> {
    const { avdName, signal } = context;
    if (!this.isFreshOfflineEpisode(tracker, options, deviceId)) {
      return;
    }
    const now = this.timer.now();
    const remainingMs = timeoutMs - (now - startTime);
    if (remainingMs <= 0) {
      return;
    }
    const offlineSince = tracker.since ?? now;

    if (!tracker.recoveryAttempted) {
      if (now - offlineSince >= FRESH_OFFLINE_RECOVERY_THRESHOLD_MS) {
        await this.dispatchFreshOfflineReconnect(
          tracker,
          deviceId!,
          now,
          offlineSince,
          remainingMs,
          { avdName, signal },
        );
      }
    }
  }

  /** True while a fresh-provision target is actively sitting in ADB `offline`. */
  private isFreshOfflineEpisode(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
  ): boolean {
    return (
      options?.freshProvision === true &&
      Boolean(deviceId) &&
      tracker.state === "offline" &&
      tracker.since !== null
    );
  }

  private nextPollingDelayMs(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
    now: number,
    pollingIntervalMs: number,
    remainingPollingTimeMs: number,
  ): number {
    const currentDelayMs = Math.min(pollingIntervalMs, remainingPollingTimeMs);
    // After the one-shot recovery, keep polling at this cadence for the rest
    // of a fresh boot. The serial can leave `offline` before Android itself is ready.
    if (options?.freshProvision === true && tracker.recoveryAttempted) {
      return Math.min(currentDelayMs, FRESH_OFFLINE_POST_RECOVERY_POLL_INTERVAL_MS);
    }
    if (!this.isFreshOfflineEpisode(tracker, options, deviceId)) {
      return currentDelayMs;
    }
    const thresholdAt = (tracker.since ?? now) + FRESH_OFFLINE_RECOVERY_THRESHOLD_MS;
    const timeUntilThresholdMs = Math.max(0, thresholdAt - now);
    const thresholdDelayMs = Math.max(
      MIN_EMULATOR_POLLING_INTERVAL_MS,
      Math.min(currentDelayMs, timeUntilThresholdMs),
    );
    return Math.min(currentDelayMs, thresholdDelayMs);
  }

  /** Dispatch the single bounded `adb -s <serial> reconnect` re-detect for a stuck fresh boot. */
  private async dispatchFreshOfflineReconnect(
    tracker: OfflineTracker,
    deviceId: string,
    now: number,
    offlineSince: number,
    remainingMs: number,
    context: { avdName: string; signal: AbortSignal | undefined },
  ): Promise<void> {
    const { avdName, signal } = context;
    tracker.recoveryAttempted = true;
    const commandTimeoutMs = Math.max(
      0,
      Math.min(FRESH_OFFLINE_RECOVERY_COMMAND_TIMEOUT_MS, remainingMs),
    );
    logger.warn(
      `Fresh provision '${avdName}' target ${deviceId} has been ADB-offline for ` +
        `${now - offlineSince}ms; attempting 'adb -s ${deviceId} reconnect' recovery`,
    );
    try {
      await this.issueReconnectOffline(deviceId, commandTimeoutMs, signal);
    } catch (error) {
      this.throwIfReadinessAborted(signal);
      // Best-effort recovery: readiness polling continues through its deadline.
      logger.warn(
        `'adb -s ${deviceId} reconnect' recovery for ${deviceId} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Issue exactly one adb -s <serial> reconnect re-detect. Shared by the
   * fresh-provision readiness recovery ({@link dispatchFreshOfflineReconnect})
   * and the disconnect monitor's in-session offline recovery
   * ({@link recoverOfflineDevices}, #7536): noRetry keeps the real AdbClient
   * from routing this through its retry executor (up to MAX_ADB_RETRIES + 1
   * executions), so one logical recovery issues exactly one reconnect command
   * (#7054).
   */
  private async issueReconnectOffline(
    deviceId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ) {
    await this.adbFactory
      .create(null)
      .execute(["-s", deviceId, "reconnect"], { timeoutMs, noRetry: true, signal });
  }

  /**
   * Among the given candidate serials, which ones adb devices -l currently
   * reports as ADB offline rather than absent. Used by the disconnect
   * monitor to distinguish an in-session emulator that dropped its transport
   * from one that is genuinely gone (#7536): both look identical to the
   * online-only getBootedDevices filter.
   *
   * Probe failures throw AndroidOfflineProbeError so callers can distinguish
   * unavailable evidence from an authoritative empty result.
   */
  async getOfflineDeviceIdsAmong(
    candidateIds: Iterable<string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Set<string>> {
    const listed = await this.getListedNonDeviceStatesAmong(candidateIds, options);
    return new Set([...listed].filter(([, state]) => state === "offline").map(([id]) => id));
  }

  /**
   * Among the given candidate serials, every one adb devices -l lists in a
   * state other than `device` (offline, authorizing, connecting,
   * unauthorized, recovery, bootloader, sideload, no permissions), keyed to
   * that state. A listed serial is still attached even though the online-only
   * getBootedDevices filter drops it, so the disconnect monitor must not treat
   * it as unplugged (#11090).
   *
   * Probe failures throw AndroidOfflineProbeError so callers can distinguish
   * unavailable evidence from an authoritative empty result.
   */
  async getListedNonDeviceStatesAmong(
    candidateIds: Iterable<string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Map<string, string>> {
    const candidates = new Set(candidateIds);
    if (candidates.size === 0) {
      return new Map();
    }
    let states: AdbDeviceState[];
    try {
      // The candidates are devices this host held, so adb existed: an executable that has since
      // vanished (replaced mid-upgrade) is a probe that could not ask, never "listed nowhere"
      // (#11643). Callers with no candidates return above and never reach a missing adb.
      states =
        (await this.adbFactory
          .create(null)
          .getDeviceStates?.({ ...options, throwOnMissingAdb: true })) ?? [];
    } catch (error) {
      throw new AndroidOfflineProbeError(`Device-state probe failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return new Map(
      states
        .filter((state) => state.state !== "device" && candidates.has(state.deviceId))
        .map((state) => [state.deviceId, state.state]),
    );
  }

  /**
   * Bounded, best-effort recovery for session-bound serial(s) the disconnect
   * monitor observed stuck in ADB offline (#7536). Each distinct serial gets
   * one host-serial reconnect, accepted even for an offline transport. Dispatch
   * concurrently so the sweep stays bounded by a single command timeout.
   * Never throws except on abort: a serial's recovery failure must not prevent
   * recovery of the others or fail the disconnect monitor's sweep.
   */
  async recoverOfflineDevices(
    deviceIds: Iterable<string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    this.throwIfReadinessAborted(options.signal);
    const timeoutMs = options.timeoutMs ?? FRESH_OFFLINE_RECOVERY_COMMAND_TIMEOUT_MS;
    await Promise.all(
      [...new Set(deviceIds)].map(async (deviceId) => {
        try {
          await this.issueReconnectOffline(deviceId, timeoutMs, options.signal);
        } catch (error) {
          this.throwIfReadinessAborted(options.signal);
          // Best-effort recovery: other serials and the disconnect sweep continue.
          logger.warn(
            `'adb -s ${deviceId} reconnect' recovery for in-session offline device failed: ${errorMessage(error)}`,
            error,
          );
        }
      }),
    );
    this.throwIfReadinessAborted(options.signal);
  }

  private targetReadinessState(targetState: AdbDeviceState | undefined): TargetReadinessState {
    if (targetState?.state === "offline") {
      return "offline";
    }
    return targetState === undefined ? "absent" : "not-ready";
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
        suggestion:
          "Delete the corrupt userdata overlay to force a fresh image:\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img.qcow2\nThe emulator will recreate it on next boot. All emulator data (installed apps, settings) will be lost.",
      };
    }

    // Generic disk image errors
    const diskErrorMatch = output.match(
      /(cannot open disk image|disk image .* is (?:corrupt|invalid|damaged)|failed to open .*\.img)/i,
    );
    if (diskErrorMatch) {
      return {
        isCorrupt: true,
        message: `Disk image error: ${diskErrorMatch[1].trim()}`,
        suggestion:
          "Try deleting corrupt overlay files in ~/.android/avd/<AVD_NAME>.avd/ and restarting the emulator.",
      };
    }

    // QEMU abnormal exit with corruption context
    if (
      output.includes("QEMU main loop exits abnormally") &&
      (output.includes("corrupt") || output.includes("qcow2"))
    ) {
      return {
        isCorrupt: true,
        message: "QEMU exited abnormally due to disk image corruption",
        suggestion:
          "Delete the corrupt userdata overlay to force a fresh image:\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img.qcow2\nThe emulator will recreate it on next boot.",
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
        message:
          "Emulator could not connect to a display (Qt 'xcb' platform plugin failed to load)",
        suggestion:
          "Run the emulator headless by setting AUTOMOBILE_EMULATOR_HEADLESS=true " +
          "(adds -no-window -no-audio), or start an X server / export DISPLAY before launching.",
      };
    }

    return { isDisplayError: false };
  }

  private launchFailureCategory(output: string): LaunchFailureCategory | undefined {
    if (/error while loading shared libraries/i.test(output)) {
      return "missing_shared_library";
    }
    if (
      /ProbeKVM[\s\S]*(?:permission denied|operation not permitted)/i.test(output) ||
      /\/dev\/kvm[\s\S]*(?:permission denied|operation not permitted)/i.test(output) ||
      /permissions? to use KVM/i.test(output)
    ) {
      return "kvm_permission_denied";
    }
    return undefined;
  }

  private accelerationCheckCategory(output: string): LaunchFailureCategory | undefined {
    const kvmCategory = this.launchFailureCategory(output);
    if (kvmCategory) {
      return kvmCategory;
    }
    if (
      /(?:acceleration|KVM|hypervisor)/i.test(output) &&
      /(?:not available|unavailable|not supported|not enabled|cannot use|disabled)/i.test(output)
    ) {
      return "hardware_acceleration_unavailable";
    }
    return undefined;
  }

  private appendCategory(error: ActionableError, category: LaunchFailureCategory): ActionableError {
    return new ActionableError(`${error.message}\n\ncategory=${category}`);
  }

  private formatEarlyExitError(
    avdName: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    category: LaunchFailureCategory | undefined,
    output: string,
    accelCheckOutput: string,
  ): ActionableError {
    const header = [
      `Emulator process exited with code: ${code}${signal ? ` (signal: ${signal})` : ""} (AVD '${avdName}'`,
      category ? `; category=${category}` : "",
      ")",
    ].join("");
    const sections = [
      header,
      output.trim() ? `Diagnostic:\n${output.trim()}` : "",
      accelCheckOutput.trim() ? `emulator -accel-check:\n${accelCheckOutput.trim()}` : "",
    ].filter(Boolean);
    return new ActionableError(sections.join("\n"));
  }

  private diagnosticOutputFromError(error: unknown): string {
    if (typeof error !== "object" || error === null) {
      return "";
    }
    const output = error as { stdout?: unknown; stderr?: unknown };
    return boundedEmulatorOutputTail(
      redactAndroidCommandOutput(
        [outputFromUnknown(output.stdout), outputFromUnknown(output.stderr)]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  }

  private runAccelerationCheck(): Promise<string> {
    // Diagnostic `emulator -accel-check` probe (up to a 3s bound) run on an
    // inconclusive cold-boot failure. It bypasses the executeCommand funnel, so
    // give it its own ambient leaf — wrapped around the whole method, outside
    // its internal Promise.race, so the added async turn can't perturb the
    // race's FakeTimer timing (see PerfContext).
    return trackAmbient("emulator -accel-check", () => this.runAccelerationCheckInner());
  }

  private async runAccelerationCheckInner(): Promise<string> {
    const controller = new AbortController();
    const probe = Promise.resolve()
      .then(() => this.execAsync(this.emulatorPath, ["-accel-check"], controller.signal))
      .then(
        (result) =>
          boundedEmulatorOutputTail(
            redactAndroidCommandOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
          ),
        (error) => this.diagnosticOutputFromError(error),
      );
    const timedOut = Symbol("emulator acceleration timeout");
    try {
      return await raceWithDeadline(probe, {
        timer: this.timer,
        timeoutMs: ACCEL_CHECK_TIMEOUT_MS,
        label: "Emulator acceleration check",
        timeoutError: () => {
          controller.abort();
          return timedOut;
        },
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      logger.debug(`Emulator acceleration check timed out after ${ACCEL_CHECK_TIMEOUT_MS}ms`);
      return "";
    }
  }

  /**
   * Execute an emulator command
   * @param command - The command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with stdout and stderr
   */
  executeCommand(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult> {
    // One span per `emulator <verb>` CLI invocation (e.g. `emulator -list-avds`
    // AVD discovery), recorded against the ambient device-lifecycle tracker when
    // one is in scope (see PerfContext).
    return trackAmbient(`emulator ${args.slice(0, 1).join(" ")}`.trimEnd(), () =>
      this.executeCommandInner(args, timeoutMs, signal),
    );
  }

  private async executeCommandInner(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const emulatorPath = await this.ensureEmulatorPath();
    const fullCommand = `${emulatorPath} ${args.join(" ")}`;
    logger.debug(`Executing emulator command: ${fullCommand}`);

    // On timeout we abort the
    // controller so the underlying child process is killed rather than left
    // running orphaned (issue #3938).
    if (timeoutMs) {
      const controller = new AbortController();

      const runPromise = this.execAsync(
        emulatorPath,
        args,
        combineAbortSignals(signal, controller.signal),
      );
      return raceWithDeadline(runPromise, {
        timer: this.timer,
        timeoutMs,
        label: "Emulator command",
        timeoutError: () =>
          new ActionableError(`Command timed out after ${timeoutMs}ms: ${fullCommand}`),
        onTimeout: () => controller.abort(),
      });
    }

    return await this.execAsync(emulatorPath, args, signal);
  }

  /**
   * List all available AVDs
   * @returns Promise with array of AVD names
   */
  async listAvds(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    coalesceInventoryEnrichment?: boolean;
  }): Promise<DeviceInfo[]> {
    if (!options?.coalesceInventoryEnrichment) {
      return this.listAvdsUncached(options);
    }
    const state = inventoryEnrichmentState(this.timer);
    const signal = options.signal ?? getAbortSignal();
    signal?.throwIfAborted();
    const cached = state.avds.get("avds");
    if (cached) {
      return cached;
    }
    const generation = state.generation;
    const shared = state.avdFlight.run(
      "avds",
      () =>
        runWithAbortSignal(undefined, async () => {
          const result = await this.listAvdsUncached({
            timeoutMs: ANDROID_INVENTORY_AVD_LIST_CAP_MS,
          });
          if (generation === state.generation) {
            state.avds.set("avds", result);
          }
          return result;
        }),
      signal,
    );
    return raceWithDeadline(shared, {
      timer: this.timer,
      timeoutMs: options.timeoutMs,
      signal,
      label: "Android AVD-list caller wait",
    });
  }

  private async listAvdsUncached(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<DeviceInfo[]> {
    try {
      const result = await this.executeCommand(["-list-avds"], options?.timeoutMs, options?.signal);
      const devices = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(
          (name) =>
            ({ name, platform: "android", isRunning: false, source: "local" }) as DeviceInfo,
        );
      return this.enrichDeviceInfoList(devices);
    } catch (error) {
      options?.signal?.throwIfAborted();
      logger.error("Failed to list AVDs:", error);

      // Check if the error is because emulator is not found
      const errorMsg = errorMessage(error);
      const daemonWorkingDirectoryFailure = this.isLikelyDaemonWorkingDirectoryFailure(errorMsg);
      const executableExists = (path: string): boolean =>
        isAbsolute(path) ? existsSync(path) : Bun.which(path) !== null;
      const missingExecutable =
        !daemonWorkingDirectoryFailure &&
        isMissingExecutableError(error, this.emulatorPath, executableExists(this.emulatorPath));
      const missingEmulator =
        missingExecutable || /No such file or directory|command not found|ENOENT/.test(errorMsg);
      if (missingEmulator && daemonWorkingDirectoryFailure) {
        throw new ActionableError(
          `Android emulator command failed because the daemon working directory is unavailable. ` +
            `Restart the AutoMobile daemon so it can use a stable working directory. Underlying error: ${errorMsg}`,
        );
      }
      if (missingEmulator) {
        const MissingError = missingExecutable ? AndroidEmulatorUnavailableError : ActionableError;
        throw new MissingError(
          `Android emulator not found.\n${this.describeEmulatorResolution()}\n\n` +
            `Install the emulator package with: sdkmanager --install "emulator"\n` +
            `(Android Studio installs it too: https://developer.android.com/studio)\n` +
            `Or point ANDROID_HOME at an SDK that already has emulator/emulator.`,
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
  async isAvdRunning(
    avdName: string,
    options: { bypassDeviceListCache?: boolean } = {},
  ): Promise<boolean> {
    const runningEmulators = await this.getBootedDevices(false, options);
    return runningEmulators.some((emulator) => emulator.name === avdName);
  }

  /**
   * Check if a specific AVD is currently starting (booting up)
   * @param avdName - The AVD name to check
   * @returns Promise with boolean indicating if the AVD is currently starting
   */
  async isAvdStarting(avdName: string): Promise<boolean> {
    try {
      return await this.runningAvdAdvertisementReader.isAvdAdvertisedRunning(avdName);
    } catch (error) {
      // Degrade to "no advertisement", but never silently: this reader is a
      // SECONDARY signal (the in-flight claim and the port-correlated scan are
      // the guards that must hold), and a read failure here used to collapse to
      // a debug line that the default INFO level dropped (#6407).
      logger.warn(
        `Failed to read running-AVD advertisements for '${avdName}': ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  /**
   * Check if any emulator is currently running
   * @returns Promise with array of running emulator info
   */
  async getBootedDevices(
    onlyEmulators: boolean = false,
    options: BootedDeviceScanOptions = {},
  ): Promise<BootedDevice[]> {
    try {
      return await this.getBootedDevicesChecked(onlyEmulators, options);
    } catch (error) {
      logger.debug(`[DeviceListTimeout] Failed to get running emulators: ${error}`);
      return [];
    }
  }

  /**
   * Ask the RUNTIME on this serial which AVD it is (`emu avd name`, with the
   * `ro.boot.qemu.avd_name` property as fallback).
   *
   * Public because identity now has no ADB transport id: a caller about to do
   * something destructive to an emulator whose discovered name is
   * `Unknown (<serial>)` must be able to re-resolve that name from the device
   * itself rather than trust a host-side cache (#6863). Returns undefined when
   * the runtime cannot answer inside `timeoutMs`.
   */
  async resolveRunningAvdName(
    device: BootedDevice,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const { name } = await this.getRunningAVDName(device, timeoutMs, signal);
    return name === "" ? undefined : name;
  }

  async resolveAvdNameForSerial(
    serial: string,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<string | undefined> {
    return await this.resolveRunningAvdName(
      { deviceId: serial, name: serial, platform: "android" },
      options.timeoutMs,
      options.signal,
    );
  }

  /**
   * `infoTimeoutMs` is the TOTAL budget for naming this runtime, not a per-command
   * allowance. The console probe and the `getprop` fallback run sequentially, so
   * giving each its own full budget would let two stalled commands take twice the
   * timeout the caller asked for -- and this resolver runs inside a destructive
   * action that is already holding a lifecycle lease against a deadline (#6863
   * review). They share one deadline; the fallback gets only what is left of it,
   * and is skipped when nothing is.
   */
  private async getRunningAVDName(
    device: BootedDevice,
    infoTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{
    name: string;
    diagnostic?: ReadinessDiagnostic;
    consoleBusyDuringProbe?: boolean;
  }> {
    const deviceId = device.deviceId;
    const busyBeforeDispatch = this.consoleBusyRegistry.isBusy(deviceId);
    if (busyBeforeDispatch) {
      // `adb devices` has already established that the serial exists. During a
      // daemon-owned snapshot operation, both identity probes can transiently
      // lose the ADB transport; leave identity unresolved instead of creating
      // the false missing-device evidence that reaches the disconnect monitor.
      logger.debug(
        `Skipping AVD-name resolution for ${deviceId}: a console-exclusive operation is in flight`,
      );
      return { name: "", consoleBusyDuringProbe: true };
    }

    const adbWithDevice = this.adbFactory.create(device);
    const deadlineMs = this.timer.now() + infoTimeoutMs;
    let diagnostic: ReadinessDiagnostic | undefined;
    const generationBeforeDispatch = this.consoleBusyRegistry.getGeneration(deviceId);
    try {
      const result = await adbWithDevice.executeCommand("emu avd name", {
        timeoutMs: infoTimeoutMs,
        noRetry: true,
        signal,
      });
      const avdName = result.stdout.trim().replace(/\r?\n.*$/, "");
      logger.debug(
        `AVD name detection for ${deviceId}: raw="${result.stdout}" (${result.stdout.length} chars), cleaned="${avdName}"`,
      );
      if (avdName) {
        return { name: avdName };
      }
    } catch (error) {
      this.throwIfReadinessAborted(signal);
      diagnostic = readinessDiagnostic("avd-name-resolution", error, deviceId);
      logger.debug(`Failed to get AVD name for ${deviceId}: ${error}`);
    }

    const consoleBusyDuringProbe =
      busyBeforeDispatch ||
      this.consoleBusyRegistry.isBusy(deviceId) ||
      generationBeforeDispatch !== this.consoleBusyRegistry.getGeneration(deviceId);

    const remainingMs = deadlineMs - this.timer.now();
    if (remainingMs <= 0) {
      logger.debug(
        `AVD name resolution for ${deviceId} spent its ${infoTimeoutMs}ms budget on the console probe; skipping the property fallback`,
      );
      return { name: "", diagnostic, consoleBusyDuringProbe };
    }

    try {
      const result = await adbWithDevice.executeCommand("shell getprop ro.boot.qemu.avd_name", {
        timeoutMs: remainingMs,
        noRetry: true,
        signal,
      });
      const avdName = result.stdout.trim().replace(/\r?\n.*$/, "");
      logger.debug(
        `AVD name property fallback for ${deviceId}: raw="${result.stdout}" (${result.stdout.length} chars), cleaned="${avdName}"`,
      );
      return avdName ? { name: avdName } : { name: "", diagnostic, consoleBusyDuringProbe };
    } catch (error) {
      this.throwIfReadinessAborted(signal);
      logger.debug(`Failed to get AVD name property for ${deviceId}: ${error}`);
      return {
        name: "",
        diagnostic: readinessDiagnostic("avd-name-resolution", error, deviceId),
        consoleBusyDuringProbe,
      };
    }
  }

  private resolveFoundDeviceModel(
    ...args: Parameters<AndroidDeviceInventoryScanner["resolveFoundDeviceModel"]>
  ): Promise<string | undefined> {
    return this.inventory.resolveFoundDeviceModel(...args);
  }

  private foundBootedDevice(
    ...args: Parameters<AndroidDeviceInventoryScanner["foundBootedDevice"]>
  ): BootedDevice {
    return this.inventory.foundBootedDevice(...args);
  }

  private resolvedReadyAvdName(
    ...args: Parameters<AndroidDeviceInventoryScanner["resolvedReadyAvdName"]>
  ): Promise<string> {
    return this.inventory.resolvedReadyAvdName(...args);
  }

  private getBootedDevicesWithDiagnostics(
    onlyEmulators: boolean = false,
    options: BootedDeviceScanOptions = {},
    signal?: AbortSignal,
  ): Promise<BootedDeviceScan> {
    return this.inventory.getBootedDevicesWithDiagnostics(onlyEmulators, options, signal);
  }

  /**
   * Like {@link getBootedDevices} but rethrows discovery failures (e.g. adb
   * unreachable) instead of swallowing them into an empty list. Callers that
   * must distinguish "no emulators are booted" from "adb discovery failed"
   * should use this.
   */
  async getBootedDevicesChecked(
    onlyEmulators: boolean = false,
    options: BootedDeviceScanOptions = {},
    signal?: AbortSignal,
  ): Promise<BootedDevice[]> {
    return (await this.getBootedDevicesWithDiagnostics(onlyEmulators, options, signal)).devices;
  }

  /**
   * Start an emulator with the specified AVD
   * @param avdName - The AVD name to start
   * @returns Promise with the spawned child process
   */
  async startEmulator(avdName: string): Promise<ChildProcess | null> {
    return (await this.launchEmulator({ avdName })).process;
  }

  private resolveCameraPosterPath(posterPath?: string): string | undefined {
    const cameraPosterPath = posterPath === undefined ? undefined : resolve(posterPath);
    if (cameraPosterPath !== undefined) {
      if (![".png", ".jpg", ".jpeg"].includes(extname(cameraPosterPath).toLowerCase())) {
        throw new ActionableError("cameraPosterPath must point to a PNG, JPG, or JPEG image.");
      }
      if (!(this.posterFileSystem ?? { existsSync }).existsSync(cameraPosterPath)) {
        throw new ActionableError(`Camera poster image does not exist: ${cameraPosterPath}`);
      }
    }
    return cameraPosterPath;
  }

  private assertCameraPosterColdBoot(posterPath?: string): void {
    if (posterPath !== undefined) {
      throw new ActionableError(
        "cameraPosterPath is unsupported on a running or starting AVD. Stop it first.",
      );
    }
  }

  async launchEmulator(
    request: AndroidEmulatorLaunchRequest,
  ): Promise<AndroidEmulatorLaunchHandle> {
    if (request.signal?.aborted) {
      throw new EmulatorLaunchCancelledError(request.avdName, null);
    }

    const cameraPosterPath = this.resolveCameraPosterPath(request.cameraPosterPath);
    let process: ChildProcess | null = null;
    let outcome: AndroidEmulatorLaunchOutcome = "launched";
    let disposed = false;
    let admission: BootAdmission | undefined;
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
      // Ambient leaf for the emulator startup command (spawn + startup
      // validation). It ends when `startEmulatorProcess` resolves — never the
      // resident emulator's whole lifetime — mirroring the iOS `simctl boot`
      // leaf (see PerfContext).
      // Raced against the request's abort so a cancel does not outwait the
      // startup validation: that can run its full 5 s fallback against an
      // emulator that ignores SIGTERM, and the owner needs the child handle
      // inside its abort grace to confirm the exit (#10075).
      const launch = await raceWithDeadline(
        () =>
          trackAmbient(`emulator launch ${request.avdName}`, () =>
            this.launcher.startEmulatorProcess(request.avdName, {
              requestedExtraArgs: request.extraArgs,
              cameraPosterPath,
              onSpawn: (spawnedProcess) => {
                process = spawnedProcess;
                if (disposed && !spawnedProcess.killed) {
                  spawnedProcess.kill();
                }
              },
              isCancelled: () => disposed,
              capturePreLaunchDeviceIds: shouldCaptureEmulatorReservationSnapshot(request.deviceId),
              expectedDeviceId: request.deviceId,
              signal: request.signal,
              admitColdBoot: request.admitColdBoot,
              onAdmitted: (admitted) => {
                admission = admitted;
              },
            }),
          ),
        { timer: this.timer, signal: request.signal, label: "Android emulator launch" },
      );
      process = launch.process;
      outcome = launch.outcome;
      if (!process) {
        // A sibling can win the AVD lock after the pre-spawn check. Never adopt its camera state.
        this.assertCameraPosterColdBoot(cameraPosterPath);
      }
      if (disposed) {
        // `dispose` already sent the SIGTERM to this child.
        throw new EmulatorLaunchCancelledError(request.avdName, process);
      }
    } catch (error) {
      request.signal?.removeEventListener("abort", dispose);
      // A failed or cancelled launch frees its capacity slot; the owner confirms the child's exit.
      admission?.release();
      // Hand the spawned child to the owner: one SIGTERM is only a request, and
      // the owner must confirm the exit before freeing the AVD (#10075).
      throw disposed ? asLaunchCancellation(request.avdName, error, process) : error;
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
      outcome,
      get targetDeviceId() {
        return process ? client.launchTargetDeviceIds.get(process) : request.deviceId;
      },
      dispose: () => {
        dispose();
        release();
      },
    };
  }

  /**
   * Whether this AVD is already up or coming up, so the launch must adopt it
   * instead of spawning a second emulator for it.
   *
   * `getBootedDevicesChecked` rather than the swallow-to-[] wrapper: an adb
   * discovery failure must surface as an error, never be read as "this AVD is
   * not running" (#6407).
   */
  private async adoptsExistingAvdLaunch(
    avdName: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    perf.startOperation("checkAlreadyRunning");
    try {
      const runningEmulators = await this.getBootedDevicesChecked(
        false,
        { bypassDeviceListCache: true },
        signal,
      );
      if (runningEmulators.some((emulator) => emulator.name === avdName)) {
        logger.info(`AVD '${avdName}' is already running - waiting for it to be ready`);
        return true;
      }
      // Mid-boot the scan can only label the emulator `Unknown (<serial>)`, so
      // the console-port reservation, not the name, is the evidence (#6407).
      const launchingDeviceId = this.reservations.findReservedLaunchSerial(
        avdName,
        runningEmulators,
        isUnknownEmulatorName,
      );
      if (launchingDeviceId) {
        logger.info(
          `AVD '${avdName}' is already starting on ${launchingDeviceId} (this process reserved that console port) - waiting for it to be ready`,
        );
        return true;
      }
      const preAdbLaunchSerial = this.reservations.findLiveReservationAwaitingAdb(
        avdName,
        runningEmulators,
      );
      if (preAdbLaunchSerial) {
        logger.info(
          `AVD '${avdName}' is already starting on ${preAdbLaunchSerial} (this process holds a live reservation adb has not listed yet) - waiting for it to be ready`,
        );
        return true;
      }
      if (this.reservations.hasLiveUnreservedLaunch(avdName)) {
        logger.info(
          `AVD '${avdName}' is already starting (this process holds a live launch for it that adb has not named yet) - waiting for it to be ready`,
        );
        return true;
      }
      if (await this.isAvdStarting(avdName)) {
        logger.info(`AVD '${avdName}' is already starting - waiting for it to be ready`);
        return true;
      }
      return false;
    } finally {
      perf.endOperation("checkAlreadyRunning");
    }
  }

  private throwIfLaunchCancelled(avdName: string, isCancelled?: () => boolean): void {
    if (isCancelled?.()) {
      throw new EmulatorLaunchCancelledError(avdName, null);
    }
  }

  private releaseReservationIfLaunchCancelled(
    avdName: string,
    reservation: EmulatorDeviceIdReservation | undefined,
    isCancelled?: () => boolean,
  ): void {
    if (!isCancelled?.()) {
      return;
    }
    if (reservation) {
      this.reservations.releasePendingEmulatorDeviceId(reservation);
    }
    this.throwIfLaunchCancelled(avdName, isCancelled);
  }

  private emulatorAudioArguments(): string[] {
    return process.env.AUTOMOBILE_EMULATOR_AUDIO === "false" ? ["-no-audio"] : [];
  }

  /**
   * Request termination of the expected running emulator.
   * @param device - The device to kill
   * @param options - `force` drops the AVD-name comparison below AND the
   *   discovery that feeds it (#6864).
   * @returns The checked target after ADB accepts termination; callers confirm disappearance.
   */
  async killDevice(device: BootedDevice, options: EmulatorKillOptions = {}): Promise<BootedDevice> {
    options = { ...options, deadlineMs: this.timer.now() + (options.timeoutMs ?? 30_000) };
    // Under `force` the rediscovery below is serial-only. Dropping the name
    // comparison alone was not enough: enrichment runs BEFORE the comparison
    // and probes every attached emulator sequentially at 2s apiece, so three
    // wedged consoles spend 6s of a 5s forced teardown deadline inside the
    // discovery and `emu kill` is never dispatched. Since `force` has already
    // committed to killing whatever occupies this serial, every one of those
    // names is read and then discarded
    // ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review).
    const runningEmulators = await this.discoverEmulatorsForKill(options);
    const emulator = runningEmulators.find((emu) => emu.deviceId === device.deviceId);

    if (!emulator || !emulator.deviceId) {
      return await this.killEmulatorMissingFromOnlineList(device, options);
    }

    if (emulator.platform !== device.platform) {
      throw new ActionableError(
        `Emulator '${device.deviceId}' identity changed before termination; refusing to kill its replacement.`,
      );
    }

    // `force` is the caller's decision, taken one layer up, to act on whatever
    // occupies this serial (#6864). It drops exactly the two NAME comparisons
    // below and nothing else: the serial selection above still has to find a
    // running emulator, and the termination primitive is unchanged.
    //
    // Dropping them is what makes the flag work at all. `deviceTools` reaches
    // here having deliberately NOT established an identity -- either skipping
    // the emulator-console probe whose wedging is the whole reason force
    // exists, or carrying the pooled AVD label no probe stood behind -- so a
    // second comparison against the same unanswerable discovery can only refuse
    // the forced kill on the caller's behalf a second time
    // ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review).
    if (!options.force) {
      if (this.shouldStopMuteEmulatorProcess(device, emulator, options)) {
        await this.stopEmulatorProcess(
          device,
          options,
          new ActionableError(
            `Refusing to kill '${device.deviceId}': the emulator could not name itself.`,
          ),
        );
        return device;
      }
      if (emulator.name !== device.name) {
        throw new ActionableError(
          `Emulator '${device.deviceId}' identity changed before termination; refusing to kill its replacement.`,
        );
      }

      // Two unknowns are not an equality. `Unknown (<serial>)` on either side is
      // the absence of a name, so a request carrying the placeholder that meets a
      // discovery carrying the placeholder has matched on nothing -- and the
      // emulator answering on the serial now may be a replacement of the one the
      // caller resolved. Callers that legitimately target an emulator whose
      // console is mute resolve its AVD name first and put THAT in the target
      // (`deviceTools.confirmPooledAvdIdentity`), so reaching here with two
      // placeholders means no identity was ever established (#6863 review).
      if (
        isUnknownEmulatorName(device.name, device.deviceId) &&
        isUnknownEmulatorName(emulator.name, emulator.deviceId)
      ) {
        throw new ActionableError(
          `Refusing to kill '${device.deviceId}': the emulator could not name itself, so this ` +
            "daemon cannot tell it apart from a replacement that took the serial. Resolve its AVD " +
            (options.processStop
              ? `name and retry. ${await this.processStopEscapeHint(device, options)}`
              : `name and retry, or stop it by hand with \`adb -s ${device.deviceId} emu kill\`.`),
        );
      }
    } else {
      logger.warn(
        `[AndroidEmulatorClient] force=true: killing whatever occupies '${device.deviceId}' ` +
          `without asking the runtime to name itself and without comparing the requested AVD ` +
          `name '${device.name}' against the discovery.`,
      );
    }

    // Terminate through the emulator console `emu kill`. Only the console
    // shutdown lets the emulator write its quick-boot snapshot on exit; a guest
    // `shell reboot -p` halts the OS without it, so the next quick-boot of the
    // AVD resumes into a halted guest that never comes adb-online and burns the
    // whole getAndroid readiness budget (issue #6849 regression of #6845). The
    // console kill remains preferred; a bounded process fallback is available
    // only when the caller supplies process-table identity evidence.
    //
    // `adb emu` selects a device by serial only — the console subcommand ignores
    // `-t` and honours just `-s`/ANDROID_SERIAL, so `adb -t <id> emu kill` fails
    // with "more than one emulator detected; use -s" as soon as a second
    // emulator is attached (issue #6845). The kill is consequently always
    // serial-scoped through the discovered emulator, which is what makes it
    // correct with several emulators attached. Transport ids are not used for
    // termination at all: the serial is the kill's identity, the discovery-time
    // check above refuses a replacement AVD found on that serial, and callers
    // confirm disappearance and incarnation afterwards.
    await this.dispatchEmulatorConsoleKill(emulator, options, device);
    logger.info(`Requested termination of emulator '${device.name}'`);
    return emulator;
  }

  private async discoverEmulatorsForKill(options: EmulatorKillOptions): Promise<BootedDevice[]> {
    const discover = (signal?: AbortSignal) =>
      this.getBootedDevicesChecked(
        false,
        {
          bypassDeviceListCache: true,
          skipNameEnrichment: options.force === true,
        },
        signal,
      );
    if (!options.processStop) {
      return discover(options.signal);
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    return raceWithDeadline(() => discover(signal), {
      timer: this.timer,
      signal: options.signal,
      timeoutMs: Math.max(0, (options.deadlineMs ?? this.timer.now()) - this.timer.now()),
      label: "Emulator shutdown discovery",
      onTimeout: () => controller.abort(),
    });
  }

  private async dispatchEmulatorConsoleKill(
    target: BootedDevice,
    options: EmulatorKillOptions,
    identityTarget: BootedDevice = target,
  ): Promise<void> {
    const remainingMs =
      (options.deadlineMs ?? this.timer.now() + (options.timeoutMs ?? 30_000)) - this.timer.now();
    const timeoutMs = options.processStop
      ? Math.max(0, Math.min(remainingMs / 3, EMULATOR_CONSOLE_KILL_BOUND_MS))
      : options.timeoutMs;
    try {
      await this.adbFactory.create(target).execute(["emu", "kill"], {
        timeoutMs,
        noRetry: true,
        signal: options.signal,
        waitForProcessSettlementAfterAbort: true,
      });
    } catch (error) {
      if (!options.processStop) {
        throw error;
      }
      options.signal?.throwIfAborted();
      if (!(error instanceof AdbCommandTimeoutError)) {
        throw error;
      }
      logger.warn(
        `[AndroidEmulatorClient] console kill timed out for ${target.deviceId}; checking process identity`,
        error,
      );
      try {
        await this.stopEmulatorProcess(identityTarget, options, error);
      } catch (stopError) {
        throw markEmulatorStopDispatched(
          stopError instanceof Error
            ? stopError
            : toActionableError(stopError, "Emulator stop failed after console kill"),
        );
      }
    }
  }

  private shouldStopMuteEmulatorProcess(
    device: BootedDevice,
    emulator: BootedDevice,
    options: EmulatorKillOptions,
  ): boolean {
    return Boolean(
      options.processStop &&
      isUnknownEmulatorName(emulator.name, emulator.deviceId) &&
      this.processStopAvdName(device, options),
    );
  }

  private processStopAvdName(
    device: BootedDevice,
    options: EmulatorKillOptions,
  ): string | undefined {
    return isUnknownEmulatorName(device.name, device.deviceId)
      ? options.processStop?.expectedAvdName
      : device.name;
  }

  private async processStopEscapeHint(
    device: BootedDevice,
    options: EmulatorKillOptions,
    identity?: EmulatorProcessIdentity,
  ): Promise<string> {
    if (identity) {
      return this.processIdentityEscapeHint(device, identity);
    }
    const stopper = options.processStop?.stopper;
    if (!stopper) {
      return emulatorProcessEscapeHint(device.deviceId);
    }
    const stopOptions = {
      deadlineMs: options.deadlineMs ?? this.timer.now(),
      signal: options.signal,
    };
    const described = await stopper.describeSerial(device.deviceId, stopOptions);
    if (described.kind === "read" && described.candidates.length > 0) {
      return emulatorProcessEscapeHint(device.deviceId, described.candidates);
    }
    const observed = await stopper.identify(
      { serial: device.deviceId, avdName: this.processStopAvdName(device, options) ?? "" },
      stopOptions,
    );
    return this.processIdentityEscapeHint(device, observed);
  }

  private processIdentityEscapeHint(
    device: BootedDevice,
    identity: EmulatorProcessIdentity,
  ): string {
    switch (identity.kind) {
      case "absent":
      case "unreadable":
        return emulatorProcessEscapeHint(device.deviceId, [], identity.kind);
      case "ambiguous":
        return emulatorProcessEscapeHint(device.deviceId, identity.candidates);
      default:
        return emulatorProcessEscapeHint(device.deviceId, [identity]);
    }
  }

  private async stopEmulatorProcess(
    device: BootedDevice,
    options: EmulatorKillOptions,
    refusal: Error,
  ): Promise<void> {
    const avdName = this.processStopAvdName(device, options);
    if (!options.processStop || !avdName) {
      throw await this.processStopRefusal(device, options, refusal);
    }
    const outcome = await options.processStop.stopper.stop(
      { serial: device.deviceId, avdName },
      {
        deadlineMs: options.deadlineMs ?? this.timer.now(),
        signal: options.signal,
      },
    );
    switch (outcome.kind) {
      case "stopped":
        return;
      case "identity-mismatch":
        throw new ActionableError(
          `Emulator '${device.deviceId}' identity changed before termination; refusing to kill its replacement (AVD '${outcome.runningAvdName}').`,
        );
      case "still-running":
        if (!outcome.signalled) {
          throw new ActionableError(
            `Emulator '${device.deviceId}' (AVD '${avdName}') is still running with pid ${outcome.pid}; no signal could be delivered (deadline spent or signal refused: permission denied or unsafe pid). ${emulatorProcessEscapeHint(device.deviceId, [{ pid: outcome.pid, command: outcome.command }])}`,
          );
        }
        throw new EmulatorStillRunningError(outcome.pid, device.deviceId, avdName, outcome.command);
      case "unidentified":
        throw await this.processStopRefusal(device, options, refusal, outcome.identity);
    }
  }

  private async processStopRefusal(
    device: BootedDevice,
    options: EmulatorKillOptions,
    refusal: Error,
    identity?: EmulatorProcessIdentity,
  ): Promise<Error> {
    const message = `${refusal.message} ${await this.processStopEscapeHint(device, options, identity)}`;
    return refusal instanceof AdbCommandTimeoutError
      ? new AdbCommandTimeoutError(message)
      : new ActionableError(message, { cause: refusal });
  }

  /**
   * The serial is not among the `device`-state rows `killDevice` rediscovered.
   * That is not proof the emulator stopped: `adb devices` also lists an
   * emulator whose transport dropped (host sleep/wake, a boot that never
   * finished) as `offline` while its process keeps running and keeps holding
   * its AVD (#10074). Read the raw states before answering "not running", so a
   * caller never retires session/pool ownership of an emulator that is alive.
   *
   * - absent from `adb devices` altogether: the one case that is "not running";
   * - attached in another state, without `force`: a distinct error that the
   *   already-stopped classifier does not match, so ownership stays intact;
   * - attached in another state, under `force`: the serial-scoped console kill.
   *   `adb emu` talks to the emulator console port rather than the adb
   *   transport, so it still reaches an `offline` emulator. Disappearance is
   *   confirmed by the caller, which must also see the serial leave `adb devices`.
   */
  private async killEmulatorMissingFromOnlineList(
    device: BootedDevice,
    options: EmulatorKillOptions,
  ): Promise<BootedDevice> {
    const stateOptions = options.processStop
      ? {
          ...options,
          timeoutMs: Math.max(0, (options.deadlineMs ?? this.timer.now()) - this.timer.now()),
        }
      : options;
    const attachedState = await this.readAttachedStateForKill(device, stateOptions);
    if (attachedState === undefined) {
      return await this.killEmulatorAbsentFromAdb(device, options);
    }
    const label = this.emulatorLabel(device);
    if (!options.force) {
      throw new ActionableError(
        `Emulator '${label}' (${device.deviceId}) is attached to adb but reported in state ` +
          `'${attachedState}', so the daemon cannot tell whether it has stopped and has left its ` +
          `session and pool entry untouched. Retry killDevice with force: true to send the ` +
          `emulator console kill to ${device.deviceId} anyway.`,
      );
    }
    logger.warn(
      `[AndroidEmulatorClient] force=true: '${device.deviceId}' is attached in adb state ` +
        `'${attachedState}'; dispatching the console kill without a booted-device match.`,
    );
    await this.dispatchEmulatorConsoleKill(device, options);
    logger.info(`Requested termination of emulator '${label}' (adb state '${attachedState}')`);
    return device;
  }

  /** The AVD name, or the serial when the caller's target carries no usable name. */
  private emulatorLabel(device: BootedDevice): string {
    return device.name.trim() === "" ? device.deviceId : device.name;
  }

  /**
   * adb lists no row for the serial. That only proves the daemon's adb server does not know
   * it, not that the emulator exited: the emulator process can outlive its adb registration
   * (a different adb server, a dropped transport). The process table is the second witness;
   * only when it also has no process for the serial is the emulator "not running".
   */
  private async killEmulatorAbsentFromAdb(
    device: BootedDevice,
    options: EmulatorKillOptions,
  ): Promise<BootedDevice> {
    const stopper = options.processStop?.stopper;
    const described = stopper
      ? await stopper.describeSerial(device.deviceId, {
          deadlineMs: options.deadlineMs ?? this.timer.now(),
          signal: options.signal,
        })
      : ({ kind: "read", candidates: [] } satisfies EmulatorSerialDescription);
    if (described.kind === "unreadable") {
      // Fail closed: an unreadable table (ps failure, deadline, unsupported platform) cannot
      // prove absence, and this wording must not match the already-stopped classifier.
      throw new ActionableError(
        `Cannot confirm whether emulator '${this.emulatorLabel(device)}' (${device.deviceId}) has ` +
          `stopped: adb does not list it and the host process table could not be read ` +
          `(${described.detail}), so its session and pool entry were left untouched. ` +
          emulatorProcessEscapeHint(device.deviceId, [], "unreadable"),
      );
    }
    const { candidates } = described;
    if (candidates.length === 0) {
      throw new ActionableError(`Emulator '${this.emulatorLabel(device)}' is not running`);
    }
    const label = this.emulatorLabel(device);
    if (this.processStopAvdName(device, options)) {
      logger.warn(
        `[AndroidEmulatorClient] '${device.deviceId}' is absent from adb but its emulator process is ` +
          `alive; stopping it through the process table.`,
      );
      await this.stopEmulatorProcess(
        device,
        options,
        new ActionableError(`Emulator '${label}' is absent from adb`),
      );
      return device;
    }
    throw new ActionableError(
      `Emulator '${label}' (${device.deviceId}) has a live process but adb does not list it, and ` +
        `no AVD name was given to verify its identity. ${emulatorProcessEscapeHint(device.deviceId, candidates)}`,
    );
  }

  private async readAttachedStateForKill(
    device: BootedDevice,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string | undefined> {
    const adb = this.adbFactory.create(null);
    if (!adb.getDeviceStates) {
      return undefined;
    }
    try {
      const states = await adb.getDeviceStates({
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        // A vanished adb cannot say the serial is gone either (#11643).
        throwOnMissingAdb: true,
      });
      return states.find((state) => state.deviceId === device.deviceId)?.state;
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      // An unreadable state list cannot prove the serial is gone, so fail the kill
      // rather than let the caller classify the emulator as already stopped.
      throw toActionableError(
        error,
        `Could not read adb device states to confirm '${device.deviceId}' is stopped`,
      );
    }
  }

  private recordReservedEmulatorDeviceId(
    childProcess: ChildProcess,
    reservation: EmulatorDeviceIdReservation,
  ): void {
    this.reservations.recordReservedEmulatorDeviceId(childProcess, reservation);
    this.recordLaunchTargetDeviceId(childProcess, reservation.deviceId, "reserved console port");
  }

  private getLaunchTargetDeviceId(childProcess?: ChildProcess | null): string | undefined {
    return childProcess ? this.launchTargetDeviceIds.get(childProcess) : undefined;
  }

  private findNamedEmulator(
    avdName: string,
    childProcess: ChildProcess | null | undefined,
    runningEmulators: BootedDevice[],
  ): { emulator?: BootedDevice; failure?: string } {
    const namedEmulator = runningEmulators.find((emulator) => emulator.name === avdName);
    logger.debug(
      `Exact name match for '${avdName}': ${namedEmulator ? `Found ${namedEmulator.deviceId}` : "Not found"}`,
    );
    if (namedEmulator) {
      this.recordLaunchTargetDeviceId(childProcess, namedEmulator.deviceId, "AVD name");
      return { emulator: namedEmulator };
    }
    return {};
  }

  private getLaunchError(childProcess?: ChildProcess | null): ActionableError | undefined {
    return childProcess ? this.launchErrors.get(childProcess) : undefined;
  }

  private getLaunchErrorFinalization(
    childProcess?: ChildProcess | null,
  ): Promise<ActionableError | undefined> | undefined {
    return childProcess ? this.launchErrorFinalizations.get(childProcess) : undefined;
  }

  private throwLaunchError(error?: ActionableError): void {
    if (error) {
      throw error;
    }
  }

  private async settleReadinessExit(
    childProcess: ChildProcess | null | undefined,
    fallback: ActionableError,
    onFatal: (error: ActionableError) => Promise<never>,
  ): Promise<void> {
    const finalization = this.getLaunchErrorFinalization(childProcess);
    const finalizedError = finalization
      ? await finalization
      : (this.getLaunchError(childProcess) ?? fallback);
    if (finalizedError) {
      await onFatal(finalizedError);
    }
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

  private throwIfReadinessAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw signal.reason;
    }
  }

  private handleReadinessPollingError(
    error: unknown,
    signal: AbortSignal | undefined,
    polling: ReadinessPollingState,
    deadlineReached: boolean,
  ): ReadinessDiagnostic | undefined {
    if (signal?.aborted) {
      polling.active = false;
      if (!deadlineReached) {
        polling.failure = signal.reason;
      }
      return undefined;
    }
    return readinessDiagnostic("device-discovery", error);
  }

  private markTargetNotReady(tracker: OfflineTracker, targetDeviceId: string | undefined): void {
    if (targetDeviceId) {
      tracker.state = "not-ready";
    }
  }

  private readinessWaitActive(
    polling: ReadinessPollingState,
    startTime: number,
    timeoutMs: number,
  ): boolean {
    return polling.active && this.timer.now() - startTime < timeoutMs;
  }

  private readinessDeadlineReached(startTime: number, timeoutMs: number): boolean {
    return this.timer.now() - startTime >= timeoutMs;
  }

  private waitForReadinessDelay(
    delayMs: number,
    signal: AbortSignal | undefined,
    polling: ReadinessPollingState,
    startTime: number,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const waitState: { timeoutHandle?: NodeJS.Timeout } = {};
      const settle = (aborted: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (aborted) {
          polling.active = false;
          if (!this.readinessDeadlineReached(startTime, timeoutMs)) {
            polling.failure = signal?.reason;
          }
        }
        if (waitState.timeoutHandle) {
          this.timer.clearTimeout(waitState.timeoutHandle);
        }
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => settle(true);
      signal?.addEventListener("abort", abort, { once: true });
      waitState.timeoutHandle = this.timer.setTimeout(() => settle(false), delayMs);
      if (signal?.aborted) {
        abort();
      }
    });
  }

  private throwPollingFailure(polling: ReadinessPollingState): void {
    if (polling.failure !== undefined) {
      throw polling.failure;
    }
  }

  private readinessTargetDeviceId(
    targetDeviceId: string | undefined,
    childProcess: ChildProcess | null | undefined,
    resolvedTargetDeviceId?: string,
  ): string | undefined {
    return targetDeviceId ?? this.getLaunchTargetDeviceId(childProcess) ?? resolvedTargetDeviceId;
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
      this.recordLaunchTargetDeviceId(childProcess, targetDeviceId, "process output");
    }
  }

  private recordLaunchTargetDeviceId(
    childProcess: ChildProcess | null | undefined,
    targetDeviceId: string,
    source: string,
  ): void {
    if (!childProcess || this.launchTargetDeviceIds.has(childProcess)) {
      return;
    }
    this.launchTargetDeviceIds.set(childProcess, targetDeviceId);
    logger.debug(`Captured emulator launch target deviceId from ${source}: ${targetDeviceId}`);
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
    signal?: AbortSignal,
    options?: AndroidEmulatorReadinessOptions,
  ): Promise<BootedDevice> {
    const startTime = this.timer.now();
    const perf = createGlobalPerformanceTracker();

    // Read polling interval from environment variable (default: 500ms, minimum: 100ms)
    const pollingIntervalMs = resolveEmulatorPollingInterval(
      process.env.EMULATOR_POLLING_INTERVAL_MS,
    );
    logger.info(
      `Waiting for emulator '${avdName}' to be ready... (polling interval: ${pollingIntervalMs}ms)`,
    );

    const launchErrorFinalization = this.getLaunchErrorFinalization(childProcess);
    const finalizedLaunchError = launchErrorFinalization
      ? await launchErrorFinalization
      : undefined;
    const recordedLaunchError = finalizedLaunchError ?? this.getLaunchError(childProcess);
    this.throwLaunchError(recordedLaunchError);

    // Monitor child process for early exit if provided
    const polling: ReadinessPollingState = { active: true };
    const state: EmulatorReadinessState = {
      processExitError: null,
      foundDeviceId: null,
      foundEmulatorName: avdName,
    };
    const cleanupProcessListeners = this.monitorReadinessProcess(avdName, childProcess, state);

    // Start background polling immediately with configurable intervals
    const probedNameSerials = new Set<string>();
    const unresolvedNameSerials = new Set<string>();
    const offlineTracker: OfflineTracker = { deviceId: null, since: null };

    perf.startOperation("devicePolling");
    const context: EmulatorReadinessContext = {
      avdName,
      timeoutMs,
      childProcess,
      targetDeviceId,
      signal,
      options,
      startTime,
      perf,
      polling,
      state,
      pollingIntervalMs,
      probedNameSerials,
      unresolvedNameSerials,
      offlineTracker,
    };
    // Start background polling immediately
    const pollingPromise = this.pollEmulatorReadiness(context);

    // Main timeout loop
    while (this.readinessWaitActive(polling, startTime, timeoutMs)) {
      const readinessFailure = state.processExitError;
      if (readinessFailure) {
        await this.settleReadinessExit(
          childProcess,
          readinessFailure,
          async (finalizedReadinessFailure) => {
            polling.active = false;
            await pollingPromise;
            perf.endOperation("devicePolling");
            cleanupProcessListeners();
            throw finalizedReadinessFailure;
          },
        );
        state.processExitError = null;
        continue;
      }

      if (state.foundDeviceId) {
        polling.active = false;
        perf.endOperation("devicePolling");
        cleanupProcessListeners();
        const resolvedName = await this.resolvedReadyAvdName(
          avdName,
          state.foundDeviceId,
          state.foundEmulatorName,
          Math.max(
            0,
            Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
          ),
          signal,
        );
        logger.info(`Emulator '${resolvedName}' is ready! Device ID: ${state.foundDeviceId}`);
        const model = await this.resolveFoundDeviceModel(
          state.foundDeviceModel,
          state.foundDeviceId,
          resolvedName,
          Math.max(
            0,
            Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
          ),
          signal,
        );
        const bootedDevice = this.foundBootedDevice(resolvedName, state.foundDeviceId, model);
        await this.wakeAndUnlockAfterReadiness(bootedDevice, signal, options, perf);
        return bootedDevice;
      }

      // Check less frequently in main loop since background polling is doing the work
      await this.waitForReadinessDelay(500, signal, polling, startTime, timeoutMs);
    }

    // Stop background polling
    polling.active = false;
    await pollingPromise;
    perf.endOperation("devicePolling");
    cleanupProcessListeners();

    this.throwPollingFailure(polling);

    if (state.foundDeviceId) {
      const resolvedName = await this.resolvedReadyAvdName(
        avdName,
        state.foundDeviceId,
        state.foundEmulatorName,
        Math.max(
          0,
          Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
        ),
        signal,
      );
      logger.info(`Emulator '${resolvedName}' is ready! Device ID: ${state.foundDeviceId}`);
      const model = await this.resolveFoundDeviceModel(
        state.foundDeviceModel,
        state.foundDeviceId,
        resolvedName,
        Math.max(
          0,
          Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
        ),
        signal,
      );
      const bootedDevice = this.foundBootedDevice(resolvedName, state.foundDeviceId, model);
      await this.wakeAndUnlockAfterReadiness(bootedDevice, signal, options, perf);
      return bootedDevice;
    }

    const correlatedTargetDeviceId = this.readinessTargetDeviceId(
      targetDeviceId,
      childProcess,
      state.resolvedTargetDeviceId,
    );
    const target = readinessTarget(correlatedTargetDeviceId, offlineTracker);
    throw readinessTimeoutError(
      avdName,
      timeoutMs,
      state.processExitError,
      state.correlationFailure,
      state.lastDiagnostic,
      target,
    );
  }

  private validateReadinessCandidate(
    context: EmulatorReadinessContext,
    emulator: BootedDevice | undefined,
    correlatedTargetDeviceId: string | undefined,
  ): BootedDevice | undefined {
    const { avdName, timeoutMs, state } = context;
    if (correlatedTargetDeviceId) {
      logger.debug(
        `Exact deviceId match for '${correlatedTargetDeviceId}': ${emulator ? `Found ${emulator.deviceId}` : "Not found"}`,
      );
      if (emulator && !matchesRequestedAvdOrUnknown(emulator, avdName, correlatedTargetDeviceId)) {
        state.correlationFailure =
          `Emulator '${avdName}' failed to become ready within ${timeoutMs}ms: ` +
          `requested AVD '${avdName}' but ${emulator.deviceId} reports '${emulator.name}'. ` +
          "Select the correct AVD or serial and retry.";
        logger.warn(state.correlationFailure);
        emulator = undefined;
      }
    }

    return emulator;
  }

  private selectReadinessEmulator(
    context: EmulatorReadinessContext,
    runningEmulators: BootedDevice[],
    correlatedTargetDeviceId: string | undefined,
  ): BootedDevice | undefined {
    const { avdName, childProcess, state } = context;
    state.correlationFailure = undefined;
    if (runningEmulators.length > 0) {
      logger.debug(
        `Found ${runningEmulators.length} running emulators: ${runningEmulators.map((e) => `${e.name}(${e.deviceId})`).join(", ")}`,
      );

      // Prefer an exact deviceId when startDevice already selected or correlated a device.
      let emulator = correlatedTargetDeviceId
        ? runningEmulators.find((emu) => emu.deviceId === correlatedTargetDeviceId)
        : undefined;
      emulator = this.validateReadinessCandidate(context, emulator, correlatedTargetDeviceId);

      // Look for emulator by name next.
      if (!emulator && !correlatedTargetDeviceId) {
        const correlation = this.findNamedEmulator(avdName, childProcess, runningEmulators);
        emulator = correlation.emulator;
        state.correlationFailure = correlation.failure;
        state.resolvedTargetDeviceId = emulator?.deviceId;
      }

      return emulator;
    }
    logger.debug(`No running emulators detected - will continue polling`);
    return undefined;
  }

  private applyReadinessProbeResults(
    context: EmulatorReadinessContext,
    emulator: BootedDevice,
    scanDiagnostic: ReadinessDiagnostic | undefined,
    results: [
      PromiseSettledResult<Awaited<ReturnType<AdbClient["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbClient["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbClient["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbClient["executeCommand"]>>>,
    ],
  ): boolean {
    const { state, signal } = context;
    const [deviceStateResult, packageManagerResult, sysBootCompletedResult, bootAnimationResult] =
      results;
    this.throwIfReadinessAborted(signal);

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
      state.lastDiagnostic =
        rejectedReadinessDiagnostic([
          ["device-state", deviceStateResult],
          ["package-manager", packageManagerResult],
          ["system-boot-complete", sysBootCompletedResult],
          ["boot-animation", bootAnimationResult],
        ]) ?? state.lastDiagnostic;
    } else {
      const stateOutput = deviceStateResult.value.stdout.trim();
      const sysBootCompleted = sysBootCompletedResult.value.stdout.trim();
      const bootAnimationState = bootAnimationResult.value.stdout.trim();
      logger.debug(
        `[PARALLEL] Package manager command completed for ${emulator.deviceId} - output: ${packageManagerResult.value.stdout.length} bytes`,
      );
      const unmetPredicate = unmetReadinessPredicate(
        emulator.deviceId,
        stateOutput,
        packageManagerResult.value,
        sysBootCompleted,
        bootAnimationState,
      );
      if (unmetPredicate) {
        // An upstream scan failure (discovery, AVD-name resolution) is the
        // root cause when it is present, so it outranks the probe verdict.
        state.lastDiagnostic = scanDiagnostic ?? unmetPredicate;
      } else {
        logger.debug(`[PARALLEL] ✅ Device state check passed for ${emulator.deviceId}`);
        logger.debug(
          `[PARALLEL] ✅ Package manager is responsive for ${emulator.deviceId} - emulator is ready!`,
        );
        logger.debug(
          `[PARALLEL] ✅ Android boot-complete signals are ready for ${emulator.deviceId}`,
        );
        logger.debug(
          `[PARALLEL] ✅ No package manager errors detected - marking emulator as ready`,
        );
        state.foundDeviceId = emulator.deviceId;
        state.foundEmulatorName = emulator.name;
        state.foundDeviceModel = emulator.model;
        return true;
      }
    }

    return false;
  }

  private scanReadinessDevices(
    context: EmulatorReadinessContext,
    snapshot:
      | Awaited<
          ReturnType<
            NonNullable<ReturnType<AdbClientFactory["create"]>["getReadinessDeviceSnapshot"]>
          >
        >
      | undefined,
    correlatedTargetDeviceId: string | undefined,
  ) {
    const { signal, timeoutMs, startTime, probedNameSerials, unresolvedNameSerials } = context;
    const candidateDevices =
      snapshot?.devices && !correlatedTargetDeviceId
        ? nextReadinessNameCandidates(snapshot.devices, probedNameSerials, unresolvedNameSerials)
        : snapshot?.devices;
    return this.getBootedDevicesWithDiagnostics(
      false,
      {
        bypassDeviceListCache: true,
        devices: candidateDevices,
        timeoutMs: Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
        deviceListTimeoutMs: Math.min(
          AdbClient.DEVICE_LIST_TIMEOUT_MS,
          timeoutMs - (this.timer.now() - startTime),
        ),
        deadlineMs: startTime + timeoutMs,
        targetDeviceId: correlatedTargetDeviceId,
        readinessOnly: true,
      },
      signal,
    );
  }

  private dispatchReadinessProbes(
    adb: ReturnType<AdbClientFactory["create"]>,
    readinessTimeoutMs: number,
    signal: AbortSignal | undefined,
  ) {
    return Promise.allSettled([
      adb.executeCommand("get-state", { timeoutMs: readinessTimeoutMs, signal }),
      adb.executeCommand("shell pm list packages", { timeoutMs: readinessTimeoutMs, signal }),
      adb.executeCommand("shell getprop sys.boot_completed", {
        timeoutMs: readinessTimeoutMs,
        signal,
      }),
      adb.executeCommand("shell getprop init.svc.bootanim", {
        timeoutMs: readinessTimeoutMs,
        signal,
      }),
    ]);
  }

  private async pollEmulatorReadiness(context: EmulatorReadinessContext): Promise<void> {
    const {
      avdName,
      timeoutMs,
      childProcess,
      targetDeviceId,
      signal,
      options,
      startTime,
      perf,
      polling,
      state,
      pollingIntervalMs,
      unresolvedNameSerials,
      offlineTracker,
    } = context;

    // Let the main loop register its wake-up first. When both sleeps share a
    // deadline, this lets a process-exit failure stop the poller before it
    // schedules another cycle.
    await Promise.resolve();
    while (polling.active && !state.foundDeviceId) {
      let correlatedTargetDeviceId: string | undefined;
      try {
        this.recordLaunchError(childProcess, (error) => {
          state.processExitError = error;
        });
        logger.debug(`Background polling iteration - checking for emulator '${avdName}'...`);

        correlatedTargetDeviceId = this.readinessTargetDeviceId(
          targetDeviceId,
          childProcess,
          state.resolvedTargetDeviceId,
        );
        const remainingTimeoutMs = timeoutMs - (this.timer.now() - startTime);
        if (remainingTimeoutMs <= 0) {
          polling.active = false;
          break;
        }
        const discoveryAdb = this.adbFactory.create(null);
        let snapshot:
          | Awaited<ReturnType<NonNullable<typeof discoveryAdb.getReadinessDeviceSnapshot>>>
          | undefined;
        try {
          snapshot = discoveryAdb.getReadinessDeviceSnapshot
            ? await discoveryAdb.getReadinessDeviceSnapshot({
                timeoutMs: Math.min(AdbClient.DEVICE_LIST_TIMEOUT_MS, remainingTimeoutMs),
                signal,
              })
            : undefined;
        } catch (error) {
          // A failed snapshot is a gap in offline observations, not continued offline time.
          this.clearOfflineTracker(offlineTracker);
          throw error;
        }
        await this.detectOfflineFailure(
          correlatedTargetDeviceId,
          offlineTracker,
          Math.min(AdbClient.DEVICE_LIST_TIMEOUT_MS, remainingTimeoutMs),
          signal,
          snapshot?.states,
        );
        await this.maybeRecoverFreshOffline(
          offlineTracker,
          options,
          correlatedTargetDeviceId,
          startTime,
          timeoutMs,
          { avdName, signal },
        );
        if (!polling.active || this.timer.now() - startTime >= timeoutMs) {
          break;
        }

        // For local emulators, check for running devices
        logger.debug(`Checking for running local emulators...`);
        const scan = await this.scanReadinessDevices(context, snapshot, correlatedTargetDeviceId);
        const scanDiagnostic = relevantScanDiagnostic(scan, correlatedTargetDeviceId);
        retryUnresolvedReadinessNames(scan.devices, unresolvedNameSerials);
        state.lastDiagnostic = scanDiagnostic;
        const runningEmulators = scan.devices;
        logger.debug(`Device scan complete - found ${runningEmulators.length} running emulators`);
        const readinessTimeoutMs = Math.max(
          0,
          Math.min(READINESS_PROBE_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
        );
        if (readinessTimeoutMs <= 0) {
          break;
        }

        const emulator = this.selectReadinessEmulator(
          context,
          runningEmulators,
          correlatedTargetDeviceId,
        );
        if (emulator && emulator.deviceId) {
          this.markTargetNotReady(offlineTracker, correlatedTargetDeviceId);
          state.correlationFailure = undefined;
          logger.debug(
            `Target emulator found: ${emulator.name} (${emulator.deviceId}) - starting readiness checks`,
          );
          // Check if the device is online and ready.
          // Run ADB state, package manager, and boot-complete checks in parallel for faster detection.
          logger.debug(
            `[PARALLEL] Running device state, package manager, and boot-complete checks for ${emulator.deviceId}...`,
          );
          const adb = this.adbFactory.create(emulator);
          try {
            perf.startOperation("adbParallelChecks");
            const results = await this.dispatchReadinessProbes(adb, readinessTimeoutMs, signal);
            perf.endOperation("adbParallelChecks");

            if (this.applyReadinessProbeResults(context, emulator, scanDiagnostic, results)) {
              return;
            }
          } catch (parallelError) {
            // Transient readiness probe failures are retried until the deadline.
            this.throwIfReadinessAborted(signal);
            logger.debug(
              `[PARALLEL] ❌ Parallel checks failed for ${emulator.deviceId}: ${parallelError}`,
            );
          }
        } else if (runningEmulators.length > 0) {
          logger.debug(`No suitable emulator found for '${avdName}' - will continue polling`);
        }
      } catch (error) {
        // Transient discovery failures remain diagnostic evidence while polling continues.
        state.lastDiagnostic =
          this.handleReadinessPollingError(
            error,
            signal,
            polling,
            this.readinessDeadlineReached(startTime, timeoutMs),
          ) ?? state.lastDiagnostic;
        logger.debug(`Background polling error (will continue): ${error}`);
      }

      const now = this.timer.now();
      const remainingPollingTimeMs = timeoutMs - (now - startTime);
      if (remainingPollingTimeMs <= 0) {
        polling.active = false;
        break;
      }
      let remainingPollingDelayMs = this.nextPollingDelayMs(
        offlineTracker,
        options,
        correlatedTargetDeviceId,
        now,
        pollingIntervalMs,
        remainingPollingTimeMs,
      );

      // Never let the background poller sleep past the readiness deadline.
      logger.debug(
        `Background polling cycle complete - sleeping ${remainingPollingDelayMs}ms before next check`,
      );
      while (polling.active && !state.foundDeviceId && remainingPollingDelayMs > 0) {
        const sleepChunkMs = Math.min(remainingPollingDelayMs, MAX_POLLING_SLEEP_CHUNK_MS);
        await this.waitForReadinessDelay(sleepChunkMs, signal, polling, startTime, timeoutMs);
        remainingPollingDelayMs -= sleepChunkMs;
      }
    }
    logger.debug(
      `Background polling stopped - pollingActive: ${polling.active}, foundDeviceId: ${state.foundDeviceId}`,
    );
  }

  private monitorReadinessProcess(
    avdName: string,
    childProcess: ChildProcess | null | undefined,
    state: EmulatorReadinessState,
  ): () => void {
    if (childProcess && childProcess.pid) {
      const processOutput: string[] = [];
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const captureOutput = (decoder: StringDecoder, data: Buffer | string) => {
        const output = typeof data === "string" ? data : decoder.write(data);
        processOutput.push(output);
        this.captureLaunchTargetDeviceId(childProcess, output);
        // Keep buffer bounded
        if (processOutput.length > 50) {
          processOutput.splice(0, processOutput.length - 50);
        }
      };
      const handleProcessExit = (code: number | null) => {
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        if (stdoutTail) {
          captureOutput(stdoutDecoder, stdoutTail);
        }
        if (stderrTail) {
          captureOutput(stderrDecoder, stderrTail);
        }
        // Any exit before readiness is fatal unless another process owns the AVD.
        const combinedOutput = processOutput.join("");
        if (combinedOutput.includes("Running multiple emulators with the same AVD")) {
          logger.warn(
            `AVD '${avdName}' is owned by another emulator process; continuing readiness polling`,
          );
          return;
        }

        // Check for known error patterns
        const sandboxError = this.sandboxFailure(combinedOutput);
        const corruptResult = this.detectCorruptImage(combinedOutput);
        const displayResult = this.detectDisplayError(combinedOutput);
        if (sandboxError) {
          state.processExitError = sandboxError;
        } else if (corruptResult.isCorrupt) {
          let msg = `Emulator failed to start: ${corruptResult.message}`;
          if (corruptResult.suggestion) {
            msg += `\n\nSuggestion: ${corruptResult.suggestion}`;
          }
          state.processExitError = new ActionableError(msg);
        } else if (displayResult.isDisplayError) {
          let msg = `Emulator failed to start: ${displayResult.message}`;
          if (displayResult.suggestion) {
            msg += `\n\nSuggestion: ${displayResult.suggestion}`;
          }
          state.processExitError = new ActionableError(msg);
        } else {
          const panicResult = this.detectArchitecturePanic(combinedOutput);
          if (panicResult.isPanic) {
            state.processExitError = new ActionableError(
              `Emulator failed to start: ${panicResult.message}`,
            );
          } else {
            state.processExitError = new EmulatorExitedDuringReadinessError(code);
          }
        }
        logger.error(
          `Emulator process exited during readiness wait: ${state.processExitError.message}`,
        );
      };
      const stdoutCapture = (data: Buffer | string) => captureOutput(stdoutDecoder, data);
      const stderrCapture = (data: Buffer | string) => captureOutput(stderrDecoder, data);
      childProcess.stdout?.on("data", stdoutCapture);
      childProcess.stderr?.on("data", stderrCapture);
      childProcess.on("exit", handleProcessExit);
      return () => {
        childProcess.stdout?.off("data", stdoutCapture);
        childProcess.stderr?.off("data", stderrCapture);
        childProcess.off("exit", handleProcessExit);
      };
    }

    return () => {};
  }

  private async wakeAndUnlockAfterReadiness(
    device: BootedDevice,
    signal: AbortSignal | undefined,
    options: AndroidEmulatorReadinessOptions | undefined,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<void> {
    if (options?.skipWakeAndUnlock) {
      return;
    }
    perf.startOperation("wakeAndUnlock");
    await this.wakeAndUnlock(device, signal);
    perf.endOperation("wakeAndUnlock");
  }

  /**
   * Wake up the emulator and dismiss the lock screen after boot.
   * This ensures the device is immediately usable for automation.
   *
   * Delegates to the shared {@link AndroidWakeAndUnlock} implementation so boot uses the same
   * path as the `wakeAndUnlock` tool: a swipe lock is dismissed, and a secure
   * lock is unlocked with the PIN remembered for the device this session (if
   * any). A secure device with no remembered PIN is left locked — non-fatal, the
   * device is still ready and the user can unlock it with the tool (#4360).
   * @param device - The booted device to wake and unlock
   */
  private async wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    try {
      const wakeAndUnlock = new AndroidWakeAndUnlock(device, this.adbFactory, {
        timer: this.timer,
        credentialStore: new DeviceLockStore(),
      });
      const result = await wakeAndUnlock.execute(undefined, signal);
      await this.waitForPrimaryUserUnlock(device, signal);
      if (!result.unlocked && result.secure) {
        logger.info(
          `[WakeAndUnlock] Device ${device.deviceId} is secure-locked and no PIN is remembered; ` +
            "leaving it locked. Unlock it once with the wakeAndUnlock tool (passing a pin) to remember it.",
        );
      } else {
        logger.info(
          `[WakeAndUnlock] Device ${device.deviceId} wake/unlock: ${JSON.stringify(result)}`,
        );
      }
    } catch (error) {
      this.throwIfReadinessAborted(signal);
      // Log but don't fail - the device is still ready, just might need manual interaction.
      // A secure lock with no remembered PIN throws ActionableError here; that is expected.
      logger.warn(`[WakeAndUnlock] Failed to wake/unlock device ${device.deviceId}: ${error}`);
    }
  }

  private async waitForPrimaryUserUnlock(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<void> {
    const adb = this.adbFactory.create(device);
    let elapsedMs = 0;
    try {
      while (elapsedMs < PRIMARY_USER_UNLOCK_WAIT_MS) {
        this.throwIfReadinessAborted(signal);
        const users = await adb.listUsers(signal);
        const primaryUser = users.find(
          (user) => user.profileType === "primary" || user.userId === 0,
        );
        if (primaryUser?.startState !== "RUNNING_LOCKED") {
          return;
        }
        await this.timer.sleep(PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS);
        elapsedMs += PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS;
      }
      logger.warn(
        `[WakeAndUnlock] Primary user on ${device.deviceId} is still RUNNING_LOCKED after ` +
          `${PRIMARY_USER_UNLOCK_WAIT_MS}ms; CtrlProxy cannot bind until the device unlocks.`,
      );
    } catch (error) {
      // User-state inspection is supplementary; preserve the completed unlock result if unavailable.
      this.throwIfReadinessAborted(signal);
      logger.debug(
        `[WakeAndUnlock] Could not confirm primary-user unlock state for ${device.deviceId}: ${error}`,
      );
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
