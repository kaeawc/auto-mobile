import { AdbCommandTimeoutError } from "./AdbCommandTimeoutError";
import { errorMessage } from "../describeUnknownError";
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
import { BootedDevice, DeviceInfo, ExecResult } from "../../models";
import { AdbClientFactory, unadmittedAdbClientFactory } from "./AdbClientFactory";
import { arch } from "os";
import { defaultTimer, Timer } from "../SystemTimer";
import { BunPortAvailabilityChecker, type PortAvailabilityChecker } from "../PortManager";
import type { AvdConfig, AvdConfigReader } from "./AvdConfigReader";
import { FileAvdConfigReader, validateAvdMemory } from "./AvdConfigReader";
import type { RunningAvdAdvertisementReader } from "./RunningAvdAdvertisementReader";
import { TmpdirRunningAvdAdvertisementReader } from "./RunningAvdAdvertisementReader";
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
  type EmulatorPortReservationDeps,
  type EmulatorPortReservations,
} from "./EmulatorPortReservations";
import {
  DefaultAndroidDeviceInventoryScanner,
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
  type EmulatorLauncher,
  type EmulatorLauncherHost,
} from "./EmulatorLauncher";
import {
  accelerationCheckCategory,
  detectArchitecturePanic,
  detectCorruptImage,
  detectDisplayError,
  launchFailureCategory,
} from "./emulatorLaunchFailure";
import {
  appendCategory,
  classifyEmulatorExitOutput,
  DefaultEmulatorLaunchDiagnostics,
  formatEarlyExitError,
  sandboxFailure,
  type ArchitectureCompatibilityResult,
  type EmulatorLaunchDiagnostics,
} from "./EmulatorLaunchDiagnostics";
import {
  DefaultEmulatorAvdCatalog,
  type EmulatorAvdCatalog,
  type ListAvdsOptions,
} from "./EmulatorAvdCatalog";
import { DefaultEmulatorCommandRunner, type EmulatorCommandRunner } from "./EmulatorCommandRunner";
import {
  DefaultEmulatorLaunchCoordinator,
  type EmulatorLaunchCoordinator,
} from "./EmulatorLaunchCoordinator";
import { DefaultEmulatorLaunchTargets, type EmulatorLaunchTargets } from "./EmulatorLaunchTargets";
import type {
  AndroidEmulatorLaunchHandle,
  AndroidEmulatorLaunchRequest,
  AndroidEmulatorReadinessOptions,
} from "./AndroidEmulatorLaunchTypes";
export type {
  AndroidEmulatorLaunchHandle,
  AndroidEmulatorLaunchRequest,
  AndroidEmulatorReadinessOptions,
} from "./AndroidEmulatorLaunchTypes";
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
    options: {
      signal?: AbortSignal;
      timeoutMs: number;
      consoleExclusiveOwner?: boolean;
      throwOnTimeout?: boolean;
    },
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
> {
  withForeignInventoryResolver?(resolver: BootedDeviceScanOptions["resolveForeignSerials"]): void;
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

import { getFallbackEmulatorPath, locateEmulatorPath } from "./emulatorBinaryLocator";
import { resolveRunningAvdNameOnce, type RunningAvdNameResult } from "./runningAvdName";
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

export { isMissingExecutableError } from "./EmulatorAvdCatalog";

/**
 * Constructor dependencies for {@link AndroidEmulatorClient}. All fields are
 * optional; omitted fields use the production implementation. Test seams are
 * injected by name instead of by position.
 */
export interface AndroidEmulatorClientOptions {
  /** Promisified exec function (for testing) */
  execAsync?: ((file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>) | null;
  /** Spawn function (for testing) */
  spawnFn?: SpawnFn | null;
  /** Timer for delays */
  timer?: Timer;
  /** Factory for creating AdbClient instances (for testing) */
  adbFactory?: AdbClientFactory;
  /** Reader for AVD config.ini files (for testing) */
  avdConfigReader?: AvdConfigReader;
  /** Host platform (for testing) */
  platform?: NodeJS.Platform;
  /** Host CPU architecture (for testing) */
  hostArchitecture?: string;
  /** Checks whether emulator ports are free (for testing) */
  hostPortAvailabilityChecker?: PortAvailabilityChecker;
  runningAvdAdvertisementReader?: RunningAvdAdvertisementReader;
  /** Tracks daemon-owned console-exclusive operations (for testing) */
  consoleBusyRegistry?: EmulatorConsoleBusyRegistry;
  /** Orders completed device discovery observations (for testing) */
  observationSequence?: DiscoveryObservationSequence;
  posterFileSystem?: Pick<FileSystem, "existsSync">;
  reservations?: EmulatorPortReservations;
  inventory?: AndroidDeviceInventoryScanner;
  launcher?: EmulatorLauncher;
  readinessPoller?: EmulatorReadinessPoller;
  /** Resolves the `emulator` binary path (for testing; defaults to filesystem/shell detection) */
  emulatorPathLocator?: () => Promise<string>;
}

type ResolvedClientOptions = AndroidEmulatorClientOptions &
  Required<
    Pick<
      AndroidEmulatorClientOptions,
      | "timer"
      | "adbFactory"
      | "platform"
      | "hostArchitecture"
      | "runningAvdAdvertisementReader"
      | "observationSequence"
    >
  >;

function withClientOptionDefaults(options: AndroidEmulatorClientOptions): ResolvedClientOptions {
  return {
    ...options,
    timer: options.timer ?? defaultTimer,
    // Below the admission gate, not behind it: discovery reading the AVD name on
    // a quarantined serial is the only event that can LIFT the quarantine, and
    // `emu kill` on one is how the pool settles a serial it can no longer
    // identify ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    adbFactory: options.adbFactory ?? unadmittedAdbClientFactory,
    platform: options.platform ?? process.platform,
    hostArchitecture: options.hostArchitecture ?? arch(),
    runningAvdAdvertisementReader:
      options.runningAvdAdvertisementReader ?? new TmpdirRunningAvdAdvertisementReader(),
    observationSequence: options.observationSequence ?? defaultDiscoveryObservationSequence,
  };
}

export class AndroidEmulatorClient implements AndroidEmulator, AndroidEmulatorForDeviceManager {
  private execAsync: (file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  private spawnFn: SpawnFn;
  private emulatorPath: string;
  private readonly emulatorPathLocator: () => Promise<string>;
  private timer: Timer;
  private adbFactory: AdbClientFactory;
  private avdConfigReader: AvdConfigReader;
  private platform: NodeJS.Platform;
  private hostArchitecture: string;
  private readonly hostPortAvailabilityChecker: PortAvailabilityChecker;
  private readonly runningAvdAdvertisementReader: RunningAvdAdvertisementReader;
  private readonly consoleBusyRegistry: EmulatorConsoleBusyRegistry;
  private readonly reservations: EmulatorPortReservations;
  private foreignInventoryResolver?: BootedDeviceScanOptions["resolveForeignSerials"];

  withForeignInventoryResolver(resolver: BootedDeviceScanOptions["resolveForeignSerials"]): void {
    this.foreignInventoryResolver = resolver;
  }

  private readonly inventory: AndroidDeviceInventoryScanner;
  private readonly launcher: EmulatorLauncher;
  private readonly readinessPoller: EmulatorReadinessPoller;
  private readonly killer: EmulatorKiller;
  private readonly offlineRecovery: EmulatorOfflineRecovery;
  private readonly targets: EmulatorLaunchTargets;
  private readonly diagnostics: EmulatorLaunchDiagnostics;
  private readonly commandRunner: EmulatorCommandRunner;
  private readonly avdCatalog: EmulatorAvdCatalog;
  private readonly coordinator: EmulatorLaunchCoordinator;

  private readonly observationSequence: DiscoveryObservationSequence;
  private readonly posterFileSystem?: Pick<FileSystem, "existsSync">;

  /**
   * Create an AndroidEmulatorClient instance. Every dependency is optional and
   * defaults to the production implementation (see {@link AndroidEmulatorClientOptions}).
   */
  constructor(options: AndroidEmulatorClientOptions = {}) {
    const {
      execAsync: execAsyncFn = null,
      spawnFn = null,
      timer,
      adbFactory,
      avdConfigReader,
      platform,
      hostArchitecture,
      hostPortAvailabilityChecker = AndroidEmulatorClient.defaultHostPortAvailabilityChecker(),
      runningAvdAdvertisementReader,
      consoleBusyRegistry,
      observationSequence,
      posterFileSystem,
      reservations,
      inventory,
      launcher,
      readinessPoller,
      emulatorPathLocator = locateEmulatorPath,
    } = withClientOptionDefaults(options);
    this.emulatorPathLocator = emulatorPathLocator;
    this.observationSequence = observationSequence;
    this.posterFileSystem = posterFileSystem;
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
    this.targets = new DefaultEmulatorLaunchTargets(() => this.reservations);
    this.diagnostics = new DefaultEmulatorLaunchDiagnostics({
      timer: () => this.timer,
      emulatorPath: () => this.emulatorPath,
      hostArchitecture: () => this.hostArchitecture,
      avdConfigReader: () => this.avdConfigReader,
      execAsync: (file, args, signal) => this.execAsync(file, args, signal),
    });
    this.commandRunner = new DefaultEmulatorCommandRunner({
      timer: () => this.timer,
      ensureEmulatorPath: () => this.ensureEmulatorPath(),
      execAsync: (file, args, signal) => this.execAsync(file, args, signal),
    });
    this.avdCatalog = new DefaultEmulatorAvdCatalog({
      timer: () => this.timer,
      emulatorPath: () => this.emulatorPath,
      avdConfigReader: () => this.avdConfigReader,
      executeCommand: (args, timeoutMs, signal) => this.executeCommand(args, timeoutMs, signal),
      listAvdsUncached: (listOptions) => this.listAvdsUncached(listOptions),
    });
    this.coordinator = new DefaultEmulatorLaunchCoordinator({
      timer: () => this.timer,
      launcher: () => this.launcher,
      reservations: () => this.reservations,
      targets: () => this.targets,
      posterFileSystem: () => this.posterFileSystem,
      getBootedDevicesChecked: (onlyEmulators, scanOptions, signal) =>
        this.getBootedDevicesChecked(
          onlyEmulators,
          { ...scanOptions, resolveForeignSerials: this.foreignInventoryResolver },
          signal,
        ),
      isAvdStarting: (avdName) => this.isAvdStarting(avdName),
    });
    // Only set a fallback emulator path here; proper detection happens lazily
    this.emulatorPath = getFallbackEmulatorPath();
  }

  wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    return this.readinessPoller.wakeAndUnlock(device, signal);
  }

  private createReadinessHost(): EmulatorReadinessHost {
    return {
      timer: () => this.timer,
      adbFactory: () => this.adbFactory,
      getLaunchError: (cp) => this.targets.getLaunchError(cp),
      getLaunchErrorFinalization: (cp) => this.targets.getLaunchErrorFinalization(cp),
      throwLaunchError: (error) => this.targets.throwLaunchError(error),
      getLaunchTargetDeviceId: (cp) => this.targets.getLaunchTargetDeviceId(cp),
      captureLaunchTargetDeviceId: (cp, output) =>
        this.targets.captureLaunchTargetDeviceId(cp, output),
      maybeRecoverFreshOffline: (...args) => this.offlineRecovery.maybeRecoverFreshOffline(...args),
      nextPollingDelayMs: (...args) => this.offlineRecovery.nextPollingDelayMs(...args),
      getBootedDevicesWithDiagnostics: (...args) => this.getBootedDevicesWithDiagnostics(...args),
      findNamedEmulator: (...args) => this.targets.findNamedEmulator(...args),
      resolvedReadyAvdName: (...args) => this.resolvedReadyAvdName(...args),
      resolveFoundDeviceModel: (...args) => this.resolveFoundDeviceModel(...args),
      foundBootedDevice: (...args) => this.foundBootedDevice(...args),
      classifyEmulatorExitOutput,
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
      launchErrors: () => this.targets.launchErrors,
      launchErrorFinalizations: () => this.targets.launchErrorFinalizations,
      launchTargetDeviceIds: () => this.targets.launchTargetDeviceIds,
      isEmulatorSerialListed: (serial, signal) => this.isEmulatorSerialListed(serial, signal),
      accelerationCheckCategory,
      adoptsExistingAvdLaunch: (avdName, perf, signal) =>
        this.coordinator.adoptsExistingAvdLaunch(avdName, perf, signal),
      appendCategory,
      assertCameraPosterColdBoot: (posterPath) =>
        this.coordinator.assertCameraPosterColdBoot(posterPath),
      captureLaunchTargetDeviceId: (childProcess, output) =>
        this.targets.captureLaunchTargetDeviceId(childProcess, output),
      checkArchitectureCompatibility: (avdName, avdConfig) =>
        this.checkArchitectureCompatibility(avdName, avdConfig),
      detectArchitecturePanic,
      detectCorruptImage,
      detectDisplayError,
      emulatorAudioArguments: () =>
        readEnvRaw(ENV.EMULATOR_AUDIO) === "false" ? ["-no-audio"] : [],
      formatEarlyExitError,
      launchFailureCategory,
      listAvds: (options) => this.listAvds(options),
      recordReservedEmulatorDeviceId: (childProcess, reservation) =>
        this.targets.recordReservedEmulatorDeviceId(childProcess, reservation),
      releaseReservationIfLaunchCancelled: (avdName, reservation, isCancelled) =>
        this.coordinator.releaseReservationIfLaunchCancelled(avdName, reservation, isCancelled),
      runAccelerationCheck: () => this.diagnostics.runAccelerationCheck(),
      sandboxFailure,
      throwIfLaunchCancelled: (avdName, isCancelled) =>
        this.coordinator.throwIfLaunchCancelled(avdName, isCancelled),
      validateAvdMemory,
    };
  }

  private async isEmulatorSerialListed(serial: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const devices = await this.getBootedDevicesChecked(
        true,
        { bypassDeviceListCache: true, skipNameEnrichment: true, skipProfileEnrichment: true },
        signal,
      );
      if (devices.some((device) => device.deviceId === serial)) {
        return true;
      }
      // Any listed transport confirms startup, even before adb reports it as online.
      return (await this.getListedNonDeviceStatesAmong([serial], { signal })).has(serial);
    } catch (error) {
      // adb may be unavailable during startup; the stdout grace and fallback still validate it.
      logger.debug(`Could not probe emulator startup serial '${serial}': ${errorMessage(error)}`);
      return false;
    }
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
    this.emulatorPath = await this.emulatorPathLocator();
    return this.emulatorPath;
  }

  checkArchitectureCompatibility(
    avdName: string,
    avdConfig?: AvdConfig | null,
  ): Promise<ArchitectureCompatibilityResult> {
    return this.diagnostics.checkArchitectureCompatibility(avdName, avdConfig);
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

  /**
   * Execute an emulator command
   * @param command - The command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with stdout and stderr
   */
  executeCommand(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult> {
    return this.commandRunner.executeCommand(args, timeoutMs, signal);
  }

  /**
   * List all available AVDs
   * @returns Promise with array of AVD names
   */
  listAvds(options?: ListAvdsOptions): Promise<DeviceInfo[]> {
    return this.avdCatalog.listAvds(options);
  }

  private listAvdsUncached(options?: ListAvdsOptions): Promise<DeviceInfo[]> {
    return this.avdCatalog.listAvdsUncached(options);
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
    options: {
      signal?: AbortSignal;
      timeoutMs: number;
      consoleExclusiveOwner?: boolean;
      throwOnTimeout?: boolean;
    },
  ): Promise<string | undefined> {
    const result = await resolveRunningAvdNameOnce(
      {
        consoleBusyRegistry: this.consoleBusyRegistry,
        adbFactory: this.adbFactory,
        timer: this.timer,
      },
      { deviceId: serial, name: serial, platform: "android" },
      options.timeoutMs,
      options.signal,
      options.consoleExclusiveOwner,
    );
    // Reset retries need timeout evidence; inventory callers retain the unresolved-name result.
    if (options.throwOnTimeout && result.nameProbeTimedOut) {
      throw new AdbCommandTimeoutError(
        `AVD name resolution timed out after ${options.timeoutMs}ms`,
      );
    }
    return result.name || undefined;
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
    return this.inventory.getBootedDevicesWithDiagnostics(
      onlyEmulators,
      {
        ...options,
        resolveForeignSerials: options.resolveForeignSerials ?? this.foreignInventoryResolver,
      },
      signal,
    );
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

  launchEmulator(request: AndroidEmulatorLaunchRequest): Promise<AndroidEmulatorLaunchHandle> {
    return this.coordinator.launchEmulator(request);
  }
}
