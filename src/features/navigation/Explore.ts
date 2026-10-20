import { throwIfInternalToolFailed } from "../../daemon/internalToolCall";
import { BootedDevice, Element, isTruthy, ObserveResult } from "../../models";
import { toActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { errorMessage } from "../../utils/describeUnknownError";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { ExportedGraph } from "../../utils/interfaces/NavigationGraph";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { beginPostActionCaptureAction } from "../../utils/PostActionCaptureContext";
import { defaultTimer, Timer } from "../../utils/SystemTimer";
import { runWithToolDispatchReporter } from "../../utils/ToolDispatchContext";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { BaseVisualChange, ProgressCallback } from "../action/BaseVisualChange";
import { DefaultElementParser } from "../utility/ElementParser";
import type { ExplorationLoopContext } from "./ExplorationLoopContext";
import type { BlockerHandlerDeps, DialogTapActionFactory } from "./ExploreBlockerDetection";
import { detectAndHandleBlockers } from "./ExploreBlockerDetection";
import { selectDiscoveryElement } from "./ExploreDiscoverySelection";
import {
  getObservationPackageName,
  getSafeExplorationCandidates,
  planExplorationDryRun,
} from "./ExploreDryRun";
import { ExploreElementActions } from "./ExploreElementActions";
import { getElementKey } from "./ExploreElementExtraction";
import { ExplorePermissionDialog } from "./ExplorePermissionDialog";
import { ExplorePlatformRecovery } from "./ExplorePlatformRecovery";
import { generateExplorationReport, isExplorationResetDue } from "./ExploreReporting";
import { explorationSafetyStopReason } from "./ExploreSafety";
import { DEFAULT_EXPLORE_TIMEOUT_MS } from "./exploreTimeout";
import type {
  ElementSelectionStats,
  ExplorationMode,
  ExplorationStrategy,
  ExploreDryRunResult,
  ExploreExecutionResult,
  ExploreOptions,
  ExploreResult,
  GraphTraversalState,
  TrackedElement,
} from "./ExploreTypes";
import {
  initializeGraphTraversal,
  isRecordedBackEdge,
  markEdgeTraversed,
  validateNavigation,
} from "./ExploreValidateMode";
import { selectValidateElement } from "./ExploreValidationSelection";
import { registeredInternalToolCaller as toolCaller } from "./InternalToolCaller";
import {
  NavigationGraphManager,
  type NavigationEdge,
  type NavigationGraphService,
} from "./NavigationGraphManager";
import { UIStateExtractor } from "./UIStateExtractor";

export { DEFAULT_EXPLORE_TIMEOUT_MS } from "./exploreTimeout";
export type { ExploreOptions } from "./ExploreTypes";

// Exploration waits for the UI to settle after an action.
const EXPLORE_ACTION_SETTLE_MS = 1000;
// Exploration waits for scrolling to settle.
const EXPLORE_SCROLL_SETTLE_MS = 1000;

export const DEFAULT_MAX_INTERACTIONS = 200;

/**
 * Explore implements intelligent app navigation exploration.
 * Perpetually explores until all navigation destinations have been reached by
 * automatically discovering navigation paths, prioritizing likely navigation elements,
 * avoiding redundant interactions, and efficiently covering unexplored screens.
 */
export class Explore extends BaseVisualChange {
  private navigationManager: NavigationGraphService;
  private exploredElements: Map<string, TrackedElement>;
  private interactionCount: number = 0;
  private lastResetAt: number = 0;
  private explorationPath: string[] = [];
  private elementSelections: ElementSelectionStats[] = [];
  private consecutiveBackCount: number = 0;
  consecutiveNoChangeCount: number = 0;
  private readonly permissionDialog = new ExplorePermissionDialog();
  loopDetection: Map<string, number> = new Map();
  private elementParser: ElementParser;
  private stopReason: string = "";
  previousScreen: string | null = null;
  private targetPackageName: string | null = null;
  consecutiveOutOfAppCount: number = 0;
  private readonly rootScreens: Set<string> = new Set();
  private pendingBackScreen: string | null = null;
  private awaitingRelaunchScreen: boolean = false;
  private hasObservedTargetApp: boolean = false;
  /**
   * Withdraws the record of the last successful recorded action. A gesture that
   * caused no navigation would otherwise stay correlatable for the manager's
   * window and stamp the next navigation, e.g. a dead-end Back (#9989).
   */
  private withdrawPendingToolCall: (() => void) | null = null;
  /** @internal Exposed for focused traversal report tests. */
  graphTraversalState: GraphTraversalState | null = null;
  private currentTargetEdge: NavigationEdge | null = null;
  /** Validate mode: the recorded Back edge selected for the next iteration (no element to tap). */
  private recordedBackEdge: NavigationEdge | null = null;
  private currentElementConfidence: number = 0;
  private sessionUuid?: string;
  private readonly tapActionFactory?: DialogTapActionFactory;

  // Constants for safety limits
  static readonly MAX_CONSECUTIVE_NO_CHANGE = 40;
  private static readonly DEFAULT_RESET_INTERVAL = 15;
  private static readonly MAX_OUT_OF_APP_ATTEMPTS = 5;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    timer: Timer = defaultTimer,
    navigationManager?: NavigationGraphService,
    sessionUuid?: string,
    tapActionFactory?: DialogTapActionFactory,
  ) {
    super(device, adb, timer);
    this.navigationManager = navigationManager ?? NavigationGraphManager.getInstance();
    this.exploredElements = new Map();
    this.elementParser = new DefaultElementParser();
    this.sessionUuid = sessionUuid;
    this.tapActionFactory = tapActionFactory;
  }

  /**
   * Read-only snapshot of the traversal counters and stop state, for tests and
   * diagnostics. Returns copies, so callers cannot mutate exploration state.
   */
  get diagnostics(): {
    readonly stopReason: string;
    readonly rootScreens: ReadonlySet<string>;
    readonly consecutiveOutOfAppCount: number;
    readonly consecutiveBackCount: number;
    readonly consecutiveNoChangeCount: number;
  } {
    return {
      stopReason: this.stopReason,
      rootScreens: new Set(this.rootScreens),
      consecutiveOutOfAppCount: this.consecutiveOutOfAppCount,
      consecutiveBackCount: this.consecutiveBackCount,
      consecutiveNoChangeCount: this.consecutiveNoChangeCount,
    };
  }

  /**
   * Seeds traversal state before calling the step methods directly, so a test
   * can start a step mid-exploration without running the whole loop.
   */
  setStateForTesting(state: {
    consecutiveNoChangeCount?: number;
    targetPackageName?: string | null;
    rootScreens?: Iterable<string>;
    elementParser?: ElementParser;
  }): void {
    if (state.consecutiveNoChangeCount !== undefined) {
      this.consecutiveNoChangeCount = state.consecutiveNoChangeCount;
    }
    if (state.targetPackageName !== undefined) {
      this.targetPackageName = state.targetPackageName;
    }
    if (state.rootScreens !== undefined) {
      for (const screen of state.rootScreens) {
        this.rootScreens.add(screen);
      }
    }
    if (state.elementParser !== undefined) {
      this.elementParser = state.elementParser;
    }
  }

  /**
   * Dependencies threaded into the blocker handlers so exploration reuses this
   * instance's injected `timer` (identical to `defaultTimer` in production) and
   * lets a test substitute a fake tap action instead of spying on
   * `TapOnElement.prototype`. `tapActionFactory` is left undefined in
   * production, so the handlers fall back to constructing `TapOnElement`.
   */
  private blockerHandlerDeps(): BlockerHandlerDeps {
    return { timer: this.timer, tapActionFactory: this.tapActionFactory };
  }

  /**
   * Execute exploration
   */
  async execute(
    options: ExploreOptions = {},
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<ExploreExecutionResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("explore");
    const startTime = this.timer.now();

    try {
      if (options.dryRun) {
        return await this.executeDryRun(options, progress, signal, perf, startTime);
      }

      // Set defaults
      const maxInteractions = options.maxInteractions ?? DEFAULT_MAX_INTERACTIONS;
      const timeoutMs = options.timeoutMs ?? DEFAULT_EXPLORE_TIMEOUT_MS;
      const strategy = options.strategy ?? "weighted";
      const mode = options.mode ?? "hybrid";
      const resetInterval = options.resetInterval ?? Explore.DEFAULT_RESET_INTERVAL;

      this.resetExplorationState(options);

      if (progress) {
        await progress(0, maxInteractions, "Starting exploration...");
      }

      // Capture initial graph state
      const initialGraph = await this.navigationManager.exportGraph();
      const initialNodeCount = initialGraph.nodes.length;

      // Initialize graph traversal for validate mode
      if (mode === "validate") {
        await this.initializeValidateTraversal();
      }

      await this.runExplorationLoop({
        options,
        maxInteractions,
        timeoutMs,
        startTime,
        strategy,
        mode,
        resetInterval,
        initialNodeCount,
        perf,
        progress,
        signal,
      });

      perf.end();
      return await this.generateReport(initialGraph, startTime, signal?.aborted === true);
    } catch (error) {
      perf.end();
      throw toActionableError(error, `Failed to execute exploration`);
    } finally {
      this.discardPendingToolCall();
    }
  }

  /** Withdraw the pending record: explore is moving on from that action. */
  private discardPendingToolCall(): void {
    const withdraw = this.withdrawPendingToolCall;
    this.withdrawPendingToolCall = null;
    withdraw?.();
  }

  private async initializeValidateTraversal(): Promise<void> {
    this.graphTraversalState = await initializeGraphTraversal(this.navigationManager);
    logger.info(
      `[Explore] Validate mode: traversing ${this.graphTraversalState?.totalEdgesInGraph ?? 0} known edges`,
    );
  }

  private resetExplorationState(options: ExploreOptions): void {
    // Reset exploration state for fresh run
    this.exploredElements.clear();
    this.loopDetection.clear();
    this.rootScreens.clear();
    this.pendingBackScreen = null;
    this.recordedBackEdge = null;
    this.awaitingRelaunchScreen = false;
    this.hasObservedTargetApp = false;
    this.elementSelections = [];
    this.explorationPath = [];
    this.interactionCount = 0;
    this.lastResetAt = 0;
    this.consecutiveBackCount = 0;
    this.consecutiveNoChangeCount = 0;
    this.permissionDialog.reset();
    this.stopReason = "";
    this.previousScreen = null;
    this.consecutiveOutOfAppCount = 0;
    this.targetPackageName = options.packageName?.trim() || null;
  }

  private async runExplorationLoop(context: ExplorationLoopContext): Promise<void> {
    const { maxInteractions, timeoutMs, startTime, strategy, mode, perf, progress, signal } =
      context;
    while (this.shouldContinue(maxInteractions, timeoutMs, startTime)) {
      if (signal?.aborted) {
        this.stopReason = OPERATION_CANCELLED_MESSAGE;
        break;
      }
      // Get current screen state
      const observation = await this.observeScreen.execute({
        perf,
        skipWaitForFresh: true,
        signal,
      });

      const preparation = await this.prepareExplorationObservation(observation, progress, signal);
      if (preparation === "break") {
        break;
      }
      if (preparation === "continue") {
        continue;
      }

      // Select next element to interact with
      const nextElement = await this.selectNextElement(observation, strategy, mode, perf);

      if (this.stopReason) {
        break;
      }

      if (!nextElement) {
        if (!(await this.recoverWithoutElement(context, observation))) {
          break;
        }
        continue;
      }

      // Only a new successful in-app interaction resets recovery accounting.
      const tracked = this.exploredElements.get(
        getElementKey(nextElement, observation.viewHierarchy),
      );
      const isNewInteraction =
        !tracked ||
        tracked.lastInteractionScreen !== (this.navigationManager.getCurrentScreen() ?? "unknown");
      // Perform interaction
      throwIfAborted(signal);
      const interactionSuccess = await this.performInteraction(
        nextElement,
        observation,
        progress,
        perf,
        signal,
      );

      if (!(await this.recordInteractionResult(interactionSuccess, mode, isNewInteraction))) {
        break;
      }

      await this.reportProgressAndReset(context);
    }
  }

  /**
   * No element was selected. In validate mode a recorded Back edge is replayed
   * with the Back button and its resulting screen checked; otherwise this is a
   * dead end. Returns false when the run must stop.
   */
  private async recoverWithoutElement(
    context: ExplorationLoopContext,
    observation: ObserveResult,
  ): Promise<boolean> {
    const { progress, signal } = context;
    if (!this.recordedBackEdge) {
      logger.info("[Explore] No suitable element found, checking dead-end recovery");
      await this.handleDeadEnd(progress, observation, signal);
      return true;
    }
    if (!(await this.validateRecordedBack(this.recordedBackEdge, observation, progress))) {
      return false;
    }
    await this.reportProgressAndReset(context);
    return true;
  }

  /**
   * Validate a recorded Back edge: press Back (recorded like any other action,
   * so the resulting navigation event is attributed to it) and check the screen
   * it lands on. A Back that cannot be dispatched fails the edge and stops the
   * run.
   */
  private async validateRecordedBack(
    edge: NavigationEdge,
    observation: ObserveResult,
    progress?: ProgressCallback,
  ): Promise<boolean> {
    this.recordedBackEdge = null;
    if (progress) {
      await progress(
        this.interactionCount,
        this.interactionCount + 1,
        `Validating Back edge ${edge.from}->${edge.to}...`,
      );
    }
    try {
      await this.dispatchBack(observation);
    } catch (error) {
      this.stopReason = `Validate mode: Back press failed for edge ${edge.from}->${edge.to}: ${errorMessage(error)}`;
      logger.warn(`[Explore] ${this.stopReason}`, error);
      if (this.graphTraversalState) {
        markEdgeTraversed(
          this.graphTraversalState,
          edge,
          { actualTo: null, success: false, error: "Back press failed" },
          this.timer,
        );
      }
      return false;
    }
    this.consecutiveBackCount = 0;
    return await this.recordInteractionResult(true, "validate");
  }

  private async prepareExplorationObservation(
    observation: ObserveResult,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<"none" | "continue" | "break"> {
    // Everything this step may dispatch (permission/blocker taps, relaunch,
    // Back) is unrecorded, so the previous action's record must not claim it.
    this.discardPendingToolCall();
    const permissionOutcome = await this.handlePermissionDialogFastPath(observation, progress);
    if (permissionOutcome === "break") {
      return "break";
    }
    if (permissionOutcome === "continue") {
      return "continue";
    }

    if (!this.targetPackageName) {
      this.targetPackageName = getObservationPackageName(observation);
      if (this.targetPackageName) {
        logger.info(`[Explore] Defaulting to foreground package: ${this.targetPackageName}`);
      }
    }

    if (this.targetPackageName) {
      const enforcement = await this.enforceTargetApp(
        observation,
        this.targetPackageName,
        progress,
        signal,
      );
      if (enforcement === "handled") {
        return "continue";
      }
      if (enforcement === "stop") {
        return "break";
      }
    }

    this.recordCurrentScreenInPath();
    if (this.shouldBreakForSafety(observation)) {
      logger.warn("[Explore] Safety condition triggered, stopping exploration");
      return "break";
    }

    // Check for blocker screens (auth, permissions, etc.) and handle them
    const blockerHandled = await detectAndHandleBlockers(
      observation,
      this.device,
      this.adb,
      this.elementParser,
      progress,
      this.blockerHandlerDeps(),
    );
    if (blockerHandled) {
      // Re-observe after handling blocker
      return "continue";
    }

    return "none";
  }

  private recordCurrentScreenInPath(): void {
    // Update current screen in path
    const currentScreen = this.navigationManager.getCurrentScreen();
    if (currentScreen && !this.explorationPath.includes(currentScreen)) {
      this.explorationPath.push(currentScreen);
      this.consecutiveOutOfAppCount = 0;
    }
  }

  private async recordInteractionResult(
    interactionSuccess: boolean,
    mode: ExplorationMode,
    isNewInteraction: boolean = false,
  ): Promise<boolean> {
    if (!interactionSuccess) {
      this.consecutiveNoChangeCount++;
      return true;
    }
    this.interactionCount++;
    this.consecutiveNoChangeCount = 0;
    if (isNewInteraction) {
      this.consecutiveOutOfAppCount = 0;
    }

    // Validate navigation in validate mode
    if (mode === "validate" && this.currentTargetEdge && this.graphTraversalState) {
      const validationSuccess = await validateNavigation(
        this.currentTargetEdge,
        this.graphTraversalState,
        this.navigationManager,
        this.timer,
        this.currentElementConfidence,
        (reason) => {
          this.stopReason = reason;
        },
      );

      if (!validationSuccess) {
        // Navigation validation failed - stop exploration
        logger.error("[Explore] Stopping exploration due to navigation validation failure");
        return false;
      }
    }
    this.recordSuccessfulScreenChange();
    return true;
  }

  private recordSuccessfulScreenChange(): void {
    const newScreen = this.navigationManager.getCurrentScreen();

    // Check if we navigated to a different screen
    if (this.previousScreen !== null && newScreen && newScreen !== this.previousScreen) {
      // We changed screens - check if we've been to this screen before
      const visitCount = this.loopDetection.get(newScreen) ?? 0;
      if (visitCount > 0) {
        // We're returning to a previously visited screen - increment loop counter
        this.loopDetection.set(newScreen, visitCount + 1);
        logger.debug(`[Explore] Returning to screen ${newScreen}, visit count: ${visitCount + 1}`);
      } else {
        // First visit to this screen - initialize counter
        this.loopDetection.set(newScreen, 1);
      }
    } else if (newScreen && this.previousScreen === null) {
      // First screen we're tracking
      this.loopDetection.set(newScreen, 1);
    }

    // Update previous screen for next iteration
    if (newScreen) {
      this.previousScreen = newScreen;
    }
  }

  private async reportProgressAndReset(context: ExplorationLoopContext): Promise<void> {
    const { progress, mode, maxInteractions, initialNodeCount, options, resetInterval, signal } =
      context;
    // Report progress
    if (progress) {
      if (mode === "validate" && this.graphTraversalState) {
        // Report graph traversal progress
        const edgesTraversed = this.graphTraversalState.traversedEdges.size;
        const totalEdges = this.graphTraversalState.totalEdgesInGraph;
        const coveragePercent =
          totalEdges > 0 ? Math.round((edgesTraversed / totalEdges) * 100) : 0;
        await progress(
          this.interactionCount,
          maxInteractions,
          `Validating graph: ${edgesTraversed}/${totalEdges} edges traversed (${coveragePercent}%) - ${this.interactionCount}/${maxInteractions} interactions`,
        );
      } else {
        // Report discovery progress
        const currentStats = await this.navigationManager.getStats();
        const currentNodeCount = currentStats.nodeCount;
        await progress(
          this.interactionCount,
          maxInteractions,
          `Explored ${currentNodeCount - initialNodeCount} new screens (${this.interactionCount}/${maxInteractions} interactions)`,
        );
      }
    }

    // Periodic reset if configured
    if (
      options.resetToHome &&
      isExplorationResetDue(this.interactionCount, this.lastResetAt, resetInterval)
    ) {
      this.lastResetAt = this.interactionCount;
      await this.resetToHome(progress, signal);
    }
  }

  private async executeDryRun(
    options: ExploreOptions,
    progress: ProgressCallback | undefined,
    signal: AbortSignal | undefined,
    perf: PerformanceTracker,
    startTime: number,
  ): Promise<ExploreDryRunResult> {
    const maxInteractions = options.maxInteractions ?? DEFAULT_MAX_INTERACTIONS;

    if (progress) {
      await progress(0, maxInteractions, "Starting exploration dry run...");
    }

    this.exploredElements.clear();
    this.elementSelections = [];
    this.explorationPath = [];
    this.interactionCount = 0;
    this.stopReason = "";
    this.previousScreen = null;
    this.consecutiveOutOfAppCount = 0;
    this.targetPackageName = options.packageName?.trim() || null;

    const observation = await this.observeScreen.execute({ perf, skipWaitForFresh: true, signal });
    return planExplorationDryRun(
      observation,
      options,
      {
        maxInteractions,
        navigationManager: this.navigationManager,
        elementParser: this.elementParser,
        timer: this.timer,
        targetPackageName: this.targetPackageName,
        exploredElements: this.exploredElements,
      },
      perf,
      startTime,
    );
  }

  async handlePermissionDialogFastPath(
    observation: ObserveResult,
    progress?: ProgressCallback,
  ): Promise<"continue" | "break" | "none"> {
    return this.permissionDialog.handle(
      observation,
      {
        elementParser: this.elementParser,
        device: this.device,
        adb: this.adb,
        blockerHandlerDeps: this.blockerHandlerDeps(),
        maxConsecutiveNoChange: Explore.MAX_CONSECUTIVE_NO_CHANGE,
        incrementNoChange: () => {
          this.consecutiveNoChangeCount++;
        },
        resetNoChange: () => {
          this.consecutiveNoChangeCount = 0;
        },
        getNoChange: () => this.consecutiveNoChangeCount,
        shouldBreakForSafety: () => this.shouldBreakForSafety(observation),
      },
      progress,
    );
  }

  /**
   * Check if exploration should continue
   */
  private shouldContinue(maxInteractions: number, timeoutMs: number, startTime: number): boolean {
    if (this.stopReason) {
      return false;
    }

    const elapsed = this.timer.now() - startTime;

    if (this.interactionCount >= maxInteractions) {
      this.stopReason = `Reached max interactions limit (${maxInteractions})`;
      logger.info(`[Explore] ${this.stopReason}`);
      return false;
    }

    if (elapsed >= timeoutMs) {
      this.stopReason = `Reached timeout limit (${timeoutMs}ms)`;
      logger.info(`[Explore] ${this.stopReason}`);
      return false;
    }

    return true;
  }

  /**
   * Check for safety conditions that should stop exploration
   */
  private shouldBreakForSafety(observation: ObserveResult): boolean {
    const reason = explorationSafetyStopReason({
      consecutiveBackCount: this.consecutiveBackCount,
      consecutiveNoChangeCount: this.consecutiveNoChangeCount,
      maxConsecutiveNoChange: Explore.MAX_CONSECUTIVE_NO_CHANGE,
      loopDetection: this.loopDetection,
      getCurrentScreen: () => this.navigationManager.getCurrentScreen(),
    });
    if (!reason) {
      return false;
    }
    this.stopReason = reason;
    logger.warn(`[Explore] ${reason}`);
    return true;
  }

  /**
   * Select the next element to interact with based on strategy
   */
  async selectNextElement(
    observation: ObserveResult,
    strategy: ExplorationStrategy,
    mode: ExplorationMode,
    perf: PerformanceTracker,
  ): Promise<Element | null> {
    return await perf.track("selectNextElement", async () => {
      this.recordedBackEdge = null;
      const viewHierarchy = observation.viewHierarchy;
      const safeCandidates = getSafeExplorationCandidates(observation, this.elementParser);

      // Validate selection also handles empty leaf screens and missing elements.
      if (mode === "validate" && this.graphTraversalState) {
        return this.selectValidateElement(safeCandidates);
      }

      if (safeCandidates.length === 0 || !viewHierarchy) {
        return null;
      }

      // Discovery and hybrid modes: use traditional element selection
      // Clear validate mode state
      this.currentTargetEdge = null;
      this.currentElementConfidence = 0;

      return selectDiscoveryElement(
        { elements: safeCandidates, hierarchy: viewHierarchy },
        strategy,
        mode,
        {
          currentScreen: this.navigationManager.getCurrentScreen(),
          exploredElements: this.exploredElements,
          elementSelections: this.elementSelections,
        },
      );
    });
  }
  private selectValidateElement(candidates: Element[]): Element | null {
    const selection = {
      stopReason: this.stopReason,
      currentTargetEdge: this.currentTargetEdge,
      currentElementConfidence: this.currentElementConfidence,
      recordedBackEdge: this.recordedBackEdge,
    };
    const element = selectValidateElement(
      candidates,
      {
        graphTraversalState: this.graphTraversalState,
        navigationManager: this.navigationManager,
        timer: this.timer,
      },
      selection,
    );
    this.stopReason = selection.stopReason;
    this.currentTargetEdge = selection.currentTargetEdge;
    this.currentElementConfidence = selection.currentElementConfidence;
    this.recordedBackEdge = selection.recordedBackEdge;
    return element;
  }

  async enforceTargetApp(
    observation: ObserveResult,
    targetPackageName: string,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<"ok" | "handled" | "stop"> {
    const currentPackage = getObservationPackageName(observation);

    if (currentPackage === targetPackageName) {
      if (this.awaitingRelaunchScreen) {
        await this.recordInitialRelaunchRoot();
        this.awaitingRelaunchScreen = false;
      }
      this.hasObservedTargetApp = true;
      this.pendingBackScreen = null;
      return "ok";
    }
    if (!currentPackage) {
      return "ok";
    }

    // The first observation after Back tells us whether that screen exits the app.
    if (this.pendingBackScreen !== null) {
      this.rootScreens.add(this.pendingBackScreen);
      this.pendingBackScreen = null;
    }
    this.consecutiveOutOfAppCount++;
    logger.warn(
      `[Explore] Foreground package '${currentPackage}' is outside target '${targetPackageName}', attempting to return`,
    );

    try {
      if (progress) {
        await progress(
          this.interactionCount,
          this.interactionCount + 1,
          `Returning to target app (${targetPackageName})...`,
        );
      }
      await this.relaunchTargetApp(targetPackageName, signal);
    } catch (error) {
      logger.warn(`[Explore] Failed to return to target app: ${errorMessage(error)}`, error);
    }
    await this.timer.sleep(EXPLORE_ACTION_SETTLE_MS);

    if (this.consecutiveOutOfAppCount >= Explore.MAX_OUT_OF_APP_ATTEMPTS) {
      this.stopReason =
        `Left target app (${targetPackageName}) without exploration progress after ` +
        `${Explore.MAX_OUT_OF_APP_ATTEMPTS} return attempts`;
      logger.warn(`[Explore] ${this.stopReason}`);
      return "stop";
    }

    return "handled";
  }

  private async recordInitialRelaunchRoot(): Promise<void> {
    const currentScreen = this.navigationManager.getCurrentScreen();
    if (!currentScreen || currentScreen === "unknown") {
      return;
    }
    const incomingEdges = await this.navigationManager.getEdgesTo(currentScreen);
    // A recorded Back edge Child -> Screen only says Back from Child lands here, so
    // Child is a descendant, not a parent. The loader's edgeType is only "tool" or
    // "unknown", so the Back press is identified by its recorded interaction.
    const hasInAppParent = incomingEdges.some(
      (edge) => edge.from !== currentScreen && !isRecordedBackEdge(edge),
    );
    if (!hasInAppParent) {
      this.rootScreens.add(currentScreen);
    }
  }

  /**
   * Perform interaction with selected element
   */
  async performInteraction(
    element: Element,
    observation: ObserveResult,
    progress?: ProgressCallback,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const elementKey = getElementKey(element, observation.viewHierarchy);
    const currentScreen = this.navigationManager.getCurrentScreen() ?? "unknown";

    try {
      // Update tracking
      const tracked = this.exploredElements.get(elementKey) ?? {
        text: element.text,
        resourceId: element["resource-id"],
        contentDesc: element["content-desc"],
        className: element["class"],
        interactionCount: 0,
        lastInteractionScreen: currentScreen,
      };

      tracked.interactionCount++;
      tracked.lastInteractionScreen = currentScreen;
      this.exploredElements.set(elementKey, tracked);

      // Check if element is scrollable - perform swipe instead of tap
      const isScrollable = isTruthy(element.scrollable);

      const success = isScrollable
        ? await this.swipeContainer(element, observation, progress, signal)
        : await this.tapElement(element, observation, progress, signal);
      // Reset consecutive back count since we did a swipe or tap (not when
      // there was no tap target to dispatch).
      if (success !== null) {
        this.consecutiveBackCount = 0;
      }
      return success ?? false;
    } catch (error) {
      logger.warn(`[Explore] Failed to interact with element: ${error}`);
      return false;
    }
  }

  /** Swipe a scrollable container; the swipeOn record needs a selector to replay it. */
  private async swipeContainer(
    element: Element,
    observation: ObserveResult,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.elementActions().swipeContainer(element, observation, progress, signal);
  }

  /** Tap an element by selector, else its centre; null when it has no tap target. */
  async tapElement(
    element: Element,
    observation: ObserveResult,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    return this.elementActions().tapElement(element, observation, progress, signal);
  }

  /**
   * Run one explore action while the navigation graph holds the tool call that
   * would replay it, so an edge it produces carries that call instead of
   * reading as unknown (Back press) in navigateTo (#9989). Mirrors the registry
   * wrapper: the record is recorded before dispatch and withdrawn when the
   * action fails, throws or is aborted. A null tool name skips recording when
   * the action has no replayable public form.
   */
  private async runRecorded<T extends { success: boolean }>(
    toolName: string | null,
    args: Record<string, unknown>,
    observation: ObserveResult | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    // The previous action is over once the next one is recorded.
    this.discardPendingToolCall();
    const withdraw = toolName
      ? this.navigationManager.recordToolCall(
          toolName,
          args,
          new UIStateExtractor().extractFromObservation(observation),
        )
      : undefined;
    let succeeded = false;
    try {
      // The action reports when its gesture goes out (#10196); a swipe that reports
      // nothing is attributed from the start of the call.
      const result = await runWithToolDispatchReporter(withdraw?.markDispatched, run);
      succeeded = result.success;
      return result;
    } finally {
      if (succeeded) {
        // Keep the record until explore moves on: the navigation it causes may
        // land after the gesture returns, but a gesture that causes none must
        // not be attributed to whatever navigates next.
        this.withdrawPendingToolCall = withdraw ?? null;
      } else {
        withdraw?.();
      }
    }
  }

  /** Record a cancelled run as the stop reason; true when the caller must stop. */
  private stopIfCancelled(signal?: AbortSignal): boolean {
    if (!signal?.aborted) {
      return false;
    }
    this.stopReason = OPERATION_CANCELLED_MESSAGE;
    return true;
  }

  /**
   * Press Back on the device, recorded as `pressButton { button: "back" }` so the
   * edge the resulting navigation creates replays (and validates) as a recorded
   * Back instead of an unknown interaction. The request signal reaches the
   * Android press so a cancelled run does not keep dispatching Back.
   */
  private async dispatchBack(observation?: ObserveResult, signal?: AbortSignal): Promise<void> {
    // Recovery dispatches below bypass BaseVisualChange's action boundary.
    await beginPostActionCaptureAction();
    await this.runRecorded("pressButton", { button: "back" }, observation, async () => {
      await this.platformRecovery().pressBack(signal);
      return { success: true };
    });
  }

  /**
   * Handle dead-end situation by going back
   */
  async handleDeadEnd(
    progress?: ProgressCallback,
    observation?: ObserveResult,
    signal?: AbortSignal,
  ): Promise<void> {
    // The previous action caused no navigation (that is why this is a dead end): withdraw
    // its record before the Back press is recorded in its place.
    this.discardPendingToolCall();
    // The loop-top check can be a whole observe and selection behind; do not press Back now.
    if (this.stopIfCancelled(signal)) {
      return;
    }
    const currentScreen = this.navigationManager.getCurrentScreen();
    if (currentScreen && currentScreen !== "unknown" && this.rootScreens.has(currentScreen)) {
      this.stopReason = `No unexplored interactions on the root screen: ${currentScreen}`;
      logger.info(`[Explore] ${this.stopReason}`);
      return;
    }
    try {
      if (progress) {
        await progress(
          this.interactionCount,
          this.interactionCount + 1,
          "Dead end detected, navigating back...",
        );
      }

      await this.dispatchBack(observation, signal);
      this.pendingBackScreen = currentScreen === "unknown" ? null : currentScreen;
      this.consecutiveBackCount++;

      // Wait briefly for navigation
      await awaitWhileRequestIsLive(this.timer.sleep(EXPLORE_SCROLL_SETTLE_MS), signal);
    } catch (error) {
      // A cancelled recovery is not a failed one: report the cancelled partial run.
      if (this.stopIfCancelled(signal)) {
        return;
      }
      logger.warn(`[Explore] Failed to navigate back: ${error}`);
      this.stopReason = `Back-navigation recovery failed: ${errorMessage(error)}`;
    }
  }

  /**
   * Reset to home screen
   */
  async resetToHome(progress?: ProgressCallback, signal?: AbortSignal): Promise<void> {
    this.discardPendingToolCall();
    try {
      if (progress) {
        await progress(
          this.interactionCount,
          this.interactionCount + 1,
          "Resetting to home screen...",
        );
      }

      await this.platformRecovery().home(signal);

      // Home alone leaves the launcher in the foreground, which the next
      // observation would treat as having left the target app (issue #6126).
      if (this.targetPackageName) {
        await this.relaunchTargetApp(this.targetPackageName, signal);
      }

      // Reset consecutive back count
      this.consecutiveBackCount = 0;
    } catch (error) {
      if (this.stopIfCancelled(signal)) {
        return;
      }
      logger.warn(`[Explore] Failed to reset to home: ${error}`);
      this.stopReason = `Home-screen recovery failed: ${errorMessage(error)}`;
    }
  }
  private async relaunchTargetApp(packageName: string, signal?: AbortSignal): Promise<void> {
    await this.platformRecovery().relaunch(packageName, signal);
    // Only an initial launch with no target-app observation can establish a fresh-start root.
    this.awaitingRelaunchScreen = !this.hasObservedTargetApp;
  }
  private elementActions(): ExploreElementActions {
    return new ExploreElementActions({
      device: this.device,
      adb: this.adb,
      timer: this.timer,
      runRecorded: (toolName, args, observation, run) =>
        this.runRecorded(toolName, args, observation, run),
    });
  }
  private platformRecovery(): ExplorePlatformRecovery {
    return new ExplorePlatformRecovery(
      this.device,
      this.adb,
      this.timer,
      async (toolName, args, signal) => {
        const response = await toolCaller.callInternal(toolName, args, undefined, signal);
        throwIfInternalToolFailed(response, toolName, this.device.platform);
      },
      this.sessionUuid,
    );
  }
  async generateReport(
    initialGraph: ExportedGraph,
    startTime: number,
    cancelled: boolean,
  ): Promise<ExploreResult> {
    return generateExplorationReport(initialGraph, startTime, cancelled, {
      navigationManager: this.navigationManager,
      timer: this.timer,
      getState: () => ({
        explorationPath: this.explorationPath,
        graphTraversalState: this.graphTraversalState,
        interactionCount: this.interactionCount,
        elementSelections: this.elementSelections,
        stopReason: this.stopReason,
      }),
    });
  }
}
