import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AwaitIdle } from "../observe/AwaitIdle";
import { RealObserveScreen } from "../observe/ObserveScreen";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { Window } from "../observe/Window";
import { logger } from "../../utils/logger";
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
import { NavigationGraphManager } from "../navigation/NavigationGraphManager";
import { PredictionAnalyzer, PredictionActionContext } from "../observe/PredictionAnalyzer";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { sequenceBackoff } from "../../utils/Backoff";
import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";

export interface ProgressCallback {
  (progress: number, total?: number, message?: string): Promise<void>;
}

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
  protected timer: Timer;

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
    this.window = new Window(device, this.adbFactory);
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
      predictionContext,
      signal: options.signal,
    });
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

  /**
   * True when a live-view IDE subscriber is attached for this device, meaning a
   * device screenshot is still worth capturing on internal re-observes.
   */
  private hasLiveViewSubscriber(): boolean {
    return getDeviceDataStreamServer()?.hasSubscriberForDevice(this.device.deviceId) ?? false;
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
    },
  ): Promise<any> {
    const perf = options.perf ?? new NoOpPerformanceTracker();

    // Use actionStartTime as minTimestamp to ensure we get data captured after the action
    // This prevents returning stale cached data from before the action was executed
    const minTimestamp = options.actionStartTime ?? 0;
    const retryBackoff = sequenceBackoff([50, 100, 200, 400]);
    const maxRetryAttempts = 4;
    const previousHash = this.hashViewHierarchy(previousObserveResult?.viewHierarchy);

    // Internal post-action re-observes don't need a device screenshot: the PNG is
    // only consumed by a live-view subscriber (fed separately by the
    // subscriber-gated screenshot stream) or by tools that return the image.
    // Skipping the capture here avoids a device round-trip per action, but stays
    // enabled while a live view is attached (#5472, AC#3).
    const skipScreenshot = !this.hasLiveViewSubscriber();

    perf.serial("finalObserve");
    // Wait for fresh data from accessibility service (skipWaitForFresh=false)
    // This ensures we get observation data that reflects the action that just completed
    let latestObservation = await this.observeScreen.execute({
      queryOptions: options.queryOptions,
      perf,
      skipWaitForFresh: false,
      minTimestamp,
      signal: options.signal,
      skipScreenshot,
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
        skipScreenshot,
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
}
