import { AMBIENT_ENV, ENV, readEnvRaw } from "../../config/env";
import { AndroidUser, BootedDevice, DeviceLockState, ExecResult } from "../../models";
import { isDeviceLostError } from "../../models/DeviceLostError";
import { deviceLostErrorFromAbortSignal } from "../deviceLossAbortRegistry";
import { getAbortSignal } from "../AbortContext";
import { type AndroidTransportRouting } from "../androidSerial";
import type { BackoffPolicy } from "../Backoff";
import { delayForAttempt, sequenceBackoff } from "../Backoff";
import { TTLCache } from "../cache/Cache";
import { errorMessage } from "../describeUnknownError";
import type { DiscoveryObservationSequence } from "../DiscoveryObservationSequence";
import { runExecSeam } from "../ExecSeam";
import {
  DefaultHostCommandExecutor,
  execFileAsync as sharedExecFileAsync,
  type HostProcessExecutor,
  type SpawnFn,
} from "../HostCommandExecutor";
import { logger } from "../logger";
import {
  getNativeHelperRegistry,
  type NativeHelperTracker,
} from "../nativeHelpers/NativeHelperRegistry";
import { trackAmbient } from "../PerfContext";
import { requirePipedOutput } from "../pipedChildProcess";
import { RetryExecutor, defaultRetryExecutor } from "../retry/RetryExecutor";
import type { SystemDetection } from "../system/SystemDetection";
import { Timer, defaultTimer } from "../SystemTimer";
import { removeFinishedAdbChild, trackActiveAdbChild } from "./adbActiveProcesses";
import { resolveAdbClientSettings, type AdbClientDependencies } from "./AdbClientDependencies";
import { parseCommandArgs } from "./AdbCommandArguments";
import {
  isNonRetryableAdbError,
  isPreDispatchError,
  isSafeToRetryCommand,
} from "./adbCommandRetryPolicy";
import { AdbCommandTimeoutError } from "./AdbCommandTimeoutError";
import { AdbDeviceDiscovery, resetAdbDeviceDiscoveryCache } from "./AdbDeviceDiscovery";
import { isAdbMissingDeviceError, notifyAdbMissingDevice } from "./AdbDeviceHealth";
import { AdbDeviceReadings } from "./AdbDeviceReadings";
import { AdbDeviceTransportUnavailableError } from "./AdbDeviceTransportUnavailableError";
import { AdbPathDiscovery } from "./AdbPathDiscovery";
import { AdbSignalExecutor, type AdbSignalExecOptions } from "./AdbSignalExecutor";
import {
  ADB_TRANSPORT_RECOVERY_BACKOFF,
  executeWithAdbTransportRecovery,
  getAdbAbortError,
} from "./adbTransportRecovery";
import {
  defaultAdbTransportRestartRegistry,
  isAdbTransportRestartCommand,
  type AdbTransportRestartRegistry,
} from "./AdbTransportRestartRegistry";
import type { EmulatorConsoleBusyRegistry } from "./EmulatorConsoleBusyRegistry";
import {
  AdbExecutor,
  type AdbDeviceState,
  type AdbExecuteOptions,
  type AdbProcess,
  type AdbSpawnOptions,
  type DeviceTimestampResult,
  type ForegroundApp,
  type ForegroundAppReadResult,
} from "./interfaces/AdbExecutor";
export { terminateActiveAdbProcesses } from "./adbActiveProcesses";

export { AdbCommandTimeoutError } from "./AdbCommandTimeoutError";
export { AdbUnavailableError } from "./AdbUnavailableError";

type ExecFileAsync = (file: string, args: string[], maxBuffer?: number) => Promise<ExecResult>;

// Route the default long-lived spawn through the shared host-process seam so the
// client no longer reaches for `child_process.spawn` directly (issue #5459). The
// executor's `spawn` is a plain passthrough, so this is behavior-identical; all
// of AdbClient's own timeout/abort/process-tracking orchestration is unchanged.
export const adbHostProcessExecutor: HostProcessExecutor = new DefaultHostCommandExecutor();

/**
 * Replace a command line that must not be logged (see `AdbExecuteOptions.logLabel`) in a
 * failure's message, stack and `cmd`, keeping the error's class and other fields.
 */
function redactCommandFromError(
  error: unknown,
  fullArgs: string[],
  commandArgs: string[],
  label: string,
): Error {
  if (!(error instanceof Error)) {
    return new Error(`adb command failed: ${label}`);
  }
  const secrets = [
    fullArgs.join(" "),
    commandArgs.join(" "),
    ...commandArgs.filter((arg) => arg !== "shell"),
  ].filter((secret) => secret.length > 0);
  const redact = (text: string): string =>
    secrets.reduce((redacted, secret) => redacted.split(secret).join(label), text);
  error.message = redact(error.message);
  if (error.stack) {
    error.stack = redact(error.stack);
  }
  if ("cmd" in error && typeof error.cmd === "string") {
    error.cmd = label;
  }
  return error;
}

// Module-level cache configuration and instances
const moduleTimer: Timer = defaultTimer;
// Keep production clients sharing the resolved path while isolating injected
// execution seams. A module-wide path cache keyed only by "adbPath" lets one
// test/client reuse another client's incomplete or synthetic discovery result.
let adbPathCaches = new WeakMap<ExecFileAsync, TTLCache<string, string>>();
const ADB_PATH_CACHE_TTL_MS = 60000; // 1 minute - ADB path rarely changes
const MACOS_MISSING_ADB_PROBE_COOLDOWN_MS = 30000;

function getAdbPathCache(execAsync: ExecFileAsync): TTLCache<string, string> {
  let cache = adbPathCaches.get(execAsync);
  if (!cache) {
    cache = new TTLCache(moduleTimer, { ttlMs: ADB_PATH_CACHE_TTL_MS });
    adbPathCaches.set(execAsync, cache);
  }
  return cache;
}

export function resetAdbClientCaches(): void {
  resetAdbDeviceDiscoveryCache();
  adbPathCaches = new WeakMap();
  AdbClient.resetMissingAdbProbeState();
}

export function resetAdbDeviceListCache(): void {
  resetAdbDeviceDiscoveryCache();
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
  if (readEnvRaw(AMBIENT_ENV.DEBUG_ADB_EXEC)) {
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
  readonly adbDeviceDiscovery: AdbDeviceDiscovery;
  private createAdbDeviceDiscovery(): AdbDeviceDiscovery {
    const client = this;
    return new AdbDeviceDiscovery({
      shouldSkipMissingAdbProbe: (...args) => client.shouldSkipMissingAdbProbe(...args),
      get timer() {
        return client.timer;
      },
      get DEVICE_LIST_TIMEOUT_MS() {
        return AdbClient.DEVICE_LIST_TIMEOUT_MS;
      },
      executeCommand: (...args) => client.executeCommand(...args),
      isMissingExecutableError: (...args) => client.isMissingExecutableError(...args),
      recordMissingAdbProbe: (...args) => client.recordMissingAdbProbe(...args),
      get observationSequence() {
        return client.observationSequence;
      },
      getDeviceStates: (...args) => client.getDeviceStates(...args),
    });
  }

  private readonly adbDeviceReadings: AdbDeviceReadings;
  private createAdbDeviceReadings(): AdbDeviceReadings {
    const client = this;
    return new AdbDeviceReadings({
      executeCommand: (...args) => client.executeCommand(...args),
      get timer() {
        return client.timer;
      },
    });
  }

  private readonly adbPathDiscovery: AdbPathDiscovery;
  private createAdbPathDiscovery(): AdbPathDiscovery {
    const client = this;
    return new AdbPathDiscovery({
      get timer() {
        return client.timer;
      },
      execWithSignal: (...args) => client.execWithSignal(...args),
      get systemDetectionFactory() {
        return client.systemDetectionFactory;
      },
      getAbortError: getAdbAbortError,
    });
  }

  device: BootedDevice | null;
  execAsync: ExecFileAsync;
  spawnFn: SpawnFn;
  private adbPath: string;
  private isTestMode: boolean;
  private readonly hostProcessExecutor: HostProcessExecutor;
  /**
   * Cached API level for the current device. Intentionally never expires during
   * a device session because API level is constant. Reset on setDevice().
   * NOT using TTLCache: session-scoped without time-based expiration.
   */
  private apiLevelCache: number | null | undefined;
  private readonly retryExecutor: RetryExecutor;
  private readonly timer: Timer;
  private readonly systemDetectionFactory: () => SystemDetection;
  private readonly observationSequence: DiscoveryObservationSequence;
  private readonly consoleBusyRegistry: EmulatorConsoleBusyRegistry | undefined;
  private readonly transportBackoff: BackoffPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly transportRouting: AndroidTransportRouting | undefined;
  private readonly transportRestartRegistry: AdbTransportRestartRegistry | undefined;
  private readonly nativeHelperRegistry: NativeHelperTracker | undefined;

  static readonly DEVICE_LIST_TIMEOUT_MS = 10_000;
  private static readonly MAX_ADB_RETRIES = 3;
  private static readonly ADB_RETRY_BACKOFF = sequenceBackoff([200, 500, 1000]);
  private static readonly MAX_MACOS_MISSING_ADB_PROBES = 3;
  private static macosMissingAdbProbes = 0;
  private static macosMissingAdbProbeStartedAt: number | null = null;

  /**
   * Create an AdbClient instance
   * @param device - Optional device
   * @param execAsyncFn - promisified exec function (for testing)
   * @param dependencies - optional collaborators (spawn, retry, timer, registries); see {@link AdbClientDependencies}
   */
  constructor(
    device: BootedDevice | null = null,
    execAsyncFn:
      | ((command: string, maxBuffer?: number) => Promise<ExecResult>)
      | ExecFileAsync
      | null = null,
    dependencies: AdbClientDependencies = {},
  ) {
    const {
      spawnFn = null,
      retryExecutor = defaultRetryExecutor,
      timer = defaultTimer,
      transportBackoff = ADB_TRANSPORT_RECOVERY_BACKOFF,
      consoleBusyRegistry,
      hostProcessExecutor = adbHostProcessExecutor,
      transportRouting,
      transportRestartRegistry,
      nativeHelperRegistry,
    } = dependencies;
    const settings = resolveAdbClientSettings(dependencies);
    this.systemDetectionFactory = settings.systemDetectionFactory;
    this.observationSequence = settings.observationSequence;
    this.consoleBusyRegistry = consoleBusyRegistry;
    this.defaultTimeoutMs = settings.defaultTimeoutMs;
    this.transportRouting = transportRouting;
    this.transportRestartRegistry = transportRestartRegistry;
    this.nativeHelperRegistry = nativeHelperRegistry;
    this.device = device;
    this.hostProcessExecutor = hostProcessExecutor;
    // Test mode if: custom execAsync provided OR global test mode flag is set
    // Check for any truthy value (not just exactly "true") to handle different env var formats
    this.isTestMode = this.hasTestExecution(execAsyncFn, readEnvRaw(ENV.TEST_MODE));
    this.execAsync = this.resolveExecAsync(execAsyncFn);
    this.spawnFn = this.resolveSpawnFn(spawnFn);
    this.retryExecutor = retryExecutor;
    this.timer = timer;
    this.transportBackoff = transportBackoff;
    this.adbPathDiscovery = this.createAdbPathDiscovery();
    // Initialize with fallback, will be updated lazily
    this.adbPath = this.getFallbackAdbPath();

    // Debug: Log when a real (non-test) AdbClient is created
    if (readEnvRaw(AMBIENT_ENV.DEBUG_ADB_EXEC) && !this.isTestMode) {
      logger.debug(`[DEBUG_ADB_EXEC] Real AdbClient created (not test mode)`);
      logger.debug(`[DEBUG_ADB_EXEC] Stack trace:`, new Error().stack);
    }

    this.adbDeviceReadings = this.createAdbDeviceReadings();

    this.adbDeviceDiscovery = this.createAdbDeviceDiscovery();
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
  private getFallbackAdbPath(): string {
    return this.adbPathDiscovery.getFallbackAdbPath();
  }

  private getAdbPath(timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    return this.adbPathDiscovery.getAdbPath(timeoutMs, signal);
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
   * @param options - Timeout, buffer, retry (`noRetry` for commands expected to fail), cancellation
   *   and streaming options
   * @returns Promise with command output
   */
  async executeCommand(command: string, options: AdbExecuteOptions = {}): Promise<ExecResult> {
    return this.execute(parseCommandArgs(command), options);
  }

  async execute(args: string[], options: AdbExecuteOptions = {}): Promise<ExecResult> {
    const deviceId = this.device?.deviceId;
    // adb root/unroot restarts adbd, so the serial briefly leaves `adb devices`;
    // mark it so the disconnect monitor does not mistake that for an unplug (#10493).
    return deviceId && isAdbTransportRestartCommand(args)
      ? (this.transportRestartRegistry ?? defaultAdbTransportRestartRegistry).runRestart(
          deviceId,
          () => this.executeTracked(args, options),
        )
      : this.executeTracked(args, options);
  }

  private async executeTracked(args: string[], options: AdbExecuteOptions): Promise<ExecResult> {
    const {
      timeoutMs,
      maxBuffer,
      noRetry,
      signal,
      beforeDispatch,
      waitForProcessSettlementAfterAbort,
      logLabel,
      onStdout,
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
      logLabel,
      onStdout,
    });
    AdbClient.resetMissingAdbProbeState();
    const duration = this.timer.now() - startTime;
    const command = logLabel ?? args.join(" ");

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
      throw getAdbAbortError(signal);
    }

    const { adbPath, baseArgs } = await this.getBaseCommandParts(options.timeoutMs, signal);
    if (signal?.aborted) {
      throw getAdbAbortError(signal);
    }
    const fullArgs = [...baseArgs, ...args];
    const remainingTimeoutMs = this.getRemainingTimeoutMs(
      options.timeoutMs,
      startTime,
      args.join(" "),
    );
    const busyAtDispatch = this.getConsoleBusyAtDispatch();
    const child = requirePipedOutput(
      this.spawnFn(adbPath, fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.abortSignalScope === "startup" ? undefined : signal,
      }),
      "the adb process",
    );
    trackActiveAdbChild(child);
    (this.nativeHelperRegistry ?? getNativeHelperRegistry()).track(child, {
      kind: "adb",
      processGroup: false,
    });

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
      removeFinishedAdbChild(child);
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
        settleStart?.(getAdbAbortError(signal));
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

    return child;
  }

  /**
   * Get device time in milliseconds since epoch.
   * Falls back to host time if the device timestamp cannot be retrieved.
   */
  async getDeviceTimestampMs(): Promise<number> {
    const result = await this.getDeviceTimestampMsWithSource();
    return result.timestampMs;
  }
  getDeviceTimestampMsWithSource(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<DeviceTimestampResult> {
    return this.adbDeviceReadings.getDeviceTimestampMsWithSource(timeoutMs, signal);
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
      const result = await this.executeCommand("shell getprop ro.build.version.sdk", {
        timeoutMs,
        noRetry: true,
        signal,
      });
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
    const spanArgs = options.logLabel ? commandArgs.slice(0, 1) : commandArgs.slice(0, 2);
    const signal = options.signal ?? getAbortSignal();
    return trackAmbient(`adb ${spanArgs.join(" ")}`.trimEnd(), () =>
      this.executeArgsImplInner(commandArgs, options),
    ).catch((error: unknown) => {
      const lost = signal && deviceLostErrorFromAbortSignal(signal);
      throw lost ?? error;
    });
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
      logLabel,
      onStdout,
    } = options;
    const startTime = this.timer.now();
    const resolvedSignal = signal ?? getAbortSignal();
    const { adbPath, baseArgs } = await this.getBaseCommandParts(timeoutMs, resolvedSignal);
    const fullArgs = [...baseArgs, ...commandArgs];
    const command = logLabel ?? commandArgs.join(" ");
    const rawExec = async (remainingMs?: number): Promise<ExecResult> => {
      try {
        return await this.execWithSignal(adbPath, fullArgs, {
          maxBuffer,
          timeoutMs: remainingMs,
          signal: resolvedSignal,
          waitForProcessSettlementAfterAbort,
          onStdout,
        });
      } catch (error) {
        throw logLabel ? redactCommandFromError(error, fullArgs, commandArgs, logLabel) : error;
      }
    };

    const exec = () =>
      executeWithAdbTransportRecovery(
        async (attempt) => {
          if (attempt > 1) {
            await beforeDispatch?.(this.getRemainingTimeoutMs(timeoutMs, startTime, command));
          }
          return rawExec(this.getRemainingTimeoutMs(timeoutMs, startTime, command));
        },
        {
          deviceId: this.device?.deviceId,
          transportId: baseArgs[1],
          timer: this.timer,
          backoff: this.transportBackoff,
          remainingMs: () =>
            timeoutMs === undefined ? undefined : timeoutMs - (this.timer.now() - startTime),
          signal: resolvedSignal,
          onExhausted: (error) =>
            this.notifyMissingDeviceIfNeeded(error, busyAtDispatch, baseArgs[1]),
        },
      );
    let busyAtDispatch = { busy: false, generation: 0 };

    // Log which device is receiving this command for parallel execution debugging
    const deviceInfo = this.device ? `[DEVICE:${this.device.deviceId}]` : "[NO-DEVICE]";
    logger.debug(
      `[ADB] ${deviceInfo} Executing: ${command.length > 80 ? command.substring(0, 80) + "..." : command}`,
    );

    if (noRetry) {
      // Skip general retries; pre-dispatch transport refusals still get their bounded wait.
      try {
        await beforeDispatch?.(this.getRemainingTimeoutMs(timeoutMs, startTime, command));
        busyAtDispatch = this.getConsoleBusyAtDispatch();
        return await exec();
      } catch (error) {
        if (resolvedSignal?.aborted) {
          throw getAdbAbortError(resolvedSignal);
        }
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
        busyAtDispatch = { busy: false, generation: 0 };
        if (resolvedSignal?.aborted) {
          throw getAdbAbortError(resolvedSignal);
        }
        await beforeDispatch?.(this.getRemainingTimeoutMs(timeoutMs, startTime, command));
        busyAtDispatch = this.getConsoleBusyAtDispatch();
        return await exec();
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
          if (
            isDeviceLostError(error) ||
            (error instanceof AdbDeviceTransportUnavailableError && error.dispatched !== "unknown")
          ) {
            return false;
          }
          if (error instanceof AdbCommandTimeoutError) {
            // A dispatch timeout has, by construction, already consumed the
            // whole command budget. Retrying would sleep past the caller's
            // deadline for a result the caller no longer wants; surface the
            // original "Command timed out after ..." error instead.
            return false;
          }
          const retryError =
            error instanceof AdbDeviceTransportUnavailableError && error.cause instanceof Error
              ? error.cause
              : error;
          if (isNonRetryableAdbError(retryError, this.device !== null)) {
            return false;
          }
          return (
            isSafeToRetryCommand(commandArgs, beforeDispatch !== undefined) ||
            (!(error instanceof AdbDeviceTransportUnavailableError) &&
              isPreDispatchError(retryError))
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
  private execWithSignal(
    file: string,
    args: string[],
    options: AdbSignalExecOptions = {},
  ): Promise<ExecResult> {
    return new AdbSignalExecutor({
      isTestMode: this.isTestMode,
      execAsync: this.execAsync,
      hostProcessExecutor: this.hostProcessExecutor,
      timer: this.timer,
    }).execWithSignal(file, args, options);
  }

  /** Typed test seam for the private execution members (#11865). */
  get testHooks() {
    const client = this;
    type ExecWithSignal = AdbClient["execWithSignal"];
    return {
      get isTestMode(): boolean {
        return client.isTestMode;
      },
      set isTestMode(value: boolean) {
        client.isTestMode = value;
      },
      get execWithSignal(): ExecWithSignal {
        return (...args) => client.execWithSignal(...args);
      },
      set execWithSignal(fn: ExecWithSignal) {
        client.execWithSignal = fn;
      },
    };
  }

  getBootedAndroidDevices(
    options: {
      bypassCache?: boolean;
      throwOnMissingAdb?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<BootedDevice[]> {
    return this.adbDeviceDiscovery.getBootedAndroidDevices(options);
  }

  getDeviceStates(
    options: { timeoutMs?: number; signal?: AbortSignal; throwOnMissingAdb?: boolean } = {},
  ): Promise<AdbDeviceState[]> {
    return this.adbDeviceDiscovery.getDeviceStates(options);
  }

  getReadinessDeviceSnapshot(options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ states: AdbDeviceState[]; devices: BootedDevice[] }> {
    return this.adbDeviceDiscovery.getReadinessDeviceSnapshot(options);
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
  getWakefulness(signal?: AbortSignal): Promise<"Awake" | "Asleep" | "Dozing" | null> {
    return this.adbDeviceReadings.getWakefulness(signal);
  }

  getDeviceLock(signal?: AbortSignal): Promise<DeviceLockState | null> {
    return this.adbDeviceReadings.getDeviceLock(signal);
  }
  listUsers(signal?: AbortSignal): Promise<AndroidUser[]> {
    return this.adbDeviceReadings.listUsers(signal);
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
  getForegroundAppChecked(
    signal?: AbortSignal,
    timeout?: number | { timeoutMs?: number; displayId?: number },
  ): Promise<ForegroundAppReadResult> {
    return this.adbDeviceReadings.getForegroundAppChecked(signal, timeout);
  }
}
