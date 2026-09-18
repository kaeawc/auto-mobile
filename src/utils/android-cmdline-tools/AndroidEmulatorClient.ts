import { errorMessage } from "../describeUnknownError";
import { type ChildProcess, type SpawnOptions } from "child_process";
import { existsSync } from "node:fs";
import { logger } from "../logger";
import { runExecSeam } from "../ExecSeam";
import {
  DefaultHostCommandExecutor,
  execFileAsync as sharedExecFileAsync,
  type HostProcessExecutor,
} from "../HostCommandExecutor";
import { BootedDevice, DeviceInfo, ExecResult, ActionableError } from "../../models";
import { AdbClientFactory, unadmittedAdbClientFactory } from "./AdbClientFactory";
import { arch } from "os";
import { detectAndroidCommandLineTools, getBestAndroidToolsLocation } from "./detection";
import { defaultTimer, Timer } from "../SystemTimer";
import { combineAbortSignals } from "../AbortContext";
import { runDetachedFromPerf, trackAmbient } from "../PerfContext";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import {
  TcpHostPortAvailabilityChecker,
  type HostPortAvailabilityChecker,
} from "../ios/IOSHostPortAvailabilityChecker";
import type { AvdConfig, AvdConfigReader } from "./AvdConfigReader";
import { FileAvdConfigReader, MIN_AVD_RAM_MB } from "./AvdConfigReader";
import type { RunningAvdAdvertisementReader } from "./RunningAvdAdvertisementReader";
import { TmpdirRunningAvdAdvertisementReader } from "./RunningAvdAdvertisementReader";
import { WakeAndUnlock } from "../../features/action/WakeAndUnlock";
import { DeviceLockStore } from "../../features/action/DeviceLockStore";
import { formFactorFrom } from "../../models/formFactor";
import type { AdbDeviceState } from "./interfaces/AdbExecutor";
import {
  AndroidCommandOutputStreamRedactor,
  redactAndroidCommandOutput,
} from "./redactAndroidCommandOutput";
import {
  defaultEmulatorConsoleBusyRegistry,
  type EmulatorConsoleBusyRegistry,
} from "./EmulatorConsoleBusyRegistry";
import {
  defaultDiscoveryObservationSequence,
  type DiscoveryObservationSequence,
} from "../DiscoveryObservationSequence";

const MODERN_PLAY_IMAGE_MIN_API_LEVEL = 30;
const MAX_LAUNCH_OUTPUT_LINES = 50;
const MAX_LAUNCH_OUTPUT_CHARS = 16_384;
const ACCEL_CHECK_TIMEOUT_MS = 3_000;
const EARLY_EXIT_DRAIN_TIMEOUT_MS = 1_000;
const DEFAULT_EMULATOR_POLLING_INTERVAL_MS = 500;
const MIN_EMULATOR_POLLING_INTERVAL_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_POLLING_SLEEP_CHUNK_MS = 500;
// A freshly-provisioned AVD's first cold boot can land its serial in ADB
// `offline` and stay there. This bounds a single re-detect recovery while
// normal readiness polling continues through the caller's full budget.
const FRESH_OFFLINE_RECOVERY_THRESHOLD_MS = 15_000;
const FRESH_OFFLINE_RECOVERY_COMMAND_TIMEOUT_MS = 5_000;
// Continue checking at a bounded cadence after recovery so a device that
// becomes ready before the deadline is observed despite a large configured interval.
const FRESH_OFFLINE_POST_RECOVERY_POLL_INTERVAL_MS = 5_000;
const MIN_EMULATOR_CONSOLE_PORT = 5554;
const MAX_EMULATOR_CONSOLE_PORT = 5682;
const EMULATOR_CONSOLE_PORT_STEP = 2;
const MAX_READINESS_DIAGNOSTIC_CHARS = 512;
const PRIMARY_USER_UNLOCK_WAIT_MS = 5_000;
const PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS = 250;

type LaunchFailureCategory =
  | "display_initialization_failed"
  | "hardware_acceleration_unavailable"
  | "kvm_permission_denied"
  | "missing_shared_library";

type ReadinessDiagnosticPhase =
  | "avd-name-resolution"
  | "boot-animation"
  | "device-discovery"
  | "device-state"
  | "package-manager"
  | "system-boot-complete";

interface ReadinessDiagnostic {
  phase: ReadinessDiagnosticPhase;
  summary: string;
  deviceId?: string;
}

interface BootedDeviceScan {
  devices: BootedDevice[];
  diagnostics: ReadinessDiagnostic[];
}

interface BootedDeviceScanOptions {
  bypassDeviceListCache?: boolean;
  /**
   * List what is attached and stop there: no `emu avd name`, no
   * `getprop ro.boot.qemu.avd_name`, no `getprop ro.product.model`. Every
   * emulator comes back under the `Unknown (<serial>)` placeholder and every
   * handset under its serial (or a name already cached), which is exactly what
   * those names mean today when the runtime declines to answer.
   *
   * Enrichment is sequential and budgets 2s per attached device, so with
   * several wedged consoles it alone outlasts a destructive action's whole
   * deadline. A caller that has ALREADY decided not to establish an identity --
   * `force` (#6864) -- must not pay for names it has committed to ignore, or
   * the escape hatch times out inside discovery and never dispatches the kill
   * it exists to dispatch
   * ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review). Nothing
   * that still compares names may set this.
   */
  skipNameEnrichment?: boolean;
}

type TargetReadinessState = "absent" | "offline" | "not-ready";

interface OfflineTracker {
  deviceId: string | null;
  since: number | null;
  state?: TargetReadinessState;
  /** A bounded `adb reconnect offline` recovery has been dispatched during this readiness invocation (monotonic once set). */
  recoveryAttempted?: boolean;
}

interface ReadinessPollingState {
  active: boolean;
  failure?: unknown;
}

export function boundedEmulatorOutputTail(output: string): string {
  const lines = output.split(/\r?\n/);
  const recentLines = lines.slice(-MAX_LAUNCH_OUTPUT_LINES);
  const recentOutput = recentLines.join("\n");
  if (recentOutput.length <= MAX_LAUNCH_OUTPUT_CHARS) {
    return recentOutput;
  }
  const marker = "[... launch output truncated ...]\n";
  return marker + recentOutput.slice(-(MAX_LAUNCH_OUTPUT_CHARS - marker.length));
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

/** Optional readiness behavior for callers recovering an existing guest state. */
export interface AndroidEmulatorReadinessOptions {
  /** Preserve the guest's restored display and keyguard state instead of waking it. */
  skipWakeAndUnlock?: boolean;
  /**
   * The device was just created by a fresh provision, so its first boot is a
   * genuine cold boot (no quick-boot snapshot to restore). When its serial sits
   * in ADB `offline` past a bounded threshold, attempt one `adb reconnect
   * offline` re-detect, then continue readiness polling through the caller's
   * timeout. A quick-boot-after-shutdown restore leaves this unset and skips
   * that recovery attempt.
   */
  freshProvision?: boolean;
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
   * @param signal - Optional caller abort; kills the child alongside the timeout
   * @returns Promise with stdout and stderr
   */
  executeCommand(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;

  /**
   * List all available AVDs
   * @param options - Optional deadline/abort for the `-list-avds` child (#7008)
   * @returns Promise with array of AVD names
   */
  listAvds(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DeviceInfo[]>;

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
  killDevice(
    device: BootedDevice,
    options?: { timeoutMs?: number; signal?: AbortSignal; force?: boolean },
  ): Promise<BootedDevice>;

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

/**
 * Decide whether the emulator should launch headless (`-no-window`).
 *
 * Resolution order:
 * 1. `AUTOMOBILE_EMULATOR_HEADLESS=true`  → always headless.
 * 2. `AUTOMOBILE_EMULATOR_HEADLESS=false` → always windowed (honor the explicit
 *    opt-out on any host, e.g. someone who wants the native emulator window).
 * 3. macOS → headless. The emulator's Qt window backing store segfaults on
 *    repaint under CoreAnimation (`EXC_BAD_ACCESS` in
 *    `QCALayerBackingStore::beginPaint` → `QPainter` → `QBrush`), which recurs
 *    across launches and takes the whole guest down. AutoMobile observes and
 *    streams the device screen, so the emulator's own window is never used —
 *    dropping it removes the crash surface entirely. Opt back in with
 *    `AUTOMOBILE_EMULATOR_HEADLESS=false`.
 * 4. Linux with no usable display server (`DISPLAY`/`WAYLAND_DISPLAY` unset or
 *    blank) → headless, because a windowed launch aborts on the Qt `xcb`
 *    platform plugin (see issue #2722).
 * 5. Otherwise → windowed (Windows has a native display; Linux has one).
 *
 * @param platform - `process.platform` value
 * @param env - environment variables to read
 * @returns the resolved mode plus a human-readable reason for logging
 */
export function resolveHeadlessMode(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { headless: boolean; reason: string } {
  const explicit = env.AUTOMOBILE_EMULATOR_HEADLESS;
  if (explicit === "true") {
    return { headless: true, reason: "AUTOMOBILE_EMULATOR_HEADLESS=true" };
  }
  if (explicit === "false") {
    return { headless: false, reason: "AUTOMOBILE_EMULATOR_HEADLESS=false (windowed forced)" };
  }

  if (platform === "darwin") {
    return {
      headless: true,
      reason:
        "macOS defaults to -no-window; the emulator's Qt/CoreAnimation window segfaults on repaint and AutoMobile streams the screen instead",
    };
  }

  if (platform === "linux") {
    const hasDisplay = Boolean(
      (env.DISPLAY && env.DISPLAY.trim()) || (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim()),
    );
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
      'AUTOMOBILE_EMULATOR_ARGS must be a JSON array of emulator arguments, for example ["-gpu", "swiftshader_indirect"]',
    );
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((argument) => typeof argument !== "string" || argument.length === 0)
  ) {
    throw new ActionableError(
      "AUTOMOBILE_EMULATOR_ARGS must be a JSON array containing non-empty string arguments",
    );
  }

  return [...parsed];
}

type EmulatorPortPair = {
  readonly consolePort: number;
  readonly adbPort: number;
};

type EmulatorConsolePortArgument = {
  readonly option: "-port" | "-ports";
  readonly value: string | undefined;
  readonly consumesFollowingArgument: boolean;
};

function emulatorConsolePortArgument(
  args: readonly string[],
  index: number,
): EmulatorConsolePortArgument | undefined {
  const argument = args[index];
  if (argument === "-port" || argument === "-ports") {
    return {
      option: argument,
      value: args[index + 1],
      consumesFollowingArgument: true,
    };
  }
  const match = argument.match(/^-(port|ports)=(.*)$/);
  return match
    ? {
        option: `-${match[1]}` as "-port" | "-ports",
        value: match[2],
        consumesFollowingArgument: false,
      }
    : undefined;
}

function parseEmulatorConsolePort(
  consolePortText: string | undefined,
  option: EmulatorConsolePortArgument["option"],
): number {
  const consolePort = Number(consolePortText);
  if (
    !consolePortText ||
    !Number.isInteger(consolePort) ||
    consolePort < MIN_EMULATOR_CONSOLE_PORT ||
    consolePort > MAX_EMULATOR_CONSOLE_PORT ||
    consolePort % EMULATOR_CONSOLE_PORT_STEP !== 0
  ) {
    throw new ActionableError(
      `Emulator ${option} must specify an even console port from ` +
        `${MIN_EMULATOR_CONSOLE_PORT} through ${MAX_EMULATOR_CONSOLE_PORT}`,
    );
  }
  return consolePort;
}

function parseEmulatorAdbPort(
  adbPortText: string | undefined,
  additionalValues: readonly string[],
): number {
  const adbPort = Number(adbPortText);
  if (
    !adbPortText ||
    additionalValues.length > 0 ||
    !Number.isInteger(adbPort) ||
    adbPort < 1 ||
    adbPort > 65_535
  ) {
    throw new ActionableError("Emulator -ports must specify distinct console and ADB TCP ports");
  }
  return adbPort;
}

function parseEmulatorPortPair(argument: EmulatorConsolePortArgument): EmulatorPortPair {
  const [consolePortText, adbPortText, ...additionalValues] = argument.value?.split(",") ?? [];
  const consolePort = parseEmulatorConsolePort(consolePortText, argument.option);
  if (argument.option === "-port") {
    return { consolePort, adbPort: consolePort + 1 };
  }

  const adbPort = parseEmulatorAdbPort(adbPortText, additionalValues);
  if (adbPort === consolePort) {
    throw new ActionableError("Emulator -ports must specify distinct console and ADB TCP ports");
  }
  return { consolePort, adbPort };
}

function emulatorPortsForDeviceId(deviceId: string | undefined): EmulatorPortPair | undefined {
  if (!deviceId?.startsWith("emulator-")) {
    return undefined;
  }
  const consolePort = Number(deviceId.slice("emulator-".length));
  if (
    !Number.isInteger(consolePort) ||
    consolePort < MIN_EMULATOR_CONSOLE_PORT ||
    consolePort > MAX_EMULATOR_CONSOLE_PORT ||
    consolePort % EMULATOR_CONSOLE_PORT_STEP !== 0
  ) {
    throw new ActionableError(
      `Expected emulator device ID '${deviceId}' must use an even console port from ` +
        `${MIN_EMULATOR_CONSOLE_PORT} through ${MAX_EMULATOR_CONSOLE_PORT}`,
    );
  }
  return { consolePort, adbPort: consolePort + 1 };
}

function observedEmulatorPorts(deviceId: string): EmulatorPortPair | undefined {
  if (!deviceId.startsWith("emulator-")) {
    return undefined;
  }
  const consolePort = Number(deviceId.slice("emulator-".length));
  if (!Number.isInteger(consolePort) || consolePort < 1 || consolePort >= 65_535) {
    return undefined;
  }
  return { consolePort, adbPort: consolePort + 1 };
}

function emulatorDeviceIdForConsolePort(consolePort: number): string {
  return `emulator-${consolePort}`;
}

/**
 * Whether a spawned emulator child is still running. A ChildProcess reports a
 * code or a signal once it has exited and leaves both unset until then, so this
 * is the guard that stops a reservation whose `exit` event never arrived from
 * blocking every later launch of that AVD.
 */
function isLaunchChildAlive(child: ChildProcess): boolean {
  return (child.exitCode ?? null) === null && (child.signalCode ?? null) === null;
}

function shouldCaptureEmulatorReservationSnapshot(deviceId: string | undefined): boolean {
  return deviceId === undefined || deviceId.startsWith("emulator-");
}

function configuredEmulatorPorts(args: readonly string[]): EmulatorPortPair | undefined {
  let configuredPorts: EmulatorPortPair | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = emulatorConsolePortArgument(args, index);
    if (!argument) {
      continue;
    }
    if (argument.consumesFollowingArgument) {
      index += 1;
    }
    const ports = parseEmulatorPortPair(argument);
    if (
      configuredPorts &&
      (configuredPorts.consolePort !== ports.consolePort ||
        configuredPorts.adbPort !== ports.adbPort)
    ) {
      throw new ActionableError("Emulator arguments specify multiple different port pairs");
    }
    configuredPorts = ports;
  }
  return configuredPorts;
}

type EmulatorDeviceIdReservation = {
  readonly deviceId: string;
  readonly ports: EmulatorPortPair;
  readonly appendPort: boolean;
  /**
   * The AVD this reservation was taken for. A reservation is the only host-side
   * fact that ties a console port to an AVD NAME while the runtime is still
   * mid-boot and answers the scan as `Unknown (<serial>)` (#6407).
   */
  readonly avdName: string;
};

type TerminalEmulatorReservation = {
  readonly generation: number;
  readonly ports: EmulatorPortPair;
};

type EmulatorDeviceIdSnapshot = {
  readonly deviceIds: ReadonlySet<string>;
  readonly isComplete: boolean;
};

/**
 * The long-lived spawn seam. Kept as its own injectable type so the default can
 * route through the shared {@link HostProcessExecutor} while tests still inject a
 * fake. Deliberately narrower than node's overloaded `typeof spawn`.
 */
type SpawnFn = (file: string, args: string[], options?: SpawnOptions) => ChildProcess;

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

export class AndroidEmulatorClient implements AndroidEmulator {
  private execAsync: (file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  private spawnFn: SpawnFn;
  private emulatorPath: string;
  private timer: Timer;
  private adbFactory: AdbClientFactory;
  private modelNameCache = new Map<string, string>();
  private avdConfigReader: AvdConfigReader;
  private platform: NodeJS.Platform;
  private hostArchitecture: string;
  private readonly hostPortAvailabilityChecker: HostPortAvailabilityChecker;
  private readonly runningAvdAdvertisementReader: RunningAvdAdvertisementReader;
  private readonly consoleBusyRegistry: EmulatorConsoleBusyRegistry;
  private readonly launchTargetDeviceIds = new WeakMap<ChildProcess, string>();
  // startDevice creates a fresh client per request, so reservations must cover
  // every client in the daemon rather than one client instance.
  private static readonly reservedLaunchDeviceIds = new Map<
    ChildProcess,
    EmulatorDeviceIdReservation
  >();
  private static readonly pendingLaunchDeviceIds = new Map<string, EmulatorDeviceIdReservation>();
  private static readonly terminalReservedDeviceIds = new Map<
    string,
    TerminalEmulatorReservation
  >();
  /**
   * AVDs whose launch this PROCESS has claimed and not yet finished. An
   * in-flight launch is invisible to every host-side signal for seconds (adb
   * has no serial yet, then the serial has no name), so the claim — not the
   * name label — is what makes a concurrent second launch of the same AVD
   * impossible in-process (#6407). Ownership hands off to the console-port
   * reservation once the process has spawned.
   */
  private static readonly inFlightAvdLaunches = new Set<string>();
  /**
   * AVD name of every launch child this process spawned WITHOUT a console-port
   * reservation. A reservation-less spawn happens whenever the pre-launch
   * device snapshot came back incomplete, and it leaves the AVD with no serial
   * to correlate against the scan, so the live child itself is the only
   * evidence that this AVD is already coming up (#6407).
   */
  private static readonly unreservedLaunchAvdNames = new Map<ChildProcess, string>();
  private static terminalReservationGeneration = 0;
  private static hostPortAvailabilityCheckerForTesting: HostPortAvailabilityChecker | undefined;
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
    hostPortAvailabilityChecker: HostPortAvailabilityChecker = AndroidEmulatorClient.defaultHostPortAvailabilityChecker(),
    runningAvdAdvertisementReader: RunningAvdAdvertisementReader = new TmpdirRunningAvdAdvertisementReader(),
    consoleBusyRegistry?: EmulatorConsoleBusyRegistry,
    private readonly observationSequence: DiscoveryObservationSequence = defaultDiscoveryObservationSequence,
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
    // Only set a fallback emulator path here; proper detection happens lazily
    this.emulatorPath = this.getFallbackEmulatorPath();
  }

  private static defaultHostPortAvailabilityChecker(): HostPortAvailabilityChecker {
    return (
      AndroidEmulatorClient.hostPortAvailabilityCheckerForTesting ??
      new TcpHostPortAvailabilityChecker()
    );
  }

  static resetLaunchReservationsForTesting(): void {
    AndroidEmulatorClient.reservedLaunchDeviceIds.clear();
    AndroidEmulatorClient.pendingLaunchDeviceIds.clear();
    AndroidEmulatorClient.terminalReservedDeviceIds.clear();
    AndroidEmulatorClient.inFlightAvdLaunches.clear();
    AndroidEmulatorClient.unreservedLaunchAvdNames.clear();
    AndroidEmulatorClient.terminalReservationGeneration = 0;
  }

  static setHostPortAvailabilityCheckerForTesting(
    checker: HostPortAvailabilityChecker | undefined,
  ): void {
    AndroidEmulatorClient.hostPortAvailabilityCheckerForTesting = checker;
  }

  /**
   * Get the path to the emulator executable.
   * This function tries the best available path synchronously, falling back to env/PATH.
   * Actual async detection is performed when needed by ensureEmulatorPath().
   * @returns The path to the emulator
   */
  private getFallbackEmulatorPath(): string {
    const androidHome =
      process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_SDK_HOME;
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
    const androidHome =
      process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_SDK_HOME;
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
          const formFactor = formFactorFrom({
            deviceType: config.deviceName,
            width: config.screenWidth,
            height: config.screenHeight,
            density: config.screenDensity,
          });
          return {
            ...device,
            apiLevel: config.apiLevel ?? device.apiLevel,
            osVersion: config.osVersion ?? device.osVersion,
            runtimeId: config.systemImagePackage ?? device.runtimeId,
            deviceType: config.deviceName ?? device.deviceType,
            screenWidth: config.screenWidth ?? device.screenWidth,
            screenHeight: config.screenHeight ?? device.screenHeight,
            screenDensity: config.screenDensity ?? device.screenDensity,
            formFactor: formFactor === "unknown" ? device.formFactor : formFactor,
            capabilityInventory: config.capabilityInventory ?? device.capabilityInventory,
          };
        } catch (error) {
          logger.debug(`Failed to enrich AVD ${device.name}: ${error}`);
          return device;
        }
      }),
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
   * the one-shot `adb reconnect offline` has been dispatched must not wipe that
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
  ): Promise<ActionableError | null> {
    let states: AdbDeviceState[];
    try {
      states = (await this.adbFactory.create(null).getDeviceStates?.({ timeoutMs, signal })) ?? [];
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
   * ADB `offline`. Runs at most one `adb reconnect offline` re-detect once the
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
    avdName: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
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
          avdName,
          signal,
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

  /** Dispatch the single bounded `adb reconnect offline` re-detect for a stuck fresh boot. */
  private async dispatchFreshOfflineReconnect(
    tracker: OfflineTracker,
    deviceId: string,
    now: number,
    offlineSince: number,
    remainingMs: number,
    avdName: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    tracker.recoveryAttempted = true;
    const commandTimeoutMs = Math.max(
      0,
      Math.min(FRESH_OFFLINE_RECOVERY_COMMAND_TIMEOUT_MS, remainingMs),
    );
    logger.warn(
      `Fresh provision '${avdName}' target ${deviceId} has been ADB-offline for ` +
        `${now - offlineSince}ms; attempting 'adb reconnect offline' recovery`,
    );
    try {
      await this.adbFactory
        .create(null)
        // One-shot recovery: noRetry keeps the real AdbClient from routing this
        // through its retry executor (up to MAX_ADB_RETRIES + 1 executions), so
        // one logical recovery issues exactly one reconnect command (#7054).
        .executeCommand("reconnect offline", commandTimeoutMs, undefined, true, signal);
    } catch (error) {
      this.throwIfReadinessAborted(signal);
      // Best-effort recovery: readiness polling continues through its deadline.
      logger.warn(
        `'adb reconnect offline' recovery for ${deviceId} failed: ${errorMessage(error)}`,
        error,
      );
    }
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
    let timeout: NodeJS.Timeout | undefined;
    const probe = Promise.resolve()
      .then(() => this.execAsync(this.emulatorPath, ["-accel-check"], controller.signal))
      .then(
        (result) =>
          boundedEmulatorOutputTail(
            redactAndroidCommandOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
          ),
        (error) => this.diagnosticOutputFromError(error),
      );
    const timeoutResult = new Promise<string>((resolve) => {
      timeout = this.timer.setTimeout(() => {
        controller.abort();
        logger.debug(`Emulator acceleration check timed out after ${ACCEL_CHECK_TIMEOUT_MS}ms`);
        resolve("");
      }, ACCEL_CHECK_TIMEOUT_MS);
    });

    try {
      return await Promise.race([probe, timeoutResult]);
    } finally {
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
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

      const runPromise = this.execAsync(
        emulatorPath,
        args,
        combineAbortSignals(signal, controller.signal),
      );
      // Once the timeout wins the race the aborted run promise rejects with an
      // AbortError; keep it handled so it can't surface as an unhandledRejection.
      runPromise.catch(() => {
        /* settled after timeout; result consumed via race */
      });

      try {
        return await Promise.race([runPromise, timeoutPromise]);
      } finally {
        this.timer.clearTimeout(timeoutId!);
      }
    }

    return await this.execAsync(emulatorPath, args, signal);
  }

  /**
   * List all available AVDs
   * @returns Promise with array of AVD names
   */
  async listAvds(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DeviceInfo[]> {
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
      const missingEmulator =
        errorMsg.includes("No such file or directory") ||
        errorMsg.includes("command not found") ||
        errorMsg.includes("ENOENT");
      if (missingEmulator && this.isLikelyDaemonWorkingDirectoryFailure(errorMsg)) {
        throw new ActionableError(
          `Android emulator command failed because the daemon working directory is unavailable. ` +
            `Restart the AutoMobile daemon so it can use a stable working directory. Underlying error: ${errorMsg}`,
        );
      }
      if (missingEmulator) {
        throw new ActionableError(
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
      const result = await adbWithDevice.executeCommand(
        "emu avd name",
        infoTimeoutMs,
        undefined,
        true,
        signal,
      );
      const avdName = result.stdout.trim().replace(/\r?\n.*$/, "");
      logger.debug(
        `AVD name detection for ${deviceId}: raw="${result.stdout}" (${result.stdout.length} chars), cleaned="${avdName}"`,
      );
      if (avdName) {
        return { name: avdName };
      }
    } catch (error) {
      this.throwIfReadinessAborted(signal);
      diagnostic = this.readinessDiagnostic("avd-name-resolution", error, deviceId);
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
      const result = await adbWithDevice.executeCommand(
        "shell getprop ro.boot.qemu.avd_name",
        remainingMs,
        undefined,
        true,
        signal,
      );
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
        diagnostic: this.readinessDiagnostic("avd-name-resolution", error, deviceId),
        consoleBusyDuringProbe,
      };
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
    options: BootedDeviceScanOptions = {},
    signal?: AbortSignal,
  ): Promise<BootedDevice[]> {
    return (await this.getBootedDevicesWithDiagnostics(onlyEmulators, options, signal)).devices;
  }

  private async getBootedDevicesWithDiagnostics(
    onlyEmulators: boolean = false,
    options: BootedDeviceScanOptions = {},
    signal?: AbortSignal,
  ): Promise<BootedDeviceScan> {
    const perf = createGlobalPerformanceTracker();
    {
      const adb = this.adbFactory.create(null);
      perf.startOperation("adbDeviceScan");
      const devices = await adb.getBootedAndroidDevices({
        bypassCache: options.bypassDeviceListCache,
        throwOnMissingAdb: true,
        signal,
      });
      perf.endOperation("adbDeviceScan");
      const runningDevices: BootedDevice[] = [];

      // Add local emulator devices
      const emulatorDevices = devices.filter((device) => device.deviceId.startsWith("emulator-"));
      const physicalDevices = devices.filter((device) => !device.deviceId.startsWith("emulator-"));

      const infoTimeoutMs = 2000;
      const diagnostics: ReadinessDiagnostic[] = [];
      perf.startOperation("avdNameResolution");
      for (const device of emulatorDevices) {
        const deviceId = device.deviceId;
        const avdName = options.skipNameEnrichment
          ? { name: "", diagnostic: undefined }
          : await this.getRunningAVDName(device, infoTimeoutMs, signal);
        if (avdName.diagnostic) {
          diagnostics.push(avdName.diagnostic);
        }

        runningDevices.push({
          ...device,
          name: avdName.name || this.unknownEmulatorName(deviceId),
          platform: "android",
          deviceId: deviceId,
          observedAt: this.observationSequence.next(),
          source: "local",
          ...(avdName.name === "" &&
            avdName.consoleBusyDuringProbe === true && {
              consoleBusyDuringProbe: avdName.consoleBusyDuringProbe,
            }),
        });
      }

      for (const device of physicalDevices) {
        runningDevices.push({
          ...device,
          name: await this.resolvePhysicalDeviceName(
            device,
            infoTimeoutMs,
            options.skipNameEnrichment === true,
            signal,
          ),
          platform: "android",
          deviceId: device.deviceId,
          source: "local",
        });
      }
      perf.endOperation("avdNameResolution");

      return { devices: runningDevices, diagnostics };
    }
  }

  /**
   * A handset's display name is `ro.product.model`, cached per serial because a
   * handset cannot change model under a fixed serial. The serial is the
   * fallback: the model is a label, never an identity, so failing to read it
   * costs nothing but a nicer name.
   */
  private async resolvePhysicalDeviceName(
    device: BootedDevice,
    infoTimeoutMs: number,
    skipNameEnrichment: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const cachedModel = this.modelNameCache.get(device.deviceId);
    if (cachedModel) {
      logger.debug(`Got model name for ${device.deviceId}: "${cachedModel}" (cached)`);
      return cachedModel;
    }
    if (skipNameEnrichment) {
      logger.debug(`Serial-only scan: not asking ${device.deviceId} for its model name`);
      return device.deviceId;
    }
    try {
      const adbWithDevice = this.adbFactory.create(device);
      const result = await adbWithDevice.executeCommand(
        "shell getprop ro.product.model",
        infoTimeoutMs,
        undefined,
        true,
        signal,
      );
      const modelName = result.stdout.trim();
      if (!modelName || modelName === "unknown") {
        logger.debug(`No model name found for ${device.deviceId}, using device ID`);
        return device.deviceId;
      }
      this.modelNameCache.set(device.deviceId, modelName);
      logger.debug(`Got model name for ${device.deviceId}: "${modelName}"`);
      return modelName;
    } catch (error) {
      // A missing model name is cosmetic: the serial already identifies the
      // handset, so discovery continues under it.
      logger.debug(`Failed to get model name for ${device.deviceId}: ${error}`);
      return device.deviceId;
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

  async launchEmulator(
    request: AndroidEmulatorLaunchRequest,
  ): Promise<AndroidEmulatorLaunchHandle> {
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
      // Ambient leaf for the emulator startup command (spawn + startup
      // validation). It ends when `startEmulatorProcess` resolves — never the
      // resident emulator's whole lifetime — mirroring the iOS `simctl boot`
      // leaf (see PerfContext).
      process = await trackAmbient(`emulator launch ${request.avdName}`, () =>
        this.startEmulatorProcess(
          request.avdName,
          request.extraArgs,
          (spawnedProcess) => {
            process = spawnedProcess;
            if (disposed && !spawnedProcess.killed) {
              spawnedProcess.kill();
            }
          },
          () => disposed,
          shouldCaptureEmulatorReservationSnapshot(request.deviceId),
          request.deviceId,
          request.signal,
        ),
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
      const launchingDeviceId = this.findReservedLaunchSerial(avdName, runningEmulators);
      if (launchingDeviceId) {
        logger.info(
          `AVD '${avdName}' is already starting on ${launchingDeviceId} (this process reserved that console port) - waiting for it to be ready`,
        );
        return true;
      }
      const preAdbLaunchSerial = this.findLiveReservationAwaitingAdb(avdName, runningEmulators);
      if (preAdbLaunchSerial) {
        logger.info(
          `AVD '${avdName}' is already starting on ${preAdbLaunchSerial} (this process holds a live reservation adb has not listed yet) - waiting for it to be ready`,
        );
        return true;
      }
      if (this.hasLiveUnreservedLaunch(avdName)) {
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
      throw new ActionableError(`Android emulator launch for '${avdName}' was cancelled`);
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
      this.releasePendingEmulatorDeviceId(reservation);
    }
    this.throwIfLaunchCancelled(avdName, isCancelled);
  }

  private emulatorAudioArguments(): string[] {
    return process.env.AUTOMOBILE_EMULATOR_AUDIO === "false" ? ["-no-audio"] : [];
  }

  private async startEmulatorProcess(
    avdName: string,
    requestedExtraArgs?: readonly string[],
    onSpawn?: (process: ChildProcess) => void,
    isCancelled?: () => boolean,
    capturePreLaunchDeviceIds: boolean = false,
    expectedDeviceId?: string,
    signal?: AbortSignal,
  ): Promise<ChildProcess | null> {
    logger.info(`Using local emulator for AVD: ${avdName}`);
    const perf = createGlobalPerformanceTracker();

    // Check if the AVD exists
    perf.startOperation("validateAvd");
    const availableAvds = await this.listAvds();
    perf.endOperation("validateAvd");
    if (!availableAvds.find((emu) => emu.name === avdName)) {
      throw new ActionableError(
        `AVD '${avdName}' not found. Available AVDs: ${availableAvds.map((emu) => emu.name).join(", ")}`,
      );
    }

    // Claim the AVD before any further await. The claim and its check are
    // adjacent and synchronous, so two concurrent launches of the same AVD in
    // this process can never both reach the spawn (#6407).
    if (AndroidEmulatorClient.inFlightAvdLaunches.has(avdName)) {
      logger.info(
        `AVD '${avdName}' already has a launch in flight in this process - waiting for it to be ready`,
      );
      // Joining an in-flight launch gives us no process handle of our own
      // (issue #3938); the caller's readiness wait adopts the same device.
      return null;
    }
    AndroidEmulatorClient.inFlightAvdLaunches.add(avdName);
    try {
      return await this.startClaimedEmulatorProcess(
        avdName,
        perf,
        requestedExtraArgs,
        onSpawn,
        isCancelled,
        capturePreLaunchDeviceIds,
        expectedDeviceId,
        signal,
      );
    } finally {
      // The claim covers this process up to the spawn; from there the console
      // port reservation carries the AVD identity through the mid-boot window.
      AndroidEmulatorClient.inFlightAvdLaunches.delete(avdName);
    }
  }

  private async startClaimedEmulatorProcess(
    avdName: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    requestedExtraArgs?: readonly string[],
    onSpawn?: (process: ChildProcess) => void,
    isCancelled?: () => boolean,
    capturePreLaunchDeviceIds: boolean = false,
    expectedDeviceId?: string,
    signal?: AbortSignal,
  ): Promise<ChildProcess | null> {
    if (await this.adoptsExistingAvdLaunch(avdName, perf, signal)) {
      // Some other actor already owns this AVD, so we hold no process handle for
      // it. Return null rather than a fabricated `{} as ChildProcess`
      // (issue #3938); the caller waits for readiness regardless.
      return null;
    }

    const avdConfig = await this.avdConfigReader.readConfig(avdName);
    this.validateAvdMemory(avdName, avdConfig);

    // Check architecture compatibility before attempting to start
    perf.startOperation("architectureCheck");
    const compatibility = await this.checkArchitectureCompatibility(avdName, avdConfig);
    perf.endOperation("architectureCheck");
    if (!compatibility.compatible && compatibility.reason) {
      logger.error(`Architecture compatibility check failed: ${compatibility.reason}`);
      throw new ActionableError(
        `Cannot start AVD '${avdName}': ${compatibility.reason}. On ${compatibility.hostArch} hosts, use AVDs with compatible architectures (e.g., arm64-v8a for Apple Silicon Macs).`,
      );
    }

    const args = ["-avd", avdName];
    const headlessMode = resolveHeadlessMode(process.platform, process.env);
    logger.info(
      `Emulator display mode: ${headlessMode.headless ? "headless" : "windowed"} (${headlessMode.reason})`,
    );
    if (headlessMode.headless) {
      args.push("-no-window");
    }
    args.push(...this.emulatorAudioArguments());
    const extraArgsRaw = process.env.AUTOMOBILE_EMULATOR_ARGS;
    if (requestedExtraArgs) {
      args.push(...requestedExtraArgs);
    } else if (extraArgsRaw) {
      args.push(...parseExtraEmulatorArguments(extraArgsRaw));
    }
    this.throwIfLaunchCancelled(avdName, isCancelled);
    const preLaunchEmulatorDeviceSnapshot = await this.capturePreLaunchEmulatorDeviceIds(
      capturePreLaunchDeviceIds,
      signal,
    );
    this.throwIfLaunchCancelled(avdName, isCancelled);
    const reservedEmulator = await this.addReservedEmulatorPort(
      args,
      avdName,
      preLaunchEmulatorDeviceSnapshot,
      expectedDeviceId,
      signal,
    );
    this.releaseReservationIfLaunchCancelled(avdName, reservedEmulator, isCancelled);
    logger.info(`Starting emulator with AVD: ${avdName}`);
    logger.debug(`Emulator command: ${this.emulatorPath} ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
      perf.startOperation("spawnEmulator");
      let child: ChildProcess;
      try {
        // Spawn the resident emulator detached from any request perf tracker, so
        // its later `exit` callbacks do not retain a completed request's tracker
        // via AsyncLocalStorage (see PerfContext). The launch-startup timing
        // stays under the ambient `emulator launch` scope.
        child = runDetachedFromPerf(() => this.spawnFn(this.emulatorPath, args));
      } catch (error) {
        if (reservedEmulator) {
          this.releasePendingEmulatorDeviceId(reservedEmulator);
        }
        throw error;
      }
      perf.endOperation("spawnEmulator");
      if (reservedEmulator) {
        this.recordReservedEmulatorDeviceId(child, reservedEmulator);
      } else {
        AndroidEmulatorClient.unreservedLaunchAvdNames.set(child, avdName);
      }
      onSpawn?.(child);

      // Keep only a redacted tail for launch diagnostics and failure classification.
      const stdoutRedactor = new AndroidCommandOutputStreamRedactor();
      const stderrRedactor = new AndroidCommandOutputStreamRedactor();
      let launchOutput = "";
      let duplicateAvdDetected = false;
      let earlyExitCategory: LaunchFailureCategory | undefined;
      let startupValidationComplete = false;
      let childTerminationObserved = false;
      let exitCode: number | null | undefined;
      let exitSignal: NodeJS.Signals | null | undefined;
      let provisionalPostValidationExitError: ActionableError | undefined;
      let resolvePostValidationExit: ((error: ActionableError | undefined) => void) | undefined;
      perf.startOperation("panicDetection");

      const appendRedactedLaunchOutput = (output: string) => {
        if (output.length > 0) {
          launchOutput = boundedEmulatorOutputTail(launchOutput + output);
        }
      };
      const currentLaunchOutput = () =>
        boundedEmulatorOutputTail(
          launchOutput + stdoutRedactor.snapshot() + stderrRedactor.snapshot(),
        );
      const flushLaunchOutput = () => {
        for (const redactor of [stdoutRedactor, stderrRedactor]) {
          const flushedOutput = redactor.flush();
          appendRedactedLaunchOutput(flushedOutput);
          if (flushedOutput.length > 0) {
            logger.debug(`Emulator output: ${flushedOutput}`);
          }
        }
        return launchOutput;
      };
      const recordEarlyExitCategory = (output: string) => {
        const category = this.launchFailureCategory(output);
        if (category && (!earlyExitCategory || category === "missing_shared_library")) {
          earlyExitCategory = category;
        }
      };
      const postValidationExitError = (output: string) =>
        this.formatEarlyExitError(
          avdName,
          exitCode ?? null,
          exitSignal ?? null,
          earlyExitCategory,
          output,
          "",
        );
      const beginPostValidationExit = (output: string) => {
        if (
          !startupValidationComplete ||
          exitCode === undefined ||
          exitCode === 0 ||
          resolvePostValidationExit
        ) {
          return;
        }
        this.launchErrorFinalizations.set(
          child,
          new Promise<ActionableError | undefined>((resolveFinalization) => {
            resolvePostValidationExit = resolveFinalization;
          }),
        );
        if (!this.launchErrors.has(child)) {
          provisionalPostValidationExitError = postValidationExitError(output);
          this.launchErrors.set(child, provisionalPostValidationExitError);
        }
        exitDrainTimeout = this.timer.setTimeout(() => {
          logger.debug(
            `Emulator stdio did not close within ${EARLY_EXIT_DRAIN_TIMEOUT_MS}ms after a validated exit`,
          );
          finalizePostValidationExit(flushLaunchOutput());
        }, EARLY_EXIT_DRAIN_TIMEOUT_MS);
      };
      const finalizePostValidationExit = (output: string) => {
        if (!resolvePostValidationExit) {
          return;
        }
        clearExitDrainTimeout();
        if (
          duplicateAvdDetected ||
          output.includes("Running multiple emulators with the same AVD")
        ) {
          // The in-process guards make this unreachable within one daemon, so a
          // duplicate that still happens came from ANOTHER process. Adoption
          // stays the behaviour, but it is no longer silent (#6407).
          logger.warn(
            `Emulator launch for AVD '${avdName}' exited as a duplicate of an emulator started outside this process; adopting it`,
          );
          this.launchErrors.delete(child);
          this.launchTargetDeviceIds.delete(child);
          const resolveFinalization = resolvePostValidationExit;
          resolvePostValidationExit = undefined;
          resolveFinalization(undefined);
          return;
        }
        if (
          !this.launchErrors.has(child) ||
          this.launchErrors.get(child) === provisionalPostValidationExitError
        ) {
          provisionalPostValidationExitError = postValidationExitError(output);
          this.launchErrors.set(child, provisionalPostValidationExitError);
        }
        const finalError = this.launchErrors.get(child) ?? postValidationExitError(output);
        const resolveFinalization = resolvePostValidationExit;
        resolvePostValidationExit = undefined;
        resolveFinalization(finalError);
      };

      // Monitor emulator output for PANIC errors
      const monitorOutput = (data: any, outputRedactor: AndroidCommandOutputStreamRedactor) => {
        const output = data.toString();
        const safeChunk = redactAndroidCommandOutput(output);
        const redactedOutput = outputRedactor.append(output);
        appendRedactedLaunchOutput(redactedOutput);
        if (redactedOutput.length > 0) {
          logger.debug(`Emulator output: ${redactedOutput}`);
        }
        const diagnosticOutput = currentLaunchOutput();
        this.captureLaunchTargetDeviceId(child, diagnosticOutput);
        duplicateAvdDetected ||=
          diagnosticOutput.includes("Running multiple emulators with the same AVD") ||
          safeChunk.includes("Running multiple emulators with the same AVD");
        recordEarlyExitCategory(diagnosticOutput);
        recordEarlyExitCategory(safeChunk);

        // Detect sandbox/JIT entitlement failures before generic PANIC handling.
        const sandboxError =
          this.sandboxFailure(diagnosticOutput) ?? this.sandboxFailure(safeChunk);
        if (sandboxError) {
          logger.error(`Emulator sandbox error detected: ${sandboxError.message}`);
          this.launchErrors.set(child, sandboxError);
          if (!child.killed) {
            child.kill();
          }
          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(sandboxError);
          }
          return;
        }

        // Check for PANIC in the output
        const panicResult = this.detectArchitecturePanic(diagnosticOutput);
        const directPanicResult = panicResult.isPanic
          ? panicResult
          : this.detectArchitecturePanic(safeChunk);
        if (directPanicResult.isPanic) {
          logger.error(`Emulator PANIC detected: ${directPanicResult.message}`);

          // Create a more helpful error message
          let errorMessage = `Emulator failed to start: ${directPanicResult.message}`;
          if (directPanicResult.hostArch && directPanicResult.avdArch) {
            errorMessage += `\n\nSuggestion: On ${directPanicResult.hostArch} hosts, create AVDs with compatible architectures:`;
            if (
              directPanicResult.hostArch === "aarch64" ||
              directPanicResult.hostArch === "arm64"
            ) {
              errorMessage += `\n- Use ARM64 system images (arm64-v8a) instead of x86/x86_64`;
              errorMessage += `\n- Example: avdmanager create avd -n MyAVD -k "system-images;android-35;google_apis;arm64-v8a"`;
            } else if (
              directPanicResult.hostArch === "x86" ||
              directPanicResult.hostArch === "x86_64"
            ) {
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
        const corruptResult = this.detectCorruptImage(diagnosticOutput);
        const directCorruptResult = corruptResult.isCorrupt
          ? corruptResult
          : this.detectCorruptImage(safeChunk);
        if (directCorruptResult.isCorrupt) {
          logger.error(`Emulator corrupt image detected: ${directCorruptResult.message}`);

          let errorMessage = `Emulator failed to start: ${directCorruptResult.message}`;
          if (directCorruptResult.suggestion) {
            errorMessage += `\n\nSuggestion: ${directCorruptResult.suggestion}`;
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
        const displayResult = this.detectDisplayError(diagnosticOutput);
        const directDisplayResult = displayResult.isDisplayError
          ? displayResult
          : this.detectDisplayError(safeChunk);
        if (directDisplayResult.isDisplayError) {
          logger.error(`Emulator display error detected: ${directDisplayResult.message}`);

          let errorMessage = `Emulator failed to start: ${directDisplayResult.message}`;
          if (directDisplayResult.suggestion) {
            errorMessage += `\n\nSuggestion: ${directDisplayResult.suggestion}`;
          }

          if (!child.killed) {
            child.kill();
          }

          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(
              this.appendCategory(
                new ActionableError(errorMessage),
                "display_initialization_failed",
              ),
            );
          }
          return;
        }

        // Check for successful startup indicators
        if (
          output.includes("INFO         | emuDirName:") ||
          output.includes("Hax is enabled") ||
          output.includes("Detected GPU type")
        ) {
          // Emulator has started successfully, resolve with the child process
          if (!childTerminationObserved && !startupValidationComplete) {
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

      let exitDrainTimeout: NodeJS.Timeout | undefined;
      let earlyExitFinalization: Promise<void> | undefined;
      const clearExitDrainTimeout = () => {
        if (exitDrainTimeout) {
          this.timer.clearTimeout(exitDrainTimeout);
          exitDrainTimeout = undefined;
        }
      };
      const finalizeEarlyExit = () => {
        if (startupValidationComplete || earlyExitFinalization) {
          return;
        }
        earlyExitFinalization = (async () => {
          clearExitDrainTimeout();
          const finalizedOutput = flushLaunchOutput();
          const completedExitCode = exitCode ?? null;
          const completedExitSignal = exitSignal ?? null;

          // Another emulator already owns this AVD; we hold no process handle
          // for it. Resolve null rather than a fabricated handle (issue #3938);
          // the caller waits for readiness regardless.
          if (
            duplicateAvdDetected ||
            finalizedOutput.includes("Running multiple emulators with the same AVD")
          ) {
            logger.warn(
              `AVD '${avdName}' is already starting/running in another process - adopting it instead of the duplicate we launched`,
            );
            if (!startupValidationComplete) {
              startupValidationComplete = true;
              perf.endOperation("panicDetection");
              resolve(null);
            }
            return;
          }

          // Check if exit was due to a sandbox/JIT entitlement failure.
          const sandboxError = this.sandboxFailure(finalizedOutput);
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

          // Check if exit was due to PANIC.
          const panicResult = this.detectArchitecturePanic(finalizedOutput);
          if (panicResult.isPanic) {
            logger.error(`Exit was due to PANIC: ${panicResult.message}`);
            if (!startupValidationComplete) {
              startupValidationComplete = true;
              perf.endOperation("panicDetection");
              reject(new ActionableError(`Emulator failed to start: ${panicResult.message}`));
            }
            return;
          }

          // Check if exit was due to corrupt disk image.
          const corruptResult = this.detectCorruptImage(finalizedOutput);
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
          const displayResult = this.detectDisplayError(finalizedOutput);
          if (displayResult.isDisplayError) {
            logger.error(`Exit was due to display error: ${displayResult.message}`);
            if (!startupValidationComplete) {
              startupValidationComplete = true;
              perf.endOperation("panicDetection");
              let errorMessage = `Emulator failed to start: ${displayResult.message}`;
              if (displayResult.suggestion) {
                errorMessage += `\n\nSuggestion: ${displayResult.suggestion}`;
              }
              reject(
                this.appendCategory(
                  new ActionableError(errorMessage),
                  "display_initialization_failed",
                ),
              );
            }
            return;
          }

          let category = earlyExitCategory ?? this.launchFailureCategory(finalizedOutput);
          let accelCheckOutput = "";
          if (
            completedExitCode !== 0 &&
            this.platform === "linux" &&
            (!category || category === "kvm_permission_denied")
          ) {
            accelCheckOutput = await this.runAccelerationCheck();
            category = category ?? this.accelerationCheckCategory(accelCheckOutput);
          }
          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(
              this.formatEarlyExitError(
                avdName,
                completedExitCode,
                completedExitSignal,
                category,
                finalizedOutput,
                accelCheckOutput,
              ),
            );
          }
        })().catch((error) => {
          logger.error(`Unable to finalize Android emulator early-exit diagnostics: ${error}`);
          if (!startupValidationComplete) {
            startupValidationComplete = true;
            perf.endOperation("panicDetection");
            reject(
              this.formatEarlyExitError(
                avdName,
                exitCode ?? null,
                exitSignal ?? null,
                earlyExitCategory,
                flushLaunchOutput(),
                "",
              ),
            );
          }
        });
      };

      // Log emulator output through the same buffered redaction path as diagnostics.
      child.stdout?.on("data", (data) => {
        monitorOutput(data, stdoutRedactor);
      });

      child.stderr?.on("data", (data) => {
        monitorOutput(data, stderrRedactor);
      });

      child.on("exit", (code, signal) => {
        this.timer.clearTimeout(startupTimeout);
        this.releaseLaunchChild(child);
        childTerminationObserved = true;
        exitCode = code;
        exitSignal = signal;
        if (code !== 0) {
          logger.error(`Emulator process exited with code: ${code}`);
        } else {
          logger.info(`Emulator process exited with code: ${code}`);
        }
        if (startupValidationComplete) {
          beginPostValidationExit(currentLaunchOutput());
        } else {
          exitDrainTimeout = this.timer.setTimeout(() => {
            logger.debug(
              `Emulator stdio did not close within ${EARLY_EXIT_DRAIN_TIMEOUT_MS}ms after an early exit`,
            );
            finalizeEarlyExit();
          }, EARLY_EXIT_DRAIN_TIMEOUT_MS);
        }
      });

      child.on("close", (code, signal) => {
        this.timer.clearTimeout(startupTimeout);
        this.releaseLaunchChild(child);
        clearExitDrainTimeout();
        childTerminationObserved = true;
        exitCode ??= code;
        exitSignal ??= signal;
        if (startupValidationComplete) {
          beginPostValidationExit(currentLaunchOutput());
          finalizePostValidationExit(flushLaunchOutput());
          return;
        }
        finalizeEarlyExit();
      });

      child.on("error", (error) => {
        this.timer.clearTimeout(startupTimeout);
        if (startupValidationComplete) {
          // The exit drain timer or close event owns finalization so later stdio is retained.
          return;
        }
        clearExitDrainTimeout();
        startupValidationComplete = true;
        perf.endOperation("panicDetection");
        reject(new ActionableError(`Emulator failed to start: ${error.message}`));
      });
    });
  }

  /**
   * Request termination of the expected running emulator.
   * @param device - The device to kill
   * @param options - `force` drops the AVD-name comparison below AND the
   *   discovery that feeds it (#6864).
   * @returns The checked target after ADB accepts termination; callers confirm disappearance.
   */
  async killDevice(
    device: BootedDevice,
    options: { timeoutMs?: number; signal?: AbortSignal; force?: boolean } = {},
  ): Promise<BootedDevice> {
    // Under `force` the rediscovery below is serial-only. Dropping the name
    // comparison alone was not enough: enrichment runs BEFORE the comparison
    // and probes every attached emulator sequentially at 2s apiece, so three
    // wedged consoles spend 6s of a 5s forced teardown deadline inside the
    // discovery and `emu kill` is never dispatched. Since `force` has already
    // committed to killing whatever occupies this serial, every one of those
    // names is read and then discarded
    // ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review).
    const runningEmulators = await this.getBootedDevicesChecked(
      false,
      {
        bypassDeviceListCache: true,
        skipNameEnrichment: options.force === true,
      },
      options.signal,
    );
    const emulator = runningEmulators.find((emu) => emu.deviceId === device.deviceId);

    if (!emulator || !emulator.deviceId) {
      throw new ActionableError(`Emulator '${device.name}' is not running`);
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
        this.isUnknownEmulatorName(device.name, device.deviceId) &&
        this.isUnknownEmulatorName(emulator.name, emulator.deviceId)
      ) {
        throw new ActionableError(
          `Refusing to kill '${device.deviceId}': the emulator could not name itself, so this ` +
            "daemon cannot tell it apart from a replacement that took the serial. Resolve its AVD " +
            `name and retry, or stop it by hand with \`adb -s ${device.deviceId} emu kill\`.`,
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
    // console kill is therefore the only termination primitive here; there is
    // no `reboot -p` path.
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
    const adb = this.adbFactory.create(emulator);
    await adb.execute(["emu", "kill"], {
      timeoutMs: options.timeoutMs,
      noRetry: true,
      signal: options.signal,
      waitForProcessSettlementAfterAbort: true,
    });

    logger.info(`Requested termination of emulator '${device.name}'`);
    return emulator;
  }

  private getLaunchTargetDeviceId(childProcess?: ChildProcess | null): string | undefined {
    return childProcess ? this.launchTargetDeviceIds.get(childProcess) : undefined;
  }

  private async capturePreLaunchEmulatorDeviceIds(
    capture: boolean,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdSnapshot | undefined> {
    if (!capture) {
      return undefined;
    }
    const terminalReservationsAtSnapshot = new Map(AndroidEmulatorClient.terminalReservedDeviceIds);
    let deviceIds: Set<string> | undefined;
    try {
      const adb = this.adbFactory.create(null);
      const devices = await adb.getBootedAndroidDevices({
        bypassCache: true,
        throwOnMissingAdb: true,
        signal,
      });
      deviceIds = new Set(
        devices
          .map((device) => device.deviceId)
          .filter((deviceId): deviceId is string => deviceId.startsWith("emulator-")),
      );
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Android emulator reservation snapshot was cancelled");
      }
      if (!adb.getDeviceStates) {
        return { deviceIds, isComplete: false };
      }
      const deviceStates = await adb.getDeviceStates({ signal });
      for (const { deviceId } of deviceStates) {
        if (deviceId.startsWith("emulator-")) {
          deviceIds.add(deviceId);
        }
      }
      this.releaseAbsentTerminalReservations(deviceIds, terminalReservationsAtSnapshot);
      return { deviceIds, isComplete: true };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (deviceIds) {
        logger.debug(`Could not capture all pre-launch emulator device IDs: ${error}`);
        return { deviceIds, isComplete: false };
      }
      // Without a current device list, do not select a port that could belong to
      // another local emulator. Readiness can still use a captured serial or an
      // exact AVD-name match.
      logger.debug(`Could not capture pre-launch emulator device IDs: ${error}`);
      return undefined;
    }
  }

  private async allocateReservedEmulatorPorts(
    avdName: string,
    preexistingDeviceIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdReservation> {
    const unavailablePorts = this.unavailableEmulatorPorts(preexistingDeviceIds);
    for (
      let port = MIN_EMULATOR_CONSOLE_PORT;
      port <= MAX_EMULATOR_CONSOLE_PORT;
      port += EMULATOR_CONSOLE_PORT_STEP
    ) {
      const ports = { consolePort: port, adbPort: port + 1 };
      if (
        !unavailablePorts.has(ports.consolePort) &&
        !unavailablePorts.has(ports.adbPort) &&
        (await this.areEmulatorPortsAvailableOnHost(ports, signal))
      ) {
        const currentUnavailablePorts = this.unavailableEmulatorPorts(preexistingDeviceIds);
        if (
          !currentUnavailablePorts.has(ports.consolePort) &&
          !currentUnavailablePorts.has(ports.adbPort)
        ) {
          return this.reservePendingEmulatorDeviceId(avdName, ports, true);
        }
      }
    }
    throw new ActionableError(
      `Cannot safely launch an Android emulator: all console ports from ` +
        `${MIN_EMULATOR_CONSOLE_PORT} through ${MAX_EMULATOR_CONSOLE_PORT} are in use`,
    );
  }

  private unavailableEmulatorPorts(
    preexistingDeviceIds: ReadonlySet<string> | undefined,
  ): Set<number> {
    const unavailablePorts = new Set<number>();
    const reservePorts = (ports: EmulatorPortPair) => {
      unavailablePorts.add(ports.consolePort);
      unavailablePorts.add(ports.adbPort);
    };
    for (const deviceId of preexistingDeviceIds ?? []) {
      const ports = observedEmulatorPorts(deviceId);
      if (ports) {
        reservePorts(ports);
      }
    }
    for (const reservation of AndroidEmulatorClient.reservedLaunchDeviceIds.values()) {
      reservePorts(reservation.ports);
    }
    for (const reservation of AndroidEmulatorClient.pendingLaunchDeviceIds.values()) {
      reservePorts(reservation.ports);
    }
    for (const reservation of AndroidEmulatorClient.terminalReservedDeviceIds.values()) {
      reservePorts(reservation.ports);
    }
    return unavailablePorts;
  }

  private async areEmulatorPortsAvailableOnHost(
    ports: EmulatorPortPair,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const availability = Promise.all([
      this.hostPortAvailabilityChecker.isAvailable("127.0.0.1", ports.consolePort),
      this.hostPortAvailabilityChecker.isAvailable("127.0.0.1", ports.adbPort),
    ]);
    if (!signal) {
      return (await availability).every(Boolean);
    }
    if (signal.aborted) {
      throw new ActionableError("Android emulator launch was cancelled while checking host ports");
    }
    let rejectCancellation!: (error: ActionableError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = () => {
      rejectCancellation(
        new ActionableError("Android emulator launch was cancelled while checking host ports"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return (await Promise.race([availability, cancellation])).every(Boolean);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private assertEmulatorPortsNotReserved(
    ports: EmulatorPortPair,
    preexistingDeviceIds: ReadonlySet<string> | undefined,
  ): void {
    const unavailablePorts = this.unavailableEmulatorPorts(preexistingDeviceIds);
    if (unavailablePorts.has(ports.consolePort) || unavailablePorts.has(ports.adbPort)) {
      throw new ActionableError(
        `Cannot safely launch an Android emulator: console port ` +
          `${ports.consolePort} is already in use`,
      );
    }
  }

  private async assertEmulatorPortsAvailable(
    ports: EmulatorPortPair,
    preexistingDeviceIds: ReadonlySet<string> | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertEmulatorPortsNotReserved(ports, preexistingDeviceIds);
    if (!(await this.areEmulatorPortsAvailableOnHost(ports, signal))) {
      throw new ActionableError(
        `Cannot safely launch an Android emulator: emulator port pair ` +
          `${ports.consolePort}/${ports.adbPort} is already in use`,
      );
    }
    this.assertEmulatorPortsNotReserved(ports, preexistingDeviceIds);
  }

  private reservePendingEmulatorDeviceId(
    avdName: string,
    ports: EmulatorPortPair,
    appendPort: boolean,
  ): EmulatorDeviceIdReservation {
    const reservation = {
      deviceId: emulatorDeviceIdForConsolePort(ports.consolePort),
      ports,
      appendPort,
      avdName,
    };
    AndroidEmulatorClient.pendingLaunchDeviceIds.set(reservation.deviceId, reservation);
    return reservation;
  }

  private async reserveEmulatorDeviceId(
    avdName: string,
    preLaunchSnapshot: EmulatorDeviceIdSnapshot | undefined,
    args: readonly string[],
    expectedDeviceId?: string,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdReservation | undefined> {
    const expectedEmulatorPorts = emulatorPortsForDeviceId(expectedDeviceId);
    if (expectedDeviceId && !expectedEmulatorPorts) {
      return undefined;
    }
    const configuredPorts = configuredEmulatorPorts(args);
    if (
      expectedEmulatorPorts &&
      configuredPorts &&
      expectedEmulatorPorts.consolePort !== configuredPorts.consolePort
    ) {
      throw new ActionableError(
        `Expected emulator device ID '${expectedDeviceId}' conflicts with configured ` +
          `console port ${configuredPorts.consolePort}`,
      );
    }
    const ports = configuredPorts ?? expectedEmulatorPorts;
    if (ports) {
      await this.assertEmulatorPortsAvailable(ports, preLaunchSnapshot?.deviceIds, signal);
      return this.reservePendingEmulatorDeviceId(avdName, ports, configuredPorts === undefined);
    }
    if (!preLaunchSnapshot?.isComplete) {
      return undefined;
    }
    return this.allocateReservedEmulatorPorts(avdName, preLaunchSnapshot.deviceIds, signal);
  }

  private async addReservedEmulatorPort(
    args: string[],
    avdName: string,
    preLaunchSnapshot: EmulatorDeviceIdSnapshot | undefined,
    expectedDeviceId?: string,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdReservation | undefined> {
    const reservation = await this.reserveEmulatorDeviceId(
      avdName,
      preLaunchSnapshot,
      args,
      expectedDeviceId,
      signal,
    );
    if (reservation?.appendPort) {
      args.push("-port", String(reservation.ports.consolePort));
    }
    return reservation;
  }

  /**
   * The serial of an emulator THIS process is launching for `avdName`, found by
   * correlating the console-port reservations it holds against the scan.
   *
   * A mid-boot emulator answers the scan as `Unknown (<serial>)` for seconds
   * (minutes on a cold boot), so the name label cannot answer "is this AVD
   * already up" (#6407). The reservation can: it was taken for this AVD, and it
   * fixes the console port the serial is derived from. Only a placeholder name
   * counts — a serial that has resolved to some OTHER AVD is a stale
   * reservation, never evidence about this one.
   */
  private findReservedLaunchSerial(
    avdName: string,
    runningEmulators: readonly BootedDevice[],
  ): string | undefined {
    const reservedSerials = new Set<string>();
    const reservations = [
      ...AndroidEmulatorClient.pendingLaunchDeviceIds.values(),
      ...AndroidEmulatorClient.reservedLaunchDeviceIds.values(),
    ];
    for (const reservation of reservations) {
      if (reservation.avdName === avdName) {
        reservedSerials.add(reservation.deviceId);
      }
    }
    return runningEmulators.find(
      (emulator) =>
        reservedSerials.has(emulator.deviceId) &&
        this.isUnknownEmulatorName(emulator.name, emulator.deviceId),
    )?.deviceId;
  }

  /**
   * The serial this process reserved for `avdName` whose emulator is alive but
   * has NOT appeared in the adb scan yet.
   *
   * Startup validation resolves off the first emulator output marker, which the
   * emulator prints seconds before adb lists the runtime, and the name-level
   * in-flight claim is dropped at that point. In that gap
   * `findReservedLaunchSerial` has nothing in the scan to correlate against, so
   * the reservation — held only from the spawn until the child exits — is the
   * one piece of evidence that this AVD is already coming up (#6407).
   *
   * A reserved serial the scan DOES list is deliberately not handled here: it
   * is either the mid-boot placeholder `findReservedLaunchSerial` already
   * matches, or a serial that has resolved to some other AVD, which makes the
   * reservation stale rather than evidence about this one.
   */
  private findLiveReservationAwaitingAdb(
    avdName: string,
    runningEmulators: readonly BootedDevice[],
  ): string | undefined {
    const scannedDeviceIds = new Set(runningEmulators.map((emulator) => emulator.deviceId));
    for (const [child, reservation] of AndroidEmulatorClient.reservedLaunchDeviceIds) {
      if (
        reservation.avdName === avdName &&
        !scannedDeviceIds.has(reservation.deviceId) &&
        isLaunchChildAlive(child)
      ) {
        return reservation.deviceId;
      }
    }
    return undefined;
  }

  /**
   * Whether this process still holds a live launch child for `avdName` that
   * reserved no console port.
   *
   * The name-level in-flight claim is released as soon as startup validation
   * resolves off the first emulator output marker, seconds before adb lists the
   * runtime. With a reservation, `findLiveReservationAwaitingAdb` covers that
   * gap; without one there is no serial to correlate, so the running child is
   * the claim. Callers reach this only after the scan failed to show the AVD by
   * name, and an exited child is both pruned here and ignored, so a missed
   * `exit` event cannot block later launches of the AVD forever.
   */
  private hasLiveUnreservedLaunch(avdName: string): boolean {
    let live = false;
    for (const [child, launchedAvdName] of [...AndroidEmulatorClient.unreservedLaunchAvdNames]) {
      if (!isLaunchChildAlive(child)) {
        AndroidEmulatorClient.unreservedLaunchAvdNames.delete(child);
        continue;
      }
      live ||= launchedAvdName === avdName;
    }
    return live;
  }

  /** Drop every launch-guard record this process holds for an exited child. */
  private releaseLaunchChild(childProcess?: ChildProcess | null): void {
    if (!childProcess) {
      return;
    }
    AndroidEmulatorClient.unreservedLaunchAvdNames.delete(childProcess);
    this.releaseReservedEmulatorDeviceId(childProcess);
  }

  private recordReservedEmulatorDeviceId(
    childProcess: ChildProcess,
    reservation: EmulatorDeviceIdReservation,
  ): void {
    this.releasePendingEmulatorDeviceId(reservation);
    AndroidEmulatorClient.reservedLaunchDeviceIds.set(childProcess, reservation);
    this.recordLaunchTargetDeviceId(childProcess, reservation.deviceId, "reserved console port");
  }

  private releasePendingEmulatorDeviceId(reservation: EmulatorDeviceIdReservation): void {
    if (AndroidEmulatorClient.pendingLaunchDeviceIds.get(reservation.deviceId) === reservation) {
      AndroidEmulatorClient.pendingLaunchDeviceIds.delete(reservation.deviceId);
    }
  }

  private releaseReservedEmulatorDeviceId(childProcess?: ChildProcess | null): void {
    if (!childProcess) {
      return;
    }
    const reservation = AndroidEmulatorClient.reservedLaunchDeviceIds.get(childProcess);
    if (reservation) {
      AndroidEmulatorClient.reservedLaunchDeviceIds.delete(childProcess);
      // ADB can retain an exited emulator briefly. Keep its port unavailable
      // until a later successful snapshot confirms the serial has disappeared.
      AndroidEmulatorClient.terminalReservedDeviceIds.set(reservation.deviceId, {
        generation: ++AndroidEmulatorClient.terminalReservationGeneration,
        ports: reservation.ports,
      });
    }
  }

  private releaseAbsentTerminalReservations(
    deviceIds: ReadonlySet<string>,
    terminalReservationsAtSnapshot: ReadonlyMap<string, TerminalEmulatorReservation>,
  ): void {
    for (const [deviceId, reservation] of terminalReservationsAtSnapshot) {
      if (
        !deviceIds.has(deviceId) &&
        AndroidEmulatorClient.terminalReservedDeviceIds.get(deviceId)?.generation ===
          reservation.generation
      ) {
        AndroidEmulatorClient.terminalReservedDeviceIds.delete(deviceId);
      }
    }
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

  private readinessTimeoutError(
    avdName: string,
    timeoutMs: number,
    processExitError: ActionableError | null,
    correlationFailure?: string,
    diagnostic?: ReadinessDiagnostic,
    target?: { deviceId: string; state: TargetReadinessState },
  ): ActionableError {
    if (processExitError) {
      return processExitError;
    }
    const details = [
      correlationFailure ?? `Emulator '${avdName}' failed to become ready within ${timeoutMs}ms`,
      target ? `target=${target.deviceId}; state=${target.state}` : "",
      diagnostic
        ? `Last readiness diagnostic: phase=${diagnostic.phase}; summary=${diagnostic.summary}`
        : "",
    ].filter(Boolean);
    return new ActionableError(details.join("\n"));
  }

  private readinessDiagnostic(
    phase: ReadinessDiagnosticPhase,
    error: unknown,
    deviceId?: string,
  ): ReadinessDiagnostic {
    const redacted = redactAndroidCommandOutput(errorMessage(error)).replace(/\s+/g, " ").trim();
    const summary =
      redacted.length <= MAX_READINESS_DIAGNOSTIC_CHARS
        ? redacted
        : `${redacted.slice(0, MAX_READINESS_DIAGNOSTIC_CHARS - 16)} [... truncated]`;
    return { phase, summary, deviceId };
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
    return this.readinessDiagnostic("device-discovery", error);
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

  private readinessTarget(
    deviceId: string | undefined,
    tracker: OfflineTracker,
  ): { deviceId: string; state: TargetReadinessState } | undefined {
    return deviceId && tracker.state ? { deviceId, state: tracker.state } : undefined;
  }

  private readinessTargetDeviceId(
    targetDeviceId: string | undefined,
    childProcess: ChildProcess | null | undefined,
  ): string | undefined {
    return targetDeviceId ?? this.getLaunchTargetDeviceId(childProcess);
  }

  private relevantScanDiagnostic(
    scan: BootedDeviceScan,
    targetDeviceId: string | undefined,
  ): ReadinessDiagnostic | undefined {
    return scan.diagnostics.findLast(
      (diagnostic) => !targetDeviceId || diagnostic.deviceId === targetDeviceId,
    );
  }

  /**
   * Returns the first readiness predicate the probed device fails, or undefined when
   * every required Android readiness signal is satisfied.
   */
  private unmetReadinessPredicate(
    deviceId: string,
    stateOutput: string,
    packageManager: ExecResult,
    sysBootCompleted: string,
    bootAnimationState: string,
  ): ReadinessDiagnostic | undefined {
    if (!stateOutput.includes("device")) {
      return this.unmetReadinessDiagnostic(
        "device-state",
        "adb get-state did not report 'device'",
        stateOutput,
        deviceId,
      );
    }
    // Only an explicit package-manager "Failure" blocks readiness. A non-empty stderr
    // on its own is routinely benign (linker and ART warnings on a healthy device) and
    // used to keep a fully booted emulator not-ready forever. See #6818.
    // Checked BEFORE the empty-listing branch: the real failure shape is an empty
    // stdout plus the reason on stderr, and reporting that as `observed=""` would
    // throw away the only actionable detail the timeout error carries.
    if (packageManager.stderr.includes("Failure")) {
      return this.unmetReadinessDiagnostic(
        "package-manager",
        "pm list packages reported a failure",
        packageManager.stderr.trim(),
        deviceId,
      );
    }
    if (!packageManager.stdout.includes("package:")) {
      // With no listing on stdout there is nothing benign for stderr to be noise
      // about, and the boot-time shape carries the reason there — e.g.
      // `cmd: Can't find service: package` while the package service is still
      // coming up. Prefer it over the vacuous `observed=""` (#6818).
      const stderr = packageManager.stderr.trim();
      return this.unmetReadinessDiagnostic(
        "package-manager",
        "pm list packages returned no 'package:' entries",
        stderr.length > 0 ? stderr : packageManager.stdout.trim(),
        deviceId,
      );
    }
    if (sysBootCompleted !== "1") {
      return this.unmetReadinessDiagnostic(
        "system-boot-complete",
        "sys.boot_completed is not 1",
        sysBootCompleted,
        deviceId,
      );
    }
    if (bootAnimationState && bootAnimationState !== "stopped") {
      return this.unmetReadinessDiagnostic(
        "boot-animation",
        "init.svc.bootanim has not stopped",
        bootAnimationState,
        deviceId,
      );
    }
    return undefined;
  }

  /**
   * Records an unmet readiness predicate with the value actually observed, so the
   * readiness timeout error names the exact check that never passed (#6818).
   */
  private unmetReadinessDiagnostic(
    phase: ReadinessDiagnosticPhase,
    check: string,
    observed: string,
    deviceId: string,
  ): ReadinessDiagnostic {
    const diagnostic = this.readinessDiagnostic(
      phase,
      `${check}; observed="${observed}"`,
      deviceId,
    );
    logger.debug(`[PARALLEL] ❌ ${deviceId} not ready: ${diagnostic.summary}`);
    return diagnostic;
  }

  private rejectedReadinessDiagnostic(
    checks: Array<[ReadinessDiagnosticPhase, PromiseSettledResult<ExecResult>]>,
  ): ReadinessDiagnostic | undefined {
    const rejected = checks.findLast((entry) => entry[1].status === "rejected");
    if (!rejected || rejected[1].status !== "rejected") {
      return undefined;
    }
    return this.readinessDiagnostic(rejected[0], rejected[1].reason);
  }

  private unknownEmulatorName(deviceId: string): string {
    return `Unknown (${deviceId})`;
  }

  private isUnknownEmulatorName(name: string, deviceId: string): boolean {
    return name === this.unknownEmulatorName(deviceId);
  }

  private matchesRequestedAvdOrUnknown(
    emulator: BootedDevice,
    avdName: string,
    targetDeviceId?: string,
  ): boolean {
    if (targetDeviceId === emulator.deviceId && !targetDeviceId.startsWith("emulator-")) {
      return true;
    }

    return (
      emulator.name === avdName ||
      this.isUnknownEmulatorName(emulator.name, emulator.deviceId) ||
      (targetDeviceId === emulator.deviceId && this.isUnknownEmulatorName(avdName, targetDeviceId))
    );
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
    let processExitError: ActionableError | null = null;
    let cleanupProcessListeners = () => {};
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
      const handleProcessExit = (code: number | null) => {
        // A null code means the process was killed by signal (e.g. SIGABRT from a
        // failed Qt xcb plugin on a headless host) — treat that as a failure too.
        if (code !== 0) {
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
              processExitError = new ActionableError(
                `Emulator failed to start: ${panicResult.message}`,
              );
            } else {
              processExitError = new ActionableError(
                `Emulator process exited with code ${code} while waiting for readiness`,
              );
            }
          }
          logger.error(
            `Emulator process exited during readiness wait: ${processExitError.message}`,
          );
        }
      };
      childProcess.stdout?.on("data", captureOutput);
      childProcess.stderr?.on("data", captureOutput);
      childProcess.on("exit", handleProcessExit);
      cleanupProcessListeners = () => {
        childProcess.stdout?.off("data", captureOutput);
        childProcess.stderr?.off("data", captureOutput);
        childProcess.off("exit", handleProcessExit);
      };
    }

    // Start background polling immediately with configurable intervals
    let foundDeviceId: string | null = null;
    let correlationFailure: string | undefined;
    let lastDiagnostic: ReadinessDiagnostic | undefined;
    const offlineTracker: OfflineTracker = { deviceId: null, since: null };

    perf.startOperation("devicePolling");
    const backgroundPoller = async () => {
      // Let the main loop register its wake-up first. When both sleeps share a
      // deadline, this lets a process-exit failure stop the poller before it
      // schedules another cycle.
      await Promise.resolve();
      while (polling.active && !foundDeviceId) {
        let correlatedTargetDeviceId: string | undefined;
        try {
          this.recordLaunchError(childProcess, (error) => {
            processExitError = error;
          });
          logger.debug(`Background polling iteration - checking for emulator '${avdName}'...`);

          correlatedTargetDeviceId = this.readinessTargetDeviceId(targetDeviceId, childProcess);
          const remainingTimeoutMs = timeoutMs - (this.timer.now() - startTime);
          if (remainingTimeoutMs <= 0) {
            polling.active = false;
            break;
          }
          await this.detectOfflineFailure(
            correlatedTargetDeviceId,
            offlineTracker,
            remainingTimeoutMs,
            signal,
          );
          await this.maybeRecoverFreshOffline(
            offlineTracker,
            options,
            correlatedTargetDeviceId,
            startTime,
            timeoutMs,
            avdName,
            signal,
          );
          if (!polling.active || this.timer.now() - startTime >= timeoutMs) {
            break;
          }

          // For local emulators, check for running devices
          logger.debug(`Checking for running local emulators...`);
          const scan = await this.getBootedDevicesWithDiagnostics(
            false,
            { bypassDeviceListCache: true },
            signal,
          );
          const scanDiagnostic = this.relevantScanDiagnostic(scan, correlatedTargetDeviceId);
          lastDiagnostic = scanDiagnostic;
          const runningEmulators = scan.devices;
          logger.debug(`Device scan complete - found ${runningEmulators.length} running emulators`);
          const readinessTimeoutMs = Math.max(0, timeoutMs - (this.timer.now() - startTime));

          correlationFailure = undefined;
          if (runningEmulators.length > 0) {
            logger.debug(
              `Found ${runningEmulators.length} running emulators: ${runningEmulators.map((e) => `${e.name}(${e.deviceId})`).join(", ")}`,
            );

            // Prefer an exact deviceId when startDevice already selected or correlated a device.
            let emulator = correlatedTargetDeviceId
              ? runningEmulators.find((emu) => emu.deviceId === correlatedTargetDeviceId)
              : undefined;
            if (correlatedTargetDeviceId) {
              logger.debug(
                `Exact deviceId match for '${correlatedTargetDeviceId}': ${emulator ? `Found ${emulator.deviceId}` : "Not found"}`,
              );
              if (
                emulator &&
                !this.matchesRequestedAvdOrUnknown(emulator, avdName, correlatedTargetDeviceId)
              ) {
                logger.debug(
                  `Exact deviceId match ${emulator.deviceId} resolved as '${emulator.name}', not requested AVD '${avdName}'`,
                );
                emulator = undefined;
              }
            }

            // Look for emulator by name next.
            if (!emulator && !correlatedTargetDeviceId) {
              const correlation = this.findNamedEmulator(avdName, childProcess, runningEmulators);
              emulator = correlation.emulator;
              correlationFailure = correlation.failure;
            }

            if (emulator && emulator.deviceId) {
              this.markTargetNotReady(offlineTracker, correlatedTargetDeviceId);
              correlationFailure = undefined;
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
                const [
                  deviceStateResult,
                  packageManagerResult,
                  sysBootCompletedResult,
                  bootAnimationResult,
                ] = await Promise.allSettled([
                  adb.executeCommand("get-state", readinessTimeoutMs, undefined, undefined, signal),
                  adb.executeCommand(
                    "shell pm list packages",
                    readinessTimeoutMs,
                    undefined,
                    undefined,
                    signal,
                  ),
                  adb.executeCommand(
                    "shell getprop sys.boot_completed",
                    readinessTimeoutMs,
                    undefined,
                    undefined,
                    signal,
                  ),
                  adb.executeCommand(
                    "shell getprop init.svc.bootanim",
                    readinessTimeoutMs,
                    undefined,
                    undefined,
                    signal,
                  ),
                ]);
                perf.endOperation("adbParallelChecks");

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
                  lastDiagnostic =
                    this.rejectedReadinessDiagnostic([
                      ["device-state", deviceStateResult],
                      ["package-manager", packageManagerResult],
                      ["system-boot-complete", sysBootCompletedResult],
                      ["boot-animation", bootAnimationResult],
                    ]) ?? lastDiagnostic;
                } else {
                  const stateOutput = deviceStateResult.value.stdout.trim();
                  const sysBootCompleted = sysBootCompletedResult.value.stdout.trim();
                  const bootAnimationState = bootAnimationResult.value.stdout.trim();
                  logger.debug(
                    `[PARALLEL] Package manager command completed for ${emulator.deviceId} - output: ${packageManagerResult.value.stdout.length} bytes`,
                  );
                  const unmetPredicate = this.unmetReadinessPredicate(
                    emulator.deviceId,
                    stateOutput,
                    packageManagerResult.value,
                    sysBootCompleted,
                    bootAnimationState,
                  );
                  if (unmetPredicate) {
                    // An upstream scan failure (discovery, AVD-name resolution) is the
                    // root cause when it is present, so it outranks the probe verdict.
                    lastDiagnostic = scanDiagnostic ?? unmetPredicate;
                  } else {
                    logger.debug(
                      `[PARALLEL] ✅ Device state check passed for ${emulator.deviceId}`,
                    );
                    logger.debug(
                      `[PARALLEL] ✅ Package manager is responsive for ${emulator.deviceId} - emulator is ready!`,
                    );
                    logger.debug(
                      `[PARALLEL] ✅ Android boot-complete signals are ready for ${emulator.deviceId}`,
                    );
                    logger.debug(
                      `[PARALLEL] ✅ No package manager errors detected - marking emulator as ready`,
                    );
                    foundDeviceId = emulator.deviceId;
                    return;
                  }
                }
              } catch (parallelError) {
                this.throwIfReadinessAborted(signal);
                logger.debug(
                  `[PARALLEL] ❌ Parallel checks failed for ${emulator.deviceId}: ${parallelError}`,
                );
              }
            } else {
              logger.debug(`No suitable emulator found for '${avdName}' - will continue polling`);
            }
          } else {
            logger.debug(`No running emulators detected - will continue polling`);
          }
        } catch (error) {
          lastDiagnostic =
            this.handleReadinessPollingError(
              error,
              signal,
              polling,
              this.readinessDeadlineReached(startTime, timeoutMs),
            ) ?? lastDiagnostic;
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
        while (polling.active && !foundDeviceId && remainingPollingDelayMs > 0) {
          const sleepChunkMs = Math.min(remainingPollingDelayMs, MAX_POLLING_SLEEP_CHUNK_MS);
          await this.waitForReadinessDelay(sleepChunkMs, signal, polling, startTime, timeoutMs);
          remainingPollingDelayMs -= sleepChunkMs;
        }
      }
      logger.debug(
        `Background polling stopped - pollingActive: ${polling.active}, foundDeviceId: ${foundDeviceId}`,
      );
    };

    // Start background polling immediately
    const pollingPromise = backgroundPoller();

    // Main timeout loop
    while (this.readinessWaitActive(polling, startTime, timeoutMs)) {
      const readinessFailure = processExitError;
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
        processExitError = null;
        continue;
      }

      if (foundDeviceId) {
        polling.active = false;
        perf.endOperation("devicePolling");
        cleanupProcessListeners();
        logger.info(`Emulator '${avdName}' is ready! Device ID: ${foundDeviceId}`);
        const bootedDevice = {
          name: avdName,
          platform: "android",
          deviceId: foundDeviceId,
        } as BootedDevice;
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

    if (foundDeviceId) {
      logger.info(`Emulator '${avdName}' is ready! Device ID: ${foundDeviceId}`);
      const bootedDevice = {
        name: avdName,
        platform: "android",
        deviceId: foundDeviceId,
      } as BootedDevice;
      await this.wakeAndUnlockAfterReadiness(bootedDevice, signal, options, perf);
      return bootedDevice;
    }

    const correlatedTargetDeviceId = this.readinessTargetDeviceId(targetDeviceId, childProcess);
    const target = this.readinessTarget(correlatedTargetDeviceId, offlineTracker);
    throw this.readinessTimeoutError(
      avdName,
      timeoutMs,
      processExitError,
      correlationFailure,
      lastDiagnostic,
      target,
    );
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
   * Delegates to the shared {@link WakeAndUnlock} feature so boot uses the same
   * path as the `wakeAndUnlock` tool: a swipe lock is dismissed, and a secure
   * lock is unlocked with the PIN remembered for the device this session (if
   * any). A secure device with no remembered PIN is left locked — non-fatal, the
   * device is still ready and the user can unlock it with the tool (#4360).
   * @param device - The booted device to wake and unlock
   */
  private async wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    try {
      const wakeAndUnlock = new WakeAndUnlock(device, this.adbFactory, {
        timer: this.timer,
        credentialStore: new DeviceLockStore(),
      });
      const result = await wakeAndUnlock.execute();
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
