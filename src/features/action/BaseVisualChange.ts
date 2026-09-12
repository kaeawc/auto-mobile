import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AwaitIdle } from "../observe/AwaitIdle";
import { RealObserveScreen } from "../observe/ObserveScreen";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { Window } from "../observe/Window";
import { isForegroundLauncher } from "../observe/androidLauncherPackages";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { DEFAULT_FUZZY_MATCH_TOLERANCE_PERCENT } from "../../utils/constants";
import {
  ActionableError,
  BootedDevice,
  DeviceLockState,
  GfxMetrics,
  ObserveResult,
} from "../../models";
import { ViewHierarchyQueryOptions } from "../../models/ViewHierarchyQueryOptions";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { NodeCryptoService } from "../../utils/crypto";
import { throwIfAborted } from "../../utils/toolUtils";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { NavigationGraphManager } from "../navigation/NavigationGraphManager";
import { PredictionAnalyzer, PredictionActionContext } from "../observe/PredictionAnalyzer";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { sequenceBackoff } from "../../utils/Backoff";
import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";
import { shouldSkipActionObservationScreenshot } from "../observe/automaticScreenshotPolicy";
import { serverConfig } from "../../utils/ServerConfig";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";

export interface ProgressCallback {
  (progress: number, total?: number, message?: string): Promise<void>;
}

/**
 * Backoff delays (ms) between `takeObservation`'s post-action retries below.
 * Exported so callers that must budget the WORST CASE of this retry loop
 * (e.g. the daemon's `TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS` in
 * `src/daemon/mcpRequestTimeout.ts`) derive it from the real constant instead
 * of guessing at a duplicated magic number (issue #6248 review, P2).
 */
export const FINAL_OBSERVATION_RETRY_BACKOFF_MS: readonly number[] = [50, 100, 200, 400];

/**
 * Max retry attempts `takeObservation` performs after its initial observation
 * (5 observation attempts total). Exported for the same reason as
 * `FINAL_OBSERVATION_RETRY_BACKOFF_MS` above.
 */
export const FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS = 4;

interface ObservedChangeOptions {
  changeExpected: boolean;
  timeoutMs?: number;
  packageName?: string;
  progress?: ProgressCallback;
  tolerancePercent?: number;
  queryOptions?: ViewHierarchyQueryOptions;
  perf?: PerformanceTracker;
  skipPreviousObserve?: boolean;
  skipUiStability?: boolean;
  observationTimestampProvider?: () => number | undefined;
  overrideMinTimestamp?: number;
  signal?: AbortSignal;
  deferPredictionOutcome?: boolean;
  deferPostActionScreenshot?: boolean;
  predictionContext?: {
    toolName: string;
    toolArgs: Record<string, any>;
  };
}

export class BaseVisualChange {
  device: BootedDevice;
  adb: AdbExecutor;
  protected adbFactory: AdbClientFactory;
  awaitIdle: AwaitIdle;
  observeScreen: ObserveScreen;
  window: Window;
  private predictionAnalyzer: PredictionAnalyzer;
  private deferredPredictionOutcomes = new WeakMap<
    object,
    (observation: ObserveResult) => Promise<void>
  >();
  protected timer: Timer;

  protected shouldCapturePostActionScreenshot(): boolean {
    // Preserve the pre-existing live-view behavior, while allowing other
    // clients to opt in with AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT=0.
    return (
      !shouldSkipActionObservationScreenshot() ||
      (getDeviceDataStreamServer()?.hasSubscriberForDevice(this.device.deviceId) ?? false)
    );
  }

  /**
   * Create an BaseVisualChange instance
   * @param device - The target device
   * @param adbFactoryOrExecutor - AdbClientFactory instance, AdbExecutor instance, or null (uses default factory)
   * @param timer - Optional timer for testing
   */
  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    timer: Timer = defaultTimer,
  ) {
    this.device = device;
    // Detect if the argument is a factory (has create method) or an executor
    if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      this.adbFactory = adbFactoryOrExecutor as AdbClientFactory;
      this.adb = this.adbFactory.create(device);
    } else if (adbFactoryOrExecutor) {
      // Legacy path: wrap the executor in a factory for downstream dependencies
      const executor = adbFactoryOrExecutor as AdbExecutor;
      this.adb = executor;
      this.adbFactory = { create: () => executor };
    } else {
      this.adbFactory = defaultAdbClientFactory;
      this.adb = this.adbFactory.create(device);
    }
    this.awaitIdle = new AwaitIdle(device, this.adbFactory);
    this.observeScreen = new RealObserveScreen(device, this.adbFactory);
    // Forward the injected clock so the internal Window shares this instance's
    // timer: home-verification derives its outer deadline from `this.timer`, and
    // Window derives the per-subread budgets from ITS timer — they must be the
    // same clock or a FakeTimer's elapsed time won't shrink the ADB sub-read
    // budgets in the integrated path (issue #6289).
    this.window = new Window(device, this.adbFactory, timer);
    this.predictionAnalyzer = new PredictionAnalyzer();
    this.timer = timer;
  }

  /**
   * Execute a block of code and wait for UI to stabilize with optional observation
   * @param block - Block of code to execute which should have a visual change.
   * @param options - Options controlling observation behavior
   */
  async observedInteraction(
    block: (observeResult: ObserveResult) => Promise<any>,
    options: ObservedChangeOptions,
  ): Promise<any> {
    const timeoutMs = options.timeoutMs || 12000;
    const progress = options.progress;
    const perf = options.perf ?? new NoOpPerformanceTracker();

    if (progress) {
      await progress(0, 100, "Preparing to execute action...");
    }
    throwIfAborted(options.signal);

    // Fetch cached view hierarchy (skip if we just terminated/cleared the app)
    let previousObserveResult: ObserveResult | null = null;
    const predictionContext = this.buildPredictionContext(options.predictionContext);
    if (options.skipPreviousObserve) {
      logger.info("[BaseVisualChange] Skipping previous observe (app was terminated/cleared)");
    } else {
      try {
        if (progress) {
          await progress(10, 100, "Getting previous view hierarchy...");
        }
        previousObserveResult = await perf.track("getPreviousObserve", async () => {
          const cached = await this.observeScreen.getMostRecentCachedObserveResult();
          if (!cached?.viewHierarchy || cached.viewHierarchy.hierarchy.error) {
            return this.observeScreen.execute({
              queryOptions: options.queryOptions,
              perf,
              skipWaitForFresh: true,
              signal: options.signal,
            });
          }
          return cached;
        });
      } catch {
        previousObserveResult = await perf.track("getPreviousObserveFallback", async () => {
          return this.observeScreen.execute({
            queryOptions: options.queryOptions,
            perf,
            skipWaitForFresh: true,
            signal: options.signal,
          });
        });
      }

      if (!previousObserveResult) {
        throw new ActionableError("Cannot perform action without view hierarchy");
      }
    }

    // Record the action start time (device time if available) to ensure fresh data
    const actionStartTime = await perf.track("getActionStartTime", async () => {
      if (this.device.platform !== "android") {
        return this.timer.now();
      }
      if (typeof this.adb.getDeviceTimestampMs === "function") {
        return this.adb.getDeviceTimestampMs();
      }
      return this.timer.now();
    });

    const blockResult = await perf.track("executeBlock", async () => {
      throwIfAborted(options.signal);
      return block(previousObserveResult!);
    });

    let observationStartTime = actionStartTime;
    const observationTimestampOverride = options.observationTimestampProvider?.();
    if (
      typeof observationTimestampOverride === "number" &&
      !Number.isNaN(observationTimestampOverride)
    ) {
      if (observationTimestampOverride >= actionStartTime) {
        observationStartTime = observationTimestampOverride;
        logger.debug(
          `[BaseVisualChange] Using observation timestamp override: ${observationStartTime}`,
        );
      } else {
        logger.debug(
          `[BaseVisualChange] Ignoring observation timestamp override (${observationTimestampOverride}) older than action start (${actionStartTime})`,
        );
      }
    }

    // Get package name for UI stability waiting
    // Priority: options > previousObserveResult.viewHierarchy.packageName > cached
    let packageName = options.packageName;

    // Try to get packageName from the observe result's view hierarchy (from accessibility service)
    if (!packageName && previousObserveResult?.viewHierarchy?.packageName) {
      packageName = previousObserveResult.viewHierarchy.packageName;
      logger.info(`[BaseVisualChange] Using packageName from view hierarchy: ${packageName}`);
    }

    // Fall back to cached active window if no packageName from hierarchy
    if (!packageName) {
      const cachedPackageName = (await this.window.getCachedActiveWindow())?.appId;
      if (cachedPackageName) {
        packageName = cachedPackageName;
        logger.info(`[BaseVisualChange] Using cached packageName: ${packageName}`);
      }
    }

    // Start UI stability tracking if we have a package name (skip if requested)
    let initState: any = null;
    let gfxMetrics: GfxMetrics | null = null;

    if (options.skipUiStability) {
      logger.info("[BaseVisualChange] Skipping UI stability tracking (skipUiStability=true)");
    } else if (this.device.platform !== "android") {
      logger.debug("[BaseVisualChange] Skipping UI stability tracking (gfxinfo is Android-only)");
    } else if (packageName) {
      logger.info(
        `[BaseVisualChange] Starting UI stability initialization with package: ${packageName}`,
      );
      initState = await perf
        .track("initUiStability", async () => {
          return this.awaitIdle.initializeUiStabilityTracking(packageName!, timeoutMs);
        })
        .catch((error) => {
          logger.debug(`[BaseVisualChange] UI stability initialization failed: ${error}`);
          return null;
        });

      // Execute UI stability waiting with appropriate state
      if (packageName.trim() !== "") {
        perf.serial("uiStability");
        if (initState !== null) {
          gfxMetrics = await this.awaitIdle.waitForUiStabilityWithState(
            packageName,
            timeoutMs,
            initState,
            perf,
            options.signal,
          );
        } else {
          gfxMetrics = await this.awaitIdle.waitForUiStability(
            packageName,
            timeoutMs,
            perf,
            options.signal,
          );
        }
        perf.end();
      }
    }

    const observed = await this.takeObservation(blockResult, previousObserveResult, {
      changeExpected: options.changeExpected,
      tolerancePercent: options.tolerancePercent ?? DEFAULT_FUZZY_MATCH_TOLERANCE_PERCENT,
      queryOptions: options.queryOptions,
      gfxMetrics,
      perf,
      actionStartTime: options.overrideMinTimestamp ?? observationStartTime,
      predictionContext: options.deferPredictionOutcome ? undefined : predictionContext,
      signal: options.signal,
      deferPostActionScreenshot: options.deferPostActionScreenshot,
    });
    if (options.deferPredictionOutcome && predictionContext && typeof observed === "object") {
      this.deferredPredictionOutcomes.set(observed, async (finalObservation) => {
        await this.predictionAnalyzer.recordOutcomeForAction(
          previousObserveResult,
          finalObservation,
          predictionContext,
        );
      });
    }
    this.annotateDeviceLock(observed, previousObserveResult);
    return observed;
  }

  /**
   * Flag when an interaction ran against a locked Android keyguard (#4280).
   *
   * The gesture is deliberately NOT blocked — a swipe-to-dismiss or a PIN-digit
   * tap is exactly how an agent recovers — but the result must never read as a
   * clean success when it likely never reached the app. We attach the pre-action
   * lock state (so an agent can branch on `secure`) plus a human-readable
   * warning. Android-only: `deviceLock` is only collected on Android observe.
   */
  private annotateDeviceLock(result: any, previousObserveResult: ObserveResult | null): void {
    if (!result || this.device.platform !== "android") {
      return;
    }
    const lock = previousObserveResult?.deviceLock;
    if (!lock?.locked) {
      return;
    }
    result.deviceLock = lock;
    result.deviceLockWarning = BaseVisualChange.buildDeviceLockWarning(lock);
    logger.warn(`[BaseVisualChange] ${result.deviceLockWarning}`);
  }

  /**
   * Record a deferred prediction outcome after a subclass replaces the initial
   * post-action observation with a later, more representative observation.
   */
  protected async recordDeferredPredictionOutcome(
    result: unknown,
    finalObservation: ObserveResult,
  ): Promise<void> {
    if (!result || typeof result !== "object") {
      return;
    }
    const recordOutcome = this.deferredPredictionOutcomes.get(result);
    if (!recordOutcome) {
      return;
    }
    this.deferredPredictionOutcomes.delete(result);
    await recordOutcome(finalObservation);
  }

  /**
   * Capture exactly one fresh screenshot after any subclass-specific
   * observation reconciliation has selected the result returned to the caller.
   */
  protected async captureTerminalObservationScreenshot(
    observation: ObserveResult | undefined,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    if (!observation) {
      return;
    }
    if (this.shouldCapturePostActionScreenshot() || serverConfig.isAccessibilityAuditEnabled()) {
      await this.observeScreen.captureScreenshot?.(perf, signal, observation);
      return;
    }
    await this.observeScreen.runAccessibilityAudit?.(observation, perf);
  }

  private static buildDeviceLockWarning(lock: DeviceLockState): string {
    const preamble = "Device is locked; this interaction likely did not reach the app under test.";
    if (lock.secure === true) {
      return `${preamble} The lock is secure (PIN/pattern/password) — ask the user to unlock the device before continuing.`;
    }
    if (lock.secure === false) {
      return `${preamble} The lock is a swipe lock — dismiss the keyguard (e.g. swipe up) before continuing.`;
    }
    return `${preamble} Unlock or dismiss the keyguard before continuing.`;
  }

  private async takeObservation(
    blockResult: any,
    previousObserveResult: ObserveResult | null,
    options: {
      changeExpected: boolean;
      tolerancePercent?: number;
      queryOptions?: ViewHierarchyQueryOptions;
      gfxMetrics?: GfxMetrics | null;
      perf?: PerformanceTracker;
      actionStartTime?: number;
      predictionContext?: PredictionActionContext;
      signal?: AbortSignal;
      deferPostActionScreenshot?: boolean;
    },
  ): Promise<any> {
    const perf = options.perf ?? new NoOpPerformanceTracker();

    // Use actionStartTime as minTimestamp to ensure we get data captured after the action
    // This prevents returning stale cached data from before the action was executed
    const minTimestamp = options.actionStartTime ?? 0;
    const retryBackoff = sequenceBackoff(FINAL_OBSERVATION_RETRY_BACKOFF_MS);
    const maxRetryAttempts = FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS;
    const previousHash = this.hashViewHierarchy(previousObserveResult?.viewHierarchy);

    perf.serial("finalObserve");
    // Wait for fresh data from accessibility service (skipWaitForFresh=false)
    // This ensures we get observation data that reflects the action that just completed
    let latestObservation = await this.observeScreen.execute({
      queryOptions: options.queryOptions,
      perf,
      skipWaitForFresh: false,
      minTimestamp,
      signal: options.signal,
      // Retries collect hierarchy only. If enabled, visual evidence is captured
      // once from the final observation below.
      skipScreenshot: true,
      skipAccessibilityAudit: true,
    });
    perf.end();

    const shouldRetry = (observation: ObserveResult): boolean => {
      // Don't retry if the observation has an error (service unavailable, connection failed, etc.)
      // Retrying won't help in these cases and just adds latency
      if (observation.viewHierarchy?.hierarchy?.error) {
        return false;
      }

      const isFresh = observation.freshness?.isFresh ?? true;
      if (minTimestamp > 0 && !isFresh) {
        return true;
      }
      if (!options.changeExpected) {
        return false;
      }
      const currentHash = this.hashViewHierarchy(observation.viewHierarchy);
      return !!previousHash && !!currentHash && previousHash === currentHash;
    };

    for (let attempt = 0; attempt < maxRetryAttempts && shouldRetry(latestObservation); attempt++) {
      const delayMs = retryBackoff.delayForAttempt(attempt + 1);
      logger.info(
        `[BaseVisualChange] Observation appears stale/unchanged, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetryAttempts})`,
      );
      await this.timer.sleep(delayMs);
      perf.serial(`finalObserve_retry_${attempt + 1}`);
      latestObservation = await this.observeScreen.execute({
        queryOptions: options.queryOptions,
        perf,
        skipWaitForFresh: false,
        minTimestamp,
        signal: options.signal,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
      });
      perf.end();
    }

    if (shouldRetry(latestObservation)) {
      const warning =
        minTimestamp > 0
          ? "Observation may be stale after interaction"
          : "Observation may not reflect expected visual change";
      // Spreading a possibly-undefined `freshness` used to drop the required
      // `isFresh`. When no freshness was computed at all, the honest value is
      // `false` (not confirmed fresh) — this branch only runs because the
      // observation still looks stale/unchanged after every retry.
      latestObservation.freshness = latestObservation.freshness
        ? { ...latestObservation.freshness, warning }
        : { isFresh: false, warning };
      logger.warn(`[BaseVisualChange] ${warning}`);
    }

    if (!options.deferPostActionScreenshot) {
      await this.captureTerminalObservationScreenshot(latestObservation, perf, options.signal);
    }

    if (
      options.changeExpected &&
      latestObservation.viewHierarchy &&
      previousObserveResult &&
      previousObserveResult?.viewHierarchy
    ) {
      // Don't override an explicit failure from the inner block — the action itself failed
      if (blockResult.success !== false) {
        blockResult.success =
          latestObservation.viewHierarchy !== previousObserveResult.viewHierarchy;
        if (!blockResult.success) {
          blockResult.error = "No visual change observed";
        }
      }
    } else {
      if (blockResult && "error" in blockResult && blockResult.error !== undefined) {
        blockResult.success = false;
      } else if (blockResult && !("success" in blockResult)) {
        blockResult.success = true;
      } else if (blockResult && "success" in blockResult && blockResult.success === undefined) {
        blockResult.success = true;
      }
    }

    // Add gfxMetrics to the observation if available
    if (options.gfxMetrics) {
      latestObservation.gfxMetrics = options.gfxMetrics;
    }

    // Add perf timing to the observation if enabled
    if (perf.isEnabled()) {
      const timings = perf.getTimings();
      if (timings) {
        latestObservation.perfTiming = timings;
      }
    }

    blockResult.observation = latestObservation;

    if (options.predictionContext) {
      await this.predictionAnalyzer.recordOutcomeForAction(
        previousObserveResult,
        latestObservation,
        options.predictionContext,
      );
    }

    return blockResult;
  }

  private hashViewHierarchy(viewHierarchy?: ObserveResult["viewHierarchy"]): string | null {
    if (!viewHierarchy) {
      return null;
    }
    try {
      return NodeCryptoService.generateCacheKey(JSON.stringify(viewHierarchy));
    } catch (error) {
      logger.debug(`[BaseVisualChange] Failed to hash view hierarchy: ${error}`);
      return null;
    }
  }

  private buildPredictionContext(
    context?: ObservedChangeOptions["predictionContext"],
  ): PredictionActionContext | undefined {
    if (!context) {
      return undefined;
    }

    const navigationGraph = NavigationGraphManager.getInstance();
    const appId = navigationGraph.getCurrentAppId();
    const fromScreen = navigationGraph.getCurrentScreen();

    if (!appId || !fromScreen) {
      return undefined;
    }

    return {
      appId,
      fromScreen,
      toolName: context.toolName,
      toolArgs: context.toolArgs,
    };
  }

  /**
   * Confirm that a "go home" action actually backgrounded the foreground app
   * by re-reading the foreground window and checking it against the
   * device's actually-configured HOME launcher, instead of trusting a
   * dispatch method's self-reported success (issue #6147: on API 28 the
   * accessibility global action for "home" can report success while the
   * foreground app is unchanged).
   *
   * Retries with short backoffs (via the injected `Timer`, so `FakeTimer`
   * keeps tests fast/deterministic) to tolerate the brief settle time a real
   * device needs between dispatch and the launcher taking focus.
   *
   * @param options.signal - Cancellation signal. Combined ONCE at entry with the
   *   ambient request signal (see {@link combineWithAmbientAbort}) and that
   *   combined signal is used for EVERY device read (`getActive`'s
   *   dumpsys/api-level/legacy reads and the launcher resolve) AND for the
   *   abort-classification check below. This matters on the normal MCP route
   *   where the caller passes no explicit `signal`: `getActive` combines the
   *   ambient signal internally and rejects on cancellation, so classifying the
   *   abort against the raw (undefined) `options.signal` would mis-log it as an
   *   ordinary read failure and keep sleeping/retrying. An abort rejects out of
   *   the reads and BREAKS the retry loop (it is re-thrown), so a cancelled
   *   verification never silently reports `false` as a device verdict.
   * @param options.timeoutMs - REMAINING budget for the whole verification, not a
   *   per-read budget. An absolute deadline is derived once and each `getActive`
   *   read, launcher lookup, and retry backoff spends only the time that remains,
   *   so verification cannot overrun the caller's deadline (e.g. a home press
   *   with one second left must not occupy the keyed device-input op for the
   *   full 5s `getActive` default plus launcher resolution and retries).
   * @param options.retryDelaysMs - Backoff delays between verification attempts.
   *   Defaults chosen to give a real device a couple of short chances to
   *   settle without materially slowing down a genuine failure. A backoff is
   *   skipped when it would push past the deadline.
   */
  protected async verifyAndroidHomeForeground(
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      retryDelaysMs?: readonly number[];
    } = {},
  ): Promise<boolean> {
    // Combine explicit + ambient ONCE so the reads and the abort classification
    // below observe the SAME signal (issue #6289): on the ambient-only route the
    // explicit signal is undefined, so checking it alone would miss the abort.
    const signal = combineWithAmbientAbort(options.signal);
    const { timeoutMs } = options;
    const retryDelaysMs = options.retryDelaysMs ?? [150, 300];
    // Single absolute deadline shared across reads, launcher lookup, and
    // backoffs. Never 0/negative downstream: getActive/resolve clamp to >= 1ms.
    const deadlineMs = timeoutMs !== undefined ? this.timer.now() + timeoutMs : undefined;
    const remainingMs = (): number | undefined =>
      deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    for (let attempt = 0; ; attempt++) {
      try {
        // A cancellation is surfaced by the reads themselves: getActive combines
        // the ambient signal and rejects on abort, and the catch below rethrows
        // any error while `signal.aborted`. Pre-checking `throwIfAborted()` here
        // would raise the raw AbortError before the read runs, mis-typing an
        // ambient-only cancellation instead of letting the read's own
        // OPERATION_CANCELLED rejection propagate (issue #6289).
        // Do not revive an expired verification budget by handing its zero value
        // to Window, which must clamp subcommand timeouts to keep those commands
        // bounded. No device read is valid once this operation's deadline passed.
        if ((remainingMs() ?? 1) <= 0) {
          return false;
        }
        const activeWindow = await this.window.getActive(true, undefined, {
          signal,
          timeoutMs: remainingMs(),
        });
        if ((remainingMs() ?? 1) <= 0) {
          return false;
        }
        const isLauncher = await isForegroundLauncher(
          activeWindow.appId,
          this.adb,
          this.device.deviceId,
          this.timer,
          deviceIncarnationToken(this.device.deviceId),
          signal,
          remainingMs(),
        );
        // A successful launcher lookup is evidence only while it remains within
        // the caller's deadline; a fast cached lookup must not accept success
        // after a preceding foreground read spent the budget.
        if (isLauncher && (remainingMs() ?? 1) > 0) {
          return true;
        }
      } catch (error) {
        // A cancellation must not be masked as "not the launcher": rethrow so the
        // caller sees the abort rather than a false failure verdict.
        if (signal?.aborted) {
          throw error;
        }
        logger.warn(
          `[BaseVisualChange] Failed to read foreground app while verifying home press: ${errorMessage(error)}`,
          error,
        );
      }
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        return false;
      }
      // Don't sleep past the shared deadline: a backoff that would overrun the
      // remaining budget ends verification now instead of stalling the keyed op.
      const remaining = remainingMs();
      if (remaining !== undefined && remaining <= delay) {
        return false;
      }
      await this.timer.sleep(delay);
    }
  }
}
