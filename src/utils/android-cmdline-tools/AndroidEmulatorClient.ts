import { errorMessage } from "../describeUnknownError";
import { existsSync } from "node:fs";
import { extname, resolve, isAbsolute } from "node:path";
import type { FileSystem } from "../filesystem/DefaultFileSystem";
import { ENV, readEnvRaw } from "../../config/env";
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
import { EmulatorLaunchCancelledError } from "../../models/EmulatorLaunchCancelledError";
import type { AdmitColdBoot, BootAdmission } from "../../models/BootAdmission";
import { AdbClientFactory, unadmittedAdbClientFactory } from "./AdbClientFactory";
import { arch } from "os";
import { defaultTimer, Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import { combineAbortSignals, getAbortSignal, runWithAbortSignal } from "../AbortContext";
import { trackAmbient } from "../PerfContext";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import { BunPortAvailabilityChecker, type PortAvailabilityChecker } from "../PortManager";
import type { AvdConfig, AvdConfigReader } from "./AvdConfigReader";
import { FileAvdConfigReader, validateAvdMemory } from "./AvdConfigReader";
import type { RunningAvdAdvertisementReader } from "./RunningAvdAdvertisementReader";
import { TmpdirRunningAvdAdvertisementReader } from "./RunningAvdAdvertisementReader";
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
  inventoryEnrichmentState,
  type AndroidDeviceInventoryDeps,
  type AndroidDeviceInventoryScanner,
  type BootedDeviceScan,
  type BootedDeviceScanOptions,
} from "./AndroidDeviceInventoryScanner";
import {
  throwIfReadinessAborted,
  isUnknownEmulatorName,
  unknownEmulatorName,
} from "./emulatorReadinessEvaluation";
import {
  DefaultEmulatorReadinessPoller,
  type EmulatorReadinessHost,
  type EmulatorReadinessPoller,
} from "./EmulatorReadinessPoller";
import {
  DefaultEmulatorLauncher,
  type AndroidEmulatorLaunchOutcome,
  boundedEmulatorOutputTail,
  type EmulatorLauncher,
  type EmulatorLauncherHost,
  type LaunchFailureCategory,
} from "./EmulatorLauncher";
import {
  accelerationCheckCategory,
  detectArchitecturePanic,
  detectCorruptImage,
  detectDeviceIdFromEmulatorOutput,
  detectDisplayError,
  detectSandboxMprotect,
  launchFailureCategory,
} from "./emulatorLaunchFailure";
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

export { EMULATOR_CONSOLE_KILL_BOUND_MS } from "./EmulatorKiller";

const ACCEL_CHECK_TIMEOUT_MS = 3_000;

function outputFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return "";
}

function resolveReadinessPoller(
  poller: EmulatorReadinessPoller | undefined,
  createHost: () => EmulatorReadinessHost,
): EmulatorReadinessPoller {
  return poller ?? new DefaultEmulatorReadinessPoller(createHost());
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

import {
  describeEmulatorResolution,
  getFallbackEmulatorPath,
  isLikelyDaemonWorkingDirectoryFailure,
  locateEmulatorPath,
} from "./emulatorBinaryLocator";
import { resolveRunningAvdNameOnce, type RunningAvdNameResult } from "./runningAvdName";
import { enrichDeviceInfoList } from "./avdDeviceInfoEnrichment";
import { AndroidEmulatorUnavailableError } from "./AndroidEmulatorUnavailableError";
export { AndroidEmulatorUnavailableError } from "./AndroidEmulatorUnavailableError";
export { AndroidOfflineProbeError } from "./AndroidOfflineProbeError";
import {
  DefaultEmulatorKiller,
  type EmulatorKiller,
  type EmulatorKillOptions,
} from "./EmulatorKiller";
import {
  DefaultEmulatorOfflineRecovery,
  type EmulatorOfflineRecovery,
  type OfflineProbeOptions,
} from "./EmulatorOfflineRecovery";

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
  private readonly readinessPoller: EmulatorReadinessPoller;
  private readonly killer: EmulatorKiller;
  private readonly offlineRecovery: EmulatorOfflineRecovery;
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
    readinessPoller?: EmulatorReadinessPoller,
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
    this.readinessPoller = resolveReadinessPoller(readinessPoller, () =>
      this.createReadinessHost(),
    );
    this.reservations = resolveEmulatorPortReservations(reservations, {
      timer: () => this.timer,
      adbFactory: () => this.adbFactory,
      hostPortAvailabilityChecker: () => this.hostPortAvailabilityChecker,
    });
    this.killer = new DefaultEmulatorKiller({
      timer: () => this.timer,
      adbFactory: () => this.adbFactory,
      getBootedDevicesChecked: (onlyEmulators, options, signal) =>
        this.getBootedDevicesChecked(onlyEmulators, options, signal),
    });
    this.offlineRecovery = new DefaultEmulatorOfflineRecovery({
      timer: () => this.timer,
      adbFactory: () => this.adbFactory,
    });
    // Only set a fallback emulator path here; proper detection happens lazily
    this.emulatorPath = getFallbackEmulatorPath();
  }

  private classifyEmulatorExitOutput(combinedOutput: string): ActionableError | null {
    const sandboxError = this.sandboxFailure(combinedOutput);
    const corruptResult = this.detectCorruptImage(combinedOutput);
    const displayResult = this.detectDisplayError(combinedOutput);
    if (sandboxError) {
      return sandboxError;
    }
    if (corruptResult.isCorrupt) {
      let msg = `Emulator failed to start: ${corruptResult.message}`;
      if (corruptResult.suggestion) {
        msg += `\n\nSuggestion: ${corruptResult.suggestion}`;
      }
      return new ActionableError(msg);
    }
    if (displayResult.isDisplayError) {
      let msg = `Emulator failed to start: ${displayResult.message}`;
      if (displayResult.suggestion) {
        msg += `\n\nSuggestion: ${displayResult.suggestion}`;
      }
      return new ActionableError(msg);
    }
    const panicResult = this.detectArchitecturePanic(combinedOutput);
    return panicResult.isPanic
      ? new ActionableError(`Emulator failed to start: ${panicResult.message}`)
      : null;
  }

  private wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    return this.readinessPoller.wakeAndUnlock(device, signal);
  }

  private createReadinessHost(): EmulatorReadinessHost {
    return {
      timer: () => this.timer,
      adbFactory: () => this.adbFactory,
      getLaunchError: (cp) => this.getLaunchError(cp),
      getLaunchErrorFinalization: (cp) => this.getLaunchErrorFinalization(cp),
      throwLaunchError: (error) => this.throwLaunchError(error),
      getLaunchTargetDeviceId: (cp) => this.getLaunchTargetDeviceId(cp),
      captureLaunchTargetDeviceId: (cp, output) => this.captureLaunchTargetDeviceId(cp, output),
      maybeRecoverFreshOffline: (...args) => this.offlineRecovery.maybeRecoverFreshOffline(...args),
      nextPollingDelayMs: (...args) => this.offlineRecovery.nextPollingDelayMs(...args),
      getBootedDevicesWithDiagnostics: (...args) => this.getBootedDevicesWithDiagnostics(...args),
      findNamedEmulator: (...args) => this.findNamedEmulator(...args),
      resolvedReadyAvdName: (...args) => this.resolvedReadyAvdName(...args),
      resolveFoundDeviceModel: (...args) => this.resolveFoundDeviceModel(...args),
      foundBootedDevice: (...args) => this.foundBootedDevice(...args),
      classifyEmulatorExitOutput: (output) => this.classifyEmulatorExitOutput(output),
    };
  }

  waitForEmulatorReady(
    avdName: string,
    timeoutMs: number = 120000,
    childProcess?: ChildProcess | null,
    targetDeviceId?: string,
    signal?: AbortSignal,
    options?: AndroidEmulatorReadinessOptions,
  ): Promise<BootedDevice> {
    // Not `async`: adopting the poller promise would add microtask turns the launch-exit timing tests pin.
    return this.readinessPoller.waitForEmulatorReady(
      avdName,
      timeoutMs,
      childProcess,
      targetDeviceId,
      signal,
      options,
    );
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
      validateAvdMemory,
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
      throwIfAborted: (signal) => throwIfReadinessAborted(signal),
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
   * Ensure emulator path is properly detected and cached
   */
  private async ensureEmulatorPath(): Promise<string> {
    this.emulatorPath = await locateEmulatorPath();
    return this.emulatorPath;
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
    return detectArchitecturePanic(output);
  }

  /** Detect sandbox/JIT entitlement failures that leave an emulator offline. */
  detectSandboxMprotect(output: string): {
    isSandboxError: boolean;
    message?: string;
    suggestion?: string;
  } {
    return detectSandboxMprotect(output);
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

  getOfflineDeviceIdsAmong(
    candidateIds: Iterable<string>,
    options: OfflineProbeOptions = {},
  ): Promise<Set<string>> {
    return this.offlineRecovery.getOfflineDeviceIdsAmong(candidateIds, options);
  }

  getListedNonDeviceStatesAmong(
    candidateIds: Iterable<string>,
    options: OfflineProbeOptions = {},
  ): Promise<Map<string, string>> {
    return this.offlineRecovery.getListedNonDeviceStatesAmong(candidateIds, options);
  }

  recoverOfflineDevices(
    deviceIds: Iterable<string>,
    options: OfflineProbeOptions = {},
  ): Promise<void> {
    return this.offlineRecovery.recoverOfflineDevices(deviceIds, options);
  }

  killDevice(device: BootedDevice, options: EmulatorKillOptions = {}): Promise<BootedDevice> {
    return this.killer.killDevice(device, options);
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
    return detectCorruptImage(output);
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
    return detectDisplayError(output);
  }

  private launchFailureCategory(output: string): LaunchFailureCategory | undefined {
    return launchFailureCategory(output);
  }

  private accelerationCheckCategory(output: string): LaunchFailureCategory | undefined {
    return accelerationCheckCategory(output);
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
      return enrichDeviceInfoList(this.avdConfigReader, devices);
    } catch (error) {
      options?.signal?.throwIfAborted();
      logger.error("Failed to list AVDs:", error);

      // Check if the error is because emulator is not found
      const errorMsg = errorMessage(error);
      const daemonWorkingDirectoryFailure = isLikelyDaemonWorkingDirectoryFailure(
        this.emulatorPath,
        errorMsg,
      );
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
          `Android emulator not found.\n${describeEmulatorResolution(this.emulatorPath)}\n\n` +
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

  private getRunningAVDName(
    device: BootedDevice,
    infoTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RunningAvdNameResult> {
    return resolveRunningAvdNameOnce(
      {
        consoleBusyRegistry: this.consoleBusyRegistry,
        adbFactory: this.adbFactory,
        timer: this.timer,
      },
      device,
      infoTimeoutMs,
      signal,
    );
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
    return readEnvRaw(ENV.EMULATOR_AUDIO) === "false" ? ["-no-audio"] : [];
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

  private detectDeviceIdFromEmulatorOutput(output: string): string | undefined {
    return detectDeviceIdFromEmulatorOutput(output);
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
   * Utility method to sleep for a specified duration
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return this.timer.sleep(ms);
  }
}
