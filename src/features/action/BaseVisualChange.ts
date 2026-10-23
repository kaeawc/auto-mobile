import {
  captureStabilityWindow,
  resolveObservationStartTime,
  resolvePackageName,
} from "./visualChangeObservationContext";
import { getActionClockSkewCache, type ActionClockSkewProvider } from "./ActionClockSkewCache";
import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";
import { ActionableError, BootedDevice, GfxMetrics, ObserveResult } from "../../models";
import type { BaseActionResult } from "../../models/BaseActionResult";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import type { TapEffect } from "../../models/TapOnElementResult";
import { ViewHierarchyQueryOptions } from "../../models/ViewHierarchyQueryOptions";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DEFAULT_FUZZY_MATCH_TOLERANCE_PERCENT } from "../../utils/constants";
import { errorMessage } from "../../utils/describeUnknownError";
import { hierarchyChanged, hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import { logger } from "../../utils/logger";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import {
  beginPostActionCaptureAction,
  deferTerminalScreenshot,
} from "../../utils/PostActionCaptureContext";
import { serverConfig } from "../../utils/ServerConfig";
import { defaultTimer, Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import {
  resolveNavigationGraphForDevice,
  type NavigationGraphResolver,
} from "../navigation/deviceNavigationGraph";
import { AndroidCtrlProxyClient } from "../observe/android";
import {
  resolveScreenshotMode,
  shouldSkipActionObservationScreenshot,
} from "../observe/automaticScreenshotPolicy";
import { AwaitIdle as RealAwaitIdle } from "../observe/AwaitIdle";
import {
  completeWindowResolutionRead,
  pendingWindowResolutionGeneration,
} from "../observe/cache/ObserveCacheRegistry";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "../observe/DeviceHierarchyCapture";
import {
  DefaultDeviceWindowCacheInvalidator,
  type DeviceWindowCacheInvalidator,
} from "../observe/DeviceWindowCacheInvalidator";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import type { AwaitIdle, UiStabilityState } from "../observe/interfaces/AwaitIdle";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../observe/interfaces/ObserveScreen";
import type { Window } from "../observe/interfaces/Window";
import { IOSCtrlProxyClient } from "../observe/ios";
import { isAdoptableCapture } from "../observe/isAdoptableCapture";
import { hasWrongWindowEvidence } from "../observe/observationFreshness";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { hierarchyUpdatedAtToMillis } from "../observe/observeTimestamp";
import { PredictionActionContext, PredictionAnalyzer } from "../observe/PredictionAnalyzer";
import { RealSettleObserve } from "../observe/SettleObserve";
import { staleDisplayError } from "../observe/StaleDisplayError";
import { Window as RealWindow } from "../observe/Window";
import { HomeForegroundVerifier, type HomeForegroundVerifyOptions } from "./HomeForegroundVerifier";
import { compareActiveWindow, deriveInteractionEffect } from "./interactionEffect";
import { MissingViewHierarchyError } from "./MissingViewHierarchyError";
import {
  applySuccessVerdict,
  asObservedResult,
  attachTelemetry,
  hasUsableHierarchy,
  observationNeedsRetry,
  warnStillStale,
} from "./observedInteractionStages";
import type {
  ObservedActionResult,
  ObservedChangeOptions,
  ObservedEnvelope,
} from "./observedInteractionTypes";
import { buildDeviceLockWarning, buildPredictionActionContext } from "./postActionAnnotations";
import { PostActionObservationReader } from "./PostActionObservationReader";
import { withForwardDeliveredNote } from "./swipeon/boomerangReturnLeg";
import {
  CallerFenceState,
  COORDINATE_ACTIONS,
  DisplayFence,
  DisplayFenceDependencies,
  INTERMEDIATE_OBSERVATION_OPTIONS,
  PostActionCapture,
  RenderedDisplayRevisionReader,
  sessionRenderedDisplayGeneration,
  sessionRenderedDisplayRevision,
} from "./visualChangeDisplayFence";
export {
  type DisplayFence,
  type DisplayFenceDependencies,
  type DisplayFenceOption,
  FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS,
  FINAL_OBSERVATION_RETRY_BACKOFF_MS,
  INTERMEDIATE_OBSERVATION_OPTIONS,
  type ProgressCallback,
  type RenderedDisplayRevisionReader,
  resolveDisplayFence,
  sessionRenderedDisplayGeneration,
} from "./visualChangeDisplayFence";
export type { ObservedActionResult, ObservedChangeOptions, ObservedEnvelope };

export class BaseVisualChange {
  /** Missing freshness remains compatible unless an internal caller requires verification. */
  static shouldRefetchCachedObservation(cached: ObserveResult, requireVerified = false): boolean {
    return requireVerified
      ? cached.freshness?.isFresh !== true
      : cached.freshness?.isFresh === false;
  }

  windowCacheInvalidator: DeviceWindowCacheInvalidator = new DefaultDeviceWindowCacheInvalidator();

  actionClockSkewCache: ActionClockSkewProvider;

  /** Selects the navigation graph this device records on; a seam for tests (#10197). */
  navigationGraphResolver: NavigationGraphResolver = resolveNavigationGraphForDevice;

  device: BootedDevice;
  adb: AdbExecutor;
  protected adbFactory: AdbClientFactory;
  awaitIdle: AwaitIdle;
  observeScreen: ObserveScreen;
  window: Window;
  private predictionAnalyzer: Pick<PredictionAnalyzer, "recordOutcomeForAction">;
  private deferredPredictionOutcomes = new WeakMap<
    object,
    (observation: ObserveResult) => Promise<void>
  >();
  protected timer: Timer;
  protected readonly displayTransitionReader: DisplayTransitionReader;
  protected readonly renderedDisplayGeneration: RenderedDisplayRevisionReader;
  protected readonly renderedDisplayRevision: RenderedDisplayRevisionReader;

  protected shouldCapturePostActionScreenshot(): boolean {
    // Preserve the pre-existing live-view behavior, while allowing other
    // clients to opt in with AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT=0.
    return (
      resolveScreenshotMode() === "settled" ||
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
    renderedDisplayRevision: RenderedDisplayRevisionReader = sessionRenderedDisplayRevision,
    displayFence: DisplayFenceDependencies = {},
  ) {
    this.actionClockSkewCache = getActionClockSkewCache(timer, displayFence.actionClockSkewCache);
    this.device = device;
    const { adbFactory, adb } = BaseVisualChange.resolveAdb(device, adbFactoryOrExecutor);
    this.adbFactory = adbFactory;
    this.adb = adb;
    // Same clock as this instance: its gfxinfo stability polls must not spend real
    // wall-clock under an injected FakeTimer.
    this.awaitIdle = displayFence.awaitIdle ?? new RealAwaitIdle(device, this.adbFactory, timer);
    // Honor the observer seam before constructing defaults: RealObserveScreen's
    // screenshot service starts host filesystem work and retention timers.
    this.observeScreen =
      displayFence.observeScreen ?? new RealObserveScreen(device, this.adbFactory);
    // Forward the injected clock so the internal Window shares this instance's
    // timer: home-verification derives its outer deadline from `this.timer`, and
    // Window derives the per-subread budgets from ITS timer — they must be the
    // same clock or a FakeTimer's elapsed time won't shrink the ADB sub-read
    // budgets in the integrated path (issue #6289).
    this.window = displayFence.window ?? new RealWindow(device, this.adbFactory, timer);
    this.predictionAnalyzer = displayFence.predictionAnalyzer ?? new PredictionAnalyzer();
    this.timer = timer;
    this.renderedDisplayRevision = displayFence.renderedDisplayRevision ?? renderedDisplayRevision;
    this.displayTransitionReader = displayFence.displayTransitions ?? displayTransitions;
    this.renderedDisplayGeneration =
      displayFence.renderedDisplayGeneration ?? sessionRenderedDisplayGeneration;
  }

  private static resolveAdb(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null,
  ): { adbFactory: AdbClientFactory; adb: AdbExecutor } {
    // Detect if the argument is a factory (has create method) or an executor
    if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      const adbFactory = adbFactoryOrExecutor as AdbClientFactory;
      return { adbFactory, adb: adbFactory.create(device) };
    }
    if (adbFactoryOrExecutor) {
      // Legacy path: wrap the executor in a factory for downstream dependencies
      const executor = adbFactoryOrExecutor as AdbExecutor;
      return { adbFactory: { create: () => executor }, adb: executor };
    }
    return { adbFactory: defaultAdbClientFactory, adb: defaultAdbClientFactory.create(device) };
  }

  protected staleDisplay(observedGeneration: number) {
    return staleDisplayError(
      observedGeneration,
      this.displayTransitionReader.identityRevision(this.device.deviceId),
      this.displayTransitionReader.currentObservedPanel(this.device.deviceId)?.key,
    );
  }

  protected captureDisplayFence(resolvedGeneration?: number): DisplayFence {
    const deviceId = this.device.deviceId;
    const currentRevision = () =>
      this.device.platform === "ios"
        ? this.displayTransitionReader.identityRevision(deviceId)
        : this.displayTransitionReader.revision(deviceId);
    const revision = currentRevision();
    const observedGeneration =
      resolvedGeneration ??
      this.renderedDisplayGeneration(deviceId) ??
      this.displayTransitionReader.identityRevision(deviceId);
    return {
      assertCurrent: () => {
        if (currentRevision() !== revision) {
          throw this.staleDisplay(observedGeneration);
        }
      },
    };
  }

  /**
   * Execute a block of code and wait for UI to stabilize with optional observation
   * @param block - Block of code to execute which should have a visual change.
   * @param options - Options controlling observation behavior
   */
  async observedInteraction<R extends ObservedActionResult>(
    block: (
      observeResult: ObserveResult,
      fence?: DisplayFence,
    ) => Promise<R | ObservedActionResult>,
    options: ObservedChangeOptions,
  ): Promise<R & ObservedEnvelope> {
    if (!options.observePartialApplication) {
      return this.runObservedInteraction(block, options);
    }
    // A partial result carries "the forward swipe was delivered"; a cancel during the observation
    // that follows must keep that note instead of reading as a plain cancellation.
    let partiallyApplied = false;
    try {
      return await this.runObservedInteraction(async (observeResult, fence) => {
        const result = await block(observeResult, fence);
        partiallyApplied = result?.success === false && result.partialApplication === true;
        return result;
      }, options);
    } catch (error) {
      throw partiallyApplied && options.signal?.aborted ? withForwardDeliveredNote(error) : error;
    }
  }

  private async runObservedInteraction<R extends ObservedActionResult>(
    block: (
      observeResult: ObserveResult,
      fence?: DisplayFence,
    ) => Promise<R | ObservedActionResult>,
    options: ObservedChangeOptions,
  ): Promise<R & ObservedEnvelope> {
    // Stages: fence -> pre-read -> run -> post-read.
    await beginPostActionCaptureAction();
    const timeoutMs = options.timeoutMs || 12000;
    const perf = options.perf ?? new NoOpPerformanceTracker();
    const state = this.captureCallerFenceState(options);

    if (options.progress) {
      await options.progress(0, 100, "Preparing to execute action...");
    }
    throwIfAborted(options.signal);

    const previousObserveResult = await this.resolvePreviousObservation(options, perf, state);
    const predictionContext = buildPredictionActionContext(options.predictionContext, () =>
      this.navigationGraphResolver(this.device),
    );
    const coordinateAction = this.reconcileDisplayAfterRead(options, state, previousObserveResult);

    // Start the cache snapshot now; consume it after dispatch so optional stability adds no
    // pre-gesture await (including actions that skip the stability wait entirely).
    const beforeWindowRead = captureStabilityWindow(this.window, this.device, options);
    const { actionStartTime, clockSkewMs } = await this.readActionClock(perf);
    const blockResult = await this.runBlock(
      block,
      previousObserveResult,
      state,
      options,
      perf,
      coordinateAction,
    );
    if (this.isUnconfirmedIosFailure(blockResult, options)) {
      perf.end();
      // Returned before any post-action read, so `observation` is absent (see ObservedEnvelope).
      return asObservedResult<R>(blockResult);
    }
    this.invalidateCtrlProxyCacheForDisplay(options);

    const observationStartTime = resolveObservationStartTime(options, actionStartTime, clockSkewMs);
    const packageName = await resolvePackageName(
      this.window,
      options,
      previousObserveResult,
      await beforeWindowRead,
      timeoutMs,
    );
    const gfxMetrics = await this.awaitUiStability(options, packageName, timeoutMs, perf);

    const observed = await this.takeObservation(blockResult, previousObserveResult, {
      changeExpected: options.changeExpected,
      display: options.display,
      postActionObserveScreen: options.postActionObserveScreen,
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
    if (options.display !== undefined) {
      observed.effect = this.deriveInteractionEffect(previousObserveResult, observed.observation);
    }
    this.annotateDeviceLock(observed, previousObserveResult);
    return observed;
  }

  private actionDisplayRevision(): number {
    return this.displayTransitionReader.identityRevision(this.device.deviceId);
  }

  /** Fence stage: capture the action-start display identity and reject a stale caller stamp. */
  private captureCallerFenceState(options: ObservedChangeOptions): CallerFenceState {
    const displayRevision = this.actionDisplayRevision();
    // Without a stored caller stamp, in-flight fences use the action-start identity generation.
    const observedGeneration =
      this.renderedDisplayGeneration(this.device.deviceId) ?? displayRevision;
    // An unscoped selector action re-reads the display instead of trusting a caller stamp; an
    // in-call read it passes in is checked against the current revision below.
    const reresolvesTarget =
      options.resolvesTargetFromRead === true &&
      options.display === undefined &&
      !options.skipPreviousObserve;
    const state: CallerFenceState = {
      displayRevision,
      fence: this.captureDisplayFence(),
      observedGeneration,
      reresolvesTarget,
      refreshForDisplayChange: false,
    };
    if (this.callerDisplayStampIsStale(options)) {
      if (!reresolvesTarget) {
        throw this.staleDisplay(observedGeneration);
      }
      state.refreshForDisplayChange = true;
    }
    return state;
  }

  private callerDisplayStampIsStale(options: ObservedChangeOptions): boolean {
    const callerDisplayRevision = this.renderedDisplayRevision(this.device.deviceId);
    if (
      options.skipCallerDisplayFence ||
      !COORDINATE_ACTIONS.has(options.predictionContext?.toolName ?? "") ||
      callerDisplayRevision === undefined
    ) {
      return false;
    }
    return this.device.platform === "ios"
      ? !this.displayTransitionReader.sameIdentitySince(this.device.deviceId, callerDisplayRevision)
      : callerDisplayRevision !== this.displayTransitionReader.revision(this.device.deviceId);
  }

  /** Pre-read stage: the hierarchy the block resolves against (never null unless skipped). */
  private async resolvePreviousObservation(
    options: ObservedChangeOptions,
    perf: PerformanceTracker,
    state: CallerFenceState,
  ): Promise<ObserveResult | null> {
    if (options.skipPreviousObserve) {
      logger.info("[BaseVisualChange] Skipping previous observe (app was terminated/cleared)");
      return options.previousObservation ?? null;
    }
    if (options.previousObservation) {
      return options.previousObservation;
    }
    const previous = await this.readFreshPreviousObservation(
      options,
      perf,
      state.refreshForDisplayChange,
    );
    if (options.usesObservationForResolution !== false && hasWrongWindowEvidence(previous)) {
      throw new ActionableError(
        `Cannot resolve elements against a wrong-window hierarchy: ${previous.freshness?.warning ?? "The refreshed observation still belongs to another window"}`,
      );
    }
    return previous;
  }

  private async readFreshPreviousObservation(
    options: ObservedChangeOptions,
    perf: PerformanceTracker,
    refreshForDisplayChange: boolean,
  ): Promise<ObserveResult> {
    const resolvesFromObservation = options.usesObservationForResolution !== false;
    const resolutionGeneration = resolvesFromObservation
      ? pendingWindowResolutionGeneration(this.device.deviceId)
      : undefined;
    // A pending window resolution or a caller-stale display needs one fresh read.
    const requiresFreshRead = refreshForDisplayChange || resolutionGeneration !== undefined;
    const evidence = { knownWrongWindow: resolutionGeneration !== undefined };
    let previous: ObserveResult | undefined;
    try {
      await options.progress?.(10, 100, "Getting previous view hierarchy...");
      previous = await perf.track("getPreviousObserve", () =>
        this.readCachedOrFreshPrevious(options, perf, requiresFreshRead, evidence),
      );
    } catch (error) {
      if (evidence.knownWrongWindow && resolvesFromObservation) {
        throw new MissingViewHierarchyError({ cause: error });
      }
      logger.warn(`Previous observation failed: ${errorMessage(error)}`, error);
      previous = await this.readPreviousFallback(options, perf);
    }
    BaseVisualChange.assertUsablePrevious(
      previous,
      evidence.knownWrongWindow && resolvesFromObservation,
    );
    this.completeResolutionRead(previous, resolutionGeneration);
    return previous;
  }

  /** A missing read, or an unusable hierarchy known to be the wrong window, cannot resolve targets. */
  private static assertUsablePrevious(
    previous: ObserveResult | undefined,
    wrongWindowMatters: boolean,
  ): asserts previous is ObserveResult {
    if (!previous) {
      throw new MissingViewHierarchyError();
    }
    if (wrongWindowMatters && (!previous.viewHierarchy || previous.viewHierarchy.hierarchy.error)) {
      throw new MissingViewHierarchyError();
    }
  }

  private completeResolutionRead(
    previous: ObserveResult,
    resolutionGeneration: number | undefined,
  ): void {
    if (resolutionGeneration !== undefined && !hasWrongWindowEvidence(previous)) {
      completeWindowResolutionRead(this.device.deviceId, resolutionGeneration);
    }
  }

  private readPreviousFallback(
    options: ObservedChangeOptions,
    perf: PerformanceTracker,
  ): Promise<ObserveResult> {
    return perf.track("getPreviousObserveFallback", () =>
      this.observeScreen.execute(
        this.previousObserveOptions(
          options,
          perf,
          options.skipCallerDisplayFence ? "fresh" : "cached-ok",
        ),
      ),
    );
  }

  private async readCachedOrFreshPrevious(
    options: ObservedChangeOptions,
    perf: PerformanceTracker,
    requiresFreshRead: boolean,
    evidence: { knownWrongWindow: boolean },
  ): Promise<ObserveResult> {
    const cached = options.display
      ? undefined
      : await this.observeScreen.getMostRecentCachedObserveResult();
    evidence.knownWrongWindow ||= hasWrongWindowEvidence(cached);
    // Preserve the missing/errored-cache fallback; a rejected usable cache
    // must instead get exactly one fresh read before any action is dispatched.
    const usableCached = Boolean(cached?.viewHierarchy && !cached.viewHierarchy.hierarchy.error);
    const staleCachedRefetch =
      requiresFreshRead ||
      (usableCached && BaseVisualChange.shouldRefetchCachedObservation(cached!));
    if (
      !usableCached ||
      staleCachedRefetch ||
      BaseVisualChange.shouldRefetchCachedObservation(cached!, options.skipCallerDisplayFence)
    ) {
      return this.observeScreen.execute(
        this.previousObserveOptions(
          options,
          perf,
          staleCachedRefetch || options.skipCallerDisplayFence ? "fresh" : "cached-ok",
        ),
      );
    }
    return cached!;
  }

  private previousObserveOptions(
    options: ObservedChangeOptions,
    perf: PerformanceTracker,
    freshness: "fresh" | "cached-ok",
  ): Parameters<ObserveScreen["execute"]>[0] {
    return {
      ...INTERMEDIATE_OBSERVATION_OPTIONS,
      freshness,
      timeoutMs: DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
      skipStaleWindowRecovery: true,
      display: options.display,
      queryOptions: options.queryOptions,
      perf,
      signal: options.signal,
    };
  }

  /**
   * Fence stage after the pre-read: a selector action adopts the new display generation when
   * the read was recorded at the current revision; a coordinate action on a moved display is
   * rejected. Returns whether this is a coordinate action.
   */
  private reconcileDisplayAfterRead(
    options: ObservedChangeOptions,
    state: CallerFenceState,
    previous: ObserveResult | null,
  ): boolean {
    const coordinateAction = COORDINATE_ACTIONS.has(options.predictionContext?.toolName ?? "");
    const displayMoved = (): boolean =>
      state.refreshForDisplayChange || this.actionDisplayRevision() !== state.displayRevision;
    if (
      state.reresolvesTarget &&
      displayMoved() &&
      previous?.displayRevision !== undefined &&
      previous.displayRevision === this.displayTransitionReader.revision(this.device.deviceId)
    ) {
      // The pre-action read was recorded at the current display revision, so the selector
      // resolves against the new generation; later transitions are still fenced from here.
      state.displayRevision = this.actionDisplayRevision();
      state.observedGeneration = this.displayTransitionReader.identityRevision(
        this.device.deviceId,
      );
      state.fence = this.captureDisplayFence(state.observedGeneration);
      state.refreshForDisplayChange = false;
    }
    if (coordinateAction && displayMoved()) {
      throw this.staleDisplay(state.observedGeneration);
    }
    return coordinateAction;
  }

  /** Record the action start time (device time if available) to ensure fresh data. */
  private async readActionClock(
    perf: PerformanceTracker,
  ): Promise<{ actionStartTime: number; clockSkewMs: number }> {
    return perf.track("getActionStartTime", async () => {
      let clockSkewMs = 0;
      if (
        this.device.platform === "android" &&
        typeof this.adb.getDeviceTimestampMs === "function"
      ) {
        clockSkewMs =
          (await this.actionClockSkewCache.getSkewMs(this.device.deviceId, () =>
            typeof this.adb.getDeviceTimestampMsWithSource === "function"
              ? this.adb.getDeviceTimestampMsWithSource()
              : this.adb.getDeviceTimestampMs(),
          )) ?? 0;
      }
      return { actionStartTime: this.timer.now() + clockSkewMs, clockSkewMs };
    });
  }

  /** Run stage: dispatch the block against the pre-read, fenced against display changes. */
  private runBlock<R extends ObservedActionResult>(
    block: (
      observeResult: ObserveResult,
      fence?: DisplayFence,
    ) => Promise<R | ObservedActionResult>,
    previous: ObserveResult | null,
    state: CallerFenceState,
    options: ObservedChangeOptions,
    perf: PerformanceTracker,
    coordinateAction: boolean,
  ): Promise<R | ObservedActionResult> {
    return perf.track("executeBlock", async () => {
      throwIfAborted(options.signal);
      if (coordinateAction && this.actionDisplayRevision() !== state.displayRevision) {
        throw this.staleDisplay(state.observedGeneration);
      }
      try {
        return await block(previous!, state.fence);
      } finally {
        if (options.foregroundAppMayChange) {
          this.windowCacheInvalidator.invalidate(this.device, true);
        }
      }
    });
  }

  /**
   * Unconfirmed iOS text must return before post-action reads consume the response margin or
   * replace its non-retryable result with cancellation.
   */
  private isUnconfirmedIosFailure(
    blockResult: ObservedActionResult,
    options: ObservedChangeOptions,
  ): boolean {
    return (
      this.device.platform === "ios" &&
      blockResult?.success === false &&
      blockResult.retryable === false &&
      !(options.observePartialApplication && blockResult.partialApplication === true)
    );
  }

  private invalidateCtrlProxyCacheForDisplay(options: ObservedChangeOptions): void {
    if (options.display === undefined) {
      return;
    }
    // ADB input bypasses CtrlProxy's gesture debouncer. Clear its tree before
    // the shared post-action capture; this also works with CtrlProxy dispatch.
    if (this.device.platform === "android") {
      AndroidCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
    } else if (this.device.platform === "ios") {
      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
    }
    throwIfAborted(options.signal);
  }

  /** Android-only gfxinfo stability wait; null when skipped or unavailable. */
  private async awaitUiStability(
    options: ObservedChangeOptions,
    packageName: string | undefined,
    timeoutMs: number,
    perf: PerformanceTracker,
  ): Promise<GfxMetrics | null> {
    if (options.skipUiStability) {
      logger.info("[BaseVisualChange] Skipping UI stability tracking (skipUiStability=true)");
      return null;
    }
    if (this.device.platform !== "android") {
      logger.debug("[BaseVisualChange] Skipping UI stability tracking (gfxinfo is Android-only)");
      return null;
    }
    if (!packageName) {
      return null;
    }
    logger.info(
      `[BaseVisualChange] Starting UI stability initialization with package: ${packageName}`,
    );
    const initState: UiStabilityState | null = await perf
      .track("initUiStability", async () => {
        return this.awaitIdle.initializeUiStabilityTracking(packageName, timeoutMs, options.signal);
      })
      .catch((error) => {
        throwIfAborted(options.signal);
        logger.debug(`[BaseVisualChange] UI stability initialization failed: ${error}`);
        return null;
      });
    if (packageName.trim() === "") {
      return null;
    }
    perf.serial("uiStability");
    const gfxMetrics =
      initState !== null
        ? await this.awaitIdle.waitForUiStabilityWithState(
            packageName,
            timeoutMs,
            initState,
            perf,
            options.signal,
          )
        : await this.awaitIdle.waitForUiStability(packageName, timeoutMs, perf, options.signal);
    perf.end();
    return gfxMetrics;
  }

  /**
   * Flag when an interaction ran against a locked Android keyguard (#4280).
   *
   * The gesture is deliberately NOT blocked — a swipe-to-dismiss or a PIN-digit
   * tap is exactly how an agent recovers — but the result must never read as a
   * clean success when it likely never reached the app. We attach the pre-action
   * lock state (so an agent can branch on `secure`) plus a human-readable
   * warning. This warning applies only to Android interactions.
   */
  protected annotateDeviceLock(
    result: ObservedEnvelope,
    previousObserveResult: ObserveResult | null,
  ): void {
    if (!result || this.device.platform !== "android") {
      return;
    }
    const lock = previousObserveResult?.deviceLock;
    if (!lock?.locked) {
      return;
    }
    delete result.deviceLockUnknown;
    result.deviceLock = lock;
    result.deviceLockWarning = buildDeviceLockWarning(lock);
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
      if (
        this.observeScreen.captureScreenshot &&
        deferTerminalScreenshot(observation, async (chosen, requestSignal) => {
          await this.observeScreen.captureScreenshot?.(perf, requestSignal ?? signal, chosen);
        })
      ) {
        return;
      }
      await this.observeScreen.captureScreenshot?.(perf, signal, observation);
      return;
    }
    await this.observeScreen.runAccessibilityAudit?.(observation, perf);
  }

  protected compareActiveWindow(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
  ): TapEffect | undefined {
    return compareActiveWindow(previousObservation, currentObservation);
  }

  protected deriveInteractionEffect(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult | undefined,
  ): TapEffect | undefined {
    return deriveInteractionEffect(previousObservation, currentObservation);
  }
  private capturePostActionObservation(
    observeScreen: ObserveScreen,
    options: ObserveScreenExecuteOptions,
    shouldRetry: (observation: ObserveResult) => boolean,
    blockResult: { success?: boolean; skipped?: unknown; wasAlreadyFocused?: boolean },
  ): Promise<PostActionCapture> {
    return new PostActionObservationReader(this.timer).capturePostActionObservation(
      observeScreen,
      options,
      shouldRetry,
      blockResult,
    );
  }

  private notePostActionReadFailure(
    observation: ObserveResult,
    phase: string,
    reason: string,
    error?: unknown,
  ): PostActionCapture {
    return new PostActionObservationReader(this.timer).notePostActionReadFailure(
      observation,
      phase,
      reason,
      error,
    );
  }

  protected rethrowObservationAbort(error: unknown, signal?: AbortSignal, enabled = true): void {
    if (!enabled) {
      return;
    }
    throwIfAborted(signal);
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
  }

  /** Validate a completed gesture without turning its capture into a retryable refusal. */
  protected checkPostActionDisplay(
    result: Pick<BaseActionResult, "observation" | "staleDisplay">,
    assertCurrent: (() => void) | undefined,
    signal?: AbortSignal,
  ): boolean {
    try {
      assertCurrent?.();
      return true;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (
        !result.observation ||
        !isAdoptableCapture(result.observation, result.observation, true)
      ) {
        throw new DispatchedObservationError(error);
      }
      const failed = this.notePostActionReadFailure(
        result.observation,
        "display settle validation",
        errorMessage(error),
        error,
      );
      result.observation = failed.observation;
      result.staleDisplay = failed.staleDisplay ?? result.staleDisplay;
      return false;
    }
  }

  private async settleDisplayObservation(
    observation: ObserveResult,
    observeScreen: ObserveScreen,
    options: { display: string; signal?: AbortSignal },
  ): Promise<PostActionCapture> {
    try {
      const settled = await new RealSettleObserve(observeScreen, this.timer).execute({
        ...options,
        initialMinTimestampMs: hierarchyUpdatedAtToMillis(observation.viewHierarchy),
        skipPerformanceAudit: true,
        skipRecompositionTracking: true,
      });
      throwIfAborted(options.signal);
      return isAdoptableCapture(observation, settled.observation, true)
        ? { observation: settled.observation, readFailed: false }
        : this.notePostActionReadFailure(
            observation,
            "display settle",
            "unusable settle capture",
            this.staleDisplay(
              observation.display.generation ??
                this.displayTransitionReader.identityRevision(this.device.deviceId),
            ),
          );
    } catch (error) {
      throwIfAborted(options.signal);
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      return this.notePostActionReadFailure(
        observation,
        "display settle",
        errorMessage(error),
        error,
      );
    }
  }

  private async finalizePostActionCapture(
    captured: PostActionCapture,
    options: { display?: string; signal?: AbortSignal; perf: PerformanceTracker },
  ): Promise<PostActionCapture> {
    try {
      await this.captureTerminalObservationScreenshot(
        captured.observation,
        options.perf,
        options.signal,
      );
      return captured;
    } catch (error) {
      if (options.display === undefined) {
        throw error;
      }
      this.rethrowObservationAbort(error, options.signal);
      const failed = this.notePostActionReadFailure(
        captured.observation,
        "terminal screenshot/audit",
        errorMessage(error),
        error,
      );
      return { ...failed, staleDisplay: failed.staleDisplay ?? captured.staleDisplay };
    }
  }

  /** Settle a non-default display, then finalize the terminal screenshot unless deferred. */
  private async refineCapture(
    initial: PostActionCapture,
    observeScreen: ObserveScreen,
    options: {
      display?: string;
      signal?: AbortSignal;
      deferPostActionScreenshot?: boolean;
    },
    perf: PerformanceTracker,
  ): Promise<PostActionCapture> {
    let captured = initial;
    if (
      options.display !== undefined &&
      !captured.readFailed &&
      hasUsableHierarchy(captured.observation)
    ) {
      captured = await this.settleDisplayObservation(captured.observation, observeScreen, {
        display: options.display,
        signal: options.signal,
      });
    }
    if (!options.deferPostActionScreenshot) {
      captured = await this.finalizePostActionCapture(captured, { ...options, perf });
    }
    return captured;
  }

  private async takeObservation<R extends ObservedActionResult>(
    blockResult: R | ObservedActionResult,
    previousObserveResult: ObserveResult | null,
    options: {
      changeExpected: boolean;
      display?: string;
      postActionObserveScreen?: ObserveScreen;
      tolerancePercent?: number;
      queryOptions?: ViewHierarchyQueryOptions;
      gfxMetrics?: GfxMetrics | null;
      perf?: PerformanceTracker;
      actionStartTime?: number;
      predictionContext?: PredictionActionContext;
      signal?: AbortSignal;
      deferPostActionScreenshot?: boolean;
    },
  ): Promise<R & ObservedEnvelope> {
    const perf = options.perf ?? new NoOpPerformanceTracker();
    const observeScreen = options.postActionObserveScreen ?? this.observeScreen;

    // Use actionStartTime as minTimestamp to ensure we get data captured after the action
    // This prevents returning stale cached data from before the action was executed
    const minTimestamp = options.actionStartTime ?? 0;
    const previousHash = hierarchyFingerprint(previousObserveResult?.viewHierarchy);

    const shouldRetry = (observation: ObserveResult): boolean =>
      observationNeedsRetry(observation, minTimestamp, options.changeExpected, previousHash);

    let captured = await this.capturePostActionObservation(
      observeScreen,
      {
        freshness: "fresh",
        display: options.display,
        queryOptions: options.queryOptions,
        perf,
        minTimestamp,
        signal: options.signal,
        ...INTERMEDIATE_OBSERVATION_OPTIONS,
      },
      shouldRetry,
      blockResult,
    );
    if (!captured.readFailed && shouldRetry(captured.observation)) {
      warnStillStale(captured.observation, minTimestamp);
    }
    captured = await this.refineCapture(captured, observeScreen, options, perf);
    const latestObservation = captured.observation;
    // The same object the block returned, which the pipeline fills in below.
    const mutable: ObservedActionResult & ObservedEnvelope = blockResult;
    if (captured.staleDisplay) {
      mutable.staleDisplay = captured.staleDisplay;
    }

    // Compare content fingerprints, not object identity: every observe returns a
    // fresh ViewHierarchyResult, so `!==` was always true (issue #6435).
    const visualChange = options.changeExpected
      ? hierarchyChanged(previousObserveResult?.viewHierarchy, latestObservation.viewHierarchy)
      : null;
    applySuccessVerdict(mutable, visualChange);
    attachTelemetry(latestObservation, options.gfxMetrics, perf);

    mutable.observation = latestObservation;

    if (options.predictionContext) {
      await this.predictionAnalyzer.recordOutcomeForAction(
        previousObserveResult,
        latestObservation,
        options.predictionContext,
      );
    }

    // Same object as the block returned (see asObservedResult for why `R` is trusted).
    return asObservedResult<R>(mutable);
  }

  /**
   * Confirm that a "go home" action actually backgrounded the foreground app by checking it
   * against the device's configured HOME launcher (issue #6147). See
   * {@link HomeForegroundVerifier.verify} for the retry, deadline and cancellation contract.
   */
  protected async verifyAndroidHomeForeground(
    options: HomeForegroundVerifyOptions = {},
  ): Promise<boolean> {
    return new HomeForegroundVerifier({
      window: this.window,
      adb: this.adb,
      deviceId: this.device.deviceId,
      timer: this.timer,
    }).verify(options);
  }
}
