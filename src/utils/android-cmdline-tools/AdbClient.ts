import { isDeviceLossCancellationReason } from "../deviceLossCancellationReason";
import {
  withAndroidTransportId,
  copyAndroidTransportId,
  type AndroidTransportRouting,
} from "../androidSerial";
import { raceWithDeadline } from "../raceWithDeadline";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { runExecSeam } from "../ExecSeam";
import {
  DefaultHostCommandExecutor,
  execFileAsync as sharedExecFileAsync,
  type HostProcessExecutor,
  type HostChildProcess as ChildProcess,
  type SpawnFn,
} from "../HostCommandExecutor";
import {
  BootedDevice,
  ExecResult,
  AndroidUser,
  classifyAndroidUser,
  DeviceLockState,
} from "../../models";
import {
  AndroidToolsDetectionAbortError,
  AndroidToolsDetectionTimeoutError,
  detectAndroidCommandLineTools,
  getBestAndroidToolsLocation,
} from "./detection";
import { resolveAndroidSdkRoot } from "./androidSdkRoot";
import { parseResumedActivityForDisplay } from "./parseResumedActivity";
import {
  AdbExecutor,
  type ForegroundApp,
  type ForegroundAppReadResult,
  type AdbExecuteOptions,
  type AdbDeviceState,
  type AdbProcess,
  type AdbSpawnOptions,
  type DeviceTimestampResult,
} from "./interfaces/AdbExecutor";
import { runWithAbortSignal, getAbortSignal } from "../AbortContext";
import { trackAmbient } from "../PerfContext";
import { OPERATION_CANCELLED_MESSAGE } from "../constants";
import { RetryExecutor, defaultRetryExecutor } from "../retry/RetryExecutor";
import { delayForAttempt, sequenceBackoff } from "../Backoff";
import { TTLCache } from "../cache/Cache";
import { SingleFlight } from "../cache/SingleFlight";
import { Timer, defaultTimer } from "../SystemTimer";
import { isAdbMissingDeviceError, notifyAdbMissingDevice } from "./AdbDeviceHealth";
import type { EmulatorConsoleBusyRegistry } from "./EmulatorConsoleBusyRegistry";
import { DefaultSystemDetection, type SystemDetection } from "../system/SystemDetection";
import {
  defaultDiscoveryObservationSequence,
  type DiscoveryObservationSequence,
} from "../DiscoveryObservationSequence";

type ExecFileAsync = (file: string, args: string[], maxBuffer?: number) => Promise<ExecResult>;

interface CommandArgState {
  current: string;
  inSingle: boolean;
  inDouble: boolean;
  escape: boolean;
}

const PROCESS_SETTLEMENT_GRACE_MS = 1_000;

// Route the default long-lived spawn through the shared host-process seam so the
// client no longer reaches for `child_process.spawn` directly (issue #5459). The
// executor's `spawn` is a plain passthrough, so this is behavior-identical; all
// of AdbClient's own timeout/abort/process-tracking orchestration is unchanged.
export const adbHostProcessExecutor: HostProcessExecutor = new DefaultHostCommandExecutor();

/**
 * Thrown when an adb command exceeds its effective `timeoutMs` budget, as
 * opposed to failing for a device reason (offline, adb error, non-numeric output).
 *
 * The distinction is load-bearing for callers that thread a request deadline — the
 * daemon's append-text path. They tell "our budget expired" apart from "the device
 * cannot answer" by an `instanceof` check, never a message match: the former must
 * NOT be cached (a later request with a fresh budget should retry), the latter is
 * cached so a dead device is not re-probed on every call. The message is preserved
 * verbatim, so existing message-based logging is unaffected.
 */
export class AdbCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbCommandTimeoutError";
  }
}

export class AdbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbUnavailableError";
  }
}

// Module-level cache configuration and instances
const moduleTimer: Timer = defaultTimer;
let deviceListCache: TTLCache<string, BootedDevice[]> | null = null;
let deviceListSingleFlight = new SingleFlight<string, BootedDevice[]>();
let deviceListGeneration = 0;
let deviceListPublishedGeneration = 0;
// Keep production clients sharing the resolved path while isolating injected
// execution seams. A module-wide path cache keyed only by "adbPath" lets one
// test/client reuse another client's incomplete or synthetic discovery result.
let adbPathCaches = new WeakMap<ExecFileAsync, TTLCache<string, string>>();

const DEVICE_LIST_CACHE_TTL_MS = 5000; // 5 seconds
const ADB_PATH_CACHE_TTL_MS = 60000; // 1 minute - ADB path rarely changes
const MACOS_MISSING_ADB_PROBE_COOLDOWN_MS = 30000;

function getDeviceListCache(timer: Timer): TTLCache<string, BootedDevice[]> {
  if (!deviceListCache) {
    deviceListCache = new TTLCache(timer, { ttlMs: DEVICE_LIST_CACHE_TTL_MS });
  }
  return deviceListCache;
}

function getAdbPathCache(execAsync: ExecFileAsync): TTLCache<string, string> {
  let cache = adbPathCaches.get(execAsync);
  if (!cache) {
    cache = new TTLCache(moduleTimer, { ttlMs: ADB_PATH_CACHE_TTL_MS });
    adbPathCaches.set(execAsync, cache);
  }
  return cache;
}

export function resetAdbClientCaches(): void {
  deviceListCache = null;
  deviceListSingleFlight = new SingleFlight();
  deviceListPublishedGeneration = ++deviceListGeneration;
  adbPathCaches = new WeakMap();
  AdbClient.resetMissingAdbProbeState();
}

export function resetAdbDeviceListCache(): void {
  deviceListCache = null;
  deviceListSingleFlight = new SingleFlight();
  deviceListPublishedGeneration = ++deviceListGeneration;
}

// Route the execFile leg through the shared exec seam (issue #5459) so the option
// mapping and the Buffer→string / trim / toString / includes coercion live in one
// place and this wrapper no longer reaches for `child_process` on its exec path.
//
// `preserveError: true` keeps the raw execFile rejection intact. This wrapper
// historically awaited `promisify(execFile)` directly and never ran the error
// through `wrapCommandError`, so callers (path detection, the fallback exec seam)
// still observe node's original error with its `.code`/`.stderr` fields — the
// seam's default wrap would drop those.
const execFileAsync: ExecFileAsync = async (
  file: string,
  args: string[],
  maxBuffer?: number,
): Promise<ExecResult> => {
  // Debug: Log when real exec is called (helps trace daemon startup in tests)
  if (process.env.DEBUG_ADB_EXEC) {
    logger.debug(`[DEBUG_ADB_EXEC] Real execFileAsync called: ${file} ${args.join(" ")}`);
    logger.debug(`[DEBUG_ADB_EXEC] Stack trace:`, new Error().stack);
  }
  return runExecSeam(
    (execOptions) => sharedExecFileAsync(file, args, execOptions),
    { maxBuffer },
    { command: file, args },
    { preserveError: true },
  );
};

export class AdbClient implements AdbExecutor {
  device: BootedDevice | null;
  execAsync: ExecFileAsync;
  spawnFn: SpawnFn;
  private adbPath: string;
  private isTestMode: boolean;
  private readonly hostProcessExecutor: HostProcessExecutor;
  private activeProcesses: Set<ChildProcess> = new Set();
  /**
   * Cached API level for the current device. Intentionally never expires during
   * a device session because API level is constant. Reset on setDevice().
   * NOT using TTLCache: session-scoped without time-based expiration.
   */
  private apiLevelCache: number | null | undefined;
  private readonly retryExecutor: RetryExecutor;
  private readonly timer: Timer;

  static readonly DEVICE_LIST_TIMEOUT_MS = 10_000;
  private static readonly DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
  private static readonly MAX_ADB_RETRIES = 3;
  private static readonly ADB_RETRY_BACKOFF = sequenceBackoff([200, 500, 1000]);
  private static readonly MAX_MACOS_MISSING_ADB_PROBES = 3;
  private static macosMissingAdbProbes = 0;
  private static macosMissingAdbProbeStartedAt: number | null = null;

  /**
   * Create an AdbClient instance
   * @param device - Optional device
   * @param execAsyncFn - promisified exec function (for testing)
   * @param spawnFn - spawn function (for testing)
   * @param retryExecutor - retry executor for command retries (for testing)
   * @param timer - Timer for delays and time tracking
   * @param observationSequence - Monotonic discovery ordering source
   * @param consoleBusyRegistry - Shared console-exclusive operation state
   * @param defaultTimeoutMs - Per-command budget when no timeout is supplied
   * @param hostProcessExecutor - Host process executor for cancellable commands
   */
  constructor(
    device: BootedDevice | null = null,
    execAsyncFn:
      | ((command: string, maxBuffer?: number) => Promise<ExecResult>)
      | ExecFileAsync
      | null = null,
    spawnFn: SpawnFn | null = null,
    retryExecutor: RetryExecutor = defaultRetryExecutor,
    timer: Timer = defaultTimer,
    private readonly systemDetectionFactory: () => SystemDetection = () =>
      new DefaultSystemDetection(),
    private readonly observationSequence: DiscoveryObservationSequence = defaultDiscoveryObservationSequence,
    private readonly consoleBusyRegistry?: EmulatorConsoleBusyRegistry,
    private readonly defaultTimeoutMs: number = AdbClient.DEFAULT_COMMAND_TIMEOUT_MS,
    hostProcessExecutor: HostProcessExecutor = adbHostProcessExecutor,
    private readonly transportRouting?: AndroidTransportRouting,
  ) {
    this.device = device;
    this.hostProcessExecutor = hostProcessExecutor;
    // Test mode if: custom execAsync provided OR global test mode flag is set
    // Check for any truthy value (not just exactly "true") to handle different env var formats
    const testModeEnv = process.env.AUTOMOBILE_TEST_MODE;
    this.isTestMode = this.hasTestExecution(execAsyncFn, testModeEnv);
    this.execAsync = this.resolveExecAsync(execAsyncFn);
    this.spawnFn = this.resolveSpawnFn(spawnFn);
    this.retryExecutor = retryExecutor;
    this.timer = timer;
    // Initialize with fallback, will be updated lazily
    this.adbPath = this.getFallbackAdbPath();

    // Debug: Log when a real (non-test) AdbClient is created
    if (process.env.DEBUG_ADB_EXEC && !this.isTestMode) {
      logger.debug(`[DEBUG_ADB_EXEC] Real AdbClient created (not test mode)`);
      logger.debug(`[DEBUG_ADB_EXEC] Stack trace:`, new Error().stack);
    }
  }

  private hasTestExecution(
    execAsyncFn:
      | ((command: string, maxBuffer?: number) => Promise<ExecResult>)
      | ExecFileAsync
      | null,
    testModeEnv: string | undefined,
  ): boolean {
    return (
      execAsyncFn !== null ||
      (testModeEnv !== undefined &&
        testModeEnv !== "" &&
        testModeEnv !== "false" &&
        testModeEnv !== "0")
    );
  }

  private resolveExecAsync(
    execAsyncFn:
      | ((command: string, maxBuffer?: number) => Promise<ExecResult>)
      | ExecFileAsync
      | null,
  ): ExecFileAsync {
    // In test mode without custom exec function, use a stub that returns empty results
    // This prevents any real adb commands from being executed
    if (this.isTestMode && execAsyncFn === null) {
      return async (): Promise<ExecResult> => ({
        stdout: "",
        stderr: "",
        toString() {
          return "";
        },
        trim() {
          return "";
        },
        includes() {
          return false;
        },
      });
    }
    return execAsyncFn ? this.wrapExecAsync(execAsyncFn) : execFileAsync;
  }

  private resolveSpawnFn(spawnFn: SpawnFn | null): SpawnFn {
    return spawnFn || ((file, args, options) => adbHostProcessExecutor.spawn(file, args, options));
  }

  private wrapExecAsync(
    execAsyncFn: ((command: string, maxBuffer?: number) => Promise<ExecResult>) | ExecFileAsync,
  ): ExecFileAsync {
    if (execAsyncFn.length >= 3) {
      return execAsyncFn as ExecFileAsync;
    }
    return async (file: string, args: string[], maxBuffer?: number) => {
      const command = [file, ...args].join(" ");
      return (execAsyncFn as (command: string, maxBuffer?: number) => Promise<ExecResult>)(
        command,
        maxBuffer,
      );
    };
  }

  /**
   * Get fallback ADB path using environment variables and PATH
   */
  private getFallbackAdbPath(): string {
    // Try environment variables
    const androidHome = resolveAndroidSdkRoot(process.env);
    if (androidHome) {
      return `${androidHome}/platform-tools/adb`;
    }

    // Final fallback to PATH
    return "adb";
  }

  /**
   * Get the ADB path asynchronously via detection
   */
  private async getAdbPath(timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    const deadlineMs = timeoutMs === undefined ? undefined : this.timer.now() + timeoutMs;
    // 1. Try environment variables first (fastest path)
    const envPath = this.getFallbackAdbPath();
    if (envPath !== "adb") {
      // We got a path from environment variables, verify it exists
      try {
        await this.executeAdbPathProbe(envPath, ["version"], deadlineMs, signal);
        logger.debug(`Using ADB from environment: ${envPath}`);
        return envPath;
      } catch (error) {
        this.throwIfAdbPathTimeout(error, signal);
        logger.debug(`ADB path from environment not working: ${envPath}`);
      }
    }

    // 2. Try to find via `which adb` (works in CI environments where adb is in PATH)
    try {
      const whichResult = await this.executeAdbPathProbe("which", ["adb"], deadlineMs, signal);
      const adbFromPath = whichResult.stdout.trim();
      if (adbFromPath) {
        logger.debug(`Found ADB via which: ${adbFromPath}`);
        return adbFromPath;
      }
    } catch (error) {
      this.throwIfAdbPathTimeout(error, signal);
      logger.debug("ADB not found via 'which adb'");
    }

    // 3. Try Android command line tools detection (slower, more comprehensive)
    try {
      const locations = await detectAndroidCommandLineTools(
        this.createDeadlineBoundSystemDetection(deadlineMs, signal),
      );
      const bestLocation = getBestAndroidToolsLocation(locations);

      if (bestLocation) {
        // For Homebrew installations, the platform-tools are in the SDK root directory
        if (bestLocation.source === "homebrew") {
          // /opt/homebrew/share/android-commandlinetools/cmdline-tools/latest -> /opt/homebrew/share/android-commandlinetools
          const sdkRoot = bestLocation.path.replace("/cmdline-tools/latest", "");
          return `${sdkRoot}/platform-tools/adb`;
        }

        // For standard installations, look in the parent SDK directory
        const sdkRoot = bestLocation.path.replace("/cmdline-tools/latest", "");
        return `${sdkRoot}/platform-tools/adb`;
      }
    } catch (error) {
      if (error instanceof AndroidToolsDetectionTimeoutError) {
        throw new AdbCommandTimeoutError(error.message);
      }
      if (error instanceof AndroidToolsDetectionAbortError) {
        throw error.abortError;
      }
      logger.debug(`Failed to detect ADB path via Android tools detection: ${error}`);
    }

    // 4. Final fallback - just use "adb" and hope it's in PATH
    logger.debug("Using fallback ADB path: adb");
    return "adb";
  }

  private async executeAdbPathProbe(
    file: string,
    args: string[],
    deadlineMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const timeoutMs = deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new AdbCommandTimeoutError(
        `Command timed out before ADB path discovery: ${file} ${args.join(" ")}`,
      );
    }
    return this.execWithSignal(file, args, undefined, timeoutMs, signal);
  }

  private createDeadlineBoundSystemDetection(
    deadlineMs: number | undefined,
    signal?: AbortSignal,
  ): SystemDetection {
    const defaults = this.systemDetectionFactory();
    return {
      getCurrentPlatform: () => defaults.getCurrentPlatform(),
      getHomeDir: () => defaults.getHomeDir(),
      getEnvVar: (name) => defaults.getEnvVar(name),
      fileExistsSync: (path) => defaults.fileExistsSync(path),
      fileExists: (path) => this.executeDetectionFileProbe(defaults, path, deadlineMs, signal),
      executeCommand: async (file, args = []) => {
        try {
          return await this.executeAdbPathProbe(file, args, deadlineMs, signal);
        } catch (error) {
          if (error instanceof AdbCommandTimeoutError) {
            throw new AndroidToolsDetectionTimeoutError(error.message);
          }
          if (signal?.aborted) {
            throw new AndroidToolsDetectionAbortError(this.getAbortError(signal));
          }
          throw error;
        }
      },
    };
  }

  private async executeDetectionFileProbe(
    systemDetection: SystemDetection,
    path: string,
    deadlineMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) {
      throw new AndroidToolsDetectionAbortError(this.getAbortError(signal));
    }

    const timeoutMs = deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new AndroidToolsDetectionTimeoutError(
        `Command timed out before ADB path discovery: ${path}`,
      );
    }
    if (timeoutMs === undefined && !signal) {
      return systemDetection.fileExists(path);
    }

    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timeoutHandle) {
          this.timer.clearTimeout(timeoutHandle);
        }
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };
      const onAbort = () =>
        settle(() => reject(new AndroidToolsDetectionAbortError(this.getAbortError(signal!))));

      if (timeoutMs !== undefined) {
        timeoutHandle = this.timer.setTimeout(
          () =>
            settle(() =>
              reject(
                new AndroidToolsDetectionTimeoutError(
                  `Command timed out before ADB path discovery: ${path}`,
                ),
              ),
            ),
          timeoutMs,
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void systemDetection.fileExists(path).then(
        (exists) => settle(() => resolve(exists)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  private throwIfAdbPathTimeout(error: unknown, signal?: AbortSignal): void {
    if (error instanceof AdbCommandTimeoutError) {
      throw error;
    }
    if (signal?.aborted) {
      throw this.getAbortError(signal);
    }
  }

  private getRemainingTimeoutMs(
    timeoutMs: number | undefined,
    startTime: number,
    command: string,
  ): number | undefined {
    if (timeoutMs === undefined) {
      return undefined;
    }
    const remainingMs = timeoutMs - (this.timer.now() - startTime);
    if (remainingMs <= 0) {
      throw new AdbCommandTimeoutError(
        `Command timed out after ${timeoutMs}ms before execution: ${command}`,
      );
    }
    return remainingMs;
  }

  /**
   * Public accessor for the resolved adb path. Same detection as `ensureAdbPath`,
   * exposed for diagnostics that want the path without running an adb command.
   */
  async getAdbPathOnly(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string> {
    return this.ensureAdbPath(options?.timeoutMs, options?.signal);
  }

  /**
   * Ensure ADB path is properly detected and cached
   */
  private async ensureAdbPath(timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    // In test mode, skip detection and use fallback (usually "adb")
    if (this.isTestMode) {
      return this.adbPath;
    }

    // Check cache first - TTLCache handles expiration automatically
    const cache = getAdbPathCache(this.execAsync);
    const cachedPath = cache.get("adbPath");
    if (cachedPath) {
      this.adbPath = cachedPath;
      return this.adbPath;
    }

    // Detect and cache the path
    const detectedPath = await this.getAdbPath(timeoutMs, signal);
    if (detectedPath === "adb") {
      // The bare command is only a guess. Let the next request retry discovery
      // instead of treating this fallback as a resolved path for one minute.
      cache.delete("adbPath");
    } else {
      cache.set("adbPath", detectedPath);
      AdbClient.resetMissingAdbProbeState();
    }
    this.adbPath = detectedPath;
    return this.adbPath;
  }

  /**
   * Get the base ADB command with optional device ID
   * @returns The base ADB command
   */
  async getBaseCommand(): Promise<string> {
    const { adbPath, baseArgs } = await this.getBaseCommandParts();
    return [adbPath, ...baseArgs].join(" ");
  }

  async getBaseCommandParts(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ adbPath: string; baseArgs: string[] }> {
    const adbPath = await this.ensureAdbPath(timeoutMs, signal);
    const deviceId = this.device?.deviceId;
    const baseArgs: string[] = [];

    if (deviceId) {
      baseArgs.push("-s", this.transportRouting?.resolveTransport(deviceId) ?? deviceId);
    }

    return { adbPath, baseArgs };
  }

  /**
   * Set the target device ID
   * @param deviceId - Device identifier
   */
  setDevice(device: BootedDevice): void {
    this.device = device;
    this.apiLevelCache = undefined;
  }

  /**
   * Execute an ADB command
   * @param command - The ADB command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @param maxBuffer - Optional maximum buffer size for command output
   * @param noRetry - Optional flag to disable retry logic for commands expected to fail
   * @returns Promise with command output
   */
  async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
    waitForProcessSettlementAfterAbort?: boolean,
  ): Promise<ExecResult> {
    return this.execute(this.parseCommandArgs(command), {
      timeoutMs,
      maxBuffer,
      noRetry,
      signal,
      waitForProcessSettlementAfterAbort,
    });
  }

  async execute(args: string[], options: AdbExecuteOptions = {}): Promise<ExecResult> {
    const {
      timeoutMs,
      maxBuffer,
      noRetry,
      signal,
      beforeDispatch,
      waitForProcessSettlementAfterAbort,
    } = options;
    // The default uses the same AdbCommandTimeoutError and SIGTERM path as an
    // explicit timeout; long-lived spawn commands do not pass through here.
    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;
    const startTime = this.timer.now();
    const result = await this.executeArgsImpl(args, {
      timeoutMs: effectiveTimeoutMs,
      maxBuffer,
      noRetry,
      signal,
      beforeDispatch,
      waitForProcessSettlementAfterAbort,
    });
    AdbClient.resetMissingAdbProbeState();
    const duration = this.timer.now() - startTime;
    const command = args.join(" ");

    // Only log longer commands or ones that take significant time
    if (
      duration > 10 ||
      command.includes("screencap") ||
      command.includes("uiautomator") ||
      command.includes("getevent")
    ) {
      const outputSize = result.stdout.length + result.stderr.length;
      logger.debug(
        `[ADB] Command completed in ${duration}ms (output: ${outputSize} bytes): ${command.length > 50 ? command.substring(0, 50) + "..." : command}`,
      );
    }

    return result;
  }

  async spawn(args: string[], options: AdbSpawnOptions = {}): Promise<AdbProcess> {
    const startTime = this.timer.now();
    const signal = options.signal ?? getAbortSignal();
    if (signal?.aborted) {
      throw this.getAbortError(signal);
    }

    const { adbPath, baseArgs } = await this.getBaseCommandParts(options.timeoutMs, signal);
    if (signal?.aborted) {
      throw this.getAbortError(signal);
    }
    const fullArgs = [...baseArgs, ...args];
    const remainingTimeoutMs = this.getRemainingTimeoutMs(
      options.timeoutMs,
      startTime,
      args.join(" "),
    );
    const busyAtDispatch = this.getConsoleBusyAtDispatch();
    const child = this.spawnFn(adbPath, fullArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.abortSignalScope === "startup" ? undefined : signal,
    });
    this.activeProcesses.add(child);

    let timeoutId: NodeJS.Timeout | undefined;
    let cleaned = false;
    let settleStart: ((error?: Error) => void) | undefined;
    const removeStartupCancellation = () => {
      signal?.removeEventListener("abort", onAbort);
      if (timeoutId) {
        this.timer.clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      this.activeProcesses.delete(child);
      child.off("exit", onExit);
      child.off("error", onError);
      removeStartupCancellation();
    };
    const onExit = () => cleanup();
    const onError = (error: Error) => {
      this.notifyMissingDeviceIfNeeded(error, busyAtDispatch, baseArgs[1]);
      cleanup();
    };
    const onAbort = () => {
      if (!cleaned) {
        child.kill("SIGTERM");
        settleStart?.(this.getAbortError(signal));
        cleanup();
      }
    };

    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (remainingTimeoutMs !== undefined) {
      timeoutId = this.timer.setTimeout(onAbort, remainingTimeoutMs);
    }

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onInitialError);
        settleStart = undefined;
        if (options.abortSignalScope === "startup") {
          removeStartupCancellation();
        }
        resolve();
      };
      const onInitialError = (error: Error) => {
        child.off("spawn", onSpawn);
        settleStart = undefined;
        reject(error);
      };
      settleStart = (error) => (error ? reject(error) : resolve());
      child.once("spawn", onSpawn);
      child.once("error", onInitialError);
      if (signal?.aborted) {
        onAbort();
      }
    });

    // eslint-disable-next-line auto-mobile/no-unknown-cast -- the public interface deliberately exposes only lifecycle, stdio, and kill.
    return child as unknown as AdbProcess;
  }

  /**
   * Get device time in milliseconds since epoch.
   * Falls back to host time if the device timestamp cannot be retrieved.
   */
  async getDeviceTimestampMs(): Promise<number> {
    const result = await this.getDeviceTimestampMsWithSource();
    return result.timestampMs;
  }

  /**
   * Get device time in milliseconds since epoch and identify its clock source.
   * Falls back to host time if the device timestamp cannot be retrieved.
   */
  async getDeviceTimestampMsWithSource(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<DeviceTimestampResult> {
    try {
      const result = await this.executeCommand(
        "shell date +%s%3N",
        timeoutMs,
        undefined,
        true,
        signal,
      );
      const trimmed = result.stdout.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          return { timestampMs: parsed, source: "device-ms" };
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.debug(`[ADB] Failed to read device time with ms precision: ${error}`);
    }

    try {
      const result = await this.executeCommand(
        "shell date +%s",
        timeoutMs,
        undefined,
        true,
        signal,
      );
      const trimmed = result.stdout.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        const timestampMs = parsed * 1000;
        if (Number.isSafeInteger(parsed) && parsed > 0 && Number.isSafeInteger(timestampMs)) {
          return { timestampMs, source: "device-seconds" };
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.debug(`[ADB] Failed to read device time in seconds: ${error}`);
    }

    logger.debug("[ADB] Falling back to host time for device timestamp");
    return { timestampMs: this.timer.now(), source: "host" };
  }

  /**
   * Get the Android API level for the connected device.
   *
   * @param timeoutMs - Optional bound on the getprop subprocess. Callers running
   *   under a request deadline (the daemon's append-text path) pass their
   *   remaining budget so a wedged adb cannot outlive the request that asked.
   * @param signal - Optional cancellation signal. When it fires mid-probe the
   *   rejection is RE-THROWN (not swallowed to null): a cancelled read must
   *   propagate so callers such as `Window.getActive` cannot go on to parse a
   *   post-abort result. Cancellation is never cached as a device verdict.
   */
  async getAndroidApiLevel(timeoutMs?: number, signal?: AbortSignal): Promise<number | null> {
    // A cached value is still a result accepted on behalf of this call.  Do not
    // let a cancelled request observe it after its deadline has fired.
    signal?.throwIfAborted();
    if (this.apiLevelCache !== undefined) {
      return this.apiLevelCache;
    }

    try {
      const result = await this.executeCommand(
        "shell getprop ro.build.version.sdk",
        timeoutMs,
        undefined,
        true,
        signal,
      );
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      this.apiLevelCache = Number.isNaN(parsed) ? null : parsed;
      return this.apiLevelCache;
    } catch (error) {
      // A cancellation is not a device verdict: rethrow so it propagates out of
      // getActive instead of being masked as a null API level, and never poison
      // the cache with it.
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`[ADB] Failed to read API level: ${error}`);
      // A GENUINE device failure (offline, adb error) is cached as null so a
      // device that cannot answer is not re-probed on every call. But OUR injected
      // budget timeout is not a device verdict — a later request with a fresh
      // budget must be free to retry — so it returns null WITHOUT poisoning the
      // cache. The distinction matters because the daemon keeps one AdbClient per
      // device for minutes (#3351 finding 4); a cached null from a single
      // timed-out probe would disable SHIFT chords for that whole window.
      if (!(error instanceof AdbCommandTimeoutError)) {
        this.apiLevelCache = null;
      }
      return null;
    }
  }

  /**
   * Determine if an error is non-retryable (auth, syntax, or device errors).
   * Returns true if the error should NOT be retried.
   */
  private isNonRetryableError(error: Error, transportId?: string): boolean {
    const underlying = error.cause instanceof Error ? error.cause : error;
    const stderr = (underlying as Error & { stderr?: string | Buffer }).stderr;
    const message = (
      stderr
        ? Buffer.isBuffer(stderr)
          ? stderr.toString()
          : stderr
        : underlying.message.startsWith("Command failed:")
          ? ""
          : underlying.message
    ).toLowerCase();
    if (isAdbMissingDeviceError(underlying, this.device?.deviceId, transportId)) {
      return true;
    }
    const nonRetryablePatterns = [
      "operation cancelled",
      "unauthorized",
      "authentication failed",
      "permission denied",
      "unknown command",
      "invalid argument",
      "syntax error",
      "device not found",
      "no devices",
      "install_failed_version_downgrade",
      "install_failed_update_incompatible",
      "install_parse_failed_no_certificates",
      "install_parse_failed_inconsistent_certificates",
      "install_parse_failed_unexpected_exception",
    ];
    return nonRetryablePatterns.some((pattern) => message.includes(pattern));
  }

  private notifyMissingDeviceIfNeeded(
    error: unknown,
    busyAtDispatch: { busy: boolean; generation: number },
    transportId?: string,
  ): void {
    const deviceId = this.device?.deviceId;
    if (!deviceId || !isAdbMissingDeviceError(error, deviceId, transportId)) {
      return;
    }
    if (
      busyAtDispatch.busy ||
      this.consoleBusyRegistry?.isBusy(deviceId) ||
      (this.consoleBusyRegistry?.getGeneration(deviceId) ?? 0) !== busyAtDispatch.generation
    ) {
      logger.debug(
        `[ADB] Suppressing missing-device notification for ${deviceId}: a console-exclusive operation is in flight`,
      );
      return;
    }
    resetAdbDeviceListCache();
    notifyAdbMissingDevice(deviceId, error);
  }

  private getConsoleBusyAtDispatch(): { busy: boolean; generation: number } {
    const deviceId = this.device?.deviceId;
    return {
      generation: deviceId ? (this.consoleBusyRegistry?.getGeneration(deviceId) ?? 0) : 0,
      busy: deviceId !== undefined && (this.consoleBusyRegistry?.isBusy(deviceId) ?? false),
    };
  }

  private isMissingExecutableError(error: unknown): boolean {
    const err = error as NodeJS.ErrnoException;
    const message = errorMessage(error);
    return (
      err.code === "ENOENT" ||
      message.includes("ENOENT") ||
      message.includes("Executable not found")
    );
  }

  /** Only explicitly known read commands may be replayed after an uncertain dispatch. */
  private isSafeToRetryCommand(commandArgs: string[], hasDispatchGuard: boolean): boolean {
    if (commandArgs[0] === "shell") {
      const payload = commandArgs.slice(1).join(" ").trim();
      // Keep shell metacharacters out: a read-looking prefix can execute a
      // second, mutating command through the device shell.
      if (/[;&`$<>\r\n]/.test(payload)) {
        return false;
      }
      // gfxinfo's reset argument clears counters, unlike its ordinary reads.
      if (/^dumpsys gfxinfo\b[^|]*\breset\b/.test(payload)) {
        return false;
      }
      if (
        /^dumpsys (?:window|activity (?:activities|processes)|display|SurfaceFlinger|package|notification|accessibility|meminfo|gfxinfo|user|power|input_method)\b(?: [^|]+)?(?: \| (?:grep|head) (?:"[^"]*"|'[^']*'|[^|"'`$\r\n])+)*$/.test(
          payload,
        )
      ) {
        return true;
      }
      if (payload.includes("|")) {
        return false;
      }
      return [
        /^(?:getprop|echo)(?: [\w. -]+)?$/,
        /^wm (?:size|density)$/,
        /^settings get [^\s]+ [^\s]+$/,
        /^pm (?:list packages|path)\b(?: .+)?$/,
        /^cmd package (?:query-activities|query-receivers|resolve-activity)\b(?: .+)?$/,
        /^cat \/proc\/[^\s]+$/,
        /^getevent -p$/,
        /^sha256sum (?:[^\s]+|'[^']+'|"[^"]+")$/,
        /^stat -c %s (?:[^\s]+|'[^']+'|"[^"]+")$/,
      ].some((pattern) => pattern.test(payload));
    }
    // Deleting a named emulator snapshot is idempotent; its caller checks the
    // serial's AVD identity again before every dispatch.
    if (commandArgs[0] === "emu" && hasDispatchGuard) {
      return (
        commandArgs.length === 5 &&
        commandArgs[1] === "avd" &&
        commandArgs[2] === "snapshot" &&
        commandArgs[3] === "del"
      );
    }
    return ["devices", "get-state", "get-serialno", "version"].includes(commandArgs[0] ?? "");
  }

  private isPreDispatchError(error: Error): boolean {
    const underlying = error.cause instanceof Error ? error.cause : error;
    if ((underlying as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    const stderr = (underlying as Error & { stderr?: string | Buffer }).stderr;
    // Node's "Command failed: <args>" and wrapCommandError's formatted text
    // include caller input; only inspect standalone errors or adb stderr.
    const message = (
      stderr
        ? Buffer.isBuffer(stderr)
          ? stderr.toString()
          : stderr
        : underlying.message.startsWith("Command failed:")
          ? ""
          : underlying.message
    )
      .trim()
      .toLowerCase()
      .replace(/^error:\s*/, "");
    if (message.startsWith("executable not found")) {
      return true;
    }
    return [
      "cannot connect to adb",
      "cannot connect to daemon",
      "cannot connect to the daemon",
    ].some((pattern) => message.startsWith(pattern));
  }

  private getAbortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    if (reason instanceof Error && isDeviceLossCancellationReason(reason.message)) {
      return reason;
    }
    return new Error(OPERATION_CANCELLED_MESSAGE);
  }

  private shouldSkipMissingAdbProbe(): boolean {
    if (this.isTestMode) {
      return false;
    }
    if (
      process.platform !== "darwin" ||
      AdbClient.macosMissingAdbProbes < AdbClient.MAX_MACOS_MISSING_ADB_PROBES
    ) {
      return false;
    }
    const skippedAt = AdbClient.macosMissingAdbProbeStartedAt;
    if (skippedAt !== null && this.timer.now() - skippedAt >= MACOS_MISSING_ADB_PROBE_COOLDOWN_MS) {
      AdbClient.resetMissingAdbProbeState();
      return false;
    }
    return true;
  }

  private recordMissingAdbProbe(): void {
    if (this.isTestMode || process.platform !== "darwin") {
      return;
    }

    AdbClient.macosMissingAdbProbes += 1;
    if (AdbClient.macosMissingAdbProbes === AdbClient.MAX_MACOS_MISSING_ADB_PROBES) {
      AdbClient.macosMissingAdbProbeStartedAt = this.timer.now();
      logger.debug(
        "[ADB] adb not found after 3 probes; skipping passive Android device scans on this macOS host.",
      );
    }
  }

  /** @internal Reset shared probe state for recovery and cache-isolated tests. */
  static resetMissingAdbProbeState(): void {
    AdbClient.macosMissingAdbProbes = 0;
    AdbClient.macosMissingAdbProbeStartedAt = null;
  }

  /**
   * Internal implementation of command execution
   * @param command - The ADB command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @param maxBuffer - Optional maximum buffer size for command output
   * @param noRetry - Optional flag to disable retry logic for commands expected to fail
   * @returns Promise with command output
   */
  private executeArgsImpl(commandArgs: string[], options: AdbExecuteOptions): Promise<ExecResult> {
    // One span per logical adb command (retries included), recorded against the
    // ambient device-lifecycle tracker when one is in scope (see PerfContext).
    // Name by the leading subcommand tokens so spans aggregate (e.g.
    // `adb shell getprop`) instead of exploding per argument set.
    return trackAmbient(`adb ${commandArgs.slice(0, 2).join(" ")}`.trimEnd(), () =>
      this.executeArgsImplInner(commandArgs, options),
    );
  }

  private async executeArgsImplInner(
    commandArgs: string[],
    options: AdbExecuteOptions,
  ): Promise<ExecResult> {
    const {
      timeoutMs,
      maxBuffer,
      noRetry,
      signal,
      beforeDispatch,
      waitForProcessSettlementAfterAbort = false,
    } = options;
    const startTime = this.timer.now();
    const resolvedSignal = signal ?? getAbortSignal();
    const { adbPath, baseArgs } = await this.getBaseCommandParts(timeoutMs, resolvedSignal);
    const fullArgs = [...baseArgs, ...commandArgs];
    const command = commandArgs.join(" ");

    // Log which device is receiving this command for parallel execution debugging
    const deviceInfo = this.device ? `[DEVICE:${this.device.deviceId}]` : "[NO-DEVICE]";
    logger.debug(
      `[ADB] ${deviceInfo} Executing: ${command.length > 80 ? command.substring(0, 80) + "..." : command}`,
    );

    if (noRetry) {
      // No retry - just execute once
      let busyAtDispatch = { busy: false, generation: 0 };
      try {
        await beforeDispatch?.(this.getRemainingTimeoutMs(timeoutMs, startTime, command));
        busyAtDispatch = this.getConsoleBusyAtDispatch();
        const result = await this.execWithSignal(
          adbPath,
          fullArgs,
          maxBuffer,
          this.getRemainingTimeoutMs(timeoutMs, startTime, command),
          resolvedSignal,
          waitForProcessSettlementAfterAbort,
        );
        return result;
      } catch (error) {
        if (resolvedSignal?.aborted) {
          throw this.getAbortError(resolvedSignal);
        }
        this.notifyMissingDeviceIfNeeded(error, busyAtDispatch, baseArgs[1]);
        const duration = this.timer.now() - startTime;
        const message = (error as Error).message;
        if (this.isMissingExecutableError(error)) {
          logger.debug(`[ADB] Command failed after ${duration}ms: ${command} - ${message}`);
        } else {
          logger.warn(`[ADB] Command failed after ${duration}ms: ${command} - ${message}`);
        }
        throw error;
      }
    }

    // Use retry executor for retryable commands
    let busyAtDispatch = { busy: false, generation: 0 };
    return this.retryExecutor.executeOrThrow(
      async () => {
        busyAtDispatch = { busy: false, generation: 0 };
        if (resolvedSignal?.aborted) {
          throw this.getAbortError(resolvedSignal);
        }
        await beforeDispatch?.(this.getRemainingTimeoutMs(timeoutMs, startTime, command));
        busyAtDispatch = this.getConsoleBusyAtDispatch();
        const remainingMs = this.getRemainingTimeoutMs(timeoutMs, startTime, command);
        return await this.execWithSignal(
          adbPath,
          fullArgs,
          maxBuffer,
          remainingMs,
          resolvedSignal,
          waitForProcessSettlementAfterAbort,
        );
      },
      {
        maxAttempts: AdbClient.MAX_ADB_RETRIES + 1,
        // Keep the usual backoff intact, but never sleep past the remaining
        // whole-command budget. The next dispatch check reports the timeout.
        delays: (attempt) => {
          const delay = delayForAttempt(AdbClient.ADB_RETRY_BACKOFF, attempt);
          const remainingMs =
            timeoutMs === undefined ? undefined : timeoutMs - (this.timer.now() - startTime);
          return remainingMs === undefined ? delay : Math.min(delay, Math.max(0, remainingMs));
        },
        signal: resolvedSignal,
        shouldRetry: (error) => {
          if (resolvedSignal?.aborted) {
            return false;
          }
          if (error instanceof AdbCommandTimeoutError) {
            // A dispatch timeout has, by construction, already consumed the
            // whole command budget. Retrying would sleep past the caller's
            // deadline for a result the caller no longer wants; surface the
            // original "Command timed out after ..." error instead.
            return false;
          }
          if (this.isNonRetryableError(error, baseArgs[1])) {
            this.notifyMissingDeviceIfNeeded(error, busyAtDispatch, baseArgs[1]);
            return false;
          }
          return (
            this.isSafeToRetryCommand(commandArgs, beforeDispatch !== undefined) ||
            this.isPreDispatchError(error)
          );
        },
        onRetry: (error, attempt) => {
          logger.debug(
            `[ADB] Retrying command (attempt ${attempt + 1}): ${command} - ${error.message}`,
          );
        },
      },
    );
  }

  private async execWithSignal(
    file: string,
    args: string[],
    maxBuffer?: number,
    timeoutMs?: number,
    signal?: AbortSignal,
    waitForProcessSettlementAfterAbort = false,
  ): Promise<ExecResult> {
    if (signal?.aborted) {
      throw this.getAbortError(signal);
    }

    if (this.isTestMode) {
      return this.execAsync(file, args, maxBuffer);
    }

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let pendingTerminationError: Error | undefined;
      let terminationTimeoutId: NodeJS.Timeout | undefined;
      let killSettlementTimeoutId: NodeJS.Timeout | undefined;
      const { child, result } = this.hostProcessExecutor.executeCommandWithChild(
        file,
        args,
        maxBuffer ? { maxBuffer } : undefined,
      );
      result
        .then((execResult) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          if (pendingTerminationError) {
            reject(pendingTerminationError);
            return;
          }
          resolve(execResult);
        })
        .catch((error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(pendingTerminationError ?? error);
        });

      this.activeProcesses.add(child);

      const onAbort = () => {
        if (settled) {
          return;
        }
        const abortError = this.getAbortError(signal);
        if (waitForProcessSettlementAfterAbort) {
          pendingTerminationError ??= abortError;
          if (timeoutId) {
            this.timer.clearTimeout(timeoutId);
          }
          signal?.removeEventListener("abort", onAbort);
          child.kill("SIGTERM");
          terminationTimeoutId = this.timer.setTimeout(() => {
            if (settled) {
              return;
            }
            child.kill("SIGKILL");
            waitForProcessExitAfterSigkill();
          }, PROCESS_SETTLEMENT_GRACE_MS);
          return;
        }
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(abortError);
      };

      const onExit = () => {
        this.activeProcesses.delete(child);
      };

      const settleAfterSigkill = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(pendingTerminationError);
      };

      const waitForProcessExitAfterSigkill = () => {
        child.once("exit", settleAfterSigkill);
        child.once("close", settleAfterSigkill);
        killSettlementTimeoutId = this.timer.setTimeout(() => {
          if (settled) {
            return;
          }
          logger.warn(
            `[ADB] Child did not exit after SIGKILL within ${PROCESS_SETTLEMENT_GRACE_MS}ms; settling command termination`,
          );
          settleAfterSigkill();
        }, PROCESS_SETTLEMENT_GRACE_MS);
      };

      const cleanup = () => {
        this.activeProcesses.delete(child);
        child.off("exit", onExit);
        child.off("exit", settleAfterSigkill);
        child.off("close", settleAfterSigkill);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        if (timeoutId) {
          this.timer.clearTimeout(timeoutId);
        }
        if (terminationTimeoutId) {
          this.timer.clearTimeout(terminationTimeoutId);
        }
        if (killSettlementTimeoutId) {
          this.timer.clearTimeout(killSettlementTimeoutId);
        }
      };

      let timeoutId: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timeoutId = this.timer.setTimeout(() => {
          if (settled) {
            return;
          }
          const timeoutError = new AdbCommandTimeoutError(
            `Command timed out after ${timeoutMs}ms: ${file} ${args.join(" ")}`,
          );
          if (waitForProcessSettlementAfterAbort) {
            pendingTerminationError ??= timeoutError;
            signal?.removeEventListener("abort", onAbort);
            child.kill("SIGTERM");
            terminationTimeoutId = this.timer.setTimeout(() => {
              if (settled) {
                return;
              }
              child.kill("SIGKILL");
              waitForProcessExitAfterSigkill();
            }, PROCESS_SETTLEMENT_GRACE_MS);
            return;
          }
          settled = true;
          cleanup();
          child.kill("SIGTERM");
          reject(timeoutError);
        }, timeoutMs);
      }

      child.on("exit", onExit);

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private parseCommandArgs(command: string): string[] {
    const trimmed = command.trim();
    const isWindows = process.platform === "win32";
    if (trimmed.startsWith("shell ")) {
      let shellCommand = trimmed.slice(6).trim();
      if (
        (shellCommand.startsWith('"') && shellCommand.endsWith('"')) ||
        (shellCommand.startsWith("'") && shellCommand.endsWith("'"))
      ) {
        shellCommand = shellCommand.slice(1, -1);
      }
      return ["shell", shellCommand];
    }

    return this.parseNonShellCommandArgs(trimmed, isWindows);
  }

  private consumeCommandQuoteOrEscape(
    char: string,
    state: CommandArgState,
    isWindows: boolean,
  ): boolean {
    if (state.escape) {
      state.current += char;
      state.escape = false;
      return true;
    }

    if (!isWindows && char === "\\" && !state.inSingle) {
      state.escape = true;
      return true;
    }

    if (char === "'" && !state.inDouble) {
      state.inSingle = !state.inSingle;
      return true;
    }

    if (char === '"' && !state.inSingle) {
      state.inDouble = !state.inDouble;
      return true;
    }

    return false;
  }

  private parseNonShellCommandArgs(trimmed: string, isWindows: boolean): string[] {
    const args: string[] = [];
    const state: CommandArgState = { current: "", inSingle: false, inDouble: false, escape: false };

    for (const char of trimmed) {
      if (this.consumeCommandQuoteOrEscape(char, state, isWindows)) {
        continue;
      }

      if (!state.inSingle && !state.inDouble && /\s/.test(char)) {
        if (state.current.length > 0) {
          args.push(state.current);
          state.current = "";
        }
        continue;
      }

      state.current += char;
    }

    if (state.current.length > 0) {
      args.push(state.current);
    }

    return args;
  }

  /**
   * Get the list of connected devices
   * @returns Promise with an array of device IDs
   */
  async getBootedAndroidDevices(
    options: {
      bypassCache?: boolean;
      throwOnMissingAdb?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<BootedDevice[]> {
    if (this.shouldSkipMissingAdbProbe()) {
      if (options.throwOnMissingAdb) {
        throw new AdbUnavailableError("ADB executable is unavailable");
      }
      return [];
    }

    // Check cache first - TTLCache handles expiration automatically
    const cache = getDeviceListCache(this.timer);
    const cachedDevices = options.bypassCache ? undefined : cache.get("devices");
    if (cachedDevices) {
      logger.debug("Getting list of connected devices (cached)");
      return cachedDevices;
    }

    const timeoutMs = options.timeoutMs ?? AdbClient.DEVICE_LIST_TIMEOUT_MS;
    const signal = options.signal ?? getAbortSignal();
    try {
      // A bypass caller needs its own fresh snapshot and must not inherit the
      // result of a non-bypass request that was already in flight.
      if (options.bypassCache) {
        return await this.readDeviceListFromAdb(timeoutMs, options.signal);
      }

      const shared = deviceListSingleFlight.run(
        "devices",
        () => {
          // The shared subprocess has its own bounded timeout but deliberately
          // does not inherit a waiter's signal. Each caller races its signal in
          // SingleFlight, so one disconnected client cannot cancel discovery
          // for the other clients sharing this cold read.
          return runWithAbortSignal(undefined, () =>
            this.readDeviceListFromAdb(AdbClient.DEVICE_LIST_TIMEOUT_MS),
          );
        },
        signal,
      );
      return await raceWithDeadline(shared, {
        timer: this.timer,
        timeoutMs,
        signal,
        label: "ADB device-list caller wait",
        timeoutError: () =>
          new AdbCommandTimeoutError(`ADB device-list caller wait timed out after ${timeoutMs}ms`),
      });
    } catch (error) {
      if (error instanceof AdbUnavailableError && !options.throwOnMissingAdb) {
        return [];
      }
      throw error;
    }
  }

  private async readDeviceListFromAdb(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BootedDevice[]> {
    const generation = ++deviceListGeneration;
    logger.debug("Getting list of connected devices");
    let result: ExecResult;
    try {
      result = await this.executeCommand("devices -l", timeoutMs, undefined, true, signal);
    } catch (error) {
      if (this.isMissingExecutableError(error)) {
        this.recordMissingAdbProbe();
        throw new AdbUnavailableError(`ADB executable is unavailable: ${(error as Error).message}`);
      }
      throw error;
    }
    const lines = result.stdout.split("\n").slice(1);

    const observedAt = this.observationSequence.next();
    const devices = lines
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        const [deviceId, state] = line.trim().split(/\s+/);
        if (!deviceId || state !== "device") {
          return [];
        }
        const transportId = line
          .trim()
          .split(/\s+/)
          .find((field) => field.startsWith("transport_id:"))
          ?.slice("transport_id:".length);
        return [
          withAndroidTransportId(
            {
              name: deviceId,
              platform: "android" as const,
              deviceId,
              observedAt,
            },
            transportId,
          ),
        ];
      });

    this.publishDeviceList(generation, devices);
    return devices;
  }

  private publishDeviceList(generation: number, devices: BootedDevice[]): void {
    if (generation >= deviceListPublishedGeneration) {
      deviceListPublishedGeneration = generation;
      getDeviceListCache(this.timer).set("devices", devices);
    }
  }

  /**
   * List raw ADB states without applying the online-only filter used by
   * getBootedAndroidDevices(). Readiness diagnostics use this to distinguish a
   * device that is absent from one that is present but stuck offline.
   */
  async getDeviceStates(
    options: { timeoutMs?: number; signal?: AbortSignal; throwOnMissingAdb?: boolean } = {},
  ): Promise<AdbDeviceState[]> {
    if (this.shouldSkipMissingAdbProbe()) {
      if (options.throwOnMissingAdb) {
        throw new AdbUnavailableError("ADB executable is unavailable");
      }
      return [];
    }

    let result: ExecResult;
    try {
      result = await this.executeCommand(
        "devices -l",
        options.timeoutMs ?? AdbClient.DEVICE_LIST_TIMEOUT_MS,
        undefined,
        true,
        options.signal,
      );
    } catch (error) {
      if (this.isMissingExecutableError(error)) {
        if (options.throwOnMissingAdb) {
          throw new AdbUnavailableError(
            `ADB executable is unavailable: ${(error as Error).message}`,
          );
        }
        // Preserve the diagnostic path while treating an unavailable ADB as no connected devices.
        logger.debug(
          `[ADB] Unable to query device states because adb is unavailable: ${(error as Error).message}`,
        );
        this.recordMissingAdbProbe();
        return [];
      }
      throw error;
    }

    return result.stdout
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        const [deviceId, state] = line.trim().split(/\s+/);
        const transportId = line
          .trim()
          .split(/\s+/)
          .find((field) => field.startsWith("transport_id:"))
          ?.slice("transport_id:".length);
        return deviceId && state ? [withAndroidTransportId({ deviceId, state }, transportId)] : [];
      });
  }

  async getReadinessDeviceSnapshot(options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ states: AdbDeviceState[]; devices: BootedDevice[] }> {
    const generation = ++deviceListGeneration;
    const states = await this.getDeviceStates({ ...options, throwOnMissingAdb: true });
    const observedAt = this.observationSequence.next();
    const devices = states
      .filter((state) => state.state === "device")
      .map((state) =>
        copyAndroidTransportId(state, {
          name: state.deviceId,
          platform: "android" as const,
          deviceId: state.deviceId,
          observedAt,
        }),
      );
    this.publishDeviceList(generation, devices);
    return { states, devices };
  }

  /**
   * Check if the device screen is currently on
   * Uses dumpsys power to check mWakefulness state
   * @returns Promise<boolean> - true if screen is on (Awake), false if off (Asleep/Dozing)
   */
  async isScreenOn(signal?: AbortSignal): Promise<boolean> {
    const wakefulness = await this.getWakefulness(signal);
    return wakefulness === "Awake";
  }

  /**
   * Get the device wakefulness state
   * Uses dumpsys power to check mWakefulness state
   * @returns Promise with wakefulness state: "Awake", "Asleep", "Dozing", or null if unknown
   */
  async getWakefulness(signal?: AbortSignal): Promise<"Awake" | "Asleep" | "Dozing" | null> {
    try {
      const result = await this.executeCommand(
        "shell dumpsys power | grep mWakefulness=",
        undefined,
        undefined,
        true,
        signal,
      );
      const match = result.stdout.match(/mWakefulness=(\w+)/);
      if (match) {
        const state = match[1];
        if (state === "Awake" || state === "Asleep" || state === "Dozing") {
          return state;
        }
      }
      return null;
    } catch {
      logger.debug("[ADB] Failed to get wakefulness state");
      return null;
    }
  }

  /**
   * Get the device lock state (Android only).
   *
   * All three signals come from a single `dumpsys window policy` read — its
   * `KeyguardServiceDelegate` block carries `showing`, `occluded`, and `secure`
   * (the last mirrors `KeyguardManager.isKeyguardSecure()`, i.e. a credential is
   * set). `secure` is deliberately NOT derived from `locksettings get-disabled`:
   * that only reports whether the lock is set to *None*, so it returns `false`
   * for both a swipe lock and a PIN and cannot tell them apart (#4235 review).
   *
   * `locked` is `showing && !occluded` — an occluded keyguard (a
   * FLAG_SHOW_WHEN_LOCKED activity like the camera) is not obscuring the app.
   *
   * Degrades gracefully: an unreadable policy dump, or one missing the keyguard
   * `showing` field, yields `null` (lock state unknown → observe omits the
   * field); a missing `secure` field yields `secure: undefined` rather than a
   * guessed boolean, so a swipe lock is never mistaken for a secure one.
   *
   * The field names are the API 30+ `KeyguardServiceDelegate` dump; on a release
   * that does not emit them the read simply returns `null` — a missing signal,
   * never a wrong one.
   *
   * Keyguard interaction has a hard ~7s budget (`config_lockScreenDisplayTimeout`,
   * a baked framework resource, not a settable key) and a documented key-event
   * unlock recipe; see docs/design-docs/plat/android/keyguard.md before building
   * anything that drives a locked device.
   */
  async getDeviceLock(signal?: AbortSignal): Promise<DeviceLockState | null> {
    let policy: string;
    try {
      const result = await this.executeCommand(
        "shell dumpsys window policy",
        undefined,
        undefined,
        true,
        signal,
      );
      policy = result.stdout;
    } catch {
      logger.debug("[ADB] Failed to read window policy for device lock state");
      return null;
    }

    // Lowercase, boundary-anchored tokens: the KeyguardServiceDelegate fields are
    // `showing=`/`occluded=`/`secure=`, which do not collide with the CamelCase
    // siblings in the same dump (`mKeyguardOccluded=`, `mSimSecure=`, `mIsShowing=`).
    const keyguardShowing = AdbClient.matchBool(policy, /(?:^|\s)showing=(true|false)/);
    if (keyguardShowing === null) {
      return null;
    }
    const occluded = AdbClient.matchBool(policy, /(?:^|\s)occluded=(true|false)/) ?? false;
    const secure = AdbClient.matchBool(policy, /(?:^|\s)secure=(true|false)/);
    return {
      locked: keyguardShowing && !occluded,
      keyguardShowing,
      secure: secure ?? undefined,
    };
  }

  /** First `<field>=true|false` match as a boolean, or null when the field is absent. */
  private static matchBool(haystack: string, pattern: RegExp): boolean | null {
    const match = haystack.match(pattern);
    return match ? match[1] === "true" : null;
  }

  /**
   * List all Android users on the device (personal, work profiles, etc.)
   * Uses dumpsys user for structured output parsing
   * Falls back to pm list users if dumpsys fails
   * @returns Promise with array of Android users
   */
  async listUsers(signal?: AbortSignal): Promise<AndroidUser[]> {
    try {
      // Try dumpsys user first - provides more structured output
      const result = await this.executeCommand(
        "shell dumpsys user",
        undefined,
        undefined,
        true,
        signal,
      );
      const users = this.parseUsersFromDumpsys(result.stdout);

      if (users.length > 0) {
        logger.info(
          `[ADB] Found ${users.length} user(s) via dumpsys: ${users.map((u) => `${u.userId}:${u.name}`).join(", ")}`,
        );
        return users;
      }

      // If dumpsys parsing failed, fall back to pm list users
      logger.debug("[ADB] dumpsys user parsing returned no users, falling back to pm list users");
      return await this.listUsersLegacy(signal);
    } catch (error) {
      logger.debug(
        `[ADB] dumpsys user failed: ${(error as Error).message}, falling back to pm list users`,
      );
      return await this.listUsersLegacy(signal);
    }
  }

  /**
   * Parse user information from dumpsys user output
   * Example line: "  UserInfo{0:null:4c13} serialNo=0 isPrimary=true"
   * Followed by: "    State: RUNNING_UNLOCKED" or "    State: SHUTDOWN"
   * @param output - Raw dumpsys user output
   * @returns Array of parsed Android users
   */
  private parseUsersFromDumpsys(output: string): AndroidUser[] {
    const users: AndroidUser[] = [];
    const lines = output.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match UserInfo line: UserInfo{userId:name:flags} ...
      // Note: name can be "null" in dumpsys output, and flags are hexadecimal
      const userMatch = line.match(/UserInfo\{(\d+):([^:]+):([0-9a-fA-F]+)\}/);
      if (!userMatch) {
        continue;
      }
      const userId = parseInt(userMatch[1], 10);
      let userName = userMatch[2];
      const flags = parseInt(userMatch[3], 16); // Parse as hexadecimal

      const startState = this.findUserStartState(lines, i);
      const running = startState === "RUNNING_UNLOCKED" || startState === "RUNNING_LOCKED";

      // If name is "null" in dumpsys, try to get the real name from "Owner name:" line
      if (userName === "null") {
        // For user 0, look for "Owner name:" line
        const ownerMatch = output.match(/Owner name:\s+(.+)/);
        if (ownerMatch && userId === 0) {
          userName = ownerMatch[1].trim();
        } else {
          userName = `User ${userId}`;
        }
      }

      users.push({
        userId,
        name: userName,
        flags,
        profileType: classifyAndroidUser(flags),
        running,
        ...(startState ? { startState } : {}),
      });
    }

    return users;
  }

  private findUserStartState(lines: string[], userLineIndex: number): string | undefined {
    // Look for the State line in the next few lines
    for (let j = userLineIndex + 1; j < Math.min(userLineIndex + 10, lines.length); j++) {
      const stateLine = lines[j];

      // If we hit another UserInfo, stop searching
      if (stateLine.match(/UserInfo\{/)) {
        break;
      }

      const stateMatch = stateLine.match(/State:\s+(\S+)/);
      if (stateMatch) {
        return stateMatch[1];
      }
    }
    return undefined;
  }

  /**
   * Legacy method to list users using pm list users command
   * Used as fallback when dumpsys user is not available or fails
   * Example output:
   *   Users:
   *     UserInfo{0:Owner:4c13} running
   *     UserInfo{10:Work profile:30} running
   * @returns Promise with array of Android users
   */
  private async listUsersLegacy(signal?: AbortSignal): Promise<AndroidUser[]> {
    try {
      const result = await this.executeCommand(
        "shell pm list users",
        undefined,
        undefined,
        true,
        signal,
      );
      const lines = result.stdout.split("\n");
      const users: AndroidUser[] = [];

      for (const line of lines) {
        // Match pattern: UserInfo{userId:name:flags} [running]
        // Note: flags are hexadecimal (e.g., "4c13")
        const match = line.match(/UserInfo\{(\d+):([^:]+):([0-9a-fA-F]+)\}\s*(running)?/);
        if (match) {
          const userId = parseInt(match[1], 10);
          const flags = parseInt(match[3], 16);
          users.push({
            userId,
            name: match[2],
            flags, // Parse as hexadecimal
            profileType: classifyAndroidUser(flags),
            running: match[4] === "running",
          });
        }
      }

      if (users.length > 0) {
        logger.info(
          `[ADB] Found ${users.length} user(s) via pm: ${users.map((u) => `${u.userId}:${u.name}`).join(", ")}`,
        );
        return users;
      }

      // If still no users found, log the raw output for debugging
      logger.warn(
        `[ADB] Failed to parse users from pm list users. Raw output: ${result.stdout.substring(0, 200)}`,
      );

      // An unparseable response is not evidence that user 0 is active.
      return [];
    } catch (error) {
      logger.warn(`[ADB] Failed to list users via pm: ${(error as Error).message}`);
      // An unavailable user service is not evidence that user 0 is active.
      return [];
    }
  }

  /**
   * Get the current foreground app package name and user ID
   * Uses dumpsys activity to find the resumed/focused activity
   * @returns Promise with { packageName: string, userId: number } or null if no app in foreground
   */
  async getForegroundApp(
    signal?: AbortSignal,
    timeout?: number | { timeoutMs?: number; displayId?: number },
  ): Promise<ForegroundApp | null> {
    const result = await this.getForegroundAppChecked(signal, timeout);
    return result.state === "known" ? result.app : null;
  }

  /**
   * Read the resumed app for the requested display, reporting unparseable output as unreadable.
   * Known with app: null requires positive evidence of no foreground app; this dumpsys
   * reader currently has no such evidence and reports unreadable when no activity parses.
   */
  async getForegroundAppChecked(
    signal?: AbortSignal,
    timeout?: number | { timeoutMs?: number; displayId?: number },
  ): Promise<ForegroundAppReadResult> {
    const { timeoutMs, displayId = 0 } =
      typeof timeout === "number" ? { timeoutMs: timeout } : (timeout ?? {});
    try {
      const result = await this.executeCommand(
        "shell dumpsys activity activities | grep -E '^[^[:space:]]|^[[:space:]]*(topResumedActivity|mResumedActivity|ResumedActivity|Resumed|mFocusedActivity)[[:space:]]*[:=]'",
        timeoutMs,
        undefined,
        true,
        signal,
      );

      const parsed = parseResumedActivityForDisplay(result.stdout, displayId);
      const foreground = parsed.activity;
      if (foreground) {
        const { userId, packageName } = foreground;
        logger.info(`[ADB] Foreground app: ${packageName} (user ${userId})`);
        return {
          state: "known",
          app: {
            packageName,
            userId,
            activityName: foreground.activityName,
            displayCount: parsed.displayCount,
          },
        };
      }

      const error = `No resumed activity could be parsed from the dumpsys activity activities output for display ${displayId} (display sections: ${parsed.displayCount}, stdout length: ${result.stdout.length})`;
      logger.warn(`[ADB] ${error}`);
      return { state: "unreadable", error };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[ADB] Failed to get foreground app", error);
      return { state: "unreadable", error: errorMessage(error) };
    }
  }
}
