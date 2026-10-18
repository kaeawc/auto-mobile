import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  applySuccessVerdict,
  attachTelemetry,
  hasUsableHierarchy,
  observationNeedsRetry,
  warnStillStale,
} from "./observedInteractionStages";
import { MissingViewHierarchyError } from "./MissingViewHierarchyError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { hierarchyUpdatedAtToMillis } from "../observe/observeTimestamp";
import { RealSettleObserve } from "../observe/SettleObserve";
import type { TapEffect } from "../../models/TapOnElementResult";
import { AwaitIdle as RealAwaitIdle } from "../observe/AwaitIdle";
import type { AwaitIdle, UiStabilityState } from "../observe/interfaces/AwaitIdle";
import type {
  ObservedActionResult,
  ObservedChangeOptions,
  ObservedEnvelope,
} from "./observedInteractionTypes";
export type { ObservedActionResult, ObservedChangeOptions, ObservedEnvelope };
import { RealObserveScreen } from "../observe/ObserveScreen";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "../observe/DeviceHierarchyCapture";
import { hasWrongWindowEvidence } from "../observe/observationFreshness";
import {
  pendingWindowResolutionGeneration,
  completeWindowResolutionRead,
} from "../observe/cache/ObserveCacheRegistry";
import {
  DefaultDeviceWindowCacheInvalidator,
  type DeviceWindowCacheInvalidator,
} from "../observe/DeviceWindowCacheInvalidator";
import {
  staleDisplayError,
  StaleDisplayError,
  type StaleDisplayDetails,
} from "../observe/StaleDisplayError";
import type { BaseActionResult } from "../../models/BaseActionResult";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../observe/interfaces/ObserveScreen";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import { isAdoptableCapture } from "../observe/isAdoptableCapture";
import type { Window } from "../observe/interfaces/Window";
import { Window as RealWindow } from "../observe/Window";
import {
  clearResolvedHomePackageCache,
  isForegroundLauncher,
} from "../observe/androidLauncherPackages";
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
import { hierarchyChanged, hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import { throwIfAborted } from "../../utils/toolUtils";
import {
  beginPostActionCaptureAction,
  deferTerminalScreenshot,
} from "../../utils/PostActionCaptureContext";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import {
  resolveNavigationGraphForDevice,
  type NavigationGraphResolver,
} from "../navigation/deviceNavigationGraph";
import { PredictionAnalyzer, PredictionActionContext } from "../observe/PredictionAnalyzer";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { sequenceBackoff } from "../../utils/Backoff";
import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";
import { defaultDaemonContext, type DaemonContext } from "../../daemon/daemonContext";
import {
  resolveScreenshotMode,
  shouldSkipActionObservationScreenshot,
} from "../observe/automaticScreenshotPolicy";
import { serverConfig } from "../../utils/ServerConfig";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { withForwardDeliveredNote } from "./swipeon/boomerangReturnLeg";

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

const COORDINATE_ACTIONS = new Set([
  "tapAt",
  "swipeAt",
  "tapOn",
  "tapAny",
  "swipeOn",
  "dragAndDrop",
  "pinchOn",
  "multiTouch",
]);

export type RenderedDisplayRevisionReader = (deviceId: string) => number | undefined;

export interface DisplayFence {
  assertCurrent(): void;
}

/** Internal dispatch options; never part of a tool's input schema. */
export interface DisplayFenceOption {
  readonly displayFence?: DisplayFence;
}

const NO_OP_DISPLAY_FENCE: DisplayFence = Object.freeze({ assertCurrent: () => {} });

/** Intermediate action reads resolve targets and effects; terminal evidence is captured once. */
export const INTERMEDIATE_OBSERVATION_OPTIONS = {
  skipScreenshot: true,
  skipAccessibilityAudit: true,
} satisfies ObserveScreenExecuteOptions;

export function resolveDisplayFence(options?: DisplayFenceOption): DisplayFence {
  return options?.displayFence ?? NO_OP_DISPLAY_FENCE;
}

export interface DisplayFenceDependencies {
  /** Collaborator overrides; default to the real device-backed implementations. */
  observeScreen?: ObserveScreen;
  awaitIdle?: AwaitIdle;
  window?: Window;
  predictionAnalyzer?: Pick<PredictionAnalyzer, "recordOutcomeForAction">;
  displayTransitions?: DisplayTransitionReader;
  renderedDisplayRevision?: RenderedDisplayRevisionReader;
  renderedDisplayGeneration?: RenderedDisplayRevisionReader;
}

export function sessionRenderedDisplayGeneration(
  deviceId: string,
  daemon: DaemonContext = defaultDaemonContext,
): number | undefined {
  const sessions = daemon.renderedDisplaySessions();
  if (!sessions) {
    return undefined;
  }
  const sessionId = sessions.getSessionForDevice(deviceId);
  return sessionId ? sessions.getLastRenderedDisplayGeneration(sessionId) : undefined;
}

function sessionRenderedDisplayRevision(
  deviceId: string,
  daemon: DaemonContext = defaultDaemonContext,
): number | undefined {
  const sessions = daemon.renderedDisplaySessions();
  if (!sessions) {
    return undefined;
  }
  const sessionId = sessions.getSessionForDevice(deviceId);
  return sessionId ? sessions.getLastRenderedDisplayRevision(sessionId) : undefined;
}

/**
 * Max retry attempts `takeObservation` performs after its initial observation
 * (5 observation attempts total). Exported for the same reason as
 * `FINAL_OBSERVATION_RETRY_BACKOFF_MS` above.
 */
export const FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS = 4;

/** Mutable display-fence state shared by the fence, pre-read and run stages. */
interface CallerFenceState {
  displayRevision: number;
  fence: DisplayFence;
  observedGeneration: number;
  reresolvesTarget: boolean;
  refreshForDisplayChange: boolean;
}

type HomeProbe = "verified" | "expired" | "not-home";

interface PostActionCapture {
  observation: ObserveResult;
  readFailed: boolean;
  staleDisplay?: StaleDisplayDetails;
}

export class BaseVisualChange {
  /** Missing freshness remains compatible unless an internal caller requires verification. */
  static shouldRefetchCachedObservation(cached: ObserveResult, requireVerified = false): boolean {
    return requireVerified
      ? cached.freshness?.isFresh !== true
      : cached.freshness?.isFresh === false;
  }

  windowCacheInvalidator: DeviceWindowCacheInvalidator = new DefaultDeviceWindowCacheInvalidator();

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
    const predictionContext = this.buildPredictionContext(options.predictionContext);
    const coordinateAction = this.reconcileDisplayAfterRead(options, state, previousObserveResult);

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
      return blockResult as R & ObservedEnvelope;
    }
    this.invalidateCtrlProxyCacheForDisplay(options);

    const observationStartTime = this.resolveObservationStartTime(
      options,
      actionStartTime,
      clockSkewMs,
    );
    const packageName = await this.resolvePackageName(options, previousObserveResult);
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
    const actionStartTime = await perf.track("getActionStartTime", async () => {
      if (this.device.platform !== "android") {
        return this.timer.now();
      }
      if (typeof this.adb.getDeviceTimestampMs === "function") {
        return this.adb.getDeviceTimestampMs();
      }
      return this.timer.now();
    });
    // Host-device clock skew, measured once with the action-start read. Zero on
    // iOS and whenever the device clock was unavailable (host-time fallback).
    // Taken after the read so any round trip makes the converted floor earlier,
    // never later, than the true post-input device time.
    return { actionStartTime, clockSkewMs: actionStartTime - this.timer.now() };
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

  private resolveObservationStartTime(
    options: ObservedChangeOptions,
    actionStartTime: number,
    clockSkewMs: number,
  ): number {
    const hostTimestamp = options.observationHostTimestampProvider?.();
    const override =
      options.observationTimestampProvider?.() ??
      (typeof hostTimestamp === "number" ? hostTimestamp + clockSkewMs : undefined);
    if (typeof override !== "number" || Number.isNaN(override)) {
      return actionStartTime;
    }
    if (override >= actionStartTime) {
      logger.debug(`[BaseVisualChange] Using observation timestamp override: ${override}`);
      return override;
    }
    logger.debug(
      `[BaseVisualChange] Ignoring observation timestamp override (${override}) older than action start (${actionStartTime})`,
    );
    return actionStartTime;
  }

  /** Package name for UI stability waiting: options, then the pre-read hierarchy, then cache. */
  private async resolvePackageName(
    options: ObservedChangeOptions,
    previous: ObserveResult | null,
  ): Promise<string | undefined> {
    if (options.packageName) {
      return options.packageName;
    }
    const fromHierarchy = previous?.viewHierarchy?.packageName;
    if (fromHierarchy) {
      logger.info(`[BaseVisualChange] Using packageName from view hierarchy: ${fromHierarchy}`);
      return fromHierarchy;
    }
    if (options.display !== undefined) {
      return undefined;
    }
    const cachedPackageName = (await this.window.getCachedActiveWindow())?.appId;
    if (cachedPackageName) {
      logger.info(`[BaseVisualChange] Using cached packageName: ${cachedPackageName}`);
    }
    return cachedPackageName || undefined;
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
   * warning. Android-only: `deviceLock` is only collected on Android observe.
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

  private compareScreenIdentity(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
  ): TapEffect | undefined {
    const previous = previousObservation.screenIdentity;
    const current = currentObservation.screenIdentity;
    if (!previous || !current || previous.platform !== current.platform) {
      return undefined;
    }
    const changed = previous.key !== current.key;
    return {
      screenChanged: changed,
      basis: changed ? "screenIdentity changed" : "screenIdentity unchanged",
    };
  }

  protected compareActiveWindow(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
  ): TapEffect | undefined {
    const previous = previousObservation.activeWindow;
    const current = currentObservation.activeWindow;
    if (!this.hasCompleteActiveWindow(previous) || !this.hasCompleteActiveWindow(current)) {
      return undefined;
    }
    // layoutSeqSum comes from dumpsys, while hierarchy-derived windows use 0.
    // Even two non-zero samples do not establish a visible change on their own;
    // the hierarchy comparison below supplies that evidence for the same activity.
    const changed =
      previous.appId !== current.appId || previous.activityName !== current.activityName;
    return {
      screenChanged: changed,
      basis: changed ? "activeWindow changed" : "activeWindow unchanged",
    };
  }

  private hasCompleteActiveWindow(
    activeWindow: ObserveResult["activeWindow"],
  ): activeWindow is NonNullable<ObserveResult["activeWindow"]> {
    return Boolean(
      activeWindow?.appId &&
      activeWindow.activityName &&
      Number.isInteger(activeWindow.layoutSeqSum),
    );
  }

  private compareViewHierarchy(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
  ): TapEffect | undefined {
    const previousHash = hierarchyFingerprint(previousObservation.viewHierarchy ?? null);
    const currentHash = hierarchyFingerprint(currentObservation.viewHierarchy ?? null);
    if (!previousHash || !currentHash) {
      return undefined;
    }
    const changed = previousHash !== currentHash;
    return {
      screenChanged: changed,
      basis: changed ? "viewHierarchy changed" : "viewHierarchy unchanged",
    };
  }

  /**
   * Issue #6258: a basis that resolves to "unchanged" must not stop the chain
   * — it must fall through to the next basis rather than being taken as final
   * proof nothing changed. A dialog open (e.g. the Material time picker) is
   * the known dialog-window gap (#6151): `activeWindow` never reflects the new
   * dialog window, so it resolves "unchanged" even though the hierarchy
   * clearly changed. The old `??` chain stopped at the first *defined* result
   * regardless of its `screenChanged` value, so `activeWindow unchanged`
   * masked a real `viewHierarchy changed`. Priority order (screenIdentity,
   * then activeWindow, then viewHierarchy) is preserved for a basis that DOES
   * report a change; when none report a change, the highest-priority
   * available basis is returned (matching prior "all unchanged" behavior).
   */
  protected deriveInteractionEffect(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult | undefined,
  ): TapEffect | undefined {
    if (!previousObservation || !currentObservation) {
      return undefined;
    }
    const hierarchyResult = this.compareViewHierarchy(previousObservation, currentObservation);
    const results = [
      this.compareScreenIdentity(previousObservation, currentObservation),
      this.compareActiveWindow(previousObservation, currentObservation),
      hierarchyResult,
    ].filter((result): result is NonNullable<typeof result> => result !== undefined);

    // A matching pair of device trees rules out a visible screen change even
    // when side-channel identity metadata was sampled from different moments.
    if (hierarchyResult && !hierarchyResult.screenChanged) {
      return results.find((result) => !result.screenChanged) ?? hierarchyResult;
    }

    const changedResult = results.find((result) => result.screenChanged);
    if (changedResult) {
      return changedResult;
    }

    return results[0] ?? { screenChanged: false, basis: "insufficient observation data" };
  }

  private async capturePostActionObservation(
    observeScreen: ObserveScreen,
    options: ObserveScreenExecuteOptions,
    shouldRetry: (observation: ObserveResult) => boolean,
    blockResult: { success?: boolean; skipped?: unknown; wasAlreadyFocused?: boolean },
  ): Promise<PostActionCapture> {
    const perf = options.perf ?? new NoOpPerformanceTracker();
    const retryBackoff = sequenceBackoff(FINAL_OBSERVATION_RETRY_BACKOFF_MS);
    let latestObservation: ObserveResult | undefined;
    let trustworthyObservation: ObserveResult | undefined;
    const read = async () => {
      const observation = await observeScreen.execute(options);
      if (options.display !== undefined) {
        throwIfAborted(options.signal);
      }
      if (
        options.display !== undefined &&
        isAdoptableCapture(trustworthyObservation ?? observation, observation, true)
      ) {
        trustworthyObservation = observation;
      }
      return observation;
    };
    try {
      perf.serial("finalObserve");
      latestObservation = await read();
      perf.end();
      for (
        let attempt = 0;
        attempt < FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS && shouldRetry(latestObservation);
        attempt++
      ) {
        const delayMs = retryBackoff.delayForAttempt(attempt + 1);
        logger.info(
          `[BaseVisualChange] Observation appears stale/unchanged, retrying in ${delayMs}ms (attempt ${attempt + 1}/${FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS})`,
        );
        await this.timer.sleep(delayMs);
        perf.serial(`finalObserve_retry_${attempt + 1}`);
        latestObservation = await read();
        perf.end();
      }
    } catch (error) {
      return this.recoverPostActionObservation(
        error,
        trustworthyObservation ?? latestObservation,
        options,
        blockResult,
      );
    }
    return { observation: latestObservation, readFailed: false };
  }

  private recoverPostActionObservation(
    error: unknown,
    observation: ObserveResult | undefined,
    options: ObserveScreenExecuteOptions,
    blockResult: { success?: boolean; skipped?: unknown; wasAlreadyFocused?: boolean },
  ): PostActionCapture {
    if (options.display === undefined) {
      throw error;
    }
    throwIfAborted(options.signal);
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (observation && isAdoptableCapture(observation, observation, true)) {
      return this.notePostActionReadFailure(
        observation,
        "observation retry",
        errorMessage(error),
        error,
      );
    }
    // A refused or skipped block never delivered a gesture.
    if (blockResult.success === false || blockResult.skipped || blockResult.wasAlreadyFocused) {
      throw error;
    }
    throw new DispatchedObservationError(error);
  }

  private notePostActionReadFailure(
    observation: ObserveResult,
    phase: string,
    reason: string,
    error?: unknown,
  ): PostActionCapture {
    const warning = `Post-action ${phase} failed: ${reason}; retaining the earlier observation`;
    logger.warn(`[BaseVisualChange] ${warning}`, error);
    return {
      observation: {
        ...observation,
        settled: false,
        freshness: {
          ...observation.freshness,
          isFresh: observation.freshness?.isFresh ?? true,
          warning: [observation.freshness?.warning, warning].filter(Boolean).join("; "),
        },
      },
      readFailed: true,
      ...(error instanceof StaleDisplayError ? { staleDisplay: error.details } : {}),
    };
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

    // Same object as the block returned. Its declared result type `R` is trusted: blocks also
    // return bare `{ success: false, error }` failures that lack `R`'s required fields.
    return mutable as R & ObservedEnvelope;
  }

  private buildPredictionContext(
    context?: ObservedChangeOptions["predictionContext"],
  ): PredictionActionContext | undefined {
    if (!context) {
      return undefined;
    }

    // The graph this device's navigation events are recorded on (its bound session's, else the
    // global one); resolved once so the outcome is judged on the graph the context came from.
    const navigationGraph = this.navigationGraphResolver(this.device);
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
      navigationGraph,
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
      onVerifiedForeground?: (appId: string) => void;
    } = {},
  ): Promise<boolean> {
    const verified = await this.readAndroidHomeForeground(options);
    if (!verified) {
      // Self-heal a launcher cache that may no longer describe this device
      // (#6863 review). The cached configured-HOME package is
      // invalidated by a connection-epoch change, but in direct mode no
      // incarnation resolver is registered, so a reconnect or a reused serial
      // leaves the entry looking valid. A failed verification is the only
      // evidence available that the cached package may be the previous
      // runtime's, so drop it and let the next press re-resolve rather than
      // keep reporting real Home presses as failures. A cancellation rethrows
      // above and never reaches here -- an aborted read is not evidence.
      clearResolvedHomePackageCache(this.device.deviceId);
    }
    return verified;
  }

  /**
   * The retry loop behind {@link verifyAndroidHomeForeground}. Split out so the
   * failure path has exactly one place to self-heal the launcher cache,
   * regardless of which of the loop's several `return false` exits was taken.
   */
  private async readAndroidHomeForeground(options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    retryDelaysMs?: readonly number[];
    onVerifiedForeground?: (appId: string) => void;
  }): Promise<boolean> {
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
        const probe = await this.probeHomeForeground(signal, remainingMs, options);
        if (probe !== "not-home") {
          return probe === "verified";
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
      // Don't sleep past the shared deadline: a backoff that would overrun the
      // remaining budget ends verification now instead of stalling the keyed op.
      const remaining = remainingMs();
      if (delay === undefined || (remaining !== undefined && remaining <= delay)) {
        return false;
      }
      await this.timer.sleep(delay);
    }
  }

  /** One foreground read plus launcher check, bounded by the shared deadline. */
  private async probeHomeForeground(
    signal: AbortSignal | undefined,
    remainingMs: () => number | undefined,
    options: { onVerifiedForeground?: (appId: string) => void },
  ): Promise<HomeProbe> {
    // Do not revive an expired verification budget by handing its zero value
    // to Window, which must clamp subcommand timeouts to keep those commands
    // bounded. No device read is valid once this operation's deadline passed.
    if ((remainingMs() ?? 1) <= 0) {
      return "expired";
    }
    const activeWindow = await this.window.getActive(true, undefined, {
      signal,
      timeoutMs: remainingMs(),
    });
    if ((remainingMs() ?? 1) <= 0) {
      return "expired";
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
      options.onVerifiedForeground?.(activeWindow.appId);
      return "verified";
    }
    return "not-home";
  }
}
