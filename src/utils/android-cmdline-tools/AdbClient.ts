import { errorMessage } from "../describeUnknownError";
import { execFile, type ChildProcess, type SpawnOptions } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";
import { createExecResult } from "../execResult";
import { DefaultHostCommandExecutor, type HostProcessExecutor } from "../HostCommandExecutor";
import { BootedDevice, ExecResult, AndroidUser, DeviceLockState } from "../../models";
import {
  AndroidToolsDetectionAbortError,
  AndroidToolsDetectionTimeoutError,
  detectAndroidCommandLineTools,
  getBestAndroidToolsLocation,
} from "./detection";
import {
  AdbExecutor,
  type AdbExecuteOptions,
  type AdbDeviceState,
  type AdbProcess,
  type AdbSpawnOptions,
  type DeviceTimestampResult,
} from "./interfaces/AdbExecutor";
import { getAbortSignal } from "../AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../constants";
import { RetryExecutor, defaultRetryExecutor } from "../retry/RetryExecutor";
import { TTLCache } from "../cache/Cache";
import { Timer, defaultTimer } from "../SystemTimer";
import { wrapCommandError } from "../CommandError";
import { isAdbMissingDeviceError, notifyAdbMissingDevice } from "./AdbDeviceHealth";
import { DefaultSystemDetection, type SystemDetection } from "../system/SystemDetection";

type ExecFileAsync = (file: string, args: string[], maxBuffer?: number) => Promise<ExecResult>;

/**
 * The long-lived spawn seam. Kept as its own injectable type so the default can
 * route through the shared {@link HostProcessExecutor} while tests still inject a
 * fake. Deliberately narrower than node's overloaded `typeof spawn`.
 */
type SpawnFn = (file: string, args: string[], options?: SpawnOptions) => ChildProcess;

// Route the default long-lived spawn through the shared host-process seam so the
// client no longer reaches for `child_process.spawn` directly (issue #5459). The
// executor's `spawn` is a plain passthrough, so this is behavior-identical; all
// of AdbClient's own timeout/abort/process-tracking orchestration is unchanged.
const hostProcessExecutor: HostProcessExecutor = new DefaultHostCommandExecutor();

/**
 * Thrown when an adb command exceeds the caller-supplied `timeoutMs` budget, as
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
// Keep production clients sharing the resolved path while isolating injected
// execution seams. A module-wide path cache keyed only by "adbPath" lets one
// test/client reuse another client's incomplete or synthetic discovery result.
let adbPathCaches = new WeakMap<ExecFileAsync, TTLCache<string, string>>();

const DEVICE_LIST_CACHE_TTL_MS = 5000; // 5 seconds
const ADB_PATH_CACHE_TTL_MS = 60000; // 1 minute - ADB path rarely changes

function getDeviceListCache(): TTLCache<string, BootedDevice[]> {
  if (!deviceListCache) {
    deviceListCache = new TTLCache(moduleTimer, { ttlMs: DEVICE_LIST_CACHE_TTL_MS });
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
  adbPathCaches = new WeakMap();
}

export function resetAdbDeviceListCache(): void {
  deviceListCache = null;
}


// Enhance the standard execFileAsync result to implement the ExecResult interface
const execFileAsync: ExecFileAsync = async (
  file: string,
  args: string[],
  maxBuffer?: number
): Promise<ExecResult> => {
  // Debug: Log when real exec is called (helps trace daemon startup in tests)
  if (process.env.DEBUG_ADB_EXEC) {
    console.warn(`[DEBUG_ADB_EXEC] Real execFileAsync called: ${file} ${args.join(" ")}`);
    console.warn(`[DEBUG_ADB_EXEC] Stack trace:`, new Error().stack);
  }
  const options = maxBuffer ? { maxBuffer } : undefined;
  const result = await promisify(execFile)(file, args, options);

  // Coerce to the canonical ExecResult (Buffer→string plus the trim/toString/
  // includes helpers) via the shared factory rather than re-inlining it here.
  return createExecResult(result.stdout, result.stderr);
};

export class AdbClient implements AdbExecutor {
  device: BootedDevice | null;
  execAsync: ExecFileAsync;
  spawnFn: SpawnFn;
  private adbPath: string;
  private isTestMode: boolean;
  private activeProcesses: Set<ChildProcess> = new Set();
  /**
   * Cached API level for the current device. Intentionally never expires during
   * a device session because API level is constant. Reset on setDevice().
   * NOT using TTLCache: session-scoped without time-based expiration.
   */
  private apiLevelCache: number | null | undefined;
  private readonly retryExecutor: RetryExecutor;
  private readonly timer: Timer;

  private static readonly DEVICE_LIST_TIMEOUT_MS = 10000;
  private static readonly MAX_ADB_RETRIES = 3;
  private static readonly MAX_MACOS_MISSING_ADB_PROBES = 3;
  private static macosMissingAdbProbes = 0;

  /**
   * Create an AdbClient instance
   * @param device - Optional device
   * @param execAsyncFn - promisified exec function (for testing)
   * @param spawnFn - spawn function (for testing)
   * @param retryExecutor - retry executor for command retries (for testing)
   * @param timer - Timer for delays and time tracking
   */
  constructor(
    device: BootedDevice | null = null,
    execAsyncFn: ((command: string, maxBuffer?: number) => Promise<ExecResult>) | ExecFileAsync | null = null,
    spawnFn: SpawnFn | null = null,
    retryExecutor: RetryExecutor = defaultRetryExecutor,
    timer: Timer = defaultTimer,
    private readonly systemDetectionFactory: () => SystemDetection = () => new DefaultSystemDetection()
  ) {
    this.device = device;
    // Test mode if: custom execAsync provided OR global test mode flag is set
    // Check for any truthy value (not just exactly "true") to handle different env var formats
    const testModeEnv = process.env.AUTOMOBILE_TEST_MODE;
    this.isTestMode = execAsyncFn !== null || (testModeEnv !== undefined && testModeEnv !== "" && testModeEnv !== "false" && testModeEnv !== "0");

    // In test mode without custom exec function, use a stub that returns empty results
    // This prevents any real adb commands from being executed
    if (this.isTestMode && execAsyncFn === null) {
      this.execAsync = async (): Promise<ExecResult> => ({
        stdout: "",
        stderr: "",
        toString() { return ""; },
        trim() { return ""; },
        includes() { return false; }
      });
    } else {
      this.execAsync = execAsyncFn
        ? this.wrapExecAsync(execAsyncFn)
        : execFileAsync;
    }
    this.spawnFn = spawnFn || ((file, args, options) => hostProcessExecutor.spawn(file, args, options));
    this.retryExecutor = retryExecutor;
    this.timer = timer;
    // Initialize with fallback, will be updated lazily
    this.adbPath = this.getFallbackAdbPath();

    // Debug: Log when a real (non-test) AdbClient is created
    if (process.env.DEBUG_ADB_EXEC && !this.isTestMode) {
      console.warn(`[DEBUG_ADB_EXEC] Real AdbClient created (not test mode)`);
      console.warn(`[DEBUG_ADB_EXEC] Stack trace:`, new Error().stack);
    }
  }

  private wrapExecAsync(
    execAsyncFn: ((command: string, maxBuffer?: number) => Promise<ExecResult>) | ExecFileAsync
  ): ExecFileAsync {
    if (execAsyncFn.length >= 3) {
      return execAsyncFn as ExecFileAsync;
    }
    return async (file: string, args: string[], maxBuffer?: number) => {
      const command = [file, ...args].join(" ");
      return (execAsyncFn as (command: string, maxBuffer?: number) => Promise<ExecResult>)(command, maxBuffer);
    };
  }

  /**
   * Get fallback ADB path using environment variables and PATH
   */
  private getFallbackAdbPath(): string {
    // Try environment variables
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_SDK_HOME;
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
        this.createDeadlineBoundSystemDetection(deadlineMs, signal)
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
    signal?: AbortSignal
  ): Promise<ExecResult> {
    const timeoutMs = deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new AdbCommandTimeoutError(`Command timed out before ADB path discovery: ${file} ${args.join(" ")}`);
    }
    return this.execWithSignal(file, args, undefined, timeoutMs, signal);
  }

  private createDeadlineBoundSystemDetection(
    deadlineMs: number | undefined,
    signal?: AbortSignal
  ): SystemDetection {
    const defaults = this.systemDetectionFactory();
    return {
      getCurrentPlatform: () => defaults.getCurrentPlatform(),
      getHomeDir: () => defaults.getHomeDir(),
      getEnvVar: name => defaults.getEnvVar(name),
      fileExistsSync: path => defaults.fileExistsSync(path),
      fileExists: path => this.executeDetectionFileProbe(defaults, path, deadlineMs, signal),
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
    signal?: AbortSignal
  ): Promise<boolean> {
    if (signal?.aborted) {
      throw new AndroidToolsDetectionAbortError(this.getAbortError(signal));
    }

    const timeoutMs = deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new AndroidToolsDetectionTimeoutError(`Command timed out before ADB path discovery: ${path}`);
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
      const onAbort = () => settle(() => reject(new AndroidToolsDetectionAbortError(this.getAbortError(signal!))));

      if (timeoutMs !== undefined) {
        timeoutHandle = this.timer.setTimeout(
          () => settle(() => reject(new AndroidToolsDetectionTimeoutError(`Command timed out before ADB path discovery: ${path}`))),
          timeoutMs
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void systemDetection.fileExists(path).then(
        exists => settle(() => resolve(exists)),
        error => settle(() => reject(error))
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

  private getRemainingTimeoutMs(timeoutMs: number | undefined, startTime: number, command: string): number | undefined {
    if (timeoutMs === undefined) {
      return undefined;
    }
    const remainingMs = timeoutMs - (this.timer.now() - startTime);
    if (remainingMs <= 0) {
      throw new AdbCommandTimeoutError(`Command timed out after ${timeoutMs}ms before execution: ${command}`);
    }
    return remainingMs;
  }

  /**
   * Public accessor for the resolved adb path. Same detection as `ensureAdbPath`,
   * exposed for diagnostics that want the path without running an adb command.
   */
  async getAdbPathOnly(): Promise<string> {
    return this.ensureAdbPath();
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
    cache.set("adbPath", detectedPath);
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

  async getBaseCommandParts(timeoutMs?: number, signal?: AbortSignal): Promise<{ adbPath: string; baseArgs: string[] }> {
    const deviceId = this.device?.deviceId;
    const adbPath = await this.ensureAdbPath(timeoutMs, signal);
    const baseArgs: string[] = [];

    if (deviceId) {
      baseArgs.push("-s", deviceId);
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
    signal?: AbortSignal
  ): Promise<ExecResult> {
    return this.execute(this.parseCommandArgs(command), { timeoutMs, maxBuffer, noRetry, signal });
  }

  async execute(args: string[], options: AdbExecuteOptions = {}): Promise<ExecResult> {
    const { timeoutMs, maxBuffer, noRetry, signal, beforeDispatch } = options;
    const startTime = this.timer.now();
    const result = await this.executeArgsImpl(args, timeoutMs, maxBuffer, noRetry, signal, beforeDispatch);
    const duration = this.timer.now() - startTime;
    const command = args.join(" ");

    // Only log longer commands or ones that take significant time
    if (duration > 10 || command.includes("screencap") || command.includes("uiautomator") || command.includes("getevent")) {
      const outputSize = result.stdout.length + result.stderr.length;
      logger.debug(`[ADB] Command completed in ${duration}ms (output: ${outputSize} bytes): ${command.length > 50 ? command.substring(0, 50) + "..." : command}`);
    }

    return result;
  }

  async spawn(args: string[], options: AdbSpawnOptions = {}): Promise<AdbProcess> {
    const signal = options.signal ?? getAbortSignal();
    if (signal?.aborted) {
      throw this.getAbortError(signal);
    }

    const { adbPath, baseArgs } = await this.getBaseCommandParts();
    if (signal?.aborted) {
      throw this.getAbortError(signal);
    }
    const fullArgs = [...baseArgs, ...args];
    const child = this.spawnFn(adbPath, fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.activeProcesses.add(child);

    let timeoutId: NodeJS.Timeout | undefined;
    let cleaned = false;
    let settleStart: ((error?: Error) => void) | undefined;
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      this.activeProcesses.delete(child);
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (timeoutId) {
        this.timer.clearTimeout(timeoutId);
      }
    };
    const onExit = () => cleanup();
    const onError = (error: Error) => {
      this.notifyMissingDeviceIfNeeded(error);
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
    if (options.timeoutMs) {
      timeoutId = this.timer.setTimeout(onAbort, options.timeoutMs);
    }

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onInitialError);
        settleStart = undefined;
        resolve();
      };
      const onInitialError = (error: Error) => {
        child.off("spawn", onSpawn);
        settleStart = undefined;
        reject(error);
      };
      settleStart = error => error ? reject(error) : resolve();
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
  async getDeviceTimestampMsWithSource(): Promise<DeviceTimestampResult> {
    try {
      const result = await this.executeCommand("shell date +%s%3N");
      const trimmed = result.stdout.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          return { timestampMs: parsed, source: "device-ms" };
        }
      }
    } catch (error) {
      logger.debug(`[ADB] Failed to read device time with ms precision: ${error}`);
    }

    try {
      const result = await this.executeCommand("shell date +%s");
      const trimmed = result.stdout.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        const timestampMs = parsed * 1000;
        if (Number.isSafeInteger(parsed) && parsed > 0 && Number.isSafeInteger(timestampMs)) {
          return { timestampMs, source: "device-seconds" };
        }
      }
    } catch (error) {
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
   */
  async getAndroidApiLevel(timeoutMs?: number): Promise<number | null> {
    if (this.apiLevelCache !== undefined) {
      return this.apiLevelCache;
    }

    try {
      const result = await this.executeCommand(
        "shell getprop ro.build.version.sdk",
        timeoutMs,
        undefined,
        true
      );
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      this.apiLevelCache = Number.isNaN(parsed) ? null : parsed;
      return this.apiLevelCache;
    } catch (error) {
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
  private isNonRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    if (isAdbMissingDeviceError(error, this.device?.deviceId)) {
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
      "offline",
    ];
    return nonRetryablePatterns.some(pattern => message.includes(pattern));
  }

  private notifyMissingDeviceIfNeeded(error: unknown): void {
    const deviceId = this.device?.deviceId;
    if (!deviceId || !isAdbMissingDeviceError(error, deviceId)) {
      return;
    }
    resetAdbDeviceListCache();
    notifyAdbMissingDevice(deviceId, error);
  }

  private isMissingExecutableError(error: unknown): boolean {
    const err = error as NodeJS.ErrnoException;
    const message = errorMessage(error);
    return err.code === "ENOENT" || message.includes("ENOENT") || message.includes("Executable not found");
  }

  private getAbortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    if (reason instanceof Error && reason.message.startsWith("device-disconnected:")) {
      return reason;
    }
    return new Error(OPERATION_CANCELLED_MESSAGE);
  }

  private shouldSkipMissingAdbProbe(): boolean {
    if (this.isTestMode) {
      return false;
    }
    return process.platform === "darwin" &&
      AdbClient.macosMissingAdbProbes >= AdbClient.MAX_MACOS_MISSING_ADB_PROBES;
  }

  private recordMissingAdbProbe(): void {
    if (this.isTestMode || process.platform !== "darwin") {
      return;
    }

    AdbClient.macosMissingAdbProbes += 1;
    if (AdbClient.macosMissingAdbProbes === AdbClient.MAX_MACOS_MISSING_ADB_PROBES) {
      logger.debug("[ADB] adb not found after 3 probes; skipping passive Android device scans on this macOS host.");
    }
  }

  /**
   * Internal implementation of command execution
   * @param command - The ADB command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @param maxBuffer - Optional maximum buffer size for command output
   * @param noRetry - Optional flag to disable retry logic for commands expected to fail
   * @returns Promise with command output
   */
  private async executeArgsImpl(
    commandArgs: string[],
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
    beforeDispatch?: (remainingTimeoutMs?: number) => Promise<void>
  ): Promise<ExecResult> {
    const startTime = this.timer.now();
    const resolvedSignal = signal ?? getAbortSignal();
    const { adbPath, baseArgs } = await this.getBaseCommandParts(timeoutMs, resolvedSignal);
    const fullArgs = [...baseArgs, ...commandArgs];
    const command = commandArgs.join(" ");

    // Log which device is receiving this command for parallel execution debugging
    const deviceInfo = this.device ? `[DEVICE:${this.device.deviceId}]` : "[NO-DEVICE]";
    logger.debug(`[ADB] ${deviceInfo} Executing: ${command.length > 80 ? command.substring(0, 80) + "..." : command}`);

    if (noRetry) {
      // No retry - just execute once
      try {
        await beforeDispatch?.(this.getRemainingTimeoutMs(timeoutMs, startTime, command));
        const result = await this.execWithSignal(
          adbPath,
          fullArgs,
          maxBuffer,
          this.getRemainingTimeoutMs(timeoutMs, startTime, command),
          resolvedSignal
        );
        return result;
      } catch (error) {
        if (resolvedSignal?.aborted) {
          throw this.getAbortError(resolvedSignal);
        }
        this.notifyMissingDeviceIfNeeded(error);
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
    return this.retryExecutor.executeOrThrow(
      async () => {
        if (resolvedSignal?.aborted) {
          throw this.getAbortError(resolvedSignal);
        }
        await beforeDispatch?.(this.getRemainingTimeoutMs(timeoutMs, startTime, command));
        const result = await this.execWithSignal(
          adbPath,
          fullArgs,
          maxBuffer,
          this.getRemainingTimeoutMs(timeoutMs, startTime, command),
          resolvedSignal
        );
        return result;
      },
      {
        maxAttempts: AdbClient.MAX_ADB_RETRIES + 1,
        delays: 0, // Immediate retry (no delay)
        signal: resolvedSignal,
        shouldRetry: error => {
          if (resolvedSignal?.aborted) {
            return false;
          }
          const retryable = !this.isNonRetryableError(error);
          if (!retryable) {
            this.notifyMissingDeviceIfNeeded(error);
          }
          return retryable;
        },
        onRetry: (error, attempt) => {
          logger.debug(`[ADB] Retrying command (attempt ${attempt + 1}): ${command} - ${error.message}`);
        },
      }
    );
  }

  private async execWithSignal(
    file: string,
    args: string[],
    maxBuffer?: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<ExecResult> {
    if (signal?.aborted) {
      throw this.getAbortError(signal);
    }

    if (this.isTestMode) {
      return this.execAsync(file, args, maxBuffer);
    }

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const options = maxBuffer ? { maxBuffer } : undefined;
      const child = execFile(file, args, options, (error, stdout, stderr) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(wrapCommandError(error, {
            command: file,
            args,
            stdout,
            stderr,
          }));
          return;
        }
        resolve(createExecResult(stdout, stderr));
      });

      this.activeProcesses.add(child);

      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(this.getAbortError(signal));
      };

      const onExit = () => {
        this.activeProcesses.delete(child);
      };

      const cleanup = () => {
        this.activeProcesses.delete(child);
        child.off("exit", onExit);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      let timeoutId: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timeoutId = this.timer.setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          child.kill("SIGTERM");
          reject(new AdbCommandTimeoutError(`Command timed out after ${timeoutMs}ms: ${file} ${args.join(" ")}`));
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
        (shellCommand.startsWith("\"") && shellCommand.endsWith("\"")) ||
        (shellCommand.startsWith("'") && shellCommand.endsWith("'"))
      ) {
        shellCommand = shellCommand.slice(1, -1);
      }
      return ["shell", shellCommand];
    }

    const args: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let escape = false;

    for (const char of trimmed) {
      if (escape) {
        current += char;
        escape = false;
        continue;
      }

      if (!isWindows && char === "\\" && !inSingle) {
        escape = true;
        continue;
      }

      if (char === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }

      if (char === "\"" && !inSingle) {
        inDouble = !inDouble;
        continue;
      }

      if (!inSingle && !inDouble && /\s/.test(char)) {
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

  /**
   * Get the list of connected devices
   * @returns Promise with an array of device IDs
   */
  async getBootedAndroidDevices(
    options: { bypassCache?: boolean; throwOnMissingAdb?: boolean; signal?: AbortSignal } = {}
  ): Promise<BootedDevice[]> {
    if (this.shouldSkipMissingAdbProbe()) {
      if (options.throwOnMissingAdb) {
        throw new AdbUnavailableError("ADB executable is unavailable");
      }
      return [];
    }

    // Check cache first - TTLCache handles expiration automatically
    const cache = getDeviceListCache();
    const cachedDevices = options.bypassCache ? undefined : cache.get("devices");
    if (cachedDevices) {
      logger.debug("Getting list of connected devices (cached)");
      return cachedDevices;
    }

    logger.debug("Getting list of connected devices");
    let result: ExecResult;
    try {
      result = await this.executeCommand(
        "devices -l",
        AdbClient.DEVICE_LIST_TIMEOUT_MS,
        undefined,
        true,
        options.signal,
      );
    } catch (error) {
      if (this.isMissingExecutableError(error)) {
        this.recordMissingAdbProbe();
        if (options.throwOnMissingAdb) {
          throw new AdbUnavailableError(`ADB executable is unavailable: ${(error as Error).message}`);
        }
        return [];
      }
      throw error;
    }
    const lines = result.stdout.split("\n").slice(1); // Skip the first line which is the header

    const devices = lines
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        const [deviceId, state, ...details] = line.trim().split(/\s+/);
        if (!deviceId || state !== "device") {
          return [];
        }
        const transportId = details
          .find(detail => detail.startsWith("transport_id:"))
          ?.slice("transport_id:".length);
        return [{
          name: deviceId,
          platform: "android",
          deviceId,
          ...(transportId ? { transportId } : {}),
        } satisfies BootedDevice];
      });

    // Cache the result
    cache.set("devices", devices);

    return devices;
  }

  /**
   * List raw ADB states without applying the online-only filter used by
   * getBootedAndroidDevices(). Readiness diagnostics use this to distinguish a
   * device that is absent from one that is present but stuck offline.
   */
  async getDeviceStates(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AdbDeviceState[]> {
    if (this.shouldSkipMissingAdbProbe()) {
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
        // Preserve the diagnostic path while treating an unavailable ADB as no connected devices.
        logger.debug(`[ADB] Unable to query device states because adb is unavailable: ${(error as Error).message}`);
        this.recordMissingAdbProbe();
        return [];
      }
      throw error;
    }

    return result.stdout
      .split("\n")
      .slice(1)
      .flatMap(line => {
        const [deviceId, state] = line.trim().split(/\s+/);
        return deviceId && state ? [{ deviceId, state }] : [];
      });
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
      const result = await this.executeCommand("shell dumpsys power | grep mWakefulness=", undefined, undefined, true, signal);
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
        signal
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
      secure: secure ?? undefined
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
      const result = await this.executeCommand("shell dumpsys user", undefined, undefined, true, signal);
      const users = this.parseUsersFromDumpsys(result.stdout);

      if (users.length > 0) {
        logger.info(`[ADB] Found ${users.length} user(s) via dumpsys: ${users.map(u => `${u.userId}:${u.name}`).join(", ")}`);
        return users;
      }

      // If dumpsys parsing failed, fall back to pm list users
      logger.debug("[ADB] dumpsys user parsing returned no users, falling back to pm list users");
      return await this.listUsersLegacy(signal);
    } catch (error) {
      logger.debug(`[ADB] dumpsys user failed: ${(error as Error).message}, falling back to pm list users`);
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
      if (userMatch) {
        const userId = parseInt(userMatch[1], 10);
        let userName = userMatch[2];
        const flags = parseInt(userMatch[3], 16); // Parse as hexadecimal

        // Look for the State line in the next few lines
        let running = false;
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const stateLine = lines[j];

          // If we hit another UserInfo, stop searching
          if (stateLine.match(/UserInfo\{/)) {
            break;
          }

          // Check for State: RUNNING_UNLOCKED or RUNNING_LOCKED
          if (stateLine.match(/State:\s+(RUNNING_UNLOCKED|RUNNING_LOCKED)/)) {
            running = true;
            break;
          }

          // If we see State: SHUTDOWN, mark as not running
          if (stateLine.match(/State:\s+SHUTDOWN/)) {
            running = false;
            break;
          }
        }

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
          running
        });
      }
    }

    return users;
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
      const result = await this.executeCommand("shell pm list users", undefined, undefined, true, signal);
      const lines = result.stdout.split("\n");
      const users: AndroidUser[] = [];

      for (const line of lines) {
        // Match pattern: UserInfo{userId:name:flags} [running]
        // Note: flags are hexadecimal (e.g., "4c13")
        const match = line.match(/UserInfo\{(\d+):([^:]+):([0-9a-fA-F]+)\}\s*(running)?/);
        if (match) {
          users.push({
            userId: parseInt(match[1], 10),
            name: match[2],
            flags: parseInt(match[3], 16), // Parse as hexadecimal
            running: match[4] === "running"
          });
        }
      }

      if (users.length > 0) {
        logger.info(`[ADB] Found ${users.length} user(s) via pm: ${users.map(u => `${u.userId}:${u.name}`).join(", ")}`);
        return users;
      }

      // If still no users found, log the raw output for debugging
      logger.warn(`[ADB] Failed to parse users from pm list users. Raw output: ${result.stdout.substring(0, 200)}`);

      // Return primary user as last resort fallback
      return [{
        userId: 0,
        name: "Owner",
        flags: 0x13,
        running: true
      }];
    } catch (error) {
      logger.warn(`[ADB] Failed to list users via pm: ${(error as Error).message}`);
      // Return primary user as fallback
      return [{
        userId: 0,
        name: "Owner",
        flags: 0x13,
        running: true
      }];
    }
  }

  /**
   * Get the current foreground app package name and user ID
   * Uses dumpsys activity to find the resumed/focused activity
   * @returns Promise with { packageName: string, userId: number } or null if no app in foreground
   */
  async getForegroundApp(signal?: AbortSignal): Promise<{ packageName: string; userId: number } | null> {
    try {
      const result = await this.executeCommand(
        'shell dumpsys activity activities | grep -E "(mResumedActivity|mFocusedActivity|topResumedActivity)" | head -1',
        undefined,
        undefined,
        true,
        signal
      );

      // Parse output to extract package name and user ID
      // Example patterns:
      //   mResumedActivity: ActivityRecord{abc1234 u0 com.example.app/.MainActivity t123}
      //   mFocusedActivity: ActivityRecord{abc1234 u10 com.example.app/.MainActivity t123}
      //   topResumedActivity=ActivityRecord{abc1234 u0 com.example.app/.MainActivity t123}

      const match = result.stdout.match(/u(\d+)\s+([^\s/]+)\//);
      if (match) {
        const userId = parseInt(match[1], 10);
        const packageName = match[2];
        logger.info(`[ADB] Foreground app: ${packageName} (user ${userId})`);
        return { packageName, userId };
      }

      logger.debug("[ADB] No foreground app detected");
      return null;
    } catch (error) {
      logger.debug(`[ADB] Failed to get foreground app: ${(error as Error).message}`);
      return null;
    }
  }
}
