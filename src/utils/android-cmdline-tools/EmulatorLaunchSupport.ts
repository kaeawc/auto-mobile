import { ActionableError, type DeviceInfo } from "../../models";
import type { AdmitColdBoot, BootAdmission } from "../../models/BootAdmission";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import type { Timer } from "../SystemTimer";
import type { HostChildProcess as ChildProcess, SpawnFn } from "../HostCommandExecutor";
import type { AvdConfig, AvdConfigReader } from "./AvdConfigReader";
import type {
  EmulatorDeviceIdReservation,
  EmulatorPortReservations,
} from "./EmulatorPortReservations";
import { AMBIENT_ENV, ENV, readEnvRaw, readEnvTrimmed } from "../../config/env";

export type LaunchFailureCategory =
  | "display_initialization_failed"
  | "hardware_acceleration_unavailable"
  | "kvm_permission_denied"
  | "missing_shared_library";

export interface EmulatorLaunchState {
  launchOutput: string;
  duplicateAvdDetected: boolean;
  earlyExitCategory: LaunchFailureCategory | undefined;
  startupValidationComplete: boolean;
  stdoutGraceTimeout: NodeJS.Timeout | undefined;
  serialPollInterval: NodeJS.Timeout | undefined;
  serialProbeInFlight: boolean;
  startupAccelerationFailureDetected: boolean;
  childTerminationObserved: boolean;
  exitCode: number | null | undefined;
  exitSignal: NodeJS.Signals | null | undefined;
  provisionalPostValidationExitError: ActionableError | undefined;
  resolvePostValidationExit: ((error: ActionableError | undefined) => void) | undefined;
  exitDrainTimeout: NodeJS.Timeout | undefined;
  earlyExitFinalization: Promise<void> | undefined;
}

export interface EmulatorLaunchMonitorContext {
  state: EmulatorLaunchState;
  child: ChildProcess;
  perf: ReturnType<typeof createGlobalPerformanceTracker>;
  appendRedactedLaunchOutput: (output: string) => void;
  currentLaunchOutput: () => string;
  recordEarlyExitCategory: (output: string) => void;
  completeStartupValidation: () => void;
  resolve: (value: ChildProcess | null) => void;
  reject: (error: ActionableError) => void;
}

export interface EmulatorEarlyExitContext {
  state: EmulatorLaunchState;
  child: ChildProcess;
  avdName: string;
  perf: ReturnType<typeof createGlobalPerformanceTracker>;
  clearExitDrainTimeout: () => void;
  flushLaunchOutput: () => string;
  completeStartupValidation: () => void;
  resolve: (value: ChildProcess | null) => void;
  reject: (error: ActionableError) => void;
}

export interface EmulatorProcessOptions {
  cameraPosterPath?: string;
  requestedExtraArgs?: readonly string[];
  onSpawn?: (process: ChildProcess) => void;
  isCancelled?: () => boolean;
  capturePreLaunchDeviceIds?: boolean;
  expectedDeviceId?: string;
  signal?: AbortSignal;
  /** Takes a capacity slot before the cold spawn (refuses at once at the limit); see {@link AndroidEmulatorLaunchRequest.admitColdBoot}. */
  admitColdBoot?: AdmitColdBoot;
  /** Receives the admission so the launch can free it when it is cancelled. */
  onAdmitted?: (admission: BootAdmission) => void;
}

export interface EmulatorProcessLaunch {
  process: ChildProcess | null;
  outcome: AndroidEmulatorLaunchOutcome;
}

export const MAX_LAUNCH_OUTPUT_LINES = 50;
export const MAX_LAUNCH_OUTPUT_CHARS = 16_384;
export const EARLY_EXIT_DRAIN_TIMEOUT_MS = 1_000;

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

export interface EmulatorLaunchOutputSource {
  snapshot(): string;
  flush(): string;
}

const emulatorLaunchOutputSources = new WeakMap<ChildProcess, EmulatorLaunchOutputSource>();

export function recordEmulatorLaunchOutputSource(
  child: ChildProcess,
  source: EmulatorLaunchOutputSource,
): void {
  emulatorLaunchOutputSources.set(child, source);
}

export function emulatorLaunchOutputSource(
  child: ChildProcess,
): EmulatorLaunchOutputSource | undefined {
  return emulatorLaunchOutputSources.get(child);
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
  const explicit = readEnvRaw(ENV.EMULATOR_HEADLESS, env);
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
      readEnvTrimmed(AMBIENT_ENV.DISPLAY, env) || readEnvTrimmed(AMBIENT_ENV.WAYLAND_DISPLAY, env),
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
      'AUTOMOBILE_EMULATOR_ARGS must be a JSON array of emulator arguments, for example ["-gpu", "swiftshader"]',
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

export class EmulatorExitedDuringReadinessError extends ActionableError {
  constructor(
    readonly exitCode: number | null,
    message?: string,
  ) {
    super(message ?? `Emulator process exited with code ${exitCode} while waiting for readiness`);
    this.name = "EmulatorExitedDuringReadinessError";
  }
}

/**
 * How a launch obtained its emulator. Only `launched` carries a process handle of this
 * launch's own; the others resolve with `process: null` (#3938) and the caller adopts the
 * emulator through its readiness wait.
 * - `launched`: this launch spawned the emulator process.
 * - `joined-in-process-launch`: another launch of the same AVD was already in flight in this
 *   process; this launch joins it.
 * - `already-running`: the AVD was already booted and visible to this process's adb (for
 *   example an emulator the user started by hand), or already starting under a reservation,
 *   launch, or running-AVD advertisement.
 * - `duplicate-of-external`: the spawned emulator exited as a duplicate of an emulator for this
 *   AVD started outside this process, which this process's adb did not list when the launch
 *   checked.
 */
export type AndroidEmulatorLaunchOutcome =
  | "launched"
  | "joined-in-process-launch"
  | "already-running"
  | "duplicate-of-external";

/** The slice of the emulator client the launcher needs: collaborators and the stderr classifiers. */
export interface EmulatorLauncherHost {
  reservations(): EmulatorPortReservations;
  timer(): Timer;
  emulatorPath(): string;
  spawnFn(): SpawnFn;
  platform(): NodeJS.Platform;
  avdConfigReader(): AvdConfigReader;
  launchErrors(): WeakMap<ChildProcess, ActionableError>;
  launchErrorFinalizations(): WeakMap<ChildProcess, Promise<ActionableError | undefined>>;
  launchTargetDeviceIds(): WeakMap<ChildProcess, string>;
  isEmulatorSerialListed(serial: string, signal?: AbortSignal): Promise<boolean>;
  accelerationCheckCategory(output: string): LaunchFailureCategory | undefined;
  adoptsExistingAvdLaunch(
    avdName: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    signal?: AbortSignal,
  ): Promise<boolean>;
  appendCategory(error: ActionableError, category: LaunchFailureCategory): ActionableError;
  assertCameraPosterColdBoot(posterPath?: string): void;
  captureLaunchTargetDeviceId(childProcess: ChildProcess, output: string): void;
  checkArchitectureCompatibility(
    avdName: string,
    avdConfig?: AvdConfig | null,
  ): Promise<{ compatible: boolean; hostArch: string; avdArch?: string; reason?: string }>;
  detectArchitecturePanic(output: string): {
    isPanic: boolean;
    message?: string;
    hostArch?: string;
    avdArch?: string;
  };
  detectCorruptImage(output: string): {
    isCorrupt: boolean;
    message?: string;
    suggestion?: string;
  };
  detectDisplayError(output: string): {
    isDisplayError: boolean;
    message?: string;
    suggestion?: string;
  };
  emulatorAudioArguments(): string[];
  formatEarlyExitError(
    avdName: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    category: LaunchFailureCategory | undefined,
    output: string,
    accelCheckOutput: string,
  ): ActionableError;
  launchFailureCategory(output: string): LaunchFailureCategory | undefined;
  listAvds(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    coalesceInventoryEnrichment?: boolean;
  }): Promise<DeviceInfo[]>;
  recordReservedEmulatorDeviceId(
    childProcess: ChildProcess,
    reservation: EmulatorDeviceIdReservation,
  ): void;
  releaseReservationIfLaunchCancelled(
    avdName: string,
    reservation: EmulatorDeviceIdReservation | undefined,
    isCancelled?: () => boolean,
  ): void;
  runAccelerationCheck(): Promise<string>;
  sandboxFailure(output: string): ActionableError | null;
  throwIfLaunchCancelled(avdName: string, isCancelled?: () => boolean): void;
  validateAvdMemory(avdName: string, avdConfig: AvdConfig | null): void;
}
