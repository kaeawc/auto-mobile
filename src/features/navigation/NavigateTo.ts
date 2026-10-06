import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  stripNavigationToolParams,
} from "../../daemon/constants";
import { ActionableError, BootedDevice, NavigateToResult } from "../../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { ToolRegistry } from "../../server/toolRegistry";
import { throwIfInternalToolFailed } from "../../server/internalToolCall";
import {
  NavigationGraphManager,
  type NavigationEdge,
  type NavigationGraphService,
} from "./NavigationGraphManager";
import type { PathResult, ToolCallInteraction } from "../../utils/interfaces/NavigationGraph";
import { edgeReplayKey } from "./edgeReplayKey";
import { ProgressCallback } from "../../server/toolRegistry";
import { SmartNavigationHelper } from "./SmartNavigationHelper";
import type { PathOptimizer } from "./interfaces/PathOptimizer";
import { UIStateSetup } from "./interfaces/UIStateSetup";
import { DefaultUIStateSetup } from "./DefaultUIStateSetup";
import { ScreenTransitionWaiter } from "./interfaces/ScreenTransitionWaiter";
import { DefaultScreenTransitionWaiter } from "./DefaultScreenTransitionWaiter";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { throwIfAborted, awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { errorMessage } from "../../utils/describeUnknownError";
import { PressButton } from "../action/PressButton";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { oppositeDirection } from "../action/swipeon/lookForScroll";
import {
  isCoordinateAddressed,
  isElementNotFoundFailure,
  ReplayRunState,
  ReplayScrollDisturbedError,
  ReplayTargetNotFoundError,
  ReplayTransientError,
  replayLookForFor,
  replayScrollContainer,
  SwipeOnReplayScrollSearcher,
  type ReplayScrollSearchRequest,
  type ReplayScrollSearcher,
} from "./replayScrollSearch";
import {
  describeForegroundOverlay,
  type ForegroundObservation,
  type ForegroundObserver,
} from "./foregroundOverlay";

/**
 * Options for the navigateTo tool.
 */
export interface NavigateToOptions {
  /** Target screen name to navigate to */
  targetScreen: string;
  /** Platform (android/ios) */
  platform: "android" | "ios";
  /** Session that selected the outer device, retained by internal replays. */
  sessionUuid?: string;
  [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]?: number;
  [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]?: number;
}

interface PathRunContext {
  targetScreen: string;
  startTime: number;
  options: NavigateToOptions;
  uiStateSetup: UIStateSetup;
  /**
   * What this call's replay scroll searches have done (#10154): time spent, where a
   * failed search left the list, and the edges to settle when the call ends.
   */
  replayState: ReplayRunState;
}

/** A path run's result; `retryFrom` is set when a step failed with the device still at its source. */
interface PathStepsOutcome {
  result: NavigateToResult;
  retryFrom?: NavigationEdge;
}

/** Why a fallback edge must not be dispatched: where the device actually is. */
interface RetryBlocker {
  reason: string;
  screen: string | null;
}

/**
 * A replay failure that was observed with a blocker already found (the pre-search
 * check), so the step outcome reuses it instead of observing the device a second time.
 */
class ReplayBlockedError extends ActionableError {
  constructor(
    message: string,
    readonly blocker: RetryBlocker,
  ) {
    super(message);
  }
}

/** What a failed step needs to know about how its replay failed (#10154). */
interface StepFailureDetail {
  error: unknown;
  replayState: ReplayRunState;
}

/** The part of a navigateTo call's state a single replay step reads and updates. */
interface ReplayRun {
  startTime: number;
  state: ReplayRunState;
}

interface NavigationPathResultContext {
  targetScreen: string;
  executedPath: string[];
  startTime: number;
}

/**
 * NavigateTo feature class that uses the navigation graph to traverse an app
 * to reach a target screen.
 */
export class NavigateTo {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private navigationManager: NavigationGraphService;
  private uiStateSetup: UIStateSetup | null;
  private screenWaiter: ScreenTransitionWaiter;
  private timer: Timer;
  private pathOptimizer: PathOptimizer | undefined;
  private sessionUuid?: string;
  private foregroundObserverProvider: () => ForegroundObserver;
  private scrollSearcher: ReplayScrollSearcher;

  private static readonly MAX_TIMEOUT_MS = 30000; // 30 seconds
  /** Swipes a replayed tapOn may spend looking for an off-screen target (#10154). */
  private static readonly REPLAY_SEARCH_MAX_SWIPES = 8;
  /** Longest a single replay scroll search may run, within the remaining navigateTo budget. */
  private static readonly REPLAY_SEARCH_MAX_MS = 10000;
  /** Most time one navigateTo call may spend in replay scroll searches across all its steps. */
  private static readonly REPLAY_SEARCH_TOTAL_MAX_MS = NavigateTo.MAX_TIMEOUT_MS / 2;
  private static readonly STEP_TIMEOUT_MS = 5000; // 5 seconds per step
  private static readonly POLL_INTERVAL_MS = 500; // Check screen every 500ms

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    uiStateSetup: UIStateSetup | null = null,
    screenWaiter: ScreenTransitionWaiter | null = null,
    navigationManager?: NavigationGraphService,
    timer: Timer = defaultTimer,
    pathOptimizer?: PathOptimizer,
    sessionUuid?: string,
    foregroundObserverProvider?: () => ForegroundObserver,
    scrollSearcher?: ReplayScrollSearcher,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.navigationManager = navigationManager ?? NavigationGraphManager.getInstance();
    this.timer = timer;
    this.pathOptimizer = pathOptimizer;
    this.sessionUuid = sessionUuid;
    this.scrollSearcher = scrollSearcher ?? new SwipeOnReplayScrollSearcher(device, this.timer);
    this.foregroundObserverProvider =
      foregroundObserverProvider ??
      (() => new RealObserveScreen(this.device, { create: () => this.adb }));

    this.uiStateSetup = uiStateSetup;
    this.screenWaiter =
      screenWaiter ||
      new DefaultScreenTransitionWaiter(
        this.navigationManager,
        NavigateTo.POLL_INTERVAL_MS,
        this.timer,
      );
  }

  /**
   * Execute navigation to the target screen.
   */
  async execute(
    options: NavigateToOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<NavigateToResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("navigateTo");

    const startTime = this.timer.now();
    const { targetScreen } = options;
    this.sessionUuid ??= options.sessionUuid;
    const uiStateSetup =
      this.uiStateSetup ??
      new DefaultUIStateSetup(this.device, this.adb, undefined, this.timer, this.sessionUuid);
    this.uiStateSetup = uiStateSetup;

    try {
      throwIfAborted(signal);
      // Get current screen from navigation graph
      const currentScreen = this.navigationManager.getCurrentScreen();

      if (!currentScreen) {
        perf.end();
        return this.unknownCurrentScreenResult(targetScreen);
      }

      // Already on target screen
      if (currentScreen === targetScreen) {
        perf.end();
        return this.alreadyOnTargetResult(currentScreen, targetScreen, startTime);
      }

      // Check if we should use smart back button navigation
      // Get current screen's back stack depth from the last observation
      const currentNode = await awaitWhileRequestIsLive(
        this.navigationManager.getNode(currentScreen),
        signal,
      );
      throwIfAborted(signal);
      const currentBackStackDepth = currentNode?.backStackDepth ?? 0;

      if (currentBackStackDepth > 0) {
        const backNavResult = await awaitWhileRequestIsLive(
          (this.pathOptimizer ?? SmartNavigationHelper).shouldUseBackButton(
            currentScreen,
            targetScreen,
            currentBackStackDepth,
          ),
          signal,
        );

        throwIfAborted(signal);
        if (backNavResult.shouldUseBack) {
          logger.info(
            `[NAVIGATE_TO] Using smart back button navigation: ` +
              `${backNavResult.backPresses} back presses. Reason: ${backNavResult.reason}`,
          );

          const result = await this.executeBackNavigation(
            backNavResult.backPresses,
            targetScreen,
            startTime,
            progress,
            signal,
          );
          throwIfAborted(signal);
          perf.end();
          return result;
        } else {
          logger.debug(
            `[NAVIGATE_TO] Not using back button navigation. Reason: ${backNavResult.reason}`,
          );
        }
      }

      // Find path to target
      const pathResult = await this.navigationManager.findPath(targetScreen);

      throwIfAborted(signal);
      if (!pathResult.found) {
        perf.end();
        const knownScreens = await this.navigationManager.getKnownScreens();
        throwIfAborted(signal);
        return this.noKnownPathResult(
          currentScreen,
          targetScreen,
          knownScreens,
          startTime,
          pathResult.unreplayableEdges,
        );
      }

      const result = await this.followPath(
        pathResult,
        { targetScreen, startTime, options, uiStateSetup },
        progress,
        signal,
      );
      perf.end();
      return result;
    } catch (error) {
      perf.end();
      throwIfAborted(signal);
      logger.warn(`[NAVIGATE_TO] Navigation failed: ${errorMessage(error)}`, error);
      return this.navigationFailureResult(error, targetScreen, startTime);
    }
  }

  /**
   * Replay the found path. When a step does not reach its target while the device
   * is still on the step's source screen, remember the failure and re-plan from
   * there: findPath ranks the failed edge below the other edges for that screen pair,
   * so the next-best one (another tool edge, then a no-tool Back edge) is tried before
   * the navigation fails (#10031). Each edge action is tried at most once per call.
   */
  private async followPath(
    initialPath: PathResult,
    context: Omit<PathRunContext, "replayState">,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<NavigateToResult> {
    const replayState = new ReplayRunState();
    try {
      return await this.followPathWithFallbacks(
        initialPath,
        { ...context, replayState },
        progress,
        signal,
      );
    } finally {
      // A target the bounded search could not find does not by itself show the edge is
      // broken: the failure only ranked it last for this call. Settling forgets what
      // this call added (never a failure an earlier call recorded) unless repeated
      // searches have missed the target, which demotes the edge for later calls.
      for (const { edge, searched } of replayState.transientFailures) {
        this.navigationManager.settleTransientEdgeFailure(edge, searched);
      }
    }
  }

  private async followPathWithFallbacks(
    initialPath: PathResult,
    context: PathRunContext,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<NavigateToResult> {
    const executedPath: string[] = [];
    const attempted = new Set<string>();
    let path = initialPath.path;
    for (;;) {
      const outcome = await this.runPathSteps(path, context, executedPath, progress, signal);
      if (!outcome.retryFrom) {
        return outcome.result;
      }
      attempted.add(edgeReplayKey(outcome.retryFrom));
      const replanned = await this.navigationManager.findPath(context.targetScreen);
      throwIfAborted(signal);
      const nextEdge = replanned.found ? replanned.path[0] : undefined;
      // A re-plan always starts at the screen the device is on; anything else (or an
      // action already tried) means there is no further edge to try for this pair.
      if (
        !nextEdge ||
        nextEdge.from !== outcome.retryFrom.from ||
        attempted.has(edgeReplayKey(nextEdge))
      ) {
        return outcome.result;
      }
      logger.info(
        `[NAVIGATE_TO] Replay of ${outcome.retryFrom.from} → ${outcome.retryFrom.to} did not ` +
          `reach its target; trying another edge for ${nextEdge.from} → ${nextEdge.to}`,
      );
      path = replanned.path;
    }
  }

  private async runPathSteps(
    path: NavigationEdge[],
    context: PathRunContext,
    executedPath: string[],
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<PathStepsOutcome> {
    const { targetScreen, startTime, options, uiStateSetup } = context;
    const resultContext = { targetScreen, executedPath, startTime };
    let reached = false;
    let arrivalScreen: string | undefined;

    for (let i = 0; i < path.length; i++) {
      throwIfAborted(signal);
      const edge = path[i];

      // Check timeout
      if (this.timer.now() - startTime > NavigateTo.MAX_TIMEOUT_MS) {
        return { result: this.navigationTimeoutResult(targetScreen, executedPath, startTime) };
      }

      // Report progress
      if (progress) {
        await awaitWhileRequestIsLive(
          progress(i, path.length, `Navigating: ${edge.from} → ${edge.to}`),
          signal,
        );
      }

      logger.info(`[NAVIGATE_TO] Step ${i + 1}/${path.length}: ${edge.from} → ${edge.to}`);

      // Execute navigation step
      try {
        await this.replayStep(
          edge,
          options,
          uiStateSetup,
          executedPath,
          { startTime, state: context.replayState },
          signal,
        );
      } catch (error) {
        throwIfAborted(signal);
        logger.warn(`[NAVIGATE_TO] Error executing step: ${errorMessage(error)}`, error);
        return this.failedStepOutcome(
          edge,
          this.stepExecutionFailureResult(error, i, resultContext),
          signal,
          { error, replayState: context.replayState },
        );
      }

      // Wait for screen transition
      throwIfAborted(signal);
      let stepReached = await this.screenWaiter.waitForScreen(
        edge.to,
        NavigateTo.STEP_TIMEOUT_MS,
        signal,
      );
      throwIfAborted(signal);
      let observedScreen: string | null = null;
      if (!stepReached) {
        throwIfAborted(signal);
        observedScreen = this.navigationManager.getCurrentScreen();
        throwIfAborted(signal);
        stepReached = observedScreen === edge.to;
      }
      arrivalScreen = observedScreen === targetScreen ? observedScreen : undefined;
      reached = stepReached && edge.to === targetScreen;
      if (!stepReached && arrivalScreen !== undefined) {
        reached = true;
        break;
      }
      if (!stepReached) {
        const error = `Navigation step ${i + 1} (${edge.from} → ${edge.to}) did not reach expected screen "${edge.to}"; observed current screen "${observedScreen ?? "unknown"}"; ${i + 1} steps ran (${executedPath.length} actions dispatched)`;
        logger.warn(`[NAVIGATE_TO] ${error}`);
        return this.failedStepOutcome(
          edge,
          this.stepArrivalFailureResult(error, observedScreen, resultContext),
          signal,
        );
      }
      this.navigationManager.recordEdgeReplayOutcome(edge, true);
    }

    // Final progress update
    if (progress) {
      await awaitWhileRequestIsLive(
        progress(
          path.length,
          path.length,
          reached ? `Arrived at ${targetScreen}` : `Waiting for ${targetScreen}`,
        ),
        signal,
      );
    }

    throwIfAborted(signal);
    return { result: this.completedNavigationResult(arrivalScreen, reached, resultContext) };
  }

  /**
   * A step whose replay did not reach its target: remember that, and offer a retry
   * only when the device never left the step's source screen (otherwise the next
   * edge for that pair is no longer the right one to try from here). The graph's
   * current screen is not proof of that: a replay can open a system dialog or sheet
   * the graph never reports, so a fresh observation must agree before a fallback
   * edge (possibly a Back press) is dispatched (#10133).
   *
   * A replay that failed only because its target was not on screen (#10154) is
   * remembered as failed for the rest of this call so the fallback edge ranks first,
   * and settled by followPath when the call ends. A replay whose pre-search check
   * already found a blocker reuses it rather than observing again.
   */
  private async failedStepOutcome(
    edge: NavigationEdge,
    result: NavigateToResult,
    signal?: AbortSignal,
    failure?: StepFailureDetail,
  ): Promise<PathStepsOutcome> {
    this.rememberReplayFailure(edge, failure);
    // The failure result already carries the screen the graph reported after the replay.
    if (result.currentScreen !== edge.from) {
      return { result };
    }
    const blocker =
      failure?.error instanceof ReplayBlockedError
        ? failure.error.blocker
        : await this.findBlockerBeforeRetry(edge.from, signal);
    if (!blocker) {
      return { result, retryFrom: edge };
    }
    return { result: this.withUnverifiedSourceDetail(result, edge.from, blocker) };
  }

  /**
   * Rank a failed edge last for later findPath calls. A target-missing failure of an
   * edge no earlier call had failed is also queued for settling, so only what this
   * call added is ever taken back (#10154).
   */
  private rememberReplayFailure(edge: NavigationEdge, failure?: StepFailureDetail): void {
    if (
      failure?.error instanceof ReplayTransientError &&
      !this.navigationManager.hasEdgeReplayFailure(edge)
    ) {
      failure.replayState.transientFailures.push({ edge, searched: failure.error.searched });
    }
    this.navigationManager.recordEdgeReplayOutcome(edge, false);
  }

  /**
   * Observe the device and report why it cannot be trusted to still be on `source`,
   * or `undefined` when it can. A failed observation is also a reason not to retry:
   * the fallback must never be dispatched blind.
   */
  private async findBlockerBeforeRetry(
    source: string,
    signal?: AbortSignal,
  ): Promise<RetryBlocker | undefined> {
    let observation: ForegroundObservation;
    try {
      throwIfAborted(signal);
      observation = await awaitWhileRequestIsLive(
        this.foregroundObserverProvider().execute(signal ? { signal } : undefined),
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[NAVIGATE_TO] Re-observe before fallback edge failed: ${errorMessage(error)}`,
        error,
      );
      return {
        reason: `the device could not be observed (${errorMessage(error)})`,
        screen: this.navigationManager.getCurrentScreen(),
      };
    }
    throwIfAborted(signal);
    // The observation feeds the graph's screen tracking, so read the screen after it.
    const screen = this.navigationManager.getCurrentScreen();
    if (screen !== source) {
      return { reason: `the observed screen is "${screen ?? "unknown"}"`, screen };
    }
    const overlay = describeForegroundOverlay(
      observation,
      this.navigationManager.getCurrentAppId(),
    );
    return overlay ? { reason: `it is showing ${overlay}`, screen } : undefined;
  }

  private withUnverifiedSourceDetail(
    result: NavigateToResult,
    source: string,
    blocker: RetryBlocker,
  ): NavigateToResult {
    const detail =
      `Not trying a fallback edge: after the failed replay the device is no longer ` +
      `confirmed on "${source}" (${blocker.reason}); resolve that and call navigateTo again`;
    logger.warn(`[NAVIGATE_TO] ${detail}`);
    return {
      ...result,
      error: result.error ? `${result.error}. ${detail}` : detail,
      currentScreen: blocker.screen,
    };
  }

  private noKnownPathResult(
    currentScreen: string,
    targetScreen: string,
    knownScreens: string[],
    startTime: number,
    unreplayableEdges = 0,
  ): NavigateToResult {
    const skipped =
      unreplayableEdges > 0
        ? ` ${unreplayableEdges} recorded transition(s) were ignored because no action was recorded ` +
          `for them, so they cannot be replayed.`
        : "";
    return {
      success: false,
      error:
        `No known path from "${currentScreen}" to "${targetScreen}".${skipped} ` +
        `Known screens: ${knownScreens.join(", ") || "none"}`,
      currentScreen,
      targetScreen,
      stepsExecuted: 0,
      durationMs: this.timer.now() - startTime,
    };
  }

  private unknownCurrentScreenResult(targetScreen: string): NavigateToResult {
    return {
      success: false,
      error: "Cannot determine current screen. No navigation events recorded yet.",
      currentScreen: null,
      targetScreen,
      stepsExecuted: 0,
    };
  }

  private alreadyOnTargetResult(
    currentScreen: string,
    targetScreen: string,
    startTime: number,
  ): NavigateToResult {
    return {
      success: true,
      message: "Already on target screen",
      currentScreen,
      targetScreen,
      stepsExecuted: 0,
      durationMs: this.timer.now() - startTime,
    };
  }

  private navigationTimeoutResult(
    targetScreen: string,
    executedPath: string[],
    startTime: number,
  ): NavigateToResult {
    return {
      success: false,
      error: "Navigation timeout (30 seconds)",
      currentScreen: this.navigationManager.getCurrentScreen(),
      targetScreen,
      stepsExecuted: executedPath.length,
      partialPath: executedPath,
      durationMs: this.timer.now() - startTime,
    };
  }

  private stepExecutionFailureResult(
    error: unknown,
    i: number,
    context: NavigationPathResultContext,
  ): NavigateToResult {
    const { targetScreen, executedPath, startTime } = context;
    return {
      success: false,
      error: `Failed to execute step ${i + 1}: ${errorMessage(error)}`,
      currentScreen: this.navigationManager.getCurrentScreen(),
      targetScreen,
      stepsExecuted: executedPath.length,
      partialPath: executedPath,
      durationMs: this.timer.now() - startTime,
    };
  }

  private stepArrivalFailureResult(
    error: string,
    observedScreen: string | null,
    context: NavigationPathResultContext,
  ): NavigateToResult {
    const { targetScreen, executedPath, startTime } = context;
    return {
      success: false,
      error,
      currentScreen: observedScreen,
      targetScreen,
      stepsExecuted: executedPath.length,
      partialPath: executedPath,
      durationMs: this.timer.now() - startTime,
    };
  }

  private completedNavigationResult(
    arrivalScreen: string | undefined,
    reached: boolean,
    context: NavigationPathResultContext,
  ): NavigateToResult {
    const { targetScreen, executedPath, startTime } = context;
    const finalScreen = arrivalScreen ?? this.navigationManager.getCurrentScreen();
    const message = reached
      ? `Successfully navigated to "${targetScreen}"`
      : `Navigation did not reach "${targetScreen}"${finalScreen ? `; currently on "${finalScreen}"` : ""}`;
    return {
      success: reached,
      message,
      ...(!reached ? { error: message } : {}),
      currentScreen: finalScreen,
      targetScreen,
      stepsExecuted: executedPath.length,
      path: executedPath,
      durationMs: this.timer.now() - startTime,
    };
  }

  private navigationFailureResult(
    error: unknown,
    targetScreen: string,
    startTime: number,
  ): NavigateToResult {
    return {
      success: false,
      error: `Navigation failed: ${errorMessage(error)}`,
      currentScreen: this.navigationManager.getCurrentScreen(),
      targetScreen,
      stepsExecuted: 0,
      durationMs: this.timer.now() - startTime,
    };
  }

  /**
   * Execute a tool call by looking up the tool in the registry.
   */
  private async executeToolCall(
    interaction: ToolCallInteraction,
    options: NavigateToOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    logger.info(`[NAVIGATE_TO] Replaying tool call: ${interaction.toolName}`);

    // Replay through the internal-call seam (#3108): it resolves the tool,
    // marks the call internal (#3087), and invokes the handler in one step.
    // `callInternal` copies the args before marking, so the stored edge
    // `interaction.args` is never mutated. Under `--actions-diff-observe` this
    // replay neither diffs its observation nor advances the agent-facing diff
    // baseline. Throws ActionableError if the tool is not registered.
    const response = await ToolRegistry.callInternal(
      interaction.toolName,
      {
        ...stripNavigationToolParams(interaction.args),
        platform: this.device.platform,
        deviceId: this.device.deviceId,
        ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
        ...(options[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM] !== undefined
          ? { [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: options[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM] }
          : {}),
        ...(options[INTERNAL_MCP_REQUEST_DEADLINE_PARAM] !== undefined
          ? { [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: options[INTERNAL_MCP_REQUEST_DEADLINE_PARAM] }
          : {}),
      },
      undefined,
      signal,
    );
    throwIfAborted(signal);
    throwIfInternalToolFailed(response, interaction.toolName, this.device.platform);
  }

  /**
   * Press the back button as a fallback navigation action.
   */
  private async pressBack(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.device.platform === "android") {
      // Keep the caller's injected ADB executor and timer for Android recovery.
      // PressButton retains the accessibility-service/ADB fallback without
      // observing, so this internal recovery does not advance any diff baseline.
      const result = await new PressButton(this.device, this.adb, this.timer).press(
        "back",
        undefined,
        undefined,
        signal,
      );
      throwIfAborted(signal);
      if (!result.success) {
        throw new Error(result.error ?? "Android back navigation failed");
      }
      logger.debug("[NAVIGATE_TO] Pressed back via Android interaction action");
      return;
    }

    // iOS has no injected host transport, so retain its internal tool routing
    // for the selected device and no-diff behavior.
    const response = await ToolRegistry.callInternal(
      "pressButton",
      {
        button: "back",
        platform: this.device.platform,
        deviceId: this.device.deviceId,
        ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
      },
      undefined,
      signal,
    );
    throwIfAborted(signal);
    throwIfInternalToolFailed(response, "pressButton", this.device.platform);
    logger.debug(`[NAVIGATE_TO] Pressed back via ${this.device.platform} interaction tool`);
  }

  /**
   * Replay the edge's tool call. A `tapOn` whose target is not on screen is retried
   * once after looking for it the way an interactive caller would, with the shared
   * `swipeOn lookFor` scroll machinery (#10154): an edge recorded after the user
   * scrolled is replayed from the screen's initial scroll position, where its target
   * can be off screen.
   *
   * The search only runs once a fresh observation confirms the device is still on the
   * edge's source screen with nothing in front of it, so its swipes are never sent at a
   * dialog or another screen (#10133). It is capped in swipes, per search, and in total
   * time per navigateTo call; when it does not find the target the step fails with
   * `ReplayTargetNotFoundError`.
   */
  private async replayToolCall(
    edge: NavigationEdge,
    interaction: ToolCallInteraction,
    options: NavigateToOptions,
    progress: ReplayRun & { executedPath: string[] },
    signal?: AbortSignal,
  ): Promise<void> {
    this.refuseCoordinateReplayAfterFailedSearch(interaction, progress.state);
    try {
      await this.executeToolCall(interaction, options, signal);
      return;
    } catch (error) {
      throwIfAborted(signal);
      const request = this.replaySearchRequest(edge, interaction, progress, error);
      if (!request) {
        throw error;
      }
      const blocker = await this.findBlockerBeforeRetry(edge.from, signal);
      if (blocker) {
        throw new ReplayBlockedError(errorMessage(error), blocker);
      }
      await this.searchForReplayTarget(request, error, progress.state, signal);
      progress.executedPath.push(`swipeOn(lookFor: ${JSON.stringify(request.lookFor)})`);
    }
    await this.executeToolCall(interaction, options, signal);
  }

  /** Run the bounded search; resolves when the target is on screen, throws when it is not. */
  private async searchForReplayTarget(
    request: ReplayScrollSearchRequest,
    tapError: unknown,
    state: ReplayRunState,
    signal?: AbortSignal,
  ): Promise<void> {
    const searchStart = this.timer.now();
    let outcome: Awaited<ReturnType<ReplayScrollSearcher["search"]>>;
    try {
      outcome = await this.scrollSearcher.search(request, signal);
    } finally {
      state.searchMs += this.timer.now() - searchStart;
    }
    throwIfAborted(signal);
    if (!outcome.found) {
      // The search leaves the list wherever it ended; later replays must not assume the
      // position the edge was recorded in.
      state.disturbedDirection = request.direction;
      throw new ReplayTargetNotFoundError(
        `${errorMessage(tapError)}; scrolled ${request.direction} looking for it (at most ` +
          `${request.maxSwipes} swipes) and it did not come into view` +
          (outcome.detail ? `: ${outcome.detail}` : ""),
      );
    }
  }

  /**
   * A failed search cannot put the list back (the search primitive tracks no net
   * scroll displacement, and its boomerang return leg is for single swipes only), so a
   * later edge is re-resolved against a fresh observation instead: `tapOn` resolves its
   * selector on the screen as it is now, and its own search starts from the current
   * position (see `replaySearchRequest`). An edge that replays recorded coordinates
   * cannot be re-resolved, so it is refused rather than tapped at the wrong place.
   */
  private refuseCoordinateReplayAfterFailedSearch(
    interaction: ToolCallInteraction,
    state: ReplayRunState,
  ): void {
    if (state.disturbedDirection && isCoordinateAddressed(interaction.toolName, interaction.args)) {
      throw new ReplayScrollDisturbedError(
        `Not replaying ${interaction.toolName}: an earlier scroll search in this navigateTo ` +
          `call left the screen scrolled, so its recorded coordinates no longer point at the ` +
          `same content`,
      );
    }
  }

  /** The bounded search to run after `error`, or undefined when scrolling cannot help. */
  private replaySearchRequest(
    edge: NavigationEdge,
    interaction: ToolCallInteraction,
    run: ReplayRun,
    error: unknown,
  ): ReplayScrollSearchRequest | undefined {
    if (interaction.toolName !== "tapOn" || !isElementNotFoundFailure(error)) {
      return undefined;
    }
    const lookFor = replayLookForFor(interaction.args);
    const maxTimeMs = Math.min(
      NavigateTo.MAX_TIMEOUT_MS - (this.timer.now() - run.startTime),
      NavigateTo.REPLAY_SEARCH_TOTAL_MAX_MS - run.state.searchMs,
      NavigateTo.REPLAY_SEARCH_MAX_MS,
    );
    if (!lookFor || maxTimeMs <= 0) {
      return undefined;
    }
    const scrollPosition = edge.uiState?.scrollPosition;
    const container = replayScrollContainer(scrollPosition);
    // A failed search earlier in this call left the list at an unknown position, most
    // likely scrolled toward where it ended, so look back the other way first.
    const direction = run.state.disturbedDirection
      ? oppositeDirection(run.state.disturbedDirection)
      : // Lists are entered at the top, so content most often needs to move up (finger up).
        (scrollPosition?.direction ?? "up");
    return {
      lookFor,
      direction,
      ...(container ? { container } : {}),
      maxSwipes: NavigateTo.REPLAY_SEARCH_MAX_SWIPES,
      maxTimeMs,
    };
  }

  private async replayStep(
    edge: NavigationEdge,
    options: NavigateToOptions,
    uiStateSetup: UIStateSetup,
    executedPath: string[],
    run: ReplayRun,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (edge.interaction) {
      // Set up scroll position if required (must happen before UI state setup)
      if (edge.uiState?.scrollPosition) {
        throwIfAborted(signal);
        const scrollAction = await uiStateSetup.setupScrollPosition(
          edge.uiState.scrollPosition,
          options.platform,
          signal,
        );
        if (scrollAction) {
          executedPath.push(scrollAction);
        }
      }

      // Set up required UI state before executing the tool call
      throwIfAborted(signal);
      const setupActions = await uiStateSetup.setupUIState(edge, options.platform, signal);
      if (setupActions.length > 0) {
        executedPath.push(...setupActions);
      }

      // Replay the tool call
      const interaction = {
        ...edge.interaction,
        args: stripNavigationToolParams(edge.interaction.args),
      };
      await this.replayToolCall(edge, interaction, options, { ...run, executedPath }, signal);
      executedPath.push(`${edge.interaction.toolName}(${JSON.stringify(interaction.args)})`);
    } else if (edge.edgeType === "back") {
      logger.info(`[NAVIGATE_TO] Edge ${edge.from} → ${edge.to} is a Back edge, using back button`);
      await this.pressBack(signal);
      executedPath.push("pressButton(back)");
    } else {
      // Nothing says what caused this transition, so pressing Back would be a guess (#10196).
      throw new ActionableError(
        `The transition ${edge.from} → ${edge.to} has no recorded action, so it cannot be replayed.`,
      );
    }
  }

  private async executeBackNavigation(
    backPresses: number,
    targetScreen: string,
    startTime: number,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<NavigateToResult> {
    // Execute back button presses
    const executedPath: string[] = [];
    for (let i = 0; i < backPresses; i++) {
      throwIfAborted(signal);
      if (progress) {
        await awaitWhileRequestIsLive(
          progress(i, backPresses, `Pressing back button (${i + 1}/${backPresses})`),
          signal,
        );
      }

      await this.pressBack(signal);
      executedPath.push("pressButton(back)");

      // Small delay between presses to allow screen transitions
      throwIfAborted(signal);
      await awaitWhileRequestIsLive(this.timer.sleep(300), signal);
    }

    // Wait for target screen
    throwIfAborted(signal);
    const reached = await this.screenWaiter.waitForScreen(
      targetScreen,
      NavigateTo.STEP_TIMEOUT_MS,
      signal,
    );
    throwIfAborted(signal);

    if (progress) {
      await awaitWhileRequestIsLive(
        progress(
          backPresses,
          backPresses,
          reached ? `Arrived at ${targetScreen}` : `Waiting for ${targetScreen}`,
        ),
        signal,
      );
    }

    throwIfAborted(signal);
    return {
      success: reached,
      message: reached
        ? `Successfully navigated to "${targetScreen}" using back button`
        : `Pressed back ${backPresses} times but did not reach "${targetScreen}"`,
      currentScreen: this.navigationManager.getCurrentScreen(),
      targetScreen,
      stepsExecuted: executedPath.length,
      path: executedPath,
      durationMs: this.timer.now() - startTime,
    };
  }
}
